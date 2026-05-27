import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { SettingsProvider, useSettings } from "./contexts/SettingsContext";
import { WorkflowProvider } from "./contexts/WorkflowContext";
import ErrorBoundary from "./components/ErrorBoundary";
import InputPage from "./pages/InputPage";
import AnalyzePage from "./pages/AnalyzePage";
import ConvertPage from "./pages/ConvertPage";
import UploadPage from "./pages/UploadPage";
import SettingsPage from "./pages/SettingsPage";
import { claudeSession } from "./services/claudeSession";
import "./App.css";

interface ClaudeTestResult {
  success: boolean;
  path: string | null;
  version: string | null;
  message: string;
}

// Claude 미연결 경고 배너
const bannerStyles: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  zIndex: 9999,
  backgroundColor: "var(--color-error, #ef4444)",
  color: "#fff",
  padding: "8px 16px",
  fontSize: "13px",
  fontWeight: 500,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
};

function ClaudeWarningBanner({ onGoSettings }: { onGoSettings: () => void }) {
  return (
    <div style={bannerStyles}>
      <span>Claude Code가 연결되지 않았습니다. 변환 기능을 사용하려면 설정에서 Claude를 연결하세요.</span>
      <button
        onClick={onGoSettings}
        style={{
          background: "rgba(255,255,255,0.2)",
          border: "1px solid rgba(255,255,255,0.5)",
          color: "#fff",
          borderRadius: "4px",
          padding: "3px 10px",
          cursor: "pointer",
          fontSize: "12px",
          fontWeight: 600,
          whiteSpace: "nowrap",
        }}
      >
        설정으로 이동
      </button>
    </div>
  );
}

// 초기 로딩 스피너
const loadingStyles: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "100vh",
  backgroundColor: "var(--color-bg)",
  gap: "16px",
  color: "var(--color-text-secondary)",
  fontSize: "14px",
};

// settings 진입 시 from으로 사용할 경로 결정.
// 현재 경로가 이미 /settings이면 home(/)으로 fallback (무한 복귀 방지).
function getReturnPath(pathname: string): string {
  return pathname === "/settings" ? "/" : pathname;
}

/**
 * Claude 세션 실패 메시지를 카테고리로 분류 — UI에서 가이드 다르게 보여줌.
 */
function classifySessionError(msg: string): "auth" | "rate_limit" | "network" | "unknown" {
  const m = msg.toLowerCase();
  if (
    m.includes("login") ||
    m.includes("authent") ||
    m.includes("credentials") ||
    m.includes("not signed in") ||
    m.includes("oauth") ||
    m.includes("api key") ||
    m.includes("401") ||
    m.includes("403") ||
    m.includes("api 호출 거부") ||
    m.includes("호출 거부 — 토큰 0건")
  ) {
    return "auth";
  }
  if (m.includes("rate limit") || m.includes("429") || m.includes("한도 초과")) {
    return "rate_limit";
  }
  if (m.includes("network") || m.includes("econn") || m.includes("etimedout") || m.includes("dns")) {
    return "network";
  }
  return "unknown";
}

/**
 * 세션 실패 시 보이는 모달 — 분류별 가이드 + 재시도/설정 이동.
 */
function ClaudeSessionErrorModal({
  error,
  onRetry,
  onGoSettings,
  onDismiss,
}: {
  error: { rawMessage: string; classification: "auth" | "rate_limit" | "network" | "unknown"; claudePath: string };
  onRetry: () => void;
  onGoSettings: () => void;
  onDismiss: () => void;
}) {
  const overlay: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.6)",
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "20px",
  };
  const card: React.CSSProperties = {
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius)",
    padding: "24px",
    maxWidth: "560px",
    width: "100%",
    color: "var(--color-text)",
    fontSize: "13px",
    lineHeight: 1.6,
  };
  const titleStyle: React.CSSProperties = {
    fontSize: "16px",
    fontWeight: 600,
    marginBottom: "12px",
  };
  const codeBox: React.CSSProperties = {
    background: "var(--color-bg)",
    border: "1px solid var(--color-border)",
    borderRadius: "4px",
    padding: "10px 12px",
    fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
    fontSize: "12px",
    margin: "8px 0",
    userSelect: "text" as const,
  };
  const btnRow: React.CSSProperties = {
    display: "flex",
    gap: "8px",
    justifyContent: "flex-end",
    marginTop: "20px",
    flexWrap: "wrap" as const,
  };
  const btnPrimary: React.CSSProperties = {
    background: "var(--color-accent)",
    border: "1px solid var(--color-accent)",
    color: "white",
    borderRadius: "var(--radius-sm)",
    padding: "8px 14px",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 500,
  };
  const btnSecondary: React.CSSProperties = {
    background: "transparent",
    border: "1px solid var(--color-border)",
    color: "var(--color-text)",
    borderRadius: "var(--radius-sm)",
    padding: "8px 14px",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 500,
  };

  let title = "Claude 세션 초기화 실패";
  let body: React.ReactNode = null;

  if (error.classification === "auth") {
    title = "Claude 로그인이 필요합니다";
    body = (
      <>
        <p style={{ margin: "0 0 8px" }}>
          Claude Code가 인증되지 않았거나 세션이 만료되었습니다. 터미널에서
          아래 명령으로 로그인을 진행해주세요.
        </p>
        <div style={codeBox}>{error.claudePath || "claude"} /login</div>
        <p style={{ margin: "12px 0 4px", color: "var(--color-text-secondary)" }}>
          또는 처음 사용이라면 임의의 명령으로 OAuth 화면을 띄울 수 있습니다:
        </p>
        <div style={codeBox}>{error.claudePath || "claude"} -p "ping"</div>
        <p style={{ margin: "12px 0 0", color: "var(--color-text-secondary)" }}>
          로그인을 마친 뒤 [다시 시도]를 눌러주세요.
        </p>
      </>
    );
  } else if (error.classification === "rate_limit") {
    title = "Anthropic API 요청 한도 초과";
    body = (
      <p style={{ margin: 0 }}>
        분당 요청 한도에 도달했습니다. 1~2분 후 [다시 시도]를 눌러주세요.
        반복되면 결제/플랜 한도를 확인해주세요.
      </p>
    );
  } else if (error.classification === "network") {
    title = "Claude 서버 연결 실패";
    body = (
      <p style={{ margin: 0 }}>
        네트워크 연결, VPN, 방화벽을 확인해주세요. 회사 네트워크에서는
        proxy 설정이 필요할 수 있습니다.
      </p>
    );
  } else {
    title = "Claude 세션 시작 실패";
    body = (
      <>
        <p style={{ margin: "0 0 8px" }}>
          알 수 없는 사유로 세션을 시작하지 못했습니다. 먼저 터미널에서
          Claude가 정상 동작하는지 확인해주세요:
        </p>
        <div style={codeBox}>{error.claudePath || "claude"} -p "ping"</div>
        <p style={{ margin: "8px 0 0", color: "var(--color-text-secondary)" }}>
          정상 응답이 오면 [다시 시도]를 눌러주세요.
        </p>
      </>
    );
  }

  return (
    <div style={overlay}>
      <div style={card}>
        <div style={titleStyle}>{title}</div>
        {body}
        <details style={{ marginTop: "12px", color: "var(--color-text-secondary)" }}>
          <summary style={{ cursor: "pointer" }}>원본 에러 메시지</summary>
          <pre
            style={{
              ...codeBox,
              marginTop: "8px",
              maxHeight: "180px",
              overflow: "auto",
              whiteSpace: "pre-wrap" as const,
              wordBreak: "break-word" as const,
            }}
          >
            {error.rawMessage}
          </pre>
        </details>
        <div style={btnRow}>
          <button style={btnSecondary} onClick={onDismiss}>
            나중에
          </button>
          <button style={btnSecondary} onClick={onGoSettings}>
            설정 열기
          </button>
          <button style={btnPrimary} onClick={onRetry}>
            다시 시도
          </button>
        </div>
      </div>
    </div>
  );
}

function AppRoutes() {
  const navigate = useNavigate();
  const location = useLocation();
  const { settings, updateSettings } = useSettings();

  // null = 확인 중, true = 연결됨, false = 미연결
  const [claudeReady, setClaudeReady] = useState<boolean | null>(null);
  const [sessionStarting, setSessionStarting] = useState(false);

  // 세션 초기화 실패 사유 — OAuth 로그인 필요 등. null이면 정상.
  const [sessionError, setSessionError] = useState<{
    rawMessage: string;
    classification: "auth" | "rate_limit" | "network" | "unknown";
    claudePath: string;
  } | null>(null);

  // 앱 시작 시 Claude 연결 확인 + 상주 세션 시작
  useEffect(() => {
    checkAndStartClaude();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkAndStartClaude = async () => {
    setClaudeReady(null);
    try {
      const result = await invoke<ClaudeTestResult>("test_claude_code", {
        customPath: settings.claudePath || null,
      });

      if (result.success) {
        const resolvedPath = result.path || settings.claudePath;
        updateSettings({ claudeVerified: true, claudePath: resolvedPath });

        // 상주 세션 시작
        if (!claudeSession.isConnected()) {
          setSessionStarting(true);
          setSessionError(null);
          try {
            await claudeSession.start(resolvedPath);
            console.log("[App] Claude session started successfully");
            setSessionError(null);
          } catch (sessionErr) {
            console.error("[App] Claude session start failed:", sessionErr);
            const raw = sessionErr instanceof Error ? sessionErr.message : String(sessionErr);
            setSessionError({
              rawMessage: raw,
              classification: classifySessionError(raw),
              claudePath: resolvedPath,
            });
          } finally {
            setSessionStarting(false);
          }
        }

        setClaudeReady(true);
      } else {
        updateSettings({ claudeVerified: false });
        setClaudeReady(false);
        navigate("/settings", { state: { from: getReturnPath(location.pathname) } });
      }
    } catch {
      updateSettings({ claudeVerified: false });
      setClaudeReady(false);
      navigate("/settings", { state: { from: getReturnPath(location.pathname) } });
    }
  };

  // 자동 업데이트 체크
  useEffect(() => {
    if (!settings.autoUpdate) return;

    const checkForUpdate = async () => {
      try {
        const update = await check();
        if (update) {
          const confirmed = window.confirm(
            `새 버전 ${update.version}이 있습니다. 업데이트하시겠습니까?`
          );
          if (confirmed) {
            await update.downloadAndInstall();
            await relaunch();
          }
        }
      } catch {
        // 실패 시 무시
      }
    };

    checkForUpdate();
    const interval = setInterval(checkForUpdate, 24 * 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, [settings.autoUpdate]);

  // navigate 이벤트 (메뉴 Cmd+, 등)
  // settings로 갈 때는 현재 경로를 from으로 전달해 [뒤로]가 원위치로 복귀하도록 함
  useEffect(() => {
    const unlisten = listen<string>("navigate", (event) => {
      const target = event.payload;
      if (target === "/settings") {
        navigate(target, { state: { from: getReturnPath(location.pathname) } });
      } else {
        navigate(target);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [navigate, location.pathname]);

  // Edit 메뉴(Cut/Copy/Paste/SelectAll/Undo/Redo)는 native NSResponder selector
  // 로 cgo 측에서 등록되므로 frontend는 어떤 keydown/paste 핸들러도 두지 않는다.
  // 키 이벤트는 cocoa → WKWebView 표준 경로를 그대로 타고, IME 모니터링도 정상.

  // 확인 중: 로딩 표시
  if (claudeReady === null) {
    return (
      <div style={loadingStyles}>
        <div
          style={{
            width: "28px",
            height: "28px",
            borderRadius: "50%",
            border: "3px solid var(--color-border)",
            borderTopColor: "var(--color-accent)",
            animation: "spin 0.8s linear infinite",
          }}
        />
        <span>
          {sessionStarting ? "Claude 세션 초기화 중..." : "Claude 연결 확인 중..."}
        </span>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <>
      {/* 미연결 경고 배너 (설정 페이지 제외) */}
      {claudeReady === false && (
        <ClaudeWarningBanner
          onGoSettings={() =>
            navigate("/settings", { state: { from: getReturnPath(location.pathname) } })
          }
        />
      )}

      {/* Claude 세션 초기화 실패 모달 — 로그인/네트워크/한도 등 가이드 */}
      {sessionError && (
        <ClaudeSessionErrorModal
          error={sessionError}
          onRetry={() => {
            setSessionError(null);
            checkAndStartClaude();
          }}
          onGoSettings={() => {
            setSessionError(null);
            navigate("/settings", { state: { from: getReturnPath(location.pathname) } });
          }}
          onDismiss={() => setSessionError(null)}
        />
      )}

      {/* 배너 높이만큼 콘텐츠 밀어내기 */}
      <div style={claudeReady === false ? { paddingTop: "40px" } : undefined}>
        <Routes>
          <Route path="/" element={<InputPage />} />
          <Route path="/analyze" element={<AnalyzePage />} />
          <Route path="/convert" element={<ConvertPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route
            path="/settings"
            element={
              <SettingsPage
                onClaudeConnected={checkAndStartClaude}
              />
            }
          />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </div>
    </>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <SettingsProvider>
        <WorkflowProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </WorkflowProvider>
      </SettingsProvider>
    </ErrorBoundary>
  );
}

export default App;
