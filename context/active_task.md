# Active Task Handoff

This file is a checkout-local view of shared contributor work and completed handoffs awaiting review. The primary checkout's ignored `.agent-work/state/active-tasks.json` is authoritative across worktrees. Follow the [active-task workflow](workflow.md#active-task-handoff); approved feature status remains in its `tasks.md`.

Use `node scripts/agents/active-task.mjs --help` to manage your own owner/task entry. `list` reads shared assignments; `render` refreshes this view. Routine mutations update only ignored shared state in every checkout. Only explicit `render` changes this optional Markdown view; use `list` for current assignments and keep rendered local snapshots out of unrelated PRs. Keep the goal, next action, verification, and blockers current. Completed workers leave results for review; clear them after integration and durable evidence recording. Retain blocked or interrupted entries.

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
    "checkout": "D:/UIT/PROJECT/SE373_PROJECT/CODING_AGENT/slop-loop"
  },
  {
    "owner": "coderabbit-8ef9a633",
    "task": "adr-0004-dates",
    "checkout": "D:/UIT/PROJECT/SE373_PROJECT/CODING_AGENT/slop-loop",
    "summary": "Verify and correct ADR-0004 approval dates",
    "next": "Coordinator review and evidence recording",
    "status": "completed",
    "verification": "Context updater/check passed: 30 Markdown files, 3 canonical facts; no context policy changes required.",
    "updatedAt": "2026-10-15T17:35:03.190Z",
    "result": "Removed unsupported acceptance and closure claims; verified recording date as 2026-10-15 UTC from commit 2c79794b868dc9cfaceb16abd68cf9e3a9a38ea0. Approval dates remain unverified."
  },
  {
    "owner": "codex-pr-conventions-010",
    "task": "tooling-pr-conventions",
    "checkout": "D:\\UIT\\PROJECT\\SE373_PROJECT\\CODING_AGENT\\slop-loop",
    "role": "coordinator",
    "summary": "Standardize naming and paired development targets",
    "next": "Obtain real app list_thread_pull_requests receipt containing public #37 and private #25; import via record-app-state, then rerun finish and preview/archive. This session exposes no app link/list tool. Keep both PRs Draft.",
    "status": "blocked",
    "verification": "Implementation/publish complete at 85764a96e48a0489a941406e2da0f28aeee42252; public #37/private #25 development; same tree 5063b6b20b55a734204c81dab83d9476d6522319; private ancestry verified; all 8 CI jobs pass; CodeRabbit completed with no actionable comments (docstring advisory retained); local 590 passed/1 skipped, runtime 230 passed; finish exited 1 for missing app receipt. Evidence: .agent-work/conventions-verification.json",
    "updatedAt": "2026-10-17T12:27:40.977Z"
  },
  {
    "owner": "codex-uc01-20261017",
    "task": "uc01-planning",
    "checkout": "D:\\UIT\\PROJECT\\SE373_PROJECT\\CODING_AGENT\\slop-loop",
    "role": "coordinator",
    "summary": "Draft UC-01 SDD artifacts, independent review, ticket proposal and paired PR",
    "next": "Obtain genuine app list_thread_pull_requests receipt containing public PR45 and private PR33, import with record-app-state, then rerun finish. Keep both Draft. Current-head CodeRabbit re-review is quota limited; prior two Minor findings repaired and resolved.",
    "status": "blocked",
    "verification": "Final public HEAD d15fd98a53e0864b775250f6a249d4f7e7bde9e3: CI4/4 pass; all local gates pass, runtime230, node590 pass/1 Windows skip. Local review3 agents clear; CodeRabbit2Minor repaired in1 PR round. 6 paired Issues/12 native edges verified, tasks16 open/P0. Completion blocked solely by unavailable real app receipt.",
    "updatedAt": "2026-10-17T13:33:09.812Z"
  },
  {
    "owner": "codex-uc01-incremental-20261017",
    "task": "uc01-incremental-specs",
    "checkout": "D:\\UIT\\PROJECT\\SE373_PROJECT\\CODING_AGENT\\slop-loop",
    "role": "coordinator",
    "summary": "Revise UC01 specs and existing paired Issues for incremental evaluation; publish new paired PRs",
    "next": "Import genuine app list_thread_pull_requests receipt for new PR48/private36 when the app capability is available; record-app-state then finish. Keep Drafts; monitor remaining private Windows contributor CI and CodeRabbit rate limit. No runtime authorization.",
    "status": "blocked",
    "verification": "Publication014 HEAD f76de355727b15c13ed05c5aeeea25a86c546ee6, paired tree8cfe49f446cafd7189dcfc9ce057ffcbb139812a. Public four CI PASS, READY_FOR_HUMAN; private three PASS/one pending. Three independent reviewers final round3 PASS; one Major and one later CodeRabbit Minor fixed. Six Issue pairs verified. Complete refused missing app receipt; no receipt tools available.",
    "updatedAt": "2026-10-17T15:26:57.890Z"
  },
  {
    "owner": "codex-uc01-t001-20261018",
    "task": "uc01-t001",
    "checkout": "D:\\UIT\\PROJECT\\SE373_PROJECT\\CODING_AGENT\\slop-loop",
    "role": "coordinator",
    "summary": "Review T001 artifact and consumer-contract agreement",
    "next": "Repair published and validated; obtain native app receipt for existing PR51/PR39, record-app-state then finish/archive; native linking/list tools remain unavailable here",
    "status": "blocked",
    "verification": "Commit ab08ad6: one-row CodeRabbit repair; CLI0 findings;2 subagents no blockers; local gates passed819 tests/1skip; all4 exact-head CI passed; thread resolved; AWAITING_HUMAN_MERGE. Evidence .agent-work/2026-10-18/uc01-t001/repair-1/verification.md",
    "updatedAt": "2026-10-18T07:50:12.276Z"
  },
  {
    "owner": "codex-uc01-phase2-20261018",
    "task": "T002-T004",
    "checkout": "D:\\UIT\\PROJECT\\SE373_PROJECT\\CODING_AGENT\\slop-loop",
    "role": "coordinator",
    "summary": "Implement UC-01 Phase 2 contract validators, controlled mocks, and versioned fixtures",
    "next": "Publish paired PRs #52/#40 from the verified branch, monitor exact-head CI, and resolve only the two repaired threads after checks pass. Keep both PRs unmerged; the user waived the app-link receipt.",
    "status": "active",
    "verification": "Code HEAD 5d62eec: focused UC-01 38 pass; runtime gate typecheck/lint/build/367 tests pass; full node --test 895 pass/1 Windows skip; digest audit 33 public + 33 grading match. Context refresh applied and validated. GPT-6.1 Sol Low Standards and Spec reviews on pinned diff through e0b0c6a: no actionable findings; snapshot 12/12 unchanged. CodeRabbit CLI committed review exit 0, 0 findings across 13 files. Earlier five findings: three valid fixed; two skipped against approved digest profile and fixture limits.",
    "updatedAt": "2026-10-18T10:26:27.746Z"
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
