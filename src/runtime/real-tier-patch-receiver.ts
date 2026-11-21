/**
 * The real-tier production patch receiver.
 *
 * Applies an admitted, already-validated patch to the bound host repository through the existing
 * `WorkspaceFilesystemPort`, then reports the measured host revision so the settled-patch hook can
 * mirror it into the volume. It writes only the admitted target paths, refuses a protected or
 * excluded path, refuses a path whose parent is not a real directory, and refuses a hunk whose
 * context does not match the current bytes (a patch that is not this file's patch). The receiver
 * performs the write only; the caller still measures, settles and mirrors.
 */
import { isCanonicalRelativePath, isProtectedPath } from '../contracts/foundation/uc03.ts';
import type { ApplyPatchAction } from '../contracts/foundation/uc03.ts';
import type { WorkspaceFilesystemPort } from '../foundation/host-filesystem-port.ts';

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

interface Hunk {
  readonly oldStart: number;
  readonly body: readonly string[];
}

interface FileHunks {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly hunks: readonly Hunk[];
}

function diffPath(raw: string, prefix: string): string | null {
  const token = raw.replace(/\r$/u, '').split('\t')[0] ?? '';
  if (token === '/dev/null') return null;
  return token.startsWith(prefix) ? token.slice(prefix.length) : token;
}

/** Every file section of one unified diff, in order, with each hunk's raw body lines. */
function parseSections(diff: string): FileHunks[] | null {
  const sections: FileHunks[] = [];
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let current: { oldPath: string | null; newPath: string | null; hunks: Hunk[] } | null = null;
  let openHunk: string[] | null = null;
  for (const line of diff.split('\n')) {
    if (openHunk !== null && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\'))) {
      openHunk.push(line);
      continue;
    }
    if (line.startsWith('--- ')) {
      if (current) sections.push(current);
      oldPath = diffPath(line.slice(4), 'a/');
      newPath = null;
      current = { oldPath, newPath: null, hunks: [] };
      openHunk = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (!current) return null;
      newPath = diffPath(line.slice(4), 'b/') ?? oldPath;
      current = { oldPath, newPath, hunks: current.hunks };
      continue;
    }
    const header = HUNK.exec(line);
    if (header) {
      if (!current) return null;
      openHunk = [];
      current.hunks.push({ oldStart: Number(header[1]), body: openHunk });
      continue;
    }
    if (line.length === 0) continue;
    return null;
  }
  if (current) sections.push(current);
  return sections;
}

function linesOf(content: string): { readonly lines: readonly string[]; readonly trailingNewline: boolean } {
  if (content === '') return { lines: [], trailingNewline: false };
  const trailingNewline = content.endsWith('\n');
  return { lines: (trailingNewline ? content.slice(0, -1) : content).split('\n'), trailingNewline };
}

/**
 * Applies the hunks for one path to its current bytes. Refuses a context or removal line that does
 * not match the file at its declared position, so a foreign or stale patch never lands.
 */
function applyHunks(source: string | null, hunks: readonly Hunk[]): string {
  const { lines: sourceLines, trailingNewline } = source === null ? { lines: [], trailingNewline: true } : linesOf(source);
  const output: string[] = [];
  let cursor = 0;
  let newlineMarker = false;
  for (const hunk of hunks) {
    const start = source === null && hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (start < cursor || start > sourceLines.length) throw new Error('PATCH_CONTEXT_MISMATCH: hunk start is outside the current file');
    while (cursor < start) output.push(sourceLines[cursor++] as string);
    for (const raw of hunk.body) {
      const marker = raw[0] ?? ' ';
      const text = raw.slice(1);
      if (marker === '\\') {
        newlineMarker = true;
        continue;
      }
      if (marker === ' ' || marker === '-') {
        if (sourceLines[cursor] !== text) throw new Error('PATCH_CONTEXT_MISMATCH: hunk line does not match the current file');
        cursor += 1;
        if (marker === ' ') output.push(text);
      } else if (marker === '+') {
        output.push(text);
      } else {
        throw new Error('PATCH_CONTEXT_MISMATCH: unknown hunk line marker');
      }
    }
  }
  while (cursor < sourceLines.length) output.push(sourceLines[cursor++] as string);
  const finalNewline = source === null ? true : trailingNewline;
  const text = output.join('\n');
  return output.length === 0 ? '' : newlineMarker ? text : finalNewline ? `${text}\n` : text;
}

/** Applies every admitted target path, then reports the measured host revision. */
export async function applyAdmittedPatch(filesystem: WorkspaceFilesystemPort, patch: ApplyPatchAction, maxFileBytes: number): Promise<{ readonly applied: true; readonly newRevisionDigest: string }> {
  const sections = parseSections(patch.patchContent);
  if (!sections || sections.length === 0) throw new Error('PATCH_UNPARSEABLE: the admitted patch is not a unified diff');
  const admitted = new Set(patch.targetPaths);
  const writes: { readonly path: string; readonly content: string }[] = [];
  for (const section of sections) {
    const path = section.newPath ?? section.oldPath;
    if (path === null || !isCanonicalRelativePath(path) || isProtectedPath(path)) throw new Error(`PATCH_PATH_REFUSED: '${path ?? ''}' is not an admitted writable path`);
    if (!admitted.has(path)) throw new Error(`PATCH_PATH_REFUSED: '${path}' is outside the admitted target paths`);
    // A deletion produces an empty result, which this receiver never writes: the agent repairs bytes.
    if (section.newPath === null) throw new Error(`PATCH_DELETION_REFUSED: '${path}' would be deleted`);
    const current = await filesystem.readTextFile(path, maxFileBytes).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    writes.push({ path, content: applyHunks(current, section.hunks) });
  }
  for (const write of writes) await filesystem.writeFile(write.path, write.content, maxFileBytes);
  const newRevisionDigest = await filesystem.getCurrentRevisionDigest(maxFileBytes);
  return { applied: true, newRevisionDigest };
}
