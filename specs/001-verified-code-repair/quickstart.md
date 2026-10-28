# Quickstart Validation Guide: UC-03

Phase 1 provides the build toolchain and a LangGraph dependency smoke test. Phase 2 adds canonical contract validation and controlled test-only port mocks; it does not provide the UC-03 runtime runner. Current authorization and remaining scope gates are recorded in [decisions](contracts/decisions.md). This guide describes phase outputs; task progress does not confer permission.

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

After `pnpm run build`, run the canonical contract suite directly with `node --test dist/tests/runtime/contract/uc03.test.js`. `pnpm run validate:runtime` cleans compiled output and runs typecheck, lint, build and all compiled runtime tests. Contract and mock passes establish development conformance only; real execution remains gated at T024/T025/T028 and later acceptance tasks.

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

## Scoped T053-T056 local checks

T053-T056 are complete locally after combined verification at HEAD 8007bbbb09ca1b424a619b155507dcc80b68dd6c plus the ten inputs in `review-r3-snapshot.json`. Source and emitted fixture/conformance/CLI suites each pass 154/154 (121 fixture and 33 CLI); typecheck, focused lint and build pass. Independent Standards R3 and Spec R3 report no unresolved P0/P1/P2 findings and scope-limited convergence. Exact commands, exit statuses and hashes are retained locally under `.agent-work/2026-10-24/uc03-t052-t056/merger-r3/` and `reviews/`. Separate pinned neutral replays record assertion-only source/emitted failures, passing typecheck/build and byte-exact GREEN restoration; historical T053/T055 RED limitations remain explicit. T052 was already complete and preserved. T057 onward and T022 remain incomplete and unreleased by this run; real adapters, production configuration, actual containment/restart, full Phase 5 acceptance and Phase 6 remain gated. Contributor publication and full runtime/contributor/CI gates are separate.

```powershell
pnpm run typecheck
node --test tests/runtime/support/uc03/provider-mocks.test.ts tests/runtime/contract/uc03-port-conformance.test.ts tests/runtime/approvals/cli.test.ts
pnpm run build
node --test dist/tests/runtime/support/uc03/provider-mocks.test.js dist/tests/runtime/contract/uc03-port-conformance.test.js dist/tests/runtime/approvals/cli.test.js
```

## Local command interfaces and remaining gates

The local T026 adapter and T027 evaluation/comparison entry points exist after `pnpm run build`. T026's positive mock route passes; material-replan baseline/renewed approval, post-review accounting and subset-repair cumulative-diff gaps keep T026 unaccepted. The evaluator can write mock infrastructure reports; no configured case driver yields required not-run results and nonzero exit. Real mode currently refuses before dispatch. These commands do not establish accepted real execution:

```powershell
node dist/src/cli/uc03.js --task fixtures/uc03/success/task.json --config <trusted-config.json> --output <report.json>
node dist/eval/uc03/runner.js --suite uc03 --mode real --config <trusted-config.json> --output <run-a.json>
node dist/eval/uc03/runner.js --suite uc03 --mode real --config <trusted-config.json> --output <run-b.json>
node dist/eval/uc03/compare.js --baseline <run-a.json> --candidate <run-b.json> --output <comparison.json>
```

Replace angle-bracket arguments with local paths. Local development fixtures under `fixtures/` are local-only and not shipped in published repository tracking; task paths like `fixtures/uc03/success/task.json` are local development examples. T002 records the selected toolchain. The runner exits nonzero for a failed/error/not-run required case, missing limits or unavailable isolation, and refuses real mode until real composition is supplied. The mock-only isolated-grading seam binds a final snapshot, profile and executor to an independent admission; fake executor checks remain infrastructure evidence, C17 remains not-run, and isRealVerified remains false. No checkpoint is automatically approved. Real evaluation still needs explicit human/test-driver decisions through the real UC-05 gate and the accepted T024 isolation profile.

## Expected validation sequence

1. Run contract/unit suites with T004 mocks; assert CAS, reservations, rejected/stale approvals, incomplete results and stale-evidence invalidation. These are development results only.
2. Run C06–C11 isolated security probes first. Build a protected-content-excluded command view with permitted source/tests byte-identical to the current canonical workspace; mount it read-only and permit writes only to scratch. Malicious pytest must fail to read excluded secrets or change source/tests; required files containing embedded secrets refuse execution instead of being silently rewritten. Confirm outside sentinels unchanged, network denied, provider marker absent and no Docker/grading/agent mounts; missing configuration refuses before execution.
3. Submit C01 through real composition: persist failing baseline, present diagnosis/plan, supply explicit approval via UC-05, apply minimal patch, run focused `python -m pytest <focused-test>` and required existing `python -m pytest` checks under the isolated RepositoryPort, obtain separate current-state review and inspect final diff/evidence report. These pytest commands run in the task workspace through the gate, never directly on host.
4. Run C03–C05/C12/C14 failure/repair/review fixtures. Check failure evidence reaches repair, previously passing tests stay protected, fourth replan and exhausted allowances stop. Withhold/reject a plan and verify no production edit occurs.
5. Run C13/C15 with real process kill/restart at each specified boundary, including coder/reviewer provider calls after durable token/cost reservation, after dispatch and before usage settlement. Missing/exhausted allowance must produce zero provider requests; interrupted requests retain their charge until reconciled, with no automatic replay. Restore the same workspace/task and revalidate repository/policy; verify retained reservations and exactly one effect after reconciliation. Same-process simulation cannot satisfy this check.
6. Run all C01–C17 twice and compare structured case outcomes/metrics. Any required not-run/failure/error remains explicit and prevents verified completion. Inspect sanitized live activity and final report, plus host-private independent grading evidence.

Record exact commands, exit codes, runtime/fixture/config/image digests, external adapter revisions and evidence references. See [acceptance contract](contracts/acceptance.md) for case assertions and [interfaces](contracts/interfaces.md) for ports/mocks. Mock success, contributor tests or a merged PR alone never establish UC-03 acceptance.
