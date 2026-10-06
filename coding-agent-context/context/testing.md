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

At this historical checkpoint, the local Windows checkout also passed `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` (265 tests), `pnpm build`, and `pnpm smoke`. Its Node-API addon was compiled with MinGW g++ against Node 24.14.0 headers for local tests. At that time, the standard `pnpm native:build` command could not complete on this host because Visual C++ Build Tools were absent; the successful Ubuntu and Windows CI builds provided the two-host native-build evidence for that older source. Visual C++ Build Tools were installed later, and the current Windows native build is recorded below. T059–T068 were a partial Phase 4 checkpoint because later path, content-open, and tool integration work was still open.

## Phase 4 — Internal phase 4 two-host CI verification checkpoint (T069–T078, T088 partial)

### Historical local Windows diagnostic checkpoints (2026-10-02)

On 2026-10-02, the local Windows checkout compiled the changed native addon with MinGW g++ and Node 24.14.0 headers for diagnostic testing. The focused command `pnpm exec vitest run tests/workspace tests/tools/workspace-gateway.test.ts tests/policy/engine.test.ts tests/tools/registry.test.ts` initially passed 167 tests with five skipped cases. After review fixes, the full `pnpm test` command passed 313 tests with five skipped cases; `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`, `pnpm smoke`, and `git diff --check` passed. The skipped cases included Linux bind-mount coverage and real symlink fixtures unavailable on this Windows host. The native Windows fixture denied a junction, hard-linked content, traversal, Git metadata, and an alternate data stream; a pinned opened file did not return bytes after its alias changed. An additional regression test proved that a closed opaque native token cannot read a later handle that reuses the same OS descriptor. Real workspace facts reached the existing gateway, and missing, duplicate, extra, wrong-alias, and wrong-operation read facts were rejected before fake executor dispatch.

Later on 2026-10-02, Visual C++ Build Tools 2026 were available on this Windows host. The Node 24.14.0 addon built successfully with `pnpm native:build`, using Python 3.12.11 at `C:\msys64\ucrt64\bin\python.exe` and the unencrypted local node-gyp header cache selected by `npm_config_devdir`. That intermediate local full `pnpm test` run passed 318 tests with 11 skipped (due to local Windows symlink privilege absence and platform skips); `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`, `pnpm smoke`, and `git diff --check` passed on this checkout. A single parallel full-suite run exceeded Vitest's five-second limit in the Git-heavy mutation-preflight test; that integration test was given a ten-second limit and passed.

### Two-host CI verification (PR #119, CI run 35)

On 2026-10-02, [CI run 35](https://github.com/pminhtaiii/slop-loop/actions/runs/37008013232) for PR #119 on branch `feat/005-workspace-boundary` (verified commit `fe0709553e927e78362328f087440693d1a107b5`) passed both Windows Quality Gate and Ubuntu Quality Gate:

1. **Windows Quality Gate (PASS)**:
   - Native build: `pnpm native:build` with runner Visual C++ tools succeeded.
   - Workspace boundary tests (`pnpm exec vitest run tests/workspace`): 79 passed, 2 skipped (81 total).
   - Full source tests (`pnpm test`): 332 passed, 2 skipped (334 total).
   - Application build (`pnpm build`): passed.
   - Smoke test (`pnpm smoke`): passed.
   - Real Windows symlink and junction behavior executed and verified: Windows runner privileges allowed real file and directory symlink fixtures to execute and pass; Windows junction denial for internal and external checkout targets passed.
   - Skipped test classification: The 2 skipped tests on Windows are Linux-only cases (`tests/workspace/native-boundary.test.ts` Linux FIFO and `tests/workspace/mount-boundary.test.ts` Linux bind mount). These are expected platform exclusions and do not block Windows evidence.

2. **Ubuntu Quality Gate (PASS)**:
   - Native build: `pnpm native:build` with runner g++ and make succeeded.
   - Workspace boundary tests (`pnpm exec vitest run tests/workspace`): 78 passed, 3 skipped (81 total).
   - Code standards: `pnpm lint`, `pnpm format:check`, and `pnpm typecheck` all passed cleanly.
   - Full source tests (`pnpm test`): 331 passed, 3 skipped (334 total).
   - Application build (`pnpm build`): passed.
   - Smoke test (`pnpm smoke`): passed.
   - Real Linux native openat2 traversal, symlink resolution, and FIFO rejection executed and passed.
   - Skipped test classification: Of the 3 skipped tests on Ubuntu, 2 are Windows-only junction fixtures (`tests/workspace/mount-boundary.test.ts` Windows junction and `tests/workspace/boundary.test.ts` mutation-parent junction). The 1 critical skipped test is `tests/workspace/mount-boundary.test.ts` Linux bind mount, which explicitly reported `UNAVAILABLE: Linux bind-mount fixture requires mount capability`.

3. **Evidence gap and status reconciliation**:
   - The GitHub-hosted Ubuntu runner could not create the Linux bind-mount fixture because the required mount capability was unavailable. A skipped test is **not** containment evidence; Linux bind-mount containment has **not** been proven safe.
   - Implementation for T069–T078 is complete, and cross-platform CI verification currently available has passed for both Windows real symlink/junction behavior and Linux native/symlink behavior.
   - Convergence task T088 remains **partial** and UNVERIFIED / UNAVAILABLE. The project explicitly accepts this Linux bind-mount verification gap for MVP; it does not independently block the Phase 4 exit decision when all other available gates pass. The skipped fixture is not a containment PASS.
   - At this historical CI checkpoint, T079–T087 were still open and the overall Phase 4 exit gate was open. Later local implementation evidence is recorded below; the older CI run does not verify the newer source.

## Phase 4 — Local Windows checkpoint before PR #164 CI (2026-10-02–2026-10-03)

The current checkout implements T079–T085 boundary-level retrieval contracts and gateway output validation. `search_code.limit` now accepts 1–200 while `list_files.limit` remains 1–100. The closed catalog enforces a 64 KiB read result, a 32 KiB search result, and 16 KiB for other tools. Whole-file reads return complete text or typed size/binary outcomes; search bounds matches, lines, total bytes, and per-file bytes with separate omitted-match, shortened-line, and omitted-skipped-file markers. These are reusable boundary builders, not Phase 6 model-visible executors.

The directory-iteration hardening opens children relative to the retained parent handle, checks that parent's identity and canonical location around the batch, and fails closed on replacement or alias retargeting. Each `entries()` call returns one validated snapshot and never reuses a previous call's child eligibility. Git tracked and nonignored untracked membership comes from two tagged, NUL-delimited `ls-files` processes per directory call, before and after child inspection; a change between them fails closed. At most one child handle is open at a time. Every accepted child is reopened relative to the retained parent after the second Git snapshot; canonical location, alias, opened identity, and link count are revalidated before the batch is emitted. File reads independently revalidate membership and opened-target identity before and after bytes are read. Git root/gitdir discovery combines its two outputs into one fail-closed `rev-parse` process per verification, so the measured directory batch uses two `ls-files` and three `rev-parse` processes regardless of child count. The measured read revalidation uses two `ls-files` and four `rev-parse` processes for its before/after checks. Adversarial tests exercise parent replacement, a swap during child resolution, directory-alias retargeting where symlink creation is available, and Git membership or child identity changes between directory snapshots or during inspection, including replacement of an earlier child while a later child opens. A Windows-runnable native retarget simulation tests canonical-path revalidation; a real same-inode symlink retarget fixture was skipped locally without symlink privilege; current-source CI fixture results are recorded below.

Observed local Windows commands at that checkpoint:

- Focused quickstart plus output-contract tests: `pnpm exec vitest run tests/workspace tests/tools/workspace-gateway.test.ts tests/policy/engine.test.ts tests/tools/registry.test.ts tests/tools/output-contracts.test.ts` — 210 passed, 17 skipped (227 total). Skips include Linux-only fixtures and Windows symlink cases unavailable under this local token; the real Windows junction case passed.
- Exact focused quickstart command without the separately named output-contract file: `pnpm exec vitest run tests/workspace tests/tools/workspace-gateway.test.ts tests/policy/engine.test.ts tests/tools/registry.test.ts` — 198 passed, 17 skipped (215 total).
- Full source suite: `pnpm test` — 354 passed, 17 skipped (371 total).
- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`, `pnpm smoke`, and `git diff --check` passed. `pnpm native:build` succeeded on Node 24.14.0 / Windows x64 using Visual C++ Build Tools 2026 and Python 3.12.11 after a sandbox-only EPERM retry outside the sandbox. The application build and smoke passed again after the native build and source edits.
- Two-axis code review found stale eligibility between directory calls and repeated Git discovery; both were fixed. Follow-up review found high handle concurrency and then stale child identity and canonical location during a directory call; those were fixed with one-child-at-a-time inspection, two stable Git snapshots, and a final native reopen of every accepted child. Both review axes found no remaining actionable security/specification finding after the last fix. A CodeRabbit CLI review found that generic redaction could silently rewrite an otherwise complete `read_file` result or search line. The gateway now rejects read/search results whose serialized bytes change during redaction, and two regression tests pass. A later CodeRabbit review identified quadratic line-shortening work; that was changed to count encoded bytes incrementally, with a multibyte boundary regression test. Its suggestion that false-to-true omission flags can exceed the byte ceiling is inapplicable because JSON `true` is one byte shorter than `false`. The CodeRabbit CLI review at this checkpoint completed with zero findings.
- Ubuntu execution was unavailable locally: WSL was not installed and Docker was unavailable. PR #119 CI run #35 predates T079–T085, so this checkpoint did not satisfy T086; current-head two-host evidence is recorded below.
- Linux bind-mount containment remains **UNVERIFIED / UNAVAILABLE**: local fixture creation and GitHub-hosted Ubuntu mount capability are unavailable. T088 is the explicitly accepted MVP verification gap, never a PASS.

## Phase 4 — Final two-host verification for PR #164 (2026-10-03)

[CI run #41](https://github.com/pminhtaiii/slop-loop/actions/runs/37096538680) (run ID `37096538680`) for [PR #164](https://github.com/pminhtaiii/slop-loop/pull/164), branch `feat/005-workspace-boundary` into `development`, succeeded on implementation commit `0b990c03718fa9ae9f1f33de230f9cf53ff38d71`. Both jobs completed frozen dependency installation, `pnpm native:build`, `pnpm exec vitest run tests/workspace`, `pnpm test`, `pnpm build`, and `pnpm smoke`. Ubuntu also completed `pnpm lint`, `pnpm format:check`, and `pnpm typecheck`.

- **Windows Quality Gate (PASS)**: Workspace tests: 106 passed, 2 skipped (108 total). Full source suite: 371 passed, 2 skipped (373 total). The native build, application build, and smoke test passed. Real Windows junction behavior executed and passed; the two skipped cases were platform-specific unavailable cases, not containment passes.
- **Ubuntu Quality Gate (PASS)**: Workspace tests: 105 passed, 3 skipped (108 total). Full source suite: 370 passed, 3 skipped (373 total). Native build, lint, formatting, typecheck, application build, and smoke test passed. The Linux bind-mount fixture reported `UNAVAILABLE: Linux bind-mount fixture requires mount capability`; its skipped outcome is not a containment pass.
- **Quickstart comparison**: CI did not invoke the exact multi-path focused Vitest command in `quickstart.md`. Its workspace step ran `tests/workspace`, and its successful full `pnpm test` run included the named workspace, gateway, policy, and registry test files on both operating systems. On the same implementation commit, the exact focused command ran locally on Windows with 200 passed and 17 skipped (217 total); `pnpm lint`, `pnpm format:check`, and `pnpm typecheck` passed locally. A concurrent lint attempt encountered `ENOENT` while a test removed a temporary directory; the sequential rerun passed. Thus all available quickstart and pinned project checks are covered without treating skipped fixtures as passes.
- **Review and phase gate**: The final full GitHub CodeRabbit review covers implementation commit `0b990c03718fa9ae9f1f33de230f9cf53ff38d71` and reports `No actionable comments were generated in the recent review.` Merge Risk is Minimal, and no architecture-level security concern was identified. T086 and Internal Phase 6 are complete. Project Phase 4 is complete for the available fixtures under the explicit T088 MVP exception; Linux bind-mount containment remains **UNVERIFIED / UNAVAILABLE** and T088 stays unchecked.

This record binds CI and review evidence to the implementation commit above. A later documentation-only commit records that evidence; it does not change the tested implementation or create a circular requirement to rerun implementation CI.

## Phase 5 two-host and Docker integration verification for PR #167 (CI run #54, 2026-10-05)

CI run [#54](https://github.com/pminhtaiii/slop-loop/actions/runs/37207436068) for
[PR #167](https://github.com/pminhtaiii/slop-loop/pull/167), branch
`feat/006-offline-verification-sandbox`, succeeded on all three jobs (run head SHA
`7a241b0`).

- **Ubuntu Quality Gate (PASS)**: Workspace tests: 105 passed / 3 skipped (108 total).
  Full source suite: 436 passed / 7 skipped. Native build, lint, formatting,
  typecheck, build, and smoke passed.
- **Windows Quality Gate (PASS)**: Workspace tests: 106 passed / 2 skipped (108 total).
  Full source suite: 435 passed / 8 skipped. Native build, build, and smoke passed.
  The local Windows host does not have active Docker Desktop running during CI; Windows CI executes the complete source and native test suite (435 passed, 8 skipped), while live container execution runs on the dedicated Ubuntu Linux Docker daemon gate (`ubuntu-docker-gate`).
- **Windows Docker Desktop execution & fixture recording (T129, FR-022)**: **UNVERIFIED / UNAVAILABLE**. Successful Windows Docker Desktop Linux-mode fixture results have not been recorded. Required evidence includes preparation storage enforcement: the effective finite Docker Desktop disk-image limit, bound engine/storage identity, and a quota-exhaustion fixture for that platform. Record exact engine/platform versions, limits and fixture outcomes. Native Linux Docker results and Windows source/native regressions do not satisfy this requirement; unavailable fixtures are not a PASS.
- **Ubuntu Docker Integration Gate (PASS)**: Dedicated `ubuntu-docker-gate` job
  running under the native Linux Docker daemon executed `docker pull alpine:3.20`
  and `pnpm sandbox:test`. All 22 test files in `tests/sandbox` passed (109 passed,
  0 skipped, 0 failed). Real Docker execution covers:
  - T105: read-only dependency and snapshot layout with no host writeback,
    DockerCliExecution output bounding and exit code capture;
  - T111 / T115: offline dependency execution with root hooks disabled, developer-only
    authority binding, hostile archive/link rejection, and immutable digest publication;
  - T122: full stale-image lifecycle journey (BLOCKED -> developer confirmation ->
    new image -> new task reevaluation & verification);
  - T127: non-root, read-only root, cap-drop ALL, tmpfs bounds, PID limits, and network
    denial;
  - T128: daemon-loss cleanup uncertainty fencing, slot hold/release gates, and
    orphaned container reconciliation.

The Phase 5 exit gate remains open until successful Windows Docker Desktop Linux-mode fixture results, including preparation storage enforcement, are recorded. T129 and T131 remain open under FR-022. The gate remains: `executable tools run only in bounded ephemeral sandbox`.
