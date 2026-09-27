# Research and Decisions: Closed Tool Registry

## Evidence

- `coding-agent-context/context/progress-checker.md` marks all Phase 2 items planned. Current `src/` has Phase 0 and Phase 1 source; no registry exists.
- ADR 0005 fixes catalog ownership, trusted selection, exact Ask/Edit names, strict Zod 4 schemas, and provider-neutral derivation.
- `coding-agent-context/context/tool-policy.md` forbids arbitrary shell, authorization by visibility, and model-chosen limits.
- `package.json` already includes Zod 4 and Vitest.

## Decisions

1. **Static registry plus tiny selector.** A fixed catalog in `src/tools/registry.ts` is closed; `src/tools/selection.ts` owns the trusted Ask/Edit candidate names. No registration or adapter interface.
2. **Strict Zod object per name.** Parse untrusted arguments; reject unknown keys. Parsed values are not permissions.
3. **Derived neutral schema.** Use `z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12', cycles: 'throw', unrepresentable: 'throw' })` with representable schemas. Zod's strict object conversion emits `additionalProperties: false`. Assert parity in tests; provider conversion waits for Phase 10. [Zod's JSON Schema documentation](https://zod.dev/json-schema) confirms these options.
4. **Trusted mode table outside registry.** Ask/Edit candidate selection is deterministic composition code, preparatory until a real task composer exists. The registry only validates candidate names and projects schemas. ADR 0007 mode behavior is separate.
5. **Conservative structural bounds.** Strings are finite, result limit 1–100, patch text at most 65,536 JavaScript string units. These bound parsing, not filesystem or execution bytes.
6. **One strict call envelope.** Parse unknown model-call data as exactly `{ name, arguments }`, then validate the registered name's arguments. Provider-specific envelope conversion waits for Phase 10. Candidate schema projection accepts strings and rejects the whole selection if any name is unknown.

## Excluded Work

No path canonicalizer, verification-profile loader, patch parser, policy engine, dispatcher, sandbox, Git adapter, audit chain, model provider, or session wiring. No ADR 0006 counter or ADR 0007 mode/stop implementation.

The Phase 1 runner has its own private model-proposal schema. This feature does not route raw model input into its trusted event variants or change its immediate mode-switch behavior.
