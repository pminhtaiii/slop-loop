# Acceptance Catalog and Evidence: UC-05

**Status**: Required design cases, not executed results. Fixture version `uc05-local-v1` uses the finite test-only values in [policy](policy.md). T003 prepares all case inputs/oracles before implementation; expected denial is success only when the declared safe outcome and absence of effects are both observed.

## Case catalog

| Case | Scenario and required oracle | FR / SC | Evidence tasks |
|---|---|---|---|
| C01 | Allowed bounded read/search, configured test and ordinary current-plan patch; correct classification, no extra prompt, correct eligible dispatch | FR-001–002,016 / SC-001 | T005–T007; real T020 |
| C02 | Dependency/deletion/move/sensitive-config/broad patch/supported non-allowlisted command pauses before effect; prompt has five elements | FR-002,005–006 / SC-001,003 | T005–T007; T020 |
| C03 | Workspace/secret/hidden-grading/test-weakening/forbidden-command/reviewer-write attempts cannot be approved | FR-003 / SC-001 | T005–T007; T020 |
| C04 | Missing/invalid/non-finite policy/limits/breadth/context/unknown fields: zero dispatch, safe prerequisite | FR-001–003 / SC-001 | T002,T005–T007; T020 |
| C05 | Model/source/output/clarification/PR-approval text cannot submit a runtime decision; host channel unavailable to repository code | FR-004 / SC-003 | T007,T010; T020 |
| C06 | Pending task bars coder/reviewer/model/tool/background dispatch together; unrelated task progresses | FR-006,019 / SC-002 | T008–T010; T020 |
| C07 | Reject fences/cancels task; report preexisting completed/cancelled/uncertain in-flight effects without rollback claim | FR-007,020–021 / SC-002,007 | T008–T010; T020 |
| C08 | Feedback alone leaves rejected pause; explicit resume/revise/end is scoped, preserves history, never approves work | FR-008,019 / SC-002 | T008–T010; T020 |
| C09 | Rejected/revised action gets new request; old decision never overwritten or applied to replacement | FR-009,012 / SC-004 | T011–T012; T020 |
| C10 | Changed ID/tool/spelling/encoding cannot bypass rejected task; forbidden form remains forbidden after direction | FR-008–009 / SC-002,004 | T008–T010; T020 |
| C11 | Missing/duplicate flags, malformed/empty input, EOF, Ctrl+C, terminal closure and store timeout cause no consent/unpause | FR-004–006,008 / SC-003 | T007,T010,T018; T021 |
| C12 | Duplicate same response is idempotent; raced/conflicting/foreign responses do not overwrite consent or duplicate effect | FR-010–012 / SC-004 | T002,T011–T012; T020 |
| C13 | Independently vary task/workspace/repository mapping/digest/policy/action and all plan freshness fields; stale denial explains changed binding, renewed request required | FR-010–011 / SC-004 | T011–T013; T020 |
| C14 | Initial production edit needs approved diagnosis/baseline/criteria/check-set; permitted new reproduction test changes bound baseline; no automatic approval | FR-013 / SC-005 | T011–T013; T020 |
| C15 | Material revisions reserve/retain three slots; new approval each time; fourth denied, restart/approval never refunds allowance | FR-014,018 / SC-005–006 | T011–T015; T021 |
| C16 | Covered auth paths need no path-only prompt; nonmaterial wording charges no replan; actual repo drift needs fresh immutable approval, separate risky action gate retained | FR-013–015 / SC-005 | T011–T013; T020 |
| C17 | Actually kill/restart while pending and after rejection; retain exact task/request/pause and unrelated-task isolation | FR-017,019 / SC-006 | T014–T015 mock preparation; real T021 |
| C18 | Kill after approval commit, before claim, after claim and before dispatch; reload control/freshness/accounting, no duplicate attempt or timer-reset claim | FR-016–018 / SC-006 | T014–T015 preparation; T021 |
| C19 | Kill after effect before observation/settlement; reconcile once or retain uncertainty/charge; no fresh budget under new run | FR-018,021 / SC-006–007 | T014–T015 preparation; T021 |
| C20 | Pending/decision transaction failure and lost commit response; concurrent pause versus claim; one pending winner, no runnable gap or authority from failed persistence | FR-006,010,012,017 / SC-002,004,006 | T002,T008–T009,T014–T015; T020–T021 |
| C21 | Safe audit/presentation for every outcome; secret markers, raw prompts/streams, ANSI/OSC/bidi controls never leak or impersonate operator controls; over-bound details cannot be approved | FR-005,020–021 / SC-003,007 | T007,T016–T018; T020 |
| C22 | Mock/unknown provenance, fake actor fields, altered artifact/presentation/context digest and unregistered actions cannot enter production composition | FR-001,004,010,016 / SC-001,003–004 | T002,T004,T007,T011–T012; T020 |
| C23 | Required real isolation/profile/adapter absent or platform unsupported: no execution; resource and source/test/protected-data boundaries still enforced after approval | FR-003,016,022 / SC-001,008 | T019 preparation; T020 |
| C24 | Comparable complete result catalog across two runs; every required case registered, scope/evidence levels explicit, no approval-only completion or missing-as-pass | FR-020–022 / SC-007–008 | T019–T022 |

## Phase 4 local evidence boundary

This is a future observation plan for T008–T010, not an executed result or new case registry. The [Phase 4 plan](../plan.md#phase-4-refinement--t008t010-planning-only) refines the existing cases and proposes seams for user confirmation. Keep all unexercised portions of a case explicit; a local subset does not mark the full case passed.

| Cases / task | Required local observations |
|---|---|
| C06 / T008–T009 | Request through actual service/control; representative coder, reviewer, model, tool/read/test and background callers invoke the SUT admission path and record zero new work while waiting/rejected. A distinct unrelated task remains eligible. |
| C07 / T008–T009 | Start mock in-flight attempts before rejection; observe fence and cancellation request through SUT wiring, then completed/cancelled/uncertain outcomes. No rollback claim, forced cancellation assumption or callback-based resume. |
| C08 / T008–T010 | Feedback leaves rejection; trusted resume/revise releases only its rejection hold; waiting/recovery-blocked/ended or unresolved claims refuse continuation. End preserves history, claims and accounting references. No direction becomes approval. |
| C08,C20 / T009–T010 | Public store direction retry returns original direction/event once. Repeat the identical four-selector CLI argv after epoch/scope changes: original metadata is recovered from authoritative history, not regenerated from current context. Changed response body conflicts; new stale-version direction conflicts; original retry after a later pause/end never restores old runnable state. |
| C10 / T008–T009 | Alternate action/request IDs, tools and equivalent spelling/encoding encounter the same task hold; forbidden operations stay denied after a valid direction. No semantic-equivalence classifier is required. |
| C20 / T008–T009 | Pending/decision/direction precommit failure, lost or malformed/protected receipt, expiry and activity failure close local admission. Observe no unauthorized dispatch or runnable gap. Preserve actual store state; unknown commit is not reported as definite noncommit. Real claim/pause serialization remains T020/T021. |
| C05,C11 / T010 | Actual subprocess rejects missing/duplicate/unknown/foreign selectors, empty input and fake operator data; no active-task default. Explicit test driver invokes real control and service, not a fake CLI result. |
| C11 / T010 | EOF/closed input and supported signal/terminal-loss paths cause no inferred response. Parent-retained mock state distinguishes interruption before submission from a committed response before output loss. Record OS/platform limits; do not count a child recreating its initial fixture as pause-retention evidence. |
| C08,C11 / T010 | Recorded resume/revise/end and identical retry exit 0 with recorded reason; end remains paused. Unrecorded hold/conflict/stale exits 3; invalid 2, denied 4, unavailable/uncertain 5. Output remains bounded and protected-data-free. |

Retain behavioral RED/GREEN, actual command/exit or signal, source snapshot, fixture/profile identity and observed direction/event/dispatch counts. Activity mocks only record attempts; no real effects are invoked. Phase 4 does not establish real all-agent admission, durable transactions, budget restoration, actual restart, full C09/C12–C19 or C24 acceptance, or completion of T011–T022.

## Human approval matrix mapping

| Matrix row | Required cases |
|---|---|
| Classification | C01–C04,C22–C23 |
| Workflow pause | C02,C06–C08,C20 |
| Binding | C09,C12–C16,C22 |
| Approve/resume | C01–C02,C12–C13,C18–C20 |
| Reject/adapt (explicit direction only) | C07–C10,C17 |
| Modify/approve | C09,C13–C16 |
| Forbidden handling | C03–C05,C10,C23 |
| Audit trail | C07,C11,C17–C22,C24 |

## Fixture, result and aggregation contract

Each immutable fixture contains schemaVersion, caseId, fixtureVersion/digest, story/FR/SC references, evidenceLevel (unit/mock/cli/real/restart), explicit profile, initial task/control/request/claim identities, trusted action/context, scripted operator events/failpoints, expected outcomes/counts, and oracle version. T003 owns fixture registration; hidden expected outputs never enter product-agent context. Test fixtures are under `tests/runtime/support/uc05/`, not the local-only `fixtures/` tree.

Each observed result records caseId/version/digest, source revision and dirty hashes when relevant, platform/toolchain/profile/adapter identities, evidenceLevel, command/exit status, expected and observed outcomes, side-effect/model-dispatch/prompt counts, restored versions/epochs, budget/claim reconciliation references, sanitized diagnostic refs, elapsed time and pass/fail/error/not-run. No source bodies, raw prompts, credentials or raw tool streams.

All required registered cases must be accounted for. Expected-denial cases pass only with expected safe denial and zero unauthorized dispatch/effects. Not-run/error/absent/mismatched fixture versions are not passes. Local mock-only passes never satisfy corresponding real/restart obligations. C24 compares two runs by case/fixture/profile/oracle identities; added/removed/incomparable cases remain explicit. No numeric latency score or model-quality measurement is claimed.

## Real acceptance conditions

T020 uses the actual shared admission/isolated executor and durable UC-04 store. Instrumentation may count entry into the real provider/agent admission paths without a live LLM call; no provider quality or network-dispatch success claim follows. Mocks cannot replace the control gate or durable store under test. The test driver supplies explicit human decisions and must not become a production autoapproval path.

T021 terminates/restores actual runtime processes at committed failpoints, not just in-memory reload. Evidence must include decision/claim/side-effect observations before/after interruption, retained task/run identities and ledger reservations. For Windows junction and Linux symlink containment, use the supported host and real executor; unsupported profiles remain not run, never extrapolated from unit tests. Docker resources must be disposable, host grading/credentials unavailable, and uncertain effects never blindly replayed.
