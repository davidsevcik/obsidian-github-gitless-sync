import {
  ChangeSpec,
  EditorState,
  StateField,
  Text,
} from "@uiw/react-codemirror";
import { ClearRangesEffect } from "./ranges-state-field";
import { Side } from "../side";

/// The change that deletes the lines between from and to, with one of the
/// line breaks around them, or an empty line would be left in their place.
export const deleteLines = (doc: Text, from: number, to: number) => {
  from = doc.lineAt(from).from;
  to = doc.lineAt(to).to;
  if (to < doc.length) {
    to += 1;
  } else if (from > 0) {
    from -= 1;
  }
  return { from, to, insert: "" };
};

/// The transaction that resolves every conflict left in the document
/// keeping the lines of one side. Lines the user already resolved, the
/// ranges coming from both documents, are left untouched.
export const acceptAll = (
  state: EditorState,
  rangesField: StateField<ConflictRange[]>,
  side: Side,
) => {
  const discarded = side === "remote" ? "local" : "remote";
  const changes: ChangeSpec[] = [];
  for (const range of state.field(rangesField)) {
    if (range.source !== discarded) {
      continue;
    }
    changes.push(deleteLines(state.doc, range.from, range.to));
  }
  return { changes, effects: ClearRangesEffect.of(null) };
};

/// Where each conflict starts, a conflict is a run of ranges that don't
/// come from both documents on consecutive lines.
export const conflictStarts = (ranges: ConflictRange[]): number[] => {
  const starts: number[] = [];
  ranges.forEach((range, index) => {
    const previous = index > 0 ? ranges[index - 1] : undefined;
    if (
      range.source !== "both" &&
      (previous === undefined ||
        previous.source === "both" ||
        // A line that no range claims anymore separates the two, ranges
        // always end at the end of a line
        range.from > previous.to + 1)
    ) {
      starts.push(range.from);
    }
  });
  return starts;
};
