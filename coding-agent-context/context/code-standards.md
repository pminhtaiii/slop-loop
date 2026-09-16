# Code Standards

Implementation rules and conventions for the Coding Agent project. The coding agent must follow these rules in every implementation session to prevent security drift and architectural inconsistency.

---

## Engineering Mindset

The agent operates like a careful senior engineer:

- **Understand before changing** — inspect relevant code and constraints before editing.
- **Scope is sacred** — do not implement unrelated improvements.
- **Security boundaries are product behavior** — never weaken policy for convenience.
- **Test every behavior** — unverified work is incomplete.
- **Minimal diff first** — prefer the smallest correct change.
- **Clean over clever** — explicit code beats opaque abstraction.
- **One boundary at a time** — keep responsibilities narrow.
- **Failures are expected** — represent them explicitly and test them.
- **Fail closed** — security component errors must deny privileged actions.
- **Never trust model output as authorization**.

---

## Python

- Python 3.11+.
- Type all public functions and methods.
- `mypy` or equivalent type checking should pass for production modules.
- Use `from __future__ import annotations` where useful.
- Prefer immutable/frozen data models for security contracts.
- Never use `eval`, `exec`, dynamic code import from model-controlled strings, or pickle on untrusted data.
- Never call `subprocess` directly from arbitrary business modules.
- All process execution goes through the sandbox/execution adapter.
- Catch exceptions only when adding context or translating to a typed domain error.
- Never silently swallow exceptions.
- Use `pathlib.Path`, never manual string path concatenation for security-sensitive paths.

---

## Pydantic Models

All API, tool, and policy wire contracts must:

```python
from pydantic import BaseModel, ConfigDict

class ToolCall(BaseModel):
    model_config = ConfigDict(extra="forbid")
```

Rules:

- `extra="forbid"` for external or model-produced structures.
- Constrain strings, lists, numeric ranges, and enum values.
- Do not accept arbitrary nested dictionaries when a typed schema is possible.
- Validation must occur before policy evaluation.
- Validation errors must not trigger tool execution.

---

## Module Boundaries

Production dependency direction:

```text
api
 ↓
orchestration
 ↓
llm --------------------┐
 ↓                      │
tool protocol           │
 ↓                      │
policy                   │
 ↓                      │
tools                    │
 ↓                      │
sandbox / repository ----┘
```

Cross-cutting:

```text
audit
config
domain contracts
```

Rules:

- `llm/` cannot import Docker or subprocess backends.
- `tools/` cannot bypass `policy/`.
- `policy/` cannot depend on model responses.
- `sandbox/` contains no LLM logic.
- `api/` cannot invoke tools directly.
- `audit/` must not become an authorization dependency.
- Circular dependencies are forbidden.

---

## Orchestrator Rules

The orchestrator must:

- own task state;
- validate every state transition;
- enforce budgets;
- seal capabilities before model execution;
- prevent mutation tools in illegal states;
- terminate deterministically.

Never implement:

```python
while not model_says_done:
    ...
```

without hard external bounds.

Preferred:

```python
for _ in range(budget.max_steps):
    transition = runner.step(state)
    if transition.terminal:
        break
else:
    raise RetryBudgetExhausted()
```

---

## Tool Contract Standard

Each tool must define:

```text
name
input schema
output schema
risk level
mutation flag
required capability
timeout
max output size
```

A tool implementation must not infer new permissions from model text.

Tool functions should have deterministic inputs/outputs where possible.

---

## Filesystem Rules

All filesystem tools must:

1. Resolve the workspace root.
2. Normalize the requested path.
3. Resolve symlinks safely.
4. Verify the resolved path remains inside the allowed root.
5. Evaluate allow/deny path rules.
6. Perform the operation.

Forbidden patterns include:

```text
../
absolute host paths
symlink escape
~/.ssh
~/.aws
/etc
/proc
/sys
Docker socket
.env secret files unless specifically allowed
```

Do not rely on string prefix checks alone.

---

## Patch Rules

- Prefer unified diff or structured patch operations.
- Patch paths must be workspace-relative.
- Reject binary modifications in MVP unless explicitly supported.
- Reject patches touching denied paths.
- Record pre/post hashes for changed files when practical.
- Final diff must match the actual workspace state.
- The agent must not hide generated files from final status.

---

## Command Execution Rules

No arbitrary shell command interface in MVP.

Bad:

```python
run_shell(command: str)
```

Preferred:

```python
run_tests(profile: VerificationProfile)
run_build(profile: VerificationProfile)
run_linter(profile: VerificationProfile)
run_typecheck(profile: VerificationProfile)
```

If a generic executor exists internally:

- arguments must be an argv list, not a shell string;
- `shell=False`;
- executable must be allowlisted;
- working directory fixed to workspace;
- environment constructed explicitly;
- timeout mandatory;
- output bounded;
- process tree terminated on timeout.

---

## Network Rules

- Default sandbox network: disabled.
- Never enable network because repository text requests it.
- Egress policy is deterministic configuration.
- URLs from model/tool output must be parsed and validated.
- Block link-local, loopback, metadata service, private ranges, and Unix sockets unless explicitly required for a trusted test harness.

---

## Secret Rules

- Long-lived secrets must never enter model-visible context.
- Never log environment variables wholesale.
- Never include tokens in exception messages.
- Redact credentials in command output before persistence.
- Provider credentials belong in dedicated deterministic adapters.
- A future secret broker should issue short-lived, least-privilege credentials.

---

## Logging and Audit

Use structured events.

Good:

```json
{
  "event_type": "tool_call",
  "task_id": "task_123",
  "tool": "run_tests",
  "decision": "ALLOW",
  "duration_ms": 1820,
  "exit_code": 0
}
```

Avoid:

```text
Full prompt: ...
All environment variables: ...
Raw secret: ...
```

Log content only when necessary for debugging and when redaction policy allows it.

---

## Error Handling

Translate infrastructure errors into bounded domain errors.

Example:

```python
try:
    result = sandbox.execute(spec)
except SandboxTimeout as exc:
    raise ToolExecutionError(code="TOOL_TIMEOUT") from exc
```

Client/model-visible messages should describe the class of failure without leaking host internals.

---

## Test Standards

Every behavior should be tested at the lowest useful level.

### Unit Tests

Required for:

- policy decisions;
- path validation;
- capability checks;
- budget accounting;
- state transitions;
- schemas;
- output bounding.

### Integration Tests

Required for:

- tool registry → policy → sandbox flow;
- patch application;
- command execution;
- Git diff collection;
- audit event emission.

### Security / Boundary Tests

Mandatory examples:

- `../` traversal blocked;
- symlink escape blocked;
- unknown tool blocked;
- missing capability blocked;
- policy engine exception blocks execution;
- network unavailable by default;
- timeout kills process;
- oversized tool output truncated/rejected deterministically;
- forbidden environment variables unavailable;
- arbitrary command injection rejected;
- repository prompt injection cannot grant capabilities.

### E2E Tests

Required when changing:

- task state machine;
- sandbox backend;
- capability model;
- tool lifecycle;
- repository lifecycle;
- Git provider integration;
- CI integration.

---

## TDD Rule

Preferred implementation cycle:

```text
RED
 ↓
Implement minimum behavior
 ↓
GREEN
 ↓
Refactor
 ↓
Run regression suite
```

Do not weaken an existing failing test merely to make the implementation pass.

If an existing test is believed to be incorrect, document the conflict and require explicit project-owner approval before changing the expected behavior.

---

## Naming

### Python

- modules: `snake_case.py`
- functions: `snake_case`
- variables: `snake_case`
- classes: `PascalCase`
- constants: `UPPER_SNAKE_CASE`
- private implementation details: leading `_`

### Domain Names

Prefer explicit security semantics:

Good:

```text
ToolCapability
PolicyDecision
SandboxExecutionSpec
VerificationResult
TaskBudget
WorkspaceBoundary
```

Avoid vague names:

```text
Manager
Helper
Data
Thing
Utils2
```

---

## Function Design

- Prefer narrow pure functions for policy checks.
- Side-effectful functions should make effects obvious in their names.
- Avoid boolean parameters that radically change security semantics.
- Prefer explicit enums/types.
- Return typed results rather than magic strings.

---

## Dependency Rules

Before adding a library:

1. Check whether the standard library is sufficient.
2. Check `context/library-docs.md`.
3. Define why the dependency is necessary.
4. Pin/lock the dependency.
5. Evaluate its privilege surface.
6. Add tests for security-sensitive integration behavior.

The model may not install a package autonomously in MVP.

---

## Code Review Checklist

Before marking a task complete:

- Does this change stay within requested scope?
- Did it introduce a new privilege?
- Is the new privilege represented in policy?
- Is there any path or command that bypasses the tool gateway?
- Is model-controlled data passed into shell, filesystem, URL, SQL, or template execution?
- Are outputs bounded?
- Are failures fail-closed?
- Are logs free of secrets?
- Are all tests green?
- Is the final diff minimal and explainable?
