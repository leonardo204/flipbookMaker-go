/**
 * workspace.ts — URL 기반 workspace 폴더 관리 서비스
 *
 * 결과 폴더(Settings.outputPath) 하위에 소스 URL별 workspace 서브폴더를 자동 생성·재사용.
 * _meta.json 기반으로 세션 상태를 유지하며 재진입 시 복원을 지원한다.
 */

import {
  mkdir,
  readDir,
  readTextFile,
  writeTextFile,
  exists,
} from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import type { PageStatus, SourceType, SitemapNode } from "../contexts/WorkflowContext";
import { extractFileKey } from "./figmaService";

// ---- 타입 정의 ----

export interface WorkspaceMeta {
  version: 1;
  sourceUrl: string;
  sourceType: "figma" | "axshare";
  documentName: string;
  fileKey?: string;
  sections: Array<{
    name: string;
    slug: string;
    path: string;
    sectionDir: string;
    status: PageStatus;
    selected: boolean;
  }>;
  sitemap?: SitemapNode[]; // 선택 — Axshare는 별도 sitemap.json 우선
  createdAt: string;
  updatedAt: string;
}

// ---- slug 유틸 ----

/**
 * 파일/폴더명용 slug 생성.
 * - 소문자 변환, 공백/_/>를 하이픈으로 치환
 * - 영숫자/한글/하이픈만 유지
 * - 빈 문자열이면 'workspace'로 fallback
 * - '_' 시작이면 'w-' prefix 추가 (_meta.json 등 예약명과 충돌 방지)
 */
export function slugifyForPath(text: string): string {
  const result = text
    .toLowerCase()
    .replace(/[>_\s]+/g, "-")
    .replace(/[^\w가-힣\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!result) return "workspace";
  if (result.startsWith("_")) return `w-${result}`;
  return result;
}

/**
 * sourceType + URL + 선택 정보에서 workspace slug 결정.
 *
 * Figma: `${slugify(documentName)}-${fileKey 앞 6자}` (documentName 없으면 host + fileKey 앞 8자)
 * Axshare: `${slugify(host)}-${slugify(lastPathSegment) || 'root'}`
 */
export function deriveWorkspaceSlug(input: {
  sourceType: SourceType;
  url: string;
  documentName?: string;
  fileKey?: string;
}): string {
  const { sourceType, url, documentName, fileKey } = input;

  let parsedHost = "";
  let lastPathSegment = "";
  try {
    const u = new URL(url);
    parsedHost = u.hostname;
    const parts = u.pathname.split("/").filter(Boolean);
    lastPathSegment = parts[parts.length - 1] ?? "";
  } catch {
    // URL 파싱 실패 시 url 자체를 slug 대상으로 사용
    parsedHost = url;
  }

  if (sourceType === "figma") {
    if (documentName && documentName.trim()) {
      const docSlug = slugifyForPath(documentName.trim());
      const keyPart = fileKey ? fileKey.slice(0, 6).toLowerCase() : slugifyForPath(parsedHost).slice(0, 8);
      return `${docSlug}-${keyPart}`;
    }
    // documentName 없으면 host + fileKey 앞 8자
    const hostSlug = slugifyForPath(parsedHost);
    const keyPart = fileKey ? fileKey.slice(0, 8).toLowerCase() : "unknown";
    return `${hostSlug}-${keyPart}`;
  }

  // Axshare
  const hostSlug = slugifyForPath(parsedHost);
  const segSlug = lastPathSegment ? slugifyForPath(lastPathSegment) : "root";
  return `${hostSlug}-${segSlug}`;
}

// ---- 경로 유틸 ----

/**
 * settings.outputPath의 '~' 해석.
 * ensureWorkspaceDir 이전에 호출해 절대 경로로 변환한다.
 */
export async function resolveOutputRoot(rawPath: string): Promise<string> {
  if (!rawPath) return rawPath;
  if (rawPath.startsWith("~/")) {
    const home = await homeDir();
    return home + rawPath.slice(2);
  }
  return rawPath;
}

/** workspace 디렉토리 절대 경로 반환 (실제 생성 없이) */
export function getWorkspaceDir(rootDir: string, slug: string): string {
  return `${rootDir}/${slug}`;
}

/** workspace 디렉토리가 없으면 재귀 생성 후 절대 경로 반환 */
export async function ensureWorkspaceDir(rootDir: string, slug: string): Promise<string> {
  const dir = getWorkspaceDir(rootDir, slug);
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    // 이미 존재하는 경우 무시
    const msg = String(e);
    if (!msg.includes("already exists") && !msg.includes("File exists")) {
      throw e;
    }
  }
  return dir;
}

// ---- _meta.json I/O ----

/** workspaceDir/_meta.json 로드. 없거나 파싱 실패 시 null 반환 */
export async function readWorkspaceMeta(workspaceDir: string): Promise<WorkspaceMeta | null> {
  const metaPath = `${workspaceDir}/_meta.json`;
  try {
    const fileExists = await exists(metaPath);
    if (!fileExists) return null;
    const raw = await readTextFile(metaPath);
    return JSON.parse(raw) as WorkspaceMeta;
  } catch {
    return null;
  }
}

/** workspaceDir/_meta.json 저장. updatedAt은 자동 갱신 */
export async function writeWorkspaceMeta(
  workspaceDir: string,
  meta: WorkspaceMeta,
): Promise<void> {
  const metaPath = `${workspaceDir}/_meta.json`;
  const updated: WorkspaceMeta = {
    ...meta,
    updatedAt: new Date().toISOString(),
  };
  await writeTextFile(metaPath, JSON.stringify(updated, null, 2));
}

// ---- 목록 / 검색 ----

/**
 * rootDir 하위 서브폴더를 스캔해 workspace 목록 반환.
 * _meta.json이 없는 폴더(평탄 fallback)도 포함하되 meta=null.
 * _.* 패턴 폴더는 내부 예약 폴더이므로 제외.
 */
export async function listWorkspaces(rootDir: string): Promise<
  Array<{ slug: string; dir: string; meta: WorkspaceMeta | null; mdCount: number }>
> {
  const results: Array<{ slug: string; dir: string; meta: WorkspaceMeta | null; mdCount: number }> = [];

  let entries: Awaited<ReturnType<typeof readDir>> = [];
  try {
    entries = await readDir(rootDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.name) continue;
    // 예약 폴더(언더스코어 시작) 제외
    if (entry.name.startsWith("_")) continue;
    // 파일은 제외 (폴더만)
    // readDir의 isDirectory 여부 확인 — 이름으로 판단 (확장자 없으면 폴더로 추정)
    // 실제 isDirectory 플래그 사용
    if (entry.isFile) continue;

    const dir = `${rootDir}/${entry.name}`;
    const meta = await readWorkspaceMeta(dir);

    // .md 파일 개수 세기
    let mdCount = 0;
    try {
      const subEntries = await readDir(dir);
      mdCount = subEntries.filter((e) => e.name?.endsWith(".md")).length;
    } catch {
      mdCount = 0;
    }

    results.push({ slug: entry.name, dir, meta, mdCount });
  }

  // updatedAt 기준 최신순 정렬
  results.sort((a, b) => {
    const aDate = a.meta?.updatedAt ?? "";
    const bDate = b.meta?.updatedAt ?? "";
    return bDate.localeCompare(aDate);
  });

  return results;
}

/**
 * URL을 비교 키로 정규화.
 * - Figma: fileKey만 추출해 비교 (node-id/page 차이 무시)
 * - Axshare: origin + pathname (query/hash 무시)
 * - 파싱 실패 시 원본 URL 그대로 fallback
 */
function normalizeUrlForMatch(url: string, sourceType?: string): string {
  try {
    if (sourceType === "figma" || url.includes("figma.com")) {
      const key = extractFileKey(url);
      if (key) return `figma:${key}`;
    }
    // Axshare 및 그 외: origin + pathname
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * rootDir 하위에서 sourceUrl이 일치하는 workspace를 찾아 반환.
 * URL 정규화 비교: Figma는 fileKey, Axshare는 origin+pathname.
 * 없으면 null.
 */
export async function findExistingWorkspace(
  rootDir: string,
  sourceUrl: string,
): Promise<{ slug: string; dir: string; meta: WorkspaceMeta } | null> {
  const inputKey = normalizeUrlForMatch(sourceUrl);
  const list = await listWorkspaces(rootDir);
  for (const item of list) {
    if (!item.meta) continue;
    const metaKey = normalizeUrlForMatch(item.meta.sourceUrl, item.meta.sourceType);
    if (metaKey === inputKey) {
      return { slug: item.slug, dir: item.dir, meta: item.meta };
    }
  }
  return null;
}

/**
 * workspace sections 중 .md 파일이 실제로 없는 항목을 status='pending'으로 보정.
 * done/converting/error 모두 .md 부재 시 pending으로 복귀.
 * 재사용 시 파일이 삭제됐거나 변환이 미완료된 섹션 감지에 사용.
 */
export async function validateWorkspace(
  workspaceDir: string,
  sections: WorkspaceMeta["sections"],
): Promise<WorkspaceMeta["sections"]> {
  const shouldValidate = (status: PageStatus) =>
    status === "done" || status === "converting" || status === "error";

  const validated = await Promise.all(
    sections.map(async (section) => {
      if (!shouldValidate(section.status)) return section;
      const mdPath = `${workspaceDir}/${section.slug}.md`;
      try {
        const fileExists = await exists(mdPath);
        if (!fileExists) {
          console.log(`[workspace] validateWorkspace: ${section.slug}.md 없음 (status=${section.status}) → pending으로 보정`);
          return { ...section, status: "pending" as PageStatus };
        }
      } catch {
        console.log(`[workspace] validateWorkspace: ${section.slug}.md 존재 확인 실패 → pending으로 보정`);
        return { ...section, status: "pending" as PageStatus };
      }
      return section;
    }),
  );
  return validated;
}
