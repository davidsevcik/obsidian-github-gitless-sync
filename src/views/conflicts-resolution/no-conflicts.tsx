import * as React from "react";

/// Shown once every conflict is resolved
const NoConflicts: React.FC = () => {
  return (
    <div
      style={{
        position: "relative",
        textAlign: "center",
        alignSelf: "center",
      }}
    >
      <div
        style={{
          margin: "20px 0",
          fontWeight: "var(--h2-weight)",
          fontSize: "var(--h2-size)",
          lineHeight: "var(--line-height-tight)",
        }}
      >
        No conflicts to resolve
      </div>
      <div
        style={{
          margin: "20px 0",
          fontSize: "var(--font-text-size)",
          color: "var(--text-muted)",
          lineHeight: "var(--line-height-tight)",
        }}
      >
        That's good, keep going
      </div>
    </div>
  );
};

export default NoConflicts;
