import { useState } from "react";

interface Props {
  npmGlobalRoot?: string;
  errorMessage?: string;
  onRecheck: () => void;
  onCancel: () => void;
}

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

const title: React.CSSProperties = {
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
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "8px",
};

const copyBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  color: "var(--color-text)",
  padding: "3px 10px",
  cursor: "pointer",
  fontSize: "11px",
  fontWeight: 500,
  whiteSpace: "nowrap",
};

const btnRow: React.CSSProperties = {
  display: "flex",
  gap: "8px",
  justifyContent: "flex-end",
  marginTop: "20px",
  flexWrap: "wrap",
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

function CommandLine({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };
  return (
    <div style={codeBox}>
      <span style={{ flex: 1, userSelect: "text", overflowX: "auto" }}>{cmd}</span>
      <button style={copyBtn} onClick={handleCopy}>
        {copied ? "복사됨" : "복사"}
      </button>
    </div>
  );
}

/**
 * Axshare 변환 시 Playwright가 글로벌 npm에 미설치된 경우 노출되는 안내 모달.
 * 사용자가 1회 설치 후 [다시 확인] → 통과 시 진행.
 */
export default function PlaywrightSetupModal({
  npmGlobalRoot,
  errorMessage,
  onRecheck,
  onCancel,
}: Props) {
  return (
    <div style={overlay}>
      <div style={card}>
        <div style={title}>Playwright 설치 필요</div>

        <p style={{ margin: "0 0 12px" }}>
          Axshare 변환은 Playwright(Chromium)을 사용합니다. 사용자 환경의 글로벌 npm
          모듈에서 Playwright를 찾을 수 없어 진행할 수 없습니다.
        </p>

        <p style={{ margin: "12px 0 4px", fontWeight: 500 }}>1. 터미널에서 Playwright 설치:</p>
        <CommandLine cmd="npm install -g playwright" />

        <p style={{ margin: "12px 0 4px", fontWeight: 500 }}>2. 브라우저 바이너리 설치 (Chromium):</p>
        <CommandLine cmd="npx playwright install chromium" />

        {npmGlobalRoot && (
          <p
            style={{
              margin: "12px 0 0",
              color: "var(--color-text-secondary)",
              fontSize: "12px",
            }}
          >
            현재 npm 글로벌 위치: <code>{npmGlobalRoot}</code>
            <br />
            설치 후 <code>{npmGlobalRoot}/playwright</code>가 생성됩니다.
          </p>
        )}

        {errorMessage && (
          <details style={{ marginTop: "12px", color: "var(--color-text-secondary)" }}>
            <summary style={{ cursor: "pointer" }}>원본 에러</summary>
            <pre
              style={{
                ...codeBox,
                display: "block",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                marginTop: "8px",
              }}
            >
              {errorMessage}
            </pre>
          </details>
        )}

        <p
          style={{
            margin: "16px 0 0",
            color: "var(--color-text-secondary)",
            fontSize: "12px",
          }}
        >
          Figma URL을 사용하실 거면 Playwright 없이도 변환 가능합니다.
        </p>

        <div style={btnRow}>
          <button style={btnSecondary} onClick={onCancel}>
            나중에
          </button>
          <button style={btnPrimary} onClick={onRecheck}>
            다시 확인
          </button>
        </div>
      </div>
    </div>
  );
}
