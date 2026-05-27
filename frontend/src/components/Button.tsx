import React from "react";

interface ButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
}

const variantStyles: Record<NonNullable<ButtonProps["variant"]>, React.CSSProperties> = {
  primary: {
    backgroundColor: "var(--color-accent)",
    color: "#fff",
    border: "none",
  },
  secondary: {
    backgroundColor: "var(--color-surface)",
    color: "var(--color-text-secondary)",
    border: "1px solid var(--color-border)",
  },
  danger: {
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    color: "var(--color-error)",
    border: "1px solid rgba(239, 68, 68, 0.2)",
  },
};

const variantHoverStyles: Record<NonNullable<ButtonProps["variant"]>, Partial<React.CSSProperties>> = {
  primary: {
    backgroundColor: "var(--color-accent-hover)",
  },
  secondary: {
    backgroundColor: "var(--color-surface-hover)",
    color: "var(--color-text)",
  },
  danger: {
    backgroundColor: "rgba(239, 68, 68, 0.18)",
  },
};

export default function Button({
  children,
  onClick,
  variant = "primary",
  disabled = false,
}: ButtonProps) {
  const baseStyle: React.CSSProperties = {
    padding: "8px 16px",
    borderRadius: "var(--radius-sm)",
    fontSize: "13px",
    fontWeight: 500,
    transition: "background-color var(--transition), color var(--transition), opacity var(--transition)",
    opacity: disabled ? 0.4 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
    whiteSpace: "nowrap" as const,
    ...variantStyles[variant],
  };

  const handleMouseEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const hoverStyle = variantHoverStyles[variant];
    Object.assign(e.currentTarget.style, hoverStyle);
  };

  const handleMouseLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const base = variantStyles[variant];
    e.currentTarget.style.backgroundColor = base.backgroundColor as string;
    if (base.color) e.currentTarget.style.color = base.color as string;
  };

  return (
    <button
      style={baseStyle}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
    </button>
  );
}
