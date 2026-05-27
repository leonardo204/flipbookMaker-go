import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { readTextFile } from "@tauri-apps/plugin-fs";
import Button from "../components/Button";
import ProgressBar from "../components/ProgressBar";
import StatusCard from "../components/StatusCard";
import { useWorkflow, type SitemapNode, type PageEntry } from "../contexts/WorkflowContext";
import { useSettings } from "../contexts/SettingsContext";
import { runCrawl } from "../services/scriptRunner";
import { getFigmaFileStructure, getFigmaFileMeta, getFigmaNodeDetail, extractFileKey, isEmptyFigmaSection, type FigmaNode } from "../services/figmaService";
import {
  deriveWorkspaceSlug,
  resolveOutputRoot,
  ensureWorkspaceDir,
  readWorkspaceMeta,
  writeWorkspaceMeta,
  type WorkspaceMeta,
} from "../services/workspace";

/**
 * scripts/lib/slug.mjs의 slugify 로직을 TypeScript로 포팅
 * capture.mjs / capture-sections.mjs와 동일한 방식으로 파일명 slug를 생성한다.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[>_\s]+/g, "-")
    .replace(/[^\w가-힣\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}


/**
 * Figma URL에서 node-id 파라미터를 추출
 * https://www.figma.com/design/XXXXX/Name?node-id=7538-22099
 */
function extractNodeId(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get("node-id");
  } catch {
    return null;
  }
}


/**
 * Axshare sitemap은 [Folder { children: [Wireframe, Wireframe, ...] }] 구조.
 * 각 Wireframe이 별도 페이지(섹션)이므로 Folder를 펼쳐 자식 Wireframe들을 최상위로 끌어올린다.
 *
 * - 단일 Folder 1개 + 자식 N개 → 자식 N개를 최상위로 (Folder 자체는 변환 단위 X)
 * - 다중 Folder → 모든 Folder의 자식 Wireframe을 모아 평탄화
 * - Folder 안에 또 Folder가 있으면 재귀
 */
function flattenAxshareSitemap(nodes: SitemapNode[]): SitemapNode[] {
  const out: SitemapNode[] = [];
  for (const n of nodes) {
    if (n.type === "Folder" && n.children && n.children.length > 0) {
      out.push(...flattenAxshareSitemap(n.children));
    } else {
      out.push(n);
    }
  }
  return out;
}

/**
 * SitemapNode 트리를 pageName 기준 자연 정렬 (00, 01, 02, ...).
 * 최상위 + 모든 children에 재귀 적용.
 */
function sortSitemapAsc(nodes: SitemapNode[]): SitemapNode[] {
  const sorted = [...nodes].sort((a, b) =>
    a.pageName.localeCompare(b.pageName, undefined, { numeric: true, sensitivity: "base" }),
  );
  return sorted.map((n) => ({
    ...n,
    children: n.children && n.children.length > 0 ? sortSitemapAsc(n.children) : n.children,
  }));
}

/**
 * Figma 노드 배열을 SitemapNode 트리로 변환.
 * SECTION/CANVAS → 카테고리(폴더), FRAME → 페이지(리프).
 * children이 있는 노드는 재귀적으로 처리.
 * 각 노드에 대해 isEmptyFigmaSection으로 "내용 없음" 여부 계산.
 */
function buildFigmaTree(nodes: FigmaNode[], baseUrl: string): SitemapNode[] {
  return nodes.map(node => {
    const hasChildren = !!node.children && node.children.length > 0;
    const isContainer = node.type === "SECTION" || node.type === "CANVAS" || node.type === "GROUP";
    const isEmpty = isEmptyFigmaSection(node);

    if (isContainer && hasChildren) {
      return {
        id: node.id,
        pageName: node.name,
        type: node.type,
        url: baseUrl,
        isEmpty,
        children: (node.children as FigmaNode[]).map(child => ({
          id: child.id,
          pageName: child.name,
          type: child.type,
          url: baseUrl,
          isEmpty: isEmptyFigmaSection(child),
          children: [],
        })),
      };
    }

    return {
      id: node.id,
      pageName: node.name,
      type: node.type,
      url: baseUrl,
      isEmpty,
      children: [],
    };
  });
}

const styles = {
  page: {
    display: "flex",
    flexDirection: "column" as const,
    minHeight: "100vh",
    padding: "32px",
    backgroundColor: "var(--color-bg)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
    marginBottom: "28px",
  },
  title: {
    color: "var(--color-text)",
    fontSize: "20px",
    fontWeight: 600,
    letterSpacing: "-0.01em",
  },
  content: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "12px",
    maxWidth: "680px",
    width: "100%",
    margin: "0 auto",
    flex: 1,
  },
  progressContainer: {
    backgroundColor: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius)",
    padding: "16px",
  },
  progressPageName: {
    color: "var(--color-text-secondary)",
    fontSize: "12px",
    marginTop: "8px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  sectionList: {
    backgroundColor: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius)",
    overflow: "hidden",
  },
  sectionHeader: {
    color: "var(--color-text-secondary)",
    fontSize: "12px",
    fontWeight: 600,
    letterSpacing: "0.03em",
    padding: "10px 16px",
    borderBottom: "1px solid var(--color-border)",
    backgroundColor: "var(--color-bg)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sectionItem: {
    alignItems: "center",
    borderBottom: "1px solid var(--color-border)",
    display: "flex",
    justifyContent: "space-between",
    padding: "11px 16px",
  },
  sectionName: {
    color: "var(--color-text)",
    fontSize: "13px",
  },
  sectionBadge: {
    backgroundColor: "var(--color-accent-subtle)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-accent)",
    fontSize: "11px",
    fontWeight: 500,
    padding: "2px 8px",
  },
  leafBadge: {
    backgroundColor: "rgba(34, 197, 94, 0.1)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-success)",
    fontSize: "11px",
    fontWeight: 500,
    padding: "2px 8px",
  },
  emptyBadge: {
    backgroundColor: "rgba(234, 179, 8, 0.12)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-warning)",
    fontSize: "11px",
    fontWeight: 500,
    padding: "2px 8px",
  },
  badgeGroup: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  indent: (depth: number) => ({
    paddingLeft: `${16 + depth * 16}px`,
  }),
  actions: {
    display: "flex",
    gap: "10px",
    justifyContent: "flex-end",
    marginTop: "4px",
  },
};

function SitemapTree({
  nodes,
  checkedIds,
  onToggle,
}: {
  nodes: SitemapNode[];
  checkedIds: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <>
      {nodes.map((node, idx) => {
        const isSection = node.children && node.children.length > 0;
        const isLast = idx === nodes.length - 1;
        return (
          <div
            key={node.id}
            style={{
              ...styles.sectionItem,
              borderBottom: isLast ? "none" : "1px solid var(--color-border)",
            }}
          >
            <span style={styles.sectionName}>
              <input
                type="checkbox"
                checked={checkedIds.has(node.id)}
                onChange={() => onToggle(node.id)}
                style={{ marginRight: "8px", cursor: "pointer" }}
              />
              {node.pageName}
            </span>
            <span style={styles.badgeGroup}>
              {node.isEmpty && (
                <span
                  style={styles.emptyBadge}
                  title="텍스트 없음 + 단일 이미지 — 변환 시 콘텐츠 부족"
                >
                  내용 없음
                </span>
              )}
              <span style={isSection ? styles.sectionBadge : styles.leafBadge}>
                {isSection ? `${node.children.length}개 프레임` : "페이지"}
              </span>
            </span>
          </div>
        );
      })}
    </>
  );
}

export default function AnalyzePage() {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const {
    workflow,
    setSitemap,
    setPages,
    setDocumentName,
    setPhase,
    setError: setWorkflowError,
    setWorkspaceDir,
    setWorkspaceSlug,
    setFileKey,
  } = useWorkflow();

  const [crawlProgress, setCrawlProgress] = useState({ current: 0, total: 0, page: "" });
  const [status, setStatus] = useState<"idle" | "crawling" | "done" | "error">("idle");
  const [localError, setLocalError] = useState<string | null>(null);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const [sitemapData, setSitemapData] = useState<SitemapNode[]>([]);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());

  // 중복 실행 방지
  const started = useRef(false);

  const allSectionIds = useMemo(() => sitemapData.map((n) => n.id), [sitemapData]);
  const allChecked = checkedIds.size === allSectionIds.length && allSectionIds.length > 0;

  const handleToggleAll = () => {
    if (allChecked) {
      setCheckedIds(new Set());
    } else {
      setCheckedIds(new Set(allSectionIds));
    }
  };

  const handleToggle = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!workflow.url) {
      navigate("/");
      return;
    }
    if (started.current) return;
    started.current = true;

    // 이미 sitemap이 있고 + 현재 URL의 sitemap[0].url과 workflow.url이 일치하면 재사용
    // (ConvertPage에서 돌아온 경우). URL이 바뀌었으면 stale → 재크롤.
    const sitemapMatchesUrl = (() => {
      if (!workflow.sitemap || workflow.sitemap.length === 0) return false;
      // figma는 sitemapNode.url이 baseUrl로 채워져 있고, axshare는 wireframe url
      // 두 케이스 모두 첫 노드의 url에 현재 workflow.url이 포함되어 있으면 매칭으로 간주
      const firstUrl = workflow.sitemap[0]?.url ?? "";
      if (!firstUrl) return false;
      // figma: sitemap[i].url == workflow.url (baseUrl 통째)
      // axshare: workflow.url의 origin이 firstUrl과 같은 사이트인지 확인
      try {
        const wfHost = new URL(workflow.url).hostname;
        return firstUrl.includes(wfHost) || workflow.url.includes(firstUrl);
      } catch {
        return false;
      }
    })();

    if (sitemapMatchesUrl) {
      console.log("[AnalyzePage] 기존 sitemap 재사용 — 같은 URL 재진입");
      setSitemapData(workflow.sitemap);
      if (workflow.pages.length > 0) {
        // ConvertPage 체크박스 변경 사항을 그대로 반영
        setCheckedIds(new Set(workflow.pages.filter((p) => p.selected).map((p) => p.path)));
      } else {
        setCheckedIds(new Set(workflow.sitemap.map((n) => n.id)));
      }
      // workspaceDir이 없으면 복원 시도 (settings 기반)
      if (!workflow.workspaceDir && workflow.workspaceSlug) {
        resolveOutputRoot(workflow.outputDir || settings.outputPath).then((root) => {
          ensureWorkspaceDir(root, workflow.workspaceSlug).then((dir) => {
            setWorkspaceDir(dir);
          });
        });
      }
      setStatus("done");
      return;
    }

    startCrawl();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (retryCountdown <= 0) return;
    const timer = setInterval(() => {
      setRetryCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          started.current = false;
          startCrawl();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryCountdown > 0]);

  const startCrawl = async () => {
    setStatus("crawling");
    setPhase("crawling");
    setLocalError(null);

    const rawOutputDir = workflow.outputDir || settings.outputPath;

    try {
      // outputPath의 '~' 해석
      const outputRoot = await resolveOutputRoot(rawOutputDir);

      if (workflow.sourceType === "axshare") {
        // Axshare 경로: workspace slug 결정 후 workspace 디렉토리 생성, runCrawl 실행
        const slug = deriveWorkspaceSlug({
          sourceType: "axshare",
          url: workflow.url,
        });
        const workspaceDir = await ensureWorkspaceDir(outputRoot, slug);
        setWorkspaceSlug(slug);
        setWorkspaceDir(workspaceDir);

        console.log(`[AnalyzePage] Axshare workspace: ${workspaceDir}`);

        let resolvedSitemapPath: string | null = null;

        await runCrawl(workflow.url, workspaceDir, (event) => {
          if (event.event === "progress") {
            setCrawlProgress({
              current: event.current ?? 0,
              total: event.total ?? 0,
              page: event.page ?? "",
            });
          } else if (event.event === "done" && event.type === "crawl") {
            resolvedSitemapPath = (event.sitemapPath as string) ?? null;
          }
        });

        if (!resolvedSitemapPath) {
          throw new Error("크롤링이 완료되었으나 sitemap 경로를 받지 못했습니다.");
        }

        const raw = await readTextFile(resolvedSitemapPath);
        const parsed: SitemapNode[] = JSON.parse(raw);
        // Axshare sitemap의 Folder 노드를 펼쳐 자식 Wireframe들을 최상위로 (각 페이지 = 변환 단위)
        const flattened = flattenAxshareSitemap(parsed);
        const sorted = sortSitemapAsc(flattened);
        setSitemap(sorted);
        setSitemapData(sorted);
        setCheckedIds(new Set(sorted.map((n) => n.id)));

        // _meta.json 초기 저장
        const newMeta: WorkspaceMeta = {
          version: 1,
          sourceUrl: workflow.url,
          sourceType: "axshare",
          documentName: "",
          sections: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const existingMeta = await readWorkspaceMeta(workspaceDir);
        await writeWorkspaceMeta(workspaceDir, existingMeta
          ? { ...existingMeta, sections: [] }
          : newMeta
        );
      } else if (workflow.sourceType === "figma") {
        // Figma 경로: documentName 먼저 수집 후 workspace slug 결정
        const fileKey = extractFileKey(workflow.url);
        if (!fileKey) {
          throw new Error("Figma URL에서 파일 키를 추출할 수 없습니다.");
        }

        setFileKey(fileKey);

        const nodeId = extractNodeId(workflow.url);
        let sitemapNodes: SitemapNode[];
        let figmaFileName = "";

        if (nodeId) {
          console.log(`[AnalyzePage] Figma node-id: ${nodeId}, fetching node detail...`);
          const [nodeDetail, fileMeta] = await Promise.all([
            getFigmaNodeDetail(fileKey, nodeId, settings.figmaToken),
            getFigmaFileMeta(fileKey, settings.figmaToken),
          ]);
          console.log(`[AnalyzePage] Node: "${nodeDetail.name}" (${nodeDetail.type}), children: ${nodeDetail.children?.length ?? 0}`);
          console.log(`[AnalyzePage] File name: "${fileMeta.name}"`);
          sitemapNodes = buildFigmaTree(nodeDetail.children || [], workflow.url);
          figmaFileName = fileMeta.name;
        } else {
          console.log(`[AnalyzePage] No node-id, fetching full file structure...`);
          const fileInfo = await getFigmaFileStructure(fileKey, settings.figmaToken);
          console.log(`[AnalyzePage] File: "${fileInfo.name}", pages: ${fileInfo.pages.length}`);
          sitemapNodes = buildFigmaTree(fileInfo.pages, workflow.url);
          figmaFileName = fileInfo.name;
        }

        setDocumentName(figmaFileName);

        // workspace slug + 디렉토리 결정
        const slug = deriveWorkspaceSlug({
          sourceType: "figma",
          url: workflow.url,
          documentName: figmaFileName,
          fileKey,
        });
        const workspaceDir = await ensureWorkspaceDir(outputRoot, slug);
        setWorkspaceSlug(slug);
        setWorkspaceDir(workspaceDir);

        console.log(`[AnalyzePage] Figma workspace: ${workspaceDir}`);

        const sortedNodes = sortSitemapAsc(sitemapNodes);
        console.log(`[AnalyzePage] Tree built: ${sortedNodes.length} top-level sections (sorted asc)`);
        sortedNodes.forEach(s => {
          console.log(`  [Section] ${s.pageName} (${s.type}) — ${s.children?.length ?? 0} frames`);
        });

        setSitemap(sortedNodes);
        setSitemapData(sortedNodes);
        setCheckedIds(new Set(sortedNodes.map((n) => n.id)));

        // _meta.json 초기 저장 (sitemap 캐시 포함)
        const existingMeta = await readWorkspaceMeta(workspaceDir);
        const newMeta: WorkspaceMeta = {
          version: 1,
          sourceUrl: workflow.url,
          sourceType: "figma",
          documentName: figmaFileName,
          fileKey,
          sections: existingMeta?.sections ?? [],
          sitemap: sortedNodes,
          createdAt: existingMeta?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await writeWorkspaceMeta(workspaceDir, newMeta);
      } else {
        throw new Error(`지원하지 않는 소스 타입입니다: ${workflow.sourceType}`);
      }

      setPhase("idle");
      setStatus("done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLocalError(msg);
      setWorkflowError(msg);
      setStatus("error");
      setPhase("idle");
      if (msg.includes("429") || msg.includes("rate limit") || msg.includes("한도 초과")) {
        setRetryCountdown(90);
      }
    }
  };

  const sectionCount = sitemapData.length;
  const frameCount = sitemapData.reduce((sum, n) => sum + (n.children?.length ?? 0), 0);

  const isAxshare = workflow.sourceType === "axshare";

  const handleStartConvert = () => {
    // 모든 섹션을 PageEntry로 변환 — 체크되지 않은 것도 ConvertPage 목록에 보이게.
    // 분석 화면을 다시 방문한 경우(workflow.pages가 비어있지 않음): 기존 status를 보존하고
    // selected만 새 체크 상태로 갱신 (이미 변환된 섹션을 다시 pending으로 돌리지 않음).
    const existing = new Map(workflow.pages.map((p) => [p.path, p]));
    const selectedSections: PageEntry[] = sitemapData
      .slice()
      .sort((a, b) => a.pageName.localeCompare(b.pageName, undefined, { numeric: true, sensitivity: "base" }))
      .map((n) => {
        const prev = existing.get(n.id);
        return {
          name: n.pageName,
          slug: slugify(n.pageName),
          sectionDir: "",
          path: n.id,
          status: prev?.status ?? ("pending" as const),
          substatus: prev?.substatus,
          selected: checkedIds.has(n.id),
        };
      });
    setSitemap(sitemapData);
    setPages(selectedSections);
    navigate("/convert");
  };

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <Button variant="secondary" onClick={() => navigate("/")}>
          뒤로
        </Button>
        <h1 style={styles.title}>구조 분석</h1>
      </div>

      <div style={styles.content}>
        {/* 진행 중 */}
        {status === "crawling" && (
          <>
            <StatusCard
              title={isAxshare ? "사이트맵 크롤링 중..." : "Figma 구조 분석 중..."}
              status="info"
            >
              {isAxshare
                ? "Axure Share 사이트맵을 분석하고 있습니다."
                : "Figma 파일의 페이지와 프레임 구조를 가져오고 있습니다."}
            </StatusCard>
            {isAxshare && (
              <div style={styles.progressContainer}>
                <ProgressBar
                  progress={crawlProgress.total > 0 ? Math.round((crawlProgress.current / crawlProgress.total) * 100) : 0}
                  label={
                    crawlProgress.total > 0
                      ? `${crawlProgress.current} / ${crawlProgress.total} 페이지`
                      : "처리 중..."
                  }
                />
                {crawlProgress.page && (
                  <div style={styles.progressPageName}>처리 중: {crawlProgress.page}</div>
                )}
              </div>
            )}
          </>
        )}

        {/* 에러 */}
        {status === "error" && localError && (
          <>
            <StatusCard title="분석 실패" status="error">
              {localError}
            </StatusCard>
            {retryCountdown > 0 && (
              <div style={{
                textAlign: "center",
                padding: "12px",
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius)",
                fontSize: "13px",
                color: "var(--color-text-secondary)",
              }}>
                <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-accent)", marginBottom: "4px" }}>
                  {Math.floor(retryCountdown / 60)}:{String(retryCountdown % 60).padStart(2, "0")}
                </div>
                자동 재시도까지 대기 중...
              </div>
            )}
            <div style={styles.actions}>
              <Button variant="secondary" onClick={() => navigate("/")}>
                취소
              </Button>
              <Button
                disabled={retryCountdown > 0}
                onClick={() => {
                  started.current = false;
                  setRetryCountdown(0);
                  startCrawl();
                }}
              >
                {retryCountdown > 0
                  ? `대기 중 (${Math.floor(retryCountdown / 60)}:${String(retryCountdown % 60).padStart(2, "0")})`
                  : "다시 시도"}
              </Button>
            </div>
          </>
        )}

        {/* 완료 */}
        {status === "done" && (
          <>
            <StatusCard title="구조 분석 완료" status="success">
              총 {sectionCount}개 섹션, {frameCount}개 프레임이 발견되었습니다.
              섹션 단위로 Markdown 변환됩니다.
            </StatusCard>

            {sitemapData.length > 0 && (
              <div style={styles.sectionList}>
                <div style={styles.sectionHeader}>
                  <span>발견된 구조 ({sitemapData.length}개 최상위 항목)</span>
                  <span
                    style={{ cursor: "pointer", color: "var(--color-accent)", fontSize: "11px", fontWeight: 500 }}
                    onClick={handleToggleAll}
                  >
                    {allChecked ? "전체 해제" : "전체 선택"}
                  </span>
                </div>
                <SitemapTree
                  nodes={sitemapData}
                  checkedIds={checkedIds}
                  onToggle={handleToggle}
                />
              </div>
            )}

            <div style={styles.actions}>
              <Button variant="secondary" onClick={() => navigate("/")}>
                취소
              </Button>
              <Button onClick={handleStartConvert} disabled={checkedIds.size === 0}>
                Markdown 변환 시작 ({checkedIds.size}개)
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
