# Quickstart: incremental UC-01 verification

**Status**: T001–T006 implement the approved contract, controlled fixtures, validated intake and initial assessment slice. Phase 3 was separately authorized on 2026-10-18 (Asia/Bangkok); see [decisions](contracts/decisions.md). The controller accepts only the explicit mock fixture profile. T007 onward requires separate authorization; real runtime and shared evaluation remain gated.

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
node --test tests/runtime/uc01/contract.test.ts tests/runtime/uc01/ports.test.ts tests/runtime/uc01/fixtures.test.ts tests/runtime/uc01/intake.test.ts tests/runtime/uc01/assess.test.ts
```

At source `0516312a12157ea3e275fa10862e3e67f07771a6`, all 84 focused tests passed. `IntakeBinder` preserves validated caller input and admits exact-digest excerpts through a trusted resolver. `IssueAssessor.assessIssue` takes explicit injected ports, clock, `uc01-fixture-v1` profile and the approved 500/250/750 token reservation ceiling with synthetic pricing identity. It guards bounded read/search and model operations, settles actual or conservatively reserved usage, validates assessment/evidence, and binds initial questions through the caller port. Deadline checks prevent successful results after reconciliation, binding or telemetry overruns; uncertain accounting remains charged. All destinations stay undetermined. No provider, filesystem, persistence, policy or dispatch adapter is selected by this entry point. Behavioral RED/GREEN and case/source/config evidence are retained locally under `.agent-work/2026-10-18/uc01-phase3/`.

## Incremental slice workflow

1. T001 records user-confirmed member approval of domain scope/consumer contracts and the finite fixture profile; keep shared evaluation API/version agreement separately pending with Tai. Each implementation slice requires separate authorization, currently through T006.
2. T002 designs product/evaluation vectors and grading statuses before validator code. T003 defines bounded mock scripts/call spies; T004 prepares versioned C01–C22 inputs, private expected outcomes/rules and development/held-out split. Validate isolation and case/result identities before feature work.
3. T005–T006 execute available US1 cases immediately, including irrelevant input, invalid output, injection and budget guards. T007–T008 do the same for clarification/answer injection, then T009–T010 for catalog/routing. Run impacted earlier regressions and capture each result before accepting the slice.
4. Use the existing Node test mechanism and the implemented module paths above for local UC-01 tests, with versioned case/rule design and injected ports. This is local test coverage, not a parallel runner. Later-answer reassessment and configured recommendation remain T007–T010.
5. T011–T013 execute real adapter/restart/policy/receiver checks only with actual owner deliveries, versions and configured authority. Missing components yield not-run records with reasons and retry gates. T014 consolidates earlier safety regression evidence; it never postpones early available attack checks.
6. T015 uses the corpus/rules designed earlier, approved thresholds and actual model/runner deliveries for two comparable scored runs and shared registration/conformance. T016 reconciles runtime gates and separates UC-01 verdict from project verdict. No context capability promotion without complete required real evidence.

## Current availability and later run conditions

| Evaluation scope | Current availability | Condition to execute |
|---|---|---|
| UC-01 contract/mock behavior | T002–T006 suites available; 84 focused tests passed at the source revision above | Explicit controlled ports/profile; later story suites require separate T007–T010 authorization |
| Real adapters / receiver | not-run: required real deliveries absent | X-READ-MODEL, X04-STATE, X05-GATE, X-RECEIVER and A-PRODUCTION; actual versioned integration |
| Held-out model quality | not-run: no approved corpus/grader/provider run | Prepared T004 data design, A-EVALUATION/A-PRODUCTION, actual model and required integrations |
| Shared scoped registration | not-run: runner/signatures not delivered/agreed | X-EVAL-AGREEMENT and X-EVAL-RUNNER; actual T015 compatibility evidence |
| Whole project / one-command entry point | not-run: no runner or approved required-UC/case manifest | Tai's real runner, confirmed course-wide requirements and all required UC registrations/deliveries |

This availability table is not a task ledger or execution result. Missing checks cannot be recorded as pass. Existing repository checks have separate coordinator logs; none establish these future capabilities.

## Evidence and shared compatibility

Use [evaluation records](contracts/evaluation.md) for case/dataset/rule IDs, code/subject/config identities, provenance, pass/fail/error/not-run and safe trace/evidence refs. Preserve failures and unknown usage; raw prompts/secrets/gold labels stay out of public artifacts. Real runs record actual latency/tokens/cost or explicit unknowns, never mock zeros presented as measurements. Keep equivalent corpus/oracle/config identities for before/after comparison and report intentional treatment changes.

The same case definitions must later register through Tai's approved seam. Prove UC-01-only selection, no global ID collisions, required-project coverage, isolated result namespaces and non-passing overall status for required UC failures/missing work. No actual shared command is documented until Tai/leader selects and delivers it. See [decisions](contracts/decisions.md) for pending sources, approvals and delivery gates.
