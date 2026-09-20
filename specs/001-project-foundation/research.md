# Research: Phase 0 Project Foundation

## Runtime and topology

**Decision**: Use Node.js 24 LTS and TypeScript in one private, single-package, single-process application.

**Rationale**: The product integrates with hosted model APIs and is primarily orchestration, policy, filesystem/process control, terminal behavior, and later UI. One TypeScript ecosystem reduces cross-runtime coordination. A single process is the smallest viable topology; modular boundaries will emerge from real behavior.

**Alternatives considered**: Python runtime; mixed Python/TypeScript runtime; early workspaces; microservices. These add a second ecosystem or speculative operational boundaries without Phase 0 value.

## Dependency management and build

**Decision**: Pin pnpm 12 through project metadata, commit `pnpm-lock.yaml`, use frozen CI installs, native ESM with NodeNext resolution, strict compiler options, and `tsc` output to `dist/`.

**Rationale**: This is reproducible across Windows and Ubuntu and preserves Node runtime semantics. pnpm blocks unapproved dependency build scripts by default.

**Alternatives considered**: npm, yarn, Bun, Deno, and bundlers. None is required for the private Node application artifact.

## Runtime configuration

**Decision**: Use Zod 4 for a strict projected application schema. Recognize only `SLOP_LOOP_LOG_LEVEL`, default to `info`, reject unknown `SLOP_LOOP_*` variables, and freeze the result.

**Rationale**: TypeScript types do not validate runtime input. Zod keeps validation and inferred types together without transitive runtime dependencies. Projection avoids incorrectly rejecting unrelated operating-system variables.

**Alternatives considered**: Manual validation and validating all of `process.env`. Manual validation duplicates type and error logic; the complete environment necessarily contains unrelated keys.

## Operational logging

**Decision**: Use Pino behind a small factory with fixed redaction and injectable output for tests.

**Rationale**: Pino supplies newline-delimited JSON, levels, error serialization, child context, and redaction without custom security-sensitive serialization code.

**Alternatives considered**: `console` and a custom JSON logger. Both require recreating levels, error handling, redaction, serialization failure behavior, and test seams. Pino remains operational logging, not canonical audit evidence.

## Tests and formatting

**Decision**: Use Vitest for source tests, type-aware ESLint for static rules, and Prettier with separate rewrite and check commands.

**Rationale**: Vitest supports the expected backend and later UI testing trajectory. Typed linting complements strict compilation. `format` is intentional mutation; `format:check` is non-mutating CI verification.

**Alternatives considered**: Node's built-in test runner and Biome. The built-in runner's coverage and module-mocking maturity are weaker for the anticipated trajectory. A second overlapping linter is unnecessary.

## Artifact verification

**Decision**: Keep source tests, build, and smoke independent. Smoke executes `node dist/index.js` after build.

**Rationale**: Source tests must not hide a dependency on generated output, while compiled startup must still be proven. Direct execution reflects a private application, not a package-consumer contract.

**Alternatives considered**: Importing source from smoke, package self-reference, and tarball installation. These either fail to test the artifact or create publication/SDK contracts outside scope.

