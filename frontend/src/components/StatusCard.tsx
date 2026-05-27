import React from "react";

interface StatusCardProps {
  title: string;
  status: "success" | "warning" | "error" | "info";
  children: React.ReactNode;
}

const statusColors: Record<StatusCardProps["status"], string> = {
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  error: "var(--color-error)",
  info: "var(--color-accent)",
};

const statusBgColors: Record<StatusCardProps["status"], string> = {
  success: "rgba(34, 197, 94, 0.06)",
  warning: "rgba(234, 179, 8, 0.06)",
  error: "rgba(239, 68, 68, 0.06)",
  info: "rgba(99, 102, 241, 0.06)",
};

const statusLabels: Record<StatusCardProps["status"], string> = {
  success: "성공",
  warning: "경고",
  error: "오류",
  info: "정보",
};

export default function StatusCard({ title, status, children }: StatusCardProps) {
  const color = statusColors[status];
  const bgColor = statusBgColors[status];

  const cardStyle: React.CSSProperties = {
    backgroundColor: bgColor,
    border: "1px solid var(--color-border)",
    borderLeft: `3px solid ${color}`,
    borderRadius: "var(--radius)",
    padding: "14px 16px",
    width: "100%",
  };

  const headerStyle: React.CSSProperties = {
    alignItems: "center",
    display: "flex",
    gap: "8px",
    marginBottom: "6px",
  };

  const badgeStyle: React.CSSProperties = {
    backgroundColor: color,
    borderRadius: "var(--radius-sm)",
    color: "#fff",
    fontSize: "10px",
    fontWeight: 600,
    padding: "2px 7px",
    letterSpacing: "0.03em",
  };

  const titleStyle: React.CSSProperties = {
    color: "var(--color-text)",
    fontSize: "13px",
    fontWeight: 600,
  };

  const contentStyle: React.CSSProperties = {
    color: "var(--color-text-secondary)",
    fontSize: "13px",
    lineHeight: 1.5,
  };

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>
        <span style={badgeStyle}>{statusLabels[status]}</span>
        <span style={titleStyle}>{title}</span>
      </div>
      <div style={contentStyle}>{children}</div>
    </div>
  );
}
