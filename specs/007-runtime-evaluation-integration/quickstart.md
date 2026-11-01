# Validation Guide: Observable Python Repair Evaluation

Planning-only guide. Commands for new files below are **future commands**, unavailable until their named tasks are implemented. No real provider/container invocation is authorized by this guide. See [release gates](contracts/decisions.md).

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

Host configuration resolves IDs, not browser/model paths. Start/run generates and reports an idempotency key; `--request-id` reuses a receipt. Decision records choice only; direction forwards explicit operator action to UC-05 control and returns its receipt. Continue validates that receipt/current state, never authority reconstructed from strings. Exercise reject then explicit revise/end; resume cannot bypass rejected/stale approval.

Custom bug command: `node dist/src/cli/evaluate.js submit --profile local-flash --repository <configured-id> --check-set <configured-id> --bug-file <public-input.json>`. File contains only section 1 public fields; its content is validated/bounded and immutable. Incomplete intake creates no runnable task. Custom run stays exploratory/ungraded, never borrows C01 acceptance. Clarification: `answers --experiment <id> --question <id> --question-digest <digest> --version <current> --answer-file <public-answers.json>`; this records reporter data only. Obtain explicit direction then continue after current approval/intake conditions hold. Material frozen-case criterion changes require a newly pinned case version, never overwrite old grade/task accounting.

Expected evidence: baseline pytest failure; model-generated diagnosis/plan; actual bound human approval; model-generated minimal diff; focused/regression passes; protected tests unchanged; fresh read-only reviewer; independent final-snapshot grade; task/run/provider/accounting/view/profile references; actual usage and safe diagnostics. Capture all unsuccessful attempts too. At least one successful repair is needed for SC-001. C01 selected pass can exit 0 while suite acceptance remains incomplete because C02–C17 were not all run.

## Faults and Comparison (T012–T014)

Future commands:

```powershell
node --test tests/runtime/integration/evaluation-failures.test.ts tests/runtime/integration/evaluation-comparison.test.ts
node dist/src/cli/evaluate.js compare --baseline <attempt-id> --candidate <attempt-id>
```

Required fault witnesses: missing config/provider, denied tool, malformed model output, test regression, stale/rejected approval, uncertain dispatch/effect, unknown metrics, missing grader and altered final snapshot. Assert returned status **and** persisted state/no downstream effects. Keep controlled/real tiers explicit. Two real experiments use fresh tasks with same initial case/repository/grader; changed configuration is displayed. Mismatched case/grader refuses comparison; unknown cost never becomes zero.

Expected refusal/clarification/exhaustion cases are graded against their own safe-outcome/no-effect predicates. They can pass evaluation without completing a repair; only repair-success cases require the complete successful repair evidence chain.

Required report/CLI witness: expected C02 clarification satisfies its case predicate and finishes selected pass/exit 0 while product task remains paused; C01 awaiting approval remains selected pending/exit 3. Neither may resume automatically or claim verified repair; omitted suite cases still make suite acceptance incomplete.

## Local Console (T015–T017)

Future command: `node dist/src/cli/evaluate.js serve --profile local-flash --catalog local-cases`.

Open printed loopback URL; enter host-issued session token locally (never in URL). Select case, submit bug input, inspect progress, explicitly approve/reject the current presentation, submit bound continuation and inspect diff/checks/diagnostics/selection/suite/comparison. Repeat stale and double-submit requests; assert no extra provider call/patch. Test cross-origin/Host substitution, escaped hostile output and private-artifact access refusal. Record actual browser actions/results against exact candidate; API-only testing is not browser acceptance. No browser credential entry/config editor or arbitrary shell.

## Acceptance and Handoff

After focused checks, run `pnpm validate:runtime`, contributor checks and context consistency per repository publication policy. Retain exact source/emission, image/profile/adapter/model/pricing/grader identities, commands/exit codes and actual/not-run criteria under ignored session. Update existing context through `update-context.mjs`; do not force-add local artifacts or fixtures. Existing UC-03 ledgers independently judge T024/T025/T028; no broad/full-suite/restart claims from a single successful case.
