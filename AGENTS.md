## Agent skills

### Issue tracker

Paired GitHub tickets via the helper backed by `gh`. See `docs/agents/issue-tracker.md` and `docs/agents/paired-publication.md`.

### Triage labels

Use the five canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context layout (`GLOSSARY.md` and `docs/adr/` at the repo root). See `docs/agents/domain.md`.

## Project context

Use [context/README.md](context/README.md) to find the relevant project context. Load only the documents needed for the task.

Before implementation and before declaring contributor work complete, follow the [active-task handoff](context/workflow.md#active-task-handoff). Contributor completion requires the published, linked PR gate; worker handoff is separate.

After implementation, follow the [context refresh](context/workflow.md#context-refresh): review affected context documents, prepare evidence-based updates in their existing format, and run `node scripts/agents/update-context.mjs --updates <edits.json> --apply` before handoff.

## Branch and PR naming

Before creating a feature branch, publishing or updating a PR, read the [branch and PR conventions](docs/agents/pr-conventions.md), the single source of truth for scoped names, unique identifiers, titles, descriptions and historical compatibility.

The contributor PR pilot targets `development` and treats about 1,000 added plus deleted lines against the immediate base as a soft size target. Report reviewable lines, generated lockfile lines, binaries, and total (`reviewable + generated`). The coordinator has standing limited authorization to commit scoped contributor work, push feature branches, and create or update pilot PRs; worker agents have no remote authority. Never push directly to `main` or `development`. A human decides each merge; the coordinator may execute it only when explicitly instructed for that PR and all required checks pass. Open the draft early once the scoped change passes the local publish gates. Follow [the PR workflow](docs/agents/pr-workflow.md) for status, review, repair, and readiness.

<!-- SPECKIT START -->
## Active Spec Kit feature

UC-03 verified code repair: [spec](specs/001-verified-code-repair/spec.md), [plan](specs/001-verified-code-repair/plan.md), [tasks](specs/001-verified-code-repair/tasks.md). Phase 1 build setup is complete; Phase 2 contract validators and controlled mocks (T003–T004) are authorized with user-confirmed shared contract agreement. Production choices remain gates before real execution; Phase 3 onward requires separate authorization. See the [decision record](specs/001-verified-code-repair/contracts/decisions.md); test-only foundations do not prove runtime capability.
<!-- SPECKIT END -->
