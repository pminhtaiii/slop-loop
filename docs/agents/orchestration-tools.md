# Orchestration output tools

Use [`agent-output.mjs`](../../scripts/agents/agent-output.mjs) to save a small JSON handoff and inspect a bounded log tail from an active contributor session. It accepts JSON on stdin, writes only inside the selected session, and prints a JSON receipt. It does not launch or verify another process.

## Save a handoff

Start the managed session first, and use the task output already provided by [`agent-context.mjs task`](../../scripts/agents/agent-context.mjs) for approved feature work. Add only the brief delta the worker needs; this tool does not parse or duplicate the task ledger.

```powershell
# Use the session identity from the registered assignment.
$sessionDate = $registeredSessionDate
$sessionId = $registeredSessionId
$workspace = (Get-Location).Path
$session = "$sessionDate/$sessionId"
node scripts/agents/agent-work.mjs start --session $sessionId --date $sessionDate --root $workspace

# Set these from the already-authorized feature assignment.
$tasksFile = $approvedTasksFile
$taskId = $approvedTaskId
$planFile = $approvedPlanFile
$taskContext = node scripts/agents/agent-context.mjs task --tasks $tasksFile --task $taskId --plan $planFile

$payload = @{
  brief = @{
    taskContext = $taskContext -join "`n"
    delta = 'Describe only the scoped change the worker needs.'
  }
  exitObservation = @{
    code = 0
    signal = $null
  }
}
$handoffJson = $payload | ConvertTo-Json -Depth 30 -Compress
$oldOutputEncoding = $OutputEncoding
$oldConsoleEncoding = [Console]::OutputEncoding
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
try {
  $OutputEncoding = $utf8NoBom
  [Console]::OutputEncoding = $utf8NoBom
  $receiptJson = $handoffJson | node scripts/agents/agent-output.mjs --workspace $workspace --session $session --output 'handoff.json'
} finally {
  $OutputEncoding = $oldOutputEncoding
  [Console]::OutputEncoding = $oldConsoleEncoding
}
$receipt = $receiptJson | ConvertFrom-Json
$receipt | Format-List status, output, bytes, exitObservation
```

The `--workspace` value must be a Git checkout root. The example sets PowerShell's native pipeline and console encodings to UTF-8 without a BOM for Windows PowerShell 5.1 and PowerShell 7, then restores both settings. PowerShell passes each option value as a separate argument; the JSON travels through stdin, so paths and JSON strings do not need shell interpolation. `handoff.json` is written as UTF-8 without a BOM under `.agent-work/<date>/<session-id>/`. The output must be a single `.json` filename that does not already exist. If passed, `--log` must name an existing regular file in the same session directory.

`exitObservation` is caller-supplied metadata copied to the receipt. A code of `0` does not prove the observed process succeeded: the CLI does not run that process. The CLI's own exit status is `0` only when it writes the handoff and receipt successfully.

| Bound | Limit |
|---|---:|
| JSON on stdin | 256 KiB, one UTF-8 object, no BOM |
| Log tail in the JSON receipt | 16 KiB and 100 lines |
| Output path | One filename inside the active session |

Malformed or oversized JSON is rejected before any output write. Existing files, linked session directories, and invalid output names are refused. Log text is returned as UTF-8 text with file size, retained byte and line counts, and a truncation flag; the CLI does not return a base64 or full log copy.

## Batch readiness

Use `agent-context.mjs batch` to report a read-only dependency frontier and `review-ready` to check whether an integrated task batch is ready for its single end-of-batch review:

```powershell
node scripts/agents/agent-context.mjs batch --tasks <tasks.md> --scope T057-T061 [--scope T063] [--authorized T057] [--session <id>] [--root <checkout>]
node scripts/agents/agent-context.mjs review-ready --tasks <tasks.md> --scope T057-T061 [--scope T063] [--authorized T057] [--session <id>] [--no-review] [--root <checkout>]
```

Scopes accept canonical task IDs or inclusive ranges. A dependency-ready frontier does not grant authorization: only IDs supplied with `--authorized` are reported as caller-provided. `review-ready` blocks on unchecked closure tasks, unknown or external prerequisites, active or blocked scoped workers, unintegrated handoffs, and path conflicts. With `--no-review`, `review.status` is `skipped`, `review.reviewed` is `false`, and `review.acceptanceCertified` is `false`; it records an opted-out review, not a review pass or acceptance certificate.

## Source boundary lint

ESLint applies source-only restrictions under `src/`: access to mock-private `transitionContexts` and `v02Calls`, including computed-string and destructuring access, and imports from `tests/runtime/support`. Runtime test support remains available to tests. Typed production methods such as `getJournalSnapshot` and ordinary `unknown` casts remain usable through their declared contracts.
