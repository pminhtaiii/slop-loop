## Agent skills

### Issue tracker

GitHub Issues via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context layout (`GLOSSARY.md` and `docs/adr/` at the repo root). See `docs/agents/domain.md`.

## Project context

Use [context/README.md](context/README.md) to find the relevant project context. Load only the documents needed for the task.

Before implementation, follow the [active-task handoff](context/workflow.md#active-task-handoff).

After implementation, follow the [context refresh](context/workflow.md#context-refresh): review affected context documents, prepare evidence-based updates in their existing format, and run `node scripts/agents/update-context.mjs --updates <edits.json> --apply` before handoff.

## Branch and PR naming

Name feature branches `feat/<feature-number>-<short-description>`, using the feature's zero-padded three-digit number and a lowercase, hyphen-separated description (for example, `feat/001-agent-workspace`). Use the exact same string as the PR title, matching its source branch.
