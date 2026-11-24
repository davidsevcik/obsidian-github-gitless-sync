import * as React from "react";
import { Menu } from "obsidian";
import { ConflictFile, ConflictResolution } from "src/sync-manager";
import DiffView, { DiffViewHandle, countConflicts } from "./diff-view";
import { Side, pluralize, sideContent } from "../side";
import IconButton from "../icon-button";
import AcceptAllBar from "../accept-all-bar";
import { ConfirmAcceptAll } from "../confirm-accept-all";
import NoConflicts from "../no-conflicts";

/// Shows the list of conflicting files, opening one shows only that file.
/// Files the user opened stay mounted, hidden, so going back to the list
/// doesn't lose the conflicts they already resolved.
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
  const [openFilePath, setOpenFilePath] = React.useState<string | null>(null);
  const [openedFilePaths, setOpenedFilePaths] = React.useState<string[]>([]);
  const [conflictsLeft, setConflictsLeft] = React.useState<
    Record<string, number>
  >(() =>
    Object.fromEntries(
      initialFiles.map((file) => [
        file.filePath,
        countConflicts(file.remoteContent || "", file.localContent || ""),
      ]),
    ),
  );
  const diffViews = React.useRef(new Map<string, DiffViewHandle>());

  const resolveFiles = (resolutions: ConflictResolution[]) => {
    const resolvedPaths = new Set(resolutions.map((r) => r.filePath));
    const remainingFiles = files.filter(
      (file) => !resolvedPaths.has(file.filePath),
    );
    setFiles(remainingFiles);
    setOpenedFilePaths(
      openedFilePaths.filter((filePath) => !resolvedPaths.has(filePath)),
    );
    const newResolvedConflicts = [...resolvedConflicts, ...resolutions];
    setResolvedConflicts(newResolvedConflicts);

    if (openFilePath !== null && resolvedPaths.has(openFilePath)) {
      // Move on to the file that comes next in the list, if any
      const index = files.findIndex((file) => file.filePath === openFilePath);
      const next = files
        .slice(index + 1)
        .find((file) => !resolvedPaths.has(file.filePath));
      if (next) {
        openFile(next.filePath);
      } else {
        setOpenFilePath(null);
      }
    }

    if (remainingFiles.length === 0) {
      // We solved all conflicts, we can resume syncing
      onResolveAllConflicts(newResolvedConflicts);
    }
  };

  const openFile = (filePath: string) => {
    setOpenedFilePaths((paths) =>
      paths.includes(filePath) ? paths : [...paths, filePath],
    );
    setOpenFilePath(filePath);
  };

  /// The content of the file once every conflict left in it keeps the
  /// given side, the conflicts already resolved in the editor are kept.
  const resolvedContent = (file: ConflictFile, side: Side) => {
    const diffView = diffViews.current.get(file.filePath);
    if (diffView) {
      return diffView.resolvedContent(side);
    }
    return sideContent(file, side);
  };

  const acceptFile = (file: ConflictFile, side: Side) => {
    resolveFiles([
      { filePath: file.filePath, content: resolvedContent(file, side) },
    ]);
  };

  const acceptAllFiles = async (side: Side) => {
    if (!(await confirmAcceptAll(side, files.length))) {
      return;
    }
    resolveFiles(
      files.map((file) => ({
        filePath: file.filePath,
        content: resolvedContent(file, side),
      })),
    );
  };

  if (files.length === 0) {
    return (
      <div className="conflicts-unified-view">
        <NoConflicts />
      </div>
    );
  }

  const openIndex = files.findIndex((file) => file.filePath === openFilePath);

  return (
    <React.StrictMode>
      <div className="conflicts-unified-view">
        {openIndex === -1 && (
          <div className="conflicts-file-list">
            <AcceptAllBar
              fileCount={files.length}
              onAcceptAll={acceptAllFiles}
            />
            {files.map((file) => (
              <FileRow
                key={file.filePath}
                filePath={file.filePath}
                conflictsLeft={conflictsLeft[file.filePath] ?? 0}
                onOpen={() => openFile(file.filePath)}
                onAccept={(side) => acceptFile(file, side)}
              />
            ))}
          </div>
        )}
        {files
          .filter((file) => openedFilePaths.includes(file.filePath))
          .map((file) => {
            const index = files.indexOf(file);
            return (
              <div
                key={file.filePath}
                className="conflicts-file-screen"
                style={{ display: index === openIndex ? "flex" : "none" }}
              >
                <FileNavigation
                  index={index}
                  fileCount={files.length}
                  onBack={() => setOpenFilePath(null)}
                  onPrevious={() => openFile(files[index - 1].filePath)}
                  onNext={() => openFile(files[index + 1].filePath)}
                />
                <FilePath filePath={file.filePath} />
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
                  onConflictsLeftChange={(conflicts) =>
                    setConflictsLeft((counts) => ({
                      ...counts,
                      [file.filePath]: conflicts,
                    }))
                  }
                  onConflictResolved={(content: string) => {
                    resolveFiles([{ filePath: file.filePath, content }]);
                  }}
                />
              </div>
            );
          })}
      </div>
    </React.StrictMode>
  );
};

const splitPath = (filePath: string) => {
  const slash = filePath.lastIndexOf("/");
  return {
    folder: slash === -1 ? "" : filePath.slice(0, slash),
    name: filePath.slice(slash + 1),
  };
};

const FilePath: React.FC<{ filePath: string }> = ({ filePath }) => {
  const { folder, name } = splitPath(filePath);
  return (
    <div className="conflicts-file-path">
      <div className="conflicts-file-name">{name}</div>
      {folder && <div className="conflicts-file-folder">{folder}</div>}
    </div>
  );
};

interface FileRowProps {
  filePath: string;
  conflictsLeft: number;
  onOpen: () => void;
  onAccept: (side: Side) => void;
}

const FileRow: React.FC<FileRowProps> = ({
  filePath,
  conflictsLeft,
  onOpen,
  onAccept,
}) => {
  const showMenu = (event: React.MouseEvent) => {
    // The row opens the file otherwise
    event.stopPropagation();
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("Keep local").onClick(() => onAccept("local")),
    );
    menu.addItem((item) =>
      item.setTitle("Keep remote").onClick(() => onAccept("remote")),
    );
    menu.addItem((item) => item.setTitle("Review").onClick(onOpen));
    menu.showAtMouseEvent(event.nativeEvent);
  };

  return (
    <div className="conflicts-file-row tappable" onClick={onOpen}>
      <FilePath filePath={filePath} />
      <div className="conflicts-file-count">
        {pluralize(conflictsLeft, "conflict")}
      </div>
      <IconButton
        icon="more-horizontal"
        label="Resolve file"
        fallbackText="⋯"
        onClick={showMenu}
      />
    </div>
  );
};

interface FileNavigationProps {
  index: number;
  fileCount: number;
  onBack: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

const FileNavigation: React.FC<FileNavigationProps> = ({
  index,
  fileCount,
  onBack,
  onPrevious,
  onNext,
}) => {
  return (
    <div className="conflicts-file-navigation">
      <button onClick={onBack}>Back</button>
      <div className="conflicts-file-navigation-count">
        {index + 1} of {fileCount}
      </div>
      <IconButton
        icon="chevron-left"
        label="Previous file"
        fallbackText="‹"
        disabled={index === 0}
        onClick={onPrevious}
      />
      <IconButton
        icon="chevron-right"
        label="Next file"
        fallbackText="›"
        disabled={index === fileCount - 1}
        onClick={onNext}
      />
    </div>
  );
};

export default UnifiedView;
