import test from 'node:test';
import assert from 'node:assert/strict';
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';

interface SmokeState {
  readonly status: string;
  readonly count: number;
}

test('LangGraph StateGraph compiles and executes a minimal state workflow', async (): Promise<void> => {
  const StateAnnotation = Annotation.Root({
    status: Annotation<string>(),
    count: Annotation<number>(),
  });

  const workflow = new StateGraph(StateAnnotation)
    .addNode('increment', (state: SmokeState): Partial<SmokeState> => ({
      status: 'processed',
      count: state.count + 1,
    }))
    .addEdge(START, 'increment')
    .addEdge('increment', END);

  const app = workflow.compile();
  const initial: SmokeState = { status: 'initial', count: 0 };
  const result = await app.invoke(initial);

  assert.equal(result.status, 'processed');
  assert.equal(result.count, 1);
});
