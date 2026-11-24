import { EditorView } from "@codemirror/view";
import diff, { DiffChunk } from "../diff";
import EditorPane from "./editor-pane";
import ActionsGutter from "./actions-gutter";
import * as React from "react";

// The width of the actions gutter between the two panes
const GUTTER_WIDTH = "160px";

interface DiffViewProps {
  remoteText: string;
  localText: string;
  onRemoteTextChange: (content: string) => void;
  onLocalTextChange: (content: string) => void;
  onConflictResolved: () => void;
}

const DiffView: React.FC<DiffViewProps> = ({
  remoteText,
  localText,
  onRemoteTextChange,
  onLocalTextChange,
  onConflictResolved,
}) => {
  // We need to know the line height to correctly draw the ribbon between the left
  // and right editor in the actions gutter
  const [lineHeight, setLineHeight] = React.useState<number>(0);
  const handleEditorReady = (editor: EditorView) => {
    setLineHeight(editor.defaultLineHeight);
  };

  const [leftEditorTopOffset, setLeftEditorTopOffset] =
    React.useState<number>(0);
  const [rightEditorTopOffset, setRightEditorTopOffset] =
    React.useState<number>(0);

  const diffs = diff(remoteText, localText);

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <PaneHeaders />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
        }}
      >
        <div style={{ flex: 1 }}>
          <EditorPane
            content={remoteText}
            highlightPluginSpec={{
              diff: diffs,
              isOriginal: true,
            }}
            onEditorUpdate={handleEditorReady}
            onContentChange={onRemoteTextChange}
            onScrollTopUpdate={setLeftEditorTopOffset}
          />
        </div>
        <div style={{ minWidth: GUTTER_WIDTH, width: "auto" }}>
          <ActionsGutter
            diffChunks={diffs}
            lineHeight={lineHeight}
            leftEditorTopOffset={leftEditorTopOffset}
            rightEditorTopLineOffset={rightEditorTopOffset}
            onAcceptLeft={(chunk: DiffChunk) => {
              if (chunk.type === "add") {
                const remoteLines = remoteText.split("\n");
                remoteLines.splice(
                  chunk.startLeftLine - 1,
                  0,
                  ...localText
                    .split("\n")
                    .slice(chunk.startRightLine - 1, chunk.endRightLine - 1),
                );
                onRemoteTextChange(remoteLines.join("\n"));
              } else if (chunk.type === "modify") {
                const remoteLines = remoteText.split("\n");
                remoteLines.splice(
                  chunk.startLeftLine - 1,
                  chunk.endLeftLine - chunk.startLeftLine,
                  ...localText
                    .split("\n")
                    .slice(chunk.startRightLine - 1, chunk.endRightLine - 1),
                );
                onRemoteTextChange(remoteLines.join("\n"));
              }
            }}
            onAcceptRight={(chunk: DiffChunk) => {
              if (chunk.type === "remove") {
                const localLines = localText.split("\n");
                localLines.splice(
                  chunk.startRightLine - 1,
                  0,
                  ...remoteText
                    .split("\n")
                    .slice(chunk.startLeftLine - 1, chunk.endLeftLine - 1),
                );
                onLocalTextChange(localLines.join("\n"));
              } else if (chunk.type === "modify") {
                const localLines = localText.split("\n");
                localLines.splice(
                  chunk.startRightLine - 1,
                  chunk.endRightLine - chunk.startRightLine,
                  ...remoteText
                    .split("\n")
                    .slice(chunk.startLeftLine - 1, chunk.endLeftLine - 1),
                );
                onLocalTextChange(localLines.join("\n"));
              }
            }}
            onReject={(chunk: DiffChunk) => {
              if (chunk.type === "add") {
                const localLines = localText.split("\n");
                localLines.splice(
                  chunk.startRightLine - 1,
                  chunk.endRightLine - chunk.startRightLine,
                );
                onLocalTextChange(localLines.join("\n"));
              } else if (chunk.type === "remove") {
                const remoteLines = remoteText.split("\n");
                remoteLines.splice(
                  chunk.startLeftLine - 1,
                  chunk.endLeftLine - chunk.startLeftLine,
                );
                onRemoteTextChange(remoteLines.join("\n"));
              }
            }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <EditorPane
            content={localText}
            highlightPluginSpec={{
              diff: diffs,
              isOriginal: false,
            }}
            onContentChange={onLocalTextChange}
            onScrollTopUpdate={setRightEditorTopOffset}
          />
        </div>
      </div>
      <div className="conflicts-file-actions">
        {/* Both panes end up identical, so the file has no conflicts left */}
        <button
          disabled={diffs.length === 0}
          onClick={() => onRemoteTextChange(localText)}
        >
          All local
        </button>
        <button
          disabled={diffs.length === 0}
          onClick={() => onLocalTextChange(remoteText)}
        >
          All remote
        </button>
        <button
          className={diffs.length === 0 ? "mod-cta" : ""}
          disabled={diffs.length > 0}
          onClick={onConflictResolved}
        >
          Resolve conflict
        </button>
      </div>
    </div>
  );
};

/// Tells which side is which, the headers sit above the whole row so they
/// don't shift the editors against the actions gutter.
const PaneHeaders: React.FC = () => {
  return (
    <div className="conflicts-pane-headers">
      <div className="conflicts-pane-header">Remote</div>
      <div style={{ minWidth: GUTTER_WIDTH }} />
      <div className="conflicts-pane-header">Local</div>
    </div>
  );
};

export default DiffView;
