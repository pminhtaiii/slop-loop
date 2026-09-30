# Quickstart: Validate the Task Domain and Orchestrator

This guide describes validation for the Phase 1 source core. The Phase 0 runtime is present in this checkout; the combined pinned-manager gate passed on 2026-09-28 after the LF checkout fix.

## Prerequisites

1. Confirm the Phase 0 source and completed status in `coding-agent-context/context/progress-checker.md`. Its standalone Ubuntu and Windows CI gates passed before the merge into this checkout.
2. Make the pinned pnpm version from `package.json` available, install with a frozen lockfile, and run the full gate on the combined branch before calling Phase 1 integration-ready.
3. Use the approved `feat/002-task-domain-orchestrator` branch in the current checkout for Phase 1 source changes.

## Focused scenarios

Run the focused source tests under `tests/orchestration/`:

```text
pnpm exec vitest run tests/orchestration/task.test.ts
pnpm exec vitest run tests/orchestration/transitions.test.ts
pnpm exec vitest run tests/orchestration/budget.test.ts
pnpm exec vitest run tests/orchestration/runner.test.ts
pnpm exec vitest run tests/orchestration/runner.e2e.test.ts
```

Expected behavior:

- Both Ask and Edit scripts traverse only graph-legal states. Direct `RECEIVED → IMPLEMENTING` ends `FAILED / INVALID_TRANSITION` without entering `IMPLEMENTING`.
- Invalid model proposals are refused and consume one model turn; the task may continue within its model-turn budget.
- Model turns and individually dispatched tool attempts have separate Small/Medium/Large limits. Capacity promotion raises only those limits and preserves cumulative usage; retries remain bounded by the initial profile.
- A simulated 1,800-second active-work limit ends the task with typed budget evidence. Permission waits do not add to active-work time.
- A same-task mode-change request returns `TASK_MODE_FIXED` and preserves the task mode and lifecycle state.
- Cancellation, blocking, failure, completion, and no-change completion are distinct; terminal replay preserves the first outcome.
- Changed-file completion requires a scripted trusted passing-verification event for the current change attempt. Repair and Edit resumption invalidate earlier passing evidence. The test asserts only the contract, not real verification execution.

## Regression and quality gate

On the combined checkout, run:

```text
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

`pnpm test` covers source behavior without requiring `dist/`. Build and smoke verify that the existing Phase 0 compiled entrypoint remains healthy. The Phase 1 end-to-end test is a deterministic in-memory lifecycle test, not a model, tool, sandbox, filesystem, Git, CLI, or audit integration test.
