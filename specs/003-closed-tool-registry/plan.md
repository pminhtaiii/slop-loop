# Implementation Plan: Closed Tool Registry

**Branch**: `feat/003-closed-tool-registry` | **Date**: 2026-09-27 | **Spec**: [spec.md](./spec.md)

**Input**: ADR 0005 and the Phase 2 feature specification. Planning does not claim implementation completion.

## Summary

Add a pure registry module with nine fixed Zod 4 definitions and a small trusted mode-name selector. The registry validates proposed call arguments and derives provider-neutral JSON Schema for names supplied by the selector. No policy decision or operation runs here.

## Technical Context

- **Language/Version**: Strict TypeScript, Node.js 24, native ESM
- **Primary Dependencies**: Existing Zod 4; no new dependency
- **Storage**: None
- **Testing**: Vitest security/contract tests plus repository quality gate
- **Target Platform**: Windows checkout and Ubuntu CI
- **Project Type**: Private single-package modular monolith
- **Performance Goals**: Fixed nine-entry catalog and bounded arguments; no external I/O
- **Constraints**: No execution, authorization, path canonicalization, profile loading, session controller, provider, or adapter
- **Scale/Scope**: `src/tools/registry.ts`, `src/tools/selection.ts`, and `tests/tools/registry.test.ts`, then phase-relevant context sync

The Tool Contract Standard in `coding-agent-context/context/code-standards.md` also requires an output schema, risk level, mutation flag, required capability, timeout, and maximum output size. These are deliberately deferred from this non-executable registry: risk and mutation are described by tool policy, while capabilities belong to Phase 3 and output/runtime limits belong to each later adapter. Before any tool is executable, its owning phase must create the complete contract and verify it. A registry entry is not a runnable tool implementation.

## Constitution Check

The constitution is an unfilled template. `CONTEXT.md`, the context pack, and ADR 0005 govern. Pre-design and post-design checks pass for documentation: fixed names, trusted visibility selection, strict boundary validation, no new privilege, and implemented status reserved for `progress-checker.md` after tests. Phase 0 is complete; Phase 1 source exists but its combined pinned-manager gate is pending. ADR 0006/0007 changes remain separate.

## Project Structure

```text
specs/003-closed-tool-registry/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/registry.md
├── checklists/requirements.md
└── tasks.md

src/tools/registry.ts
src/tools/selection.ts
tests/tools/registry.test.ts
```

The `tools/` directory appears with its first real behavior. Both modules are pure and are not wired into `src/index.ts` or the Phase 1 scripted runner.

## Design

1. Define the nine-name catalog with descriptions and strict Zod object schemas. Provide no registration API.
2. Validate one unknown input with a strict outer `{ name, arguments }` Zod object first, then exact name lookup and name-specific `safeParse`. Reject missing/extra top-level fields and names outside 1–64 Unicode code points. Return a typed accepted call or bounded error; omit raw patch/query text from errors. Provider envelope normalization belongs to Phase 10.
3. Define the Ask/Edit candidate-name mapping in `src/tools/selection.ts`, outside the registry. The registry's `modelVisibleToolsForNames(names: readonly string[])` validates **all** candidate names before projecting any schema; one unknown name fails the whole request. This is preparatory until a real task composer exists.
4. Derive provider-neutral input JSON Schema with `z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12', cycles: 'throw', unrepresentable: 'throw' })`. Use only representable strict objects; fail closed if conversion cannot represent a definition. Do not maintain parallel schemas. Phase 10 owns provider conversion.
5. Test valid/invalid fixtures, fixed selection, and parity for all nine tools. Test that raw command and control fields fail.

## Threat Review

| Question | Answer and proof |
| --- | --- |
| New capability | Recognition, structural validation, and visibility metadata only. No execution. |
| Model data to privileged sink | Strict outer call parse, exact name lookup, and strict argument parse only; unknown fields and names fail. |
| Path traversal / symlink | Strings are not path authority; Phase 4 resolves and confines paths. |
| Command injection | No command/shell field; profile names and logical targets require later trusted checks. |
| Secrets | No environment/file reads; errors omit argument values. |
| Repository content changes policy | Catalog and mode mapping are static trusted code. |
| Failure | Conversion or lookup errors abort; no partial schema output grants authority. |
| Bound | Length/count limits reject oversized inputs; execution limits are later. |
| Audit | Later gateway/policy must record attempts and decisions; no audit writer here. |
| Boundary test | Negative fixtures, exact selection tests, schema parity for nine tools. |

## Verification and Dependencies

Write each behavior test first and confirm expected RED. Implement minimum GREEN and run focused Vitest. Then run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm smoke`. Security convergence and separate standards/security and specification reviews must clear HIGH findings. Update phase-relevant context and `progress-checker.md` only after verification. See [tasks.md](./tasks.md).

Phase 2 can be implemented as an isolated pure module. Phase 1's pinned pnpm gate remains a prerequisite for integration readiness. Phase 3 consumes validated calls for per-invocation authorization; later phases own adapters. The managed `AGENTS.md` section now contains the Phase 2 plan pointer alongside the approved Phase 1 pointer.

The existing Phase 1 runner keeps its private model-proposal schema and immediate same-task mode behavior for now. Registry work must not feed raw model input into trusted runner event variants; ADR 0007's task-bound mode change is separate.
