# Contributor Testing Guidance

This document describes current contributor testing guidance and the helper tests present in this repository. It is not the complete verification specification for the planned slop-loop runtime; see [the target verification matrices](../docs/progress-checker-matrices.md).

Use the repository's established test and quality commands. Read `AGENTS.md`, project documentation, and the feature plan for applicable requirements; do not assume a test framework or invent project-wide commands.

## Test-first implementation

- For code changes, use the repository's `tdd` skill and write or update focused behavioral tests before implementation.
- Run the narrowest relevant tests first, then the broader applicable regression checks.
- Treat unrelated collection, environment, harness, or fixture failures as blockers to test evidence, not as a passing behavioral test.
- Do not skip coverage, weaken assertions, change expected behavior, or relax a safety constraint just to obtain a passing result.

## Reporting results

For every validation command, report the exact command and its exit status. Distinguish passed, failed, and unrun checks; explain why an applicable check was not run. A focused pass proves only the behavior it exercised.

Do not mark a task complete until its implementation is integrated and its applicable checks pass. Do not claim feature completion while required tests, convergence, or review gates remain unresolved.

## Local helper tests

The task-context and managed-session helpers require Node.js 20 or newer, use Node.js built-ins, and can be tested without installing packages:

```powershell
node --test tests/ci/agent-context.test.mjs tests/ci/agent-work.test.mjs
```

Run the complete contributor test suite with Node's test-runner discovery:

```powershell
node --test
```

When editing `context/*.md`, `AGENTS.md`, or `docs/progress-checker-matrices.md`, check local inline file links with:

```powershell
node scripts/ci/check-context.mjs
```

## Runtime bootstrap gate

Before the TypeScript runtime is considered ready, CI must run strict TypeScript compiler checks and mechanical lint rules. Record the compiler and linter choices in [tech_stack.md](tech_stack.md) when they are selected; this requirement does not select tools or justify adding them before that decision. Runtime boundary changes also need evidence from the relevant [target verification matrices](../docs/progress-checker-matrices.md).
