import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type QuestionRepositorySizeBand = 'small' | 'medium' | 'large';

export interface CreateQuestionRepositoryFixtureOptions {
  readonly band: QuestionRepositorySizeBand;
  readonly seed?: string;
}

export interface QuestionFixtureFile {
  readonly path: string;
  readonly digest: string;
  readonly lineCount: number;
}

export interface QuestionFixtureCanary {
  readonly id: string;
  readonly path: string;
  readonly value: string;
}

export interface QuestionRepositoryFixture {
  readonly root: string;
  readonly band: QuestionRepositorySizeBand;
  readonly seedDigest: string;
  readonly digest: string;
  readonly lineCount: number;
  readonly files: readonly QuestionFixtureFile[];
  readonly canaries: readonly QuestionFixtureCanary[];
  dispose(): Promise<void>;
}

const DEFAULT_SEED = 'question-fixture-v1';
const FIXTURE_PREFIX = 'slop-loop-question-target-';
const BAND_LINE_COUNTS: Readonly<Record<QuestionRepositorySizeBand, number>> = Object.freeze({
  small: 1_000,
  medium: 10_000,
  large: 30_000,
});
const PADDING_LINES_PER_FILE = 500;

const PADDING_BUCKETS = Object.freeze([
  Object.freeze({ directory: 'src/generated', extension: 'py', style: 'python' as const }),
  Object.freeze({ directory: 'tests/fixtures/generated', extension: 'py', style: 'python' as const }),
  Object.freeze({ directory: 'docs/reference', extension: 'md', style: 'markdown' as const }),
  Object.freeze({ directory: 'config/generated', extension: 'toml', style: 'toml' as const }),
]);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lineCount(content: string): number {
  return content.length === 0 ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
}

function source(lines: readonly string[]): string {
  return lines.join('\n') + '\n';
}

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === '' || (pathFromParent !== '..' && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent));
}

function assertSafeOptions(input: unknown): asserts input is CreateQuestionRepositoryFixtureOptions {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Question fixture options must be an object');
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.some(key => key !== 'band' && key !== 'seed')) throw new TypeError('Question fixture accepts only band and seed; judging data is not fixture input');
  if (record['band'] !== 'small' && record['band'] !== 'medium' && record['band'] !== 'large') {
    throw new TypeError('Question fixture band must be small, medium, or large');
  }
  if (record['seed'] !== undefined && (typeof record['seed'] !== 'string' || record['seed'].trim().length === 0 || Buffer.byteLength(record['seed'], 'utf8') > 128)) {
    throw new TypeError('Question fixture seed must be non-empty and at most 128 UTF-8 bytes');
  }
}

function coreFiles(seedDigest: string): { files: Map<string, string>; canaries: QuestionFixtureCanary[] } {
  const canaryPath = 'tests/fixtures/public_canary.py';
  const canaryValue = `SYNTHETIC_SOURCE_CANARY_${seedDigest.slice(0, 16)}`;
  const files = new Map<string, string>([
    [
      'src/orders/api.py',
      source([
        '"""Public order submission entry point."""',
        'from orders.store import append_order',
        'from orders.validation import normalize_order',
        '',
        'def submit_order(payload: dict) -> int:',
        '    """Validate an order, then append it and return its identifier."""',
        '    order = normalize_order(payload)',
        '    return append_order(order)',
      ]),
    ],
    [
      'src/orders/validation.py',
      source([
        '"""Input checks for public order submission."""',
        '',
        'def normalize_order(payload: dict) -> dict:',
        '    if not payload.get("items"):',
        '        raise ValueError("an order needs at least one item")',
        '    return {**payload, "status": "pending"}',
      ]),
    ],
    [
      'src/orders/store.py',
      source([
        '"""In-memory order storage used by the example repository."""',
        'ORDERS: list[dict] = []',
        '',
        'def append_order(order: dict) -> int:',
        '    record = {"id": len(ORDERS) + 1, **order}',
        '    ORDERS.append(record)',
        '    return record["id"]',
      ]),
    ],
    [
      'src/late_definition.py',
      source([
        ...Array.from({ length: 240 }, (_, index) => `# Earlier module note ${String(index + 1).padStart(3, '0')}.`),
        'def retry_window_seconds(attempt: int) -> int:',
        '    """Return a five-second backoff per attempt, capped at thirty seconds."""',
        '    return min(30, attempt * 5)',
      ]),
    ],
    [
      'tests/test_orders.py',
      source([
        'from orders.api import submit_order',
        'from orders.store import ORDERS',
        '',
        'def test_submit_order_stores_pending_order():',
        '    identifier = submit_order({"items": ["book"]})',
        '    assert identifier == ORDERS[-1]["id"]',
        '    assert ORDERS[-1]["status"] == "pending"',
      ]),
    ],
    [
      'docs/architecture.md',
      source([
        '# Order flow',
        '',
        '`submit_order` in `src/orders/api.py` normalizes the payload before it calls storage.',
        'Normalization rejects an empty item list and labels accepted records as pending.',
        'The store appends the record and returns its integer identifier.',
        'The tests exercise this public flow without defining a runtime command.',
      ]),
    ],
    ['pyproject.toml', source(['[project]', 'name = "synthetic-question-target"', 'version = "0.0.0"', 'requires-python = ">=3.11"', '', '[tool.pytest.ini_options]', 'testpaths = ["tests"]'])],
    [canaryPath, source(['"""Public source canary for controlled leak checks."""', `PUBLIC_CANARY = "${canaryValue}"`])],
    ['tests/fixtures/execution_probe.py', source(['from pathlib import Path', 'Path(__file__).with_name("python-executed").touch()'])],
  ]);

  return {
    files,
    canaries: [{ id: 'public-source-canary-v1', path: canaryPath, value: canaryValue }],
  };
}

function addPadding(files: Map<string, string>, targetLineCount: number, seedDigest: string): void {
  const currentLineCount = [...files.values()].reduce((total, content) => total + lineCount(content), 0);
  let remaining = targetLineCount - currentLineCount;
  if (remaining < 0) throw new RangeError('Core question fixture exceeds the selected size band');

  let fileNumber = 0;
  while (remaining > 0) {
    const bucket = PADDING_BUCKETS[fileNumber % PADDING_BUCKETS.length];
    if (!bucket) throw new Error('Question fixture padding bucket is unavailable');
    const linesInFile = Math.min(remaining, PADDING_LINES_PER_FILE);
    const path = `${bucket.directory}/section-${String(fileNumber).padStart(3, '0')}.${bucket.extension}`;
    const lines = Array.from({ length: linesInFile }, (_, lineIndex) => {
      const marker = `${seedDigest.slice(0, 12)}-${String(fileNumber).padStart(3, '0')}-${String(lineIndex + 1).padStart(3, '0')}`;
      if (bucket.style === 'markdown') return `<!-- deterministic question fixture padding ${marker} -->`;
      return `# deterministic question fixture padding ${marker}`;
    });
    files.set(path, source(lines));
    remaining -= linesInFile;
    fileNumber += 1;
  }
}

function fixtureDigest(files: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  for (const [path, content] of [...files.entries()].sort(([left], [right]) => compareText(left, right))) {
    hash.update(path, 'utf8').update('\0', 'utf8').update(content, 'utf8').update('\0', 'utf8');
  }
  return hash.digest('hex');
}

/** Creates a public-only target tree outside the active workspace; no Python is imported or run. */
export async function createQuestionRepositoryFixture(input: CreateQuestionRepositoryFixtureOptions): Promise<QuestionRepositoryFixture> {
  assertSafeOptions(input);

  const band = input.band;
  const seed = input.seed ?? DEFAULT_SEED;
  const seedDigest = sha256(seed);
  const { files, canaries } = coreFiles(seedDigest);
  addPadding(files, BAND_LINE_COUNTS[band], seedDigest);
  const digest = fixtureDigest(files);

  const workspaceRoot = await realpath(process.cwd());
  const tempRoot = await realpath(tmpdir());
  if (isWithin(workspaceRoot, tempRoot)) throw new Error('OS temporary directory must be outside the active workspace');

  const root = await mkdtemp(join(tempRoot, FIXTURE_PREFIX));
  try {
    for (const [path, content] of files) {
      const target = resolve(root, path);
      if (!isWithin(root, target)) throw new Error('Question fixture path escaped its target root');
      await mkdir(resolve(target, '..'), { recursive: true });
      await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
    }

    const actualRoot = await realpath(root);
    if (isWithin(workspaceRoot, actualRoot)) throw new Error('Question fixture target must be isolated from the active workspace');

    let disposed = false;
    const fixtureFiles = [...files.entries()]
      .map(([path, content]) => Object.freeze({ path, digest: sha256(content), lineCount: lineCount(content) }))
      .sort((left, right) => compareText(left.path, right.path));
    return Object.freeze({
      root: actualRoot,
      band,
      seedDigest,
      digest,
      lineCount: fixtureFiles.reduce((total, file) => total + file.lineCount, 0),
      files: Object.freeze(fixtureFiles),
      canaries: Object.freeze(canaries.map(canary => Object.freeze(canary))),
      async dispose() {
        if (disposed) return;
        disposed = true;
        await rm(actualRoot, { recursive: true, force: true });
      },
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw new Error(`Could not create ${band} question repository fixture`, { cause: error });
  }
}
