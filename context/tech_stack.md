# Technology Stack

This page records approved implementation choices and keeps undecided choices explicit. It separates the language used to build slop-loop from the languages and tools used by repositories slop-loop will work on.

## Approved choices

| Area | Choice | Scope |
|---|---|---|
| slop-loop implementation | TypeScript | Core coding-agent runtime |
| Runtime toolchain | Node.js 24 LTS, pnpm@12.5.1 | Phase 1 bootstrap; frozen pnpm-lock.yaml |
| Compiler and build | TypeScript 6.0.3, strict NodeNext ESM | pnpm run typecheck / pnpm run build |
| Runtime test runner | Node.js built-in test runner | pnpm run test:runtime; compiled TypeScript tests |
| Mechanical lint | ESLint 10.12.0, @eslint/js 10.0.1, globals 17.13.0, typescript-eslint 8.71.2 | pnpm run lint |
| Mechanical formatting | Prettier 3.9.10, single quotes, printWidth 200, `endOfLine: auto` for the CRLF working copy | pnpm run format:check |
| Workflow orchestration | `@langchain/langgraph` | Retain the official TypeScript implementation as the orchestration library |
| Initial target repositories | Python with `pytest` | Repositories the runtime will initially operate on |
| Task execution environment | Docker | Agent loop and trusted harness on host; repository and Python/pytest tooling in task container; host-side tools use Docker execution directly; see [ADR-0003](../docs/adr/0003-docker-task-workspace-boundary.md) |

Phase 1 provides the strict TypeScript/LangGraph build and a dependency smoke test. Phase 2 canonical validators use TypeScript and Node built-ins without a schema dependency; they do not provide the UC-03 workflow or select a production provider. [pnpm-workspace.yaml](../pnpm-workspace.yaml) makes pnpm's default 24-hour dependency release-age policy explicit. The lock selects compatible core 1.2.17 and LangSmith 0.10.13 after CI rejected the newer imported releases; no age exclusion or trust bypass is configured. Exact direct versions are pinned in [package.json](../package.json) and transitive versions in [pnpm-lock.yaml](../pnpm-lock.yaml). The user confirmed shared-contract agreement, completed Phase 1 bootstrap and authorized Phase 2 canonical validators and test-only mocks; [decisions](../specs/001-verified-code-repair/contracts/decisions.md) retains production release gates.

## Existing contributor helpers

The repository has Node.js ES module agent helpers under `scripts/agents/` with tests under `tests/agents/`. CI validation scripts and their tests live under `scripts/ci/` and `tests/ci/`. The existing helper test command uses Node's built-in test runner and requires Node.js 20 or newer; see [testing guidance](testing.md).

Contributor helpers retain their existing Node.js commands. The separately selected runtime bootstrap uses the tools listed above; helper test results do not prove runtime behavior.

## Open decisions

No choice is recorded yet for:

- a CLI or service framework;
- the LLM provider and model;
- the persistence and LangGraph checkpoint backend;
- the concrete Docker isolation configuration;
- deployment and supported operating environments;
- the evaluation harness and reporting format; a controlled-tier `uc03-workflow-evaluation/1` report contract exists in `eval/uc03/`, but the harness and reporting choice is not closed by it;

Treat these as open until an implementation decision is explicitly recorded. Do not infer them from the existing helper scripts or tests.

The recovered Feature 007 v0.2 route, bootstrap, evaluator and CLI reuse existing modules and Node built-ins; recovery adds no dependency, persistence backend, provider or isolation choice. Feature 007 Phase 4–5 added no dependency. Workflow comparison is a pure function in `eval/uc03/compare.ts`, diagnostics reuse the existing `src/foundation/telemetry.ts` sanitizers, and the local console uses built-in `node:http`. There is still no CLI or service framework choice and no `serve` CLI command. `createConsoleServer` is called only by `tests/runtime/unit/evaluation-console.test.ts`, so its source implementation has no production/CLI server consumer. `runEvaluateCli` supports host-file `status`, `decision`, `direction` and `continue` only when the trusted assembly supplies valid control bindings; this does not launch the console. `createEvaluationService` stores experiments, receipts and active ID in process-local `Map`s (`src/runtime/evaluation-service-lifecycle.ts`); it does not provide durable sessions or restart recovery.
