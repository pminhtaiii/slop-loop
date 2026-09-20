# Implementation Plan: Phase 0 Project Foundation

**Branch**: `[main]` | **Date**: 2026-09-20 | **Spec**: [spec.md](./spec.md)

## Summary

Establish a private TypeScript application foundation that validates one namespaced setting, emits one structured startup record, compiles to `dist/`, and proves source behavior and compiled startup independently. The repository remains a single-package, single-process application; future modules appear only with real behavior.

## Technical Context

**Language/Version**: TypeScript on Node.js 24 LTS

**Primary Dependencies**: pnpm 12, Zod 4, Pino, TypeScript, Vitest, ESLint with type-aware typescript-eslint, Prettier

**Storage**: N/A

**Testing**: Vitest source tests plus a separate compiled-entrypoint smoke command

**Target Platform**: Windows developer environments and Ubuntu GitHub Actions; full quality gate on Ubuntu and runtime/build/smoke gate on Windows

**Project Type**: Private single-package, single-process application

**Performance Goals**: Compiled startup completes within 5 seconds in CI

**Constraints**: Native ESM; strict TypeScript; no bundler, publication, SDK, package self-reference, exports map, CLI behavior, coverage gate, microservices, speculative modules, or arbitrary lifecycle scripts

**Scale/Scope**: Three production files, focused source tests, one compiled startup smoke path, and two CI jobs

## Constitution Check

The constitution file is an unfilled template and defines no enforceable gates. The repository context supplies the governing constraints: minimal scope, strict validation, structured and non-secret operational output, TDD, explicit verification, no speculative abstractions, and synchronized context documentation.

Pre-design gate: **PASS**. The design introduces only behavior required by the specification and no new agent capability.

Post-design gate: **PASS**. Research, contracts, and validation keep configuration and logging bounded, keep source tests independent from build output, and avoid future-facing package or service boundaries.

## Project Structure

### Documentation

```text
specs/001-project-foundation/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── configuration.md
│   └── verification.md
└── tasks.md
```

### Source Code

```text
src/
├── config.ts
├── logging.ts
└── index.ts

tests/
├── config.test.ts
├── logging.test.ts
└── smoke.test.ts
```

Root configuration contains `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, TypeScript, ESLint, Prettier, Vitest, and GitHub Actions configuration. `dist/` is generated and not source-controlled.

**Structure Decision**: Create only files needed by Phase 0 behavior. `index.ts` is the private application entrypoint. Future architectural and test directories are created with their first real behavior.

## Design

1. `config.ts` projects `SLOP_LOOP_*` values from an injectable environment map, rejects unknown application-prefixed names, validates `SLOP_LOOP_LOG_LEVEL`, applies `info`, and returns a frozen typed result.
2. `logging.ts` exposes a small Pino factory. Application-controlled fields contain external data; fixed redaction is defense in depth, not an authorization boundary.
3. `index.ts` loads configuration, creates the logger, emits a bounded startup record, and exits successfully. Invalid configuration exits unsuccessfully with an actionable bounded diagnostic.
4. Vitest tests source behavior without `dist/`. Build uses `tsc`. Smoke executes `node dist/index.js` only after build.
5. CI composes explicit commands. Ubuntu runs every gate; Windows omits duplicated static formatting/lint/type checks but proves install, tests, build, and compiled startup.

## Complexity Tracking

No constitution violations or justified complexity exceptions.

