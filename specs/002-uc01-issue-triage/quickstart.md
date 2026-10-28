# Quickstart: incremental UC-01 verification

**Status**: T001–T010 implement approved contracts, controlled fixtures, intake, assessment, later-answer clarification and configured recommendation. Phase 5 was separately authorized on 2026-10-19 (Asia/Bangkok); see [decisions](contracts/decisions.md). The controller accepts only the explicit mock fixture profile. T014 safety regression consolidation was separately authorized on 2026-10-20 (Asia/Bangkok) and is complete at the controlled local level; T013 was separately authorized on 2026-10-28 for actual UC-03 receiver compatibility under uc01-uc03-receiver-v1. T011/T012, T015/T016 and real runtime/shared evaluation remain separately gated.

## Existing planning and repository checks

From the repository root in PowerShell:

```powershell
node scripts/agents/agent-context.mjs assignment --uc UC-01
node scripts/agents/agent-context.mjs handoff --tasks specs/002-uc01-issue-triage/tasks.md
node scripts/ci/check-context.mjs
node scripts/ci/check-runtime.mjs
node --test
```

Assignment/handoff read the canonical task ledger and current owner/scope; context checks validate links/facts. Runtime and full Node suites include local UC-01 tests alongside bootstrap/UC-03/contributor checks. These exercise controlled behavior, not real classification accuracy or project evaluation. Report actual exit status, failures and skipped checks. Existing `pnpm run validate:runtime` is a build/lint/type/test command, not a model evaluation runner.

Run the focused implemented slice with:

```powershell
node --test tests/runtime/uc01/*.test.ts
```

At source `3b4d4f3ada61b0734b221100589101ba537c45e9`, all 123 focused tests passed (84 prior tests and 39 Phase 4 tests). `IntakeBinder` preserves validated caller input and admits exact-digest excerpts through a trusted resolver. `bindClarification` validates same-issue answers and projects immutable prior and unanswered questions; `projectClarification` preserves unanswered material questions and rejects identity reuse or merged overflow. `IssueAssessor.assessIssue` takes explicit injected ports, clock, `uc01-fixture-v1` profile and the approved 500/250/750 token reservation ceiling with synthetic pricing identity. Later calls resolve the opaque continuation and compare its full immutable projection before excerpt admission or constrained activity; model input receives prior questions and admitted answer-origin evidence, while the opaque reference stays outside provider-visible content. Shared task accounting retains prior spending and uncertain reservations across invocation/run IDs. The controller guards bounded read/search and model operations, settles usage, validates assessment/evidence and binds material questions through the caller port. Deadline checks prevent successful results after reconciliation, resolution, binding or telemetry overruns. At that historical Phase 4 revision, clarification supplied no approval and destinations stayed undetermined. No provider, filesystem, persistence, policy or dispatch adapter is selected by this entry point. Behavioral RED/GREEN, case/source/config and merger evidence are retained locally under `.agent-work/2026-10-19/uc01-phase4/`.

At Phase 5 integrated verification merge `3b393bc0d2ee5248c9777de8633d206d45436e10` (unchanged UC-01 implementation from `b358b6664152b3241e0a7f1c0be6898c557a73b5`), 150 focused UC-01 tests pass; typecheck/lint/build and 511 compiled runtime tests pass; the full Node suite passes 1183 tests with 1 existing Windows skip and 0 failures. `projectRecommendation` validates configured compatible destinations and evidence-linked responsibility rationale without IO; `IssueAssessor` composes it after clarification projection. Empty/unsupported destinations retain uncertainty; unresolved route ambiguity produces bound material questions. C07,C12–C16,C19,C22 cover feature urgency, catalog changes, forbidden capabilities, malformed output, injection, denied/exhausted calls and finite question/output bounds. No dispatch/approval/repair task is created. Phase 5 RED/GREEN and integration evidence is retained locally under `.agent-work/2026-10-19/uc01-phase5/`; these checks establish only controlled local behavior.

At T014 source `6aa8727ee671f7ebd225cb9ece82a7faca934f6b`, run `node --test tests/runtime/uc01/safety.test.ts` (88 passed) or the full UC-01 command above (238 passed, including all 150 earlier tests). `node scripts/ci/check-runtime.mjs` passed typecheck/lint/clean build and 945 compiled tests; `node --test` passed 2052 tests with 1 existing Windows skip and 0 failures. C14–C19,C22 consolidate injection, unsupported tools, protected/forged evidence, guard ordering, finite caps, uncertain usage and cumulative invocation accounting through the approved mock ports. The pre-implementation oracle inventory and final citation sensitivity probe are retained locally in `docs/verification/uc01-t014-verification.md`; the probe failed as expected when a disposable process deliberately accepted invalid output. Runtime source, earlier tests and dataset 1.0.0-draft.2 are unchanged. No real containment/restart, receiver integration or model-quality check is established.

## Incremental slice workflow

1. T001 records user-confirmed member approval of domain scope/consumer contracts and the finite fixture profile; keep shared evaluation API/version agreement separately pending with Tai. Each implementation slice requires separate authorization, currently covering T001–T010 and separately authorized mock-only T014.
2. T002 designs product/evaluation vectors and grading statuses before validator code. T003 defines bounded mock scripts/call spies; T004 prepares versioned C01–C22 inputs, private expected outcomes/rules and development/held-out split. Validate isolation and case/result identities before feature work.
3. T005–T006 execute available US1 cases immediately, including irrelevant input, invalid output, injection and budget guards. T007–T008 do the same for clarification/answer injection, then T009–T010 for catalog/routing. Run impacted earlier regressions and capture each result before accepting the slice.
4. Use the existing Node test mechanism and the implemented module paths above for local UC-01 tests, with versioned case/rule design and injected ports. This is local test coverage, not a parallel runner. Later-answer reassessment is implemented at the mock level; configured recommendation is implemented at the same controlled level.
5. T011/T012 execute real adapter/restart/policy checks only with actual owner deliveries, versions and configured authority. T013 separately exercises actual UC-03 intake under uc01-uc03-receiver-v1 after UC-03 T011/T012, without provider access or dispatch. Missing components yield not-run records with reasons and retry gates. T014 consolidates earlier safety regression evidence; it never postpones early available attack checks.
6. T015 uses the corpus/rules designed earlier, approved thresholds and actual model/runner deliveries for two comparable scored runs and shared registration/conformance. T016 reconciles runtime gates and separates UC-01 verdict from project verdict. No context capability promotion without complete required real evidence.

## Current availability and later run conditions

| Evaluation scope | Current availability | Condition to execute |
|---|---|---|
| UC-01 contract/mock behavior | T002–T010 and T014 suites available; 238 focused tests passed at the T014 source revision above | Explicit controlled ports/profile; real delivery and production gates remain separate |
| Real shared adapters | not-run: required real deliveries absent | X-READ-MODEL, X04-STATE, X05-GATE and A-PRODUCTION; actual versioned integration |
| UC-03 receiver compatibility | C21 source/emitted 14/14 pass against actual intake | uc01-uc03-receiver-v1; upstream mock provenance retained; no dispatch |
| Held-out model quality | not-run: no approved corpus/grader/provider run | Prepared T004 data design, A-EVALUATION/A-PRODUCTION, actual model and required integrations |
| Shared scoped registration | not-run: runner/signatures not delivered/agreed | X-EVAL-AGREEMENT and X-EVAL-RUNNER; actual T015 compatibility evidence |
| Whole project / one-command entry point | not-run: no runner or approved required-UC/case manifest | Tai's real runner, confirmed course-wide requirements and all required UC registrations/deliveries |

This availability table is not a task ledger or execution result. Missing checks cannot be recorded as pass. Existing repository checks have separate coordinator logs; none establish these future capabilities.

## Evidence and shared compatibility

Use [evaluation records](contracts/evaluation.md) for case/dataset/rule IDs, code/subject/config identities, provenance, pass/fail/error/not-run and safe trace/evidence refs. Preserve failures and unknown usage; raw prompts/secrets/gold labels stay out of public artifacts. Real runs record actual latency/tokens/cost or explicit unknowns, never mock zeros presented as measurements. Keep equivalent corpus/oracle/config identities for before/after comparison and report intentional treatment changes.

The same case definitions must later register through Tai's approved seam. Prove UC-01-only selection, no global ID collisions, required-project coverage, isolated result namespaces and non-passing overall status for required UC failures/missing work. No actual shared command is documented until Tai/leader selects and delivers it. See [decisions](contracts/decisions.md) for pending sources, approvals and delivery gates.


## Scoped T013 receiver compatibility — 2026-10-28

The [receiver contract](../001-verified-code-repair/contracts/uc01-receiver.md) is delivered by UC-03 T012. Run `node --test tests/runtime/uc01/receiver.test.ts` and its emitted counterpart after build: both pass 14/14. C21 uses the actual IssueAssessor and receiver, preserving the original report/recommendation and mock provenance. Caller reproduction, expectations, criteria, checks, budgets and identity are never generated from an assessment; unresolved material questions remain needs-info. Configured IDs, source/version checks, identity/snapshot/config binding and zero downstream effects are exercised.

The integrated source/emitted regression passes 587/587. [UC-03 scoped evidence](../001-verified-code-repair/quickstart.md#scoped-supplied-task-intake-and-receiver-evidence--2026-10-28) records RED/GREEN and limitations. X-RECEIVER agreement and actual delivery/check evidence are established for uc01-uc03-receiver-v1; task acceptance remains in the sole ledger. T011/T012 real shared-adapter integration, restart and T015/T016 model/shared evaluation remain separately gated.
