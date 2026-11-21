/**
 * The real-tier production patch receiver.
 *
 * Applies an admitted, already-validated patch to the bound host repository through the existing
 * `WorkspaceFilesystemPort`, then reports the measured host revision so the settled-patch hook can
 * mirror it into the volume. It writes only the admitted target paths, refuses a protected or
 * content-excluded path, refuses a path whose parent is not a real directory, and refuses a hunk
 * whose context does not match the current bytes (a patch that is not this file's patch).
 *
 * The whole patch is parsed, validated and computed before any write: every section is checked
 * (form, size, path, context, deletion), every output byte is produced in memory, and only then are
 * all targets committed by staging each file and renaming. A failure anywhere restores the originals,
 * so no earlier write survives. The receiver performs the write only; the caller still measures,
 * settles and mirrors.
 */
import { isCanonicalRelativePath, isProtectedPath } from '../contracts/foundation/uc03.ts';
import type { ApplyPatchAction } from '../contracts/foundation/uc03.ts';
import { containsProtectedContent } from '../foundation/docker-workspace-policy.ts';
import type { WorkspaceFilesystemPort } from '../foundation/host-filesystem-port.ts';

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

interface Hunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newCount: number;
  /** Filled as the body is parsed, then treated as immutable by `applyHunks`. */
  readonly body: string[];
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

/**
 * Every file section of one unified diff, in order, with each hunk's raw body lines. A hunk body is
 * bounded by its header's line counts, so a following `--- ` file header is never swallowed as a
 * removal line, and a body that does not reach its declared counts is malformed.
 */
function parseSections(diff: string): FileHunks[] | null {
  const sections: FileHunks[] = [];
  let oldPath: string | null = null;
  let current: { oldPath: string | null; newPath: string | null; hunks: Hunk[] } | null = null;
  let open: { readonly hunk: Hunk; readonly oldCount: number; readonly newCount: number } | null = null;
  let oldSeen = 0;
  let newSeen = 0;
  const lines = diff.split('\n');
  for (const line of lines) {
    if (open !== null) {
      const marker = line[0];
      if (marker === '\\') continue;
      const advancesOld = marker === ' ' || marker === '-';
      const advancesNew = marker === ' ' || marker === '+';
      if (advancesOld || advancesNew) {
        if (advancesOld) oldSeen += 1;
        if (advancesNew) newSeen += 1;
        if (oldSeen > open.oldCount || newSeen > open.newCount) return null;
        open.hunk.body.push(line);
        if (oldSeen === open.oldCount && newSeen === open.newCount) open = null;
        continue;
      }
      // A body that ends early is malformed; the section headers below are parsed from the same line.
      if (oldSeen !== open.oldCount || newSeen !== open.newCount) return null;
      open = null;
    }
    if (line.startsWith('--- ')) {
      if (current) sections.push(current);
      oldPath = diffPath(line.slice(4), 'a/');
      current = { oldPath, newPath: null, hunks: [] };
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (!current) return null;
      // The explicit null destination of a deletion is kept so the deletion refusal sees it first.
      current = { oldPath, newPath: diffPath(line.slice(4), 'b/'), hunks: current.hunks };
      continue;
    }
    const header = HUNK.exec(line);
    if (header) {
      if (!current) return null;
      const oldCount = header[2] === undefined ? 1 : Number(header[2]);
      const newCount = header[4] === undefined ? 1 : Number(header[4]);
      const hunk: Hunk = { oldStart: Number(header[1]), oldCount, newCount, body: [] };
      current.hunks.push(hunk);
      oldSeen = 0;
      newSeen = 0;
      open = { hunk, oldCount, newCount };
      continue;
    }
    if (line.length === 0) continue;
    // A `\ No newline at end of file` marker follows the hunk line it annotates, so it can trail a closed hunk.
    if (line.startsWith('\\') && current !== null && current.hunks.length > 0) continue;
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

interface PlannedWrite {
  readonly path: string;
  readonly content: string;
  /** The bytes currently on disk, restored if a later commit step fails; undefined for a new file. */
  readonly original: string | undefined;
}

/**
 * Validates every section of one patch without any effect, then returns the complete set of writes.
 * A malformed section (no destination, a `/dev/null` destination, a missing hunk, a size over the
 * bound, a protected or content-excluded target, an unadmitted path) refuses the whole patch here.
 */
async function planWrites(filesystem: WorkspaceFilesystemPort, patch: ApplyPatchAction, maxFileBytes: number): Promise<PlannedWrite[]> {
  const sections = parseSections(patch.patchContent);
  if (!sections || sections.length === 0) throw new Error('PATCH_UNPARSEABLE: the admitted patch is not a unified diff');
  const admitted = new Set(patch.targetPaths);
  const writes: PlannedWrite[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    // A deletion names its source but a `/dev/null` destination: keep it distinct from a rename or edit.
    if (section.newPath === null) throw new Error(`PATCH_DELETION_REFUSED: '${section.oldPath ?? ''}' would be deleted`);
    const path = section.newPath;
    if (!isCanonicalRelativePath(path) || isProtectedPath(path)) throw new Error(`PATCH_PATH_REFUSED: '${path}' is not an admitted writable path`);
    if (!admitted.has(path)) throw new Error(`PATCH_PATH_REFUSED: '${path}' is outside the admitted target paths`);
    if (seen.has(path)) throw new Error(`PATCH_PATH_REFUSED: '${path}' appears in more than one section`);
    seen.add(path);
    if (section.hunks.length === 0) throw new Error(`PATCH_UNPARSEABLE: '${path}' has no hunks`);
    let current: string | null;
    try {
      current = await filesystem.readTextFile(path, maxFileBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      current = null;
    }
    // The same content exclusions the workspace mirror and view builder apply: a file whose current
    // bytes would be excluded from a command view is never rewritten by a patch.
    if (current !== null && containsProtectedContent(current)) throw new Error(`PATCH_PATH_REFUSED: '${path}' contains protected content`);
    const content = applyHunks(current, section.hunks);
    if (Buffer.byteLength(content, 'utf8') > maxFileBytes) throw new Error(`FILE_TOO_LARGE: '${path}' exceeds its byte limit`);
    if (containsProtectedContent(content)) throw new Error(`PATCH_PATH_REFUSED: '${path}' would introduce protected content`);
    writes.push({ path, content, original: current ?? undefined });
  }
  return writes;
}

/** Applies every admitted target path atomically, then reports the measured host revision. */
export async function applyAdmittedPatch(filesystem: WorkspaceFilesystemPort, patch: ApplyPatchAction, maxFileBytes: number): Promise<{ readonly applied: true; readonly newRevisionDigest: string }> {
  // Every validation and every output byte is computed before the first write.
  const writes = await planWrites(filesystem, patch, maxFileBytes);
  const committed: PlannedWrite[] = [];
  try {
    for (const write of writes) {
      await filesystem.writeFile(write.path, write.content, maxFileBytes);
      committed.push(write);
    }
  } catch (error) {
    // Restore every already-written file to its original bytes (or remove a newly created one).
    for (const done of committed.reverse()) {
      if (done.original === undefined) await filesystem.removeFile(done.path);
      else await filesystem.writeFile(done.path, done.original, maxFileBytes);
    }
    throw error;
  }
  const newRevisionDigest = await filesystem.getCurrentRevisionDigest(maxFileBytes);
  return { applied: true, newRevisionDigest };
}
