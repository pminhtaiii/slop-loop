# Background Publication Jobs

The standard [PR-first workflow](pr-workflow.md#publish-a-draft) uses foreground `publish --mode push-only` and runs regression suites in CI. This optional detached runner retains automatic changed-path selection and may run long local gates; select it deliberately:

```powershell
node scripts/agents/publication-job.mjs start --root <checkout> --body-file <file> --summary "<action summary>"
node scripts/agents/publication-job.mjs status --root <checkout> --id <returned-job-id>
```

`start` retains the checkout, branch, candidate SHA, frozen PR body and log path in the primary checkout's ignored `.agent-work/publication-jobs/`. It launches the existing `publish` operation with detached execution, hidden Windows UI and file-backed output. Default path selection skips local suites for eligible documentation/contributor-only changes and retains full gates for runtime or unknown changes. `--skip-review-request` is supported; use foreground `publish --mode full` to force full local verification. The publisher fetches development and checks ancestry before expensive gates, so a stale branch fails before the suites run. Keep the checkout unchanged until the job ends; a candidate change before worker execution refuses publication, and normal publisher checks still apply before push.

After `STARTED`, record the job ID, checkout, candidate and resume command in the active assignment's next action, send one concise pending update, and end the agent turn. Agents may yield while gates run. Resume when the user returns or the host delivers a completion event; this runner installs no notification or scheduled wakeup. Inspect retained status once on resume rather than opening a model-driven polling loop. Full logs and heartbeats stay on disk; inspect a bounded tail for failures. `SUCCEEDED` means publication returned successfully, not that remote CI or contributor completion passed. Follow normal status, app-link and finish gates afterward. Pending remote CI also permits yielding to the public PR watcher or a later user turn.

An unfinished job blocks a second background start for the same branch across linked checkouts. `processAlive` is a best-effort PID observation, not evidence of gate success or process identity. After an interrupted process, retain its record and inspect logs and workflow locks before explicit recovery; stale records and locks are never reclaimed automatically. Foreground publication remains available, so coordinators must inspect the retained job before launching it too. Yielding retains active assignments and does not finish sessions, cancel jobs, authorize cleanup or authorize merging.

Before editing a follow-up, use [contributor preparation](orchestration-tools.md#contributor-preparation) to observe live PR state. A merged PR requires a fresh branch through `prepare-next`; a local commit does not reopen its old publication lifecycle. Preserve unpublished commits on the source branch and intentionally carry only the approved correction into the new scope.

The status command includes a bounded `progress` summary from the retained publication log so callers can identify the latest gate without reading a full transcript. Missing or partial log data stays unavailable/unknown and never promotes `RUNNING` to success. The retained job result and live PR checks remain authoritative for their respective stages.

