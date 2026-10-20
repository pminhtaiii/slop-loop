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

After implementation, follow the [context refresh](context/workflow.md#context-refresh): review affected context documents, prepare evidence-based updates in their existing format, and run `node scripts/agents/update-context.mjs --updates <edits.json> --apply` before handoff.

## Branch and PR naming

Before creating a feature branch, publishing or updating a PR, read the [branch and PR conventions](docs/agents/pr-conventions.md), the single source of truth for scoped names, unique identifiers, titles, descriptions and historical compatibility.

The contributor PR pilot targets `development` and treats about 1,000 added plus deleted lines against the immediate base as a soft size target. Report reviewable lines, generated lockfile lines, binaries, and total (`reviewable + generated`). The coordinator has standing limited authorization to commit scoped contributor work, push feature branches, and create or update pilot PRs; worker agents have no remote authority. Never push directly to `main` or `development`. A human decides each merge; the coordinator may execute it only when explicitly instructed for that PR and all required checks pass. Open the draft early once the scoped change passes the local publish gates. Follow [the PR workflow](docs/agents/pr-workflow.md) for status, review, repair, and readiness.

<!-- SPECKIT START -->
## Active Spec Kit feature

UC-01 evidence-backed issue triage: [spec](specs/002-uc01-issue-triage/spec.md), [plan](specs/002-uc01-issue-triage/plan.md), [tasks](specs/002-uc01-issue-triage/tasks.md). T001–T010 agreement, controlled assessment, later-answer clarification and configured recommendation are complete. Phase 5 T009–T010 was separately authorized on 2026-10-19 (Asia/Bangkok); see [decisions](specs/002-uc01-issue-triage/contracts/decisions.md). T011 onward requires separate authorization. Real adapters, production choices and model-quality evaluation remain gated; mock checks establish only exercised local behavior.

UC-03 verified code repair: [spec](specs/001-verified-code-repair/spec.md), [plan](specs/001-verified-code-repair/plan.md), [tasks](specs/001-verified-code-repair/tasks.md). Phase 1 build setup is complete; Phase 2 contract validators and controlled mocks (T003–T004) are authorized with user-confirmed shared contract agreement. Production choices remain gates before real execution; Phase 3 onward requires separate authorization. See the [decision record](specs/001-verified-code-repair/contracts/decisions.md); test-only foundations do not prove runtime capability.
UC-05 bound human approval: [spec](specs/023-uc05-human-approval/spec.md), [plan](specs/023-uc05-human-approval/plan.md), [tasks](specs/023-uc05-human-approval/tasks.md). T001–T010 and the T023 correction of T007 are complete locally through `f6edb85` under separate phase authorizations. The user confirmed three Phase 4 control/service, mock-store direction and CLI subprocess seams on 2026-10-20 (Asia/Saigon). Validators, policy, control, presentation and CLI establish exercised mock-only behavior. T011–T022 require separate authorization; real adapters, production profiles and restart evidence remain gated. Read [decisions](specs/023-uc05-human-approval/contracts/decisions.md) before implementation or an approval/recovery integration change.
<!-- SPECKIT END -->
