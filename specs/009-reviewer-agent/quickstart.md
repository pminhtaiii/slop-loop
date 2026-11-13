# Quickstart: UC-06 Planning and Future Verification

Current state: documentation only. Commands below distinguish current planning checks from future implementation tests. Missing future files are not behavioral RED. Do not run provider/container/real-quality/restart commands until their exact task/tier is released.

## Current planning checks

T002 follow-up: pure types/validators now exist in src/contracts/review.ts and src/uc06/validation.ts. Source and freshly emitted uc06-review tests pass 8/8 each; reviewer regressions pass 25/25 with typecheck/build/scoped lint/format. Independent merger/reviews stopped at usage limits, so T002 remains unchecked. See [current evidence](checklists/t002-verification.md). The original planning observations below remain historical; no future graph/safety/grade suite is claimed implemented by T002.

From C:/SE373:

```powershell
node scripts/agents/planning-workflow.mjs validate --dir specs/009-reviewer-agent
node scripts/agents/planning-workflow.mjs status --dir specs/009-reviewer-agent
node scripts/ci/check-context.mjs
git diff --check
```

Expected validation clean; status still says awaiting-independent-reviews/readyForImplementation:false because helper certifies only automated checks. Both actual reviewer lanes and file snapshot are separately retained in checklists/planning-validation.md. Authorization remains planning-only even with a planning-quality pass.

Baseline inspection already ran source reviewer/accounting/path regressions: 25 passed/0 failed/exit 0, controlled doubles only. It does not verify UC-06, real model quality, integrated target execution or restart.

## After explicit controlled release

Prerequisites: T001 exact agreement/release; repository's existing installed pinned toolchain. Follow test-first per task. After implementation/build:

```powershell
pnpm run typecheck
pnpm run build
node --test tests/runtime/contract/uc06-review.test.ts tests/runtime/unit/uc06-context.test.ts tests/runtime/unit/uc06-reviewer.test.ts tests/runtime/unit/uc06-review-prompt.test.ts
node --test tests/runtime/security/uc06-review-safety.test.ts tests/runtime/integration/uc06-review-route.test.ts tests/runtime/integration/uc06-review-repair.test.ts tests/runtime/unit/uc06-grade.test.ts tests/runtime/contract/uc06-evaluation.test.ts
node --test dist/tests/runtime/contract/uc06-review.test.js dist/tests/runtime/unit/uc06-context.test.js dist/tests/runtime/unit/uc06-reviewer.test.js dist/tests/runtime/unit/uc06-review-prompt.test.js
node --test dist/tests/runtime/security/uc06-review-safety.test.js dist/tests/runtime/integration/uc06-review-route.test.js dist/tests/runtime/integration/uc06-review-repair.test.js dist/tests/runtime/unit/uc06-grade.test.js dist/tests/runtime/contract/uc06-evaluation.test.js
node --test tests/runtime/unit/runtime-reviewer.test.ts tests/runtime/unit/reviewer-v02-accounting.test.ts tests/runtime/contract/uc03-review-regressions.test.ts tests/runtime/unit/deepseek-transport.test.ts
```

Also run matching emitted counterparts of those four predecessor suites and affected existing graph/evaluation conformance tests. No full-suite result is implied by focused passes. Existing baseline suite names may contain “real” while using fakes; classify by the invoked dependencies.

Expected journeys: current clean response accepted with exact evidence; faulty response produces located supported findings; missing verification/stale context forbids dispatch; post-dispatch drift keeps charges but withholds acceptance; malformed/forbidden output invalidates whole result; hostile input has no tool capability; findings lead through repair/new verification/new review, or stop incomplete with no remaining authority. Examine owner state/journals as well as returned outcomes.

## Real milestones: not runnable under current authorization

Before T011 require G-DELIVERY/G-ROUTE/G-PROFILE/G-SECURITY and explicit release; record exact owner/public APIs, candidate/profile/image/model/prompt/pricing and current approval authority. A source adapter or “real” label alone is insufficient. Target repository checks remain under original containment/approval proofs.

T012 additionally requires independently frozen private labels and approved G-QUALITY rubric before the first candidate output. Grade through the same admitted reviewer/registered evaluator; report all required cases, TP/FP/FN/invalid/not-run and no quality claim from scripted output.

T013 additionally requires G-RESTART, durable owner versions and actual subprocess termination with distinct PIDs at each reservation/dispatch/settlement/observation boundary. Restore same task/new run and verify no charge reset or duplicate effect. Retain uncertain holds until exact owner reconciliation; no in-process simulation acceptance.

Quality and restart outcomes are separate: Q01–Q12 and the quality milestone's recorded controlled safety set can pass with R18 not-run. Report quality=pass, restart=incomplete, fullFeatureAcceptance=incomplete in that case. Missing/invalid required Q or safety witness keeps quality incomplete. Do not use selected quality score to overwrite full acceptance.

Future test entry points are tests/runtime/integration/uc06-review-real.test.ts, uc06-review-quality.test.ts and uc06-review-restart.test.ts (with corresponding dist files). Test profiles must refuse before provider/container effects when gates absent and return explicit not-run evidence/nonzero acceptance result. Do not hide a missing required milestone behind a successful skipped suite.

## Handoff

Use current candidate snapshot and two planning lanes, independent merger/review for any later implementation batch, exact criterion evidence and managed context updater. Keep local artifacts under .agent-work/2026-11-12/uc06-reviewer-planning/. No push/merge/issue closure is authorized; report local planning quality without claiming published contributor completion.
