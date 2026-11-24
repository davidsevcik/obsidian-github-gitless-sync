import * as React from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";

import diff from "../diff";
import { createRangesStateField } from "./ranges-state-field";
import {
  createLineDecorations,
  createResolutionDecorations,
} from "./decorations";
import { acceptAll, conflictStarts } from "./accept-all";
import { Side, pluralize } from "../side";
import IconButton from "../icon-button";
import { createFoldUnchanged } from "./fold-unchanged";
import { createUnifiedDocument, withLineBreaks } from "./unified-document";

interface DiffViewProps {
  initialRemoteText: string;
  initialLocalText: string;
  onConflictsLeftChange?: (conflicts: number) => void;
  onConflictResolved: (content: string) => void;
}

/// Lets the parent resolve the file without dispatching anything, used
/// when all the files are resolved at once.
export interface DiffViewHandle {
  /// The content of the file once every conflict left keeps the given side
  resolvedContent: (side: Side) => string;
}

const DiffView = React.forwardRef<DiffViewHandle, DiffViewProps>(
  (
    {
      initialRemoteText,
      initialLocalText,
      onConflictsLeftChange,
      onConflictResolved,
    },
    ref,
  ) => {
    const editorViewRef = React.useRef<EditorView | null>(null);

    const setup = React.useMemo(() => {
      const diffChunks = diff(initialRemoteText, initialLocalText);
      const { doc, lineRanges } = createUnifiedDocument(
        initialRemoteText,
        initialLocalText,
        diffChunks,
      );
      return {
        doc,
        lineRanges,
        rangesField: createRangesStateField(lineRanges),
      };
    }, [initialRemoteText, initialLocalText]);
    const { doc, lineRanges, rangesField } = setup;

    const [conflictsLeft, setConflictsLeft] = React.useState(
      () => conflictStarts(lineRanges).length,
    );
    React.useEffect(() => {
      onConflictsLeftChange?.(conflictsLeft);
    }, [conflictsLeft]);

    React.useImperativeHandle(
      ref,
      () => ({
        resolvedContent: (side: Side) => {
          const sideText =
            side === "local" ? initialLocalText : initialRemoteText;
          const view = editorViewRef.current;
          if (!view) {
            return sideText;
          }
          const state = view.state;
          return withLineBreaks(
            state.update(acceptAll(state, rangesField, side)).state.doc,
            sideText,
          );
        },
      }),
      [setup],
    );

    const acceptAllInEditor = (side: Side) => {
      const view = editorViewRef.current!;
      view.dispatch(acceptAll(view.state, rangesField, side));
    };

    /// Moves the cursor to the next or previous conflict and scrolls to it,
    /// wrapping around at the ends of the document.
    const goToConflict = (direction: 1 | -1) => {
      const view = editorViewRef.current!;
      const starts = conflictStarts(view.state.field(rangesField));
      if (starts.length === 0) {
        return;
      }
      const head = view.state.selection.main.head;
      const target =
        direction === 1
          ? (starts.find((pos) => pos > head) ?? starts[0])
          : ([...starts].reverse().find((pos) => pos < head) ??
            starts[starts.length - 1]);
      view.dispatch({
        selection: { anchor: target },
        effects: EditorView.scrollIntoView(target, { y: "center" }),
      });
    };

    const extensions = React.useMemo(() => {
      return [
        rangesField,
        createFoldUnchanged(lineRanges),
        createLineDecorations(rangesField),
        createResolutionDecorations(rangesField, () => editorViewRef.current!),
        EditorView.updateListener.of((update) => {
          const ranges = update.state.field(rangesField);
          if (ranges !== update.startState.field(rangesField)) {
            setConflictsLeft(conflictStarts(ranges).length);
          }
        }),
        EditorView.editable.of(true),
        EditorView.lineWrapping,
        EditorView.theme({
          "&": {
            backgroundColor: "var(--background-primary)",
            color: "var(--text-normal)",
            borderTop: "1px solid var(--background-modifier-border)",
            borderBottom: "1px solid var(--background-modifier-border)",
          },
          ".cm-content": {
            padding: 0,
            caretColor: "var(--caret-color)",
            fontSize: "var(--font-text-size)",
            fontFamily: "var(--font-text)",
          },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
            background: "var(--text-selection)",
          },
          "&.cm-focused": {
            outline: 0,
          },
          "&.cm-focused .cm-cursor": {
            borderLeftColor: "var(--text-normal)",
          },
          ".cm-addedLine": {
            backgroundColor: "rgba(var(--color-green-rgb), 0.1)",
          },
          ".cm-deletedLine": {
            backgroundColor: "rgba(var(--color-red-rgb), 0.1)",
          },
        }),
      ];
    }, [setup]);

    const hasConflicts = conflictsLeft > 0;

    return (
      <div className="conflicts-unified-diff">
        <div className="conflicts-navigation">
          <div className="conflicts-navigation-count">
            {conflictsLeft === 0
              ? "No conflicts left"
              : `${pluralize(conflictsLeft, "conflict")} left`}
          </div>
          {hasConflicts && (
            <>
              <IconButton
                icon="chevron-up"
                label="Previous conflict"
                fallbackText="‹"
                onClick={() => goToConflict(-1)}
              />
              <IconButton
                icon="chevron-down"
                label="Next conflict"
                fallbackText="›"
                onClick={() => goToConflict(1)}
              />
            </>
          )}
        </div>
        <div className="conflicts-unified-editor">
          <CodeMirror
            value={doc}
            height="100%"
            style={{ height: "100%" }}
            theme="none"
            basicSetup={false}
            extensions={extensions}
            onCreateEditor={(view: EditorView) => {
              editorViewRef.current = view;
            }}
          />
        </div>
        <div className="conflicts-file-actions">
          <button
            disabled={!hasConflicts}
            onClick={() => acceptAllInEditor("local")}
          >
            All local
          </button>
          <button
            disabled={!hasConflicts}
            onClick={() => acceptAllInEditor("remote")}
          >
            All remote
          </button>
          <button
            className={hasConflicts ? "" : "mod-cta"}
            disabled={hasConflicts}
            onClick={() => {
              // The local file is the one we're writing
              const content = withLineBreaks(
                editorViewRef.current!.state.doc,
                initialLocalText,
              );
              onConflictResolved(content);
            }}
          >
            Resolve conflict
          </button>
        </div>
      </div>
    );
  },
);

export default DiffView;
