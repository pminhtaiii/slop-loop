import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import * as sqliteVec from 'sqlite-vec';

test('sqlite-vec writes, ranks, rolls back and reopens a disk database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'question-index-platform-'));
  const path = join(directory, 'index.sqlite');
  const open = () => {
    const database = new DatabaseSync(path, { allowExtension: true });
    sqliteVec.load(database);
    database.enableLoadExtension(false);
    return database;
  };
  const ranks = (database: DatabaseSync) =>
    database
      .prepare('SELECT rowid, vec_distance_cosine(embedding, ?) AS distance FROM chunks ORDER BY distance')
      .all('[1,0]')
      .map(({ rowid, distance }) => [rowid, distance]);
  try {
    {
      const db = open();
      try {
        db.exec('CREATE VIRTUAL TABLE chunks USING vec0(embedding float[2])');
        const insert = db.prepare('INSERT INTO chunks(rowid, embedding) VALUES (?, ?)');
        insert.run(1n, '[0,1]');
        insert.run(2n, '[1,0]');
        assert.deepEqual(ranks(db), [
          [2, 0],
          [1, 1],
        ]);
        db.exec('BEGIN');
        insert.run(3n, '[-1,0]');
        assert.deepEqual(ranks(db), [
          [2, 0],
          [1, 1],
          [3, 2],
        ]);
        db.exec('ROLLBACK');
      } finally {
        db.close();
      }
    }
    using reopened = open();
    assert.deepEqual(ranks(reopened), [
      [2, 0],
      [1, 1],
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
