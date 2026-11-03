/**
 * The durable control head is authoritative: only a missing file falls back to the seed. A present
 * but malformed control record must fail closed, never be read as runnable.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DurableStore } from '../../../src/persistence/store.ts';
import { StatePortStore } from '../../../src/persistence/adapters/state-port-v02-storage.ts';
import { DEFAULT_CONTROL } from '../../../src/persistence/adapters/state-port-v02-types.ts';

const taskId = 'task-control';

async function openState(baseDir: string): Promise<StatePortStore> {
  const store = new DurableStore(baseDir);
  await store.init();
  return new StatePortStore(store);
}

async function withState(control: unknown, assertBody: (state: StatePortStore) => Promise<void>): Promise<void> {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-control-'));
  try {
    const state = await openState(baseDir);
    await state.writeJson(state.statePath(taskId, 'control.json'), control);
    await assertBody(state);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

test('durable control record: a missing file still returns the fallback seed', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-control-missing-'));
  try {
    const state = await openState(baseDir);
    assert.deepEqual(await state.readControl(taskId, DEFAULT_CONTROL), DEFAULT_CONTROL);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('durable control record: a null root is refused instead of silently seeding runnable', async () => {
  await withState(null, async state => {
    await assert.rejects(state.readControl(taskId, DEFAULT_CONTROL), /Corrupted UC-03 control record/);
  });
});

test('durable control record: an array root is refused', async () => {
  await withState([], async state => {
    await assert.rejects(state.readControl(taskId, DEFAULT_CONTROL), /Corrupted UC-03 control record/);
  });
});

test('durable control record: a scalar root is refused', async () => {
  await withState('runnable', async state => {
    await assert.rejects(state.readControl(taskId, DEFAULT_CONTROL), /Corrupted UC-03 control record/);
  });
});

test('durable control record: an invalid mode is refused', async () => {
  await withState({ ...DEFAULT_CONTROL, mode: 'bogus' }, async state => {
    await assert.rejects(state.readControl(taskId, DEFAULT_CONTROL), /Corrupted UC-03 control record: invalid mode/);
  });
});

test('durable control record: a valid paused hold is read back unchanged', async () => {
  const held = { ...DEFAULT_CONTROL, mode: 'paused' as const, holdRef: 'hold-1' };
  await withState(held, async state => {
    assert.deepEqual(await state.readControl(taskId, DEFAULT_CONTROL), held);
  });
});
