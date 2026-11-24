import { describe, expect, it } from "vitest";
import { EditorState, Text } from "@uiw/react-codemirror";
import diff from "../diff";
import { acceptAll } from "./accept-all";
import { createRangesStateField } from "./ranges-state-field";
import {
  countConflicts,
  createUnifiedDocument,
  withLineBreaks,
} from "./unified-document";

const unified = (remote: string, local: string) =>
  createUnifiedDocument(remote, local, diff(remote, local));

const pairs: [string, string, string][] = [
  ["replaced line", "a\nremote\nb", "a\nlocal\nb"],
  ["added at the end", "a\nb", "a\nb\nc"],
  ["removed at the start", "x\na\nb", "a\nb"],
  ["several conflicts", "1\n2\n3\n4\n5\n6\n7\n8", "1\nX\n3\n4\n5\n6\nY\n8\n9"],
  ["only remote content", "a\nb", ""],
];

describe("createUnifiedDocument", () => {
  it("shows the remote lines before the local ones", () => {
    const { doc, lineRanges } = unified("a\nremote\nb", "a\nlocal\nb");
    expect(doc).toBe("a\nremote\nlocal\nb");
    expect(lineRanges.map((r) => r.source)).toEqual([
      "both",
      "remote",
      "local",
      "both",
    ]);
  });

  it.each(pairs)(
    "gives back each side by accepting all of it: %s",
    (_, remote, local) => {
      const { doc, lineRanges } = unified(remote, local);
      const field = createRangesStateField(lineRanges);
      const state = EditorState.create({ doc, extensions: [field] });
      const accepted = (side: "local" | "remote") =>
        state.update(acceptAll(state, field, side)).state.doc.toString();
      expect(accepted("local")).toBe(local);
      expect(accepted("remote")).toBe(remote);
    },
  );
});

describe("countConflicts", () => {
  it("counts each run of changed lines once", () => {
    expect(countConflicts("a\nremote\nb", "a\nlocal\nb")).toBe(1);
    expect(
      countConflicts("1\n2\n3\n4\n5\n6\n7\n8", "1\nX\n3\n4\n5\n6\nY\n8"),
    ).toBe(2);
  });

  it("counts nothing for identical texts", () => {
    expect(countConflicts("a\nb", "a\nb")).toBe(0);
  });
});

describe("withLineBreaks", () => {
  const doc = Text.of(["a", "b"]);

  it("keeps the CRLF line breaks of the original", () => {
    expect(withLineBreaks(doc, "x\r\ny")).toBe("a\r\nb");
  });

  it("keeps LF line breaks", () => {
    expect(withLineBreaks(doc, "x\ny")).toBe("a\nb");
  });
});
