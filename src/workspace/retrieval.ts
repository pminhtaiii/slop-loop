import type { OpenedRegularTarget } from "./types.js";

const READ_BYTES = 65_536;
const SEARCH_BYTES = 32_768;
const SEARCH_FILE_BYTES = 4 * 1024 * 1024;
const LINE_BYTES = 4_096;
const encoder = new TextEncoder();

type ReadSource = Pick<OpenedRegularTarget, "canonicalPath" | "read">;

export type ReadResult =
  | {
      readonly kind: "CONTENT";
      readonly path: string;
      readonly method: "workspace-read";
      readonly content: string;
    }
  | {
      readonly kind: "SIZE_LIMIT" | "BINARY";
      readonly path: string;
      readonly method: "workspace-read";
    };

function encodedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function boundedRead(source: ReadSource): ReadResult {
  const base = { path: source.canonicalPath, method: "workspace-read" as const };
  const bytes = source.read(READ_BYTES + 1);
  if (bytes.byteLength > READ_BYTES) return { ...base, kind: "SIZE_LIMIT" };
  const content = decodeText(bytes);
  if (content === null) return { ...base, kind: "BINARY" };
  const result = { ...base, kind: "CONTENT" as const, content };
  return encodedBytes(result) <= READ_BYTES ? result : { ...base, kind: "SIZE_LIMIT" };
}

export interface SearchFile {
  readonly path: string;
  readonly content: string | Buffer;
}

export interface SearchResult {
  readonly kind: "SEARCH_RESULT";
  readonly method: "workspace-search";
  readonly matches: readonly {
    readonly path: string;
    readonly lineNumber: number;
    readonly line: string;
    readonly shortened: boolean;
  }[];
  readonly skipped: readonly { readonly path: string; readonly reason: "SIZE_LIMIT" | "BINARY" }[];
  readonly omittedMatches: boolean;
  readonly shortenedLines: boolean;
  readonly omittedFiles: boolean;
}

function shortenedLine(line: string): { line: string; shortened: boolean } {
  if (encoder.encode(line).byteLength <= LINE_BYTES) return { line, shortened: false };
  const characters: string[] = [];
  let bytes = 0;
  for (const character of line) {
    const length = encoder.encode(character).byteLength;
    if (bytes + length > LINE_BYTES) break;
    characters.push(character);
    bytes += length;
  }
  return { line: characters.join(""), shortened: true };
}

export function boundedSearch(
  files: Iterable<SearchFile>,
  query: string,
  limit = 200,
): SearchResult {
  if (!query || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new TypeError("Invalid search request");
  const matches: Array<{ path: string; lineNumber: number; line: string; shortened: boolean }> = [];
  const skipped: Array<{ path: string; reason: "SIZE_LIMIT" | "BINARY" }> = [];
  let omittedMatches = false;
  let shortenedLines = false;
  let omittedFiles = false;
  const result = (): SearchResult => ({
    kind: "SEARCH_RESULT",
    method: "workspace-search",
    matches,
    skipped,
    omittedMatches,
    shortenedLines,
    omittedFiles,
  });
  // Each flag changing from false to true removes one byte from the JSON envelope.
  let resultBytes = encodedBytes(result());
  const reserveItem = (item: unknown, previousCount: number): boolean => {
    const addedBytes = encodedBytes(item) + (previousCount > 0 ? 1 : 0);
    if (resultBytes + addedBytes > SEARCH_BYTES) return false;
    resultBytes += addedBytes;
    return true;
  };
  for (const file of files) {
    if (file.path.length > 1024) throw new TypeError("Invalid source path");
    const bytes = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
    const reason =
      bytes.byteLength > SEARCH_FILE_BYTES
        ? "SIZE_LIMIT"
        : decodeText(Buffer.from(bytes)) === null
          ? "BINARY"
          : null;
    if (reason !== null) {
      const item: SearchResult["skipped"][number] = { path: file.path, reason };
      if (reserveItem(item, skipped.length)) skipped.push(item);
      else if (!omittedFiles) {
        omittedFiles = true;
        resultBytes -= 1;
      }
      continue;
    }
    const content = typeof file.content === "string" ? file.content : decodeText(file.content);
    if (content === null) continue;
    for (const [index, line] of content.split(/\r?\n/u).entries()) {
      if (!line.includes(query)) continue;
      if (matches.length >= limit) {
        if (!omittedMatches) {
          omittedMatches = true;
          resultBytes -= 1;
        }
        continue;
      }
      const shortened = shortenedLine(line);
      const item = { path: file.path, lineNumber: index + 1, ...shortened };
      if (!reserveItem(item, matches.length)) {
        if (!omittedMatches) {
          omittedMatches = true;
          resultBytes -= 1;
        }
        continue;
      }
      matches.push(item);
      if (shortened.shortened && !shortenedLines) {
        shortenedLines = true;
        resultBytes -= 1;
      }
    }
  }
  return result();
}
