import { ConflictChoice, ConflictFile } from "src/sync-manager";

/// Which version of a conflicting file to keep
export type Side = "remote" | "local";

export const sideContent = (file: ConflictFile, side: Side): string =>
  (side === "local" ? file.localContent : file.remoteContent) || "";

/// The choice that keeps one version of the file whole
export const keepSide = (file: ConflictFile, side: Side): ConflictChoice =>
  file.binary
    ? { filePath: file.filePath, keep: side }
    : { filePath: file.filePath, content: sideContent(file, side) };

/// "1 file", "3 files"
export const pluralize = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
