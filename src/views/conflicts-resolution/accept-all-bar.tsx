import * as React from "react";
import { Side, pluralize } from "./side";

interface AcceptAllBarProps {
  fileCount: number;
  onAcceptAll: (side: Side) => void;
}

/// Resolves every remaining file of the sync with the same side.
const AcceptAllBar: React.FC<AcceptAllBarProps> = ({
  fileCount,
  onAcceptAll,
}) => {
  return (
    <div className="conflicts-accept-all-bar">
      <div className="conflicts-accept-all-count">
        {pluralize(fileCount, "file")} with conflicts
      </div>
      <button onClick={() => onAcceptAll("local")}>Accept all local</button>
      <button onClick={() => onAcceptAll("remote")}>Accept all remote</button>
    </div>
  );
};

export default AcceptAllBar;
