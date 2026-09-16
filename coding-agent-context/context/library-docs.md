# Library Docs

Project-specific usage rules for third-party libraries in the Coding Agent MVP.

This file describes **how this project uses libraries**, not their complete upstream documentation.

---

## Before Using Any Library

Read in this order:

1. `AGENTS.md` if present.
2. `context/tool-policy.md` for capability/security constraints.
3. `context/code-standards.md` for implementation rules.
4. This file for project-specific library patterns.
5. Upstream documentation only when necessary.

Order of authority:

```text
Explicit project policy
→ tool-policy.md
→ code-standards.md
→ library-docs.md
→ upstream docs
→ model training knowledge
```

No library feature may be used to bypass project policy.

---

## FastAPI

### Purpose

Thin HTTP boundary for:

- task submission;
- task/result lookup;
- health endpoints.

### Rules

- Routes validate request models using Pydantic.
- Routes never call sandbox/process adapters directly.
- Routes delegate to application/orchestration services.
- Internal exceptions map to stable error responses.
- Health endpoints do not invoke the LLM.

Example:

```python
@router.post("/tasks", response_model=TaskAccepted)
async def create_task(
    request: CreateTaskRequest,
    service: TaskService = Depends(get_task_service),
) -> TaskAccepted:
    return await service.create(request)
```

---

## Pydantic v2

### Purpose

Strict validation for:

- API payloads;
- tool calls;
- tool outputs;
- capability manifests;
- policy configuration;
- audit events.

### Required Pattern

```python
from pydantic import BaseModel, ConfigDict, Field

class ReadFileArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=1024)
    max_bytes: int = Field(default=65536, ge=1, le=65536)
```

### Rules

- `extra="forbid"` for model-produced contracts.
- Use enums/Literals for closed value sets.
- Bound arrays and strings.
- Do not pass unvalidated `dict` objects into tool execution.

---

## Docker SDK / Docker CLI Adapter

### Purpose

Create ephemeral task sandboxes.

The project should isolate Docker-specific behavior behind `SandboxBackend`.

Conceptual interface:

```python
class SandboxBackend(Protocol):
    async def create(self, spec: SandboxSpec) -> SandboxHandle: ...
    async def execute(
        self,
        handle: SandboxHandle,
        spec: ExecutionSpec,
    ) -> ExecutionResult: ...
    async def destroy(self, handle: SandboxHandle) -> None: ...
```

### Rules

- Never expose Docker socket to the task container.
- Never mount host `/`.
- Run as non-root where supported.
- Network is disabled by default.
- Mount only the task workspace writable.
- Explicitly set memory/CPU/PID limits.
- Always destroy sandboxes in cleanup/finally paths.
- Image selection comes from trusted config, never model output.

---

## subprocess

### Purpose

Internal implementation detail for trusted host-side adapters only.

### Required Pattern

```python
result = subprocess.run(
    argv,
    cwd=workspace,
    env=safe_env,
    shell=False,
    capture_output=True,
    timeout=timeout_seconds,
    check=False,
)
```

### Rules

- Never execute model-provided shell strings.
- `shell=True` is forbidden.
- Executable and argument shape must come from an approved command profile.
- Environment is allowlisted.
- stdout/stderr are bounded and redacted.
- Prefer sandbox execution over host execution.

---

## Git

### Purpose

Repository evidence and local workspace operations.

Allowed MVP operations:

```text
git status --porcelain
git diff --no-ext-diff
git diff --cached --no-ext-diff
git rev-parse --show-toplevel
```

Optional:

```text
git switch -c agent/<task-id>
```

### Rules

- Git commands execute only in validated workspace.
- No `push`, `merge`, `reset --hard`, `clean -fdx`, `rebase`, or force operations in MVP.
- Do not use Git configuration to execute external helpers.
- Final reported diff must be generated deterministically from the workspace.

---

## pytest

### Purpose

Primary Python test runner.

### Usage

The model does not construct arbitrary pytest shell commands.

Trusted verification profile:

```yaml
tests:
  argv: ["pytest", "-q"]
  timeout_seconds: 120
```

### Rules

- Test invocation is config-owned.
- Exit code and bounded output are returned.
- Test failures are evidence, not permission to alter tests.
- Security tests run in CI and before release.

---

## Ruff

### Purpose

Linting and formatting checks.

Recommended profile:

```yaml
lint:
  argv: ["ruff", "check", "."]
  timeout_seconds: 60
```

Formatting should initially be a separate explicit operation rather than a hidden side effect.

---

## mypy

### Purpose

Static type checking for production modules.

Recommended profile:

```yaml
typecheck:
  argv: ["mypy", "src"]
  timeout_seconds: 120
```

Do not weaken global type rules to resolve a local implementation issue without explicit approval.

---

## SQLite

### Purpose

Local MVP persistence for:

- tasks;
- agent runs;
- tool call metadata;
- artifact references.

### Rules

- Database access is not exposed as a model tool.
- Use parameterized queries or an ORM.
- Do not store raw secrets.
- Repository file contents do not need to be copied into the database.
- Keep schema portable enough to migrate to PostgreSQL.

---

## PostgreSQL

### Purpose

Recommended later persistence backend for multi-user/server deployments.

Use transactions for multi-record lifecycle updates such as:

```text
task terminal transition
+ final run status
+ artifact metadata
```

Model-generated SQL is forbidden.

---

## HTTP Client (`httpx`)

### Purpose

Deterministic provider integrations such as model API or Git provider API.

Rules:

- User/repository text cannot choose arbitrary destinations.
- Base URLs are trusted configuration.
- Apply connect/read timeouts.
- Limit response sizes.
- Redact auth headers from logs.
- Do not automatically follow redirects across trust boundaries without validation.

---

## OpenTelemetry

### Purpose

Optional tracing and metrics.

Recommended correlation fields:

```text
task_id
run_id
step_id
tool_name
policy_decision
```

Forbidden high-cardinality or sensitive labels:

```text
raw_prompt
source_code
token
secret
full_command_output
```

---

## LLM Provider Adapter

No provider SDK may be imported throughout the codebase.

Wrap the provider behind:

```python
class ModelClient(Protocol):
    async def complete(self, request: ModelRequest) -> ModelResponse: ...
```

Rules:

- Provider keys remain outside model context.
- Tool schemas are generated from the closed registry.
- Tool responses are bounded before they return to the provider.
- Provider retries obey task budgets.
- Provider switching must not alter authorization semantics.

---

## GitHub Integration — Future

When added, isolate behind a dedicated Git provider interface.

Possible capabilities:

```text
read_repository_metadata
create_branch
push_agent_branch
create_pull_request
read_ci_status
```

Never grant:

```text
admin repository
delete repository
bypass branch protection
organization owner
unrestricted workflow secret access
```

Use short-lived/scoped credentials when possible.

---

## Dependency Installation

MVP rule:

```text
Agent cannot autonomously install dependencies.
```

If verification fails because a dependency is missing, return a structured blocker.

Future dependency installation requires:

- explicit policy capability;
- registry allowlist;
- version constraint validation;
- network egress restriction;
- supply-chain scanning.
