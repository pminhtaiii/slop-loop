# Quickstart: Validate the Task Domain and Orchestrator

This guide describes validation for the isolated Phase 1 source core. The plan is approved and the core code/tests exist; Phase 0 integration remains pending.

## Prerequisites

1. Complete the Phase 0 exit gate in `coding-agent-context/context/progress-checker.md` using `specs/001-project-foundation/tasks.md` before calling Phase 1 integration-ready. The current checkout has not passed it.
2. Make the pinned pnpm version from `package.json` available, install with a frozen lockfile, and confirm the Phase 0 commands pass.
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
- Model proposals invalid in the current state are refused and charged as steps; the task may continue within budget.
- The 30th permitted step may complete. A 31st attempted step and a fourth general retry stop before execution with typed budget evidence.
- A simulated deadline at 900 seconds expires a paused or permission-waiting task.
- Edit→Ask→Edit preserves identity, objective, and usage; the task re-enters inspection and cannot bypass later permission checks.
- Cancellation, blocking, failure, completion, and no-change completion are distinct; terminal replay preserves the first outcome.
- Changed-file completion requires a scripted trusted passing-verification event for the current change attempt. Repair and Edit resumption invalidate earlier passing evidence. The test asserts only the contract, not real verification execution.

## Regression and quality gate

Once Phase 0 is available, run:

```text
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

`pnpm test` covers source behavior without requiring `dist/`. Build and smoke verify that the existing Phase 0 compiled entrypoint remains healthy. The Phase 1 end-to-end test is a deterministic in-memory lifecycle test, not a model, tool, sandbox, filesystem, Git, CLI, or audit integration test.
