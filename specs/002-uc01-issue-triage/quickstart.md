# Quickstart: incremental UC-01 verification

**Status**: T001 artifact/consumer agreement approved; subsequent implementation is not authorized. No UC-01 runtime/tests, executable evaluation dataset or shared evaluation runner is implemented by this revision. Future implementation paths have T001 ownership agreement; no new runner command or implementation path is selected.

## Existing planning and repository checks

From the repository root in PowerShell:

```powershell
node scripts/agents/agent-context.mjs assignment --uc UC-01
node scripts/agents/agent-context.mjs handoff --tasks specs/002-uc01-issue-triage/tasks.md
node scripts/ci/check-context.mjs
node scripts/ci/check-runtime.mjs
node --test
```

These commands exist now. Assignment/handoff show Thai, approved T001 artifacts, one completed task and 15 unchecked tasks; context checks validate links/facts. Runtime and full Node suites exercise existing bootstrap/UC-03 contracts/mocks/contributor helpers, not UC-01 cases, classification accuracy or project evaluation. Report actual exit status, failures and skipped checks. Existing `pnpm run validate:runtime` is a build/lint/type/test command, not a model evaluation runner.

## Future authorized slice workflow

1. T001 records user-confirmed member approval of domain scope/consumer contracts and the finite fixture profile; keep shared evaluation API/version agreement separately pending with Tai. Directional agreement grants no implementation permission.
2. T002 designs product/evaluation vectors and grading statuses before validator code. T003 defines bounded mock scripts/call spies; T004 prepares versioned C01–C22 inputs, private expected outcomes/rules and development/held-out split. Validate isolation and case/result identities before feature work.
3. T005–T006 execute available US1 cases immediately, including irrelevant input, invalid output, injection and budget guards. T007–T008 do the same for clarification/answer injection, then T009–T010 for catalog/routing. Run impacted earlier regressions and capture each result before accepting the slice.
4. Use the existing Node test mechanism for local UC-01 tests after they exist and are authorized, with the proposed case/rule design and injected ports. Confirm actual test module paths/discovery from the implementation; do not invent a CLI invocation or report an absent suite as passed. This is local test coverage, not a parallel runner.
5. T011–T013 execute real adapter/restart/policy/receiver checks only with actual owner deliveries, versions and configured authority. Missing components yield not-run records with reasons and retry gates. T014 consolidates earlier safety regression evidence; it never postpones early available attack checks.
6. T015 uses the corpus/rules designed earlier, approved thresholds and actual model/runner deliveries for two comparable scored runs and shared registration/conformance. T016 reconciles runtime gates and separates UC-01 verdict from project verdict. No context capability promotion without complete required real evidence.

## Current availability and later run conditions

| Evaluation scope | Status in this planning revision | Condition to execute |
|---|---|---|
| UC-01 contract/mock behavior | not-run: no UC-01 validators/tests exist | A-ARTIFACTS, agreed domain seam and authorized T002–T010 implementation |
| Real adapters / receiver | not-run: required real deliveries absent | X-READ-MODEL, X04-STATE, X05-GATE, X-RECEIVER and A-PRODUCTION; actual versioned integration |
| Held-out model quality | not-run: no approved corpus/grader/provider run | Prepared T004 data design, A-EVALUATION/A-PRODUCTION, actual model and required integrations |
| Shared scoped registration | not-run: runner/signatures not delivered/agreed | X-EVAL-AGREEMENT and X-EVAL-RUNNER; actual T015 compatibility evidence |
| Whole project / one-command entry point | not-run: no runner or approved required-UC/case manifest | Tai's real runner, confirmed course-wide requirements and all required UC registrations/deliveries |

This availability table is not a task ledger or execution result. Missing checks cannot be recorded as pass. Existing repository checks have separate coordinator logs; none establish these future capabilities.

## Evidence and shared compatibility

Use [evaluation records](contracts/evaluation.md) for case/dataset/rule IDs, code/subject/config identities, provenance, pass/fail/error/not-run and safe trace/evidence refs. Preserve failures and unknown usage; raw prompts/secrets/gold labels stay out of public artifacts. Real runs record actual latency/tokens/cost or explicit unknowns, never mock zeros presented as measurements. Keep equivalent corpus/oracle/config identities for before/after comparison and report intentional treatment changes.

The same case definitions must later register through Tai's approved seam. Prove UC-01-only selection, no global ID collisions, required-project coverage, isolated result namespaces and non-passing overall status for required UC failures/missing work. No actual shared command is documented until Tai/leader selects and delivers it. See [decisions](contracts/decisions.md) for pending sources, approvals and delivery gates.
