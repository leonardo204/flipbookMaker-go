import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { readTextFile, exists, remove } from "@tauri-apps/plugin-fs";
import { useSettings } from "../contexts/SettingsContext";
import { useWorkflow } from "../contexts/WorkflowContext";
import Button from "../components/Button";
import ProgressBar from "../components/ProgressBar";
import StatusCard from "../components/StatusCard";
import { generateMarkdown } from "../services/claudeService";
import {
  extractFileKey,
  getFigmaNodeDetail,
  renderFigmaFramesToFiles,
  type FigmaNode,
} from "../services/figmaService";
import { readWorkspaceMeta, writeWorkspaceMeta, type WorkspaceMeta } from "../services/workspace";

const FALLBACK_OUTPUT_DIR = "~/Documents/FlipMD/output";

type StageStatus = "idle" | "converting" | "done" | "error";

/**
 * Figma URL에 node-id 쿼리 파라미터를 안전하게 설정/교체.
 * 기존 ?node-id=... 가 있어도 중복되지 않도록 URLSearchParams 사용.
 * URL 파싱 실패 시 base URL의 쿼리 부분만 잘라내고 새 node-id로 재구성.
 */
function buildFigmaPageUrl(baseUrl: string, nodeId: string): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("node-id", nodeId);
    return url.toString();
  } catch {
    const [pathPart] = baseUrl.split("?");
    return `${pathPart}?node-id=${encodeURIComponent(nodeId)}`;
  }
}

/**
 * Figma API/네트워크 에러를 사용자 친화적 한국어로 분류.
 * 토큰 미입력 / 한도 초과 / 권한 부족 / 네트워크 오류 등을 명확히 구분.
 */
function classifyFigmaError(rawMsg: string, stage: string, pageName: string): string {
  const msg = rawMsg.toLowerCase();

  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("한도 초과") || msg.includes("rate limited")) {
    return (
      `Figma API rate limit 초과 (${stage}, ${pageName})\n` +
      `Pro 한도: 메타 15/min, 이미지 6/min.\n` +
      `해결: 1-2분 대기 후 [재시도]. 자주 발생하면 token 별도 발급 또는 Pro 업그레이드.`
    );
  }
  if (msg.includes("401") || msg.includes("403") || msg.includes("invalid token") || msg.includes("forbidden")) {
    return (
      `Figma 인증 실패 (${stage}, ${pageName})\n` +
      `Personal Access Token이 만료되었거나 권한이 부족함.\n` +
      `해결: Settings에서 새 PAT 발급 후 입력. PAT는 file:read 스코프 필요.`
    );
  }
  if (msg.includes("404") || msg.includes("not found")) {
    return (
      `Figma 노드를 찾을 수 없음 (${stage}, ${pageName})\n` +
      `해당 섹션이 삭제되었거나 file_key/node_id가 변경됐을 수 있음.\n` +
      `해결: Figma URL을 다시 확인하고 [분석 화면]에서 sitemap 새로고침.`
    );
  }
  if (msg.includes("400") || msg.includes("bad request")) {
    return (
      `Figma API 잘못된 요청 (${stage}, ${pageName})\n` +
      `노드 ID 형식이 잘못됐거나 batch가 너무 큼.\n` +
      `상세: ${rawMsg.slice(0, 200)}`
    );
  }
  if (msg.includes("network") || msg.includes("econnrefused") || msg.includes("etimedout") || msg.includes("fetch")) {
    return (
      `네트워크 오류 (${stage}, ${pageName})\n` +
      `Figma API 또는 S3 연결 실패. 인터넷 연결 / VPN / 방화벽 확인.\n` +
      `상세: ${rawMsg.slice(0, 200)}`
    );
  }
  // 기본
  return `Figma ${stage} 실패 (${pageName})\n상세: ${rawMsg.slice(0, 300)}`;
}

/**
 * 노드 트리에서 렌더링 대상 프레임을 수집해 시각 순서(상→하, 좌→우)로 정렬한 ID 목록 반환.
 * - 직속 자식 중 FRAME/COMPONENT/INSTANCE 대상
 * - SECTION/GROUP은 한 단계 더 들어가서 그 안의 FRAME 수집
 * - 정렬 기준: bbox.y (행) → bbox.x (열). bbox 없으면 트리 순서 유지
 *
 * 시각 순서로 정렬해야 LLM이 "이미지를 이어 보면 하나의 흐름"으로 파악 가능.
 */
function collectFrameIds(node: FigmaNode): string[] {
  const collected: FigmaNode[] = [];

  function walk(n: FigmaNode, isRoot: boolean) {
    if (!isRoot && (n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE")) {
      if (n.id) collected.push(n);
      return; // FRAME 내부의 더 깊은 FRAME은 별도 화면으로 보지 않음 (자식 컴포넌트는 한 화면 내부 요소)
    }
    if (n.type === "SECTION" || n.type === "GROUP" || n.type === "CANVAS" || isRoot) {
      n.children?.forEach((c) => walk(c, false));
    }
  }

  // 루트 자체가 FRAME이면 자기 자신을 우선 추가
  if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") {
    if (node.id) collected.push(node);
    node.children?.forEach((c) => walk(c, false));
  } else {
    walk(node, true);
  }

  // bbox 기반 시각 정렬 (행 → 열). 같은 행으로 묶기 위해 y를 100px 단위로 라운딩.
  const ROW_GROUP = 100;
  const sorted = [...collected].sort((a, b) => {
    if (!a.bbox || !b.bbox) return 0;
    const aRow = Math.floor(a.bbox.y / ROW_GROUP);
    const bRow = Math.floor(b.bbox.y / ROW_GROUP);
    if (aRow !== bRow) return aRow - bRow;
    return a.bbox.x - b.bbox.x;
  });

  return sorted.map((n) => n.id);
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
    alignItems: "center",
    display: "flex",
    gap: "12px",
    marginBottom: "28px",
    flexWrap: "wrap" as const,
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
    flex: 1,
    gap: "12px",
    margin: "0 auto",
    maxWidth: "680px",
    width: "100%",
  },
  stageLabel: {
    color: "var(--color-text-secondary)",
    fontSize: "12px",
    marginTop: "6px",
  },
  docList: {
    backgroundColor: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius)",
    overflow: "hidden",
  },
  docHeader: {
    borderBottom: "1px solid var(--color-border)",
    color: "var(--color-text-secondary)",
    fontSize: "12px",
    fontWeight: 600,
    letterSpacing: "0.03em",
    padding: "10px 16px",
    backgroundColor: "var(--color-bg)",
  },
  docItem: {
    alignItems: "center",
    display: "flex",
    gap: "12px",
    justifyContent: "space-between",
    padding: "10px 16px",
  },
  docRowOuter: {
    display: "flex",
    flexDirection: "column" as const,
  },
  errorPanel: {
    backgroundColor: "rgba(239, 68, 68, 0.06)",
    borderTop: "1px solid var(--color-border)",
    color: "var(--color-text)",
    fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
    fontSize: "11px",
    lineHeight: 1.5,
    padding: "10px 16px",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  },
  rowActionBtn: {
    backgroundColor: "transparent",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-text)",
    cursor: "pointer",
    fontSize: "11px",
    fontWeight: 500,
    padding: "3px 8px",
    transition: "background 0.15s, border-color 0.15s",
  },
  rowActionBtnPrimary: {
    backgroundColor: "var(--color-accent)",
    border: "1px solid var(--color-accent)",
    borderRadius: "var(--radius-sm)",
    color: "white",
    cursor: "pointer",
    fontSize: "11px",
    fontWeight: 500,
    padding: "3px 10px",
  },
  rowActionBtnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
  docName: {
    color: "var(--color-text)",
    fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
    fontSize: "12px",
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  openLink: {
    color: "var(--color-accent)",
    fontSize: "12px",
    fontWeight: 500,
    cursor: "pointer",
    marginLeft: "8px",
    textDecoration: "none" as const,
  },
  statusGroup: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    flexShrink: 0,
  },
  actions: {
    display: "flex",
    gap: "10px",
    justifyContent: "flex-end",
    marginTop: "4px",
  },
};

function stageLabelText(stage: StageStatus): string {
  switch (stage) {
    case "converting":
      return "Markdown 생성 중...";
    case "done":
      return "변환 완료";
    case "error":
      return "오류 발생";
    default:
      return "변환 준비 중...";
  }
}

export default function ConvertPage() {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const {
    workflow,
    setPhase,
    updatePageStatus,
    updatePageSubstatus,
    updatePageSelected,
    setAllPagesSelected,
  } = useWorkflow();

  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<StageStatus>("idle");
  const [localError, setLocalError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);

  // 완료된 페이지 수 (Markdown 생성 완료 기준)
  const [doneCount, setDoneCount] = useState(0);
  const [pageErrors, setPageErrors] = useState<Record<string, string>>({});
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());

  // 중복 실행 방지
  const started = useRef(false);
  const stoppedRef = useRef(false);

  // workspaceDir 우선 — 없으면 outputDir → settings.outputPath 순으로 fallback
  const outputDir = workflow.workspaceDir || workflow.outputDir || settings.outputPath || FALLBACK_OUTPUT_DIR;
  const pages = workflow.pages;

  useEffect(() => {
    if (!workflow.url) {
      navigate("/");
      return;
    }
    if (started.current) return;
    started.current = true;
    stoppedRef.current = false;

    // 선택된 섹션이 없으면 자동 일괄 변환 시작 안 함 (사용자가 행별 [변환]으로 개별 시작)
    const hasSelected = workflow.pages.some((p) => p.selected);
    if (hasSelected) {
      startPipeline();
    } else {
      console.log("[ConvertPage] 선택된 섹션 0개 — 일괄 변환 건너뜀, 개별 변환 대기");
      setStage("idle");
      setPhase("idle");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // workflow.pages 변경 시 _meta.json sections 갱신 (500ms debounce)
  const metaDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const wsDir = workflow.workspaceDir;
    if (!wsDir || pages.length === 0) return;

    if (metaDebounceRef.current) clearTimeout(metaDebounceRef.current);
    metaDebounceRef.current = setTimeout(async () => {
      try {
        const existingMeta = await readWorkspaceMeta(wsDir);
        if (!existingMeta) return;

        const sections: WorkspaceMeta["sections"] = pages.map((p) => ({
          name: p.name,
          slug: p.slug,
          path: p.path,
          sectionDir: p.sectionDir,
          status: p.status,
          selected: p.selected,
        }));

        await writeWorkspaceMeta(wsDir, { ...existingMeta, sections });
      } catch (e) {
        console.warn("[ConvertPage] _meta.json sections 갱신 실패:", e);
      }
    }, 500);

    return () => {
      if (metaDebounceRef.current) clearTimeout(metaDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, workflow.workspaceDir]);

  /**
   * 단일 섹션 변환 — 데이터 수집(메타+이미지) + Claude 호출 + 결과 반영.
   * 일괄 변환과 단일 변환/재시도에서 공통으로 사용.
   * @returns true = 성공, false = 실패 (호출자가 progress/state 갱신)
   */
  const processOnePage = async (page: typeof pages[number]): Promise<boolean> => {
    const claudePath = settings.claudePath || "claude";
    const isFigma = workflow.sourceType === "figma";
    const fileKey = isFigma ? extractFileKey(workflow.url) : null;

    updatePageStatus(page.name, "converting");
    // 진입 시 이전 에러 메시지 정리
    setPageErrors((prev) => {
      if (!prev[page.name]) return prev;
      const next = { ...prev };
      delete next[page.name];
      return next;
    });

    let textContent = "";
    let pageUrl = workflow.url;
    let imagePaths: string[] = [];

    // 기존 .md 파일이 있으면 사전 삭제 — Claude가 "이미 있어 유지" 판단 차단
    const targetMdPath = `${outputDir}/${page.slug}.md`;
    try {
      if (await exists(targetMdPath)) {
        updatePageSubstatus(page.name, "기존 파일 정리");
        await remove(targetMdPath);
        console.log(`[ConvertPage] 기존 파일 삭제: ${targetMdPath}`);
      }
    } catch (e) {
      console.warn(`[ConvertPage] 기존 파일 삭제 실패 (계속 진행):`, e);
    }

    if (isFigma && fileKey) {
      // Step 1: 메타데이터(노드 트리) — 여기 실패는 fatal
      let nodeDetail: FigmaNode | null = null;
      try {
        updatePageSubstatus(page.name, "노드 트리 수집");
        nodeDetail = await getFigmaNodeDetail(fileKey, page.path, settings.figmaToken);
        const frameCount = nodeDetail.children?.length ?? 0;
        console.log(`[ConvertPage] Section "${page.name}": ${frameCount} frames`);
        textContent = JSON.stringify(nodeDetail);
        pageUrl = buildFigmaPageUrl(workflow.url, page.path);
      } catch (e) {
        console.error(`[ConvertPage] Meta fetch failed for "${page.name}":`, e);
        const errStr = e instanceof Error ? e.message : String(e);
        const detailedError = classifyFigmaError(errStr, "메타 fetch", page.name);
        updatePageStatus(page.name, "error");
        setPageErrors((prev) => ({ ...prev, [page.name]: detailedError }));
        return false;
      }

      // Step 2: 이미지 렌더 (best-effort — 실패해도 메타로 계속)
      if (nodeDetail) {
        const frameIds = collectFrameIds(nodeDetail);
        if (frameIds.length > 0) {
          const imageDir = `${outputDir}/_figma_images/${page.slug}`;
          try {
            const downloaded = await renderFigmaFramesToFiles(
              fileKey,
              frameIds,
              settings.figmaToken,
              imageDir,
              1,
              (ev) => {
                if (ev.phase === "rendering") {
                  updatePageSubstatus(page.name, `이미지 렌더 요청 (${frameIds.length}개)`);
                } else {
                  updatePageSubstatus(page.name, `이미지 다운로드 ${ev.current}/${ev.total}`);
                }
              },
            );
            imagePaths = Object.values(downloaded).filter((p): p is string => p !== null);
            console.log(
              `[ConvertPage] Section "${page.name}": ${imagePaths.length}/${frameIds.length} 이미지 다운로드 성공`,
            );
            if (imagePaths.length === 0 && frameIds.length > 0) {
              console.warn(
                `[ConvertPage] 모든 이미지 다운로드 실패 — 메타만으로 변환 진행 (${page.name})`,
              );
            }
          } catch (e) {
            console.warn(`[ConvertPage] 이미지 렌더 실패(메타는 유지) "${page.name}":`, e);
          }
        }
      }
    } else if (!isFigma) {
      // Axshare 분기
      const pageDataDir = page.sectionDir ? `${outputDir}/${page.sectionDir}` : outputDir;
      try {
        textContent = await readTextFile(`${pageDataDir}/${page.slug}.txt`);
      } catch {
        textContent = `(텍스트 파일 없음: ${page.slug}.txt)`;
      }
    }

    updatePageSubstatus(
      page.name,
      imagePaths.length > 0
        ? `Claude 분석 (이미지 ${imagePaths.length}개)`
        : "Claude 분석 (메타만)",
    );

    const result = await generateMarkdown(
      claudePath,
      pageUrl,
      page.slug,
      page.name,
      textContent,
      outputDir,
      workflow.sourceType,
      workflow.documentName,
      imagePaths,
    );

    if (result.success) {
      updatePageStatus(page.name, "done");
      return true;
    } else {
      updatePageStatus(page.name, "error");
      setPageErrors((prev) => ({ ...prev, [page.name]: result.error || "알 수 없는 오류" }));
      return false;
    }
  };

  /**
   * selected=true 인 섹션만 일괄 변환.
   * (selected=false 항목은 목록에 표시되지만 개별 [변환] 버튼으로만 처리 가능)
   */
  const startPipeline = async () => {
    setLocalError(null);
    setStopped(false);
    setStage("converting");
    setPhase("converting");

    const targetPages = pages.filter((p) => p.selected);
    const perPageProgress = targetPages.length > 0 ? 100 / targetPages.length : 0;
    let completedCount = 0;

    if (targetPages.length === 0) {
      setStage("idle");
      setPhase("idle");
      return;
    }

    for (let pi = 0; pi < targetPages.length; pi++) {
      const page = targetPages[pi];
      if (stoppedRef.current) break;
      const ok = await processOnePage(page);
      if (ok) {
        completedCount += 1;
        setDoneCount(completedCount);
      }
      setProgress(Math.round(perPageProgress * (pi + 1)));
    }

    if (!stoppedRef.current) {
      setProgress(100);
      // 일괄 대상(selected) 중 부분 실패가 있으면 idle로 — 사용자가 행별 [재시도] 가능
      const hasFailures = targetPages.some((p) => {
        const cur = pages.find((x) => x.name === p.name);
        return cur?.status === "error";
      });
      if (hasFailures) {
        setStage("idle");
        setPhase("idle");
      } else {
        setStage("done");
        setPhase("done");
      }
    }
  };

  /**
   * 선택된 미완료 섹션만 일괄 변환 (재변환 X — done은 [재변환] 버튼 별도 사용).
   * 변환 중에는 호출 차단.
   */
  const convertSelected = async () => {
    if (singleRunningRef.current || stage === "converting") {
      console.log("[ConvertPage] 다른 작업 진행 중 — 선택 변환 차단");
      return;
    }
    const targets = pages.filter(
      (p) => p.selected && p.status !== "done" && p.status !== "converting",
    );
    if (targets.length === 0) {
      console.log("[ConvertPage] 변환 대상 없음 (선택+미완료+미진행)");
      return;
    }

    singleRunningRef.current = true;
    setLocalError(null);
    setStopped(false);
    setStage("converting");
    setPhase("converting");
    stoppedRef.current = false;

    const perPageProgress = 100 / targets.length;
    let completedThisRun = 0;

    try {
      for (let pi = 0; pi < targets.length; pi++) {
        if (stoppedRef.current) break;
        const ok = await processOnePage(targets[pi]);
        if (ok) completedThisRun++;
        setProgress(Math.round(perPageProgress * (pi + 1)));
      }

      if (!stoppedRef.current) {
        setProgress(100);
        // 전체 done 여부 재산출
        const allDoneNow = pages.every(
          (p) => p.status === "done" || (!p.selected && p.status === "pending"),
        );
        if (allDoneNow) {
          setStage("done");
          setPhase("done");
        } else {
          setStage("idle");
          setPhase("idle");
        }
      }
      // doneCount 재산출
      const total = pages.filter((p) => p.status === "done").length + completedThisRun;
      setDoneCount(total);
    } finally {
      singleRunningRef.current = false;
    }
  };

  /**
   * 단일 섹션만 변환 (개별 변환 / 재시도 버튼).
   * 일괄 변환 도중에는 호출 차단 (singleRunningRef).
   */
  const singleRunningRef = useRef(false);

  const convertSingle = async (page: typeof pages[number]) => {
    if (singleRunningRef.current || stage === "converting") {
      console.log("[ConvertPage] 다른 작업 진행 중 — 단일 변환 차단");
      return;
    }
    singleRunningRef.current = true;
    try {
      const prevDoneSet = new Set(pages.filter((p) => p.status === "done").map((p) => p.name));
      const wasDone = prevDoneSet.has(page.name);

      await processOnePage(page);

      // doneCount 재산출 — 단일 변환 결과를 반영해 진행률 갱신
      const newDone = pages.reduce((acc, p) => {
        if (p.name === page.name) {
          // workflow 갱신은 비동기라 결과가 즉시 반영 안 될 수 있음 — 직접 비교
          return acc;
        }
        return p.status === "done" ? acc + 1 : acc;
      }, 0);
      // 단일 변환 후 done 상태는 workflow.pages가 가지고 있으므로 직접 카운트
      const refreshed = pages.find((p) => p.name === page.name);
      const isDoneNow = refreshed?.status === "done";
      const adjusted = newDone + (isDoneNow ? 1 : 0);
      setDoneCount(adjusted);

      if (!wasDone && adjusted === pages.length) {
        setStage("done");
        setProgress(100);
        setPhase("done");
      }
    } finally {
      singleRunningRef.current = false;
    }
  };

  const handleStop = () => {
    stoppedRef.current = true;
    setStopped(true);
    setStage("error");
    setPhase("idle");
  };

  const handleRetry = () => {
    setProgress(0);
    setDoneCount(0);
    setLocalError(null);
    setStage("idle");
    started.current = false;
    stoppedRef.current = false;
    startPipeline();
    started.current = true;
  };

  const totalPages = pages.length;
  const selectedPages = pages.filter((p) => p.selected);
  const selectedTotal = selectedPages.length;
  const displayDone = doneCount;

  const busyAny = stage === "converting" || singleRunningRef.current;
  const pendingSelectedCount = pages.filter(
    (p) => p.selected && p.status !== "done" && p.status !== "converting",
  ).length;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <Button
          variant="secondary"
          onClick={() => navigate("/")}
          disabled={busyAny}
        >
          처음으로
        </Button>
        <Button
          variant="secondary"
          onClick={() => navigate("/analyze")}
          disabled={busyAny}
        >
          분석 화면
        </Button>
        <h1 style={styles.title}>Markdown 변환</h1>
      </div>

      <div style={styles.content}>
        <ProgressBar progress={progress} label="변환 진행률" />
        <div style={styles.stageLabel}>{stageLabelText(stage)}</div>

        {/* 완료 상태 */}
        {stage === "done" && (
          <StatusCard title="변환 완료" status="success">
            선택한 {selectedTotal}개 문서가 성공적으로 변환되었습니다. Confluence에 업로드할 수 있습니다.
            {selectedTotal < totalPages && ` (선택 안 한 ${totalPages - selectedTotal}개는 목록에서 개별 변환 가능합니다.)`}
          </StatusCard>
        )}

        {/* 에러 상태 */}
        {stage === "error" && localError && (
          <StatusCard title="변환 실패" status="error">
            {localError}
          </StatusCard>
        )}

        {/* 중지 상태: 현재 진행 중인 작업이 완료된 후 루프가 종료됨 */}
        {stopped && !localError && (
          <StatusCard title="변환 중지됨" status="error">
            사용자가 변환을 중지했습니다. 현재 진행 중인 작업이 완료된 후 중지됩니다.
          </StatusCard>
        )}

        {/* 선택 변환 컨트롤바 */}
        {totalPages > 0 && (
          <div
            style={{
              alignItems: "center",
              display: "flex",
              gap: "8px",
              flexWrap: "wrap" as const,
            }}
          >
            <Button
              variant="secondary"
              onClick={() => setAllPagesSelected(true)}
              disabled={busyAny}
            >
              전체 선택
            </Button>
            <Button
              variant="secondary"
              onClick={() => setAllPagesSelected(false)}
              disabled={busyAny}
            >
              전체 해제
            </Button>
            <div style={{ flex: 1 }} />
            <Button
              onClick={convertSelected}
              disabled={busyAny || pendingSelectedCount === 0}
            >
              선택한 {pendingSelectedCount}개 변환
            </Button>
          </div>
        )}

        {/* 문서 목록 */}
        {totalPages > 0 && (
          <div style={styles.docList}>
            <div style={styles.docHeader}>
              변환된 문서 ({displayDone}/{selectedTotal}개 선택됨, 전체 {totalPages}개)
            </div>
            {pages.map((page, idx) => {
              const isLast = idx === pages.length - 1;
              const isErrorExpanded = expandedErrors.has(page.name);
              const busy = stage === "converting" || page.status === "converting";

              const toggleError = () => {
                setExpandedErrors((prev) => {
                  const next = new Set(prev);
                  if (next.has(page.name)) next.delete(page.name);
                  else next.add(page.name);
                  return next;
                });
              };

              const dim = !page.selected && page.status === "pending";
              return (
                <div
                  key={page.name}
                  style={{
                    ...styles.docRowOuter,
                    borderBottom: isLast ? "none" : "1px solid var(--color-border)",
                    opacity: dim ? 0.7 : 1,
                  }}
                >
                  <div style={styles.docItem}>
                    <input
                      type="checkbox"
                      checked={page.selected}
                      disabled={busy || page.status === "converting"}
                      onChange={(e) => updatePageSelected(page.name, e.target.checked)}
                      style={{ cursor: busy ? "not-allowed" : "pointer", marginRight: "4px" }}
                      title="일괄 변환 대상에 포함"
                    />
                    <span style={styles.docName}>{page.name}.md</span>
                    <div style={styles.statusGroup}>
                      {page.status === "done" && (
                        <>
                          <span
                            style={{ color: "var(--color-success)", fontSize: "12px", fontWeight: 500 }}
                          >
                            완료
                          </span>
                          <span
                            style={styles.openLink}
                            onClick={() =>
                              invoke("open_path", { path: `${outputDir}/${page.slug}.md` })
                                .catch((e) => alert(`파일 열기 실패: ${e}`))
                            }
                          >
                            열기
                          </span>
                          <button
                            style={{
                              ...styles.rowActionBtn,
                              ...(busy ? styles.rowActionBtnDisabled : {}),
                            }}
                            disabled={busy}
                            onClick={() => convertSingle(page)}
                            title="이 섹션을 다시 변환"
                          >
                            재변환
                          </button>
                        </>
                      )}
                      {page.status === "converting" && (
                        <span
                          style={{
                            color: "var(--color-warning)",
                            fontSize: "12px",
                            fontWeight: 500,
                            maxWidth: "320px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap" as const,
                          }}
                          title={page.substatus || "변환 중"}
                        >
                          {page.substatus ? `변환 중 — ${page.substatus}` : "변환 중..."}
                        </span>
                      )}
                      {page.status === "error" && (
                        <>
                          <span
                            style={{
                              color: "var(--color-error, #ef4444)",
                              fontSize: "12px",
                              fontWeight: 500,
                              maxWidth: "300px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap" as const,
                              cursor: "pointer",
                              textDecoration: "underline dotted",
                            }}
                            title="클릭해서 상세 사유 펼치기/접기"
                            onClick={toggleError}
                          >
                            {pageErrors[page.name]
                              ? `오류: ${pageErrors[page.name].slice(0, 50)}${pageErrors[page.name].length > 50 ? "…" : ""}`
                              : "오류"}
                          </span>
                          <button
                            style={{
                              ...styles.rowActionBtnPrimary,
                              ...(busy ? styles.rowActionBtnDisabled : {}),
                            }}
                            disabled={busy}
                            onClick={() => convertSingle(page)}
                            title="이 섹션만 재시도"
                          >
                            재시도
                          </button>
                        </>
                      )}
                      {page.status === "pending" && page.selected && (
                        <>
                          <span
                            style={{ color: "var(--color-text-tertiary)", fontSize: "12px" }}
                          >
                            대기
                          </span>
                          <button
                            style={{
                              ...styles.rowActionBtnPrimary,
                              ...(busy ? styles.rowActionBtnDisabled : {}),
                            }}
                            disabled={busy}
                            onClick={() => convertSingle(page)}
                            title="이 섹션만 변환"
                          >
                            변환
                          </button>
                        </>
                      )}
                      {page.status === "pending" && !page.selected && (
                        <>
                          <span
                            style={{
                              color: "var(--color-text-tertiary)",
                              fontSize: "12px",
                              fontStyle: "italic",
                            }}
                            title="분석 단계에서 체크 해제됨 — 일괄 변환에서 제외"
                          >
                            선택 안 함
                          </span>
                          <button
                            style={{
                              ...styles.rowActionBtn,
                              ...(busy ? styles.rowActionBtnDisabled : {}),
                            }}
                            disabled={busy}
                            onClick={() => convertSingle(page)}
                            title="이 섹션만 개별 변환"
                          >
                            변환
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {page.status === "error" && isErrorExpanded && pageErrors[page.name] && (
                    <div style={styles.errorPanel}>{pageErrors[page.name]}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* 문서 목록이 없는 경우 (workflow.pages가 비어있을 때) */}
        {totalPages === 0 && stage !== "done" && stage !== "error" && (
          <StatusCard title="페이지 목록 없음" status="info">
            분석 단계에서 페이지를 불러오지 못했습니다. 처음으로 돌아가서 다시 시도하세요.
          </StatusCard>
        )}

        {/* 액션 버튼 */}
        <div style={styles.actions}>
          {stage === "converting" && !stopped && (
            <Button variant="danger" onClick={handleStop}>
              중지
            </Button>
          )}

          {(stage === "error" || stopped) && (
            <>
              <Button variant="secondary" onClick={() => navigate("/")}>
                처음으로
              </Button>
              <Button onClick={handleRetry}>다시 시도</Button>
            </>
          )}

          {/* 일괄 변환 끝났는데 부분 실패가 있는 경우 (stage = idle) */}
          {stage === "idle" && pages.some((p) => p.status === "error") && (
            <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
              <Button variant="secondary" onClick={() => navigate("/")}>
                처음으로
              </Button>
              <Button onClick={handleRetry}>실패 포함 전체 다시 변환</Button>
            </div>
          )}

          {stage === "done" && (
            <div style={{ display: "flex", gap: "10px", width: "100%", flexWrap: "wrap" as const }}>
              <Button
                variant="secondary"
                onClick={() => invoke("open_path", { path: outputDir }).catch((e) => alert(`폴더 열기 실패: ${e}`))}
              >
                결과 폴더 열기
              </Button>
              <div style={{ flex: 1 }} />
              <Button onClick={() => navigate("/upload")}>Confluence 업로드</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
