---
name: fixing-ci-failures
description: Use when remote CI checks, GitHub Actions pipelines, or automated test runners fail on a branch or PR
---

# Fixing CI Failures

## Overview

Remote CI environments encounter distinct constraints that local development machines often do not: resource limits, CPU scheduling contention, platform-specific pathing, permission boundaries, and strict network isolation.

**Core principle:** Always pull and isolate remote failure logs to identify the exact root cause before attempting fixes. Never guess, thrash, or re-run blind.

---

## When to Use

- GitHub Actions or other automated CI checks fail on a branch or pull request
- A test or job passes locally but times out or fails on the remote CI runner
- Cross-platform gates (e.g. Windows runner vs. Linux runner) exhibit OS-specific failures
- Build, typecheck, lint, or format verification jobs report errors in remote pipelines

### When NOT to Use

- Local verification has not been run yet (run local tests, lint, and typecheck before pushing)
- Failure is caused by missing remote repository secrets or external outages outside the code repository (escalate to user)
- PR / branch checks are already green

---

## The CI Remediation Loop

```
  ┌────────────────────────────────────────────────────────┐
  │ 1. Check CI Status (gh pr checks / gh run list)         │
  └───────────────────────────┬────────────────────────────┘
                              │ Failing
                              ▼
  ┌────────────────────────────────────────────────────────┐
  │ 2. Pull Remote Failure Logs (gh run view --log-failed) │
  └───────────────────────────┬────────────────────────────┘
                              │ Error & stack isolated
                              ▼
  ┌────────────────────────────────────────────────────────┐
  │ 3. Trace Root Cause (Timeout, Platform, Env, Logic)    │
  └───────────────────────────┬────────────────────────────┘
                              │ Cause identified
                              ▼
  ┌────────────────────────────────────────────────────────┐
  │ 4. Minimal Local Fix & Local Verification              │
  └───────────────────────────┬────────────────────────────┘
                              │ Passes locally
                              ▼
  ┌────────────────────────────────────────────────────────┐
  │ 5. Stage, Commit & Push to Remote                      │
  └───────────────────────────┬────────────────────────────┘
                              │ Re-triggered
                              ▼
  ┌────────────────────────────────────────────────────────┐
  │ 6. Monitor Pipeline (gh run watch)                     │
  └─────────────┬────────────────────────────┬─────────────┘
                │ Still failing (< 3 tries)  │ All Pass
                ▼                            ▼
         [ Repeat Loop ]                [ CI Green ]
```

---

## Process Steps

### 1. Pin the Failing Run & Job

Inspect current check status via GitHub CLI:

```bash
# For a pull request:
gh pr checks <pr-number>

# For the active branch:
gh run list --branch <branch-name> --limit 5
```

Identify:
- Failing workflow run ID
- Specific failing job name(s) and job ID(s)
- Failing step name(s)

### 2. Extract and Isolate the Failure Logs

Never guess what failed from step names alone. Pull the exact step failure logs:

```bash
# View all failed step logs from the run:
gh run view <run-id> --log-failed

# Or target a specific failing job:
gh run view <run-id> --job <job-id> --log-failed
```

Extract the exact:
- Failure title and error message
- Stack trace with file and line numbers
- Elapsed duration before failure (distinguishes timeouts from fast crashes)

### 3. Trace the Root Cause

Classify the failure into one of these distinct categories before touching code:

| Failure Category | Symptoms in Logs | Typical Root Causes | Correct Remediation |
|---|---|---|---|
| **Timeout / Contention** | `Error: Test timed out in 5000ms`, `ETIMEDOUT` | Runner CPU starvation under parallel test execution; slow process spawning on Windows (e.g. `git.exe`) | Increase default timeout in test runner config (e.g. `vitest.config.ts`) and add explicit test-level `{ timeout: ... }` options |
| **Platform / OS Difference** | Path separator errors (`/` vs `\`), CRLF/LF line ending mismatches, symlink errors | Windows runner lacks Linux utilities; developer mode required for symlinks; case insensitivity differences | Use `path.join`/`node:path` normalization; inspect OS capabilities (`skipIf(!symlinkSupported)`) |
| **Logic / Regression** | `AssertionError: expected X to be Y` | Feature edits altered expected output, broke a contract, or left a test out of date | Fix production code or update assertions to match updated specifications |
| **Dependency / Environment** | `Cannot find module`, lockfile mismatch, version skew | Pinned package missing; engine version mismatch; missing native build tools | Verify frozen lockfile, reinstall dependencies, or check runner prerequisites in workflow YAML |

### 4. Implement Minimal Fix Locally

Implement the minimal targeted change addressing the root cause:
- Do not bundle unrelated refactorings or stylistic tweaks.
- Verify the fix locally using the targeted test command first:
  ```bash
  pnpm exec vitest run <path/to/failing-test.ts>
  ```
- Run the repository quality gate (typecheck, lint, source tests):
  ```bash
  pnpm typecheck
  pnpm lint
  ```

### 5. Stage, Commit, and Push

Commit with a focused conventional commit message explaining the failure and remediation:

```bash
git add <modified-files>
git commit -m "fix(ci): increase timeout for Windows runner git-heavy workspace tests"
git push origin <head-branch>
```

### 6. Monitor Pipeline & Circuit Breaker

Wait for GitHub Actions to pick up the push and monitor progress:

```bash
# Monitor the in-flight run:
gh run watch <run-id>

# Or check status of the PR checks:
gh pr checks <pr-number>
```

#### Circuit Breaker Rule (Preventing Thrashing)
- If a fix fails on the runner **3 consecutive times**:
  - **STOP** immediately.
  - Do not push a 4th speculative fix.
  - Review runner architectural differences, workflow configuration, or discuss with your human partner.

---

## Quick Reference Commands

| Operation | Command |
|---|---|
| Check PR status | `gh pr checks <pr-number>` |
| List recent runs | `gh run list --branch <branch> --limit 5` |
| View failed logs | `gh run view <run-id> --log-failed` |
| View job logs | `gh run view <run-id> --job <job-id>` |
| Watch active run | `gh run watch <run-id>` |
| Re-run failed jobs | `gh run rerun <run-id> --failed` |

---

## Common Rationalizations & Red Flags

| Rationalization | Reality |
|---|---|
| *"It's just a flake, let me re-run without changing anything."* | Flakes are usually unhandled race conditions or inadequate timeouts under runner load. Harden the test. |
| *"It passed on my laptop, so the CI runner is wrong."* | The CI runner is the canonical production gatekeeper. Fix the code to tolerate runner constraints. |
| *"I know what's wrong, I don't need to read the remote logs."* | Guessing causes thrashing and wasted CI minutes. Always inspect `--log-failed` first. |
| *"Let me push 5 speculative fixes together."* | Multi-variable changes mask the real problem and create secondary regressions. Change one thing at a time. |
