# Slop Loop

Controlled local coding-agent application.

## Overview

Slop Loop is a private, single-package, single-process TypeScript application designed to evolve into a modular monolith as real subsystem boundaries emerge. It runs on Node.js 24 LTS and uses strict TypeScript with native ESM compilation.

The application foundation provides:
- Bounded startup lifecycle emitting structured operational JSON records.
- Strict configuration validation using Zod for the `SLOP_LOOP_*` environment namespace.
- Fast and secure operational logging via Pino with field redaction and bounded untrusted data handling.
- Independent source-level testing and compiled artifact verification without bundlers or speculative abstractions.

> **Scope Note**: Slop Loop is a private internal application. It does not publish a public SDK, expose package export maps, use package self-reference (`import ... from 'slop-loop'`), or provide an interactive CLI argument parser in this foundation phase.

---

## Prerequisites

- **Node.js**: `^24.0.0` (Node.js 24 LTS)
- **pnpm**: `^12.0.0` (pinned via `packageManager: pnpm@12.5.1` in `package.json`)

---

## Installation

Install dependencies using the committed lockfile:

```bash
pnpm install --frozen-lockfile
```

---

## Configuration

The application recognizes configuration settings under the `SLOP_LOOP_*` environment namespace:

| Variable | Description | Accepted Values | Default |
| :--- | :--- | :--- | :--- |
| `SLOP_LOOP_LOG_LEVEL` | Minimum log level for operational logging | `trace`, `debug`, `info`, `warn`, `error`, `fatal` | `info` |

### Validation Rules

- **Default Behavior**: If `SLOP_LOOP_LOG_LEVEL` is absent, the application defaults to `info` and starts successfully.
- **Strict Namespace**: Any unrecognized environment variable starting with `SLOP_LOOP_` causes startup to fail deterministically with an actionable diagnostic.
- **Invalid Values**: Any unsupported log level causes startup to fail with an error detailing the accepted values.
- **Unrelated Variables**: System environment variables outside the `SLOP_LOOP_` prefix are ignored and do not affect application configuration.

---

## Verification & Development Commands

All verification commands do not mutate tracked repository source files, with the exception of `pnpm format` (which intentionally formats modified files) and `pnpm build` (which emits compiled artifacts to the uncommitted `dist/` directory).

| Command | Purpose | Contract |
| :--- | :--- | :--- |
| `pnpm lint` | Static linting | Runs ESLint with type-aware rules across source and test files. |
| `pnpm format:check` | Format verification | Verifies code formatting via Prettier without modifying files. |
| `pnpm format` | Code formatting | Rewrites files using Prettier formatting rules. |
| `pnpm typecheck` | Type checking | Type-checks source (`tsconfig.json`) and tests (`tsconfig.test.json`) without emitting files. |
| `pnpm test` | Source tests | Runs unit and contract tests via Vitest directly against TypeScript source without requiring `dist/`. |
| `pnpm build` | Compilation | Compiles TypeScript source to native ESM JavaScript in `dist/` via `tsc`. |
| `pnpm smoke` | Artifact verification | Executes `node dist/index.js` to verify the compiled entrypoint starts, logs structured JSON, and exits cleanly. |

### Canonical Verification Sequence

To verify the entire foundation locally before committing:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

---

## Platform Quality Gates (CI)

Continuous Integration is automated via GitHub Actions (`.github/workflows/ci.yml`) on pull requests and pushes to `main`:

- **Ubuntu Quality Gate (`ubuntu-latest`)**: Runs the complete verification sequence: frozen install, lint, format check, type check, unit tests, build, and compiled smoke verification.
- **Windows Quality Gate (`windows-latest`)**: Runs platform runtime and artifact verification: frozen install, unit tests, build, and compiled smoke verification.
