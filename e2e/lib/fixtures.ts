import { crc32, deflateSync } from "node:zlib";

// Test data shared by the scenarios

// A 1x1 PNG, its bytes are not valid UTF-8 so it catches binary files
// handled as text
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);


// Two other versions of the image, as two devices could make. Bytes after
// the end of a PNG are ignored by viewers, and they still have NUL bytes.
export const PNG_FROM_A = Buffer.concat([PNG, Buffer.from("from A\0")]);
export const PNG_FROM_B = Buffer.concat([PNG, Buffer.from("from B\0")]);

/**
 * A PNG of one color, big enough to see in a screenshot.
 */
export function solidPng(
  width: number,
  height: number,
  [r, g, b]: [number, number, number],
): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([length, typeAndData, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  // Each row starts with filter type 0
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat()),
  ]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// The versions of an image two devices made, red and blue
export const RED_PNG = solidPng(120, 80, [220, 40, 40]);
export const BLUE_PNG = solidPng(160, 80, [40, 80, 220]);

// Bytes that aren't an image, nor valid UTF-8 so they're not taken for text
export const BROKEN_IMAGE = Buffer.from([0xff, 0xfe, 0x00, 0x42, 0x61, 0x64]);
