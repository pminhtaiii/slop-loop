# Active Task Handoff

This file is a checkout-local view of shared contributor work and completed handoffs awaiting review. The primary checkout's ignored `.agent-work/state/active-tasks.json` is authoritative across worktrees. Follow the [active-task workflow](workflow.md#active-task-handoff); approved feature status remains in its `tasks.md`.

Use `node scripts/agents/active-task.mjs --help` to manage your own owner/task entry. `list` reads shared assignments; `render` refreshes this view. Routine mutations update only ignored shared state in every checkout. Only explicit `render` changes this optional Markdown view; use `list` for current assignments and keep rendered local snapshots out of unrelated PRs. Keep the goal, next action, verification, and blockers current. Completed workers leave results for review; clear them after integration and durable evidence recording. Retain blocked or interrupted entries.

The script preserves these instructions and changes only the managed data below. An empty array is the commit-ready baseline; the file and its markers remain in the repository. Keep secrets and raw logs out of entries; link to approved evidence instead.

## Current assignments

<!-- active-task:start -->
```json
[
  {
    "owner": "codex-uc01-phase2-20261018",
    "task": "T002-T004",
    "checkout": "D:\\UIT\\PROJECT\\SE373_PROJECT\\CODING_AGENT\\slop-loop",
    "role": "coordinator",
    "summary": "Implement UC-01 Phase 2 contract validators, controlled mocks, and versioned fixtures",
    "next": "Await human merge decision for public PR #52 and submission PR #40; do not merge without explicit instruction. Both original CodeRabbit threads are resolved. The user waived app-link receipt; leave bookkeeping active.",
    "status": "active",
    "verification": "UC-01 T002–T004 implementation code is unchanged since source HEAD 5d62eec (catalog binding, guard-slot fix, fixture-oracle correction). Focused tests 38 pass; runtime gate 367 tests pass; full node --test 895 pass/1 Windows skip; digest audit 33 public + 33 grading match. GPT-6.1 Sol Low Standards and Spec reviews: no findings; pinned 12/12 snapshot unchanged. Local CodeRabbit committed review: exit 0, 0 findings across 13 files. Paired PRs #52/#40 are published from this branch; current-head GitHub checks and review state are tracked on PR #52. Both original CodeRabbit threads are resolved. Neither PR merged; user waived app-link receipt.",
    "updatedAt": "2026-10-18T10:33:32.768Z"
  },
  {
    "owner": "codex-uc01-t002-gpt61sol",
    "task": "T002",
    "checkout": "D:\\UIT\\PROJECT\\SE373_PROJECT\\CODING_AGENT\\slop-loop\\.agent-work\\worktrees\\uc01-phase2-t002-gpt61sol",
    "role": "worker",
    "summary": "Implement UC-01 contract and evaluation validators",
    "next": "Coordinator integration and PR publication required",
    "status": "handed-off",
    "verification": "",
    "updatedAt": "2026-10-18T08:20:54.600Z",
    "result": "Stopped after user clarified the coordinator is the implementer and GPT-6.1 Sol Low should review. Uncommitted draft remains in the registered worktree at src/uc01/contracts.ts and tests/runtime/uc01/contract.test.ts; initial RED/GREEN slices and digest subset were reported passing. Coordinator will inspect and take over; no task status changed."
  }
]
```
<!-- active-task:end -->
