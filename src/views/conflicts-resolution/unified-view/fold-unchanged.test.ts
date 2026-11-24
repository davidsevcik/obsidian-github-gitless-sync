import { describe, expect, it } from "vitest";
import { EditorState } from "@uiw/react-codemirror";
import { createFoldUnchanged } from "./fold-unchanged";

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);

/// The folded line ranges, as 1-based line numbers
const foldedLines = (
  state: EditorState,
  field: ReturnType<typeof createFoldUnchanged>,
) => {
  const folds: [number, number][] = [];
  state.field(field).between(0, state.doc.length, (from, to) => {
    folds.push([state.doc.lineAt(from).number, state.doc.lineAt(to).number]);
  });
  return folds;
};

/// 10 unchanged lines, a conflict line, 10 unchanged lines
const createState = () => {
  const doc = [...lines(10, "a"), "conflict", ...lines(10, "b")].join("\n");
  const state0 = EditorState.create({ doc });
  const line = (n: number) => state0.doc.line(n);
  const ranges: ConflictRange[] = [
    { from: line(1).from, to: line(10).to, source: "both" },
    { from: line(11).from, to: line(11).to, source: "local" },
    { from: line(12).from, to: line(21).to, source: "both" },
  ];
  const field = createFoldUnchanged(ranges);
  return { state: EditorState.create({ doc, extensions: [field] }), field };
};

describe("createFoldUnchanged", () => {
  it("folds unchanged lines leaving three lines around the conflict", () => {
    const { state, field } = createState();
    expect(foldedLines(state, field)).toEqual([
      [1, 7],
      [15, 21],
    ]);
  });

  it("folds nothing if there are no conflicts", () => {
    const doc = lines(20).join("\n");
    const field = createFoldUnchanged([
      { from: 0, to: doc.length, source: "both" },
    ]);
    const state = EditorState.create({ doc, extensions: [field] });
    expect(foldedLines(state, field)).toEqual([]);
  });

  it("doesn't fold a few unchanged lines", () => {
    const doc = ["a", "b", "conflict", "c", "d"].join("\n");
    const state0 = EditorState.create({ doc });
    const line = (n: number) => state0.doc.line(n);
    const field = createFoldUnchanged([
      { from: line(1).from, to: line(2).to, source: "both" },
      { from: line(3).from, to: line(3).to, source: "remote" },
      { from: line(4).from, to: line(5).to, source: "both" },
    ]);
    const state = EditorState.create({ doc, extensions: [field] });
    expect(foldedLines(state, field)).toEqual([]);
  });

  it("unfolds when an edit touches the fold", () => {
    const { state, field } = createState();
    const edited = state.update({
      changes: { from: 0, insert: "NEW\n" },
    }).state;
    expect(foldedLines(edited, field)).toEqual([[16, 22]]);
  });

  it("keeps the folds an edit elsewhere doesn't touch", () => {
    const { state, field } = createState();
    const conflict = state.doc.line(11);
    const edited = state.update({
      changes: { from: conflict.to, insert: "!" },
    }).state;
    expect(foldedLines(edited, field)).toEqual([
      [1, 7],
      [15, 21],
    ]);
  });
});
