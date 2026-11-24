// The image formats Obsidian shows, SVG is text so it's merged instead
const IMAGE_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/// The media type of an image file, undefined if it's not an image
export const imageType = (filePath: string): string | undefined => {
  const name = filePath.split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? IMAGE_TYPES[name.slice(dot + 1).toLowerCase()] : undefined;
};

/// "512 B", "12.3 KB", "4.1 MB"
export const formatSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(1)} ${units[unit]}`;
};
