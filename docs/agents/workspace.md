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

## Isolated implementation

Confirm the approved integration branch and resolve its current tip before creating a worker. Create the parent `.agent-work/worktrees/` directory if absent, then use:

```powershell
git -C <integration-checkout> worktree add -b <unique-task-branch> <absolute-worker-path> <verified-integration-tip>
git -C <integration-checkout> worktree list --porcelain
node scripts/ci/agent-worktree.mjs register --id <worker-id> --path <absolute-worker-path> --integration-ref <integration-branch> --session <date/session-id> --owner <owner> --task <task>
```

The worker path must be a new path inside the designated worktree area. A name collision stops creation; choose another owner/path instead of replacing an existing checkout. These commands create a separate checkout without switching the integration checkout's branch. Start agents with the worker checkout as their working directory. Existing uncommitted changes are not included automatically; preserve them and explicitly carry only required authorized files when needed.

Keep workers on their assigned task branches. Integrate through the approved feature workflow; creating a dump space does not authorize commits, merges, pushes, or source edits in another checkout.

## Retirement

Use the `clean-agent-dump` skill when a run is ready for cleanup. After the shared owner/task handoff is completed, the coordinator reviews the result and attests that workers stopped. Accept the receipt with a verification file outside `.agent-work/` and Git metadata, inside the primary checkout:

```powershell
node scripts/ci/agent-worktree.mjs accept --id <worker-id> --evidence docs/<verification-file> --workers-stopped
node scripts/ci/agent-worktree.mjs cleanup --id <worker-id>
```

The preview reports eligibility or a retention reason. It checks registered/canonical paths, branch and accepted HEAD, active/blocked shared tasks, dirty/untracked/ignored content, ancestry into the recorded integration ref, and the retained evidence hash. A clean tree alone does not prove integration. `--workers-stopped` is the coordinator's explicit attestation, not process discovery by the CLI.

When removal is authorized, repeat the targeted cleanup command with `--apply`. Under shared locks the helper rechecks eligibility and uses Git's non-forced worktree removal, retaining the branch and ownership receipt. It rejects the invoking checkout, primary checkout, unknown owners, and paths outside the managed area. Session cleanup remains separate; its helper retains active, linked, malformed, and Git-containing folders. Neither operation deletes the dump root or overrides a safety refusal.
