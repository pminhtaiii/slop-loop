# Quickstart and Validation Guide: UC-05

**Current state**: Phase 1 / T001 and local foundation tasks T002–T004 are complete. The branch includes companion validators, the C01–C24 test fixture registry, and in-memory mock ports; these establish local test behavior only. The CLI and approval service remain future T005–T021 deliverables, and no production, real-execution or restart capability is established.

## Validate this planning package now

From the repository root with Node.js available:

```powershell
node scripts/agents/planning-workflow.mjs validate --dir specs/023-uc05-human-approval
node scripts/agents/planning-workflow.mjs status --dir specs/023-uc05-human-approval
node scripts/ci/check-context.mjs
```

Validation must report zero P0/P1 defects. `status` reports automated validation only (`awaiting-independent-reviews`); independent Standards and Testability reports must be evaluated separately before recording a planning quality pass. Implementation still requires [release gates](contracts/decisions.md).

## After Phase 2 local foundations

Use the approved Node.js 24/pnpm toolchain and frozen repository dependencies. If dependency setup is required, follow the existing project setup; this guide does not install or change dependencies. After T004, use explicit test-only `uc05-local-v1` profiles and mock-marked ports. After T007, the proposed local checks are:

```powershell
node --test tests/runtime/approvals/contracts.test.ts tests/runtime/approvals/policy.test.ts tests/runtime/approvals/service.test.ts tests/runtime/approvals/cli.test.ts
```

After each later story, add its exact test files from tasks.md. After T019:

```powershell
node --test tests/runtime/approvals/control.test.ts tests/runtime/approvals/plan-binding.test.ts tests/runtime/approvals/plan-context.test.ts tests/runtime/approvals/restart-admission.test.ts tests/runtime/approvals/audit.test.ts tests/runtime/approvals/acceptance.test.ts
pnpm run validate:runtime
```

Record command and exit status, fixture/config versions and evidence scope; missing files or import errors are not behavioral RED. Existing canonical UC-03 tests remain unchanged. A runtime bootstrap pass does not establish production approval.

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
