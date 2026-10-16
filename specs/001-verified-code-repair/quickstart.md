# Quickstart Validation Guide: UC-03

Phase 1 provides the build toolchain and a LangGraph dependency smoke test. It does not provide the UC-03 runtime runner. The user authorized setup and confirmed shared contracts on 2026-10-16 (Asia/Saigon); production choices remain required before real execution. See [decisions](contracts/decisions.md).

## Build setup (available now)

Use Node.js 24 LTS and the pnpm version pinned in package.json. From repository root:

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run test:runtime
node --test
```

The runtime smoke test checks the installed LangGraph integration, not a repaired repository. Runtime CI runs the build gates on Ubuntu and Windows. Current results are local-only at `docs/verification/2026-10-16-verified-code-repair-phase1.md`; earlier compiler/linter probes and initial npm results are retained in [initial Phase 1 verification](https://github.com/pminhtaiii/slop-loop/blob/ee5be9b147efb44511b8e65ece375fc904c5f062/docs/verification/2026-10-16-verified-code-repair-phase1.md).

## Current planning checks (available now)

From repository root, run:

```powershell
$env:SPECIFY_FEATURE_DIRECTORY = (Resolve-Path specs/001-verified-code-repair).Path
& .specify/scripts/powershell/check-prerequisites.ps1 -Json -RequireTasks -IncludeTasks
node scripts/ci/check-context.mjs
node scripts/agents/agent-context.mjs handoff --tasks specs/001-verified-code-repair/tasks.md
```

Expected: Spec Kit resolves this feature and design documents, context links/facts pass, handoff reports the current task ledger. These checks do not establish product behavior. See checklists/planning-validation.md and docs/verification/2026-10-16-uc03-planning.md for checks actually run.

## Future prerequisites

T001 records shared-contract confirmation, constitution handling and alignment with accepted ADR-0004. T002 establishes the selected Node/pnpm/TypeScript/LangGraph/lint/test bootstrap. The user-approved amendment defers provider/model, supported execution hosts, Docker profile/image digest, artifact retention and every required finite production limit until before real execution; those choices are not supplied by bootstrap defaults. Use a prepared Python/pytest image; task containers cannot download missing dependencies. Supply trusted provider credentials only to host configuration, never to repo files/argv/child environment.

X04-STATE and X05-GATE deliveries must match contract v0.1 (or its explicitly agreed successor), with actual owner-ledger/revision/evidence links. Mock suites may run before they arrive; real execution cannot. T024/T025 gate real operations. Reviewer configuration is separate and read-only.

## Future command interface (to implement, not existing commands)

T026 provides a thin local adapter; T027 provides these planned portable one-command interfaces after T001 selects the runtime toolchain:

```powershell
node dist/cli/uc03.js --task fixtures/uc03/success/task.json --config <trusted-config.json> --output <report.json>
node dist/eval/uc03/runner.js --suite uc03 --mode real --config <trusted-config.json> --output <run-a.json>
node dist/eval/uc03/runner.js --suite uc03 --mode real --config <trusted-config.json> --output <run-b.json>
node dist/eval/uc03/compare.js --baseline <run-a.json> --candidate <run-b.json> --output <comparison.json>
```

Use actual paths chosen during implementation, replacing angle-bracket arguments. Future toolchain selection must provide the documented build and focused runtime-test invocation before these commands are runnable; T002 records exact commands. The runner exits nonzero for a failed/error/not-run required case, missing limits or unavailable isolation, and rejects production mock composition. It never auto-approves a real human checkpoint. Evaluation fixtures requiring a decision use explicit human/test-driver decisions via the real UC-05 gate, labelled as evaluation input rather than autonomous approval.

## Expected validation sequence

1. Run contract/unit suites with T004 mocks; assert CAS, reservations, rejected/stale approvals, incomplete results and stale-evidence invalidation. These are development results only.
2. Run C06–C11 isolated security probes first. Build a protected-content-excluded command view with permitted source/tests byte-identical to the current canonical workspace; mount it read-only and permit writes only to scratch. Malicious pytest must fail to read excluded secrets or change source/tests; required files containing embedded secrets refuse execution instead of being silently rewritten. Confirm outside sentinels unchanged, network denied, provider marker absent and no Docker/grading/agent mounts; missing configuration refuses before execution.
3. Submit C01 through real composition: persist failing baseline, present diagnosis/plan, supply explicit approval via UC-05, apply minimal patch, run focused `python -m pytest <focused-test>` and required existing `python -m pytest` checks under the isolated RepositoryPort, obtain separate current-state review and inspect final diff/evidence report. These pytest commands run in the task workspace through the gate, never directly on host.
4. Run C03–C05/C12/C14 failure/repair/review fixtures. Check failure evidence reaches repair, previously passing tests stay protected, fourth replan and exhausted allowances stop. Withhold/reject a plan and verify no production edit occurs.
5. Run C13/C15 with real process kill/restart at each specified boundary, including coder/reviewer provider calls after durable token/cost reservation, after dispatch and before usage settlement. Missing/exhausted allowance must produce zero provider requests; interrupted requests retain their charge until reconciled, with no automatic replay. Restore the same workspace/task and revalidate repository/policy; verify retained reservations and exactly one effect after reconciliation. Same-process simulation cannot satisfy this check.
6. Run all C01–C17 twice and compare structured case outcomes/metrics. Any required not-run/failure/error remains explicit and prevents verified completion. Inspect sanitized live activity and final report, plus host-private independent grading evidence.

Record exact commands, exit codes, runtime/fixture/config/image digests, external adapter revisions and evidence references. See [acceptance contract](contracts/acceptance.md) for case assertions and [interfaces](contracts/interfaces.md) for ports/mocks. Mock success, contributor tests or a merged PR alone never establish UC-03 acceptance.
