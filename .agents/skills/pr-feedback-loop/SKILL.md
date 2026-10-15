---
name: pr-feedback-loop
description: Prepare or update PRs and converge CI feedback by diagnosing failing GitHub Actions runs and applying fixes until green. Use for PR preparation with verification, PR updates, or failing CI checks; use pr for body-only writing.
---

**Poll** CI pipeline status, **harvest** failing GitHub Actions steps, **triage** errors against local gates, **remediate** locally, and commit/push until the remote pipeline **converges** to green.

## PR preparation and updates

When the task includes opening or updating a PR, read [the PR body skill](../pr/SKILL.md) before writing its body. Use that skill's format, the final diff, and verified evidence. Refresh the description after remediation when PR updates are authorized by the task. A CI-only task does not authorize opening or merging a PR.

## Steps

### 1. Poll status

Query the GitHub Actions workflow run for the current commit HEAD:

```bash
node .agents/skills/pr-feedback-loop/scripts/inspect-ci.mjs
```

To monitor an in-flight run until completion, append `--watch` (default 15s polling interval):

```bash
node .agents/skills/pr-feedback-loop/scripts/inspect-ci.mjs --head --watch
```

If the helper script is unavailable, execute the direct Node one-liner fallback:

```bash
node -e "async function check(){const h={'User-Agent':'CI-Diagnostic-Agent'};const r=await(await fetch('https://api.github.com/repos/pminhtaiii/Flight-Booking-System/actions/runs?per_page=3',{headers:h})).json();if(!r.workflow_runs?.length){console.log('No runs found');return;}const run=r.workflow_runs[0];console.log('Run ID:',run.id,'| Status:',run.status,'| Conclusion:',run.conclusion,'| SHA:',run.head_sha);const j=await(await fetch(run.jobs_url,{headers:h})).json();for(const job of j.jobs||[]){console.log(' - Job:',job.name,'| Status:',job.status,'| Conclusion:',job.conclusion);for(const s of job.steps||[]){if(s.conclusion==='failure'){console.log('    --> [FAILED STEP #'+s.number+']:',s.name);}}}}check().catch(console.error);"
```

**Completion criterion**: The workflow run for the target commit (or latest run) is retrieved with Run ID, status, conclusion, and job list; if in progress, polling continues until conclusion is determined.

### 2. Harvest & Triage

Inspect the jobs and steps breakdown from Step 1. For every job with conclusion `failure`, harvest the failing step number and step name.

Map each failing step to its local reproduction command:

| Failing CI Job | Failing Step Pattern | Local Reproduction Command |
|---|---|---|
| `detect-changes` / `ci-status` | Contract / evaluate | `node --test tests/ci/ci-workflow.contract.test.mjs` |
| `api-gate` | Lint / shared types / typecheck | `pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings 0` && `pnpm --filter @shared/types test` && `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit` |
| `api-unit-tests` | Run API unit tests | `pnpm --filter @api/backend run test:ci` |
| `api-e2e-tests` | Run API E2E tests | `npm run test:e2e --workspace=apps/api` |
| `web-gate` | Lint / Route / Typecheck | `pnpm --filter @web/frontend lint` && `pnpm --filter @web/frontend typecheck` |
| `web-build` | Build web | `pnpm --filter @web/frontend build` |
| `agent-gate` | Ruff check / format | `uv run --package agent ruff check apps/agent` && `uv run --package agent ruff format --check apps/agent` |
| `agent-tests` | Agent tests | `uv run --package agent pytest apps/agent/tests -m "not redis_integration"` |
| `smoke-and-sanity` | Smoke & sanity run | `node scripts/ci/run-smoke-sanity.mjs --mode=ci` |
| `security-sast` | Run SAST scanner | `node scripts/security/run-sast.mjs --mode full --sarif-output artifacts/security/sast.json --strict-scanner` |
| `security-supply-chain` | Run supply chain check | `node scripts/security/run-supply-chain.mjs --output artifacts/security/supply-chain.json --strict` |

Reproduce the error locally using the mapped command, or inspect runner logs via GitHub web UI (`html_url`) if the failure is environment-specific.

**Completion criterion**: Every failing step number and name is identified, error output is extracted, and the mapped local reproduction command reproduces the failure or confirms the issue.

### 3. Remediate locally

Implement the code fix addressing the root cause identified during triage:

1. Apply the code modifications locally.
2. Re-run the local reproduction command from Step 2; confirm the check passes with exit code 0.
3. Run the full local domain validation gate for the affected domain to ensure no secondary regressions were introduced:
   - **API domain**: API Gate + API Unit Tests.
   - **Web domain**: Web Gate + Web Build.
   - **Agent domain**: Agent Gate + Agent pytest.
   - **CI / Shared domain**: Static Contract test (`node --test tests/ci/ci-workflow.contract.test.mjs`).

**Completion criterion**: The local reproducing command passes clean (exit code 0), and all associated local domain gate checks pass.

### 4. Push

Stage all changed files, commit with a descriptive message referencing the resolved CI step, and push to the remote branch:

```bash
git add <files>
git commit -m "fix(ci): resolve <job-name> <step-name> failure"
git push origin <branch>
```

**Completion criterion**: All remediated files are committed, working directory is clean, and HEAD is pushed to the remote branch.

### 5. Converge

Poll the newly triggered workflow run for the pushed HEAD commit:

```bash
node .agents/skills/pr-feedback-loop/scripts/inspect-ci.mjs --head --watch
```

This forms a **convergence loop** — repeat steps 1–5 if new or different steps fail.

**Circuit breaker rule**: If the same job and step fail with the same root cause after 1 remediation attempt, stop immediately, explain the persistent issue, and ask the user for guidance. Do not loop indefinitely.

**Completion criterion**: The remote workflow run for the pushed HEAD commit completes with conclusion `success` (`Verdict: CI PASSED`), or the circuit breaker halts execution after 1 failed retry.
