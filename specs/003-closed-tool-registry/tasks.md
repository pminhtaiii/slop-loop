# Tasks: Closed Tool Registry

- **Input**: [spec.md](./spec.md), [plan.md](./plan.md), [contracts/registry.md](./contracts/registry.md)
- **Status**: Planned; no Phase 2 implementation claimed.
- **Numbering**: Continues the repository-wide GitHub task sequence after closed T001–T030; issues T031–T036 track this plan.

## Phase 1: Setup

No new package, dependency, or scaffold is required. Existing Node 24, Zod 4, Vitest, and quality scripts are reused.

## Phase 2: Foundational

No shared runtime foundation is added. Phase 2 remains pure and isolated from the current runner.

## Phase 3: User Story 1 — Recognize and validate calls (P1)

- [ ] T031 [US1] RED: Add strict outer-call tests for missing/extra top-level fields, arrays, and null; add unknown-name, valid-argument, missing-field, wrong-type, unknown-key, oversize (including supplementary-plane characters at the maxLength boundary), and forbidden command/control-field cases for all nine tools in `tests/tools/registry.test.ts`; run `pnpm exec vitest run tests/tools/registry.test.ts` and confirm intended failure.
- [ ] T032 [US1] GREEN: Add strict `{ name, arguments }` parsing, the fixed nine-entry strict Zod 4 catalog, and `validateToolCall(call: unknown)` in `src/tools/registry.ts`; rerun focused Vitest and ensure errors omit raw argument text. No registration or execution API.

## Phase 4: User Story 2 — Present trusted selection (P1)

- [ ] T033 [US2] RED: Add exact Ask/Edit selection, mixed known/unknown selected-name total-failure, and schema-parity fixtures for all nine tools in `tests/tools/registry.test.ts`, covering required/optional fields, types, limits (confirming Draft 2020-12 maxLength agreement on supplementary-plane strings at the boundary), and `additionalProperties: false`; confirm intended failure.
- [ ] T034 [US2] GREEN: Implement trusted Ask/Edit typed candidate-name mapping in `src/tools/selection.ts` and provider-neutral Zod-derived schema projection for `readonly string[]` in `src/tools/registry.ts`; validate all names before projecting, then rerun focused Vitest. Use input JSON Schema conversion, fail closed on unsupported conversion, and do not add a second argument schema or authorize calls.

## Phase 5: Polish, Verification, and Context Sync

- [ ] T035 Review `src/tools/registry.ts`, `src/tools/selection.ts`, and `tests/tools/registry.test.ts` against `specs/003-closed-tool-registry/plan.md` and `coding-agent-context/context/tool-policy.md`; run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm smoke`. Resolve HIGH security/spec findings before completion.
- [ ] T036 Update `coding-agent-context/context/progress-checker.md`, `coding-agent-context/context/architecture.md`, and `coding-agent-context/context/tool-policy.md` to match verified reality; review the other files under `coding-agent-context/context/` for needed sync. Preserve Phase 1 pinned pnpm readiness status and the later executable Tool Contract gate. Use Spec Kit agent-context update to add the Phase 2 pointer in managed `AGENTS.md` while retaining the approved Phase 1 pointer. Review final diff.

**Dependency order**: T031→T032→T033→T034→T035→T036. Each RED task requires observing the intended failure before its GREEN task. Source and tests are confined to the three planned files until a concrete need proves otherwise.
