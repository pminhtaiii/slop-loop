# 02: Atomic Durable File Store with Concurrency Protection

**What to build:**  
A crash-resilient, file-based persistence store in `src/state/durable-store.ts`. All state writes must be atomic using temp file creation, fsync, and rename. Concurrent writes must be prevented via explicit file locks without automatic unsafe reclamation.

**Blocked by:**  
- 01: Data Contracts and Runtime Validation for State & Checkpoints

**Status:**  
`completed`

- [x] Implement `DurableStore` class managing task state and checkpoint files under `.agent-work/state/`.
- [x] Implement `atomicWriteJson(path, data)` ensuring data is completely written and synced before replacing destination.
- [x] Implement `withLock(lockPath, fn)` to serialize operations across workers or checkpointer instances.
- [x] Implement SHA-256 state integrity verification on read.
- [x] Add unit test suite `tests/runtime/uc04/durable-store.test.ts` verifying concurrent access serialization and crash-safety.
