## Agent skills

### Issue tracker

Paired GitHub tickets via the helper backed by `gh`. See `docs/agents/issue-tracker.md` and `docs/agents/paired-publication.md`.

### Triage labels

Use the five canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context layout (`GLOSSARY.md` and `docs/adr/` at the repo root). See `docs/agents/domain.md`.

## Project context

Use [context/README.md](context/README.md) to find the relevant project context. Load only the documents needed for the task.

Before authoring, planning, or auditing a feature, follow the [planning workflow](context/planning.md).

Before implementation and before declaring contributor work complete, follow the [active-task handoff](context/workflow.md#active-task-handoff). Contributor completion requires the published, linked PR gate; worker handoff is separate.

Before delegating parallel contributor work, follow the [agent coordination](context/workflow.md#agent-coordination) policy.

After implementation, follow the [context refresh](context/workflow.md#context-refresh): review affected context documents, prepare evidence-based updates in their existing format, and run `node scripts/agents/update-context.mjs --updates <edits.json> --apply` before handoff.

## Branch and PR naming

Before creating a feature branch, publishing or updating a PR, read the [branch and PR conventions](docs/agents/pr-conventions.md), the single source of truth for unnumbered scoped names, matching PR titles, descriptions and historical compatibility.

The contributor PR pilot targets `development` and treats about 1,000 added plus deleted lines against the immediate base as a soft size target. Report reviewable lines, generated lockfile lines, binaries, and total (`reviewable + generated`). The coordinator has standing limited authorization to commit scoped contributor work, push feature branches, and create or update pilot PRs; worker agents have no remote authority. Never push directly to `main` or `development`. A human decides each merge; the coordinator may execute it only when explicitly instructed for that PR and all required checks pass. Open the draft early once the scoped change passes the local publish gates. Follow [the PR workflow](docs/agents/pr-workflow.md) for status, review, repair, and readiness.

<!-- SPECKIT START -->
## Active Spec Kit features

Before feature work, read its linked `spec.md`, `plan.md`, `tasks.md`, and `contracts/decisions.md`. The task ledger records completion; the decision record carries authorization. A completed task or earlier phase authorization does not release successor work. Keep capability claims within the evidence those records support.

- UC-01 evidence-backed issue triage: [spec](specs/002-uc01-issue-triage/spec.md), [plan](specs/002-uc01-issue-triage/plan.md), [tasks](specs/002-uc01-issue-triage/tasks.md), and [decisions](specs/002-uc01-issue-triage/contracts/decisions.md). T001–T010 agreement, controlled assessment, later-answer clarification and configured recommendation are complete. Phase 5 T009–T010 was separately authorized on 2026-10-19 (Asia/Bangkok). T014 mock-only safety regression consolidation was separately authorized on 2026-10-20 (Asia/Bangkok) and is complete locally; 88 safety/238 UC-01 tests pass. T011–T013 and T015–T016 require separate authorization. Real adapters, production choices, and model-quality evaluation remain gated; mock checks establish only exercised local behavior.
- UC-03 verified code repair: [spec](specs/001-verified-code-repair/spec.md), [plan](specs/001-verified-code-repair/plan.md), [tasks](specs/001-verified-code-repair/tasks.md), and [quickstart](specs/001-verified-code-repair/quickstart.md). Consult the [decision record](specs/001-verified-code-repair/contracts/decisions.md) for recorded scope statements before implementation. On 2026-10-21 (Asia/Saigon), the user separately authorized Phase 4 T015–T018 on `feat/uc03-bounded-repair`, as recorded in the decision record. This releases mock-backed repair and replan work only; Phase 5 onward, real execution and production adapters remain gated. Historical Phase 3 authorization wording is not used to release successor work. Task status reports progress only and does not grant permission. Mock-only checks establish only exercised local behavior.
- UC-05 bound human approval: [spec](specs/023-uc05-human-approval/spec.md), [plan](specs/023-uc05-human-approval/plan.md), [tasks](specs/023-uc05-human-approval/tasks.md), and [decisions](specs/023-uc05-human-approval/contracts/decisions.md). T001–T015 and T023–T027 review corrections are complete locally through `41c4215` under separate phase authorizations. On 2026-10-20 (Asia/Saigon), the user confirmed the Phase 5 evaluator/service/canonical-consumer seams and relayed Tai/X03-PLAN-CONTEXT agreement. Source/emitted approvals pass 160/160; the full runtime gate passes 1005 compiled tests. Phase 6 T014–T015 and its service/control mock-recovery seam were separately authorized on 2026-10-21 (Asia/Saigon). Evidence remains mock-only; T016–T022, real adapters, production profiles and restart remain gated. Read [decisions](specs/023-uc05-human-approval/contracts/decisions.md) before implementation or an approval/recovery integration change.
<!-- SPECKIT END -->
