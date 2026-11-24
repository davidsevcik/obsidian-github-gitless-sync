import * as React from "react";
import { Side } from "./side";

/// A file that isn't text can't be merged, one version replaces the other
const BinaryConflict: React.FC<{ onKeep: (side: Side) => void }> = ({
  onKeep,
}) => {
  return (
    <div className="conflicts-binary">
      <p>
        This file isn't text, so its versions can't be merged. Keep one of them,
        it replaces the other.
      </p>
      <div className="conflicts-file-actions">
        <button onClick={() => onKeep("local")}>Keep local</button>
        <button onClick={() => onKeep("remote")}>Keep remote</button>
      </div>
    </div>
  );
};

export default BinaryConflict;
