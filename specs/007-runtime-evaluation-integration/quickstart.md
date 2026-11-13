# Validation Guide: Observable Python Repair Evaluation

Commands below exercise the source/controlled tier where code has been delivered. T011 and T017 still lack real acceptance. T020–T034 have the separate controlled implementation release recorded in [release gates](contracts/decisions.md); restored code and green focused tests do not establish their full-task acceptance. No real provider/container invocation is authorized by this guide.

## Current Planning Checks

```powershell
node scripts/agents/planning-workflow.mjs validate --dir specs/007-runtime-evaluation-integration
node scripts/agents/planning-workflow.mjs status --dir specs/007-runtime-evaluation-integration
node scripts/ci/check-context.mjs
```

`status` checks automation only; independent reviews and implementation release are separate.

## Operator Prerequisites

After task release, operator configures host-only DeepSeek credentials, endpoint/model and pricing, explicit operational profile, catalog entries for local Python tasks/private graders, exact Docker image/platform and accepted UC-04/UC-05 adapters. Never put keys in chat, repository, task container or reports. No hidden default economic budget; inspect derived exposure in readiness.

Existing local `fixtures/uc03/success/` may be used if present and explicitly cataloged; it is not shipped. Recompute snapshot identity; task JSON's placeholder digest is not trusted. Prepare Python/pytest dependencies in the image before tasks; no downloads during execution. Real proof requires G-OWNERS/G-ROUTE/G-PROFILE/G-ISOLATION/G-APPROVAL. Missing prerequisites must remain blocked/not-run, not simulated success.

## Controlled Integration (T001–T010)

Run focused behavioral tests through the actual graph/driver with controlled dependencies. Verify generated proposal traversal rather than caller-provided plan/patch; explicit human pause/current approval; final report-to-grade identity; independent grading refusal; stale/unknown/failed cases. No controlled result is real-model evidence.

Future focused source commands:

```powershell
node --test tests/runtime/unit/evaluation-profile.test.ts tests/runtime/unit/evaluation-report-v1.test.ts tests/runtime/unit/uc03-agent.test.ts tests/runtime/unit/workflow-evaluation.test.ts tests/runtime/unit/workflow-grade.test.ts
pnpm run build
node --test dist/tests/runtime/unit/workflow-evaluation.test.js dist/tests/runtime/unit/workflow-grade.test.js
```

## First Real Python Repair (T011)

Planned CLI grammar:

```powershell
node dist/src/cli/evaluate.js preflight --profile local-flash --catalog local-cases
node dist/src/cli/evaluate.js run --profile local-flash --catalog local-cases --case C01
node dist/src/cli/evaluate.js status --experiment <returned-id>
node dist/src/cli/evaluate.js decision --experiment <id> --presentation <current-ref> --choice approve
node dist/src/cli/evaluate.js direction --experiment <id> --kind resume --task-version <current> --control-version <current> --decision <receipt-ref>
node dist/src/cli/evaluate.js continue --experiment <id> --version <current-version> --direction <returned-direction-ref>
```

Host configuration resolves IDs, not browser/model paths. Start/run generates and reports an idempotency key, passed as `--idempotency-key` (the contract's `idempotencyKey`); replaying the same key for the same experiment returns the original receipt instead of repeating effects. Decision records choice only; direction forwards explicit operator action to UC-05 control and returns its receipt. Continue validates that receipt/current state, never authority reconstructed from strings. Exercise reject then explicit revise/end; resume cannot bypass rejected/stale approval.

Custom bug command: `node dist/src/cli/evaluate.js submit --profile local-flash --repository <configured-id> --check-set <configured-id> --bug-file <public-input.json>`. File contains only section 1 public fields; its content is validated/bounded and immutable. Incomplete intake creates no runnable task. Custom run stays exploratory/ungraded, never borrows C01 acceptance. Clarification: `answers --experiment <id> --question <id> --question-digest <digest> --version <current> --answer-file <public-answers.json>`; this records reporter data only. Obtain explicit direction then continue after current approval/intake conditions hold. Material frozen-case criterion changes require a newly pinned case version, never overwrite old grade/task accounting.

Expected evidence: baseline pytest failure; model-generated diagnosis/plan; actual bound human approval; model-generated minimal diff; focused/regression passes; protected tests unchanged; fresh read-only reviewer; independent final-snapshot grade; task/run/provider/accounting/view/profile references; actual usage and safe diagnostics. Capture all unsuccessful attempts too. At least one successful repair is needed for SC-001. C01 selected pass can exit 0 while suite acceptance remains incomplete because C02–C17 were not all run.

## Faults and Comparison (T012–T014)

Implemented controlled checks (source; emitted counterparts after `pnpm run build`):

```powershell
node --test tests/runtime/integration/evaluation-failures.test.ts tests/runtime/integration/evaluation-comparison.test.ts
node --test tests/runtime/unit/evaluation-diagnostics.test.ts tests/runtime/unit/workflow-comparison.test.ts
```

Workflow comparison is library-only: `compareWorkflowEvaluations(baseline, candidate, { strictSameConfig })` in `eval/uc03/compare.ts`. The existing `node dist/eval/uc03/compare.js --baseline <file> --candidate <file> [--output <file>]` entry still calls only the legacy `compareEvaluations`, so no CLI command compares workflow reports yet. Diagnostics are produced by `createEvaluationDiagnostic` (`src/runtime/evaluation-diagnostics.ts`) and attached to non-complete `runUC03Graph` results (`src/uc03/graph.ts`). The workflow report stores one bounded `diagnostic` string composed from that record's bounded component/attribution/reason codes; its evidence refs and milestone kinds are still dropped at that boundary. Comparison identity guards treat an unobserved (`null`) repository, grader or pinned initial repository as **unverified**, which refuses the pair — two not-run reports cannot compare as compatible. The console's comparison port is injected by tests only: no production adapter maps the page's `guarded`/`strict` selection onto `strictSameConfig` yet.

Required fault witnesses: missing config/provider, denied tool, malformed model output, test regression, stale/rejected approval, uncertain dispatch/effect, unknown metrics, missing grader and altered final snapshot. Assert returned status **and** persisted state/no downstream effects. Keep controlled/real tiers explicit. Every listed witness here is controlled; the two-real-attempt comparison half is not run because T011 is not-run. Two real experiments would use fresh tasks with same initial case/repository/grader; changed configuration is displayed. Mismatched case/grader refuses comparison; unknown cost never becomes zero.

Expected refusal/clarification/exhaustion cases are graded against their own safe-outcome/no-effect predicates. They can pass evaluation without completing a repair; only repair-success cases require the complete successful repair evidence chain.

Required report/CLI witness: expected C02 clarification satisfies its case predicate and finishes selected pass/exit 0 while product task remains paused; C01 awaiting approval remains selected pending/exit 3. Neither may resume automatically or claim verified repair; omitted suite cases still make suite acceptance incomplete.

## Local Console (T015–T017)

Controlled server checks only (source; emitted counterparts after build):

```powershell
node --test tests/runtime/unit/evaluation-console.test.ts tests/runtime/unit/evaluation-console-page.test.ts
```

No `serve` command exists: `src/cli/evaluate.ts` supports `preflight`/`run` and operator `status`/`decision`/`direction`/`continue` commands, but does not launch `createConsoleServer`; its only call is `tests/runtime/unit/evaluation-console.test.ts`. The server binds `127.0.0.1`, requires exact `Host`/`Origin` and an `x-operator-token` header, and takes the UC-05 approval and comparison surfaces as injected ports. The page checks are string-level assertions on the rendered document, not a browser run.

Once wired, the journey is: open the loopback URL; enter the host-issued session token locally (never in URL). Select case, submit bug input, inspect progress, explicitly approve/reject the current presentation, submit bound continuation and inspect diff/checks/diagnostics/selection/suite/comparison. Repeat stale and double-submit requests; assert no extra provider call/patch. Test cross-origin/Host substitution, escaped hostile output and private-artifact access refusal. T017 requires actual browser actions/results to be recorded against the exact candidate; API-only testing is not browser acceptance. T017 is **not run**: it depends on T011 (G-REAL) and no browser was driven. No browser credential entry/config editor or arbitrary shell.

## Acceptance and Handoff

Recorded 2026-11-04 on `feat/uc03-diagnostics-comparison-console` (base HEAD `e80b7b9e`, 20 pre-existing uncommitted paths plus the five T018 documents). Observed: `node --test tests/runtime/unit/evaluation-diagnostics.test.ts` 13/13 pass; `tests/runtime/unit/workflow-comparison.test.ts` 12/12; `tests/runtime/integration/evaluation-failures.test.ts` 13/13; `tests/runtime/integration/evaluation-comparison.test.ts` 5/5; `tests/runtime/unit/evaluation-console.test.ts` 13/13; `tests/runtime/unit/evaluation-console-page.test.ts` 9/9; `tests/runtime/integration/evaluation-success.test.ts` 4/4; combined integration trio 22/22. Emitted counterparts after `pnpm run build`: eight unit files 78/78, three integration files 22/22. `pnpm run typecheck` exit 0; `pnpm run build` exit 0; `eslint src eval tests` and `prettier --check` over the changed paths exit 0. All tiers are controlled/mock; no provider, container or browser ran. The full runtime lane (`node scripts/ci/run-runtime-tests.mjs`, 91 emitted files, 571845ms) is **not clean**: one failure in `dist/tests/runtime/approvals/acceptance.test.js` (`{comparable:false}` vs expected `true`). That test runs two children of the identical command against verified-unchanged source; in this lane the first was killed at 240150ms (`exitStatus:null`, `signal:SIGTERM`) after reporting 263 of 283 checks, while the second completed the same command in 113856ms with 283/283 passing (matching the test's own `expectedCheckCount = 283`). Import tracing found zero transitive edges from those suites to anything this branch changed (0 hits over 108 source and 99 emitted files). The suites are healthy; the first, cold child alone exceeds the test's own 240s cap on this hardware, so the test is timing-sensitive here rather than impossible to pass, and no full-suite pass is claimed. T011 stays not-run (G-OWNERS/G-ROUTE/G-PROFILE/G-ISOLATION/G-APPROVAL unmet), T017 stays not-run (inherits T011), and suite acceptance stays `incomplete` (17 required, satisfied subset). T019 recorded the delegated agreement and T020–T034 were separately released for source/controlled-tier implementation on 2026-11-04 ([decisions](contracts/decisions.md)); that release adds no real-tier evidence, At that 2026-11-06 checkpoint, T025–T031 were partial because T026 had a confirmed contract gap; T019, T021–T024, T032–T033 and — after the 2026-11-06 batch — T020 and T034 were recorded only at their scoped criteria. That checkpoint predates the separately released T020–T034 completion work and the T030 controlled merger verdict below; it did not automatically change any task status.

After focused checks, run `pnpm validate:runtime`, contributor checks and context consistency per repository publication policy. Retain exact source/emission, image/profile/adapter/model/pricing/grader identities, commands/exit codes and actual/not-run criteria under ignored session. Update existing context through `update-context.mjs`; do not force-add local artifacts or fixtures. Existing UC-03 ledgers independently judge T024/T025/T028; no broad/full-suite/restart claims from a single successful case.

## Host-composition correction validation — source/controlled recovery

The decision record contains T019's single delegated-attestation agreement and the later source/controlled release of T020–T034. Pinned real owner implementations and production execution gates remain absent. Test-only deliveries keep the controlled label. `prepareControlledUC03Host` returns `controlled-ready` for complete mock deliveries; `runControlledUC03GraphV02` and the driver's distinct controlled binding exercise the versioned path without relabeling mocks. Production assembly and execution continue to refuse mock ports; the controlled binding cannot run in a real evaluation context.

Focused source commands (run the applicable groups and retain candidate-bound results):

```powershell
node --test tests/runtime/contract/uc03-production-ports.test.ts tests/runtime/unit/guarded-read-capability.test.ts tests/runtime/unit/trusted-host-snapshot.test.ts tests/runtime/contract/baseline-evidence-adapter.test.ts tests/runtime/unit/host-action-context.test.ts tests/runtime/contract/command-view-owner-binding.test.ts
node --test tests/runtime/unit/uc03-coder-v02.test.ts tests/runtime/integration/uc03-v02-route.test.ts tests/runtime/contract/uc03-host-bootstrap.test.ts tests/runtime/unit/uc03-host-cli.test.ts tests/runtime/integration/uc03-host-pipeline.test.ts
node --test tests/runtime/unit/repository-baseline-source.test.ts tests/runtime/unit/repository-diff.test.ts tests/runtime/unit/reviewer-v02-accounting.test.ts
node --test tests/runtime/contract/uc03-controlled-host.test.ts tests/runtime/contract/evaluation-composition.test.ts tests/runtime/unit/evaluation-cli.test.ts
pnpm run typecheck
pnpm run build
node --test dist/tests/runtime/integration/uc03-v02-route.test.js dist/tests/runtime/contract/uc03-host-bootstrap.test.js dist/tests/runtime/integration/uc03-host-pipeline.test.js
```

Also run the emitted counterparts of every focused source test listed above and existing affected legacy source/emitted suites; retain commands/exits. The sole full local runtime/contributor publication gate runner remains `publish` under repository policy.

Recovery on `feat/uc03-route-recovery` restores the missing route entry, shared port unions, generation dispatch and replan forwarding in `c71d209a`, then reuses the retained bootstrap, CLI and pipeline witnesses through `36b6aa9d`. At that candidate, the host/composition/CLI/pipeline source group passes 47/47 and typecheck exits 0; the preceding route/coder/replan/reviewer group passes 29/29. These are historical checks of that recovery step, not results for subsequent edits. The original pipeline witness stops at the first owner reload and does not prove full traversal.

Subsequent recovery adds a direct-shell regression (valid host references reach assembly-unavailable exit 4; malformed configuration remains exit 2), separate controlled assembly/dispatch, and a public generation regression using the canonical model-input validator. The latter first failed because graph and model computed incompatible context digests; the v0.2 branch now uses the canonical digest while preserving legacy controlled behavior. Retain the final source/emitted results separately. At that intermediate candidate, generated repair, reject/revise, approval-context consumption and original UC-03 closure still required their own checks; restoring code did not automatically accept T027–T031. The later T030 result is recorded below.

At `854d2017` (an earlier checkpoint before T030), the first controlled journey reaches persisted `AwaitPlan` with `pending-approval` after baseline reproduction, a fenced source read and two model-boundary turns under fresh canonical admissions. Integrated source checks for coder generation, pipeline and controlled admission pass 32/32; typecheck exits 0. The generated plan contains no caller-supplied solution and no edit occurs before explicit approval. This is a bounded checkpoint, not a completed repair or full T030 acceptance. Mid-run clarification previously needed an owner-contract amendment; the 2026-11-07 [host contract](contracts/host-composition.md) §8 supplies it as an additive `TaskState.clarification` record plus the guarded `Investigate → NeedsInfo → Investigate` pair. The amended contract permits the path; nothing implements it yet, and T026 acceptance requires the implemented bound-answer continuation witness plus T027's route wiring.

| Witness | Required observed result | Task |
|---|---|---|
| Complete/missing/stale owner delivery | Complete controlled assembly labeled controlled; missing/stale production assembly unavailable, zero mutation/dispatch/allocation | T020/T028 |
| Read during pause/fence race | Closure never runs on stale authority; repository containment/redaction still enforced | T021 |
| Real snapshot and baseline restore | Measured identities plus exact durable ack/lookup; drift/forged ack/uncertainty blocks | T022/T023 |
| Changed/unknown registered action | No reconstructed policy facts or reused decision; explicit new bound authority needed | T024 |
| Nonliteral correct view vs each mismatch | Correct measured values accepted by owner fixture; mismatch yields no executor call | T025 |
| Measured isolation record | Build issues one record accepted by `isMeasuredCommandViewIsolation`; absent, forged, foreign-id and foreign-digest records refuse; each of the four refusals reached by its own fixture (`ISOLATION_RECORD_UNMEASURED`, `_VIEW_MISMATCH`, `_DIGEST_MISMATCH`, `_VIEW_UNHASHED`), with `_VIEW_UNHASHED` reached only by a view whose declared digest no longer re-derives from its content; precedence proved separately by one combined-violation fixture yielding `_UNMEASURED`; `admitMeasuredCommandView` returns the record beside the view; `commandExecutionLimits` accepts a matching policy by value and throws `COMMAND_RESOURCE_POLICY_MISMATCH` when only `policy.isolationProfileRef` differs (the throw is the whole witness — `commandExecutionLimits` takes no controller, so a zero-`executeContainer` clause would hold for a broken implementation too) | T025 |
| Provider and coder test action | Exact fourth context forwarded; one claim/attempt/charge; independent per-check repository admission | T026 |
| Explicit material replan/replay/race/exhaustion | Candidate payload/digest checked before commit; one durable charge/current transition; same replay same committed state/receipts, changed content/digest mismatch/loser denied, fourth refused, uncertain commit blocks | T027 |
| CLI and full controlled traversal | Controlled host bootstrap/graph/evaluator used; C02 selected pass/task paused versus C01 pending; protected sentinels intact. **Trusted host-file controls are supported**: `runEvaluateCli` validates the full control command, uses explicit programmatic `options.control` first, and otherwise loads `--host` then uses the trusted assembly's `resolved.control` for `status`, `decision`, `direction`, or `continue` (`src/cli/evaluate.ts:287-297`). A missing or invalid control binding still returns `OPERATOR_CONTROL_UNAVAILABLE` with exit 4 (`src/cli/evaluate-control.ts:110-118`). This control CLI is not a server launcher: no `serve` command exists, `createConsoleServer` is called only by its unit test (`src/runtime/console-server.ts`, `tests/runtime/unit/evaluation-console.test.ts`), and page assertions remain string-level rather than browser evidence. | T029/T030 |
| Recovery lacks proof | Unknown start/unfenced closure/unsupported patch reconciliation stays blocked, no repeated effect | T028/T030 |
| Retained source and actual diff | Original source bytes available after edits/continuation; changed/deleted/added files measured; wrong base/missing source/partial manifest refuses | T033/T032 |
| Inspect loop, clarification and stop | Observed tool result reaches next freshly admitted request; an explicit record-less wait spends zero dispatches while a proposal-produced pause spends exactly one `coder:propose-plan` dispatch and no more; stop/exhaustion withholds completion | T026/T027/T030 |
| Reviewer durable chain | Distinct reviewer role/current context, exactly one claim/attempt/outcome; stale/fenced zero transport, possible-dispatch timeout charged uncertain/no replay | T034/T030 |

T031 records this evidence without accepting original UC-03 findings automatically. For a real attempt, separately confirm current G-OWNERS/G-PROFILE/G-ROUTE, then obtain execution release and run original T024 guard-composed containment and T025 actual approvals on the exact candidate/profile. T011/UC-03 T028 require actual provider/tools/state/gate/reviewer and independent final-snapshot grade, with one successful repair. Earlier direct Docker probes or local durable handoff tests are not these proofs. Missing real prerequisites are not-run/nonzero. Retain ignored evidence; do not force-add fixtures or local verification archives.

## Integrated controlled correction — T030 (2026-11-13)

Independent verification accepted complete T030 controlled criteria on candidate `068c9718cbae828d45fc658e32613df68b76faf4` (`.agent-work/2026-11-12/feature007-completion/merger/T030-068-verdict.json`, verdict SHA-256 `c878754459fe535edd1eeb1d3b35e534af86ae1d16e9580bc260a8f18bcd210a`). The repaired grading/pipeline tests pass 78/78 in source and 78/78 from the fresh `dist/`; `tsc --noEmit` and the fresh build both exit 0. The independent service/report probe passes 10/10 and the private-grading boundary probe passes 3/3. The scoped worker commands and statuses are in `.agent-work/2026-11-13/feature007-host-resume/T030-repair-command-status.json`; its artifacts are `T030-repair-source.log`, `T030-repair-emitted.log`, `T030-repair-typecheck.log` and `T030-repair-build.log` in that session directory. These are focused checks, not a full suite. The merger separately reassessed unaffected prior T030 inputs: the earlier 80/80 source and emitted matrix plus owner-state parity 4/4 remain evidence only for unchanged scope; `T030-068-verdict.json` records the impact analysis.

The controlled service journey reaches `Deliver`/`COMPLETED`, binds the hidden check ID through admission, execution and safe result, and produces a C01 selected pass with exit 0. Its report still says `real: false`, and suite acceptance remains incomplete. Missing or wrong admission/result identity, failed grading outcome and post-grade snapshot drift remain not-run/fail and cannot be upgraded from graph completion. Repeated inspection/continuation does not rerun the graph or hidden executor or add provider, command, patch, journal or owner effects. The repaired candidate also has an independent concurrent graph witness for material replan replay: two identical in-flight requests produce one owner commit/reservation and the same committed receipts/state, without an extra command or patch. Criterion-level evidence is in `T030-068-verdict.json`; the earlier worker not-run replay row and prior blocked M030-01 verdict remain historical records, not current gaps.

T030 is checked in the task ledger after independent verification; T020–T030 are checked. T019's one delegated agreement record remains distinct from its task acceptance: T019 is still unchecked because its remaining acceptance requires three explicit statements. T031 changes no task checkbox, original acceptance, or fixture publication. No original-owner review/message was issued for original UC-03 closure; that review is pending.

The 2026-11-04 implementation release for T020–T034 remains source/controlled only. These gates remain open:

- G-OWNERS: pinned, independently confirmed production UC-04/UC-05 deliveries and owner implementations.
- G-PROFILE: admitted credentials, pricing/billable bounds, image/platform and finite operational profile.
- G-ROUTE: original UC-03 T026/T066 obligations and original-owner closure review.
- G-ISOLATION / UC-03 T024: actual hostile-code, command-view, network/resource and protected-sentinel containment on the accepted profile.
- G-APPROVAL / UC-03 T025: actual owner-backed command-view admission, approval and continuation.
- G-REAL / T011: one successful real repair using actual provider, tools, state/gate/reviewer and independent final-snapshot grade; T011 remains unchecked until that evidence exists.
- T014 real comparison: two admitted real attempts, gated by T011.
- T017: actual browser journey, gated by T011. Source console tests are not browser evidence.
- G-RESTART / original UC-03 T032: process-kill recovery. T018 full Feature 007 acceptance remains separate.

The source has no `serve` CLI command. `createConsoleServer` currently has only a unit-test caller, and `createEvaluationService` stores experiments, receipts and the active ID in process-local maps; this does not provide a durable session or restart guarantee. Host-file CLI control commands can use trusted assembly bindings but do not launch the console. No paid provider call, container run, production owner delivery, browser run, restart or full-suite acceptance is claimed.

### FR-013–018 and SC-006–007 evidence map

| Requirement | Candidate-bound witness and retained evidence | Limit |
|---|---|---|
| FR-013 | Candidate `068c9718`; `tests/runtime/contract/uc03-host-bootstrap.test.ts`, `tests/runtime/contract/evaluation-composition.test.ts`, `tests/runtime/unit/uc03-host-cli.test.ts`, `tests/runtime/unit/evaluation-cli.test.ts`, and service traversal in `tests/runtime/integration/uc03-host-pipeline.test.ts`; T028/T029 receipts and T030 merger verdict. | Controlled assembly and control bindings only; production owner delivery/profile remain gated. |
| FR-014 | `tests/runtime/unit/uc03-coder-v02.test.ts`, `tests/runtime/unit/reviewer-v02-accounting.test.ts`, `tests/runtime/integration/uc03-v02-route.test.ts`, plus the constructed coder, reviewer, repair/replan and report path in `uc03-host-pipeline.test.ts`; T030-068 verdict. | Controlled v0.2 authority path; original UC-03 T026/T066 closure remains owner-reviewed. |
| FR-015 | `tests/runtime/unit/guarded-read-capability.test.ts`, `tests/runtime/unit/trusted-host-snapshot.test.ts`, and the T030 inspect/fresh-admission traversal in `uc03-host-pipeline.test.ts`. | Controlled host measurements do not prove hostile-code containment. |
| FR-016 | `tests/runtime/contract/baseline-evidence-adapter.test.ts`, `tests/runtime/unit/repository-baseline-source.test.ts`, `tests/runtime/unit/repository-diff.test.ts`, and the T030 baseline/delivery path. | Production durable owner acknowledgment and lookup are still gated by G-OWNERS. |
| FR-017 | `tests/runtime/unit/host-action-context.test.ts`, `tests/runtime/integration/uc03-host-pipeline.test.ts`, and `tests/runtime/unit/evaluation-cli.test.ts`; current approval/direction/continuation is exercised through controlled owners. | Actual UC-05 control and UC-04 accounting delivery remain gated by T025/G-APPROVAL and G-OWNERS. |
| FR-018 | `tests/runtime/contract/command-view-owner-binding.test.ts`, `tests/runtime/unit/uc03-replan-port.test.ts`, `tests/runtime/unit/reviewer-v02-accounting.test.ts`, and T030 same-graph replay/effect/accounting witness. | The measured view seam is controlled; actual command-view containment and production exactly-once owner receipts remain gated. |
| SC-006 | Row-level positive and missing/stale/substituted/refusal evidence in `.agent-work/2026-11-12/feature007-completion/T030-evidence.json` and the independent T030-068 verdict. | Only the listed controlled capabilities and rows are proven; no real readiness is implied. |
| SC-007 | T030-068 same-graph concurrent replay, repeated service/control requests, fourth-replan refusal and bounded effect/accounting rows; `T030-independent-068-v2.log`. | Mock owner receipts do not establish foreign-owner transactions or real effects. |

For the focused repaired source/emitted/type checks, use the exact commands in `T030-repair-command-status.json`; for independent criteria and observed outcomes, use the T030-068 merger verdict. Neither should be replaced by the pre-repair 80/80 receipt or by an aggregate full-suite claim.
