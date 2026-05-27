/**
 * WorkspacePickerModal — 같은 URL의 workspace가 이미 존재할 때 표시되는 3-way 다이얼로그.
 *
 * 옵션:
 * - 재사용: 기존 workspace 상태를 복원해 ConvertPage로 이동
 * - 새로 분석: 같은 workspace 디렉토리를 재사용하되 sections 초기화 후 AnalyzePage로 이동
 * - 취소: 모달만 닫음 (URL 입력 유지)
 */

import type { WorkspaceMeta } from "../services/workspace";

interface WorkspacePickerModalProps {
  existing: { slug: string; dir: string; meta: WorkspaceMeta };
  onReuse: () => void;
  onFreshAnalyze: () => void;
  onCancel: () => void;
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  backgroundColor: "rgba(0, 0, 0, 0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalStyle: React.CSSProperties = {
  backgroundColor: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius)",
  padding: "24px",
  maxWidth: "420px",
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

const titleStyle: React.CSSProperties = {
  color: "var(--color-text)",
  fontSize: "16px",
  fontWeight: 600,
};

const infoStyle: React.CSSProperties = {
  backgroundColor: "var(--color-bg)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  padding: "12px",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const labelStyle: React.CSSProperties = {
  color: "var(--color-text-secondary)",
  fontSize: "11px",
  fontWeight: 600,
  letterSpacing: "0.03em",
};

const valueStyle: React.CSSProperties = {
  color: "var(--color-text)",
  fontSize: "13px",
};

const badgeStyle = (type: "figma" | "axshare"): React.CSSProperties => ({
  display: "inline-block",
  fontSize: "11px",
  fontWeight: 500,
  padding: "2px 8px",
  borderRadius: "var(--radius-sm)",
  backgroundColor: type === "figma" ? "rgba(99, 102, 241, 0.12)" : "rgba(234, 179, 8, 0.12)",
  color: type === "figma" ? "var(--color-accent)" : "var(--color-warning)",
});

const progressBadgeStyle: React.CSSProperties = {
  display: "inline-block",
  fontSize: "11px",
  fontWeight: 500,
  padding: "2px 8px",
  borderRadius: "var(--radius-sm)",
  backgroundColor: "rgba(34, 197, 94, 0.1)",
  color: "var(--color-success)",
};

const actionsStyle: React.CSSProperties = {
  display: "flex",
  gap: "8px",
  justifyContent: "flex-end",
  flexWrap: "wrap",
};

const btnBase: React.CSSProperties = {
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 500,
  padding: "8px 16px",
  transition: "background 0.15s, border-color 0.15s",
  border: "1px solid var(--color-border)",
};

const btnPrimary: React.CSSProperties = {
  ...btnBase,
  backgroundColor: "var(--color-accent)",
  borderColor: "var(--color-accent)",
  color: "white",
};

const btnSecondary: React.CSSProperties = {
  ...btnBase,
  backgroundColor: "transparent",
  color: "var(--color-text)",
};

const btnGhost: React.CSSProperties = {
  ...btnBase,
  backgroundColor: "transparent",
  color: "var(--color-text-secondary)",
  borderColor: "transparent",
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function WorkspacePickerModal({
  existing,
  onReuse,
  onFreshAnalyze,
  onCancel,
}: WorkspacePickerModalProps) {
  const { meta } = existing;

  const doneCount = meta.sections.filter((s) => s.status === "done").length;
  const totalCount = meta.sections.length;

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <span style={titleStyle}>이미 변환된 워크스페이스가 있습니다</span>

        <div style={infoStyle}>
          <span style={labelStyle}>문서명</span>
          <span style={valueStyle}>{meta.documentName || "(이름 없음)"}</span>

          <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "4px" }}>
            <span style={badgeStyle(meta.sourceType)}>
              {meta.sourceType === "figma" ? "Figma" : "Axshare"}
            </span>
            {totalCount > 0 && (
              <span style={progressBadgeStyle}>
                {doneCount}/{totalCount}개 완료
              </span>
            )}
          </div>

          <span style={{ ...labelStyle, marginTop: "6px" }}>마지막 수정</span>
          <span style={{ ...valueStyle, fontSize: "12px", color: "var(--color-text-secondary)" }}>
            {formatDate(meta.updatedAt)}
          </span>
        </div>

        <span style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
          기존 변환 결과를 재사용하거나, 처음부터 새로 분석할 수 있습니다.
        </span>

        <div style={actionsStyle}>
          <button style={btnGhost} onClick={onCancel}>
            취소
          </button>
          <button style={btnSecondary} onClick={onFreshAnalyze}>
            새로 분석
          </button>
          <button style={btnPrimary} onClick={onReuse}>
            재사용
          </button>
        </div>
      </div>
    </div>
  );
}
