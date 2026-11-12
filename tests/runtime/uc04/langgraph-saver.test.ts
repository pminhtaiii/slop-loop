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

  await t.test('deleteThread is properly coordinated with pending persist tasks', async () => {
    const saver = new DurableCheckpointSaver(store);
    const threadId = 'thread-delete-coord-1';
    const config = { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'cp-01' } };

    // Fire put and deleteThread back-to-back without awaiting put first
    const putPromise = saver.put(
      config,
      {
        v: 1,
        id: 'cp-01',
        ts: new Date().toISOString(),
        channel_values: { val: 42 },
        channel_versions: { val: 1 },
        versions_seen: {},
      },
      { source: 'input', step: 1, parents: {} },
    );

    const deletePromise = saver.deleteThread(threadId);
    await Promise.all([putPromise, deletePromise]);

    // Check thread is deleted in current saver
    const tuple = await saver.getTuple(config);
    assert.equal(tuple, undefined, 'Deleted thread must return undefined');

    // Fresh saver instance must also see thread as deleted (not resurrected by trailing persist)
    const freshSaver = new DurableCheckpointSaver(store);
    const freshTuple = await freshSaver.getTuple(config);
    assert.equal(freshTuple, undefined, 'Fresh saver must confirm thread remains deleted');
  });

  await t.test('concurrent restore operations are safely serialized', async () => {
    const saver1 = new DurableCheckpointSaver(store);
    const threadId = 'thread-restore-concurrent-1';
    const config = { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'cp-c1' } };

    await saver1.put(
      config,
      {
        v: 1,
        id: 'cp-c1',
        ts: new Date().toISOString(),
        channel_values: { status: 'ready' },
        channel_versions: { status: 1 },
        versions_seen: {},
      },
      { source: 'input', step: 1, parents: {} },
    );

    // Create fresh instance and invoke concurrent restores/reads
    const saver2 = new DurableCheckpointSaver(store);
    const results = await Promise.all([saver2.getTuple(config), saver2.getTuple(config), saver2.getTuple(config)]);

    for (const res of results) {
      assert.ok(res);
      assert.equal(res.checkpoint.id, 'cp-c1');
    }
  });

  await t.test('serializes checkpoint updates across distinct saver instances on the same thread', async () => {
    const threadId = 'thread-cross-instance-1';
    const config1 = { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'cp-inst-1' } };
    const config2 = { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'cp-inst-2' } };

    const saverA = new DurableCheckpointSaver(store);
    const saverB = new DurableCheckpointSaver(store);

    // saverA saves checkpoint 1
    await saverA.put(
      config1,
      {
        v: 1,
        id: 'cp-inst-1',
        ts: new Date().toISOString(),
        channel_values: { step: 1 },
        channel_versions: { step: 1 },
        versions_seen: {},
      },
      { source: 'input', step: 1, parents: {} },
    );

    // saverB saves checkpoint 2 on the same thread
    await saverB.put(
      config2,
      {
        v: 1,
        id: 'cp-inst-2',
        ts: new Date().toISOString(),
        channel_values: { step: 2 },
        channel_versions: { step: 2 },
        versions_seen: {},
      },
      { source: 'loop', step: 2, parents: {} },
    );

    // saverA reloads and gets latest tuple - should see saverB's checkpoint 2
    const tupleA = await saverA.getTuple({ configurable: { thread_id: threadId } });
    assert.ok(tupleA);
    assert.equal(tupleA.checkpoint.id, 'cp-inst-2');

    // Verify all checkpoints exist in saverA list
    const tuplesList: unknown[] = [];
    for await (const t of saverA.list({ configurable: { thread_id: threadId } })) {
      tuplesList.push(t);
    }
    assert.equal(tuplesList.length, 2, 'Both checkpoints from saverA and saverB must be retained');
  });

  await t.test('two-saver delete regression: clearing cache when thread is deleted by another instance', async () => {
    const threadId = 'thread-two-saver-del-1';
    const config = { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'cp-del-1' } };

    const saverA = new DurableCheckpointSaver(store);
    const saverB = new DurableCheckpointSaver(store);

    // saverA creates checkpoint
    await saverA.put(
      config,
      {
        v: 1,
        id: 'cp-del-1',
        ts: new Date().toISOString(),
        channel_values: { count: 100 },
        channel_versions: { count: 1 },
        versions_seen: {},
      },
      { source: 'input', step: 1, parents: {} },
    );

    // saverB loads thread into its memory
    const tupleBBefore = await saverB.getTuple(config);
    assert.ok(tupleBBefore);
    assert.equal(tupleBBefore.checkpoint.id, 'cp-del-1');

    // saverA deletes thread
    await saverA.deleteThread(threadId);

    // saverB gets tuple - must return undefined and clear its cache
    const tupleBAfter = await saverB.getTuple(config);
    assert.equal(tupleBAfter, undefined, 'saverB must observe deletion and clear cached data');

    // saverB lists all threads - deleted thread must not be listed
    const allListed: unknown[] = [];
    for await (const t of saverB.list({})) {
      allListed.push(t);
    }
    const matchingDeleted = allListed.filter(t => (t as { config?: { configurable?: { thread_id?: string } } }).config?.configurable?.thread_id === threadId);
    assert.equal(matchingDeleted.length, 0, 'Deleted thread must not appear in saverB all-thread list');
  });

  await t.test('preserves undefined parentConfig for root checkpoints across disk reloads', async () => {
    const threadId = 'thread-root-cp-1';
    const config = { configurable: { thread_id: threadId, checkpoint_ns: '' } };
    const saver1 = new DurableCheckpointSaver(store);

    // Save root checkpoint (no parent in config)
    await saver1.put(
      config,
      {
        v: 1,
        id: 'cp-root-01',
        ts: new Date().toISOString(),
        channel_values: { count: 0 },
        channel_versions: { count: 1 },
        versions_seen: {},
      },
      { source: 'input', step: 1, parents: {} },
    );

    // Restore via a fresh saver instance from disk
    const saver2 = new DurableCheckpointSaver(store);
    const restored = await saver2.getTuple(config);
    assert.ok(restored, 'Checkpoint must be restored');
    assert.equal(restored.parentConfig, undefined, 'Root checkpoint must have undefined parentConfig, not checkpoint_id: null');
  });

  await t.test('persists and restores task writes incrementally across multiple tasks', async () => {
    const threadId = 'thread-multi-task-writes-1';
    const config = { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'cp-w-1' } };
    const saver1 = new DurableCheckpointSaver(store);

    await saver1.put(
      config,
      {
        v: 1,
        id: 'cp-w-1',
        ts: new Date().toISOString(),
        channel_values: { a: 1, b: 2 },
        channel_versions: { a: 1, b: 1 },
        versions_seen: {},
      },
      { source: 'input', step: 1, parents: {} },
    );

    // Write from taskA and taskB
    await saver1.putWrites(config, [['a', 10]], 'task-A');
    await saver1.putWrites(config, [['b', 20]], 'task-B');

    // Fresh saver instance from disk must see pending writes for both tasks
    const saver2 = new DurableCheckpointSaver(store);
    const restored = await saver2.getTuple(config);
    assert.ok(restored);
    assert.ok(restored.pendingWrites);
    assert.equal(restored.pendingWrites.length, 2, 'Pending writes from both taskA and taskB must be restored');
  });
});
