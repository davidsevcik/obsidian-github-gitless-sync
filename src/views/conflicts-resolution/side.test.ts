import { describe, expect, it } from "vitest";
import { keepSide } from "./side";

describe("keepSide", () => {
  it("resolves a text file with the content of the side", () => {
    const file = {
      filePath: "note.md",
      remoteContent: "remote",
      localContent: "local",
      binary: false,
    };
    expect(keepSide(file, "remote")).toEqual({
      filePath: "note.md",
      content: "remote",
    });
  });

  it("keeps a binary file whole", () => {
    const file = {
      filePath: "image.png",
      remoteContent: "",
      localContent: "",
      binary: true,
    };
    expect(keepSide(file, "local")).toEqual({
      filePath: "image.png",
      keep: "local",
    });
  });
});
