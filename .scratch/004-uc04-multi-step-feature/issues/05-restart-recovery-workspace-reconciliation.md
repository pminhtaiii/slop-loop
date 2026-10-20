# 05: Process Restart Recovery & Workspace Assumption Reconciliation

**What to build:**  
The restart recovery engine in `src/state/reconciliation.ts`. When a new process starts with an existing `taskId`, it loads the latest valid checkpoint, inspects live git status, validates saved assumptions (git HEAD, clean state, file digests), and continues execution from the first non-completed step.

**Blocked by:**  
- 02: Atomic Durable File Store with Concurrency Protection
- 03: Step State Machine & Checkpoint Lifecycle Transitions
- 04: Cumulative Budget Ledger & Two-Phase Reservation Engine

**Status:**  
`completed`

- [x] Implement `captureWorkspaceBaseline(repoRoot)` capturing commit hash, branch, clean status, and changed file digests.
- [x] Implement `reconcileAndResume(taskId, store)`:
  - Load latest checkpoint from `DurableStore`.
  - Validate workspace baseline against live repository. Throw `WorkspaceDriftError` if altered.
  - Reconcile pending budget reservations.
  - Determine next active step without re-executing steps marked `done`.
- [x] Add integration test suite in `tests/runtime/uc04/restart-recovery.test.ts` verifying recovery across independent process executions.
