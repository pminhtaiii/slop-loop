# Use TypeScript in a single-process application

Status: accepted.

Slop Loop Phase 0 uses TypeScript on Node.js 24 LTS, native ESM, strict tsc compilation, and pnpm rather than the previously proposed Python runtime. The application primarily coordinates hosted model APIs, repository reasoning, deterministic policy, process control, structured logging, and future terminal/UI surfaces; one language and test ecosystem keeps those concerns coherent while preserving a provider-neutral design.

The MVP starts as one private, single-package, single-process application, designed to evolve as a modular monolith as real subsystem boundaries appear. Phase 0 therefore creates only config.ts, logging.ts, and index.ts plus focused tests, and does not create speculative subsystem folders, workspace packages, microservices, a bundler, or dependency-boundary tooling.

Zod 4, Pino, Vitest, type-aware ESLint, and Prettier are the selected implementation/development tools. The only Phase 0 application setting is SLOP_LOOP_LOG_LEVEL, defaulting to info. The compiled smoke check runs node dist/index.js after pnpm build. There is no package self-reference, exports map, npm publication, SDK, CLI contract, coverage gate, or tarball consumer test yet.

The first target repositories remain Python repositories with trusted pytest, Ruff, and mypy verification profiles. Those tools belong to target repositories and do not determine Slop Loop's implementation runtime. Microservices, package extraction, SDK publication, and npm publication remain deferred until concrete operational or consumer requirements justify them.
