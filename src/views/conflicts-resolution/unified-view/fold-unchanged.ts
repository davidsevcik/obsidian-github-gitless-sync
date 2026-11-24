import {
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@uiw/react-codemirror";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

// Unchanged lines shown before and after each conflict
const CONTEXT_LINES = 3;
// Folding fewer lines than this hides too little to be worth a click
const MIN_FOLDED_LINES = 4;

const UnfoldEffect = StateEffect.define<number>();

class FoldWidget extends WidgetType {
  constructor(private lines: number) {
    super();
  }

  eq(other: FoldWidget) {
    return other.lines === this.lines;
  }

  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement("div");
    div.className = "conflicts-fold";
    div.setText(`⋯ ${this.lines} unchanged lines`);
    div.setAttribute("aria-label", "Show unchanged lines");
    div.addEventListener("click", () => {
      view.dispatch({ effects: UnfoldEffect.of(view.posAtDOM(div)) });
    });
    return div;
  }

  // The editor would move the cursor there too, and on mobile that
  // opens the keyboard
  ignoreEvent() {
    return true;
  }
}

const createFolds = (
  state: EditorState,
  ranges: ConflictRange[],
): DecorationSet => {
  const builder = new RangeSetBuilder<Decoration>();
  // Nothing to focus on if there are no conflicts
  if (!ranges.some((range) => range.source !== "both")) {
    return builder.finish();
  }
  ranges.forEach((range, index) => {
    if (range.source !== "both") {
      return;
    }
    let startLine = state.doc.lineAt(range.from).number;
    let endLine = state.doc.lineAt(range.to).number;
    if (index > 0) {
      startLine += CONTEXT_LINES;
    }
    if (index < ranges.length - 1) {
      endLine -= CONTEXT_LINES;
    }
    const lines = endLine - startLine + 1;
    if (lines < MIN_FOLDED_LINES) {
      return;
    }
    builder.add(
      state.doc.line(startLine).from,
      state.doc.line(endLine).to,
      Decoration.replace({ widget: new FoldWidget(lines), block: true }),
    );
  });
  return builder.finish();
};

/// Hides the long runs of lines that are the same in both documents, so the
/// conflicts are easier to find. Clicking a fold shows its lines.
export const createFoldUnchanged = (initialRanges: ConflictRange[]) =>
  StateField.define<DecorationSet>({
    create: (state) => createFolds(state, initialRanges),
    update: (folds, tr) => {
      folds = folds.map(tr.changes);
      for (const effect of tr.effects) {
        if (effect.is(UnfoldEffect)) {
          folds = folds.update({
            filter: (from, to) => effect.value < from || effect.value > to,
          });
        }
      }
      return folds;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
