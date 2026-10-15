# Active Task Handoff

This file is a checkout-local view of shared contributor work and completed handoffs awaiting review. The primary checkout's ignored `.agent-work/state/active-tasks.json` is authoritative across worktrees. Follow the [active-task workflow](workflow.md#active-task-handoff); approved feature status remains in its `tasks.md`.

Use `node scripts/agents/active-task.mjs --help` to manage your own owner/task entry. `list` reads shared assignments; `render` refreshes this view. Mutations update shared state; only primary-checkout mutations refresh Markdown automatically. Worker mutations leave tracked files unchanged. Keep the goal, next action, verification, and blockers current. Completed workers leave results for review; clear them after integration and durable evidence recording. Retain blocked or interrupted entries.

The script preserves these instructions and changes only the managed data below. An empty array is the commit-ready baseline; the file and its markers remain in the repository. Keep secrets and raw logs out of entries; link to approved evidence instead.

## Current assignments

<!-- active-task:start -->
```json
[
  {
    "owner": "codex-dump-setup",
    "task": "agent-dump",
    "summary": "Set up isolated agent dump workspace and cleanup skill",
    "next": "Coordinator review and evidence recording",
    "status": "completed",
    "verification": "C:/coding agent/.agent-work/2026-10-15/dump-space-setup/verification.md; 37 passed, one existing skip",
    "updatedAt": "2026-10-15T09:20:36.102Z",
    "result": "Dump layout and clean-agent-dump skill ready in codex/agent-dump-setup. Guarded nested Git checkout cleanup; context and tests passed. Retain this uncommitted worktree for review.",
    "checkout": "C:/coding agent/.agent-work/worktrees/dump-space-setup"
  },
  {
    "owner": "codex-context-five",
    "task": "context-five",
    "checkout": "C:\\coding agent",
    "summary": "Clarify data and checkpoint contracts, define glossary, extract maintenance guide, structure progress evidence",
    "next": "Update context and domain documentation",
    "status": "active",
    "verification": "",
    "updatedAt": "2026-10-15T11:05:28.244Z"
  }
]
```
<!-- active-task:end -->
