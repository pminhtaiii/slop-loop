# Agent Dump Workspace

Use the integration checkout's ignored `.agent-work/` for temporary agent artifacts. Read this before creating worker worktrees or cleaning a run. This directory is local working storage, not the canonical feature specification or task ledger.

## Layout and ownership

| Location relative to the integration checkout | Contents |
|---|---|
| `.agent-work/<date>/<session-id>/` | Managed session: briefs, notes, logs, snapshots, and worker ownership receipts |
| `.agent-work/worktrees/<unique-worker-id>/` | Registered Git worktree, kept outside deletable session folders |
| `.agent-work/worktree-receipts/` | Helper-owned ownership, accepted-head, and evidence-hash receipts |
| `.agent-work/state/` | Shared contributor assignments and lock, used by all linked worktrees |

Start a session with the existing `agent-work.mjs` helper described in [the contributor workflow](../../context/workflow.md#agent-coordination). Register each worker with `agent-worktree.mjs`; its JSON receipt binds its path, owner/task, branch, base, integration ref, and managed session. Both helpers accept `--root <checkout>`; worktree retirement resolves the primary checkout automatically. Keep briefs and logs in the session, and durable verification outside the deletable dump area. Existing Markdown receipts are historical notes, not automatic cleanup authority.

Use the contributor workflow's compact reports to inspect session and assignment state before opening detailed records.

## Isolated implementation

Confirm the approved integration branch and resolve its current tip before creating a worker. Create the parent `.agent-work/worktrees/` directory if absent, then use:

```powershell
git -C <integration-checkout> worktree add -b <unique-task-branch> <absolute-worker-path> <verified-integration-tip>
git -C <integration-checkout> worktree list --porcelain
node scripts/agents/agent-worktree.mjs register --id <worker-id> --path <absolute-worker-path> --integration-ref <integration-branch> --session <date/session-id> --owner <owner> --task <task>
```

The worker path must be a new path inside the designated worktree area. A name collision stops creation; choose another owner/path instead of replacing an existing checkout. These commands create a separate checkout without switching the integration checkout's branch. Start agents with the worker checkout as their working directory. Existing uncommitted changes are not included automatically; preserve them and explicitly carry only required authorized files when needed.

Keep workers on their assigned task branches. Integrate through the approved feature workflow; creating a dump space does not authorize commits, merges, pushes, or source edits in another checkout.

## Gemini task briefs

Use the concise brief and final handoff shape in the [contributor workflow](../../context/workflow.md#task-briefs-and-handoffs), with the exact checkout, branch, and acceptance commands. Keep raw notes in the managed session. After one failed tool call, allow one named fallback and ask the worker to report a blocker if it also fails; browse only when the task needs current factual research.

## Repository package manager

Use `pnpm` for repository installs and package scripts. The root `package.json` pins pnpm; npm versions that support `devEngines.packageManager` reject npm installs and scripts, and Corepack refuses Yarn for this package. These settings do not intercept arbitrary shell commands or Yarn invoked outside Corepack. Contributor and runtime CI also install with pnpm.

The `pnpm install` prepare step selects the repository's `.githooks` directory when Git is available and no custom `core.hooksPath` is set. It skips setup when Git is missing or the checkout is outside a Git repository. The pre-commit hook checks staged regular text blobs from the index and rejects authored files over 20,000 bytes (about 5,000 tokens at bytes/4). It skips exact package lockfile names, `node_modules/`, `dist/`, `coverage/`, and codegen filenames containing `.generated.` or `.g.` before an extension; do not mark authored files as generated to avoid splitting. Split an oversized file by cohesive responsibility, keep a small entry point, then rerun `pnpm run check:staged-size`. Contributor CI exercises this staged-index checker with temporary Git indexes; it does not scan the pull-request tree. A custom Git hook path is preserved, and installs with `--ignore-scripts` do not configure the hook; run `pnpm run prepare` after a skipped lifecycle install when no custom hook path is configured.

## Retirement

Use the `clean-agent-dump` skill when a run is ready for cleanup. After the shared owner/task handoff is completed, the coordinator reviews the result and attests that workers stopped. Accept the receipt with a verification file outside `.agent-work/` and Git metadata, inside the primary checkout:

```powershell
node scripts/agents/agent-worktree.mjs accept --id <worker-id> --evidence docs/<verification-file> --workers-stopped
node scripts/agents/agent-worktree.mjs cleanup --id <worker-id>
```

The preview reports eligibility or a retention reason. It checks registered/canonical paths, branch and accepted HEAD, active/blocked shared tasks, dirty/untracked/ignored content, ancestry into the recorded integration ref, and the retained evidence hash. A clean tree alone does not prove integration. `--workers-stopped` is the coordinator's explicit attestation, not process discovery by the CLI.

When removal is authorized, repeat the targeted cleanup command with `--apply`. Under shared locks the helper rechecks eligibility and uses Git's non-forced worktree removal, retaining the branch and ownership receipt. It rejects the invoking checkout, primary checkout, unknown owners, and paths outside the managed area. Session cleanup remains separate; its helper retains active, linked, malformed, and Git-containing folders. Neither operation deletes the dump root or overrides a safety refusal.
