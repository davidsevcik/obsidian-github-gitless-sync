import { Text } from "@uiw/react-codemirror";
import diff, { DiffChunk } from "../diff";
import { conflictStarts } from "./accept-all";

/// Create a unique document that combines text from the remote
/// and the local document depending on the diff chunks.
/// This returns a single string of the combined documents and the
/// ranges that specify whether a certain document range comes from
/// remote, local or both documents, so we can highlight them.
export const createUnifiedDocument = (
  remoteText: string,
  localText: string,
  diffChunks: DiffChunk[],
): { doc: string; lineRanges: ConflictRange[] } => {
  const sortedChunks = [...diffChunks].sort(
    (a, b) => a.startLeftLine - b.startLeftLine,
  );

  const remoteLines = remoteText.split(/\r?\n/);
  const localLines = localText.split(/\r?\n/);

  let result: string[] = [];
  let lineRanges: ConflictRange[] = [];
  let linePosition = 0;
  let currentRange: ConflictRange | null = null;

  let remoteTextLine = 1;
  let localTextLine = 1;

  const addLine = (line: string, source: "remote" | "local" | "both") => {
    result.push(line);

    const startPos = linePosition;
    const endPos = linePosition + line.length;

    if (currentRange && currentRange.source === source) {
      // Extend existing range
      currentRange.to = endPos;
    } else {
      // Create new range
      if (currentRange) {
        lineRanges.push(currentRange);
      }
      currentRange = { from: startPos, to: endPos, source };
    }

    // Move position to start of next line
    linePosition = endPos + 1; // +1 for newline
  };

  // Process each chunk
  for (const chunk of sortedChunks) {
    // Add common lines before the chunk
    while (
      remoteTextLine < chunk.startLeftLine &&
      localTextLine < chunk.startRightLine
    ) {
      addLine(remoteLines[remoteTextLine - 1], "both");
      remoteTextLine++;
      localTextLine++;
    }

    // Add removed lines (from old text)
    for (let i = remoteTextLine; i < chunk.endLeftLine; i++) {
      addLine(remoteLines[i - 1], "remote");
    }

    // Add added lines (from new text)
    for (let i = localTextLine; i < chunk.endRightLine; i++) {
      addLine(localLines[i - 1], "local");
    }

    // Update line pointers
    remoteTextLine = chunk.endLeftLine;
    localTextLine = chunk.endRightLine;
  }

  // Add remaining common lines after the last chunk
  while (
    remoteTextLine <= remoteLines.length &&
    localTextLine <= localLines.length
  ) {
    if (
      remoteTextLine > remoteLines.length ||
      localTextLine > localLines.length
    )
      break;
    addLine(remoteLines[remoteTextLine - 1], "both");
    remoteTextLine++;
    localTextLine++;
  }

  // Add the final range if there is one
  if (currentRange) {
    lineRanges.push(currentRange);
  }

  return { doc: result.join("\n"), lineRanges };
};

/// The editor splits lines on any line break, the content we save keeps
/// the line breaks of the original text.
export const withLineBreaks = (doc: Text, original: string) => {
  const text = doc.toString();
  return original.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
};

/// How many conflicts the unified document of the two versions has, the
/// same count the editor shows
export const countConflicts = (remoteText: string, localText: string) =>
  conflictStarts(
    createUnifiedDocument(remoteText, localText, diff(remoteText, localText))
      .lineRanges,
  ).length;
