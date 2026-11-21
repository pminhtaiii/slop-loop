/** SQLite state owner, called only inside the isolated index worker. */
import { chmodSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, relative, isAbsolute, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import * as sqliteVec from 'sqlite-vec';
import type { QuestionIndexedFileV1, QuestionIndexGenerationV1, RetrievalResourceLimitsV1 } from '../contracts/questions/contracts.ts';
import type { IndexCommand, IndexReply, QuestionIndexRow, QuestionIndexPublication } from './index-types.ts';

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

export function openIndexStorage(path: string, roots: readonly string[], limits: RetrievalResourceLimitsV1): (command: IndexCommand) => IndexReply {
  const directory = realpathSync(dirname(path));
  if (directory !== dirname(path) || roots.some(root => inside(realpathSync(root), path))) throw new Error('Unsafe index location');
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const entry = lstatSync(path + suffix, { throwIfNoEntry: false });
    if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)) throw new Error('Unsafe index file');
  }
  const database = new DatabaseSync(path, { allowExtension: true });
  sqliteVec.load(database);
  database.enableLoadExtension(false);
  chmodSync(path, 0o600);
  // Rollback journal plus the database are each bounded by half the disk quota.
  const pages = Math.floor((limits.maxIndexDiskBytes - 8192) / 8192);
  if (pages < 16) throw new Error('Insufficient index disk quota');
  database.exec(
    `PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-${Math.max(1, Math.floor(limits.maxSqliteCacheBytes / 1024))}; PRAGMA max_page_count=${pages}`,
  );
  database.exec(
    'CREATE TABLE IF NOT EXISTS head (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, path TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS staged_files (attempt TEXT NOT NULL, path TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(attempt,path)); CREATE TABLE IF NOT EXISTS staged_chunks (attempt TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(attempt,id));',
  );
  database.exec('CREATE TABLE IF NOT EXISTS writer (id INTEGER PRIMARY KEY CHECK(id=1), attempt TEXT NOT NULL, expires INTEGER NOT NULL)');
  database.exec('CREATE TABLE IF NOT EXISTS integrity (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL)');
  database.exec('CREATE TABLE IF NOT EXISTS publication (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)');
  const contentDigest = () => {
    const hash = createHash('sha256');
    for (const query of ['SELECT id,data FROM head ORDER BY id', 'SELECT path,data FROM files ORDER BY path', 'SELECT id,path,data FROM chunks ORDER BY id']) {
      hash.update(query);
      for (const row of database.prepare(query).iterate()) hash.update(JSON.stringify(row)).update('\n');
    }
    const receipt = database.prepare('SELECT data FROM publication WHERE id=1').get();
    if (receipt) hash.update('publication').update(String(receipt['data']));
    return hash.digest('hex');
  };
  const decode = <T>(value: unknown): T => {
    if (typeof value !== 'string') throw new Error('Corrupt index');
    return JSON.parse(value) as T;
  };
  const head = () => {
    const row = database.prepare('SELECT data FROM head WHERE id=1').get();
    return row ? decode<QuestionIndexGenerationV1>(row['data']) : null;
  };
  const diskBytes = () => ['', '-journal', '-wal', '-shm'].reduce((sum, suffix) => sum + (statSync(path + suffix, { throwIfNoEntry: false })?.size ?? 0), 0);
  const publication = () => {
    const row = database.prepare('SELECT data FROM publication WHERE id=1').get();
    return row ? decode<QuestionIndexPublication>(row['data']) : undefined;
  };
  const empty = () => ({ status: 'ok' as const, generation: head(), files: [], chunks: [], diskBytes: diskBytes(), publication: publication() });
  const fitsMemory = () => {
    const bytes = database.prepare('SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) AS bytes FROM chunks').get()?.['bytes'];
    const fileBytes = database.prepare('SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) AS bytes FROM files').get()?.['bytes'];
    return typeof bytes === 'number' && typeof fileBytes === 'number' && bytes + fileBytes <= limits.maxWorkerMemoryBytes / 8;
  };
  return command => {
    try {
      // Revocation can reclaim an oversized store under the worker's time and memory bounds.
      if (!(command.kind === 'cleanup' && command.revoke) && diskBytes() > limits.maxIndexDiskBytes) return { status: 'exhausted', reasonCode: 'scan-limit' };
      if (command.kind === 'current') return empty();
      if (command.kind === 'begin') {
        const bound = Math.floor((Math.min(command.diskBytes, limits.maxIndexDiskBytes) - 8192) / 8192);
        if (bound < 16 || diskBytes() * 2 + 8192 > command.diskBytes) return { status: 'exhausted', reasonCode: 'scan-limit' };
        database.exec(`PRAGMA max_page_count=${bound}`);
        database.exec('BEGIN IMMEDIATE');
        try {
          const lease = database.prepare('SELECT expires FROM writer WHERE id=1').get();
          if (lease && typeof lease['expires'] === 'number' && lease['expires'] > Date.now()) return { status: 'busy', reasonCode: 'busy' };
          database.exec('DELETE FROM staged_chunks; DELETE FROM staged_files; DELETE FROM writer;');
          database.prepare('INSERT INTO writer VALUES(1,?,?)').run(command.attempt, command.leaseUntil);
          database.exec('COMMIT');
          return empty();
        } finally {
          if (database.isTransaction) database.exec('ROLLBACK');
        }
      }
      if (command.kind === 'inspect') {
        database.exec('BEGIN');
        try {
          const generation = head();
          const count = database.prepare('SELECT count(*) AS count FROM chunks').get()?.['count'];
          if (typeof count !== 'number' || count > command.maxChunks || count > limits.maxChunks) return { status: 'exhausted', reasonCode: 'scan-limit' };
          if (!fitsMemory()) return { status: 'exhausted', reasonCode: 'scan-limit' };
          const files = database
            .prepare('SELECT data FROM files ORDER BY path LIMIT ?')
            .all(limits.maxFiles + 1)
            .map(row => decode<QuestionIndexedFileV1>(row['data']));
          if (files.length > limits.maxFiles) return { status: 'exhausted', reasonCode: 'scan-limit' };
          const chunks = database
            .prepare('SELECT data FROM chunks ORDER BY id')
            .all()
            .map(row => decode<QuestionIndexRow>(row['data']));
          if (generation ? database.prepare('SELECT digest FROM integrity WHERE id=1').get()?.['digest'] !== contentDigest() : files.length !== 0 || chunks.length !== 0)
            return { status: 'unavailable', reasonCode: 'store-unavailable' };
          return { status: 'ok', generation, files, chunks, diskBytes: diskBytes(), publication: publication() };
        } finally {
          database.exec('ROLLBACK');
        }
      }
      if (command.kind === 'stage') {
        if (command.rows.length > limits.maxBatchSize) return { status: 'exhausted', reasonCode: 'scan-limit' };
        if (Buffer.byteLength(JSON.stringify(command.rows)) > limits.maxWorkerMemoryBytes / 8) return { status: 'exhausted', reasonCode: 'scan-limit' };
        database.exec('BEGIN IMMEDIATE');
        try {
          const lease = database.prepare('SELECT attempt,expires FROM writer WHERE id=1').get();
          if (lease?.['attempt'] !== command.attempt || Number(lease['expires']) <= Date.now()) return { status: 'stale', reasonCode: 'binding-mismatch' };
          database.prepare('INSERT OR REPLACE INTO staged_files VALUES (?,?,?)').run(command.attempt, command.file.path, JSON.stringify(command.file));
          const insert = database.prepare('INSERT INTO staged_chunks VALUES (?,?,?,?)');
          for (const row of command.rows) insert.run(command.attempt, row.metadata.chunkId, row.metadata.path, JSON.stringify(row));
          const count = database.prepare('SELECT count(*) AS count FROM staged_chunks').get()?.['count'];
          if (typeof count !== 'number' || count > limits.maxChunks) throw new Error('Index stage quota');
          database.exec('COMMIT');
          return empty();
        } finally {
          if (database.isTransaction) database.exec('ROLLBACK');
        }
      }
      if (command.kind === 'publish') {
        database.exec('BEGIN IMMEDIATE');
        try {
          if (head()?.generationId !== (command.expected ?? undefined)) return { status: 'stale', reasonCode: 'binding-mismatch' };
          const lease = database.prepare('SELECT attempt,expires FROM writer WHERE id=1').get();
          if (lease?.['attempt'] !== command.attempt || Number(lease['expires']) <= Date.now()) return { status: 'stale', reasonCode: 'binding-mismatch' };
          if (!command.reuse) {
            const changed = database
              .prepare('SELECT path FROM staged_files WHERE attempt=?')
              .all(command.attempt)
              .map(row => String(row['path']));
            const retained = new Set(command.paths);
            for (const row of database.prepare('SELECT path FROM files').all()) {
              const path = String(row['path']);
              if (!retained.has(path) || changed.includes(path)) {
                database.prepare('DELETE FROM chunks WHERE path=?').run(path);
                database.prepare('DELETE FROM files WHERE path=?').run(path);
              }
            }
            database.prepare('INSERT INTO files SELECT path,data FROM staged_files WHERE attempt=?').run(command.attempt);
            database.prepare('INSERT INTO chunks SELECT id,path,data FROM staged_chunks WHERE attempt=?').run(command.attempt);
          }
          if (!fitsMemory()) return { status: 'exhausted', reasonCode: 'scan-limit' };
          database.prepare('INSERT OR REPLACE INTO head VALUES(1,?)').run(JSON.stringify(command.generation));
          database
            .prepare('INSERT OR REPLACE INTO publication VALUES(1,?)')
            .run(JSON.stringify({ operationId: command.operationId, expectedGenerationId: command.expected, generation: command.generation }));
          database.prepare('INSERT OR REPLACE INTO integrity VALUES(1,?)').run(contentDigest());
          database.prepare('DELETE FROM staged_files WHERE attempt=?').run(command.attempt);
          database.prepare('DELETE FROM staged_chunks WHERE attempt=?').run(command.attempt);
          database.prepare('DELETE FROM writer WHERE attempt=?').run(command.attempt);
          database.exec('COMMIT');
          return empty();
        } finally {
          if (database.isTransaction) database.exec('ROLLBACK');
        }
      }
      database.exec('BEGIN IMMEDIATE');
      try {
        if (command.revoke)
          database.exec(
            'DELETE FROM head; DELETE FROM chunks; DELETE FROM files; DELETE FROM staged_chunks; DELETE FROM staged_files; DELETE FROM writer; DELETE FROM integrity; DELETE FROM publication;',
          );
        else if (command.attempt === null) database.exec('DELETE FROM staged_chunks; DELETE FROM staged_files;');
        else {
          database.prepare('DELETE FROM staged_chunks WHERE attempt=?').run(command.attempt);
          database.prepare('DELETE FROM staged_files WHERE attempt=?').run(command.attempt);
          database.prepare('DELETE FROM writer WHERE attempt=?').run(command.attempt);
        }
        database.exec('COMMIT');
        if (command.revoke || command.attempt === null) database.exec('VACUUM');
        if (command.revoke && diskBytes() > limits.maxIndexDiskBytes) return { status: 'exhausted', reasonCode: 'scan-limit' };
        return empty();
      } finally {
        if (database.isTransaction) database.exec('ROLLBACK');
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'errcode' in error ? error.errcode : undefined;
      return code === 5 || code === 6
        ? { status: 'busy', reasonCode: 'busy' }
        : code === 13
          ? { status: 'exhausted', reasonCode: 'scan-limit' }
          : { status: 'unavailable', reasonCode: 'store-unavailable' };
    }
  };
}
