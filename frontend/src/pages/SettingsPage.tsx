import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettings } from "../contexts/SettingsContext";
import { useWorkflow } from "../contexts/WorkflowContext";
import Button from "../components/Button";
import TextInput from "../components/TextInput";
import StatusCard from "../components/StatusCard";
import { claudeSession } from "../services/claudeSession";
import { verifyFigmaToken } from "../services/figmaService";

interface ClaudeTestResult {
  success: boolean;
  path: string | null;
  version: string | null;
  message: string;
}

type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "installing" | "latest" | "error";

const styles = {
  page: {
    display: "flex",
    flexDirection: "column" as const,
    minHeight: "100vh",
    overflowY: "auto" as const,
    backgroundColor: "var(--color-bg)",
  },
  inner: {
    maxWidth: "600px",
    width: "100%",
    margin: "0 auto",
    padding: "32px 24px 48px",
    display: "flex",
    flexDirection: "column" as const,
    gap: "0",
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    marginBottom: "28px",
    gap: "12px",
  },
  backButton: {
    background: "none",
    border: "none",
    color: "var(--color-text-secondary)",
    cursor: "pointer",
    fontSize: "13px",
    padding: "5px 8px",
    borderRadius: "var(--radius-sm)",
    transition: "color var(--transition), background-color var(--transition)",
  },
  title: {
    color: "var(--color-text)",
    fontSize: "20px",
    fontWeight: 600,
  },
  container: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "12px",
  },
  section: {
    backgroundColor: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius)",
    padding: "20px",
    display: "flex",
    flexDirection: "column" as const,
    gap: "16px",
  },
  sectionHeader: {
    color: "var(--color-text-secondary)",
    fontSize: "13px",
    fontWeight: 600,
    marginBottom: "4px",
  },
  row: {
    display: "flex",
    alignItems: "flex-end" as const,
    gap: "12px",
  },
  infoRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 0",
  },
  infoLabel: {
    color: "var(--color-text-secondary)",
    fontSize: "13px",
  },
  infoValue: {
    color: "var(--color-text)",
    fontSize: "13px",
    fontWeight: 500,
  },
  statusDot: (connected: boolean): React.CSSProperties => ({
    display: "inline-block",
    width: "7px",
    height: "7px",
    borderRadius: "50%",
    backgroundColor: connected ? "var(--color-success)" : "var(--color-error)",
    marginRight: "6px",
  }),
  statusText: (connected: boolean): React.CSSProperties => ({
    fontSize: "13px",
    color: connected ? "var(--color-success)" : "var(--color-error)",
    fontWeight: 500,
  }),
};

function getUpdateStatusText(status: UpdateStatus): string {
  switch (status) {
    case "checking":
      return "확인 중...";
    case "available":
      return "업데이트 가능";
    case "downloading":
      return "다운로드 중...";
    case "installing":
      return "설치 중...";
    case "latest":
      return "최신 버전입니다";
    case "error":
      return "확인 실패";
    default:
      return "";
  }
}

function getUpdateStatusColor(status: UpdateStatus): string {
  switch (status) {
    case "available":
      return "var(--color-warning, #f59e0b)";
    case "latest":
      return "var(--color-success)";
    case "error":
      return "var(--color-error)";
    default:
      return "var(--color-text-secondary)";
  }
}

interface SettingsPageProps {
  /** App.tsx에서 Claude 연결 성공 후 세션 재시작을 트리거하는 콜백 */
  onClaudeConnected?: () => void;
}

export default function SettingsPage({ onClaudeConnected }: SettingsPageProps = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  // 진입 시 전달된 from으로 복귀. 없으면 home(/) — 메뉴(Cmd+,)에서 진입한 경우 등
  const fromPath = (location.state as { from?: string } | null)?.from || "/";
  const { settings, updateSettings } = useSettings();
  const { workflow } = useWorkflow();

  // 뒤로 가는 시점에 동적으로 평가 — Confluence/Figma 미완료 상태로 from=/upload에 복귀하면
  // 차단 화면이 반복되어 무한 루프가 발생하므로 안전한 경로로 우회 (v1.3.10 fix)
  const computeBackTarget = (): string => {
    if (fromPath === "/upload" && !settings.confluenceVerified) {
      return workflow.workspaceDir ? "/convert" : "/";
    }
    return fromPath;
  };

  // Claude Code (로컬 UI 상태)
  const [claudePathLocal, setClaudePathLocal] = useState(settings.claudePath);
  const [claudeConnected, setClaudeConnected] = useState<boolean | null>(
    settings.claudeVerified ? true : null
  );
  const [claudeVersion, setClaudeVersion] = useState<string | null>(null);
  const [claudeMessage, setClaudeMessage] = useState<string>("");
  const [claudeDetectedPath, setClaudeDetectedPath] = useState<string | null>(
    settings.claudePath || null
  );
  const [claudeTesting, setClaudeTesting] = useState(false);

  // Figma
  const [figmaVerifying, setFigmaVerifying] = useState(false);

  // Update
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [updateInfo, setUpdateInfo] = useState<Update | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [appVersion, setAppVersion] = useState("...");

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion("unknown"));
  }, []);

  // Confluence (SettingsContext 기반 + OS Keychain for token)
  const [atlassianUrl, setAtlassianUrl] = useState(settings.atlassianUrl);
  const [confluenceEmail, setConfluenceEmail] = useState(settings.confluenceEmail);
  const [confluenceToken, setConfluenceToken] = useState("");
  const [confluenceConnected, setConfluenceConnected] = useState<boolean | null>(
    settings.confluenceVerified ? true : null
  );
  const [confluenceTesting, setConfluenceTesting] = useState(false);
  const [confluenceMessage, setConfluenceMessage] = useState("");

  useEffect(() => {
    // 페이지 진입 시 Keychain에서 API 토큰 로드
    invoke<string | null>("load_credential", {
      service: "flipbookmaker",
      key: "confluence-token",
    })
      .then((token) => {
        if (token) setConfluenceToken(token);
      })
      .catch(() => {});
  }, []);

  const handleClaudeTest = async () => {
    setClaudeTesting(true);
    try {
      const result = await invoke<ClaudeTestResult>("test_claude_code", {
        customPath: claudePathLocal.trim() || null,
      });
      setClaudeConnected(result.success);
      setClaudeMessage(result.message);
      if (result.success) {
        const resolvedPath = result.path || claudePathLocal;
        updateSettings({ claudeVerified: true, claudePath: resolvedPath });
        if (result.path) {
          setClaudeDetectedPath(result.path);
          if (!claudePathLocal.trim()) {
            setClaudePathLocal(result.path);
          }
        }
        // 상주 세션 시작 (아직 연결되지 않은 경우)
        if (!claudeSession.isConnected()) {
          claudeSession.start(resolvedPath).catch(() => {
            // 세션 시작 실패 시 무시 (fallback 사용)
          });
        }
        // App.tsx의 claudeReady 상태 갱신 콜백 호출
        onClaudeConnected?.();
      } else {
        updateSettings({ claudeVerified: false });
      }
      if (result.version) {
        setClaudeVersion(result.version);
      } else {
        setClaudeVersion(null);
      }
    } catch (e) {
      setClaudeConnected(false);
      setClaudeVersion(null);
      setClaudeMessage("명령 실행 중 오류가 발생했습니다.");
      updateSettings({ claudeVerified: false });
    } finally {
      setClaudeTesting(false);
    }
  };

  const handleSelectFolder = async () => {
    const selected = await open({
      directory: true,
      title: "결과 폴더 선택",
    });
    if (selected) {
      updateSettings({ outputPath: selected as string });
    }
  };

  const handleCheckUpdate = async () => {
    setUpdateStatus("checking");
    setUpdateInfo(null);
    try {
      const update = await check();
      if (update) {
        setUpdateInfo(update);
        setUpdateStatus("available");
      } else {
        setUpdateStatus("latest");
      }
    } catch {
      setUpdateStatus("error");
    }
  };

  const handleDownloadAndInstall = async () => {
    if (!updateInfo) return;
    setUpdateStatus("downloading");
    setDownloadProgress(0);
    try {
      let downloaded = 0;
      let total = 0;
      await updateInfo.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data?.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data?.chunkLength ?? 0;
          if (total > 0) setDownloadProgress(Math.round((downloaded / total) * 100));
        } else if (event.event === "Finished") {
          setDownloadProgress(100);
          setUpdateStatus("installing");
        }
      });
      await relaunch();
    } catch {
      setUpdateStatus("error");
    }
  };

  const handleFigmaVerify = async () => {
    if (!settings.figmaToken) return;
    setFigmaVerifying(true);
    try {
      const valid = await verifyFigmaToken(settings.figmaToken);
      updateSettings({ figmaVerified: valid });
      if (!valid) {
        alert("Figma 토큰이 유효하지 않습니다. 토큰을 확인해주세요.");
      }
    } catch {
      updateSettings({ figmaVerified: false });
      alert("Figma 연결 확인 실패");
    } finally {
      setFigmaVerifying(false);
    }
  };

  const handleConfluenceTest = async () => {
    setConfluenceTesting(true);
    setConfluenceMessage("");
    try {
      await invoke<string>("test_confluence_connection", {
        url: atlassianUrl.trim(),
        email: confluenceEmail.trim(),
        token: confluenceToken,
      });
      setConfluenceConnected(true);
      setConfluenceMessage("Confluence에 성공적으로 연결되었습니다.");
      updateSettings({
        atlassianUrl: atlassianUrl.trim(),
        confluenceEmail: confluenceEmail.trim(),
        confluenceVerified: true,
      });
      await invoke("save_credential", {
        service: "flipbookmaker",
        key: "confluence-token",
        value: confluenceToken,
      });
    } catch (e) {
      setConfluenceConnected(false);
      setConfluenceMessage(
        typeof e === "string" ? e : "연결 실패. 설정을 확인하세요."
      );
      updateSettings({ confluenceVerified: false });
    } finally {
      setConfluenceTesting(false);
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.inner}>
        <div style={styles.topBar}>
          <button
            style={styles.backButton}
            onClick={() => navigate(computeBackTarget())}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--color-text)";
              e.currentTarget.style.backgroundColor = "var(--color-surface)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--color-text-secondary)";
              e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            &larr; 뒤로
          </button>
          <span style={styles.title}>설정</span>
        </div>

        <div style={styles.container}>
          {/* 일반 */}
          <div style={styles.section}>
            <span style={styles.sectionHeader}>일반</span>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>앱 버전</span>
              <span style={styles.infoValue}>v{appVersion}</span>
            </div>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>업데이트</span>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                {updateStatus !== "idle" && (
                  <span
                    style={{
                      fontSize: "13px",
                      color: getUpdateStatusColor(updateStatus),
                      fontWeight: 500,
                    }}
                  >
                    {getUpdateStatusText(updateStatus)}
                    {updateStatus === "downloading" ? ` ${downloadProgress}%` : ""}
                  </span>
                )}
                {updateStatus === "available" ? (
                  <Button onClick={handleDownloadAndInstall}>
                    업데이트
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={handleCheckUpdate}
                    disabled={updateStatus === "checking" || updateStatus === "downloading" || updateStatus === "installing"}
                  >
                    {updateStatus === "checking" ? "확인 중..." : "확인"}
                  </Button>
                )}
              </div>
            </div>
            {updateStatus === "downloading" && (
              <div style={{ padding: "0 0 4px" }}>
                <div style={{ backgroundColor: "var(--color-surface)", borderRadius: "4px", height: "6px", overflow: "hidden" }}>
                  <div style={{ backgroundColor: "var(--color-accent)", height: "100%", width: `${downloadProgress}%`, transition: "width 0.3s ease", borderRadius: "4px" }} />
                </div>
              </div>
            )}
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>자동 업데이트</span>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={settings.autoUpdate}
                  onChange={(e) => updateSettings({ autoUpdate: e.target.checked })}
                  style={{ width: "16px", height: "16px", accentColor: "var(--color-accent)" }}
                />
                <span style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
                  앱 시작 시 및 24시간마다 확인
                </span>
              </label>
            </div>
          </div>

          {/* Claude Code */}
          <div style={styles.section}>
            <span style={styles.sectionHeader}>Claude Code</span>
            <TextInput
              value={claudePathLocal}
              onChange={setClaudePathLocal}
              placeholder="/usr/local/bin/claude (자동 감지)"
              label="claude 경로"
            />
            {claudeConnected === null && (
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>상태</span>
                <span style={{ fontSize: "13px", color: "var(--color-text-tertiary)" }}>
                  테스트 전
                </span>
              </div>
            )}
            {claudeConnected !== null && (
              <>
                <div style={styles.infoRow}>
                  <span style={styles.infoLabel}>상태</span>
                  <span>
                    <span style={styles.statusDot(claudeConnected)} />
                    <span style={styles.statusText(claudeConnected)}>
                      {claudeConnected
                        ? claudeVersion
                          ? `연결됨 — ${claudeVersion}`
                          : "연결됨"
                        : "미연결"}
                    </span>
                  </span>
                </div>
                {claudeConnected && claudeDetectedPath && (
                  <div style={styles.infoRow}>
                    <span style={styles.infoLabel}>감지된 경로</span>
                    <span
                      style={{
                        fontSize: "12px",
                        color: "var(--color-text-secondary)",
                        fontFamily: "monospace",
                        maxWidth: "320px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {claudeDetectedPath}
                    </span>
                  </div>
                )}
                <StatusCard
                  title="연결 상태"
                  status={claudeConnected ? "success" : "error"}
                >
                  {claudeMessage ||
                    (claudeConnected
                      ? "Claude Code에 연결되었습니다."
                      : "Claude Code를 찾을 수 없습니다. 경로를 확인하세요.")}
                </StatusCard>
              </>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button
                variant="secondary"
                onClick={handleClaudeTest}
                disabled={claudeTesting}
              >
                {claudeTesting ? "테스트 중..." : "연결 테스트"}
              </Button>
            </div>
          </div>

          {/* Figma 설정 */}
          <div style={styles.section}>
            <span style={styles.sectionHeader}>Figma 연결</span>
            <span style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
              Figma Personal Access Token을 입력하세요.
              Figma → Help and account → Account settings → Security에서 생성할 수 있습니다.
            </span>
            <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                <TextInput
                  value={settings.figmaToken ?? ""}
                  onChange={(v) => {
                    updateSettings({ figmaToken: v, figmaVerified: false });
                  }}
                  placeholder="figd_..."
                  label="Figma API Token"
                  type="password"
                />
              </div>
              <Button
                variant="secondary"
                onClick={handleFigmaVerify}
                disabled={!settings.figmaToken || figmaVerifying}
              >
                {figmaVerifying ? "확인 중..." : "연결 확인"}
              </Button>
            </div>
            {settings.figmaVerified && (
              <StatusCard title="연결됨" status="success">
                Figma API 연결이 확인되었습니다.
              </StatusCard>
            )}
          </div>

          {/* Confluence */}
          <div style={styles.section}>
            <span style={styles.sectionHeader}>Confluence</span>
            <TextInput
              value={atlassianUrl}
              onChange={setAtlassianUrl}
              placeholder="https://your-domain.atlassian.net"
              label="Atlassian URL"
            />
            <TextInput
              value={confluenceEmail}
              onChange={setConfluenceEmail}
              placeholder="your@email.com"
              label="계정 (이메일)"
            />
            <TextInput
              value={confluenceToken}
              onChange={setConfluenceToken}
              placeholder="API 토큰"
              label="API 토큰"
              type="password"
            />
            {/* Space Key는 별도 설정으로 두지 않음 — 업로드 시 부모 페이지 URL에서 자동 추출 */}
            {confluenceConnected !== null && (
              <StatusCard
                title="연결 상태"
                status={confluenceConnected ? "success" : "error"}
              >
                {confluenceMessage ||
                  (confluenceConnected
                    ? "Confluence에 연결되었습니다."
                    : "Confluence에 연결할 수 없습니다. 설정을 확인하세요.")}
              </StatusCard>
            )}
            {confluenceConnected !== null && (
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>상태</span>
                <span>
                  <span style={styles.statusDot(confluenceConnected)} />
                  <span style={styles.statusText(confluenceConnected)}>
                    {confluenceConnected ? "연결됨" : "미연결"}
                  </span>
                </span>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button
                variant="secondary"
                onClick={handleConfluenceTest}
                disabled={confluenceTesting}
              >
                {confluenceTesting ? "테스트 중..." : "연결 테스트"}
              </Button>
            </div>
          </div>

          {/* 출력 */}
          <div style={styles.section}>
            <span style={styles.sectionHeader}>출력</span>
            <div style={styles.row}>
              <TextInput
                value={settings.outputPath}
                onChange={(v) => updateSettings({ outputPath: v })}
                placeholder="~/Documents/FlipMD"
                label="기본 저장 경로"
              />
              <Button variant="secondary" onClick={handleSelectFolder}>
                폴더 선택
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
