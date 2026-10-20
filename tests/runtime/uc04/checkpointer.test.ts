import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableFileCheckpointer } from '../../../src/state/checkpointer.ts';
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';

describe('UC-04 Ticket 06: DurableFileCheckpointer for LangGraph', () => {
  let tempDir: string;
  let checkpointer: DurableFileCheckpointer;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'slop-lg-cp-'));
    checkpointer = new DurableFileCheckpointer(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists LangGraph checkpoints to disk across StateGraph steps', async () => {
    const GraphState = Annotation.Root({
      count: Annotation<number>({
        reducer: (x, y) => (y !== undefined ? y : x),
        default: () => 0,
      }),
      log: Annotation<string[]>({
        reducer: (x, y) => x.concat(y),
        default: () => [],
      }),
    });

    const workflow = new StateGraph(GraphState)
      .addNode('step1', (state) => ({ count: state.count + 1, log: ['step1 done'] }))
      .addNode('step2', (state) => ({ count: state.count + 1, log: ['step2 done'] }))
      .addEdge(START, 'step1')
      .addEdge('step1', 'step2')
      .addEdge('step2', END);

    const app = workflow.compile({ checkpointer });
    const config = { configurable: { thread_id: 'thread-01' } };

    const result = await app.invoke({ count: 10 }, config);
    assert.equal(result.count, 12);
    assert.deepEqual(result.log, ['step1 done', 'step2 done']);

    // Check tuple exists in checkpointer
    const tuple = await checkpointer.getTuple(config);
    assert.ok(tuple);
    assert.equal(tuple.checkpoint.channel_values.count, 12);
  });

  it('restores checkpoint from disk into a fresh checkpointer instance (simulating restart)', async () => {
    const GraphState = Annotation.Root({
      step: Annotation<string>({
        reducer: (_, y) => y,
        default: () => 'start',
      }),
    });

    const workflow = new StateGraph(GraphState)
      .addNode('first', () => ({ step: 'first-done' }))
      .addEdge(START, 'first')
      .addEdge('first', END);

    const app1 = workflow.compile({ checkpointer });
    const config = { configurable: { thread_id: 'thread-restart' } };
    await app1.invoke({}, config);

    // Create a new checkpointer instance pointing to the same disk directory
    const freshCheckpointer = new DurableFileCheckpointer(tempDir);
    const restoredTuple = await freshCheckpointer.getTuple(config);

    assert.ok(restoredTuple);
    assert.equal(restoredTuple.checkpoint.channel_values.step, 'first-done');
  });
});
