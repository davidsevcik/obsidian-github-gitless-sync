import * as React from "react";
import { ConflictFile, ConflictResolution } from "src/sync-manager";
import DiffView, { DiffViewHandle } from "./diff-view";
import { Side, sideContent } from "../side";
import AcceptAllBar from "../accept-all-bar";
import { ConfirmAcceptAll } from "../confirm-accept-all";
import NoConflicts from "../no-conflicts";

const UnifiedView = ({
  initialFiles,
  onResolveAllConflicts,
  confirmAcceptAll,
}: {
  initialFiles: ConflictFile[];
  onResolveAllConflicts: (resolutions: ConflictResolution[]) => void;
  confirmAcceptAll: ConfirmAcceptAll;
}) => {
  const [files, setFiles] = React.useState(initialFiles);
  const [resolvedConflicts, setResolvedConflicts] = React.useState<
    ConflictResolution[]
  >([]);
  const diffViews = React.useRef(new Map<string, DiffViewHandle>());

  const resolveFiles = (resolutions: ConflictResolution[]) => {
    const resolvedPaths = new Set(resolutions.map((r) => r.filePath));
    // Remove the files from the conflicts to resolve
    const remainingFiles = files.filter(
      (file) => !resolvedPaths.has(file.filePath),
    );
    setFiles(remainingFiles);
    // Keep track of the resolved conflicts
    const newResolvedConflicts = [...resolvedConflicts, ...resolutions];
    setResolvedConflicts(newResolvedConflicts);
    if (remainingFiles.length === 0) {
      // We solved all conflicts, we can resume syncing
      onResolveAllConflicts(newResolvedConflicts);
    }
  };

  /// Every conflict left in each file keeps the given side, the conflicts
  /// already resolved in the editors are kept.
  const acceptAllFiles = async (side: Side) => {
    if (!(await confirmAcceptAll(side, files.length))) {
      return;
    }
    resolveFiles(
      files.map((file) => ({
        filePath: file.filePath,
        content:
          diffViews.current.get(file.filePath)?.resolvedContent(side) ??
          sideContent(file, side),
      })),
    );
  };

  const renderConflict = (file: ConflictFile) => {
    return (
      <div
        key={file.filePath}
        style={{
          width: "100%",
          paddingTop: "var(--size-4-4)",
          paddingBottom: "var(--size-4-4)",
          borderBottom: "1px solid var(--background-modifier-border)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          className="inline-title"
          style={{
            width: "100%",
            paddingLeft: "var(--size-4-8)",
            paddingRight: "var(--size-4-8)",
          }}
        >
          {file.filePath}
        </div>
        <DiffView
          ref={(handle) => {
            if (handle) {
              diffViews.current.set(file.filePath, handle);
            } else {
              diffViews.current.delete(file.filePath);
            }
          }}
          initialRemoteText={file.remoteContent || ""}
          initialLocalText={file.localContent || ""}
          onConflictResolved={(content: string) => {
            resolveFiles([{ filePath: file.filePath, content }]);
          }}
        />
      </div>
    );
  };

  return (
    <React.StrictMode>
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "auto",
        }}
      >
        {files.length === 0 ? (
          <NoConflicts />
        ) : (
          <>
            <AcceptAllBar
              fileCount={files.length}
              onAcceptAll={acceptAllFiles}
            />
            {files.map(renderConflict)}
          </>
        )}
      </div>
    </React.StrictMode>
  );
};

export default UnifiedView;
