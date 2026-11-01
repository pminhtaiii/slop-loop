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

## Contributor preparation

Before starting a new worker or editing a follow-up to a published change, run `node scripts/agents/contributor-prepare.mjs --root <checkout>`. Its compact report combines checkout freshness, live PR state, role/assignment observations, context pointers and observed executable availability. Host model and sandbox capabilities remain unknown unless supplied by the host; the report does not infer them from repository files.

`READY` permits the next scoped action. `BLOCKED` preserves the checkout and registry. `NEEDS_NEXT_BRANCH` identifies a merged PR and points to the existing `pr-workflow.mjs prepare-next` operation; supplying `--next-branch <feat/scope-description>` makes that next command concrete. Closed or unknown PR state requires diagnosis rather than treating the branch as fresh. The default report does not edit the worktree or assignment registry; its existing preflight fetch updates remote-tracking metadata and requires Git fetch access.

For new existing-checkout workers, use the registration path after the coordinator has selected the intended checkout:

```powershell
node scripts/agents/contributor-prepare.mjs --register --root <checkout> --owner <worker> --task <task> --session <date/session> --summary "<scope>" --next "<next action>" --owned-path <path> --factory-managed
```

Registration calls the existing worker-start lifecycle only after a ready report and a current live-PR/branch/HEAD recheck, passing expected branch/head and cleanliness guards into the registry write boundary. Blocked or merged-branch preparation creates no assignment and performs no branch move. Reserve/bind remains the required path for new worktrees; preparation does not replace its receipts. Finish preparation before dispatching workers, and keep their bound checkout/branch fixed until handoff or explicit recovery.

## Focused verification receipts

Capture focused evidence on its first execution with `node scripts/agents/focused-check.mjs run --root <checkout> --receipt <session-relative-file.json> --input <source-path> -- <command> <args>`. Supply the receipt as a repository-relative path under the ignored managed session, for example `.agent-work/<date>/<session>/checks.json`; declare all relevant input/configuration files with repeated `--input`. Use the same arguments with `verify` instead of `run` to check retained evidence without executing the command again.

The runner retains actual output, exit status, command arguments, candidate/input fingerprints and an allowlisted execution-environment identity. Receipts contain no raw environment-variable dump. Successful unchanged receipts may be reused at focused verification/review boundaries; changed inputs, candidate, command, environment, receipt or output artifacts require a new run. Undeclared external state and semantic correctness remain outside that reuse claim. Failed or skipped results cannot establish successful verification.

Use existing evidence when its bindings remain applicable instead of rerunning a command only to save its output. These focused receipts never bypass required full publication gates or independent CI.

The context contract's `requiredSkillStages` entries bind a required skill path to a named workflow heading. The context checker requires a real link inside that heading's section; a navigation-only link elsewhere or a fenced example does not satisfy the requirement. The configured `verify-task` mapping keeps pre-handoff verification discoverable at its execution stage.

## Factory state checks

Use `node scripts/agents/factory-state.mjs capture --root <checkout>` to capture a candidate fingerprint. It returns `schemaVersion`, `candidateSha256`, and `candidate`, binding HEAD, branch, index modes/blob IDs, and worktree bytes for tracked and non-ignored untracked files. Unsupported linked, submodule or unmerged entries block capture. Save output and other run artifacts in the ignored managed session so creating evidence does not change the candidate.

The coordinator prepares a schema-v1 manifest with `identity` (`owner`, `task`, `session`, absolute `checkout`), `candidateSha256`, exact `ownedPaths`, `authorization` (`declared: true`, nonempty `sources` of repository-relative `path` and `sha256`), and nonempty `criteria`. Each criterion has an `id`, `source` matching an authorization-source path, `allowedTiers`, and `requiredChecks`. The authorization declaration records the coordinator's scoped decision; the helper does not interpret permission from prose or task completion.

```powershell
node scripts/agents/factory-state.mjs check --mode dispatch --root <checkout> --manifest <manifest.json> --manifest-sha256 <trusted-sha256>
node scripts/agents/factory-state.mjs check --mode handoff --root <checkout> --manifest <manifest.json> --manifest-sha256 <trusted-sha256> --evidence <evidence.json> --evidence-sha256 <trusted-sha256>
```

Pass SHA-256 digests retained by the coordinator, separately from worker-controlled files. Hashing a replacement manifest supplied by the worker would defeat this binding. Dispatch checks the registered worker identity, checkout binding, exact ownership, competing active/blocked ownership, authorization-source bytes, and candidate fingerprint. Unknown competing worker ownership blocks conservatively; resolve stale assignments through the existing recovery workflow rather than treating them as stopped. These checks are read-only observations; they do not reserve paths, dispatch agents, change task state, or replace existing lifecycle gates.

For handoff, evidence schema v1 contains `identity`, `manifestSha256`, `candidateSha256`, and `criteria`. Each criterion records `id`, `status: "passed"`, an allowed `tier`, and `checks`; each required check records `id`, `status: "passed"`, `command`, `exitCode: 0`, and nonempty `artifacts` containing repository-relative `path` and `sha256`. The helper checks retained artifact bytes as well as required coverage. Missing, failed, skipped, mismatched, or stale required evidence blocks the check.

Implementation changes invalidate the dispatch candidate. Before handoff, the coordinator captures the final candidate and pins its manifest, preserving the approved criteria and authorization boundaries; the worker then supplies evidence for that final binding. Refresh affected evidence after further changes. A pass establishes declared binding and coverage only: caller-supplied commands, exit statuses, tiers and reports are not independent execution attestations or semantic acceptance. Independent review and contributor publication remain separate.

The check command prints JSON `status: "pass"` with exit 0, or `status: "blocked"` and reasons with nonzero exit. It executes no evidence commands and grants no merge authority. Controlled fixtures run with `node --test tests/agents/factory-state.test.mjs`.

### Enforced factory handoff

Opt worker assignments into factory verification with `--factory-managed` when starting or reserving them. After verification of the final candidate, the coordinator pins the manifest and evidence on that assignment:

```powershell
node scripts/agents/active-task.mjs pin-factory-handoff --owner <worker> --task <task> --manifest <manifest.json> --evidence <evidence.json> --root <checkout>
node scripts/agents/active-task.mjs handoff --owner <worker> --task <task> --result "<scoped result>" --root <checkout>
```

Pinning retains regular-file references and their digests under the registered assignment. Handoff consumes those saved pins; worker-supplied replacement criteria are not accepted through the handoff command. Missing pins or changed candidate, authorization, criteria or evidence block the marked assignment before its handoff state changes. Existing binding, readiness and owned-path checks still apply. Unmarked legacy assignments retain their existing lifecycle. Pinning is a trusted local coordinator operation, not operating-system isolation from an actor who can rewrite shared state. Reassigned workers keep the factory requirement but need fresh pins for their new identity.

## Source boundary lint

ESLint applies source-only restrictions under `src/`: access to mock-private `transitionContexts` and `v02Calls`, including computed-string and destructuring access, and imports from `tests/runtime/support`. Runtime test support remains available to tests. Typed production methods such as `getJournalSnapshot` and ordinary `unknown` casts remain usable through their declared contracts.
