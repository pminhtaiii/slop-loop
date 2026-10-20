# Quickstart and Validation Guide: UC-05

**Current state**: Separately authorized T001–T013 and T023–T025 corrections are integrated locally through `1f02efe`. Exact binding, immutable stale projections, atomic mock pending replacement, safe port failures and canonical Patch consumer compatibility augment the earlier policy/control/CLI slice. Source/emitted approvals pass 139/139; runtime typecheck/full lint/build and 893 compiled tests pass. The service has mock provenance and direct CLI composition remains unavailable. T014–T022 and production/real-execution/actual restart remain gated.

## Validate this planning package now

From the repository root with Node.js available:

```powershell
node scripts/agents/planning-workflow.mjs validate --dir specs/023-uc05-human-approval
node scripts/agents/planning-workflow.mjs status --dir specs/023-uc05-human-approval
node scripts/ci/check-context.mjs
```

Validation must report zero P0/P1 defects. `status` reports automated validation only (`awaiting-independent-reviews`); independent Standards and Testability reports must be evaluated separately before recording a planning quality pass. Implementation still requires [release gates](contracts/decisions.md).

## Validate Phase 3 locally

Use the approved Node.js 24/pnpm toolchain and frozen repository dependencies. If dependency setup is required, follow the existing project setup; this guide does not install or change dependencies. Use explicit test-only `uc05-local-v1` profiles and mock-marked ports. At corrected T007 integration, the focused command passed 66/66 and runtime validation passed typecheck, lint, build and 623 compiled tests:

```powershell
node --test tests/runtime/approvals/*.test.ts
pnpm run validate:runtime
```

After each later story, add its exact test files from tasks.md. After T019:

```powershell
node --test tests/runtime/approvals/control.test.ts tests/runtime/approvals/plan-binding.test.ts tests/runtime/approvals/plan-context.test.ts tests/runtime/approvals/restart-admission.test.ts tests/runtime/approvals/audit.test.ts tests/runtime/approvals/acceptance.test.ts
pnpm run validate:runtime
```

Record command and exit status, fixture/config versions and evidence scope; missing files or import errors are not behavioral RED. Existing canonical UC-03 tests remain unchanged. A runtime bootstrap pass does not establish production approval.

## Validate Phase 4 locally

Read the [Phase 4 plan](plan.md#phase-4-refinement--t008t010-planning-only), [local case obligations](contracts/acceptance.md#phase-4-local-evidence-boundary) and [authorization record](contracts/decisions.md#phase-4-implementation-authorization). The user confirmed the three seams before implementation; T008 → T009 → T010 were accepted sequentially. Task completion is recorded only in tasks.md.

With the existing approved toolchain/dependencies, run:

```powershell
node --test tests/runtime/approvals/control.test.ts tests/runtime/approvals/mock-ports.test.ts tests/runtime/approvals/cli.test.ts
node --test tests/runtime/approvals/*.test.ts
node scripts/ci/check-runtime.mjs
```

The full focused command passed 90/90 and the runtime gate passed at the source integration above. Windows SIGINT/SIGTERM observations before mutation and after commit retain the same child's last mock-store snapshots in the parent; they establish no postmortem persistence or durable runtime restart. Record actual platform/exit/signal facts and any not-run paths. Direct CLI entry remains unavailable; no production connection is added.

## Validate Phase 5 locally

Read the [authorization and three seams](contracts/decisions.md#phase-5-implementation-authorization-and-seams). T011–T013 and T025 are integrated; their individual evidence is in tasks.md. Run `node --test tests/runtime/approvals/plan-binding.test.ts tests/runtime/approvals/plan-context.test.ts tests/runtime/approvals/service.test.ts`, then the complete approval suite and `node scripts/ci/check-runtime.mjs`. The integrated source/emitted approval suites pass 139/139 and the runtime gate passes 893 compiled tests, typecheck, lint and build.

The canonical consumer tests use actual service consent and mock accounting/context. Simulated new-run ledger reload does not prove process restart. Approved stale assessments are derived on reads; only pending replacement uses the existing mock assessment transaction. No real adapter/profile, durable terminal assessment or production composition is supplied.

## CLI approval/rejection scenarios (after T010/T018)

Compile through the existing build. Start the trusted host operator composition with an admitted UC-04 store, context provider and operator capability. Without that configured composition the CLI must return unavailable/denied, never create a local fallback store.

Use [CLI commands](contracts/cli.md) to list a named task, show/inspect its pending request, and submit a decision with the displayed task/request versions and presentation digest. Read actual identifiers from the trusted host; do not paste invented IDs as authority.

1. **Allowed**: Request an admitted bounded read/configured command. No action prompt; verify task/control prerequisites still apply.
2. **Approval**: Propose a supported risky action. Confirm no effect and all task agents paused; show/inspect the exact safe details. Explicitly approve; observe only the interrupted action becomes eligible for guarded execution.
3. **Reject**: Reject a new pending request. Confirm all task activity stays stopped and alternate IDs/tools cannot bypass it. Provide facts only: still paused. Submit explicit revise/resume: history remains, and approval-required work gets a new request. End prevents agent continuation.
4. **Drift**: Change a bound repository/policy identity under the controlled driver. Old approval fails with a specific stale reason. Fresh approval uses a new slot; unchanged strategy does not consume a replan. Never mutate the original binding.
5. **Inspection failure**: Exceed admitted page/content bounds or supply protected payloads/terminal controls. No unsafe display or approval of hidden semantics; safe denial and pause retention.

## Real integration and restart (after external gates)

Only after G-AUTH/G-CONTRACT/G-PROFILE/G-REAL, run:

```powershell
node --test tests/runtime/approvals/integration.test.ts
node --test tests/runtime/approvals/restart.test.ts
```

The integration suite composes real UC-04 state and Tai's actual host/tool/provider admission with disposable isolated tasks. Restart suite kills/restores processes while pending/rejected, after decision save, after claim before dispatch, and after effect before settlement. Check zero blind duplicates, retained uncertainty/charges and independent unrelated tasks. Missing adapter/profile/host support is not-run with a concrete delivery owner, never simulated success. C01–C24 in [acceptance](contracts/acceptance.md) define the oracles and two-run comparison.

## Deliver evidence

Keep detailed results under ignored `docs/verification/` and managed session artifacts. Link actual owner-approved external ledgers, source/adapter/profile revisions and commands. Map every required case to its result/evidence level and disclose missing coverage. X05-GATE is ready only for the verified scope; contributor publication and human merge decisions follow their separate workflow.
