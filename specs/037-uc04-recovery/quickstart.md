# Quickstart and Validation: UC-04

## Current planning validation

Run from the repository root; these commands exist today and do not execute UC-04:

```powershell
node scripts/agents/agent-context.mjs assignment --uc UC-04
node scripts/agents/planning-workflow.mjs validate --dir specs/037-uc04-recovery
node scripts/agents/planning-workflow.mjs status --dir specs/037-uc04-recovery
node scripts/agents/planning-workflow.mjs review-brief --dir specs/037-uc04-recovery --role standards
node scripts/agents/planning-workflow.mjs review-brief --dir specs/037-uc04-recovery --role testability
node scripts/ci/check-context.mjs
git diff --check
```

Assignment can still report `NEEDS_PLANNING` because the delegation map intentionally has no approved UC-04 links. Automated status can say `awaiting-independent-reviews`; it neither certifies reviews nor authorizes implementation. Evaluate each current-artifact independent report with `node scripts/agents/planning-workflow.mjs evaluate-review --review <local-report.md>`. Retain source hashes/report results locally.

## Future foundation validation (unimplemented)

Prerequisites: explicit task/seam authorization; G-EXTENSION path/schema agreement; G-STORE selected durable adapter with exact adapter paths/host/crash contract added to plan/tasks; G-CONTROL for pause surface; explicit finite safe test profiles. No runtime files or commands below exist as UC-04 evidence today.

After implementing approved tasks, use existing build/test infrastructure:

```powershell
node scripts/ci/check-runtime.mjs
node --test tests/runtime/uc04/*.test.ts
node --test dist/tests/runtime/uc04/restart.test.js
```

The named suites are planned outputs, not commands run in this assignment. T012 must expose its scripted driver through `tests/runtime/support/uc04/restart-child.ts` and document the exact selected store/profile invocation here before claiming runnable durability validation. Do not invent a backend path, environment selector or CLI flag to fill that gap.

Required scenarios for that driver:

1. Register a scripted task with explicit goal/criteria/constraints/steps/check refs and an independent second task. Complete a step; acknowledge coherent checkpoint; kill old process, confirm exit and start new process against the retained store. Assert R03 exact state and no repeated step.
2. Kill after reserve, after claim, after dispatch and after effect before persistence. Compare retained reservations/usage/effect witnesses under new run IDs. Exercise known non-dispatch/completion and unknown outcomes; unknown non-idempotent work cannot retry (R04–R05,R10–R11).
3. Pause with a bounded operation outstanding, decline early resume, record result and require another explicit resume. Restart while deliberately paused, waiting/rejected, and approved before claim; preserve independent holds and unrelated task progress (R06–R08).
4. Mutate saved repository assumptions through the trusted test seam; re-inspect without overwriting and invalidate evidence/binding. Missing/corrupt state or exhausted accounting returns a blocker. Apparent completion requires owning verification evidence (R09,R13).
5. Compact long history with all six fields, then test each omission/conflict and actual restart. Inspect safe status/history and protected-marker exclusions; deletion remains unavailable (R12,R14–R15).
6. Run the required catalog twice; retain case/profile/backend/host/source identities and all process/effect/count receipts per [acceptance](contracts/acceptance.md). Not-run is not pass.

## Later real integration

T013 requires actual X05-GATE and X03-ADMISSION revisions and profiles. Repeat the approval/claim/effect/drift/restart cases with real shared boundaries. Controlled foundation results cannot satisfy this gate. Integrated feature workflow and cross-task memory are still later G-FEATURE/G-MEMORY work; no hidden production fallback or automatic approval is allowed.
