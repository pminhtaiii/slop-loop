# Progress Tracker

This file records implemented reality.

Do not mark a capability complete because it appears in architecture or planning documents. A capability is complete only when its implementation and required verification exist.

---

## MVP Status

Overall status:

```text
PLANNING / CONTEXT FOUNDATION
```

The TypeScript/Node 24 single-process foundation and Phase 0 design frontier are recorded. Runtime implementation status must be updated as code is built.

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

- [ ] Define `TaskContext`.
- [ ] Define task state enum.
- [ ] Implement validated transitions.
- [ ] Implement task budgets.
- [ ] Implement terminal outcomes.
- [ ] Add transition unit tests.
- [ ] Add retry/budget exhaustion tests.

Exit gate:

```text
task cannot enter illegal state
task always terminates under finite budget
```

---

## Phase 2 — Closed Tool Registry

- [ ] Define tool contract.
- [ ] Define strict tool call schema.
- [ ] Implement closed registry.
- [ ] Reject unknown tools.
- [ ] Generate model-visible schemas only from allowed registry entries.
- [ ] Add registry security tests.

MVP tool targets:

- [ ] `list_files`
- [ ] `search_code`
- [ ] `read_file`
- [ ] `apply_patch`
- [ ] `run_tests`
- [ ] `run_build`
- [ ] `run_linter`
- [ ] `run_typecheck`
- [ ] `git_diff`

Exit gate:

```text
model cannot invoke or register an unknown tool
```

---

## Phase 3 — Policy Engine & Capabilities

- [ ] Define `ToolCapability`.
- [ ] Define `PolicyDecision`.
- [ ] Seal capabilities during task admission.
- [ ] Recheck capability on every tool call.
- [ ] Implement default deny.
- [ ] Implement tool allowlist.
- [ ] Implement read/write path capabilities.
- [ ] Implement budget checks.
- [ ] Fail closed on policy exception.
- [ ] Add negative authorization tests.

Exit gate:

```text
no tool executes without explicit capability
policy failure cannot become ALLOW
```

---

## Phase 4 — Workspace Boundary

- [ ] Implement workspace canonicalization.
- [ ] Block `..` traversal.
- [ ] Block absolute path escape.
- [ ] Block symlink escape.
- [ ] Add denied secret path patterns.
- [ ] Bound read sizes.
- [ ] Bound search results.
- [ ] Add adversarial filesystem tests.

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
- [ ] Revoke file permissions on `/clear`, exit, and switching to `Ask`; make affected grants unavailable on branch drift or relevant external file change.
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
- [ ] `git_diff`.
- [ ] Detect branch switches without switching branches for the user.
- [ ] Reauthorize affected prior path-operation grants only when a later task needs them.
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


