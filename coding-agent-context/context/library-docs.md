# Library Docs

Project-specific usage rules for third-party libraries in the Slop Loop MVP.

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

The selected Phase 0 implementation and development stack is Node.js 24 LTS, native ESM TypeScript, pnpm, Zod 4, Pino, Vitest, type-aware ESLint, Prettier, and tsc. There is no bundler. Selection does not indicate implementation completion; `context/progress-checker.md` is the source of truth. The first target repositories are TypeScript repositories, initially Slop Loop itself, using trusted pnpm verification profiles. Docker verification is planned for Phase 5 but is not implemented; process adapters, Git, provider HTTP, audit persistence, and session behavior are also future product concerns.

Phase 4 uses the pinned `node-gyp` development dependency to build one in-process Node-API addon for workspace filesystem enforcement. The addon must be built with `pnpm native:build` on each supported host before native-boundary evidence is accepted. A manually compiled MinGW addon is useful for local Windows diagnosis but does not satisfy the pinned native-build gate or replace Ubuntu and Windows CI verification.

---

## Node.js Runtime and pnpm

Use Node.js 24 LTS APIs and native ESM. pnpm is the only package manager; pin its version and commit the lockfile. Use tsc for the private dist/ artifact and do not add a bundler in Phase 0.

The Phase 0 scripts are pnpm format for intentional rewrite, pnpm format:check for verification only, pnpm lint, pnpm typecheck, pnpm test for Vitest source behavior, pnpm build, and pnpm smoke for node dist/index.js.

## Zod 4

Use Zod 4 for runtime validation. At external or model-facing boundaries, validate before policy or execution. In Phase 0, accept only `SLOP_LOOP_LOG_LEVEL`, default it to `info`, reject unknown `SLOP_LOOP_*` names, and ignore unrelated environment variables. The environment map may be injectable for tests; return a typed, frozen configuration result.

The Phase 2 registry uses one strict Zod argument object per fixed tool name. `z.toJSONSchema` derives provider-neutral Draft 2020-12 input schemas with `io: 'input'`, `cycles: 'throw'`, and `unrepresentable: 'throw'`. Keep string length limits consistent with JSON Schema Unicode code-point semantics and test the advertised/runtime contract for every tool. Schema conversion is metadata only; authorization and execution belong to later phases.

## Pino

Use Pino only for operational logging through a small `createLogger` factory with fixed redaction and injectable output for tests. Put untrusted repository, model, and tool data under application-controlled fields. Redaction is defense in depth, not an authorization boundary, and Pino logs are not canonical audit evidence.

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

```ts
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
- Each verification check uses a fresh offline Linux container cloned from the same captured snapshot for its profile verdict; there are no supporting services in the MVP.
- Keep the system directories, toolchain, and root filesystem read-only. Only the copied snapshot/build artifacts under `/workspace` and `/tmp` are writable. Never mount the developer checkout writable or copy results back automatically.
- Filter the workspace snapshot to include current working-tree edits and eligible untracked files while excluding `.git`, denied secrets, nested repositories, host `node_modules`, and stale/generated artifacts.
- Target-repository content/configuration/code is untrusted; only trusted runtime configuration determines authority and execution policy.
- Preparation is developer-triggered. Fetch only exact locked artifacts from approved public registries with lifecycle/build scripts disabled and restricted network; validate sources, reject destinations/redirects outside the allowlist, and verify lockfile integrity hashes. Unsupported sources and integrity failures block preparation. Run any explicitly allowlisted lifecycle/build script offline only for its exact locked dependency identity; unsupported scripts block until the developer updates trusted configuration. The target repo Dockerfile is never executed or allowed to select privileges, mounts, network, or build instructions. Repository-owned native compilation uses a separate trusted profile. Never give preparation secrets, sensitive host directories, the Docker socket, or a writable real-checkout mount. Feature 006 selects Q18/Q21 mechanisms pending implementation and adversarial proof.
- Fingerprint manifests, lockfile, approved package-manager configuration, exact-identity script allowlist, Node/pnpm versions, Linux architecture, base-image digest, and application-owned preparation recipe. Reject stale images pending developer preparation; never install automatically.
- Rebuild repository-owned native addons offline from the captured snapshot inside each check container with the prepared toolchain; missing prerequisites block execution.
- Treat repository code and dependency scripts as malicious. The MVP accepts hardened Docker with documented residual isolation limits; a dedicated VM is deferred for future reconsideration.
- Cleanup uses bounded retries, blocks further verification if container stop/removal remains unconfirmed, reports identity/state, and reconciles only Slop Loop-owned resources at startup. Never fall back to host execution.
- A minimal preparation helper is a Phase 5 developer-facing operation. On a stale image, explain/report the state and offer/start preparation only after explicit developer confirmation; the model cannot initiate it or enable networking. The later interactive CLI may expose the helper (Q22).
- Initial CPU/memory/PID/time defaults are selected and require Phase 5 integration validation. Initial output and writable-storage bounds are selected in the Feature 006 plan and require integration proof; see ADR 0011 Q14.
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
- `shell: true` is forbidden.
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

## TypeScript target verification

The first targets are TypeScript repositories, initially Slop Loop itself. Trusted profiles use pnpm test (Vitest), pnpm lint (ESLint), pnpm typecheck (tsc), and pnpm build. Profile argv and limits are runtime-owned; the model cannot supply shell commands or arbitrary scripts. Package scripts and dependencies are untrusted repository code and execute only inside the sandbox. Results include bounded output and exit status; failures do not authorize weakening checks.

The reference toolchain is Node.js 24 and pnpm 12.5.1, pinned by package.json. A separate developer-triggered preparation step produces a versioned verification image containing dependencies and build tools. One profile verdict captures one workspace-filtered snapshot; each check runs in a fresh offline Linux container clone of those same captured bytes. There are no supporting services. Fingerprint drift blocks verification until developer preparation; ordinary source edits do not invalidate the image. Verification cannot enable network or fall back to host execution. These are planned profiles, not implemented sandbox capability.

---

## Phase 5 preparation and native build decisions

Dependency downloading uses restricted networking with lifecycle/build scripts disabled. Only exact locked dependency identities from approved public registries may be fetched. Trusted preparation validates destinations and redirects and verifies lockfile integrity hashes; unsupported sources and integrity failures block preparation. Feature 006 selects the mechanism pending implementation and adversarial proof. A dependency lifecycle/build script may execute only offline when trusted configuration allowlists that exact locked identity; unsupported scripts block preparation until the developer updates trusted configuration. The allowlist is included in the preparation fingerprint. Target Dockerfiles are never executed or allowed to set privileges, mounts, network, or build instructions. Repository-owned native compilation uses a separate trusted profile. Preparation is developer-triggered and never agent-triggered.

The image fingerprint covers manifests, lockfile, approved package-manager configuration, exact-identity lifecycle/build-script allowlist, Node/pnpm versions, Linux architecture, base-image digest, and application-owned preparation recipe. Ordinary source edits do not invalidate it; fingerprint drift requires explicit preparation. Repository-owned native addons rebuild offline from the captured source in each fresh check container under a separate trusted profile, using image-provided compiler tools, Python where needed, and matching Node headers. Dependency-owned native components may be prepared once. Missing prerequisites block verification. Snapshot bytes are hashed into a manifest, checked for observed capture races with bounded retries, and compared with the live checkout after checks. Capture is non-atomic and cannot exclude rapid change-and-restore races; watchers are advisory. See ADR 0011 Q16.

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

The planned provider-ready prototype will use a deterministic mock. Provider selection is deferred; usable-MVP release requires one real adapter and a small end-to-end integration test.

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
