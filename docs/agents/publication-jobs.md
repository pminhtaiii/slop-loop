# Background Publication Jobs

Start long local publication gates through the detached runner:

```powershell
node scripts/agents/publication-job.mjs start --root <checkout> --body-file <file> --summary "<action summary>"
node scripts/agents/publication-job.mjs status --root <checkout> --id <returned-job-id>
```

`start` retains the checkout, branch, candidate SHA, frozen PR body and log path in the primary checkout's ignored `.agent-work/publication-jobs/`. It launches the existing full `publish` operation with detached execution, hidden Windows UI and file-backed output. `--skip-review-request` is supported; push-only execution remains an explicit foreground choice. The publisher fetches development and checks ancestry before expensive gates, so a stale branch fails before the suites run. Keep the checkout unchanged until the job ends; a candidate change before worker execution refuses publication, and normal publisher checks still apply before push.

After `STARTED`, record the job ID, checkout, candidate and resume command in the active assignment's next action, send one concise pending update, and end the agent turn. Agents may yield while gates run. Resume when the user returns or the host delivers a completion event; this runner installs no notification or scheduled wakeup. Inspect retained status once on resume rather than opening a model-driven polling loop. Full logs and heartbeats stay on disk; inspect a bounded tail for failures. `SUCCEEDED` means publication returned successfully, not that remote CI or contributor completion passed. Follow normal status, app-link and finish gates afterward. Pending remote CI also permits yielding to the public PR watcher or a later user turn.

An unfinished job blocks a second background start for the same branch across linked checkouts. `processAlive` is a best-effort PID observation, not evidence of gate success or process identity. After an interrupted process, retain its record and inspect logs and workflow locks before explicit recovery; stale records and locks are never reclaimed automatically. Foreground publication remains available, so coordinators must inspect the retained job before launching it too. Yielding retains active assignments and does not finish sessions, cancel jobs, authorize cleanup or authorize merging.

