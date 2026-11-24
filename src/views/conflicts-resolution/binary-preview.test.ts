import { describe, expect, it } from "vitest";
import { formatSize, imageType } from "./binary-preview";

describe("imageType", () => {
  it("tells the type of an image from its extension", () => {
    expect(imageType("photo.png")).toBe("image/png");
    expect(imageType("attachments/Photo.JPG")).toBe("image/jpeg");
    expect(imageType("a.b/scan.webp")).toBe("image/webp");
  });

  it("doesn't preview files that aren't images", () => {
    expect(imageType("paper.pdf")).toBeUndefined();
    expect(imageType("png")).toBeUndefined();
    expect(imageType(".png")).toBeUndefined();
    expect(imageType("images.png/file")).toBeUndefined();
  });
});

describe("formatSize", () => {
  it("formats bytes in the largest unit", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(12_595)).toBe("12.3 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatSize(3 * 1024 ** 4)).toBe("3072.0 GB");
  });
});
