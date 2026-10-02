# Progress Tracker

This file records implemented reality.

Do not mark a capability complete because it appears in architecture or planning documents. A capability is complete only when its implementation and required verification exist.

---

## MVP Status

Overall status:

```text
PHASE 0 FOUNDATION COMPLETE / PHASE 1 RUNNER RECONCILED / PHASE 2 REGISTRY SOURCE IMPLEMENTED / PHASE 3 FAKE-PORT AUTHORITY CORE IMPLEMENTED
```

Phase 0 runtime and its exit gate are complete on `development` and its source is present in this checkout. The Phase 1 task domain and deterministic orchestrator are implemented, with ADR 0006/0007 runner reconciliation in this checkout. Phase 2 has a pure closed registry, trusted Ask/Edit name selector, and T041 capability/effect metadata. T037–T058 implement the Phase 3 fake-port authority core: policy decisions, task ceilings, asynchronous gateway routing, cancellation fencing, bounded audit events, output contract handling, and typed runner outcomes. There is still no real model, filesystem tool execution, permission ledger, sandbox, CLI, or durable audit adapter; Phase 4, 5, 7, 8, and 12 own those integrations.

The agreed future product MVP is an interactive local CLI implemented in TypeScript for Python target repositories. It supports `Ask` and `Edit` modes in one in-memory session, repository questions, permission-gated updates and creation in the current checkout, trusted Docker verification, progress questions, and a final diff and verification report. The developer owns Git writes. The first model provider remains undecided. Worktrees, session persistence, API/web, active-task scope changes, and remote Git delivery are deferred. These are planned behaviors, not completed capabilities.

---

## Phase 0 — TypeScript Application Foundation

- [x] Pin Node.js 24 LTS and pnpm version; create the private single-package manifest and lockfile.
- [x] Configure native ESM, strict TypeScript, tsc build to dist/, and no bundler.
- [x] Configure type-aware ESLint and Prettier.
- [x] Add only src/config.ts, src/logging.ts, and src/index.ts.
- [x] Add Vitest tests for configuration and logging plus a separate compiled smoke path.
- [x] Implement strict Zod 4 configuration for SLOP_LOOP_LOG_LEVEL with default info, injectable environment map, unknown-prefixed-variable rejection, and frozen typed output.
- [x] Implement the small Pino createLogger factory with controlled nested fields and explicit redaction.
- [x] Add pnpm format and pnpm format:check with explicit rewrite/check semantics.
- [x] Add Ubuntu full CI and Windows test/build/smoke CI.
- [x] Record the TypeScript, Node 24, single-process, private-package, and future modular-monolith decision.
- [x] Synchronize context, glossary, architecture, standards, libraries, workflow, policy, and progress.

Phase 0 must not create speculative subsystem directories, workspaces, microservices, package self-reference, exports, publication, SDK, CLI behavior, coverage gates, deployment, or model/provider behavior.

Exit gate:

~~~text
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
~~~
## Phase 1 — Task Domain & Orchestrator

- [x] Define `TaskContext`.
- [x] Define task state enum.
- [x] Implement validated transitions.
- [x] Implement task budgets.
- [x] Implement terminal outcomes.
- [x] Add transition unit tests.
- [x] Add retry/budget exhaustion tests.

The current checkout passes 205 tests across Phases 0–2 and the Phase 3 prerequisite changes, including the Phase 1 regression suite. Pinned pnpm 12.5.1 runs through Corepack outside the local sandbox; frozen install and all six quality scripts, including `format:check`, passed on 2026-09-28. The 152-test focused prerequisite suite also passed. The Phase 1 combined gate is satisfied. Budget expiry is checked on each event or injected clock tick; a later runtime must schedule real clock checks and bound external calls.

Exit gate:

```text
task cannot enter illegal state
task always terminates under finite budget
```

---

## Phase 2 — Closed Tool Registry

- [x] Define the non-executable registry entry and validated-call contract; complete executable tool contracts in later owning phases.
- [x] Define strict outer and per-tool argument schemas.
- [x] Implement the fixed nine-name closed registry and trusted Ask/Edit selector.
- [x] Reject unknown tool names and malformed arguments.
- [x] Derive provider-neutral model-visible input schemas only for registered selected names.
- [x] Add registry security and advertised/runtime parity tests.

MVP names registered as definitions only; tool adapters remain planned:

- [x] `list_files`
- [x] `search_code`
- [x] `read_file`
- [x] `apply_patch`
- [x] `run_tests`
- [x] `run_build`
- [x] `run_linter`
- [x] `run_typecheck`
- [x] `git_diff`

The focused registry suite passes 90 tests. It checks strict call envelopes, the 64-code-point name bound, all nine argument contracts, Unicode code-point length bounds, unknown-name denial, Ask/Edit selection, schema parity, safe copies, and trusted metadata isolation. Registry functions have no policy decision or execution path and are not wired into the Phase 1 runner. The pinned quality scripts pass on this checkout; Phase 2 T035/T036 review tasks remain open.

Exit gate:

```text
the registry cannot accept or register an unknown tool; there is no invocation path yet
```

---

## Phase 3 — Policy Engine & Capabilities

- [x] Define `ToolCapability` in the trusted registry metadata for all nine names; policy use remains open.
- [x] Define `PolicyDecision`.
- [x] Seal capabilities during task admission.
- [x] Recheck capability on every tool call.
- [x] Implement default deny.
- [x] Implement tool allowlist.
- [x] Implement read/write path capabilities through fake trusted facts.
- [x] Implement budget checks.
- [x] Fail closed on policy exception.
- [x] Add negative authorization tests.

T037–T058 are implemented and verified: fixed per-task mode, separate cumulative model-turn/tool-attempt counters, shared finite retries, permission-wait clock exclusion, checkout-slot stop fencing, bounded budget handoff, trusted registry classification, policy ceilings, gateway routing, fake audit ordering, output-contract handling, and typed audit outcomes. The full suite passed with 238 tests on 2026-09-30. This remains a fake-port proof; real containment, grant, executor, sandbox, and JSONL integrations are later-phase gates.

Exit gate:

```text
no tool executes without explicit capability
policy failure cannot become ALLOW
```

---

## Phase 4 — Workspace Boundary

- [x] Discover, canonicalize, and seal the selected current Git checkout root at admission; reject launch outside a valid checkout.
- [ ] Exclude sibling and nested repositories, ignored paths, and `.git` internals from repository tools while allowing nonignored tracked and untracked files.
- [ ] Implement workspace canonicalization.
- [ ] Block `..` traversal.
- [ ] Block absolute path escape.
- [ ] Block symlink escape.
- [ ] Block hard-linked content, nested mount/reparse crossings, and nonregular content targets.
- [ ] Add denied secret path patterns.
- [ ] Bound `read_file` to 64 KiB whole-file content with an explicit size-limit result.
- [ ] Bound `search_code` to 200 matches, 32 KiB total output, 4 KiB per returned line, and 4 MiB per searched file; mark omitted matches and shortened lines.
- [ ] Add adversarial filesystem tests.

T059–T068 implement the native-addon build/load contract, checkout selection and sealed admission, Git membership candidate enumeration, and US1 fixtures. On 2026-10-01, [CI run 31](https://github.com/pminhtaiii/slop-loop/actions/runs/36857259445) for commit `cd2be96dfffcafe07f8cf07289595563c5020383` passed `pnpm native:build`, 23 workspace tests, and the 265-test source suite on both Ubuntu and Windows; application build and smoke passed on both, and Ubuntu also passed lint, formatting, and type checking. The local Windows source suite also passed 265 tests with a manually compiled Node-API addon. The standard `pnpm native:build` command remains unavailable on that particular host because Visual C++ Build Tools are absent, but its native build is verified on both CI hosts. This is a partial Phase 4 checkpoint, not the workspace-boundary exit gate. Real path facts, safe content opens, and model-visible repository executors remain absent.

Internal Phase 4 is in progress in this checkout. T072, T073, and T078 now cover strict requested-alias parsing and secret denial, explicit and implicit read-path facts, and exact gateway fact matching. A native held-root prototype and real `WorkspaceBoundary` provide current read facts, a safe opened-file read primitive, and bounded directory enumeration on the tested local Windows host. They do not complete the Phase 4 exit gate: Windows still rejects eligible symlinks, Linux absolute in-root symlinks and bind mounts have not been verified, mutation preflight and complete adversarial fixtures remain open, and the standard Windows native build requires missing Visual C++ Build Tools. No model-visible repository content executor is enabled. T069–T071 and T074–T077 remain open; T079–T087 are later Phase 4 work. The registry still caps `search_code` at 100 matches, and the gateway still applies a generic 32 KiB result cap pending T079–T085.

Exit gate:

```text
repository tools cannot access host files outside workspace
```

---

## Phase 5 — Sandbox

- [ ] Define `SandboxBackend`.
- [ ] Implement Docker backend.
- [ ] Non-root container execution.
- [ ] CPU limit.
- [ ] Memory limit.
- [ ] PID/process limit.
- [ ] Wall-clock timeout.
- [ ] Network disabled.
- [ ] Copy repository state into an ephemeral sandbox workspace; never mount the developer checkout writable.
- [ ] Cleanup on success/failure/cancellation.
- [ ] Sandbox integration tests.

Exit gate:

```text
executable tools run only in bounded ephemeral sandbox
```

---

## Phase 6 — Read Tools

- [ ] `list_files`.
- [ ] search_code with a narrow search-text/scope/result-count schema and runtime-owned ripgrep arguments.
- [ ] Small automatic context: tree, instructions, and explicit references only.
- [ ] Retrieval fixture suite with required/helpful/forbidden files and answer/verification expectations.
- [ ] Retrieval metrics for recall, precision, irrelevant volume, denied attempts, bytes, calls, correctness, and verification selection.
- [ ] `read_file`.
- [ ] Strict schemas.
- [ ] Output bounding.
- [ ] Audit events.

Exit gate:

```text
agent can understand a fixture repository without host escape
```

---

## Phase 7 — Patch Tool

- [ ] Unified patch schema.
- [ ] Patch validation.
- [ ] Edit mode enforcement.
- [ ] Exact canonical repository-relative path-operation permission requests, including batched pairs.
- [ ] Revoke file permissions on `/clear`, exit, switching to `Ask`, and branch switch; make affected grants unavailable on other relevant external file change.
- [ ] Denied-path rejection.
- [ ] Changed-file recording.
- [ ] Patch rollback on invalid application.
- [ ] Patch integration tests.

Exit gate:

```text
all code mutations are policy-authorized and diff-visible
```

---

## Phase 8 — Verification Tools

- [ ] Trusted verification profiles with pytest -q as the Python default.
- [ ] Focused logical target validation with full-profile fallback.
- [ ] Audit requested logical target and executed profile/validated target.
- [ ] `run_tests`.
- [ ] `run_build`.
- [ ] `run_linter`.
- [ ] `run_typecheck`.
- [ ] Timeout handling.
- [ ] Exit code capture.
- [ ] stdout/stderr bounding.
- [ ] Output redaction.
- [ ] Process cleanup.

Exit gate:

```text
agent can verify code without arbitrary shell capability
```

---

## Phase 9 — Git Evidence

- [ ] Current-checkout Git validation.
- [ ] Read-only branch and `HEAD` detection.
- [ ] Stable `git status` evidence.
- [ ] Trusted branch/`HEAD`/status snapshots at admission and refresh checkpoints without a model-visible `git_status` tool.
- [ ] `git_diff`.
- [ ] Detect branch switches without switching branches for the user.
- [ ] Invalidate all grants and stale permission prompts on branch switch; refresh repository evidence and allow the same task to resume in the same checkout, requesting fresh exact grants only when mutation is needed.
- [ ] Final diff artifact.
- [ ] Tests proving the agent cannot stage, commit, switch, push, merge, or alter `.git/**`.

Exit gate:

```text
final result reflects actual checkout mutation and no Git write was performed
```

---

## Phase 10 — LLM Integration

- [ ] Provider-neutral model adapter.
- [ ] Tool schema conversion.
- [ ] Task prompt contract.
- [ ] Repository content marked as untrusted.
- [ ] Bounded tool result injection.
- [ ] Model retry budget.
- [ ] Model error handling.
- [ ] Deterministic mock ModelClient that exercises the full orchestration loop.
- [ ] One real ModelClient and a small end-to-end integration test before usable-MVP release.

Exit gate:

```text
LLM can reason about task but cannot bypass deterministic authority
```

---

## Phase 11 — Agent Loop

- [ ] Inspection state.
- [ ] Plan state.
- [ ] Mutation state.
- [ ] Verification state.
- [ ] Bounded repair loop.
- [ ] Review state.
- [ ] Final summary.
- [ ] Budget exhaustion path.
- [ ] Cancellation path.

Exit gate:

```text
fixture task completes end-to-end or terminates with typed failure
```

---

## Phase 12 — Audit & Observability

- [ ] Structured audit schema with stable event_id, session_id, timestamp, event type, policy decision, and bounded result metadata.
- [ ] Append-only JSONL file per session in application-local storage as canonical evidence.
- [ ] Reader filters by session, event type, tool, path, decision, and time.
- [ ] Any later database is a rebuildable index, never a writable authority.
- [ ] Tool request events.
- [ ] Policy decision events.
- [ ] Execution result events.
- [ ] State transition events.
- [ ] Redaction layer.
- [ ] Correlation IDs.
- [ ] Basic metrics.

Exit gate:

```text
a completed task can be reconstructed from metadata without exposing secrets
```

---

## Phase 13 — Interactive CLI

- [ ] Start an in-memory session from the terminal.
- [ ] Display a labeled Ask / Edit mode selector with a typed fallback.
- [ ] Preserve conversation when the developer changes mode.
- [ ] Revoke file permissions when entering Ask; returning to Edit starts without permissions.
- [ ] /clear and exit discard context and permissions while leaving applied edits in place.
- [ ] Show task state and recent actions while work continues.
- [ ] Answer informational questions about the active task without stopping it.
- [ ] Stop only on an explicit stop request or a required blocking decision.
- [ ] Show the final diff and verification report for human review.
- [ ] CLI integration tests.

Exit gate:

```text
developer can run and inspect both MVP workflows from the terminal
```

---

## Deferred — API and Web Interface

- [ ] Submit task endpoint.
- [ ] Task status endpoint.
- [ ] Result endpoint.
- [ ] Health/live endpoint.
- [ ] Health/dependency endpoint.
- [ ] Request size bounds.
- [ ] API integration tests.

Exit gate:

```text
external client can start and inspect a task without directly accessing tools
```

---

## Phase 14 — CI/CD

- [ ] Pull request CI.
- [ ] Unit tests.
- [ ] Integration tests.
- [ ] Security/boundary tests.
- [ ] Lint.
- [ ] Typecheck.
- [ ] Dependency vulnerability scan.
- [ ] Secret scan.
- [ ] Build/container smoke test.
- [ ] Required status aggregation.

Exit gate:

```text
no merge when required quality/security gates fail
```

---

## Phase 15 — MVP Security Sign-Off

Required adversarial scenarios:

- [ ] unknown tool;
- [ ] malformed tool schema;
- [ ] path traversal;
- [ ] symlink escape;
- [ ] forbidden secret file;
- [ ] shell injection attempt;
- [ ] repository prompt injection;
- [ ] output flooding;
- [ ] infinite test process;
- [ ] policy engine crash;
- [ ] sandbox startup failure;
- [ ] budget exhaustion;
- [ ] network attempt.

Exit gate:

```text
all scenarios fail safely
```

---

## Phase 16 — MVP Demonstration

Reference demo task:

```text
Given a fixture repository with a defect in calculate_discount(),
locate the implementation, fix the bug without changing its public API,
run the relevant tests, and return the diff and verification result.
```

Expected trace:

```text
Task admitted
→ sandbox created
→ capabilities sealed
→ code searched
→ file read
→ plan recorded
→ patch applied
→ tests run
→ optional bounded repair
→ final diff collected
→ result emitted
→ sandbox destroyed
```

Acceptance:

- [ ] Correct bug fix.
- [ ] Tests pass.
- [ ] No unrelated files changed.
- [ ] No unauthorized tool requests executed.
- [ ] Complete audit trace exists.
- [ ] Sandbox destroyed.

---

## Deferred Backlog

- [ ] Web interface.
- [ ] Separate Git worktrees.
- [ ] Persistent/restorable session history and retention policy.
- [ ] Agent-performed Git writes.
- [ ] Changes to active-task scope through conversation.
- [ ] GitHub App authentication.
- [ ] Automatic PR creation.
- [ ] CI status polling.
- [ ] Dependency installation capability.
- [ ] Network egress proxy.
- [ ] Secret broker.
- [ ] Reviewer agent.
- [ ] Long-term repository memory/index.
- [ ] Multi-agent workflows.
- [ ] Agent terminal-command capability under a separately designed sandbox and authorization policy; arbitrary shell remains denied in the MVP.
- [ ] Staging deploy.
- [ ] Production deploy.
- [ ] Canary and rollback.
- [ ] SBOM/provenance signing.

---

## Final Security Acceptance Checklist

- [ ] Repository results retain source-path and retrieval-method provenance.
- [ ] Repository text cannot enter system-level instructions or change policy.
- [ ] Write symlinks and path swaps are rejected at point of use.
- [ ] Permission binds canonical path and update/create operation.
- [ ] Create fails if the target exists.
- [ ] Modified verification config is deferred to a later validated session.
- [ ] Canonical JSONL, event hash chain, and manifest verify deterministically.
- [ ] BUDGET_EXHAUSTED records budget, limit, usage, and audit ordering.
