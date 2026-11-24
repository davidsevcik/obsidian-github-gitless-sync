import { describe, expect, it } from "vitest";
import { decodeText } from "./utils";

describe("decodeText", () => {
  it("decodes UTF-8 text", () => {
    expect(decodeText(new TextEncoder().encode("héllo 👋\n"))).toBe(
      "héllo 👋\n",
    );
  });

  it("decodes an empty file", () => {
    expect(decodeText(new Uint8Array())).toBe("");
  });

  it("rejects bytes that aren't UTF-8", () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
  });

  it("rejects content with NUL bytes", () => {
    expect(decodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]))).toBeNull();
  });
});
