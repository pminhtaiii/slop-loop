# Data Model: Closed Tool Registry

## Static Registry Entry

`ToolName` is a closed nine-name union. Each entry has a unique name, short description, and one strict Zod 4 object argument schema. Trusted source creates entries at module load; no registration API exists. An entry is not yet a complete executable Tool Contract: output schema, risk, mutation, capability, timeout, and output size are completed by owning later phases before execution.

## Proposed Call and Validation Result

Input is one `unknown` value. A strict outer object accepts exactly `{ name, arguments }`, requires a name of 1–64 Unicode code points, and rejects missing or extra fields. Validation then checks the exact name and parses arguments with that name's strict schema. Success contains the name and parsed structural arguments. Failure identifies `INVALID_CALL`, `UNKNOWN_TOOL`, or `INVALID_ARGUMENTS` with bounded metadata, not raw argument contents. Provider-specific envelope conversion belongs to Phase 10. Success does not authorize a run.

## Model-Visible Schema

A derived item has `name`, `description`, and provider-neutral JSON Schema `parameters`. Strict objects advertise `additionalProperties: false`; required/optional fields and finite constraints come from the same Zod schema as runtime validation.

## Trusted Selection

The fixed table in `src/tools/selection.ts` maps Ask to four names and Edit to nine and returns typed `ToolName[]` candidates. The registry accepts a `readonly string[]`, validates every candidate before projection, and returns schemas in stable catalog order. One unknown candidate fails the whole request. Future task composition supplies developer-selected mode; this phase has no live session.

## Invariants

- Exactly nine unique registered names.
- Unknown argument keys fail in every contract.
- Advertised properties and runtime validation derive from one definition.
- Model/repository data cannot mutate catalog, mode, budget, permission, or execution config.
- Registry output alone never authorizes an operation.
