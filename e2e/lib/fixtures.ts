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

type Rgb = [number, number, number];

/**
 * A PNG drawn by a function giving the color of each pixel.
 */
export function drawPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Rgb,
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
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter type of the row
    for (let x = 0; x < width; x++) {
      raw.set(pixel(x, y).map(Math.round), row + 1 + x * 3);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb =>
  [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as Rgb;

/**
 * A landscape: a sky, a sun and two hills, in the colors given.
 */
function landscape(colors: {
  skyTop: Rgb;
  skyBottom: Rgb;
  sun: Rgb;
  sunAt: [number, number];
  farHill: Rgb;
  nearHill: Rgb;
}): Buffer {
  const width = 360;
  const height = 240;
  return drawPng(width, height, (x, y) => {
    const near = height * 0.78 - 30 * Math.sin((x / width) * Math.PI * 1.3 + 0.6);
    const far = height * 0.6 - 40 * Math.sin((x / width) * Math.PI * 2 + 2.1);
    if (y > near) return colors.nearHill;
    if (y > far) return colors.farHill;
    const [sx, sy] = colors.sunAt;
    if (Math.hypot(x - sx, y - sy) < 26) return colors.sun;
    return mix(colors.skyTop, colors.skyBottom, y / height);
  });
}

// Two versions of a photo, as two devices could make: the day and the
// sunset. They're the same size, their bytes differ.
export const DAY_PNG = landscape({
  skyTop: [70, 140, 220],
  skyBottom: [190, 225, 250],
  sun: [255, 236, 140],
  sunAt: [270, 60],
  farHill: [110, 160, 110],
  nearHill: [60, 120, 70],
});
export const SUNSET_PNG = landscape({
  skyTop: [70, 50, 120],
  skyBottom: [250, 150, 90],
  sun: [255, 200, 90],
  sunAt: [110, 130],
  farHill: [120, 70, 90],
  nearHill: [60, 40, 60],
});

// Bytes that aren't an image, nor valid UTF-8 so they're not taken for text
export const BROKEN_IMAGE = Buffer.from([0xff, 0xfe, 0x00, 0x42, 0x61, 0x64]);
