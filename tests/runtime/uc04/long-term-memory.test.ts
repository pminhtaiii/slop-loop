import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LongTermMemoryStore } from '../../../src/memory/long-term-store.ts';

describe('UC-04 Ticket 08: LongTermMemoryStore', () => {
  let tempDir: string;
  let memoryStore: LongTermMemoryStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'slop-memory-test-'));
    memoryStore = new LongTermMemoryStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('supports storing, listing, retrieving, and deleting persistent repository conventions', async () => {
    await memoryStore.set('test_runner', 'Use pytest with -v flag and 10s timeout');
    await memoryStore.set('linter', 'Run ruff check .');

    const value = await memoryStore.get('test_runner');
    assert.equal(value, 'Use pytest with -v flag and 10s timeout');

    const all = await memoryStore.list();
    assert.equal(all.length, 2);

    await memoryStore.delete('linter');
    const remaining = await memoryStore.list();
    assert.equal(remaining.length, 1);
    assert.equal(await memoryStore.get('linter'), null);
  });

  it('enforces that memory is advisory and reconciles with live facts', async () => {
    await memoryStore.set('preferred_formatter', 'black');

    // Codebase fact inspection: repository actually uses 'ruff format'
    const actualRepoFact = 'ruff format';
    const resolved = memoryStore.resolveWithFact(
      'preferred_formatter',
      actualRepoFact
    );

    // Repository fact takes priority over advisory memory
    assert.equal(resolved.effectiveValue, 'ruff format');
    assert.equal(resolved.isOverridden, true);
  });
});
