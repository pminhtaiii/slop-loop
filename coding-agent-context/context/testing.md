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
2. Small/Medium/Large profiles cap model turns at 30/60/120 and dispatched tool attempts at 60/120/240. The next capacity charge promotes within the sealed schedule or ends at Large with `BUDGET_EXHAUSTED` and a bounded handoff. Shared recovery retries remain fixed at the initial profile's 3/5/8 ceiling; the active-work deadline is 1,800 seconds.
3. Task mode stays fixed. A same-task mode change is rejected; stop aborts in-flight work where supported and retains the checkout slot until the attempt settles. A permission wait retains the slot but does not consume active-work time.
4. Invalid model proposals consume a model turn. Individually dispatched calls consume a separate tool attempt; internal lifecycle events consume neither. Cancellation, blocking, failure, and completion remain distinct.
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

Run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm smoke` on the combined checkout. The current full source suite includes 90 registry tests and 115 Phase 0/1 tests. `pnpm smoke` still executes the Phase 0 compiled entrypoint; it does not exercise registry functions or a tool invocation loop.

On 2026-09-28, a tracked LF checkout rule resolved the Windows CRLF mismatch. Pinned pnpm 12.5.1 through Corepack passed frozen install, lint, `format:check`, typecheck, all 205 tests, build, and smoke on this combined checkout. Phase 2 source is implemented; T035 security/spec review and T036 final context/diff review remain open before declaring Phase 2 integration-ready.

The registry is pure and does not execute a tool or decide authorization. T041 adds trusted capability/effect metadata without making an adapter executable. Phase 3 policy, later adapters, provider conversion, and complete executable tool contracts require separate verification. See `specs/003-closed-tool-registry/quickstart.md` and `specs/003-closed-tool-registry/contracts/registry.md`.

## Phase 3 — Policy Engine & Capabilities: prerequisite checkpoint

T037–T041 are implemented in this checkout. Run the focused prerequisite suite with:

```sh
pnpm exec vitest run tests/orchestration tests/tools/registry.test.ts
```

On 2026-09-28, that suite passed 152 tests. Frozen install and all pinned quality scripts, including `format:check`, passed on the combined checkout. These prerequisite tests prove runner budget/stop behavior and registry classification only. Phase 3 adds the focused policy, gateway, and runner suites below; real path containment and durable JSONL evidence remain later-phase work.

### Phase 3 focused gateway and runner tests

```sh
pnpm exec vitest run tests/policy/engine.test.ts tests/tools/gateway.test.ts tests/orchestration/runner.e2e.test.ts
```

On 2026-09-30, the full pinned test suite passed with 238 tests. These tests prove fake-port policy denial, committed pre-evidence before executor start, audit outage blocking, stable result-event retry without executor replay, output bounds, effect-status reporting, denial recovery exhaustion, and cancellation fencing. They do not provide real filesystem containment, process/sandbox, grant-ledger, or JSONL persistence evidence.

## Phase 4 — Internal phases 1–3 checkpoint (T059–T068)

On 2026-10-01, [CI run 31](https://github.com/pminhtaiii/slop-loop/actions/runs/36857259445) for commit `cd2be96dfffcafe07f8cf07289595563c5020383` passed on Ubuntu and Windows. Both jobs completed `pnpm native:build`, `pnpm exec vitest run tests/workspace` (23 passing tests), `pnpm test` (265 passing tests), `pnpm build`, and `pnpm smoke`; the Ubuntu job also completed `pnpm lint`, `pnpm format:check`, and `pnpm typecheck`. The workspace tests cover trusted root/subdirectory selection, physical directory aliases, denied missing/forged identities, same-path linked-worktree gitfile replacement, a gitfile switch during selection, sanitized Git discovery, tracked/untracked/ignored membership, gitlinks, nested and bare repositories (including a missing config), ordinary repository-shaped directories, a leading byte-order mark in an untracked pathname, sibling paths, symlinked and uninspectable directory prefixes, and native-loader compatibility.

The local Windows checkout also passed `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` (265 tests), `pnpm build`, and `pnpm smoke`. Its Node-API addon was compiled with MinGW g++ against Node 24.14.0 headers for local tests. The standard `pnpm native:build` command still cannot complete on this particular host because Visual C++ Build Tools are absent; the successful Ubuntu and Windows CI builds provide the two-host native-build evidence. T059–T068 remain a partial Phase 4 checkpoint: the workspace-containment exit gate in `specs/005-workspace-boundary/quickstart.md` is not satisfied because later T069–T087 path, content-open, and tool integration work remains open.

## Phase 4 — Internal phase 4 work-in-progress checkpoint (T069–T078)

On 2026-10-02, the local Windows checkout compiled the changed native addon with MinGW g++ and Node 24.14.0 headers for diagnostic testing. The focused command `pnpm exec vitest run tests/workspace tests/tools/workspace-gateway.test.ts tests/policy/engine.test.ts tests/tools/registry.test.ts` initially passed 167 tests with five skipped cases. After review fixes, the full `pnpm test` command passed 313 tests with five skipped cases; `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`, `pnpm smoke`, and `git diff --check` passed. The skipped cases include Linux bind-mount coverage and real symlink fixtures unavailable on this Windows host. The native Windows fixture denied a junction, hard-linked content, traversal, Git metadata, and an alternate data stream; a pinned opened file did not return bytes after its alias changed. An additional regression test proved that a closed opaque native token cannot read a later handle that reuses the same OS descriptor. Real workspace facts reached the existing gateway, and missing, duplicate, extra, wrong-alias, and wrong-operation read facts were rejected before fake executor dispatch.

Later on 2026-10-02, Visual C++ Build Tools 2026 were available on this Windows host. The current Node 24.14.0 addon built successfully with `pnpm native:build`, using Python 3.12.11 at `C:\msys64\ucrt64\bin\python.exe` and the unencrypted local node-gyp header cache selected by `npm_config_devdir`. The final full `pnpm test` run passed 318 tests with 11 skipped; the focused workspace/gateway/policy/registry run passed 174 tests with 10 skipped before the final `missing/../` regression test was added. `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`, `pnpm smoke`, and `git diff --check` passed on this checkout. A single parallel full-suite run exceeded Vitest's five-second limit in the Git-heavy mutation-preflight test; that integration test now has a ten-second limit and passed in the final full run.

The Windows junction fixture passed for both external and in-checkout targets. The Windows host still cannot create ordinary file or directory symlink fixtures, so eligible read aliases, alias swaps, cycles, and the `missing/../` regression remain skipped locally; Linux bind-mount and FIFO cases are platform-skipped. No post-T068 Ubuntu or Windows CI run has validated the new Linux and Windows native source, and no Linux build or mount-capable fixture was available locally. A skipped critical fixture is not containment evidence. T069–T078 source tasks are implemented, but the Internal Phase 4 US2 checkpoint and the overall Phase 4 exit gate remain unverified. T088 records the remaining two-host adversarial-fixture evidence task; T079–T087 remain future Phase 4 tasks.
