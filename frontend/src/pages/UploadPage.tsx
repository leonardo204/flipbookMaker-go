import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { readTextFile, readDir } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import Button from "../components/Button";
import ProgressBar from "../components/ProgressBar";
import StatusCard from "../components/StatusCard";
import TextInput from "../components/TextInput";
import { useSettings } from "../contexts/SettingsContext";
import { useWorkflow } from "../contexts/WorkflowContext";
import { readWorkspaceMeta } from "../services/workspace";
import {
  uploadToConfluence,
  parseConfluenceParentUrl,
  type MdFile,
  type UploadResult,
} from "../services/confluenceService";

// 각 페이지별 업로드 진행 상태
type PageUploadStatus = "waiting" | "uploading" | "success" | "error";

// parentPageUrl 확인 상태
type ParentPageStatus = "idle" | "resolving" | "resolved" | "error";

// Children page 제목 정책 — Confluence는 Space 내 제목이 고유해야 함
// auto: 오늘 날짜를 Suffix로 자동 추가 / prefix·suffix: 사용자 입력값 사용
type TitlePolicyMode = "auto" | "prefix" | "suffix";

const todayYmd = (): string => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const applyTitlePolicy = (
  name: string,
  mode: TitlePolicyMode,
  prefixText: string,
  suffixText: string,
): string => {
  if (mode === "auto") return `${name} (${todayYmd()})`;
  if (mode === "prefix") {
    const v = prefixText.trim();
    return v ? `${v} ${name}` : name;
  }
  if (mode === "suffix") {
    const v = suffixText.trim();
    return v ? `${name} ${v}` : name;
  }
  return name;
};

interface PageUploadEntry {
  name: string;
  path: string;
  status: PageUploadStatus;
  result?: UploadResult;
}

interface CollectedMdFile extends MdFile {
  path: string; // .md 파일 절대 경로 (목록 표시용)
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
    flex: 1,
    gap: "12px",
    margin: "0 auto",
    maxWidth: "680px",
    width: "100%",
  },
  section: {
    backgroundColor: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius)",
    display: "flex",
    flexDirection: "column" as const,
    gap: "10px",
    padding: "20px",
  },
  sectionTitle: {
    color: "var(--color-text)",
    fontSize: "13px",
    fontWeight: 600,
    marginBottom: "2px",
  },
  configRow: {
    display: "flex",
    gap: "8px",
    fontSize: "13px",
  },
  configLabel: {
    color: "var(--color-text-secondary)",
    minWidth: "80px",
  },
  configValue: {
    color: "var(--color-text)",
    flex: 1,
    wordBreak: "break-all" as const,
  },
  pageList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "6px",
  },
  pageRow: {
    alignItems: "center",
    display: "flex",
    gap: "10px",
    padding: "8px 12px",
    backgroundColor: "var(--color-bg)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
  },
  pageName: {
    flex: 1,
    fontSize: "13px",
    color: "var(--color-text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  pageStatusBadge: (status: PageUploadStatus) => ({
    fontSize: "11px",
    fontWeight: 500,
    padding: "2px 8px",
    borderRadius: "var(--radius-sm)",
    backgroundColor:
      status === "success"
        ? "rgba(34, 197, 94, 0.12)"
        : status === "error"
          ? "rgba(239, 68, 68, 0.12)"
          : status === "uploading"
            ? "rgba(99, 102, 241, 0.12)"
            : "rgba(148, 163, 184, 0.12)",
    color:
      status === "success"
        ? "var(--color-success)"
        : status === "error"
          ? "var(--color-error)"
          : status === "uploading"
            ? "var(--color-accent)"
            : "var(--color-text-secondary)",
  }),
  pageUrlLink: {
    fontSize: "11px",
    color: "var(--color-accent)",
    cursor: "pointer",
    textDecoration: "underline",
    whiteSpace: "nowrap" as const,
  },
  errorText: {
    fontSize: "11px",
    color: "var(--color-error)",
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  actions: {
    display: "flex",
    gap: "10px",
    justifyContent: "flex-end",
    marginTop: "4px",
  },
  parentPageRow: {
    display: "flex",
    gap: "8px",
    alignItems: "flex-end",
  },
  parentPageStatus: (status: ParentPageStatus): React.CSSProperties => ({
    fontSize: "12px",
    fontWeight: 500,
    color:
      status === "resolved"
        ? "var(--color-success)"
        : status === "error"
          ? "var(--color-error)"
          : status === "resolving"
            ? "var(--color-warning)"
            : "var(--color-text-secondary)",
  }),
  policyHelp: {
    fontSize: "12px",
    color: "var(--color-text-secondary)",
    lineHeight: 1.55,
  },
  radioRow: {
    display: "flex",
    gap: "10px",
    marginTop: "4px",
  },
  radioCard: (selected: boolean): React.CSSProperties => ({
    flex: 1,
    border: `1px solid ${selected ? "var(--color-accent)" : "var(--color-border)"}`,
    backgroundColor: selected
      ? "rgba(99, 102, 241, 0.10)"
      : "var(--color-bg)",
    borderRadius: "var(--radius-sm)",
    padding: "10px 12px",
    cursor: "pointer",
    display: "flex",
    alignItems: "flex-start",
    gap: "8px",
    transition: "border-color .12s, background-color .12s",
  }),
  radioLabel: {
    fontSize: "13px",
    fontWeight: 600,
    color: "var(--color-text)",
  },
  radioDesc: {
    fontSize: "11px",
    color: "var(--color-text-secondary)",
    marginTop: "2px",
    lineHeight: 1.4,
  },
  policyInfo: {
    display: "flex",
    alignItems: "flex-start",
    gap: "8px",
    padding: "10px 12px",
    backgroundColor: "var(--color-bg)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
    fontSize: "13px",
    color: "var(--color-text)",
    lineHeight: 1.5,
  },
  policyInfoAccent: {
    color: "var(--color-accent)",
    fontWeight: 600,
  },
  policyError: {
    fontSize: "12px",
    color: "var(--color-error)",
    marginTop: "4px",
  },
};

const PAGE_STATUS_LABELS: Record<PageUploadStatus, string> = {
  waiting: "대기",
  uploading: "업로드 중",
  success: "완료",
  error: "실패",
};

export default function UploadPage() {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const { workflow } = useWorkflow();

  // 수집된 .md 파일 목록
  const [collectedFiles, setCollectedFiles] = useState<CollectedMdFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  const [pageEntries, setPageEntries] = useState<PageUploadEntry[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadDone, setUploadDone] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());

  // 중단 신호 — 호출자가 stopped=true로 설정하면 confluenceService가 다음 페이지부터 처리 중단
  const stopRef = useRef<{ stopped: boolean }>({ stopped: false });

  // 상위 페이지 URL inline form (필수 — Space Key를 여기서 자동 추출)
  const [parentPageUrl, setParentPageUrl] = useState("");
  const [parentPageStatus, setParentPageStatus] = useState<ParentPageStatus>("idle");
  const [parentPageId, setParentPageId] = useState<string | null>(null);
  const [parentSpaceKey, setParentSpaceKey] = useState<string | null>(null);
  const [parentResolveError, setParentResolveError] = useState<string | null>(null);

  // Children page 제목 정책 — Confluence Space 내 제목 중복 방지용
  const [titleMode, setTitleMode] = useState<TitlePolicyMode>("auto");
  const [titlePrefix, setTitlePrefix] = useState("");
  const [titleSuffix, setTitleSuffix] = useState("");

  // 설정 미완료 여부
  const settingsIncomplete = !settings.confluenceVerified;

  // workspaceDir 기반 .md 파일 수집
  const collectMdFiles = useCallback(async (): Promise<CollectedMdFile[]> => {
    const workspaceDir = workflow.workspaceDir;
    if (!workspaceDir) return [];

    const mdFiles: CollectedMdFile[] = [];

    // _meta.json 로드 (sections 순서용)
    const meta = await readWorkspaceMeta(workspaceDir);

    // readDir로 .md 파일 수집
    let entries: Awaited<ReturnType<typeof readDir>> = [];
    try {
      entries = await readDir(workspaceDir);
    } catch (e) {
      throw new Error(`결과 폴더를 읽을 수 없습니다: ${e instanceof Error ? e.message : String(e)}`);
    }

    const mdEntries = entries.filter((e) => e.name?.endsWith(".md") && !e.isDirectory);

    // _figma_images 폴더에서 png 수집
    let pngEntries: Awaited<ReturnType<typeof readDir>> = [];
    try {
      const imgDir = `${workspaceDir}/_figma_images`;
      pngEntries = await readDir(imgDir);
    } catch {
      // _figma_images 폴더 없으면 무시
    }

    // sections 순서에 따라 정렬
    let orderedMdEntries = mdEntries;
    if (meta && meta.sections.length > 0) {
      const sectionOrder = new Map(meta.sections.map((s, idx) => [s.slug + ".md", idx]));
      orderedMdEntries = [...mdEntries].sort((a, b) => {
        const aIdx = sectionOrder.get(a.name ?? "") ?? 999;
        const bIdx = sectionOrder.get(b.name ?? "") ?? 999;
        return aIdx - bIdx;
      });
    } else {
      // 평탄 폴더 fallback: 파일명 자연 정렬
      orderedMdEntries = [...mdEntries].sort((a, b) =>
        (a.name ?? "").localeCompare(b.name ?? "", undefined, { numeric: true })
      );
    }

    for (const entry of orderedMdEntries) {
      if (!entry.name) continue;
      const mdPath = `${workspaceDir}/${entry.name}`;
      let content = "";
      try {
        content = await readTextFile(mdPath);
      } catch {
        continue;
      }

      // section 이름 결정
      const slug = entry.name.replace(/\.md$/, "");
      let name = slug.replace(/-/g, " ");
      if (meta) {
        const matched = meta.sections.find((s) => s.slug === slug || s.slug + ".md" === entry.name);
        if (matched) name = matched.name;
      }

      // 해당 slug의 이미지 수집 — _figma_images/<slug>/ 디렉토리 또는 workspaceDir 직속 png
      const slugImagePaths: string[] = [];

      // _figma_images/<slug>/ 하위 png
      try {
        const slugImgDir = `${workspaceDir}/_figma_images/${slug}`;
        const slugImgEntries = await readDir(slugImgDir);
        slugImgEntries
          .filter((e) => e.name?.endsWith(".png") && !e.isDirectory)
          .forEach((e) => slugImagePaths.push(`${slugImgDir}/${e.name}`));
      } catch {
        // 해당 slug 이미지 폴더 없음
      }

      // workspaceDir 직속 png (Axshare 평탄 구조)
      // 평탄 fallback에서는 어떤 png가 어떤 .md에 대응하는지 알 수 없으므로
      // 모든 .md에 동일 이미지를 중복 첨부하는 대신 첨부를 생략한다.
      if (slugImagePaths.length === 0 && pngEntries.length > 0) {
        console.warn("[UploadPage] 평탄 폴더 — 이미지 매칭 불가, 첨부 생략");
        // slugImagePaths는 빈 배열로 유지 (중복 업로드 방지)
      }

      mdFiles.push({
        title: name,
        content,
        imagePaths: slugImagePaths,
        path: mdPath,
      });
    }

    return mdFiles;
  }, [workflow.workspaceDir]);

  // workspaceDir이 설정되면 .md 파일 목록 자동 수집
  useEffect(() => {
    if (!workflow.workspaceDir) return;

    setFilesLoading(true);
    setFilesError(null);
    collectMdFiles()
      .then((files) => setCollectedFiles(files))
      .catch((e) => setFilesError(e instanceof Error ? e.message : String(e)))
      .finally(() => setFilesLoading(false));
  }, [workflow.workspaceDir, collectMdFiles]);

  // 상위 페이지 URL 확인 (필수)
  // URL에서 Space Key + Page ID를 클라이언트 측 정규식으로 추출 — 토큰/네트워크 호출 불필요.
  // (이전에는 keychain에서 토큰을 로드해 macOS Keychain 권한 팝업이 떴음 — 검증 자체엔 불필요)
  // 잘못된 ID/Space는 실제 업로드 시점에 Rust가 명확한 에러를 반환함.
  const handleResolveParentPage = () => {
    setParentResolveError(null);

    const trimmed = parentPageUrl.trim();
    if (!trimmed) {
      setParentPageStatus("error");
      setParentResolveError(
        "상위 페이지 URL은 필수입니다. Confluence 페이지 URL(예: https://xxx.atlassian.net/wiki/spaces/KEY/pages/12345/제목)을 입력하세요.",
      );
      return;
    }

    const parsed = parseConfluenceParentUrl(trimmed);

    if (!parsed.pageId) {
      setParentPageStatus("error");
      setParentResolveError(
        "URL에서 페이지 ID를 추출할 수 없습니다. /pages/{ID} 형식이 포함된 Confluence URL이어야 합니다.",
      );
      return;
    }

    if (!parsed.spaceKey) {
      setParentPageStatus("error");
      setParentResolveError(
        "URL에서 Space Key를 추출할 수 없습니다. /spaces/{KEY}/pages/{ID} 형식의 Confluence Cloud URL을 입력해주세요.",
      );
      return;
    }

    setParentPageId(parsed.pageId);
    setParentSpaceKey(parsed.spaceKey);
    setParentPageStatus("resolved");
  };

  /**
   * 업로드 실행. resume=true이면 이미 success인 파일은 스킵하고 나머지만 업로드.
   */
  const runUpload = useCallback(
    async (resume: boolean = false) => {
      setGlobalError(null);
      setUploadDone(false);
      if (!resume) setUploadProgress(0);

      const rawFiles = await collectMdFiles();
      if (rawFiles.length === 0) {
        setGlobalError("업로드할 Markdown 파일을 찾을 수 없습니다.");
        return;
      }

      // 제목 정책 적용 — Confluence Space 내 제목 중복 방지
      const mdFiles = rawFiles.map((f) => ({
        ...f,
        title: applyTitlePolicy(f.title, titleMode, titlePrefix, titleSuffix),
      }));

      // resume=true면 기존 pageEntries의 success를 보존, error/waiting/uploading은 waiting으로 리셋
      // resume=false면 전부 waiting으로 초기화
      const skipTitles = new Set<string>();
      setPageEntries((prev) => {
        if (resume && prev.length > 0) {
          return prev.map((e) => {
            if (e.status === "success") {
              skipTitles.add(e.name);
              return e;
            }
            return { ...e, status: "waiting" as const, result: undefined };
          });
        }
        return mdFiles.map((f) => ({
          name: f.title,
          path: f.path,
          status: "waiting" as const,
        }));
      });

      // resume 모드에선 prev에서 직접 skip 추출 (setState는 비동기라)
      if (resume) {
        // 위 setPageEntries 호출 시 작성된 skipTitles를 사용 — 단, 그 setter 콜백에서만 채워짐.
        // 안전을 위해 한 번 더 화면 상태 기반으로 보강
        pageEntries.forEach((e) => {
          if (e.status === "success") skipTitles.add(e.name);
        });
      }

      stopRef.current = { stopped: false };
      setUploading(true);

      try {
        let token: string;
        try {
          token = await invoke<string>("load_credential", {
            service: "flipbookmaker",
            key: "confluence-token",
          });
        } catch (e) {
          throw new Error(
            `API 토큰을 불러올 수 없습니다: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        const onProgress = (
          current: number,
          total: number,
          title: string,
          result?: UploadResult,
        ) => {
          const pct = Math.round((current / total) * 100);
          setUploadProgress(pct);

          setPageEntries((prev) => {
            const next = [...prev];
            const idx = next.findIndex((e) => e.name === title);
            if (idx === -1) return prev;

            if (result) {
              next[idx] = {
                ...next[idx],
                status: result.success ? "success" : "error",
                result,
              };
            } else {
              next[idx] = { ...next[idx], status: "uploading" };
            }
            return next;
          });
        };

        if (!parentSpaceKey || !parentPageId) {
          throw new Error(
            "부모 페이지가 설정되지 않았습니다. 상위 페이지 URL을 입력하고 [확인] 버튼을 눌러주세요.",
          );
        }

        await uploadToConfluence(
          {
            baseUrl: settings.atlassianUrl,
            email: settings.confluenceEmail,
            token,
            spaceKey: parentSpaceKey,
            parentPageId,
          },
          mdFiles,
          onProgress,
          4000,
          stopRef.current,
          skipTitles,
        );

        if (stopRef.current.stopped) {
          setGlobalError(
            "업로드가 사용자에 의해 중단되었습니다. [재시작]으로 이어서 업로드하거나 [취소]로 결과를 초기화할 수 있습니다.",
          );
        } else {
          setUploadDone(true);
        }
      } catch (e) {
        setGlobalError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
      }
    },
    [settings, collectMdFiles, parentPageId, parentSpaceKey, pageEntries, titleMode, titlePrefix, titleSuffix],
  );

  const handleUpload = useCallback(() => runUpload(false), [runUpload]);
  const handleResume = useCallback(() => runUpload(true), [runUpload]);

  /** 중단 — 현재 진행 중인 페이지가 끝나면 다음 페이지부터 처리 중단 */
  const handleStop = useCallback(() => {
    stopRef.current.stopped = true;
    console.log("[UploadPage] 사용자 중단 요청");
  }, []);

  /** 취소 — 모든 진행 상태 초기화 (이미 업로드된 페이지는 Confluence에서 직접 정리 필요) */
  const handleCancel = useCallback(() => {
    stopRef.current.stopped = true;
    setPageEntries([]);
    setUploadProgress(0);
    setUploadDone(false);
    setGlobalError(null);
    setExpandedErrors(new Set());
  }, []);

  const toggleErrorExpand = useCallback((name: string) => {
    setExpandedErrors((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // 설정 미완료 화면
  if (settingsIncomplete) {
    // 뒤로 버튼: navigate(-1) 대신 명시적 경로로. workspaceDir 있으면 변환 결과(/convert),
    // 없으면 home(/). settings ↔ /upload 핑퐁 무한 루프 차단 (v1.3.10 fix)
    const backTarget = workflow.workspaceDir ? "/convert" : "/";
    return (
      <div style={styles.page}>
        <div style={styles.header}>
          <Button variant="secondary" onClick={() => navigate(backTarget)}>
            뒤로
          </Button>
          <h1 style={styles.title}>Confluence 업로드</h1>
        </div>
        <div style={styles.content}>
          <StatusCard title="Confluence 설정 필요" status="warning">
            Confluence 연결이 확인되지 않았습니다. 설정에서 Confluence 정보를
            입력하고 연결 테스트를 완료해주세요.
          </StatusCard>
          <div style={styles.actions}>
            <Button
              onClick={() =>
                navigate("/settings", { state: { from: "/upload" } })
              }
            >
              설정으로 이동
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // workspaceDir 없음 — 안내
  if (!workflow.workspaceDir) {
    return (
      <div style={styles.page}>
        <div style={styles.header}>
          <Button variant="secondary" onClick={() => navigate("/")}>
            처음으로
          </Button>
          <h1 style={styles.title}>Confluence 업로드</h1>
        </div>
        <div style={styles.content}>
          <StatusCard title="변환 폴더 없음" status="warning">
            업로드할 workspace 폴더가 지정되지 않았습니다.
            먼저 변환 단계를 완료하거나, 홈에서 변환된 폴더를 선택해주세요.
          </StatusCard>
          <div style={styles.actions}>
            <Button variant="secondary" onClick={() => navigate("/")}>
              처음으로
            </Button>
            <Button onClick={() => navigate("/convert")}>변환 페이지로 이동</Button>
          </div>
        </div>
      </div>
    );
  }

  const successCount = pageEntries.filter((e) => e.status === "success").length;
  const failCount = pageEntries.filter((e) => e.status === "error").length;

  // 제목 정책 유효성: prefix/suffix 모드는 입력값 필수
  const titlePolicyValid =
    titleMode === "auto" ||
    (titleMode === "prefix" && titlePrefix.trim().length > 0) ||
    (titleMode === "suffix" && titleSuffix.trim().length > 0);

  // 업로드 버튼 활성 조건: parentPageStatus가 resolved + 제목 정책 유효
  const uploadEnabled =
    parentPageStatus === "resolved" &&
    titlePolicyValid &&
    !uploading &&
    !uploadDone &&
    collectedFiles.length > 0;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <Button
          variant="secondary"
          onClick={() => navigate(-1)}
          disabled={uploading}
        >
          뒤로
        </Button>
        <h1 style={styles.title}>Confluence 업로드</h1>
      </div>

      <div style={styles.content}>
        {/* 설정 요약 (읽기 전용) */}
        <div style={styles.section}>
          <span style={styles.sectionTitle}>Confluence 설정</span>
          <div style={styles.configRow}>
            <span style={styles.configLabel}>URL</span>
            <span style={styles.configValue}>{settings.atlassianUrl}</span>
          </div>
          <div style={styles.configRow}>
            <span style={styles.configLabel}>계정</span>
            <span style={styles.configValue}>{settings.confluenceEmail}</span>
          </div>
          <div style={styles.configRow}>
            <span style={styles.configLabel}>Space</span>
            <span style={styles.configValue}>
              {parentSpaceKey ?? "(상위 페이지 URL에서 자동 추출)"}
            </span>
          </div>
        </div>

        {/* 상위 페이지 URL inline form (필수) */}
        <div style={styles.section}>
          <span style={styles.sectionTitle}>상위 페이지 URL (필수)</span>
          <div style={styles.parentPageRow}>
            <div style={{ flex: 1 }}>
              <TextInput
                value={parentPageUrl}
                onChange={(v) => {
                  setParentPageUrl(v);
                  // 값 변경 시 확인 상태 초기화
                  if (parentPageStatus !== "idle") {
                    setParentPageStatus("idle");
                    setParentPageId(null);
                    setParentSpaceKey(null);
                    setParentResolveError(null);
                  }
                }}
                placeholder="https://xxx.atlassian.net/wiki/spaces/KEY/pages/12345/제목"
                label="상위 페이지 URL (예: /spaces/KEY/pages/{ID} 형식)"
              />
            </div>
            <Button
              variant="secondary"
              onClick={handleResolveParentPage}
              disabled={parentPageStatus === "resolving" || uploading}
            >
              {parentPageStatus === "resolving" ? "확인 중..." : "확인"}
            </Button>
          </div>

          {/* 상태 메시지 */}
          {parentPageStatus === "resolved" && (
            <span style={styles.parentPageStatus("resolved")}>
              확인됨 — Space: <strong>{parentSpaceKey}</strong>, 페이지 ID:{" "}
              <strong>{parentPageId}</strong>
            </span>
          )}
          {parentPageStatus === "error" && parentResolveError && (
            <span style={styles.parentPageStatus("error")}>
              {parentResolveError}
            </span>
          )}
          {parentPageStatus === "idle" && (
            <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
              업로드 전 [확인] 버튼을 눌러 상위 페이지를 검증해주세요. URL에서 Space와 페이지 ID가 자동 추출됩니다.
            </span>
          )}
        </div>

        {/* Children Page 제목 정책 — Space 내 제목 중복 방지 */}
        <div style={styles.section}>
          <span style={styles.sectionTitle}>Children Page 제목 정책</span>
          <p style={styles.policyHelp}>
            Confluence는 같은 Space 내에서 페이지 제목이 <strong>고유</strong>해야 합니다.
            플립북 특성상 같은 children page name이 중복될 수 있어, 구분 문자열을 자동/수동으로 붙입니다.
          </p>

          <div style={styles.radioRow}>
            {(
              [
                { mode: "auto" as const, label: "Auto", desc: "오늘 날짜를 Suffix로 자동 추가" },
                { mode: "prefix" as const, label: "Prefix", desc: "제목 앞에 문자열 추가" },
                { mode: "suffix" as const, label: "Suffix", desc: "제목 뒤에 문자열 추가" },
              ]
            ).map((opt) => (
              <label
                key={opt.mode}
                style={styles.radioCard(titleMode === opt.mode)}
                onClick={() => !uploading && setTitleMode(opt.mode)}
              >
                <input
                  type="radio"
                  name="title-policy-mode"
                  value={opt.mode}
                  checked={titleMode === opt.mode}
                  onChange={() => setTitleMode(opt.mode)}
                  disabled={uploading}
                  style={{ marginTop: "2px", accentColor: "var(--color-accent)" }}
                />
                <div>
                  <div style={styles.radioLabel}>{opt.label}</div>
                  <div style={styles.radioDesc}>{opt.desc}</div>
                </div>
              </label>
            ))}
          </div>

          {titleMode === "auto" && (
            <div style={styles.policyInfo}>
              <span style={styles.policyInfoAccent}>●</span>
              <span>
                오늘 날짜 <strong style={styles.policyInfoAccent}>{todayYmd()}</strong>{" "}
                가 모든 children page 제목 뒤에 자동으로 붙습니다.
              </span>
            </div>
          )}

          {titleMode === "prefix" && (
            <div>
              <TextInput
                value={titlePrefix}
                onChange={setTitlePrefix}
                placeholder="예: [v1.3] 또는 KT-2026Q2"
                label="Prefix 문자열 (필수)"
                disabled={uploading}
              />
              {!titlePrefix.trim() && (
                <div style={styles.policyError}>
                  Prefix 모드에서는 문자열 입력이 필수입니다.
                </div>
              )}
            </div>
          )}

          {titleMode === "suffix" && (
            <div>
              <TextInput
                value={titleSuffix}
                onChange={setTitleSuffix}
                placeholder="예: (v1.3) 또는 -draft"
                label="Suffix 문자열 (필수)"
                disabled={uploading}
              />
              {!titleSuffix.trim() && (
                <div style={styles.policyError}>
                  Suffix 모드에서는 문자열 입력이 필수입니다.
                </div>
              )}
            </div>
          )}
        </div>

        {/* .md 파일 목록 */}
        <div style={styles.section}>
          <span style={styles.sectionTitle}>
            업로드 대상 ({collectedFiles.length}개)
          </span>

          {filesLoading && (
            <span style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
              파일 목록 로드 중...
            </span>
          )}

          {filesError && (
            <StatusCard title="파일 수집 실패" status="error">
              {filesError}
            </StatusCard>
          )}

          {!filesLoading && !filesError && collectedFiles.length === 0 && (
            <StatusCard title="변환된 문서 없음" status="warning">
              workspace 폴더에서 .md 파일을 찾을 수 없습니다.
              먼저 변환 단계를 완료해주세요.
            </StatusCard>
          )}

          {!filesLoading && collectedFiles.length > 0 && (
            <div style={styles.pageList}>
              {(pageEntries.length > 0
                ? pageEntries
                : collectedFiles.map<PageUploadEntry>((f) => ({
                    name: applyTitlePolicy(f.title, titleMode, titlePrefix, titleSuffix),
                    path: f.path,
                    status: "waiting",
                  }))
              ).map((entry: PageUploadEntry) => {
                const isErr = entry.result && !entry.result.success;
                const isExpanded = expandedErrors.has(entry.name);
                const fullMsg = entry.result?.message ?? "";
                const shortMsg = fullMsg.split("\n")[0].slice(0, 80);

                return (
                  <div
                    key={entry.name}
                    style={{ display: "flex", flexDirection: "column" }}
                  >
                    <div style={styles.pageRow}>
                      <span style={styles.pageName}>{entry.name}</span>

                      <span style={styles.pageStatusBadge(entry.status)}>
                        {PAGE_STATUS_LABELS[entry.status]}
                      </span>

                      {entry.result?.success && entry.result.page_url && (
                        <span
                          style={styles.pageUrlLink}
                          onClick={() =>
                            openUrl(entry.result!.page_url!).catch((e) =>
                              alert(`링크 열기 실패: ${e}`),
                            )
                          }
                        >
                          Confluence에서 열기
                        </span>
                      )}

                      {isErr && fullMsg && (
                        <span
                          style={{
                            ...styles.errorText,
                            cursor: "pointer",
                            textDecoration: "underline dotted",
                          }}
                          title="클릭하면 상세 사유 펼치기/접기"
                          onClick={() => toggleErrorExpand(entry.name)}
                        >
                          {shortMsg}
                          {fullMsg.length > 80 ? "…" : ""}
                        </span>
                      )}
                    </div>
                    {isErr && isExpanded && (
                      <div
                        style={{
                          backgroundColor: "rgba(239, 68, 68, 0.06)",
                          borderTop: "1px solid var(--color-border)",
                          color: "var(--color-text)",
                          fontFamily:
                            "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
                          fontSize: "11px",
                          lineHeight: 1.5,
                          padding: "10px 16px",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {fullMsg}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 진행률 바 (업로드 중 또는 완료 후) */}
        {(uploading || uploadProgress > 0) && (
          <ProgressBar
            progress={uploadProgress}
            label={
              uploading
                ? `업로드 중... (${successCount + failCount}/${collectedFiles.length})`
                : "업로드 완료"
            }
          />
        )}

        {/* 글로벌 에러 */}
        {globalError && (
          <StatusCard title="업로드 실패" status="error">
            {globalError}
          </StatusCard>
        )}

        {/* 완료 결과 요약 */}
        {uploadDone && !globalError && (
          <StatusCard
            title={failCount === 0 ? "업로드 완료" : "업로드 부분 완료"}
            status={failCount === 0 ? "success" : "warning"}
          >
            {successCount}개 성공
            {failCount > 0 && `, ${failCount}개 실패`}
          </StatusCard>
        )}

        <div style={styles.actions}>
          {/* 업로드 중: [중단] 버튼만 노출 */}
          {uploading && (
            <Button variant="danger" onClick={handleStop}>
              중단
            </Button>
          )}

          {/* 중단됨 또는 일부 실패: [취소] + [재시작] */}
          {!uploading && pageEntries.length > 0 && !uploadDone && (
            <>
              <Button variant="secondary" onClick={handleCancel}>
                취소 (목록 초기화)
              </Button>
              <Button onClick={handleResume} disabled={!uploadEnabled}>
                재시작
              </Button>
            </>
          )}

          {/* 일부 실패 + 완료: [실패만 재시도] */}
          {!uploading && uploadDone && failCount > 0 && (
            <>
              <Button variant="secondary" onClick={handleCancel}>
                목록 초기화
              </Button>
              <Button onClick={handleResume} disabled={!uploadEnabled}>
                실패만 재시도
              </Button>
            </>
          )}

          {/* 초기 상태: [업로드 시작] */}
          {!uploading && pageEntries.length === 0 && (
            <Button onClick={handleUpload} disabled={!uploadEnabled}>
              업로드 시작
            </Button>
          )}

          {/* 모두 성공 + 완료 */}
          {!uploading && uploadDone && failCount === 0 && (
            <Button disabled>
              업로드 완료
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
