import { describe, expect, it } from "vitest";
import { EditorState } from "@uiw/react-codemirror";
import { DecorationSet, EditorView } from "@codemirror/view";
import diff from "../diff";
import { createResolutionDecorations } from "./decorations";
import { createRangesStateField } from "./ranges-state-field";
import { createUnifiedDocument } from "./unified-document";

/// Where the resolution bars are, the widgets are never drawn here
const resolutionBarPositions = (remote: string, local: string) => {
  const { doc, lineRanges } = createUnifiedDocument(
    remote,
    local,
    diff(remote, local),
  );
  const field = createRangesStateField(lineRanges);
  const state = EditorState.create({
    doc,
    extensions: [
      field,
      createResolutionDecorations(field, () => {
        throw new Error("Not clicked in tests");
      }),
    ],
  });
  const positions: number[] = [];
  for (const source of state.facet(EditorView.decorations)) {
    (source as DecorationSet).between(0, state.doc.length, (from) => {
      positions.push(from);
    });
  }
  return { doc, positions };
};

describe("createResolutionDecorations", () => {
  it("draws one bar between the two sides of a replacement", () => {
    const { doc, positions } = resolutionBarPositions(
      "a\nremote\nb",
      "a\nlocal\nb",
    );
    expect(positions).toEqual([doc.indexOf("remote") + "remote".length]);
  });

  it("draws a bar for a local conflict at the start of the file", () => {
    // The conflicts are a leading local line and a trailing remote line
    const { doc, positions } = resolutionBarPositions("mid\nR", "L\nmid");
    expect(positions).toEqual([0, doc.indexOf("R")]);
  });
});
