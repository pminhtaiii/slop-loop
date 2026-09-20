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

## MVP Classification

Phase 0 implementation dependencies are Node.js 24 LTS, native ESM TypeScript, pnpm, Zod 4, Pino, Vitest, type-aware ESLint, Prettier, and tsc. There is no bundler. pytest, Ruff, and mypy are trusted verification tools in the first Python target repositories, not Slop Loop dependencies. Docker, process adapters, Git, provider HTTP, audit persistence, and session behavior are future product concerns.

---

## Node.js Runtime and pnpm

Use Node.js 24 LTS APIs and native ESM. pnpm is the only package manager; pin its version and commit the lockfile. Use tsc for the private dist/ artifact and do not add a bundler in Phase 0.

The Phase 0 scripts are pnpm format for intentional rewrite, pnpm format:check for verification only, pnpm lint, pnpm typecheck, pnpm test for Vitest source behavior, pnpm build, and pnpm smoke for node dist/index.js.
## HTTP Transport — Future

A future HTTP boundary may submit tasks and return status/results. It remains a thin transport layer, validates external input with Zod, delegates to orchestration, never invokes tools directly, and never embeds policy logic. The framework is intentionally undecided.
## Vitest, ESLint, and Prettier

Vitest tests Slop Loop source behavior and must not depend on dist/ existing. ESLint uses type-aware TypeScript rules. Prettier is explicit: pnpm format rewrites intentionally and pnpm format:check verifies without changing files.

Coding agents format only files they intentionally modify; this is repository policy, not a Phase 0 model capability.

## Docker SDK / Docker CLI Adapter

### Purpose

Create ephemeral task sandboxes.

The project should isolate Docker-specific behavior behind `SandboxBackend`.

Conceptual interface:

```python
interface SandboxBackend {
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  execute(handle: SandboxHandle, spec: ExecutionSpec): Promise<ExecutionResult>;
  destroy(handle: SandboxHandle): Promise<void>;
}
```

### Rules

- Never expose Docker socket to the task container.
- Never mount host `/`.
- Run as non-root where supported.
- Network is disabled by default.
- Copy the current repository state into an ephemeral sandbox workspace. Never mount the developer checkout writable.
- Explicitly set memory/CPU/PID limits.
- Always destroy sandboxes in cleanup/finally paths.
- Image selection comes from trusted config, never model output.

---

## Node.js Process Execution

### Purpose

Internal implementation detail for trusted adapters only. Node child_process APIs remain behind a deterministic execution adapter.

### Required Pattern

~~~ts
const result = await executor.run({
  argv,
  cwd: workspace,
  env: safeEnv,
  timeoutMs,
  shell: false,
});
~~~

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

### Rules

- Git commands execute only in the validated current checkout.
- The adapter may read repository root, branch, `HEAD`, status, and diff.
- The developer performs branch switches, staging, commits, and remote operations.
- No Git write operation is exposed in the MVP, including writes to `.git/**`.
- Do not use Git configuration to execute external helpers.
- Final status and diff evidence must be generated deterministically from the checkout.

---

## pytest

### Purpose

Primary test runner for Python target repositories; it is not a Slop Loop implementation dependency.

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

Linting and formatting checks for Python target repositories; it is not a Slop Loop implementation dependency.

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

Static type checking for Python target repositories; it is not Slop Loop's TypeScript checker.

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

Possible later rebuildable indexing of canonical JSONL audit evidence for:

- tasks;
- agent runs;
- tool call metadata;
- artifact references.

### Rules

- JSONL remains the canonical writable audit authority; the database is rebuilt from it.
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

## HTTP Client (Node fetch)

### Purpose

A future model-provider API adapter. Git-provider API use is future work. Node's configured fetch or another reviewed client remains behind the adapter.

Rules:

- User/repository text cannot choose arbitrary destinations.
- Base URLs are trusted configuration.
- Apply connect/read timeouts.
- Limit response sizes.
- Redact auth headers from logs.
- Do not automatically follow redirects across trust boundaries without validation.

---

## OpenTelemetry — Optional / Future

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

The provider-ready prototype uses a deterministic mock. Provider selection is deferred; usable-MVP release requires one real adapter and a small end-to-end integration test.

No provider SDK may be imported throughout the codebase.

Wrap the provider behind:

~~~ts
interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
~~~

Rules:

- Provider keys remain outside model context.
- Tool schemas are generated from the closed registry.
- Tool responses are bounded before they return to the provider.
- Provider retries obey task budgets.
- Provider switching must not alter authorization semantics.

---

## Greptile — Future Reference

Greptile is an external code-review service with Git-host and CLI workflows. It is not an MVP dependency, verification profile, or model-callable tool. If evaluated later, integrate it behind explicit network and external-service policy.

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


