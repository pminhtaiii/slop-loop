# UC-01 → UC-03 Receiver Contract

**Version**: `uc01-uc03-receiver-v1`.
**Authority**: On 2026-10-28 (Asia/Bangkok), the user reported Tai's delegation of implementation and technical decisions for UC-03 T011 → T012 → UC-01 T013, including necessary specification/contract amendments. This additive receiver agreement leaves canonical UC-03 `0.1.0`, atomic-admission `0.2.0`, and UC-01 wire `uc01-draft-v1` unchanged. See [authorization](decisions.md).

## Public seams and ownership

```typescript
receiveBugTask({ task, materialAmbiguities? }): IntakeResult
receiveUc01Assessment({
  contractVersion: 'uc01-uc03-receiver-v1', outcome, invocation, context,
  suppliedBugTask, receiverConfig: { destinationId, defectClassificationIds }
}): IntakeResult
```

Both exported functions accept runtime-validated unknown input envelopes in `src/uc03/input.ts`, with cohesive helpers in `input-types.ts`, `input-data.ts` and `input-uc01.ts`. Tai owns the receiver. UC-01 T013 owns compatibility tests in `tests/runtime/uc01/receiver.test.ts`, calling this delivered implementation; it does not own shared execution, persistence, approval or a dispatcher. Direct intake tests live in `tests/runtime/unit/uc03-success.test.ts`.

Before canonical validators, bounded data-only parsing rejects proxies before traps, prototypes, accessors, cycles and sparse arrays. Its transport safety ceiling is depth 32, 20,000 visited values and 1 MiB cumulative UTF-8 string/key bytes. These limits do not supply execution budgets or production defaults. Rejection diagnostics use fixed paths/codes, including for unknown caller property names.

Envelopes and receiver configuration are closed records. The UC-01 envelope requires every listed field; unsupported/missing contract versions are invalid input. `destinationId` is nonempty text and `defectClassificationIds` is a nonempty, duplicate-free array of nonempty IDs. Configuration must resolve against the validated trusted catalog: destination exists, each selected classification exists with `impairmentAssessment=true`, and the destination accepts each selected classification. These are explicit application choices, never hardcoded `repair`/`defect` defaults.

## Admission and outcomes

`IntakeResult` is a discriminated union using `status`:

| Status | Meaning and payload |
|---|---|
| `accepted` | `{status, task: BugTask, source?}`; task is a detached canonical validator value. Source is `{contractVersion, assessmentId, issueId, reportDigest, catalogId, catalogVersion, provenance}`. Acceptance grants no execution authority. |
| `needs-info` | `{status, fields: string[], questionIds: string[]}`; missing canonical fields or supplied material ambiguity/unresolved UC-01 questions. No executable task. Direct ambiguity uses fields `["materialAmbiguities"]` and empty questionIds; UC-01 carries question IDs only. |
| `invalid-input` | Malformed envelope/task/configuration/outcome, unsupported version or invalid canonical field. Carries safe paths/codes; no executable task. |
| `conflict` | Valid source and candidate disagree on task, repository, revision or configuration binding. Carries safe paths/codes; no executable task. |
| `not-applicable` | Valid UC-01 failure outcome, undetermined/unsupported/nondefect classification or a recommendation for another destination. No executable task. |

Diagnostics use stable codes and canonical field paths, never reflected caller values, raw report, model text, commands, exception messages or protected payloads. Missing/empty reproduction, expected behavior, repository identity or acceptance criteria requests information; malformed supplied values remain invalid input. Other absent required canonical fields also request information. No missing goal, limits, checks, constraints or configuration is filled with defaults. Complete direct tasks need no artificial confirmation flag. Optional `materialAmbiguities` is a caller-supplied bounded array of nonempty question strings; nonempty ambiguity requires confirmation through a later caller resubmission rather than speculative intake. Ambiguity strings and UC-01 questions are data and confer no approval authority.

The receiver validates UC-01 through the existing `validateOutcome(outcome, invocation, context)` and validates the invocation/trusted context binding even for failure outcomes. It does not create a second assessment schema. Accepted assessed input must select the configured receiver destination and an admitted defect classification. Valid `needs-info` input stays `needs-info` even when `suppliedBugTask` is complete; unresolved material questions are preserved as clarification metadata, never converted into requirements or action approval. A malformed outcome/configuration is rejected before it can be treated as an ordinary unsupported route.

The caller supplies the entire bug task independently, including reproduction, observed/expected behavior, criteria, checks, constraints, finite limits and configuration. Partial `suppliedBugTask` is permitted only to obtain missing-field diagnostics. Assessment prose, severity, citations, uncertainty and recommendation never generate these fields. Validate canonical `BugTask` with the existing accepted validator after missing-input classification. Return a detached canonical validator value, preserving supplied semantics and original digest format; existing scalar whitespace normalization is allowed. Clone nested arrays/records so later caller mutation cannot change the accepted task.

Bind candidate `taskId` to the validated invocation, `repositoryId` to the trusted context/assessment, `initialRevisionDigest` to the assessment snapshot, and `configId`/`configVersion` to the trusted context. Snapshot equality compares SHA-256 identity: UC-01 uses lowercase bare 64-hex; the candidate may use the identical bare digest or `sha256:` prefix. Reject malformed/different digest identity; retain the caller's original canonical task digest representation in the returned task. Different receiver execution configuration requires a future explicit mapping contract; v1 does not infer one.

UC-01 source metadata is separate from `BugTask`: assessment identity, issue identity, report digest, catalog identity/version and `mock`/`real` provenance remain traceable. Preserve original assessment/report data without mutation. Mock assessment provenance remains mock even though the actual delivered receiver is being exercised; receiver compatibility is actual local integration evidence, not evidence of a real LLM, reproduction or a verified diagnosis.

## Zero-effect boundary and acceptance

The receiver is pure validation. It creates no task ID, state, checkpoint, approval, model call, dispatch or repair, and calls no execution graph. `validateGraphInput` remains an execution/state admission seam, not this receiver. Later UC-03 investigation, approval, atomic-admission and verification gates remain mandatory for any separately authorized execution.

T011 preserves existing investigation/verification implementations and their tests, adds a runnable neutral intake signature and records assertion-only RED for missing/ambiguous/complete intake. It never replaces implemented modules with skeletons. T012 replaces only the intake neutral behavior; final direct-input tests pass. UC-01 T013 proves C21 against this exact receiver version, including actual `IssueAssessor` → receiver flow, complete and missing caller details, unresolved questions, malformed/version/configuration input, stale binding, configured destination IDs, provenance preservation, detached output and zero dispatch/repair effects. Routing and existing investigation/verification suites provide regression evidence. X-RECEIVER requires both this agreed contract and actual delivered receiver/check evidence; this document alone does not satisfy delivery.

All real model/provider, UC-01 T011/T012, UC-04/UC-05 implementation, production configuration, automatic repair/dispatch and broader UC-03 end-to-end acceptance remain outside this authorization. Task completion is recorded only in the task ledgers after integrated acceptance evidence.

All refusal variants use `{status, reasonCode: string, path: string}`. Field paths and reason codes are fixed safe vocabulary; unknown property names and question text are not reflected in diagnostics.
