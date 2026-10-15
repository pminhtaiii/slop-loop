# Implementation Status

This page records observed implementation evidence for this repository. A design, plan, issue, or context document is not proof that a runtime capability exists. Detailed target evidence criteria are kept in [`docs/progress-checker-matrices.md`](../docs/progress-checker-matrices.md).

## Status meanings

| Status | Meaning |
|---|---|
| `NOT_STARTED` | Evidence indicates implementation work has not begun |
| `IN_PROGRESS` | Implementation is actively being developed |
| `BLOCKED` | A known blocker prevents progress |
| `IMPLEMENTED_UNVERIFIED` | Implementation exists, but required verification is incomplete |
| `VERIFIED` | Implementation exists; required verification passed, evidence is identifiable, and no known blocker invalidates the result |

Use `OUT_OF_SCOPE` only as a scope decision after the use-case set is selected. It is not a verification status. Do not use `NOT_STARTED` to mean that a capability is out of scope.

Missing or uninspected evidence alone does not establish `NOT_STARTED`. If the inspection is insufficient to tell whether work has begun, leave the status unassigned and state what remains unknown.

## Repository observations

Inspected on 2026-10-15. Base HEAD: `f9818ef628435f010714bc5bd39b17252cc07954`, with uncommitted local changes. A base revision alone does not identify those changes; the [helper source snapshot](../docs/verification/contributor-helpers-2026-10-15.snapshot.json) records the exact helper and test hashes. [Verification evidence](../docs/verification/2026-10-15-context-maintenance.md) records commands and limitations. Status applies only to the scope described in each row.

| Area | Status | Implementation / inspected paths | Verification evidence | Inspected revision |
|---|---|---|---|---|
| Coding-agent runtime | `NOT_STARTED` | Repository inventory contains no TypeScript product-runtime source or entry point. | Inventory inspection; runtime context remains target design. | `f9818ef62843` + local edits |
| End-to-end execution and runtime evaluation | `NOT_STARTED` | No product runtime or evaluation runner found in the repository inventory. | Inventory inspection; no runtime execution evidence. | `f9818ef62843` + local edits |
| Contributor helpers | `IMPLEMENTED_UNVERIFIED` | `scripts/agents/`, `tests/agents/`, and the context checker under `scripts/ci/` and `tests/ci/`. | `node --test` exited 0: 47 passed, one Windows file-symlink case skipped; overall verification remains partial. | `f9818ef62843` + helper snapshot |
| Contributor PR pilot | `IMPLEMENTED_UNVERIFIED` | `scripts/agents/pr-workflow.mjs`, its tests, `.coderabbit.yaml`, and [workflow guide](../docs/agents/pr-workflow.md). | User revised policy: CI and resolved conversations gate readiness; CodeRabbit approval is optional, including re-review. Human decides every merge; the coordinator may execute an explicitly authorized merge of that PR after required checks pass. Current-head CI must be observed after publication. [Evidence](../docs/verification/pr-automation.md). | Policy revision inspected 2026-10-15; historical source snapshot describes the earlier helper |
| Context consistency guard | `VERIFIED` | `scripts/ci/check-context.mjs` and `tests/ci/check-context.test.mjs`; transitively checks referenced Markdown documents. | All 13 checker CLI tests passed (exit 0), including broken nested links, cycles, code examples, and checkout escapes. This covers link/fact checks, not semantic consistency. [Evidence](../docs/verification/retro-improvements-2026-10-15.md). | Inspection base `c3f2710` with dirty checker/test hashes in [snapshot](../docs/verification/context-checker-2026-10-15.snapshot.json); 2026-10-15 |
| Contributor coordination CLI | `VERIFIED` | `pr-workflow.mjs preflight`, `agent-context.mjs assignment`, and `active-task.mjs archive` under `scripts/agents/`. | Initial affected suite: 29 passed; after explicit-fetch hardening, all 14 PR-helper tests passed (exit 0). Other helper sources were unchanged. Includes reporting without remote publication, read-only assignment extraction, archive preview/apply, collision and escape refusal, and recovery. Tests simulate PR/network boundaries; runtime capabilities are outside this scope. [Evidence](../docs/verification/contributor-helpers-2026-10-15.md). | Inspection base `5b71979` with dirty source hashes in [snapshot](../docs/verification/contributor-coordination.snapshot.json); 2026-10-15 |
| Context refresh | `VERIFIED` | `scripts/agents/update-context.mjs`, `tests/agents/update-context.test.mjs`. | All four updater CLI tests passed in `node --test` (exit 0); this status covers tested CLI behavior, not semantic accuracy of agent-written prose. | `f9818ef62843` + helper snapshot |
| Governance and project context | `IMPLEMENTED_UNVERIFIED` | `AGENTS.md`, `GLOSSARY.md`, `docs/agents/`, and `context/`. | `node scripts/ci/check-context.mjs` exited 0; manual semantic review recorded. Runtime enforcement remains unimplemented. | `f9818ef62843` + local edits |

No product runtime capability is marked `VERIFIED` by this inspection. The initial Python/`pytest` target, TypeScript implementation language, and LangGraph choice are recorded in [tech_stack.md](tech_stack.md); they are design choices, not implementation evidence.

When updating a row, record its scoped status, inspected paths, verification command and exit status, inspection date, and revision. For a dirty checkout, identify relevant file hashes or a retained snapshot as well as the base commit; label partial verification and skipped checks. Reinspect affected rows after source changes rather than carrying forward an old passing result. Use [testing.md](testing.md) for contributor checks and [context maintenance](../docs/agents/context-maintenance.md) for applying updates. Neither replaces the target-runtime verification specification.
