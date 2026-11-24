import { describe, expect, it } from "vitest";
import { EditorState } from "@uiw/react-codemirror";
import { acceptAll, conflictStarts, deleteLines } from "./accept-all";
import {
  createRangesStateField,
  UpdateRangesEffect,
} from "./ranges-state-field";

const createState = (doc: string, ranges: ConflictRange[]) => {
  const field = createRangesStateField(ranges);
  return { state: EditorState.create({ doc, extensions: [field] }), field };
};

const acceptAllText = (
  state: EditorState,
  field: ReturnType<typeof createRangesStateField>,
  side: "local" | "remote",
) => state.update(acceptAll(state, field, side)).state.doc.toString();

// remote "a\nR\nb\nc", local "a\nL\nb\nc\nN"
const replacedAndAdded = (): ConflictRange[] => [
  { from: 0, to: 1, source: "both" },
  { from: 2, to: 3, source: "remote" },
  { from: 4, to: 5, source: "local" },
  { from: 6, to: 9, source: "both" },
  { from: 10, to: 11, source: "local" },
];

describe("acceptAll", () => {
  it("keeps the local lines of every conflict", () => {
    const { state, field } = createState(
      "a\nR\nL\nb\nc\nN",
      replacedAndAdded(),
    );
    expect(acceptAllText(state, field, "local")).toBe("a\nL\nb\nc\nN");
  });

  it("keeps the remote lines of every conflict", () => {
    const { state, field } = createState(
      "a\nR\nL\nb\nc\nN",
      replacedAndAdded(),
    );
    expect(acceptAllText(state, field, "remote")).toBe("a\nR\nb\nc");
  });

  it("leaves no conflicts", () => {
    const { state, field } = createState(
      "a\nR\nL\nb\nc\nN",
      replacedAndAdded(),
    );
    const next = state.update(acceptAll(state, field, "local")).state;
    expect(next.field(field)).toEqual([]);
  });

  it("keeps the conflicts already resolved", () => {
    const { state, field } = createState(
      "a\nR\nL\nb\nc\nN",
      replacedAndAdded(),
    );
    // What the Accept local button of the first conflict does
    const resolved = state.update({
      changes: { from: 2, to: 4, insert: "" },
      effects: [
        UpdateRangesEffect.of({ index: 1 }),
        UpdateRangesEffect.of({ index: 2, newSource: "both" }),
      ],
    }).state;
    expect(conflictStarts(resolved.field(field))).toHaveLength(1);
    expect(acceptAllText(resolved, field, "remote")).toBe("a\nL\nb\nc");
  });

  it("keeps a conflict replaced by hand", () => {
    const { state, field } = createState("R\nL", [
      { from: 0, to: 1, source: "remote" },
      { from: 2, to: 3, source: "local" },
    ]);
    const edited = state.update({
      changes: { from: 0, to: 3, insert: "merged" },
    }).state;
    expect(acceptAllText(edited, field, "local")).toBe("merged");
    expect(acceptAllText(edited, field, "remote")).toBe("merged");
  });

  it("keeps the half of a conflict edited by hand", () => {
    const { state, field } = createState("a\nR\nL\nb", [
      { from: 0, to: 1, source: "both" },
      { from: 2, to: 3, source: "remote" },
      { from: 4, to: 5, source: "local" },
      { from: 6, to: 7, source: "both" },
    ]);
    const edited = state.update({ changes: { from: 5, insert: "!" } }).state;
    expect(acceptAllText(edited, field, "remote")).toBe("a\nR\nL!\nb");
    expect(acceptAllText(edited, field, "local")).toBe("a\nL!\nb");
  });

  // remote "a\nb", local "a\n\nb"
  const addedEmptyLine = (): ConflictRange[] => [
    { from: 0, to: 1, source: "both" },
    { from: 2, to: 2, source: "local" },
    { from: 3, to: 4, source: "both" },
  ];

  it("keeps a conflict that is a single empty line after an edit", () => {
    const { state, field } = createState("a\n\nb", addedEmptyLine());
    const edited = state.update({ changes: { from: 4, insert: "!" } }).state;
    expect(conflictStarts(edited.field(field))).toHaveLength(1);
    expect(acceptAllText(edited, field, "remote")).toBe("a\nb!");
  });

  it.each([
    [1, 2],
    [2, 3],
  ])(
    "doesn't delete the next line once the empty conflict line is deleted by hand (%i-%i)",
    (from, to) => {
      const { state, field } = createState("a\n\nb", addedEmptyLine());
      const edited = state.update({ changes: { from, to } }).state;
      expect(acceptAllText(edited, field, "remote")).toBe("a\nb");
    },
  );
});

describe("deleteLines", () => {
  const doc = EditorState.create({ doc: "a\nX\nb" }).doc;
  const deleted = (from: number, to: number) =>
    EditorState.create({ doc })
      .update({ changes: deleteLines(doc, from, to) })
      .state.doc.toString();

  it("deletes a line with one of its line breaks", () => {
    expect(deleted(2, 3)).toBe("a\nb");
    expect(deleted(0, 1)).toBe("X\nb");
    expect(deleted(4, 5)).toBe("a\nX");
  });

  it("deletes the whole document", () => {
    expect(deleted(0, 5)).toBe("");
  });
});

describe("conflictStarts", () => {
  it("counts a replacement as one conflict", () => {
    expect(conflictStarts(replacedAndAdded())).toEqual([2, 10]);
  });

  it("keeps two conflicts apart once the line between them is erased", () => {
    // remote "R1\nx\nR2", local "L1\nx\nL2"
    const { state, field } = createState("R1\nL1\nx\nR2\nL2", [
      { from: 0, to: 2, source: "remote" },
      { from: 3, to: 5, source: "local" },
      { from: 6, to: 7, source: "both" },
      { from: 8, to: 10, source: "remote" },
      { from: 11, to: 13, source: "local" },
    ]);
    const edited = state.update({ changes: { from: 6, to: 7 } }).state;
    expect(conflictStarts(edited.field(field))).toHaveLength(2);
  });
});
