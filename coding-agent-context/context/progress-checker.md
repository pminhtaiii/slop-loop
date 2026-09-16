# Progress Tracker

This file records implemented reality.

Do not mark a capability complete because it appears in architecture or planning documents. A capability is complete only when its implementation and required verification exist.

---

## MVP Status

Overall status:

```text
PLANNING / CONTEXT FOUNDATION
```

The context package has been defined. Runtime implementation status must be updated as code is built.

The agreed first MVP is an interactive local CLI for Python repositories. It supports repository questions and a small bug fix in a separate Git worktree, approved test/build checks, progress questions during a task, and a final diff and verification report. The first model provider remains undecided. The API/web interface, active-task scope changes, and remote Git delivery are deferred. These are planned behaviors, not completed capabilities.

---

## Phase 0 — Project Foundation

- [ ] Initialize Python project and package layout.
- [ ] Configure formatter/linter/typechecker.
- [ ] Add pytest structure.
- [ ] Add configuration model.
- [ ] Add structured logging.
- [ ] Add CI baseline.
- [x] Define context architecture and development rules.

Exit gate:

```text
lint passes
typecheck passes
unit test harness runs
CI executes on pull request
```

---

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
- [ ] Workspace-only writable mount.
- [ ] Cleanup on success/failure/cancellation.
- [ ] Sandbox integration tests.

Exit gate:

```text
executable tools run only in bounded ephemeral sandbox
```

---

## Phase 6 — Read Tools

- [ ] `list_files`.
- [ ] `search_code`.
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
- [ ] Write capability enforcement.
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

- [ ] Trusted verification profiles.
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

- [ ] Workspace Git validation.
- [ ] Separate task Git worktree without changing the developer's current worktree or branch.
- [ ] `git status`.
- [ ] `git_diff`.
- [ ] Optional local task branch.
- [ ] Final diff artifact.
- [ ] Git safety tests.

Exit gate:

```text
final result reflects actual workspace mutation
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
- [ ] Mock model integration tests.

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

- [ ] Structured audit schema.
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

- [ ] Start a repository question or bug-fix task from the terminal.
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
