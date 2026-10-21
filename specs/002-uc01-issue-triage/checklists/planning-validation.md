# Planning Validation: UC-01

**Status**: DRAFT planning checklist; implementation authorization pending.

## Artifact and boundary checks

- [x] ADR-0005 boundaries represented without changing approved decisions.
- [x] One issue/repository; provenance, severity dimensions, clarification and configured recommendation specified.
- [x] Structured schema and outcome unions distinguish trusted context from caller/model data.
- [x] Existing UC-03 artifacts unchanged; bug-specific shared signatures are not assumed triage-compatible.
- [x] Thai/Tai/Thanh Tan/Trong Tan ownership and external gates explicit.
- [x] All 16 implementation tasks unchecked with owner, dependencies, paths and acceptance checks.
- [x] Internal edges increase task IDs; no cycle; shared paths sequenced; zero premature [P] markers.
- [x] Separate contract-validation, mock, real integration and receiver compatibility tasks.
- [x] Fixtures, attacks, held-out evaluation and numeric production gates separated from current evidence.
- [x] C01–C22 input/oracle/rule design precedes feature implementation at T002–T004; early safety is not deferred to T014.
- [x] Each task has evaluation/evidence obligations; 16 IDs/dependency edges and six existing Issue groupings retained.
- [x] Proposed case/result/registration records cover UC-scoped IDs, immutable versions, isolated labels/results and scoped/project selection.
- [x] Hard-gate failures, scored quality, execution completeness and >=80% classification floor have distinct aggregation semantics.
- [x] T015 consumes prepared cases for real-model comparisons and actual shared compatibility, with runner absence recorded not-run.
- [x] Original course source gaps, IssueTicket/output/routing reconciliation and Tai/leader decisions remain explicit.

## Review evidence policy

For this revision, at least three independent local reviewers inspect latest uncommitted files before its first commit and paired Issue updates. Raw reports, deduplicated findings, corrections, source hashes and command evidence stay in ignored managed workspace. This checklist states the policy and artifact checks; it does not substitute for actual reviewer reports or claim an unrun CI result. Maximum three local repair/review rounds; unresolved valid Critical/Major findings stop commit/publication. This revision is limited to UC-01 specs and existing paired Issues; no runtime, runner, foreign specs or project workflow edits.
