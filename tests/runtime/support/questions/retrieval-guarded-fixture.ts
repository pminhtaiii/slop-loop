/** Controlled immutable bytes exercised through the actual guarded repository reader. */
import { ControlledRepositoryTools, type ExecutionGuardReadCapability, type GuardedReadOperation, type TrustedFilesystemPort } from '../../../../src/foundation/repository-tools.ts';
import { createQuestionRepositoryPort, type QuestionRepositoryPort } from '../../../../src/questions/repository.ts';
import type { QuestionRetrievalOptions } from '../../../../src/questions/retrieval.ts';

export function guardedRetrievalRepository(
  options: QuestionRetrievalOptions,
  texts: ReadonlyMap<string, string>,
): { readonly repository: QuestionRepositoryPort; readonly reads: readonly string[]; readonly guarded: readonly string[] } {
  const reads: string[] = [];
  const guarded: string[] = [];
  const bindingPort = {
    async checkBinding() {
      return { status: 'ok' as const, binding: options.identity.binding };
    },
    async checkBindingBounded() {
      return { status: 'ok' as const, binding: options.identity.binding };
    },
  };
  const guard: ExecutionGuardReadCapability = {
    provenance: 'mock',
    capabilityId: 'controlled-reader',
    workspaceId: options.identity.binding.workspaceId,
    taskId: options.identity.taskId,
    async mediateRead<T>(operation: GuardedReadOperation<T>): Promise<T> {
      guarded.push(operation.kind);
      return operation.execute();
    },
  };
  const filesystem: TrustedFilesystemPort = {
    provenance: 'mock',
    async stat(path) {
      return { isFile: texts.has(path), isDirectory: path === '' || path === '.', isSymbolicLink: false, size: Buffer.byteLength(texts.get(path) ?? '') };
    },
    async lstat(path) {
      return { isFile: texts.has(path), isDirectory: path === '' || path === '.', isSymbolicLink: false, size: Buffer.byteLength(texts.get(path) ?? '') };
    },
    async realpath(path) {
      return path;
    },
    async readDir() {
      throw new Error('live directory access forbidden');
    },
    async readTextFile() {
      throw new Error('live source access forbidden');
    },
    async getCurrentRevisionDigest() {
      throw new Error('live revision access forbidden');
    },
  };
  const tools = new ControlledRepositoryTools({
    guardCapability: guard,
    fsPort: filesystem,
    limits: { maxExcerptBytes: 4096, maxResultCount: 100 },
    questionIdentity: options.identity,
    questionBindingPort: bindingPort,
    questionLimits: { ...options.repositoryLimits, maxScannedFiles: 1000, maxScannedBytes: 10000000, maxReturnedBytes: 1000000, maxCursors: 10, contextLinesBefore: 1, contextLinesAfter: 1 },
    questionSnapshotPort: { acquireSnapshot: lease, acquireSnapshotBounded: lease },
  });
  async function lease() {
    return {
      snapshot: options.snapshot,
      async readFile(path: string, maxBytes: number) {
        reads.push(path);
        const text = texts.get(path);
        if (text === undefined) return { status: 'unreadable' as const, scannedBytes: 0 };
        const bytes = Buffer.from(text);
        return bytes.length > maxBytes ? { status: 'oversized' as const, scannedBytes: maxBytes + 1 } : { status: 'ok' as const, bytes, scannedBytes: bytes.length };
      },
    };
  }
  return { repository: createQuestionRepositoryPort({ binding: options.identity.binding, reader: tools, bindingPort }), reads, guarded };
}
