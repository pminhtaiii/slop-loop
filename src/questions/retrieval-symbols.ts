/** Uses the pinned Python grammar's identifier lexer, including its Unicode continuation tables. */
import { createRequire } from 'node:module';
import type { QuestionIndexedChunkV1 } from '../contracts/questions/contracts.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import type { QuestionIndexFailure } from './index.ts';

export interface RecognizedQuestionSymbols {
  readonly status: 'ok';
  readonly simple: ReadonlySet<string>;
  readonly qualified: ReadonlySet<string>;
  readonly identifiers: readonly string[];
}
export async function recognizeQuestionSymbols(
  query: string,
  chunks: readonly QuestionIndexedChunkV1[],
  control: QuestionRepositoryOperationControl,
): Promise<RecognizedQuestionSymbols | QuestionIndexFailure> {
  const stopped = (): QuestionIndexFailure | undefined =>
    control.signal.aborted ? { status: 'cancelled', reasonCode: 'cancelled' } : Date.now() >= control.deadlineEpochMs ? { status: 'exhausted', reasonCode: 'deadline' } : undefined;
  const before = stopped();
  if (before) return before;
  try {
    const { Parser, Language } = await import('web-tree-sitter');
    await Parser.init();
    const grammar = await Language.load(createRequire(import.meta.url).resolve('@repomix/tree-sitter-wasms/out/tree-sitter-python.wasm'));
    const after = stopped();
    if (after) return after;
    const parser = new Parser();
    parser.setLanguage(grammar);
    try {
      const identifier = (name: string): boolean => {
        const tree = parser.parse(`${name} = None\n`, null, { progressCallback: () => !!stopped() });
        try {
          const expression = tree?.rootNode.namedChildren[0];
          const assignment = expression?.namedChildren[0];
          const left = assignment?.childForFieldName('left');
          return !!tree && !tree.rootNode.hasError && left?.type === 'identifier' && left.text === name;
        } finally {
          tree?.delete();
        }
      };
      const continuation = new Map<string, boolean>();
      const tokens: string[] = [];
      let run = '';
      const flush = () => {
        const name = run.replace(/^\.+|\.+$/g, '');
        run = '';
        if (name && name.split('.').every(identifier)) tokens.push(name);
      };
      for (const point of query) {
        const stop = stopped();
        if (stop) return stop;
        let accepted = continuation.get(point);
        if (accepted === undefined) {
          accepted = point === '.' || identifier(`_${point}`);
          continuation.set(point, accepted);
        }
        if (accepted) run += point;
        else flush();
      }
      flush();
      const final = stopped();
      if (final) return final;
      const simpleNames = new Set(chunks.filter(chunk => chunk.kind === 'definition').map(chunk => chunk.symbolName));
      const qualifiedNames = new Set(chunks.filter(chunk => chunk.kind === 'definition').map(chunk => chunk.qualifiedSymbolName));
      const simple = new Set<string>(),
        qualified = new Set<string>();
      for (const token of tokens) {
        if (token.includes('.')) {
          if (qualifiedNames.has(token)) qualified.add(token);
        } else if (simpleNames.has(token)) simple.add(token);
      }
      return { status: 'ok', simple, qualified, identifiers: Object.freeze([...new Set(tokens)]) };
    } finally {
      parser.delete();
    }
  } catch {
    return stopped() ?? { status: 'unavailable', reasonCode: 'store-unavailable' };
  }
}
