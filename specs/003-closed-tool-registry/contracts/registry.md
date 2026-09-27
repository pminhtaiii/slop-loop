# Contract: Closed Tool Registry

## Pure Operations

```ts
validateToolCall(call: unknown): ValidationResult;
modelVisibleToolsForNames(names: readonly string[]): readonly ModelToolSchema[];
selectedToolNamesForMode(mode: 'Ask' | 'Edit'): readonly ToolName[]; // trusted composition, outside registry
```

These are design signatures; equivalent naming/types are acceptable. The first two belong to `src/tools/registry.ts`; `selectedToolNamesForMode` belongs to `src/tools/selection.ts`. `validateToolCall` first parses a strict outer `{ name, arguments }` object: missing fields, extra top-level fields, arrays, and null yield `INVALID_CALL`; a syntactically valid but unregistered name yields `UNKNOWN_TOOL`; invalid name-specific arguments yield `INVALID_ARGUMENTS`. It does not throw for model input. Provider-specific envelope normalization belongs to Phase 10. `modelVisibleToolsForNames` validates every name before projecting any schema; one unknown name fails the entire request. Results are immutable or safe copies. No function executes or authorizes a tool.

This Phase 2 entry contract covers recognition and input shape only. `coding-agent-context/context/code-standards.md` requires each executable tool to define output schema, risk level, mutation flag, required capability, timeout, and maximum output size. Those fields are deferred to the owning policy and adapter phases because this registry has no execution result, capability decision, or runtime limit. No entry may become executable without a complete contract and tests for those fields.

## Fixed Catalog and Arguments

All arguments are strict objects. Strings are nonempty and length-bounded; fields below are the only accepted keys. Lengths count Unicode code points (characters), matching Draft 2020-12 `maxLength` semantics. Values remain untrusted until later checks.

| Tool | Required | Optional | Structural constraints |
| --- | --- | --- | --- |
| `list_files` | — | `path`, `limit` | `path`: 1–1024 chars; `limit`: integer 1–100 |
| `search_code` | `query` | `scope`, `limit` | `query`: 1–512 chars; `scope`: 1–1024 chars; `limit`: integer 1–100 |
| `read_file` | `path` | — | `path`: 1–1024 chars |
| `git_diff` | — | — | Empty object only |
| `apply_patch` | `patch` | — | `patch`: 1–65,536 chars; text only |
| `run_tests` | `profile` | `target` | `profile`: 1–64 chars; logical `target`: 1–1024 chars |
| `run_build` | `profile` | — | `profile`: 1–64 chars |
| `run_linter` | `profile` | — | `profile`: 1–64 chars |
| `run_typecheck` | `profile` | — | `profile`: 1–64 chars |

These conservative parser bounds are proposed because policy sets no exact argument maxima. They can be tightened with documented tests. `path` and `scope` are syntactic values only; Phase 4 handles repository confinement, symlinks, denied paths, bytes, and result bounds. `profile` and `target` are names only; Phase 8 loads trusted profiles and maps logical targets. Patch targets/operations and permissions belong to Phase 7. No contract accepts executable names, flags, argv, shell text, timeouts, environment variables, capabilities, or approval data.

## Visibility

- `Ask`: `list_files`, `search_code`, `read_file`, `git_diff`.
- `Edit`: all Ask tools plus `apply_patch`, `run_tests`, `run_build`, `run_linter`, `run_typecheck`.
- Candidate names originate in `src/tools/selection.ts`, not the registry. The registry rejects any selected name absent from the fixed catalog.
- Visibility neither grants a capability nor implies a call will pass Phase 3 policy.

## Model-Visible Representation

Each item is `{ name, description, parameters }`. `parameters` is provider-neutral JSON Schema generated with Zod 4 `io: 'input'`, `target: 'draft-2020-12'`, `cycles: 'throw'`, and `unrepresentable: 'throw'`. It carries object type, properties, required list, `additionalProperties: false`, and field constraints. Tests compare it with runtime acceptance for every tool, including unknown-field rejection. Phase 10 converts it for a provider.
