# Phase Testing Guide

Record the verification procedure for each product phase here when that phase is implemented. Use `progress-checker.md` for completion status; a documented test plan alone does not prove a capability exists.

## Phase 1 — Task Domain & Orchestrator

### Prerequisites

- Use Node.js 24 and the pnpm version pinned in `package.json`.
- Run `pnpm install --frozen-lockfile` in a checkout containing both Phase 0 and Phase 1 source.
- Run commands from the repository root.

### Focused behavior tests

```sh
pnpm exec vitest run tests/orchestration/task.test.ts tests/orchestration/transitions.test.ts tests/orchestration/budget.test.ts tests/orchestration/runner.test.ts tests/orchestration/runner.e2e.test.ts
```

Confirm that the tests cover these Phase 1 exit conditions:

1. A task enters only declared states. An illegal internal transition becomes `FAILED / INVALID_TRANSITION` without entering the requested state; terminal tasks cannot continue.
2. The last permitted agent step can complete, while the next step, a fourth retry, or the 900-second deadline produces a typed `BUDGET_EXHAUSTED` outcome with limit and usage evidence.
3. A trusted `Edit → Ask → Edit` mode change keeps task identity, objective, and usage, then resumes at inspection. Informational tasks cannot switch into Edit.
4. Invalid model proposals consume a step but leave a permitted task route open. Cancellation, blocking, failure, and completion remain distinct.
5. A changed Edit task completes only with a passing verification result for its current attempt. No-change completion reports that verification did not run.

`runner.e2e.test.ts` uses scripted events and an injected clock. Permission, verification, and sandbox events in these tests are fixtures, not calls to real adapters. Deadline expiry is checked when an event or clock tick is processed; a later runtime must schedule ticks and bound external calls.

### Combined Phase 0 + Phase 1 quality gate

Run the complete gate on the combined checkout:

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

All commands must exit successfully. `pnpm test` includes the focused Phase 1 tests and the Phase 0 regression tests. `pnpm build` checks compiled TypeScript output. `pnpm smoke` runs `dist/index.js`, the Phase 0 entrypoint; it does not execute the Phase 1 runner. The focused scripted lifecycle test is the Phase 1 end-to-end evidence.

Ubuntu CI runs this full command sequence with a frozen pnpm install. Windows CI runs the source tests, build, and smoke. If the pinned pnpm executable is blocked on a local machine, record that limitation and use the matching CI run as evidence for the pinned-manager gate; direct invocation of installed binaries is useful local diagnosis but is not the same pnpm-script gate.

For the detailed Phase 1 contract and additional test scenarios, see `specs/002-task-domain-orchestrator/quickstart.md` and `specs/002-task-domain-orchestrator/plan.md`.

## Phase 2 — Closed Tool Registry

### Prerequisites and focused tests

Use Node.js 24, pnpm 12.5.1 from `package.json`, and `pnpm install --frozen-lockfile`. From the repository root, run:

```sh
pnpm exec vitest run tests/tools/registry.test.ts
```

The focused suite proves that:

1. Exactly nine fixed tool names are recognized. Unknown names, outer names beyond 64 Unicode code points, malformed `{ name, arguments }` calls, unknown argument keys, wrong types, and out-of-range values are rejected without returning raw query or patch text.
2. String bounds count Unicode code points; a supplementary-plane character at a `maxLength` boundary agrees with the advertised Draft 2020-12 JSON Schema.
3. Trusted Ask selection exposes four names and Edit exposes nine. An unknown selected name fails the whole schema request; duplicate or reordered candidates produce one stable catalog-ordered result per name.
4. Required and optional fields, types, limits, and `additionalProperties: false` agree between runtime validation and the Zod-derived model-visible schema for every tool.
5. Validated calls retain name-specific TypeScript argument types. Caller changes to returned schema data cannot change later results or the trusted selection.

### Combined quality gate and current limitation

Run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm smoke` on the combined checkout. The full source suite includes 77 registry tests and 98 Phase 0/1 tests. `pnpm smoke` still executes the Phase 0 compiled entrypoint; it does not exercise registry functions or a tool invocation loop.

On this Windows checkout, pnpm 12.5.1 can run through Corepack outside the local sandbox. The pinned scripts for lint, typecheck, test, build, and smoke pass. `pnpm format:check` reports 15 unchanged files with CRLF line endings; `pnpm exec prettier --check . --end-of-line auto` passes as a diagnostic. That diagnostic does not replace the full pnpm-script gate. Phase 2 source is implemented, while integration readiness remains open until the required format gate passes in a checkout or CI run.

The registry is pure and does not execute a tool or decide authorization. Phase 3 policy, later adapters, provider conversion, and complete executable tool contracts require separate verification. See `specs/003-closed-tool-registry/quickstart.md` and `specs/003-closed-tool-registry/contracts/registry.md`.
