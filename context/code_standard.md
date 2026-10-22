# Backend Code Standards

These standards apply to the slop-loop runtime written in <!-- context-fact: runtime-language -->TypeScript<!-- /context-fact --> and orchestrated with <!-- context-fact: orchestrator -->`@langchain/langgraph`<!-- /context-fact -->. They do not describe the Python repositories the runtime operates on. The approved runtime choices and open decisions are recorded in [Technology stack](tech_stack.md). Existing contributor helpers under `scripts/agents/` and CI checks under `scripts/ci/` remain Node.js `.mjs` modules and should keep their current conventions.

## Engineering discipline

Before changing code, establish the task scope and relevant repository evidence. Implement the smallest readable solution that meets the requirements. Reuse existing helpers before adding dependencies, and avoid speculative abstractions. Add comments to explain non-obvious reasons or constraints, not to restate the code.

## Types and boundaries

Use strict TypeScript. Treat untrusted input and external data as `unknown`; validate and narrow them before use. Never use `any`, including in casts or library wrappers. Assert only when a runtime check or trusted invariant establishes what TypeScript cannot express; keep the assertion local and explain the invariant. Prefer `const`, and mark values and fields `readonly` when mutation is outside their contract.

Give exports and public object boundaries explicit parameter and return types; infer simple local and private types. Use object types for data, unions for finite variants, and discriminated unions when callers branch on results. Use interfaces for extendable contracts or class implementations. Name files kebab-case, values and functions camelCase, and types and classes PascalCase. Prefer named exports and `import type` for type-only imports.

Validate configuration, model output, tool arguments, persisted state, and provider responses at runtime; TypeScript annotations do not validate data. Check configuration at startup and fail fast with a clear, safe error. Keep provider credentials inside the explicit provider boundary and repository secrets outside model-visible or tool-visible data. Follow [runtime_policy.md](runtime_policy.md) for the distinction between trusted provider configuration, protected payloads, and approved trace data.

## Module and runtime boundaries

Organize modules around capabilities, with small public interfaces and acyclic dependencies. CLI and HTTP adapters parse input, call a use case, and translate typed outcomes into process exits or protocol responses. Keep workflow and domain decisions in control modules; put tool execution, persistence, and provider IO behind separate boundaries. Do not assume an HTTP framework or health endpoint exists.

Pass dependencies through parameters or constructors so they are visible at call sites and replaceable in focused checks; no dependency injection framework is required. Keep policy decisions in deterministic code; model suggestions and prompts do not replace validation or authorization. See [Architecture](architecture.md) and [Tools and permissions](tools_permissions.md) for ownership and policy boundaries.

A public wrapper that only forwards across a port is an intentional boundary: pass input through, preserve the typed result, and add no policy, persistence, or duplicate effect. On validation or permission refusal, return the typed refusal without changing persisted state or invoking downstream effects.

## LangGraph workflow code

Define graph state with explicit types and fields needed for transitions, recovery, and verification. Validate node inputs and restored checkpoints at runtime. Nodes return typed partial updates for fields they own; avoid shared-state mutation or silently overwriting unrelated fields. Keep reducers and merge behavior explicit for fields that can receive multiple updates.

Keep node logic deterministic where practical, and route tool, provider, and persistence side effects through explicit boundaries. Retry only transient failures, and only when an operation is idempotent or guarded against duplicate effects; never blindly retry mutations or permission denials. Check cancellation, bound timeouts and retry counts, and clean up resources in `finally` or equivalent. Checkpointing may replay nodes, so in-memory flags cannot prevent duplicate effects. See [State and memory](state_and_memory.md) for recovery requirements.

## Outcomes, failures, and logs

Model expected failures as typed, discriminated outcomes callers handle explicitly, such as validation rejection, permission denial, timeout, or a tool result. Let unexpected programming or infrastructure exceptions reach the workflow boundary for recording and safe task failure. Catch only to add context, recover, translate, or clean up. Catch-log-rethrow wrappers add noise and duplicate logs.

Emit structured logs with stable event names and task ID, run ID, node, tool, duration, and outcome fields. Sanitize user-controlled strings and never log raw prompts, credentials, environment values, raw tool content, or protected repository data. Follow [runtime_policy.md](runtime_policy.md) for permitted metadata, sanitized approved command details, bounded diagnostics, and protected artifact references; [tools_permissions.md](tools_permissions.md) defines protected data and access boundaries.

## Verification

Follow [Testing guidance](testing.md) for contributor checks and reporting. Add behavioral coverage for boundary validation, permission outcomes, workflow updates, retry limits, cancellation, and recovery as those behaviors are implemented. This document does not choose a test framework or runtime dependencies; see open decisions in [Technology stack](tech_stack.md). Report only checks actually run.
