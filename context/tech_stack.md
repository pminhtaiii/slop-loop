# Technology Stack

This page records approved implementation choices and keeps undecided choices explicit. It separates the language used to build slop-loop from the languages and tools used by repositories slop-loop will work on.

## Approved choices

| Area | Choice | Scope |
|---|---|---|
| slop-loop implementation | TypeScript | Core coding-agent runtime |
| Runtime toolchain | Node.js 24 LTS, pnpm@12.5.1 | Phase 1 bootstrap; frozen pnpm-lock.yaml |
| Compiler and build | TypeScript 6.0.3, strict NodeNext ESM | pnpm run typecheck / pnpm run build |
| Runtime test runner | Node.js built-in test runner | pnpm run test:runtime; compiled TypeScript tests |
| Mechanical lint | ESLint 10.12.0, typescript-eslint 8.71.2 | pnpm run lint |
| Workflow orchestration | `@langchain/langgraph` | Retain the official TypeScript implementation as the orchestration library |
| Initial target repositories | Python with `pytest` | Repositories the runtime will initially operate on |
| Task execution environment | Docker | Agent loop and trusted harness on host; repository and Python/pytest tooling in task container; host-side tools use Docker execution directly; see [ADR-0003](../docs/adr/0003-docker-task-workspace-boundary.md) |

Phase 1 provides the strict TypeScript/LangGraph build and a dependency smoke test, not the UC-03 workflow. Exact direct versions are pinned in [package.json](../package.json) and transitive versions in [pnpm-lock.yaml](../pnpm-lock.yaml). The user confirmed shared-contract agreement and approved bootstrap-only scope; [decisions](../specs/001-verified-code-repair/contracts/decisions.md) retains production release gates.

## Existing contributor helpers

The repository has Node.js ES module agent helpers under `scripts/agents/` with tests under `tests/agents/`. CI validation scripts and their tests live under `scripts/ci/` and `tests/ci/`. The existing helper test command uses Node's built-in test runner and requires Node.js 20 or newer; see [testing guidance](testing.md).

Contributor helpers retain their existing Node.js commands. The separately selected runtime bootstrap uses the tools listed above; helper test results do not prove runtime behavior.

## Open decisions

No choice is recorded yet for:

- formatting tools;
- a CLI or service framework;
- the LLM provider and model;
- the persistence and LangGraph checkpoint backend;
- the concrete Docker isolation configuration;
- deployment and supported operating environments;
- the evaluation harness and reporting format.

Treat these as open until an implementation decision is explicitly recorded. Do not infer them from the existing helper scripts or tests.
