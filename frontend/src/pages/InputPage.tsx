import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useSettings } from "../contexts/SettingsContext";
import { useWorkflow, type PageEntry } from "../contexts/WorkflowContext";
import { checkNodeAvailable, checkPlaywrightAvailable } from "../services/scriptRunner";
import PlaywrightSetupModal from "../components/PlaywrightSetupModal";
import {
  findExistingWorkspace,
  listWorkspaces,
  validateWorkspace,
  resolveOutputRoot,
  readWorkspaceMeta,
  writeWorkspaceMeta,
  type WorkspaceMeta,
} from "../services/workspace";
import WorkspacePickerModal from "../components/WorkspacePickerModal";
import Button from "../components/Button";
import TextInput from "../components/TextInput";
import StatusCard from "../components/StatusCard";
import type { AppSettings } from "../contexts/SettingsContext";

/**
 * 시작 전 설정 점검 패널.
 * 미설정 항목을 한 번에 보여주고 [설정 열기] 버튼으로 이동.
 * 모두 정상이면 패널 자체를 노출 안 함.
 */
function SetupChecklist({
  settings,
  onGoSettings,
}: {
  settings: AppSettings;
  onGoSettings: () => void;
}) {
  // 항목별 상태 — required (필수) / optional (선택)
  const items: Array<{ label: string; ok: boolean; required: boolean; hint: string }> = [
    {
      label: "Claude Code 연결",
      ok: settings.claudeVerified,
      required: true,
      hint: "Markdown 변환에 필수. 미연결 시 변환 시작이 차단됩니다.",
    },
    {
      label: "결과 폴더 (출력 경로)",
      ok: !!settings.outputPath,
      required: true,
      hint: "변환된 Markdown과 이미지가 저장될 root 폴더.",
    },
    {
      label: "Figma Personal Access Token",
      ok: !!settings.figmaToken,
      required: false,
      hint: "Figma URL 변환 시에만 필요. Axshare만 쓸 거면 생략 가능.",
    },
    {
      label: "Confluence 연결",
      ok: settings.confluenceVerified,
      required: false,
      hint: "Confluence 업로드를 사용하려면 필요. Markdown 생성만 할 거면 생략 가능.",
    },
  ];

  const missingRequired = items.filter((it) => it.required && !it.ok);
  const missingOptional = items.filter((it) => !it.required && !it.ok);

  // 전부 정상이면 노출 안 함
  if (missingRequired.length === 0 && missingOptional.length === 0) {
    return null;
  }

  const cardStyle: React.CSSProperties = {
    backgroundColor: "var(--color-surface)",
    border: `1px solid ${missingRequired.length > 0 ? "rgba(239, 68, 68, 0.4)" : "var(--color-border)"}`,
    borderRadius: "var(--radius)",
    padding: "16px 20px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  };

  const itemRowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    gap: "10px",
    fontSize: "13px",
  };

  return (
    <div style={cardStyle}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--color-text)" }}>
          {missingRequired.length > 0 ? "설정이 필요합니다" : "선택 항목 미설정"}
        </span>
        <Button variant="secondary" onClick={onGoSettings}>
          설정 열기
        </Button>
      </div>

      {[...missingRequired, ...missingOptional].map((it) => (
        <div key={it.label} style={itemRowStyle}>
          <span
            style={{
              color: it.required ? "#ef4444" : "var(--color-warning)",
              fontWeight: 700,
              minWidth: "16px",
            }}
          >
            ●
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ color: "var(--color-text)", fontWeight: 500 }}>
              {it.label}
              {it.required ? (
                <span
                  style={{
                    marginLeft: "8px",
                    fontSize: "11px",
                    color: "#ef4444",
                    fontWeight: 600,
                  }}
                >
                  필수
                </span>
              ) : (
                <span
                  style={{
                    marginLeft: "8px",
                    fontSize: "11px",
                    color: "var(--color-text-tertiary)",
                  }}
                >
                  선택
                </span>
              )}
            </div>
            <div
              style={{
                color: "var(--color-text-secondary)",
                fontSize: "12px",
                marginTop: "2px",
                lineHeight: 1.5,
              }}
            >
              {it.hint}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

const styles = {
  page: {
    alignItems: "center",
    display: "flex",
    flexDirection: "column" as const,
    justifyContent: "center",
    minHeight: "100vh",
    padding: "32px",
    position: "relative" as const,
    backgroundColor: "var(--color-bg)",
  },
  settingsButton: {
    position: "absolute" as const,
    top: "20px",
    right: "20px",
    background: "none",
    border: "1px solid var(--color-border)",
    color: "var(--color-text-secondary)",
    cursor: "pointer",
    fontSize: "16px",
    padding: "6px 10px",
    borderRadius: "var(--radius-sm)",
    transition: "color var(--transition), background-color var(--transition), border-color var(--transition)",
    lineHeight: 1,
    backgroundColor: "transparent",
  },
  container: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "20px",
    maxWidth: "520px",
    width: "100%",
  },
  header: {
    textAlign: "center" as const,
    marginBottom: "4px",
  },
  title: {
    color: "var(--color-text)",
    fontSize: "26px",
    fontWeight: 700,
    marginBottom: "8px",
    letterSpacing: "-0.02em",
  },
  subtitle: {
    color: "var(--color-text-secondary)",
    fontSize: "13px",
    lineHeight: 1.6,
  },
  section: {
    backgroundColor: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius)",
    padding: "20px",
    display: "flex",
    flexDirection: "column" as const,
    gap: "14px",
  },
  sectionTitle: {
    color: "var(--color-text)",
    fontSize: "13px",
    fontWeight: 600,
  },
  sectionSubtitle: {
    color: "var(--color-text-secondary)",
    fontSize: "12px",
    marginTop: "-4px",
  },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
  },
  // 워크스페이스 목록 행
  workspaceRow: {
    alignItems: "center",
    backgroundColor: "var(--color-bg)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
    cursor: "pointer" as const,
    display: "flex",
    gap: "10px",
    padding: "10px 12px",
    transition: "border-color 0.15s, background-color 0.15s",
  },
  workspaceName: {
    flex: 1,
    color: "var(--color-text)",
    fontSize: "13px",
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  workspaceMeta: {
    color: "var(--color-text-secondary)",
    fontSize: "11px",
    flexShrink: 0,
  },
  badge: (type: "figma" | "axshare"): React.CSSProperties => ({
    flexShrink: 0,
    fontSize: "10px",
    fontWeight: 500,
    padding: "2px 6px",
    borderRadius: "var(--radius-sm)",
    backgroundColor: type === "figma" ? "rgba(99, 102, 241, 0.12)" : "rgba(234, 179, 8, 0.12)",
    color: type === "figma" ? "var(--color-accent)" : "var(--color-warning)",
  }),
  pathHint: {
    color: "var(--color-text-secondary)",
    fontSize: "11px",
    marginTop: "-4px",
  },
};

type WorkspaceItem = {
  slug: string;
  dir: string;
  meta: WorkspaceMeta | null;
  mdCount: number;
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function InputPage() {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const {
    setUrl: setWorkflowUrl,
    setOutputDir,
    setSourceType,
    setSitemap,
    setPages,
    setDocumentName,
    setWorkspaceDir,
    setWorkspaceSlug,
    setFileKey,
  } = useWorkflow();
  const [url, setUrl] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [nodeAvailable, setNodeAvailable] = useState<boolean | null>(null);

  // Playwright 미설치 시 노출되는 모달
  const [playwrightModalVisible, setPlaywrightModalVisible] = useState(false);
  const [playwrightModalInfo, setPlaywrightModalInfo] = useState<{
    npmGlobalRoot?: string;
    error?: string;
  }>({});
  const [pendingAxshareUrl, setPendingAxshareUrl] = useState<string | null>(null);

  // WorkspacePickerModal 상태
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerExisting, setPickerExisting] = useState<{
    slug: string;
    dir: string;
    meta: WorkspaceMeta;
  } | null>(null);
  const [pendingNavigateType, setPendingNavigateType] = useState<"figma" | "axshare" | null>(null);

  // 변환된 폴더 목록 (카드 2)
  const [workspaceList, setWorkspaceList] = useState<WorkspaceItem[]>([]);
  const [workspaceListLoading, setWorkspaceListLoading] = useState(false);
  const [workspaceListError, setWorkspaceListError] = useState<string | null>(null);

  useEffect(() => {
    checkNodeAvailable()
      .then((result) => setNodeAvailable(result.available))
      .catch(() => setNodeAvailable(false));
  }, []);

  // 진입 시 변환된 workspace 목록 로드
  useEffect(() => {
    if (!settings.outputPath) return;
    setWorkspaceListLoading(true);
    setWorkspaceListError(null);
    resolveOutputRoot(settings.outputPath)
      .then((root) => listWorkspaces(root))
      .then((list) => setWorkspaceList(list))
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[InputPage] listWorkspaces 실패:", msg);
        setWorkspaceListError(msg);
        setWorkspaceList([]);
      })
      .finally(() => setWorkspaceListLoading(false));
  }, [settings.outputPath]);

  const handleAnalyze = async () => {
    if (!url.trim()) return;

    if (!settings.outputPath) {
      setValidationError("결과 폴더를 먼저 설정해주세요.");
      setTimeout(() => navigate("/settings", { state: { from: "/" } }), 1500);
      return;
    }

    if (!settings.claudeVerified) {
      setValidationError("Claude Code 연결을 먼저 확인해주세요.");
      setTimeout(() => navigate("/settings", { state: { from: "/" } }), 1500);
      return;
    }

    // URL 패턴 검증: figma.com 또는 axshare.com 포함 여부 확인
    const trimmedUrl = url.trim();
    let detectedType: "figma" | "axshare" | null = null;

    if (trimmedUrl.includes("figma.com")) {
      if (!settings.figmaToken) {
        setValidationError("Figma Personal Access Token이 없습니다. 설정 페이지에서 먼저 등록해주세요.");
        setTimeout(() => navigate("/settings", { state: { from: "/" } }), 1500);
        return;
      }
      detectedType = "figma";
    } else if (trimmedUrl.includes("axshare.com")) {
      detectedType = "axshare";
      // Axshare는 Playwright 의존 — 글로벌 npm에 설치되어 있는지 사전 확인
      const pwResult = await checkPlaywrightAvailable();
      if (!pwResult.available) {
        setPlaywrightModalInfo({
          npmGlobalRoot: pwResult.npmGlobalRoot,
          error: pwResult.error,
        });
        setPendingAxshareUrl(trimmedUrl);
        setPlaywrightModalVisible(true);
        return;
      }
    } else {
      setValidationError("Figma 또는 Axure Share URL을 입력해주세요.");
      return;
    }

    setValidationError(null);

    // 기존 workspace 검색
    try {
      const root = await resolveOutputRoot(settings.outputPath);
      const existing = await findExistingWorkspace(root, trimmedUrl);
      if (existing) {
        // 모달 표시
        setPendingNavigateType(detectedType);
        setPickerExisting(existing);
        setPickerVisible(true);
        return;
      }
    } catch (e) {
      console.warn("[InputPage] findExistingWorkspace 실패 (계속 진행):", e);
    }

    // 신규 — 바로 분석 시작
    doNavigateAnalyze(trimmedUrl, detectedType);
  };

  /** Playwright 모달의 [다시 확인] — 사용자가 설치 후 재검증. 통과 시 axshare 분석 자동 재진입 */
  const handlePlaywrightRecheck = async () => {
    const pwResult = await checkPlaywrightAvailable();
    if (pwResult.available && pendingAxshareUrl) {
      setPlaywrightModalVisible(false);
      const target = pendingAxshareUrl;
      setPendingAxshareUrl(null);
      setPlaywrightModalInfo({});
      // 같은 URL로 다시 handleAnalyze 흐름 진입 (workspace 검색부터)
      setUrl(target);
      // 모달 닫힌 후 한 박자 뒤 재호출 (state 반영)
      setTimeout(() => handleAnalyze(), 50);
    } else {
      // 여전히 미설치 — 모달 유지하고 메시지만 갱신
      setPlaywrightModalInfo({
        npmGlobalRoot: pwResult.npmGlobalRoot,
        error: pwResult.error,
      });
    }
  };

  /** workspace 없음 또는 신규 분석 — WorkflowContext 세팅 후 AnalyzePage로 이동 */
  const doNavigateAnalyze = (trimmedUrl: string, type: "figma" | "axshare") => {
    setSourceType(type);
    setWorkflowUrl(trimmedUrl);
    setOutputDir(settings.outputPath);
    // 이전 분석/변환의 sitemap/pages를 명시적으로 비움 — AnalyzePage가 stale 데이터 재사용 방지
    setSitemap([]);
    setPages([]);
    navigate("/analyze");
  };

  /** 재사용 — workspace 상태 복원 후 ConvertPage로 이동 */
  const handleReuse = async () => {
    if (!pickerExisting || !pendingNavigateType) return;
    setPickerVisible(false);

    const { slug, dir, meta } = pickerExisting;
    const trimmedUrl = url.trim();

    try {
      // sections 보정 (.md 누락 항목을 pending으로)
      const validatedSections = await validateWorkspace(dir, meta.sections);

      // WorkflowContext 복원
      setSourceType(pendingNavigateType);
      setWorkflowUrl(trimmedUrl);
      setOutputDir(settings.outputPath);
      setWorkspaceDir(dir);
      setWorkspaceSlug(slug);
      setDocumentName(meta.documentName ?? "");
      if (meta.fileKey) setFileKey(meta.fileKey);
      if (meta.sitemap) setSitemap(meta.sitemap);

      // sections → PageEntry[]
      const pageEntries: PageEntry[] = validatedSections.map((s) => ({
        name: s.name,
        slug: s.slug,
        path: s.path,
        sectionDir: s.sectionDir,
        status: s.status,
        selected: s.selected,
      }));
      setPages(pageEntries);

      navigate("/convert");
    } catch (e) {
      console.error("[InputPage] 재사용 복원 실패:", e);
      setValidationError("workspace 복원 중 오류가 발생했습니다. 새로 분석을 시도해주세요.");
    }
  };

  /** 새로 분석 — 같은 workspace 디렉토리 재사용, sections만 초기화 */
  const handleFreshAnalyze = async () => {
    if (!pickerExisting || !pendingNavigateType) return;
    setPickerVisible(false);

    const trimmedUrl = url.trim();
    const { dir, slug, meta } = pickerExisting;

    // _meta.json sections를 명시적으로 비움 (stale sections 방지)
    try {
      const existingMeta = await readWorkspaceMeta(dir);
      if (existingMeta) {
        await writeWorkspaceMeta(dir, { ...existingMeta, sections: [] });
      }
    } catch (e) {
      console.warn("[InputPage] handleFreshAnalyze: _meta.json sections 초기화 실패 (계속 진행):", e);
    }

    // WorkflowContext 세팅 (workspace 정보 포함)
    setSourceType(pendingNavigateType);
    setWorkflowUrl(trimmedUrl);
    setOutputDir(settings.outputPath);
    setWorkspaceDir(dir);
    setWorkspaceSlug(slug);
    setDocumentName(meta.documentName ?? "");
    if (meta.fileKey) setFileKey(meta.fileKey);
    // 직전 reuse 흐름의 stale pages가 잠시 보이는 것 방지 (AnalyzePage가 곧 덮어쓰지만 안전망)
    setPages([]);

    navigate("/analyze");
  };

  /** 변환된 폴더에서 workspace 클릭 → UploadPage */
  const handleWorkspaceClick = async (item: WorkspaceItem) => {
    if (!item.meta) {
      // meta가 없는 평탄 폴더 — workspaceDir만 세팅 후 upload
      setWorkspaceDir(item.dir);
      setWorkspaceSlug(item.slug);
      navigate("/upload");
      return;
    }

    try {
      const validatedSections = await validateWorkspace(item.dir, item.meta.sections);
      setWorkspaceDir(item.dir);
      setWorkspaceSlug(item.slug);
      setDocumentName(item.meta.documentName ?? "");
      setSourceType(item.meta.sourceType);
      setWorkflowUrl(item.meta.sourceUrl);
      if (item.meta.fileKey) setFileKey(item.meta.fileKey);
      if (item.meta.sitemap) setSitemap(item.meta.sitemap);

      const pageEntries: PageEntry[] = validatedSections.map((s) => ({
        name: s.name,
        slug: s.slug,
        path: s.path,
        sectionDir: s.sectionDir,
        status: s.status,
        selected: s.selected,
      }));
      setPages(pageEntries);

      navigate("/upload");
    } catch (e) {
      console.error("[InputPage] workspace 클릭 복원 실패:", e);
    }
  };

  return (
    <div style={styles.page}>
      <button
        style={styles.settingsButton}
        title="설정"
        onClick={() => navigate("/settings", { state: { from: "/" } })}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--color-text)";
          e.currentTarget.style.backgroundColor = "var(--color-surface)";
          e.currentTarget.style.borderColor = "var(--color-text-tertiary)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "var(--color-text-secondary)";
          e.currentTarget.style.backgroundColor = "transparent";
          e.currentTarget.style.borderColor = "var(--color-border)";
        }}
      >
        &#9881;
      </button>

      {/* WorkspacePickerModal */}
      {pickerVisible && pickerExisting && (
        <WorkspacePickerModal
          existing={pickerExisting}
          onReuse={handleReuse}
          onFreshAnalyze={handleFreshAnalyze}
          onCancel={() => setPickerVisible(false)}
        />
      )}

      {/* PlaywrightSetupModal — axshare URL 입력 시 미설치 발견되면 노출 */}
      {playwrightModalVisible && (
        <PlaywrightSetupModal
          npmGlobalRoot={playwrightModalInfo.npmGlobalRoot}
          errorMessage={playwrightModalInfo.error}
          onRecheck={handlePlaywrightRecheck}
          onCancel={() => {
            setPlaywrightModalVisible(false);
            setPendingAxshareUrl(null);
            setPlaywrightModalInfo({});
          }}
        />
      )}

      <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Any Flipbook to Markdown</h1>
          <p style={styles.subtitle}>
            Figma 또는 Axure 플립북을 Markdown 문서로 변환하고 Confluence에 업로드합니다
          </p>
        </div>

        {/* 미설정 항목 체크리스트 */}
        <SetupChecklist
          settings={settings}
          onGoSettings={() => navigate("/settings", { state: { from: "/" } })}
        />

        {/* 카드 1: URL 입력 */}
        <div style={styles.section}>
          <span style={styles.sectionTitle}>플립북 URL 입력</span>
          <TextInput
            value={url}
            onChange={setUrl}
            placeholder="https://figma.com/... 또는 https://axshare.com/..."
            label="플립북 URL"
            onEnter={handleAnalyze}
          />

          {nodeAvailable === false && (
            <StatusCard title="Node.js 필요" status="error">
              Markdown 변환에 Node.js가 필요합니다. nodejs.org에서 설치 후 앱을 재시작하세요.
            </StatusCard>
          )}

          {validationError && (
            <StatusCard title="설정 필요" status="warning">
              {validationError}
            </StatusCard>
          )}

          <div style={styles.actions}>
            <Button onClick={handleAnalyze} disabled={!url.trim() || nodeAvailable === false}>
              분석 시작
            </Button>
          </div>
        </div>

        {/* 카드 2: 변환된 폴더에서 업로드 */}
        <div style={styles.section}>
          <span style={styles.sectionTitle}>변환된 폴더에서 업로드</span>
          {settings.outputPath && (
            <span style={styles.pathHint}>결과 폴더: {settings.outputPath}</span>
          )}

          {!settings.outputPath && (
            <StatusCard title="결과 폴더 미설정" status="warning">
              설정에서 결과 폴더를 먼저 지정해주세요.
            </StatusCard>
          )}

          {settings.outputPath && workspaceListLoading && (
            <span style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
              목록 불러오는 중...
            </span>
          )}

          {settings.outputPath && !workspaceListLoading && workspaceListError && (
            <div
              style={{
                border: "1px solid var(--color-error)",
                borderRadius: "var(--radius-sm)",
                padding: "8px 12px",
                fontSize: "12px",
                color: "var(--color-error)",
              }}
            >
              목록 불러오기 실패: {workspaceListError}
            </div>
          )}

          {settings.outputPath && !workspaceListLoading && !workspaceListError && workspaceList.length === 0 && (
            <span style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
              변환된 워크스페이스가 없습니다
            </span>
          )}

          {settings.outputPath && !workspaceListLoading && !workspaceListError && workspaceList.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {workspaceList.map((item) => (
                <div
                  key={item.slug}
                  style={styles.workspaceRow}
                  onClick={() => handleWorkspaceClick(item)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--color-accent)";
                    e.currentTarget.style.backgroundColor = "var(--color-accent-subtle)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--color-border)";
                    e.currentTarget.style.backgroundColor = "var(--color-bg)";
                  }}
                >
                  <span style={styles.workspaceName}>
                    {item.meta?.documentName || item.slug}
                  </span>
                  {item.meta && (
                    <span style={styles.badge(item.meta.sourceType)}>
                      {item.meta.sourceType === "figma" ? "Figma" : "Axshare"}
                    </span>
                  )}
                  <span style={styles.workspaceMeta}>
                    {item.mdCount > 0 ? `${item.mdCount}개 .md` : ""}
                    {item.meta?.updatedAt ? ` · ${formatDate(item.meta.updatedAt)}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
