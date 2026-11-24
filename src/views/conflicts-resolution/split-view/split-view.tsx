import * as React from "react";
import { ConflictFile, ConflictResolution } from "src/sync-manager";
import DiffView from "./diff-view";
import FilesTabBar from "./files-tab-bar";
import AcceptAllBar from "../accept-all-bar";
import { ConfirmAcceptAll } from "../confirm-accept-all";
import NoConflicts from "../no-conflicts";
import { Side, sideContent } from "../side";

const SplitView = ({
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
  const [currentFileIndex, setCurrentFileIndex] = React.useState(0);
  const currentFile = files.at(currentFileIndex);

  const onConflictResolved = () => {
    // Remove the file from the conflicts to resolve
    const remainingFiles = files.filter(
      (_, index) => index !== currentFileIndex,
    );
    setFiles(remainingFiles);
    // Keep track of the resolved conflicts
    const newResolvedConflicts = [
      ...resolvedConflicts,
      {
        filePath: currentFile!.filePath,
        content: currentFile!.localContent,
      },
    ];
    setResolvedConflicts(newResolvedConflicts);
    // Select the previous file only if we're not already at the start
    if (currentFileIndex > 0) {
      setCurrentFileIndex(currentFileIndex - 1);
    }
    if (remainingFiles.length === 0) {
      // We solved all conflicts, we can resume syncing
      onResolveAllConflicts(newResolvedConflicts);
    }
  };

  // The panes hold the edits made so far, so the remaining conflicts of a
  // file keep a side by taking the whole pane of that side
  const acceptAllFiles = async (side: Side) => {
    if (!(await confirmAcceptAll(side, files.length))) {
      return;
    }
    setFiles([]);
    onResolveAllConflicts([
      ...resolvedConflicts,
      ...files.map((file) => ({
        filePath: file.filePath,
        content: sideContent(file, side),
      })),
    ]);
  };

  return (
    <React.StrictMode>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          justifyContent: "center",
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
            <FilesTabBar
              files={files.map((f) => f.filePath)}
              currentFile={currentFile?.filePath || ""}
              setCurrentFileIndex={setCurrentFileIndex}
            />
            <div
              style={{
                overflow: "auto",
                flex: 1,
              }}
            >
              <DiffView
                remoteText={currentFile?.remoteContent || ""}
                localText={currentFile?.localContent || ""}
                onRemoteTextChange={(content: string) => {
                  const tempFiles = [...files];
                  tempFiles[currentFileIndex].remoteContent = content;
                  setFiles(tempFiles);
                }}
                onLocalTextChange={(content: string) => {
                  const tempFiles = [...files];
                  tempFiles[currentFileIndex].localContent = content;
                  setFiles(tempFiles);
                }}
                onConflictResolved={onConflictResolved}
              />
            </div>
          </>
        )}
      </div>
    </React.StrictMode>
  );
};

export default SplitView;
