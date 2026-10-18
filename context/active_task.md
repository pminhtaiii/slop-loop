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
    "next": "Await human review and merge decision for follow-up public PR #54 and paired submission PR #42; do not merge without explicit instruction. The user waived the app-link receipt; keep contributor bookkeeping active.",
    "status": "active",
    "verification": "UC-01 T002–T004 source HEAD ed8f8a1 was merged to development by public PR #52 (merge 9845ab8) and paired submission PR #40 (merge f173ee6). Focused tests: 38 passed; runtime gate: typecheck/lint/build and 367 compiled tests passed; full node --test: 895 passed, 1 Windows skip; independent digest audit matched 33 public and 33 grading records. Final GPT-6.1 Sol Low Standards and Spec review found no actionable issues. Four current-head public CI jobs passed and no review conversations remain unresolved. Local CodeRabbit reviews identified issues that were repaired; the final CLI rerun on ed8f8a1 was rate-limited (44-minute wait), and GitHub's CodeRabbit check displayed pass with a rate-limit note, so no final CLI review is claimed. No live calls or model-quality result are claimed. User waived the app-link receipt; contributor bookkeeping remains active.",
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
