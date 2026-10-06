# Repository Read Tools Implementation Plan

> **For agentic workers:** Use subagent-driven-development or executing-plans to implement this plan task by task. The checklist in [tasks.md](tasks.md) is the execution ledger. This PR authorizes planning only.

**Goal:** Enable bounded, provenance-preserving repository retrieval and small automatic context through existing deterministic task authority.

**Architecture:** Host read executors reuse `WorkspaceBoundary` safe handles and in-process literal matching. Bootstrap dispatches the same registered calls through the same runner/gateway; only trusted audit origin differs. Retrieval observes current bytes per call, while verification retains its independent snapshot contract.

**Tech Stack:** Node.js 24 LTS, strict native-ESM TypeScript, pinned pnpm 12.5.1, existing Zod 4/Vitest and Node-API boundary; no new runtime dependency or search process.

**Spec:** [spec.md](spec.md)

**Branch**: `feat/007-repository-read-tools` | **Date**: 2026-10-06

## Global Constraints

- Keep existing nine-name catalog; enable only three retrieval executors. Preserve Ask/Edit ceilings and default deny.
- All source bytes flow through held safe handles, never `fs.readFile(path)` or independent executable traversal.
- Whole-file/model read caps: 65,536 bytes; search file cap: 4,194,304 bytes; result cap: 32,768 bytes; returned line cap: 4,096 bytes; matches: 1–200. List result cap: 16,384 bytes; entries: 1–100.
- Keep the current narrow redactor and `TOOL_CONTRACT_FAILURE` on changed read/search payloads. No broad scanner, bypass or silent content rewrite.
- Root `AGENTS.md` alone is automatic instruction content. Nested instructions require explicit retrieval.
- No regex, grep/ripgrep process, network, chunk reads, indexes, retrieval snapshots, mutation adapters, real provider, CLI or durable audit implementation.
- Phase 4 prerequisite is satisfied for available fixtures under T088. Phase 5's Windows Docker gate remains OPEN; no Phase 6 evidence closes it.

## Review Focus

1. Exact 4 MiB versus 4 MiB+1 files: probe safely; never search a prefix as a complete file (T137/T138).
2. Many aliases/deep directories: keep distinct work accounting from returned results and stop canonical cycles (T139–T142).
3. Synchronous native/Git calls: cooperative cancellation cannot preempt them; bound calls, refresh time and fence late results (T135/T136/T145).
4. Heuristic match in source/path and bootstrap instructions: reject affected payload before delivery and benchmark adversarial inputs (T143/T144/T150–T153).
5. Root instructions absent or beyond bounded listing: avoid treating incomplete discovery as absence; preserve normal denial/recovery for dispatched calls (T146/T147).

## Summary and Current Behavior

Phase 4 supplies held regular-file reads, safe immediate directory snapshots and `boundedRead`/`boundedSearch` builders. Registry read/search output schemas exist; list output is currently `z.unknown()`. The gateway validates output, applies generic redaction, rejects altered read/search payloads and audits metadata. `TaskRunner.dispatchProposals` charges/settles requests but accepts one `now` value for a batch; real asynchronous retrieval needs fresh clock observations. No complete model-visible filesystem executor or automatic-context adapter exists.

The current tracker on `development` supersedes the earlier closed-Phase-5 statement used during initial grilling: Linux Docker evidence exists, while Windows Docker Desktop fixtures leave that exit gate open. Host read tools depend on Phase 4, not sandbox execution. Future end-to-end Edit integration still requires the unfinished applicable gates.

## Technical Context

**Language/Version:** TypeScript strict/native ESM; Node.js 24 LTS.

**Primary Dependencies:** Existing Zod 4, Vitest, Node built-ins and native workspace addon. No additions.

**Storage:** Live checkout plus bounded per-invocation memory; no persistent retrieval cache/snapshot or content audit.

**Testing:** RED/GREEN Vitest contracts, injected traversal/clock tests, native fixture integration on Ubuntu/Windows, scripted gateway E2E and dedicated benchmark command.

**Target Platform:** Ubuntu and Windows host inspection. Docker is unnecessary for Phase 6 retrieval checks.

**Project Type:** Internal modules of the private modular monolith; interfaces become model tool contracts in Phase 10.

**Performance Goals:** Calibrate and freeze p95 sanitizer and end-to-end overhead thresholds on reference hosts in T151 before executor enablement; record p50/p95/p99. Initial engineering target: p95 sanitizer cost <=10 ms at maximum read/search result size, subject to measured evidence rather than an unverified promise.

**Constraints:** Finite counts/bytes/depth/deadline, cooperative cancellation, mandatory audit, no unauthorized read or raw payload persistence.

**Scale/Scope:** Small/medium TypeScript fixture repositories; larger scopes return explicit incompleteness and can be narrowed through more budgeted calls.

## Constitution Check

The loaded `.specify/memory/constitution.md` is an unratified placeholder template, not a source of new rules. Effective gates come from `AGENTS.md`, authoritative context and accepted ADRs 0005/0006/0008/0009/0011/0012.

| Gate | Before research | After design |
| --- | --- | --- |
| Closed names, immutable task authority, no arbitrary commands | PASS: preserve existing catalog | PASS: contracts expose no new capability |
| Point-of-use safe reads and mandatory evidence | PASS: reuse Phase 4/3 | PASS: bootstrap shares dispatch; child reads revalidate |
| Finite work/recovery and cancellation | PASS: trusted limits required | PASS: bounded walker and refreshed clocks specified |
| TDD, security review and measured evidence | PASS: mandatory workflow | PASS: tasks and quickstart cover requirements |
| Implementation status truthful | PASS: Phase 6 planned | PASS: Phase 5 Windows gate and T088 preserved |

These are design compliance results, not passed runtime tests.

## Project Structure

### Documentation

```text
specs/007-repository-read-tools/
  spec.md
  plan.md
  research.md
  data-model.md
  contracts/read-tools.md
  quickstart.md
  tasks.md
  checklists/requirements.md
  review.md
  issues.md
```

### Planned Source and Tests

```text
src/tools/registry.ts                 strict list schema and content identity fields
src/tools/gateway.ts                  trusted origin, unchanged heuristic semantics
src/tools/read.ts                     three concrete retrieval executors and bounded traversal
src/tools/read-gateway.ts             trusted ready-to-compose gateway adapter
src/orchestration/runner.ts           shared dispatch, fresh clock and trusted origin
src/orchestration/context.ts          small bootstrap adapter
src/workspace/boundary.ts             private probe and file/directory search-scope facts
native/workspace/addon.cc             private read-capacity guard increases by one byte
src/workspace/retrieval.ts            bounded read/search identities and incremental search
tests/tools/read.test.ts              executor unit behavior
tests/tools/read.integration.test.ts  real boundary plus gateway
tests/tools/read.security.test.ts     hostile native fixtures
tests/tools/output-contracts.test.ts  extended strict output/redaction regressions
tests/orchestration/context.test.ts   bootstrap boundaries/accounting
tests/orchestration/runner.test.ts    real-time dispatch regressions
tests/retrieval/evaluation.test.ts    metric formulas and traces
tests/retrieval/performance.test.ts   correctness-backed benchmark cases
tests/fixtures/retrieval/             miniature repository cases and expectations
scripts/benchmark-retrieval.ts        dedicated warmed benchmark report/gate
package.json                         retrieval:bench command only
```

These are planned changes; this PR changes documentation only. Keep shared-file edits sequential rather than extracting a new framework. Existing retrieval regression files are `tests/workspace/read-bounds.test.ts` and `tests/workspace/search-bounds.test.ts`; migrate those plus hash-less fake results in `tests/tools/workspace-gateway.test.ts`, registry/gateway tests and sandbox fake-port fixtures when strict schemas change.

## Interfaces and Responsibilities

`createReadExecutors(boundary: WorkspaceBoundary, workspaceId: string, options: ReadExecutionOptions): Readonly<Pick<Record<ToolName, ToolExecutor>, 'list_files' | 'search_code' | 'read_file'>>` lives in `src/tools/read.ts`. Options contain only trusted limits and monotonic clock/yield dependencies. Construction binds the admitted workspace; each call asserts `authority.paths` matches its requested scope/workspace, then performs fresh boundary safe opens. The factory is wired by a trusted composition/test root, never exposed to model arguments.

During development, tests compose this factory directly to collect correctness/performance evidence. After T151–T153 measured gates pass, T154 adds `createReadGateway(boundary, workspaceId, dependencies, options): ToolGateway` in `src/tools/read-gateway.ts`; dependencies supply trusted audit/grant ports but cannot substitute repository-read executors. The adapter installs only the three read executors and the bound real workspace-facts port. Its composition test proves real Ask/Edit retrieval and absence of mutation/execution tools, followed by full verification and T155/T156 reviews before release readiness is declared at T158. This is a build/release-readiness gate, not per-call machine benchmark lookup. Phase 10/13 can later use this trusted adapter; do not change the foundation `start()` into a premature model/CLI loop.

`ReadExecutionOptions` defaults: `maxFiles=1024`, `maxDirectories=256`, `maxDepth=32`, `maxSourceBytes=64*1024*1024`, `maxElapsedMs=5000`, and asynchronous yield at least once per file/directory or bounded line batch. Work counters count attempted candidates, including aliases/denials; emitted counts do not bound traversal by themselves. Per-call elapsed limit is bounded by the active task's remaining deadline. Existing synchronous Git commands each have a 10-second timeout; one boundary primitive may contain multiple such commands. The 5-second scan deadline is cooperatively enforced before/after primitives, not advertised as a hard 5-second wall limit. An operation may exceed that deadline by a whole bounded primitive, including its sequential Git calls; document observed latency and test fencing. No new unbounded retry loop.

`TaskRunner.dispatchProposals` accepts `now: number | (() => number)` compatibly, evaluating the trusted clock before every attempt, settlement and outcome transition. Existing numeric fake-time tests retain their semantics. A trusted `origin: 'AGENT' | 'BOOTSTRAP'` dispatch option reaches gateway request/result metadata; it is not part of tool JSON Schema, user arguments or repository content. Bootstrap uses this same method one request at a time after the task enters INSPECTING; it never invokes an executor directly. Trusted call origin does not change eligibility, accounting, denial recovery or failure mapping. Audit tool identifiers are validated registered names or a closed invalid/unknown sentinel, never raw proposed names. After awaited execution and before context delivery, recheck invocation generation/abort and current deadline; preserve applicable result evidence without delivering a late payload.

Extend trusted `InvocationFence` with a runner-owned remaining-active-work callback; extend `ToolExecutionAuthority` with finite `remainingActiveWorkMs`. The callback accounts elapsed time since `task.lastObservedAt` against `task.budget.maxActiveWorkSeconds*1000 - task.usage.activeWorkMs`, using the trusted dispatch clock, never model values. Before execution after awaited pre-audit, perform a TICK through the runner so expired active work becomes the existing BUDGET_EXHAUSTED outcome with no executor call. Executor receives remaining active work and uses its monotonic clock to set `min(5000, remainingActiveWorkMs)` cooperative allowance. After execution/result audit, perform another TICK before settling/returning even for the last successful call; account elapsed work once through lastObservedAt, suppress late/exhausted payloads and retain applicable result-committed budget evidence. An exhausted active-work task is not relabeled as developer cancellation, and no new tool attempt or retry is charged by a TICK. Numeric fake-time callers remain supported; tests using real read executors supply the trusted fence/remaining-budget contract.

`collectInitialContext(runner: TaskRunner, gateway: ToolGateway, input: BootstrapInput, now: () => number): Promise<BootstrapContext>` lives in `src/orchestration/context.ts`. Input is structured developer references, never references mined from repository/model text. Bootstrap preserves normal terminal/error handling, stops the current bootstrap batch on any non-executed result and returns bounded metadata without recovering authority itself. It may proceed with normal task recovery only through the existing runner contract.

## Retrieval Algorithms and Output

### Read and oversized-file detection

Reuse `boundedRead` for UTF-8/size behavior and hash the exact consumed bytes once with Node SHA-256. Add hash provenance within the same encoded cap; keep content hashes out of audit metadata. For search, both TypeScript and native addon read-capacity guards currently reject capacities above 4 MiB. Extend both private trusted guards to 4 MiB+1 solely for oversize probing, keeping the public content cap at 4 MiB. Test safe-open identity/membership validation before/after the probe; a file yielding the extra byte is skipped, never searched as a prefix. A short read/growth race cannot establish atomic file stability; hash only bytes consumed and do not claim more.

### Listing

One `list_files` call lists immediate children; directories include a kind tag so the agent can descend. Sort accepted canonical paths by code-point order, deduplicate aliases and fit strict list schema/count/serialized cap before return. Root scope is represented as `.` in scope fields only. Do not emit denied names or rejected host targets. The existing >=1,024-child directory failure stays fail closed; expanding that native contract/pagination is excluded. Mark only valid bounded omissions; an authority failure must not be relabeled as normal truncation.

### Search

Extend `WorkspaceBoundary.factsFor` search-scope classification, which currently assumes a directory, to accept an eligible regular file or directory using trusted inspection. Determine scope kind using safe boundary opens; traverse validated immediate directory snapshots depth first in deterministic order. Open a child only through `WorkspaceBoundary`; distinguish ordinary excluded targets from unavailable authority. Hold one content target at a time; close every handle in `finally`. Track canonical directory identities and canonical file targets per invocation for cycle/alias control, with bounded sets.

Incrementally feed eligible complete <=4 MiB files into the existing bounded search builder; avoid accumulating all source files or splitting the entire repository into lines. Source-byte accounting includes oversized/binary probes and discarded bytes, not just matching files. Limit every safe read to the remaining source-byte allowance; if that prevents establishing a complete file, stop with SOURCE_BYTE_LIMIT and do not search the prefix. Hash consumed bytes, use literal per-line matching and bound line processing/yields. Newline-containing queries are valid input but match no individual line; this behavior is explicit and tested. Returned matches carry content hash. On output/count/work/depth/deadline stops set truthful flags/reasons and do not scan the entire remaining tree just to count omissions. `omittedMatches` indicates matches may be omitted; it is not an exact count. A scan may be complete only when every eligible discovered target was processed/skipped under its documented content policy. Cancellation emits no late partial context; unavailable authority fails the call.

### Narrow heuristic

Keep current case-insensitive `token|secret|password=...` string replacement and secret-like object-key redaction. Gateway retains whole-result `TOOL_CONTRACT_FAILURE` when read/search redaction changes output. List metadata is also sanitized and schema-checked; changed source-path metadata cannot be presented as canonical evidence. Do not broaden regex or scan all source bytes: the heuristic covers candidate model-visible results, not every possible secret in the repository. False positives and misses are accepted residual limitations, not proof of secret-free content. No content/raw query enters audit even on failure.

## Automatic Context Selection

Runtime caps: 8 tool attempts, 96 KiB aggregate serialized context including omissions, at most 4 unique explicit references, tree depth 2 and at most 100 tree entries total. Inspect at most the first 32 raw references, validating each as a 1–1,024-character string before deduplication; summarize uninspected remainder by count only, with at most 32 omission entries. Do not copy, hash, sort or iterate an unbounded reference array before enforcing this cap. These are extra upper bounds within the admitted task's remaining tool allowance, not new allowances. Priority: root listing to establish a small tree; root `AGENTS.md` when discovered eligible; explicit references in developer order; optional depth-two tree listings only with remaining capacity. Deduplicate root instructions/references so no file is read twice just for bootstrap.

If listing cannot prove root instruction absence because it was incomplete, record `NOT_DISCOVERED` rather than `MISSING`; do not silently claim no root instruction exists. A normal root `read_file` may be dispatched within remaining bounds to resolve uncertainty; it receives normal denial/recovery if absent or forbidden. Missing/denied references expose only bounded reference index/reason, not raw external paths. A denied or contract-failing call stops bootstrap under the same runner behavior; it is not ignored by a privileged loader. Aggregate-cap exclusion reports omission without adding partial text or silently dropping successful audit evidence. Later explicit calls may obtain more context.

All bootstrap results are untrusted repository evidence. Phase 6 produces typed context fragments, not a provider prompt implementation or a system-message mutation. No nested instruction content is automatically discovered or fetched on descendant access; an explicit developer reference to a nested instruction file remains ordinary referenced content. No special authority is attached to root instructions. Audit/budget/policy/contract failures or cancellation suppress delivery of the accumulated bootstrap batch; no model turn starts from those partial fragments. Safe aggregate/work-cap omissions while the task remains eligible may return bounded partial context.

## Evaluation and Performance

Use fixtures materialized as isolated temporary Git checkouts. `tests/fixtures/retrieval/expectations.json` declares source-content relevance sets, deterministic trace requests, expected evidence properties and diagnostic verification selections. The scripted driver runs through the real gateway/runner and bounded bootstrap, while fake model/audit ports supply only the still-deferred integrations.

Record content-only recall/precision separately from path discovery; see [data-model.md](data-model.md) for formulas. Required baseline traces target recall 1.0 and content precision >=0.8 on deliberately small reference fixtures; adversarial/scoped/limited traces declare their own exact expectations. Zero forbidden deliveries is unconditional. Verification selection checks trusted fixture expectations against scripted selection values without executing Phase 8 adapters or treating scripted choices as LLM reasoning. Live answer correctness is `NOT_MEASURED`.

T151 first runs correctness-backed dedicated benchmarks: 100 warmups and >=1,000 measured iterations per max-size sanitizer case, and >=30 end-to-end fixture runs on each host. Record CPU/OS/Node, p50/p95/p99, warmup/sample counts and allocation/source-byte counts. Compare normal gateway sanitization with a benchmark-only validation/serialization baseline that never exposes content or changes production gates. Freeze absolute per-host p95 thresholds and a regression ceiling of baseline*1.25 + 1 ms for sanitizer cases; freeze end-to-end budgets separately from I/O variability. Initial <=10 ms sanitizer target is diagnostic until calibrated; failed calibration blocks enablement pending a reviewed optimization/threshold rationale, never weaker security. Do not run noisy timing assertions in the ordinary unit suite; use a dedicated performance job and committed measurement metadata, not private machine output or secrets.

## Threat Review

| Threat | Control | Proof |
| --- | --- | --- |
| Bootstrap grants authority/free access | Same runner/gateway, trusted origin, shared ceilings | T135/T136/T146/T147 |
| Child/path/symlink swap or host escape | Held boundary opens and fresh child checks | T137/T138/T145 |
| Huge file/alias/deep tree floods | Probe, finite work/output limits, incremental processing | T139–T142/T145 |
| Repository prompt injection | Untrusted fragments, no schema/policy changes | T146/T147/T149 |
| Sensitive content in allowed file | Existing narrow heuristic, whole affected result withheld | T143/T144/T150–T153 |
| Audit failure/cancellation late result | Pre-evidence gate, no replay, close/fence | T135/T136/T145/T149 |
| False complete no-match/stale identity | Explicit incompleteness, consumed-byte identity | T137–T142/T149 |

No new execution/network capability is introduced. Policy exceptions or unavailable authority remain fail closed; external audit failure uses existing blocked outcomes. Previously approved file edits are never rolled back by retrieval.

## Implementation Sequence and Verification

Execute [tasks.md](tasks.md), starting T132. Each deliverable defines RED assertions, targeted commands and exact files; implementations wait for confirmed expected RED. Reuse tests/source rather than adding alternate policy/executor frameworks. Commit cohesive slices only after targeted GREEN/regressions. Run [quickstart.md](quickstart.md) on both hosts before final convergence, separate standards/spec review and context sync.

MVP increment: US1 delivers one safe read through the gateway. It is not the entire Phase 6 gate. US2 supplies discovery, US3 small bootstrap, US4 evaluation/performance; all are required before Phase 6 completion. This planning PR runs artifact validation/format/link checks only; no product test pass or performance claim is made.

## Complexity Tracking

No new dependency, subprocess search adapter, broad scanner, worker framework, retrieval snapshot lifecycle or index is justified. The existing synchronous boundary primitives create a documented cooperative-cancellation limit; revisit only if measured latency demands a separately reviewed asynchronous boundary redesign.
