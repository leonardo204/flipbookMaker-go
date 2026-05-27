import { invoke } from "@tauri-apps/api/core";

export interface FigmaBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string; // "CANVAS", "FRAME", "SECTION", "COMPONENT" 등
  characters?: string;          // TEXT 노드의 실제 텍스트
  bbox?: FigmaBoundingBox;      // 절대 위치/크기 (와이어프레임 표현용)
  componentId?: string;         // INSTANCE 노드가 참조하는 컴포넌트 ID
  visible?: boolean;            // false인 경우만 표기 (기본 true)
  children?: FigmaNode[];
}

export interface FigmaFileInfo {
  name: string;
  lastModified: string;
  pages: FigmaNode[];
}

/**
 * Figma 파일 키를 URL에서 추출
 * https://www.figma.com/design/XXXXX/FileName → XXXXX
 * https://www.figma.com/file/XXXXX/FileName → XXXXX
 */
export function extractFileKey(url: string): string | null {
  const match = url.match(/figma\.com\/(?:file|design)\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Figma API 토큰 유효성 확인
 */
export async function verifyFigmaToken(token: string): Promise<boolean> {
  try {
    const result = await invoke<string>("figma_api_proxy", {
      endpoint: "/v1/me",
      token,
    });
    const data = JSON.parse(result);
    return !!data.id;
  } catch {
    return false;
  }
}

/**
 * Figma 파일 구조 가져오기 (페이지/프레임 목록)
 */
export async function getFigmaFileStructure(
  fileKey: string,
  token: string,
): Promise<FigmaFileInfo> {
  await metaRateLimiter.acquire();
  const result = await invoke<string>("figma_api_proxy", {
    endpoint: `/v1/files/${fileKey}?depth=2`,
    token,
  });
  const data = JSON.parse(result);

  return {
    name: data.name,
    lastModified: data.lastModified,
    pages: (data.document?.children || []).map(simplifyNode),
  };
}

/**
 * Figma 파일 메타 정보(이름/수정일)만 가볍게 조회
 */
export async function getFigmaFileMeta(
  fileKey: string,
  token: string,
): Promise<{ name: string; lastModified: string }> {
  await metaRateLimiter.acquire();
  const result = await invoke<string>("figma_api_proxy", {
    endpoint: `/v1/files/${fileKey}?depth=1`,
    token,
  });
  const data = JSON.parse(result);
  return {
    name: data.name || "",
    lastModified: data.lastModified || "",
  };
}

// ─── Rate limiter (Figma /v1/images: ~6 req/min on Pro) ────────────────────
//
// 토큰 버킷 패턴: 분당 N개 토큰 충전, 호출 시 1개 소모. 토큰 부족 시 대기.
// /v1/images만 통과. /v1/files 등 메타 호출은 별도 카운트 (분당 ~15 한도).

interface RateLimiter {
  acquire(): Promise<void>;
}

function createRateLimiter(maxPerMin: number, label: string): RateLimiter {
  const intervalMs = Math.ceil(60_000 / maxPerMin);
  let nextAvailableAt = 0;

  return {
    async acquire() {
      const now = Date.now();
      if (now >= nextAvailableAt) {
        nextAvailableAt = now + intervalMs;
        return;
      }
      const waitMs = nextAvailableAt - now;
      console.log(`[figmaRate:${label}] 대기 ${waitMs}ms (한도 ${maxPerMin}/min)`);
      await new Promise((r) => setTimeout(r, waitMs));
      nextAvailableAt = Date.now() + intervalMs;
    },
  };
}

// 보수적으로 limit 보다 1단계 낮게 설정해 안전 마진 확보
const imagesRateLimiter = createRateLimiter(5, "images"); // /v1/images
const metaRateLimiter = createRateLimiter(12, "meta");    // /v1/files, /v1/files/.../nodes

// Figma /v1/images batch 한 번 호출의 ID 한도.
// 실험적으로 32~36개에서 400 Bad Request 발생 → 보수적으로 10개로 청크 분할.
const IMAGE_BATCH_MAX = 10;

/**
 * Figma 프레임/노드들의 PNG 렌더링 URL을 batch로 받아옴 (단일 호출, 청크 분할 안 함).
 * 내부 헬퍼 — 외부에서는 chunked 버전 사용 권장.
 */
async function getFigmaImageUrlsRaw(
  fileKey: string,
  nodeIds: string[],
  token: string,
  scale: number,
  format: "png" | "jpg" | "svg" | "pdf",
): Promise<Record<string, string | null>> {
  if (nodeIds.length === 0) return {};

  await imagesRateLimiter.acquire();

  const idsParam = nodeIds.map((id) => encodeURIComponent(id)).join(",");
  const endpoint = `/v1/images/${fileKey}?ids=${idsParam}&format=${format}&scale=${scale}`;

  console.log(`[figmaService] /v1/images call: ${nodeIds.length} ids, scale=${scale}, format=${format}`);

  const result = await invoke<string>("figma_api_proxy", { endpoint, token });
  const data = JSON.parse(result);

  if (data.err) {
    throw new Error(`Figma image render 실패: ${data.err}`);
  }

  return data.images || {};
}

/**
 * Figma 프레임/노드들의 PNG 렌더링 URL을 청크 분할로 받아옴.
 *
 * - 청크당 IMAGE_BATCH_MAX(10)개 ID 단위로 자동 분할
 * - 청크별 rate limiter 통과 (개별 호출 = 1토큰)
 * - 한 청크가 400 등으로 실패하면 절반으로 재분할해 재시도 (1개로 줄어들 때까지)
 * - 끝까지 실패한 ID는 결과에서 null로 표기 (전체 실패하지 않음)
 *
 * @param scale 1 (기본) ~ 4. 2배 권장 — 가독성과 크기의 균형.
 * @param format png/jpg/svg/pdf
 */
export async function getFigmaImageUrls(
  fileKey: string,
  nodeIds: string[],
  token: string,
  scale: number = 2,
  format: "png" | "jpg" | "svg" | "pdf" = "png",
): Promise<Record<string, string | null>> {
  if (nodeIds.length === 0) return {};

  const chunks: string[][] = [];
  for (let i = 0; i < nodeIds.length; i += IMAGE_BATCH_MAX) {
    chunks.push(nodeIds.slice(i, i + IMAGE_BATCH_MAX));
  }
  console.log(
    `[figmaService] /v1/images: ${nodeIds.length} ids → ${chunks.length} chunks (max ${IMAGE_BATCH_MAX}/chunk)`,
  );

  const merged: Record<string, string | null> = {};
  for (const ids of nodeIds) merged[ids] = null;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    try {
      const urls = await getFigmaImageUrlsRaw(fileKey, chunk, token, scale, format);
      Object.assign(merged, urls);
    } catch (e) {
      console.warn(
        `[figmaService] chunk ${ci + 1}/${chunks.length} (${chunk.length} ids) 실패:`,
        e,
      );
      // 청크 분할 재시도
      if (chunk.length > 1) {
        const half = Math.ceil(chunk.length / 2);
        const sub1 = chunk.slice(0, half);
        const sub2 = chunk.slice(half);
        try {
          const urls1 = await getFigmaImageUrlsRaw(fileKey, sub1, token, scale, format);
          Object.assign(merged, urls1);
        } catch (e1) {
          console.warn(`[figmaService] sub-chunk 1 (${sub1.length}) 실패:`, e1);
          // 더 쪼개기 — 개별 호출
          for (const id of sub1) {
            try {
              const u = await getFigmaImageUrlsRaw(fileKey, [id], token, scale, format);
              Object.assign(merged, u);
            } catch (e0) {
              console.warn(`[figmaService] 개별 id ${id} 실패:`, e0);
            }
          }
        }
        try {
          const urls2 = await getFigmaImageUrlsRaw(fileKey, sub2, token, scale, format);
          Object.assign(merged, urls2);
        } catch (e2) {
          console.warn(`[figmaService] sub-chunk 2 (${sub2.length}) 실패:`, e2);
          for (const id of sub2) {
            try {
              const u = await getFigmaImageUrlsRaw(fileKey, [id], token, scale, format);
              Object.assign(merged, u);
            } catch (e0) {
              console.warn(`[figmaService] 개별 id ${id} 실패:`, e0);
            }
          }
        }
      }
    }
  }

  const successCount = Object.values(merged).filter((v) => v !== null).length;
  console.log(`[figmaService] /v1/images 완료: ${successCount}/${nodeIds.length} 성공`);
  return merged;
}

/**
 * Figma 렌더 URL에서 PNG를 로컬 파일로 다운로드.
 * Figma S3 URL은 ~30초 후 만료되므로 즉시 호출 권장.
 */
export async function downloadFigmaImage(url: string, destPath: string): Promise<number> {
  return invoke<number>("download_to_file", { url, destPath });
}

export interface RenderProgressEvent {
  phase: "rendering" | "downloading";
  current: number;
  total: number;
}

/**
 * 섹션의 모든 frame ID에 대해 PNG 렌더 URL을 batch로 받고, 즉시 로컬 다운로드.
 * 한 섹션 = 한 번의 /v1/images 호출 + N번의 다운로드 (다운로드는 Figma rate limit 대상 아님).
 *
 * @param onProgress 단계/진행률 콜백 — UI에 세부 상태 표시용
 * @returns frame ID → 로컬 파일 경로 매핑 (실패 시 null)
 */
export async function renderFigmaFramesToFiles(
  fileKey: string,
  frameIds: string[],
  token: string,
  destDir: string,
  scale: number = 2,
  onProgress?: (e: RenderProgressEvent) => void,
): Promise<Record<string, string | null>> {
  if (frameIds.length === 0) return {};

  onProgress?.({ phase: "rendering", current: 0, total: frameIds.length });
  const urls = await getFigmaImageUrls(fileKey, frameIds, token, scale, "png");

  const result: Record<string, string | null> = {};
  let downloaded = 0;

  for (const frameId of frameIds) {
    const url = urls[frameId];
    if (!url) {
      console.warn(`[figmaService] frame ${frameId}: 렌더 URL 없음`);
      result[frameId] = null;
      downloaded++;
      onProgress?.({ phase: "downloading", current: downloaded, total: frameIds.length });
      continue;
    }
    const safeId = frameId.replace(/[^A-Za-z0-9_-]/g, "_");
    const destPath = `${destDir}/${safeId}.png`;
    try {
      const bytes = await downloadFigmaImage(url, destPath);
      console.log(`[figmaService] downloaded ${safeId}.png (${bytes} bytes)`);
      result[frameId] = destPath;
    } catch (e) {
      console.error(`[figmaService] frame ${frameId} 다운로드 실패:`, e);
      result[frameId] = null;
    }
    downloaded++;
    onProgress?.({ phase: "downloading", current: downloaded, total: frameIds.length });
  }

  return result;
}

/**
 * Figma 특정 노드의 상세 정보 가져오기
 */
export async function getFigmaNodeDetail(
  fileKey: string,
  nodeId: string,
  token: string,
): Promise<FigmaNode> {
  await metaRateLimiter.acquire();
  const result = await invoke<string>("figma_api_proxy", {
    endpoint: `/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=10`,
    token,
  });
  const data = JSON.parse(result);
  const nodes = data.nodes || {};
  const nodeData = Object.values(nodes)[0] as any;
  return simplifyNode(nodeData?.document || {});
}

/**
 * 섹션이 "변환할 콘텐츠가 사실상 없는지" 좁게 판단.
 *
 * 콘텐츠 없음 = 다음 모두 충족:
 * - TEXT 노드 0개 (라벨/카피 없음)
 * - INSTANCE/COMPONENT 0개 (재사용 컴포넌트 없음)
 * - FRAME 1개 이하 (다중 화면 없음)
 * - 원시 노드(RECTANGLE/VECTOR/IMAGE/ELLIPSE/LINE) 2개 이하
 *
 * → End Page처럼 단일 이미지뿐인 섹션만 잡힘. 와이어프레임이 풍부한 섹션은 제외되지 않음.
 *
 * 참고: depth=2 응답(파일 구조)에서는 자식의 자식이 없어 정확도가 떨어짐.
 *       depth=10 응답(node-id 지정)에서는 정확하게 작동.
 */
export function isEmptyFigmaSection(node: FigmaNode): boolean {
  let texts = 0;
  let instances = 0;
  let components = 0;
  let frames = 0;
  let primitives = 0;

  function walk(n: FigmaNode, isRoot: boolean) {
    if (!isRoot) {
      if (n.type === "TEXT" && (n.characters ?? "").trim().length > 0) {
        texts++;
      } else if (n.type === "INSTANCE") {
        instances++;
      } else if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") {
        components++;
      } else if (n.type === "FRAME") {
        frames++;
      } else if (
        n.type === "RECTANGLE" ||
        n.type === "VECTOR" ||
        n.type === "IMAGE" ||
        n.type === "ELLIPSE" ||
        n.type === "LINE"
      ) {
        primitives++;
      }
    }
    n.children?.forEach((c) => walk(c, false));
  }
  walk(node, true);

  const hasContent =
    texts > 0 || instances > 0 || components > 0 || frames >= 2 || primitives >= 3;
  return !hasContent;
}

function simplifyNode(node: any): FigmaNode {
  const result: FigmaNode = {
    id: node.id || "",
    name: node.name || "",
    type: node.type || "",
  };

  // TEXT 노드의 실제 본문 텍스트 — 와이어프레임에 적힌 라벨/카피
  if (typeof node.characters === "string" && node.characters.length > 0) {
    result.characters = node.characters;
  }

  // 절대 위치/크기 — 레이아웃 추론용 (소수점 1자리로 축약)
  if (node.absoluteBoundingBox) {
    const b = node.absoluteBoundingBox;
    result.bbox = {
      x: Math.round((b.x ?? 0) * 10) / 10,
      y: Math.round((b.y ?? 0) * 10) / 10,
      width: Math.round((b.width ?? 0) * 10) / 10,
      height: Math.round((b.height ?? 0) * 10) / 10,
    };
  }

  // INSTANCE가 참조하는 컴포넌트 ID — 재사용 컴포넌트 식별
  if (node.componentId) {
    result.componentId = node.componentId;
  }

  // 숨김 처리된 노드는 명시 (보이는 노드는 표기 생략)
  if (node.visible === false) {
    result.visible = false;
  }

  if (node.children && node.children.length > 0) {
    result.children = node.children.map(simplifyNode);
  }
  return result;
}
