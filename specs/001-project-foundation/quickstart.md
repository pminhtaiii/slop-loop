# Quickstart: Validate Phase 0

## Prerequisites

- Node.js 24 LTS
- The pnpm version pinned by the repository

## Install

```text
pnpm install --frozen-lockfile
```

## Source verification

Run these before generating `dist/`:

```text
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
```

Expected: every command succeeds and `pnpm test` does not require `dist/`.

## Build and smoke

```text
pnpm build
pnpm smoke
```

Expected: the build creates `dist/index.js`; smoke starts it directly, applies the default `info` configuration, emits structured startup output, and exits successfully.

## Configuration scenarios

Validate each accepted level by setting `SLOP_LOOP_LOG_LEVEL` before `pnpm smoke`. An unsupported value or unknown `SLOP_LOOP_*` name must make startup fail with a bounded diagnostic. Unrelated environment variables must not affect the configuration.

Platform-specific environment-setting syntax is deliberately not prescribed by the application contract.
