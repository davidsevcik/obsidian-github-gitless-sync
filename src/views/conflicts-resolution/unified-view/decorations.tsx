import {
  EditorState,
  Range,
  RangeSetBuilder,
  StateField,
} from "@uiw/react-codemirror";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";

import { createRoot } from "react-dom/client";
import UnifiedResolutionBar from "./unified-resolution-bar";
import { UpdateRangesEffect } from "./ranges-state-field";
import { deleteLines } from "./accept-all";

interface ResolutionWidgetProps {
  onAcceptRemote: () => void;
  onAcceptLocal: () => void;
  onAcceptBoth?: () => void;
  onDiscardBoth?: () => void;
}

/// Widget that show some buttons to the user so they can resolve the conflicts.
/// This is usually drawn between two conflicting ranges in the document, if
/// the conflict comes only from a single document this will be shown on top.
///
/// If the conflict comes from a single document accepting the other one
/// discards its lines, and the accept both and discard both buttons are not set.
class ResolutionWidget extends WidgetType {
  constructor(private props: ResolutionWidgetProps) {
    super();
  }

  toDOM(): HTMLElement {
    const div = document.createElement("div");
    const root = createRoot(div);
    root.render(<UnifiedResolutionBar {...this.props} />);
    return div;
  }
}

/// Create a line decoration for CodeMirror editor that highlights
/// the ranges set by the ranges state field to show where the text comes from.
/// Text coming from remote will be shown as red and local as green.
export const createLineDecorations = (
  rangesStateField: StateField<ConflictRange[]>,
) => {
  return EditorView.decorations.compute(["doc", rangesStateField], (state) => {
    const ranges = state.field(rangesStateField);
    const builder = new RangeSetBuilder<Decoration>();

    for (const range of ranges) {
      const startLine = state.doc.lineAt(range.from);
      const endLine = state.doc.lineAt(range.to);
      for (let i = 0; i <= endLine.number - startLine.number; i += 1) {
        const line = state.doc.line(startLine.number + i);
        if (range.source === "remote") {
          builder.add(
            line.from,
            line.from,
            Decoration.line({ class: "cm-deletedLine" }),
          );
        } else if (range.source === "local") {
          builder.add(
            line.from,
            line.from,
            Decoration.line({ class: "cm-addedLine" }),
          );
        }
      }
    }

    return builder.finish();
  });
};

/// Create the resolution buttons depending on the ranges state field.
/// We need the view to dispatch the transaction to update the document
/// and delete the ranges when the user click the buttons.
export const createResolutionDecorations = (
  rangesStateField: StateField<ConflictRange[]>,
  getView: () => EditorView,
) => {
  return EditorView.decorations.compute(
    [rangesStateField],
    (state: EditorState) => {
      const ranges = state.field(rangesStateField);
      let widgets: Range<Decoration>[] = [];

      // The widget of a range that comes from a single document, accepting
      // its side keeps the lines and accepting the other side deletes them.
      const oneSidedWidget = (range: ConflictRange, index: number) => {
        const keep = () => {
          getView().dispatch({
            effects: UpdateRangesEffect.of({
              index: index,
              newSource: "both",
            }),
          });
        };
        const discard = () => {
          const view = getView();
          view.dispatch({
            changes: deleteLines(view.state.doc, range.from, range.to),
            effects: UpdateRangesEffect.of({
              index: index,
            }),
          });
        };
        const fromRemote = range.source === "remote";
        return Decoration.widget({
          widget: new ResolutionWidget({
            onAcceptRemote: fromRemote ? keep : discard,
            onAcceptLocal: fromRemote ? discard : keep,
          }),
          side: -1,
          block: true,
        }).range(range.from);
      };

      ranges.forEach((range: ConflictRange, index: number) => {
        if (range.source === "both") {
          return;
        }
        // at(-1) would be the last range
        const previousRange = index > 0 ? ranges[index - 1] : undefined;
        const nextRange = ranges.at(index + 1);

        if (range.source === "remote") {
          const nextRangeIsNew = nextRange?.source === "local";
          if (nextRangeIsNew) {
            const deco = Decoration.widget({
              widget: new ResolutionWidget({
                onAcceptRemote: () => {
                  getView().dispatch({
                    changes: {
                      from: range.to,
                      to: nextRange.to,
                      insert: "",
                    },
                    effects: [
                      UpdateRangesEffect.of({
                        index,
                        newSource: "both",
                      }),
                      UpdateRangesEffect.of({
                        index: index + 1,
                      }),
                    ],
                  });
                },
                onAcceptLocal: () => {
                  getView().dispatch({
                    changes: {
                      from: range.from,
                      to: nextRange?.from || range.to,
                      insert: "",
                    },
                    effects: [
                      UpdateRangesEffect.of({
                        index,
                      }),
                      UpdateRangesEffect.of({
                        index: index + 1,
                        newSource: "both",
                      }),
                    ],
                  });
                },
                onAcceptBoth: () => {
                  getView().dispatch({
                    effects: [
                      UpdateRangesEffect.of({
                        index,
                        newSource: "both",
                      }),
                      UpdateRangesEffect.of({
                        index: index + 1,
                        newSource: "both",
                      }),
                    ],
                  });
                },
                onDiscardBoth: () => {
                  const view = getView();
                  view.dispatch({
                    changes: deleteLines(
                      view.state.doc,
                      range.from,
                      nextRange.to,
                    ),
                    effects: [
                      UpdateRangesEffect.of({
                        index,
                      }),
                      UpdateRangesEffect.of({
                        index: index + 1,
                      }),
                    ],
                  });
                },
              }),
              side: 1,
              block: true,
            });
            widgets.push(deco.range(range.to));
          } else {
            widgets.push(oneSidedWidget(range, index));
          }
        } else if (
          range.source === "local" &&
          previousRange?.source !== "remote"
        ) {
          // We draw this only in case the previous range doesn't come from the old document
          // since we handle that above
          widgets.push(oneSidedWidget(range, index));
        }
      });

      return Decoration.set(widgets);
    },
  );
};
