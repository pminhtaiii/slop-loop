import { createRequire } from 'node:module';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { QuestionIndexedChunkV1, QuestionIndexedFileV1, QuestionRetrievalOmissionReasonV1, RepositoryBindingV1, RepositoryToolFailureV1 } from '../contracts/questions/contracts.ts';
import { validateQuestionIndexedFile } from '../contracts/questions/validation.ts';
import { computeFileDigest } from '../foundation/docker-workspace-policy.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import type { QuestionEmbeddingInput, QuestionEmbeddingPort } from './embedding.ts';
import type { QuestionRepositoryPort } from './repository.ts';

type FileIdentity = Pick<QuestionIndexedFileV1, 'path' | 'fileType' | 'originalByteDigest'>;
interface Range {
  readonly startLine: number;
  readonly endLine: number;
}
type Definition = Range & { readonly name: string; readonly qualifiedName: string; readonly node: SyntaxNode };
type Unit = Range & { readonly node?: SyntaxNode };

export interface QuestionChunkSource {
  readonly file: FileIdentity & { readonly lineCount: number };
  readonly binding: RepositoryBindingV1;
  readonly snapshotId: string;
  readonly manifestDigest: string;
  readonly repository: Pick<QuestionRepositoryPort, 'checkBinding' | 'readSpan'>;
  readonly pageLines: number;
  readonly maxSourceBytes: number;
  readonly maxChunks: number;
}

export interface QuestionPreparedChunk {
  readonly metadata: QuestionIndexedChunkV1;
  readonly embeddingInput: QuestionEmbeddingInput;
  readonly tokens: number;
}

export interface QuestionChunkBuild {
  readonly file: QuestionIndexedFileV1;
  readonly chunks: readonly QuestionPreparedChunk[];
}

function sameBinding(left: RepositoryBindingV1, right: RepositoryBindingV1): boolean {
  return left.repositoryId === right.repositoryId && left.workspaceId === right.workspaceId && left.revisionDigest === right.revisionDigest && left.policyDigest === right.policyDigest;
}

function omission(result: RepositoryToolFailureV1): QuestionRetrievalOmissionReasonV1 {
  switch (result.status) {
    case 'stale':
      return 'stale-binding';
    case 'cancelled':
    case 'exhausted':
      return 'budget-exhausted';
    case 'denied':
      return result.reasonCode === 'protected' ? 'protected' : 'unreadable';
    case 'invalid':
      return result.reasonCode === 'line-too-large' ? 'oversized' : 'partial-scan';
    case 'unavailable':
      return result.reasonCode === 'unsupported-adapter' ? 'unavailable' : result.reasonCode;
  }
}

async function guardedLines(source: QuestionChunkSource, control: QuestionRepositoryOperationControl): Promise<string[] | QuestionRetrievalOmissionReasonV1> {
  const { file, repository } = source;
  const lines: string[] = [];
  let bytes = 0;
  for (let startLine = 1; startLine <= file.lineCount;) {
    if (expired(control)) return 'budget-exhausted';
    const endLine = Math.min(file.lineCount, startLine + source.pageLines - 1);
    const result = await repository.readSpan({ path: file.path, startLine, endLine }, control);
    if (expired(control)) return 'budget-exhausted';
    if (result.status !== 'ok') return omission(result);
    const { span } = result;
    if (
      !sameBinding(span.identity.binding, source.binding) ||
      span.snapshotId !== source.snapshotId ||
      span.manifestDigest !== source.manifestDigest ||
      span.path !== file.path ||
      span.originalByteDigest !== file.originalByteDigest ||
      span.excerptDigest !== computeFileDigest(span.excerpt)
    ) {
      return 'stale-binding';
    }
    const page = span.excerpt.split('\n');
    if (
      span.range.startLine !== startLine ||
      span.range.endLine > endLine ||
      (span.range.endLine < endLine && (span.truncation.kind !== 'truncated' || span.truncation.nextLine !== span.range.endLine + 1)) ||
      page.length !== span.range.endLine - startLine + 1 ||
      !span.excerpt.isWellFormed() ||
      span.excerpt.includes('\0') ||
      span.excerpt.includes('\r')
    )
      return 'partial-scan';
    bytes += Buffer.byteLength(span.excerpt) + (startLine === 1 ? 0 : 1);
    if (bytes > source.maxSourceBytes) return 'oversized';
    for (const line of page) lines.push(line);
    startLine = span.range.endLine + 1;
  }
  return lines;
}

function expired(control: QuestionRepositoryOperationControl): boolean {
  return control.signal.aborted || Date.now() >= control.deadlineEpochMs;
}

function range(node: SyntaxNode): Range {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + (node.endPosition.column === 0 ? 0 : 1),
  };
}

function definitions(root: SyntaxNode): Definition[] {
  const found: Definition[] = [];
  const stack: { node: SyntaxNode; parent: string }[] = [{ node: root, parent: '' }];
  while (stack.length) {
    const entry = stack.pop();
    if (!entry) break;
    const { node, parent } = entry;
    const decorated = node.type === 'decorated_definition';
    const target = decorated ? node.childForFieldName('definition') : node;
    if (target?.type === 'function_definition' || target?.type === 'class_definition') {
      const name = target.childForFieldName('name')?.text;
      if (name) {
        const qualifiedName = parent ? `${parent}.${name}` : name;
        found.push({ ...range(node), name, qualifiedName, node });
        const suite = target.childForFieldName('body');
        if (suite) stack.push({ node: suite, parent: qualifiedName });
        continue;
      }
    }
    for (const child of [...node.namedChildren].reverse()) {
      if (child) stack.push({ node: child, parent });
    }
  }
  return found;
}

function moduleRanges(lineCount: number, covered: readonly Range[]): Range[] {
  const gaps: Range[] = [];
  let startLine = 1;
  for (const entry of covered) {
    if (entry.startLine > startLine) gaps.push({ startLine, endLine: entry.startLine - 1 });
    startLine = Math.max(startLine, entry.endLine + 1);
  }
  if (startLine <= lineCount) gaps.push({ startLine, endLine: lineCount });
  return gaps;
}

/** Partition a region by starts of complete statements. Recursion is deferred until an oversized unit needs it. */
function units(node: SyntaxNode, region: Range): Unit[] {
  const target = node.type === 'decorated_definition' ? (node.childForFieldName('definition') ?? node) : node;
  const cuts = new Map<number, SyntaxNode>();
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    for (const child of current.namedChildren) {
      if (!child) continue;
      if (child.type === 'block') {
        for (const statement of child.namedChildren) {
          if (!statement) continue;
          const start = range(statement).startLine;
          if (start > region.startLine && start <= region.endLine) cuts.set(start, statement);
        }
      } else if (child.type.endsWith('_clause')) {
        stack.push(child);
      }
    }
  }
  const starts = [region.startLine, ...[...cuts.keys()].sort((a, b) => a - b)];
  return starts.map((startLine, i) => {
    const endLine = (starts[i + 1] ?? region.endLine + 1) - 1;
    const child = cuts.get(startLine);
    return child ? { startLine, endLine, node: child } : { startLine, endLine };
  });
}

export async function buildQuestionChunks(
  source: QuestionChunkSource,
  embedding: Pick<QuestionEmbeddingPort, 'count' | 'profile'>,
  control: QuestionRepositoryOperationControl,
): Promise<QuestionChunkBuild> {
  const { path, fileType, originalByteDigest, lineCount } = source.file;
  const identity = { path, fileType, originalByteDigest };
  const omissions = new Set<QuestionRetrievalOmissionReasonV1>();
  const chunks: QuestionPreparedChunk[] = [];
  function finish(): QuestionChunkBuild {
    return { file: { ...identity, coverage: omissions.size === 0 ? 'complete' : 'partial', omissionReasons: [...omissions] }, chunks };
  }
  function refuse(reason: QuestionRetrievalOmissionReasonV1): QuestionChunkBuild {
    return { file: { ...identity, coverage: 'excluded', omissionReasons: [reason] }, chunks: [] };
  }
  if (
    ![lineCount, source.pageLines, source.maxSourceBytes, source.maxChunks].every(n => Number.isSafeInteger(n) && n > 0) ||
    !validateQuestionIndexedFile({ ...identity, coverage: 'complete', omissionReasons: [] }).ok
  )
    return refuse('partial-scan');
  if (expired(control)) return refuse('budget-exhausted');
  const before = await source.repository.checkBinding(control);
  if (before.status !== 'ok') return refuse(omission(before));
  if (!sameBinding(before.binding, source.binding)) return refuse('stale-binding');
  const read = await guardedLines(source, control);
  if (typeof read === 'string') return refuse(read);
  const lines = read;

  function emit(region: Range, def: Definition | null, logical: readonly Unit[]): void {
    let partOrder = 0;
    const definitionId = def ? computeFileDigest(JSON.stringify([path, originalByteDigest, def.qualifiedName, def.startLine, def.endLine])) : null;
    const kind = def ? 'definition' : fileType === 'documentation' || fileType === 'configuration' ? fileType : 'module-text';
    function candidate(startLine: number, endLine: number): QuestionPreparedChunk | undefined {
      if (expired(control) || chunks.length >= source.maxChunks || endLine - startLine >= 60) return;
      const excerpt = lines.slice(startLine - 1, endLine).join('\n');
      const normalizedByteLength = Buffer.byteLength(excerpt);
      if (normalizedByteLength > 4096 || normalizedByteLength === 0) return;
      const embeddingInput = { kind: 'passage' as const, text: JSON.stringify({ path, startLine, endLine, symbol: def?.qualifiedName ?? null, excerpt }) };
      const count = embedding.count(embeddingInput, control.signal);
      if (count.status !== 'ok') {
        if (count.status !== 'overflow') omissions.add(count.status === 'cancelled' ? 'budget-exhausted' : 'unavailable');
        return;
      }
      const excerptDigest = computeFileDigest(excerpt);
      const chunkId = computeFileDigest(JSON.stringify([path, originalByteDigest, startLine, endLine, definitionId]));
      return {
        metadata: {
          schemaVersion: 'question-retrieval/1',
          path,
          fileType,
          kind,
          symbolName: def?.name ?? null,
          qualifiedSymbolName: def?.qualifiedName ?? null,
          startLine,
          endLine,
          originalByteDigest,
          excerptDigest,
          normalizedByteLength,
          chunkId,
          vectorId: computeFileDigest(JSON.stringify([chunkId, embedding.profile.id])),
          definition: def && definitionId ? { definitionId, qualifiedName: def.qualifiedName, startLine: def.startLine, endLine: def.endLine, partOrder } : null,
        },
        embeddingInput,
        tokens: count.tokens,
      };
    }
    function save(chunk: QuestionPreparedChunk): void {
      if (chunks.length >= source.maxChunks) omissions.add('budget-exhausted');
      else {
        const { metadata } = chunk;
        chunks.push(metadata.definition ? { ...chunk, metadata: { ...metadata, definition: { ...metadata.definition, partOrder } } } : chunk);
        partOrder++;
      }
    }
    const whole = candidate(region.startLine, region.endLine);
    if (whole) {
      save(whole);
      return;
    }
    let pending: QuestionPreparedChunk | undefined;
    const queue: Unit[] = [...(logical.length ? logical : [region])].reverse();
    while (queue.length > 0) {
      if (expired(control) || chunks.length >= source.maxChunks) {
        omissions.add('budget-exhausted');
        return;
      }
      const unit = queue.pop();
      if (!unit) break;
      const merged = candidate(pending?.metadata.startLine ?? unit.startLine, unit.endLine);
      if (merged) {
        pending = merged;
        continue;
      }
      const standalone = pending ? candidate(unit.startLine, unit.endLine) : undefined;
      if (!standalone && unit.node) {
        const children = units(unit.node, unit);
        if (children.length > 1) {
          for (const child of children.reverse()) queue.push(child);
          continue;
        }
      }
      if (standalone) {
        if (pending) save(pending);
        pending = standalone;
        continue;
      }
      for (let line = unit.startLine; line <= unit.endLine; line++) {
        if (expired(control) || chunks.length >= source.maxChunks) {
          omissions.add('budget-exhausted');
          return;
        }
        const next = candidate(pending?.metadata.startLine ?? line, line);
        if (next) {
          pending = next;
          continue;
        }
        if (pending) save(pending);
        pending = candidate(line, line);
        if (!pending && lines[line - 1]) omissions.add('oversized');
      }
    }
    if (pending) save(pending);
  }

  const python = fileType === 'python-source' || fileType === 'python-test';
  if (python && !expired(control)) {
    const { Parser, Language } = await import('web-tree-sitter');
    await Parser.init();
    const require = createRequire(import.meta.url);
    const grammar = await Language.load(require.resolve('@repomix/tree-sitter-wasms/out/tree-sitter-python.wasm'));
    if (expired(control)) return refuse('budget-exhausted');
    const parser = new Parser();
    try {
      parser.setLanguage(grammar);
      const tree = parser.parse(lines.join('\n'));
      try {
        if (!tree || tree.rootNode.hasError) {
          omissions.add('parse-failure');
          emit({ startLine: 1, endLine: lineCount }, null, []);
        } else {
          const found = definitions(tree.rootNode);
          for (const def of found) {
            if (expired(control) || chunks.length >= source.maxChunks) {
              omissions.add('budget-exhausted');
              break;
            }
            emit(def, def, units(def.node, def));
          }
          for (const gap of moduleRanges(lineCount, found)) emit(gap, null, []);
        }
      } finally {
        tree?.delete();
      }
    } finally {
      parser.delete();
    }
  } else if (!expired(control)) {
    emit({ startLine: 1, endLine: lineCount }, null, []);
  }
  if (expired(control)) return refuse('budget-exhausted');
  const after = await source.repository.checkBinding(control);
  if (expired(control)) return refuse('budget-exhausted');
  if (after.status !== 'ok') return refuse(omission(after));
  if (!sameBinding(after.binding, source.binding)) return refuse('stale-binding');
  return finish();
}
