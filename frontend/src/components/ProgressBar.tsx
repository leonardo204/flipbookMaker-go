import React from "react";

interface ProgressBarProps {
  progress: number; // 0-100
  label?: string;
}

export default function ProgressBar({ progress, label }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, progress));
  const isComplete = clamped === 100;

  const containerStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    width: "100%",
  };

  const labelRowStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    fontSize: "12px",
    color: "var(--color-text-secondary)",
  };

  const trackStyle: React.CSSProperties = {
    backgroundColor: "var(--color-surface)",
    borderRadius: "4px",
    height: "6px",
    overflow: "hidden",
    width: "100%",
  };

  const fillStyle: React.CSSProperties = {
    backgroundColor: isComplete ? "var(--color-success)" : "var(--color-accent)",
    borderRadius: "4px",
    height: "100%",
    transition: "width 0.3s ease, background-color 0.3s ease",
    width: `${clamped}%`,
  };

  return (
    <div style={containerStyle}>
      <div style={labelRowStyle}>
        {label && <span>{label}</span>}
        <span style={{ marginLeft: "auto" }}>{clamped}%</span>
      </div>
      <div style={trackStyle}>
        <div style={fillStyle} />
      </div>
    </div>
  );
}
