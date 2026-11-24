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
