# Quickstart and Validation: UC-04

## Current planning validation

Run from the repository root; these commands exist today and do not execute UC-04:

```powershell
node scripts/agents/agent-context.mjs assignment --uc UC-04
node scripts/agents/planning-workflow.mjs validate --dir specs/037-uc04-recovery
node scripts/agents/planning-workflow.mjs status --dir specs/037-uc04-recovery
node scripts/agents/planning-workflow.mjs review-brief --dir specs/037-uc04-recovery --role standards
node scripts/agents/planning-workflow.mjs review-brief --dir specs/037-uc04-recovery --role testability
node scripts/ci/check-context.mjs
git diff --check
```

Assignment can still report `NEEDS_PLANNING` because the delegation map intentionally has no approved UC-04 links. Automated status can say `awaiting-independent-reviews`; it neither certifies reviews nor authorizes implementation. Evaluate each current-artifact independent report with `node scripts/agents/planning-workflow.mjs evaluate-review --review <local-report.md>`. Retain source hashes/report results locally.

## Foundation validation (T001–T012)

Selected persistence adapter: `DurableStore` (`src/persistence/store.ts`) providing atomic file writes, SHA-256 checksum verification, and non-reclaimed file locking per ADR-0007.
Selected test profile: `test-controlled` operating on isolated directory sandboxes.
Exact T012 process restart validation command:

```powershell
node scripts/ci/check-runtime.mjs
node --test tests/runtime/uc04/*.test.ts
node --test tests/runtime/uc04/restart.test.ts
```

T012 drives multi-process crash and restart cycles through `tests/runtime/support/uc04/restart-child.ts` and `tests/runtime/uc04/restart.test.ts`. Across distinct OS processes, abrupt termination retains checkpoints, preserves conservative token reservations, and resumes safely from the first uncompleted step.

Actual test scope verified by `restart.test.ts`:

1. Process 1 (Initialization): Registers a scripted task with baseline workspace commit and sets up durable task storage.
2. Process 2 (Step 1): Executes step 1, consumes tokens, transitions step to done, and commits a durable checkpoint.
3. Process 3 (Step 2 Crash): Claims and reserves tokens for step 2, then simulates an abrupt process crash (exit code 137) before settlement.
4. Process 4 (Recovery & Resume): Spawns a fresh OS process, reloads state from the retained checkpoint, conservatively settles interrupted reservations to prevent budget leakage, reruns step 2 to completion, and validates full workflow completion with accurate consumed token accounting across 4 independent OS process lifecycles.

## Later real integration

T013 requires actual X05-GATE and X03-ADMISSION revisions and profiles. Repeat the approval/claim/effect/drift/restart cases with real shared boundaries. Controlled foundation results cannot satisfy this gate. Integrated feature workflow and cross-task memory are still later G-FEATURE/G-MEMORY work; no hidden production fallback or automatic approval is allowed.
