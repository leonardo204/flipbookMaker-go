import React, { useState } from "react";

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  /**
   * `type="password"`는 macOS Secure Event Input을 활성화해 외부 IME 모니터
   * (한영 표시기 등)가 키 이벤트를 받지 못한다. 토큰처럼 ASCII만 들어가는
   * 필드는 type="text"로 두고 시각적 마스킹만 적용하면 그 문제가 사라진다.
   * `type="password"`가 전달되면 자동으로 text + 마스킹 + 토글로 전환한다.
   */
  type?: string;
  onEnter?: () => void;
  disabled?: boolean;
}

export default function TextInput({
  value,
  onChange,
  placeholder,
  label,
  type = "text",
  onEnter,
  disabled = false,
}: TextInputProps) {
  const isPassword = type === "password";
  const [revealed, setRevealed] = useState(false);
  const masked = isPassword && !revealed;

  const containerStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    width: "100%",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: "12px",
    color: "var(--color-text-secondary)",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  };

  const inputStyle: React.CSSProperties = {
    backgroundColor: "var(--color-bg)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-text)",
    fontSize: "13px",
    padding: "9px 12px",
    paddingRight: isPassword ? "40px" : "12px",
    outline: "none",
    transition: "border-color var(--transition), box-shadow var(--transition)",
    width: "100%",
    // -webkit-text-security은 WKWebView / Chromium 모두 지원 — type=text를
    // 유지한 채 시각만 마스킹.
    WebkitTextSecurity: masked ? "disc" : undefined,
  } as React.CSSProperties;

  const wrapperStyle: React.CSSProperties = {
    position: "relative",
    width: "100%",
  };

  const toggleStyle: React.CSSProperties = {
    position: "absolute",
    top: "50%",
    right: "8px",
    transform: "translateY(-50%)",
    background: "transparent",
    border: "none",
    color: "var(--color-text-secondary)",
    cursor: "pointer",
    fontSize: "13px",
    padding: "4px 6px",
    borderRadius: "var(--radius-sm)",
  };

  // password로 들어와도 실제 DOM input의 type은 항상 text. 마스킹은 CSS.
  const renderedType = "text";

  return (
    <div style={containerStyle}>
      {label && <label style={labelStyle}>{label}</label>}
      <div style={wrapperStyle}>
        <input
          type={renderedType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete={isPassword ? "off" : undefined}
          autoCorrect={isPassword ? "off" : undefined}
          autoCapitalize={isPassword ? "off" : undefined}
          spellCheck={isPassword ? false : undefined}
          style={{
            ...inputStyle,
            opacity: disabled ? 0.5 : 1,
            cursor: disabled ? "not-allowed" : "text",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && onEnter) onEnter();
          }}
          onFocus={(e) => {
            if (disabled) return;
            e.currentTarget.style.borderColor = "var(--color-accent)";
            e.currentTarget.style.boxShadow = "0 0 0 2px var(--color-accent-subtle)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "var(--color-border)";
            e.currentTarget.style.boxShadow = "none";
          }}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            style={toggleStyle}
            tabIndex={-1}
            aria-label={revealed ? "숨기기" : "표시"}
            title={revealed ? "숨기기" : "표시"}
          >
            {revealed ? "🙈" : "👁"}
          </button>
        )}
      </div>
    </div>
  );
}
