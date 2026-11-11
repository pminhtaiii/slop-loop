import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateGraph, Annotation, interrupt, Command } from '@langchain/langgraph';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableCheckpointSaver } from '../../../src/persistence/adapters/langgraph-saver.ts';

test('UC-04: DurableCheckpointSaver for LangGraph', async t => {
  let tempBase: string;
  let store: DurableStore;

  t.beforeEach(async () => {
    tempBase = await mkdtemp(join(tmpdir(), 'uc04-langgraph-test-'));
    store = new DurableStore(tempBase);
    await store.init();
  });

  t.afterEach(async () => {
    await rm(tempBase, { recursive: true, force: true });
  });

  await t.test('compiles into StateGraph and saves checkpoints durably', async () => {
    const saver = new DurableCheckpointSaver(store);

    const State = Annotation.Root({
      count: Annotation<number>({
        reducer: (curr, update) => curr + update,
        default: () => 0,
      }),
    });

    const builder = new StateGraph(State)
      .addNode('step1', () => ({ count: 1 }))
      .addNode('step2', () => ({ count: 2 }))
      .addEdge('__start__', 'step1')
      .addEdge('step1', 'step2')
      .addEdge('step2', '__end__');

    const graph = builder.compile({ checkpointer: saver });
    const config = { configurable: { thread_id: 'thread-basic-1' } };

    const result = await graph.invoke({ count: 10 }, config);
    assert.equal(result.count, 13, 'Expected accumulated count: 10 + 1 + 2 = 13');

    // Verify checkpoint tuple exists
    const tuple = await saver.getTuple(config);
    assert.ok(tuple, 'Checkpoint tuple must exist');
    assert.equal((tuple.checkpoint.channel_values as Record<string, unknown>).count, 13);
  });

  await t.test('simulates process restart: fresh checkpointer instance resumes interrupted graph', async () => {
    const threadId = 'thread-restart-test';
    const config = { configurable: { thread_id: threadId } };

    const State = Annotation.Root({
      status: Annotation<string>({
        reducer: (_curr, update) => update,
        default: () => 'init',
      }),
      approvedBy: Annotation<string>({
        reducer: (_curr, update) => update,
        default: () => '',
      }),
    });

    const builder = new StateGraph(State)
      .addNode('step1', () => ({ status: 'waiting_for_approval' }))
      .addNode('approval_gate', () => {
        const feedback = interrupt('Awaiting human sign-off');
        return {
          status: 'resumed',
          approvedBy: String(feedback),
        };
      })
      .addNode('final_step', s => ({
        status: `completed_by_${s.approvedBy}`,
      }))
      .addEdge('__start__', 'step1')
      .addEdge('step1', 'approval_gate')
      .addEdge('approval_gate', 'final_step')
      .addEdge('final_step', '__end__');

    // --- PROCESS 1: Run graph until human interrupt ---
    const saverProcess1 = new DurableCheckpointSaver(store);
    const graphProcess1 = builder.compile({ checkpointer: saverProcess1 });

    const interruptedResult = await graphProcess1.invoke({ status: 'started' }, config);
    assert.equal(interruptedResult.status, 'waiting_for_approval');
    assert.ok((interruptedResult as Record<string, unknown>).__interrupt__, 'Interrupt event must be present');

    // Confirm state has paused at approval_gate
    const pausedState = await graphProcess1.getState(config);
    assert.deepEqual(pausedState.next, ['approval_gate']);

    // --- PROCESS 2: Fresh saver instance from disk, fresh graph compile ---
    const saverProcess2 = new DurableCheckpointSaver({ baseDir: join(tempBase, 'langgraph') });
    const graphProcess2 = builder.compile({ checkpointer: saverProcess2 });

    // Verify fresh checkpointer sees the interrupted state from disk
    const resumedStateBefore = await graphProcess2.getState(config);
    assert.deepEqual(resumedStateBefore.next, ['approval_gate']);

    // Resume execution with operator feedback
    const finalResult = await graphProcess2.invoke(new Command({ resume: 'Operator Thanh Tan' }), config);

    assert.equal(finalResult.status, 'completed_by_Operator Thanh Tan');
    assert.equal(finalResult.approvedBy, 'Operator Thanh Tan');

    // Verify terminal state
    const terminalState = await graphProcess2.getState(config);
    assert.deepEqual(terminalState.next, []);
  });

  await t.test('list and deleteThread operate faithfully against persistent storage', async () => {
    const saver = new DurableCheckpointSaver(store);

    const State = Annotation.Root({
      val: Annotation<string>({
        reducer: (_c, u) => u,
        default: () => '',
      }),
    });

    const builder = new StateGraph(State)
      .addNode('nodeA', () => ({ val: 'done' }))
      .addEdge('__start__', 'nodeA')
      .addEdge('nodeA', '__end__');

    const graph = builder.compile({ checkpointer: saver });
    await graph.invoke({ val: 'x' }, { configurable: { thread_id: 'thread-list-1' } });
    await graph.invoke({ val: 'y' }, { configurable: { thread_id: 'thread-list-2' } });

    // List all
    const allTuples: unknown[] = [];
    for await (const tuple of saver.list({})) {
      allTuples.push(tuple);
    }
    assert.ok(allTuples.length >= 2, 'Should list checkpoints for both threads');

    // Delete thread-list-1
    await saver.deleteThread('thread-list-1');
    const tupleAfterDelete = await saver.getTuple({ configurable: { thread_id: 'thread-list-1' } });
    assert.equal(tupleAfterDelete, undefined, 'Deleted thread must return undefined');

    // Fresh instance should also see thread-list-1 deleted
    const freshSaver = new DurableCheckpointSaver(store);
    const freshTuple = await freshSaver.getTuple({ configurable: { thread_id: 'thread-list-1' } });
    assert.equal(freshTuple, undefined, 'Deleted thread must remain deleted in fresh instance');
  });

  await t.test('putWrites preserves MemorySaver JSON-formatted pending writes across instances', async () => {
    const saver1 = new DurableCheckpointSaver(store);
    const threadId = 'thread-writes-json-1';
    const config = { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'cp-01' } };

    // Initialize checkpoint
    await saver1.put(
      config,
      {
        v: 1,
        id: 'cp-01',
        ts: new Date().toISOString(),
        channel_values: { count: 1 },
        channel_versions: { count: 1 },
        versions_seen: {},
      },
      { source: 'input', step: 1, parents: {} },
    );

    // Call putWrites
    await saver1.putWrites(config, [['count', 2]], 'task-write-01');

    // Create fresh instance from disk
    const saver2 = new DurableCheckpointSaver(store);
    const tuple = await saver2.getTuple(config);
    assert.ok(tuple, 'Checkpoint tuple must be restored');
    assert.ok(tuple.pendingWrites, 'Pending writes must be restored');
    assert.ok(tuple.pendingWrites.length > 0, 'Pending writes array must not be empty');
  });
});
