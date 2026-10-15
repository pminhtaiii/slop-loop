# Technology Stack

This page records approved implementation choices and keeps undecided choices explicit. It separates the language used to build slop-loop from the languages and tools used by repositories slop-loop will work on.

## Approved choices

| Area | Choice | Scope |
|---|---|---|
| slop-loop implementation | TypeScript | Core coding-agent runtime |
| Workflow orchestration | `@langchain/langgraph` | Retain the official TypeScript implementation as the orchestration library |
| Initial target repositories | Python with `pytest` | Repositories the runtime will initially operate on |

These choices describe the intended product stack. They do not establish that the runtime or these dependencies are already implemented in this repository.

## Existing contributor helpers

The repository currently has Node.js ES module helpers under `scripts/ci/` and corresponding tests under `tests/ci/`. The existing helper test command uses Node's built-in test runner and requires Node.js 20 or newer; see [testing guidance](testing.md).

This is contributor tooling already present in the repository. It does not select the core runtime's Node.js version, package manager, or test framework.

## Open decisions

No choice is recorded yet for:

- the Node.js version used to run the TypeScript runtime;
- the package manager and dependency lockfile;
- the TypeScript runtime's test framework;
- build, lint, and formatting tools;
- a CLI or service framework;
- the LLM provider and model;
- the persistence and LangGraph checkpoint backend;
- the isolation mechanism used to execute repository commands;
- deployment and supported operating environments;
- the evaluation harness and reporting format.

Treat these as open until an implementation decision is explicitly recorded. Do not infer them from the existing helper scripts or tests.
