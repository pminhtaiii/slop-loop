# Contributor coordination helpers: 2026-10-15

Scope: preflight reporting, UC assignment context, preview-first completed-handoff archival, and agent-facing workflow guidance. These are contributor tools, not product-runtime implementation.

## Public command contracts

- `pr-workflow.mjs preflight` fetches development and reports branch validity, ahead/behind counts, dirty paths, and committed diff size. It does not call GitHub, publish, reset, or rebase. Failed fetches stop rather than report stale freshness.
- `agent-context.mjs assignment --uc UC-03` reads the delegation map and linked local files. It reports planning gaps separately from dependency/approval review, rejects ambiguous UC rows and escaping paths, and leaves the task ledger unchanged.
- `active-task.mjs archive --owner <id> --task <id> --output docs/verification/<name>.json` previews by default. `--apply` holds the existing shared lock, saves a completed entry exclusively, reads it back for equality, then clears only that entry. It supports resuming after archive creation and refuses collisions, replaced tasks, linked output directories, active/blocked entries, and busy locks. It retains branches, worktrees, and raw evidence. Commit the returned archive with the handoff evidence.

## Evidence

Three positive public-command tests initially failed because the existing CLIs did not implement those commands. The first implemented focused run passed all four cases, including the archive rejection cases. Added coverage exercises recovery after archive creation and a new task reusing the same ID. `node --test tests/agents/active-task.test.mjs tests/agents/agent-context.test.mjs tests/agents/pr-workflow.test.mjs` then passed all 29 tests (exit 0). [The source snapshot](contributor-coordination.snapshot.json) identifies the dirty helper/test contents at the inspection base; passing simulated process/network seams do not establish remote GitHub behavior. Publication-gate outcomes are recorded in the PR and coordinator handoff.

The real assignment report for UC-03 returned Tai and `NEEDS_PLANNING` for missing approved feature artifacts. Real preflight fetched development and flagged the known dirty implementation checkout without changing its source. The completed retro handoff was previewed and then preserved in [its archive](retro-handoff-2026-10-15.json) before removal from the shared store; PR #3 had already merged into development. The current contributor-helper assignment remained intact.

Preflight is an observation, not an execution permission. Artifact existence does not establish approval or completion. Archive previews leave the handoff, archive destination, and tracked view unchanged; shared helper directory/lock setup may still occur. Existing manual `clear` remains available for compatibility, with the workflow directing ordinary retirement through verified archival.
