# Quickstart: validating the UC-01 draft

**Status**: Planning only. No UC-01 runtime commands or test suites exist yet. Commands below separate checks available now from future authorized acceptance.

## Available planning checks

From the repository root in PowerShell:

```powershell
node scripts/agents/agent-context.mjs assignment --uc UC-01
node scripts/agents/agent-context.mjs handoff --tasks specs/002-uc01-issue-triage/tasks.md
node scripts/ci/check-context.mjs
node scripts/ci/check-runtime.mjs
node --test
```

Expected: assignment reports Thai and draft artifacts, not implementation authorization; handoff reflects all unchecked tasks; context check validates links/facts. Existing runtime/helper tests exercise the baseline only, not UC-01. Runtime check requires installed approved dependencies and supported Node/pnpm; report environmental failures accurately.

## Future controlled acceptance (not authorized here)

After A-ARTIFACTS and X-FOUNDATION-AGREEMENT, implement tasks in the [ledger](tasks.md). Build with existing `pnpm run validate:runtime`; planned compiled tests will be runnable as `node --test dist/tests/runtime/uc01/*.test.js` after they exist. This is a future path, not a passing result.

1. Use C01–C08 fixtures for configured classification and all severity outcomes; inspect the three impact dimensions and reporter/repository evidence distinction.
2. Use C06/C10 to return questions, retain caller-owned continuation binding and supply answers in the next invocation; C11 must deny stale/foreign answers before calls.
3. Change catalog for C12/C13; only supported compatible recommendation or undetermined is accepted; dispatch spy remains zero.
4. Run C14–C22 negative cases, including unsupported model tools, protected data, missing budgets, uncertain usage and mock production admission. Assert actual consumed/retained accounting and safe termination.

## Future real integration

T011–T013 require recorded shared adapter versions and [owner gates](contracts/decisions.md). Run actual guarded read/provider, durable reservation/restart and policy pause/resume cases with their owners. Validate receiving-workflow projection without dispatch. Keep hidden grading inaccessible. T015 needs separately approved real-run configuration and thresholds; record two evaluation runs with usage, agreement and safe sanitized evidence. If unavailable, report BLOCKED, preserve mock-only results and leave tasks unchecked.
