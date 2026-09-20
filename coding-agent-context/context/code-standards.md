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

## TypeScript and Node.js

- Use Node.js 24 LTS and TypeScript in strict mode.
- Use native ESM and tsc; no bundler in Phase 0.
- Use pnpm only, with a pinned package-manager version and committed lockfile.
- Compile the private application to dist/.
- Do not use eval, Function constructors, dynamic model-controlled imports, or unsafe deserialization.
- Keep future process execution, filesystem mutation, network access, and secrets behind deterministic adapters.

Phase 0 source structure is limited to config.ts, logging.ts, and index.ts. Future architectural modules and test directories are introduced only when their first real behavior exists.

Phase 0 commands are: pnpm format for intentional rewrite; pnpm format:check for verification only; pnpm lint; pnpm typecheck; pnpm test for Vitest source tests; pnpm build; and pnpm smoke for node dist/index.js.

The repository policy says coding agents format only files they intentionally modify. This is a code-standard policy, not a Phase 0 model capability.

## Runtime Validation (Zod 4)

Use Zod 4 for strict runtime configuration and future external/model contracts. Prefer closed objects, explicit enums, bounded strings and collections, and validation before policy or execution.

Phase 0 recognizes only SLOP_LOOP_LOG_LEVEL under the SLOP_LOOP_* namespace, defaults it to info, rejects unknown prefixed names, accepts an injectable environment map, and returns typed frozen configuration.

Rules:
- Reject unknown keys where a closed object is intended.
- Do not pass unvalidated plain objects into policy, tools, logging, or execution.
- Validation errors must never trigger privileged work.

## Module Boundaries

Phase 0 has no real subsystem modules and does not enforce a dependency graph. Do not create speculative orchestration, policy, tools, sandbox, audit, or repository directories.

When those boundaries appear with real behavior, keep contracts narrow and maintain this direction:

```text
interfaces / contracts
  ↓
orchestration
  ↓
policy and capability checks
  ↓
tools and verification
  ↓
sandbox / repository / integrations
```

Rules:
- model adapters cannot authorize actions;
- tools cannot bypass policy;
- policy cannot depend on model responses;
- sandbox contains no model logic;
- audit remains observational, never an authorization dependency;
- the composition root may wire concrete adapters;
- circular dependencies are forbidden.


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
for (let step = 0; step < budget.maxSteps; step += 1) {
  const transition = runner.step(state);
  if (transition.terminal) break;
}
// Exhaustion is handled as a typed terminal outcome.
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

Slop Loop source behavior uses Vitest. Every behavior should be tested at the lowest useful level.

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

### TypeScript

- files: descriptive kebab-free names such as config.ts and logging.ts;
- functions and variables: camelCase;
- types, interfaces, classes, and enums: PascalCase;
- constants: UPPER_SNAKE_CASE when genuinely constant;
- avoid vague names such as Manager, Helper, Data, Thing, or Utils2;

### Domain Names

Prefer explicit security semantics:

```text
ToolCapability
PolicyDecision
SandboxExecutionSpec
VerificationResult
TaskBudget
WorkspaceBoundary
```

Python naming rules apply only inside target repositories, not to Slop Loop implementation.

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


