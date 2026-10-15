#!/usr/bin/env node
/**
 * GitHub Actions CI Inspector
 * Inspects workflow runs, jobs, and step failures for pminhtaiii/Flight-Booking-System.
 */

import { execSync } from 'node:child_process';
import process from 'node:process';

const DEFAULT_REPO = 'pminhtaiii/Flight-Booking-System';
const DEFAULT_INTERVAL_SEC = 15;

function parseArgs(args) {
  const options = {
    repo: DEFAULT_REPO,
    interval: DEFAULT_INTERVAL_SEC,
    watch: false,
    head: false,
    latest: false,
    sha: null,
    runId: null,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--watch' || arg === '--poll' || arg === '-w') {
      options.watch = true;
    } else if (arg === '--interval' || arg === '-i') {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val) && val > 0) {
        options.interval = val;
      }
    } else if (arg === '--head') {
      options.head = true;
    } else if (arg === '--latest') {
      options.latest = true;
    } else if (arg === '--sha' || arg === '-s') {
      options.sha = args[++i];
    } else if (arg === '--run-id' || arg === '-r') {
      options.runId = args[++i];
    } else if (arg === '--repo') {
      options.repo = args[++i];
    }
  }

  return options;
}

function printUsage() {
  console.log(`Usage: node inspect-ci.mjs [options]

Options:
  --head              Check the CI run matching local git HEAD commit
  --latest            Check the latest CI run regardless of commit
  --sha <commit-sha>  Check the CI run for a specific commit SHA
  --run-id <id>       Inspect a specific GitHub Actions workflow run ID
  --watch, --poll     Poll and wait until the run finishes (default interval: 15s)
  --interval <sec>    Polling interval in seconds when watching (default: 15)
  --repo <owner/repo> GitHub repository (default: ${DEFAULT_REPO})
  --help, -h          Show this help message
`);
}

function getLocalHeadSha() {
  try {
    return execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function getAuthHeaders() {
  const headers = {
    'User-Agent': 'CI-Diagnostic-Agent',
    Accept: 'application/vnd.github+json',
  };
  let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    try {
      token = execSync('gh auth token', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // gh CLI not available or not logged in
    }
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function formatDuration(ms) {
  if (ms <= 0 || isNaN(ms)) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${seconds}s`;
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m ${seconds}s`;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: getAuthHeaders() });
    if (!res.ok) {
      let message = res.statusText;
      try {
        const errJson = await res.json();
        if (errJson.message) message = errJson.message;
      } catch {
        // use statusText fallback
      }
      if (res.status === 403 && message.toLowerCase().includes('rate limit')) {
        throw new Error(`GitHub API rate limit exceeded. Set GITHUB_TOKEN or GH_TOKEN to increase limits.`);
      }
      throw new Error(`GitHub API returned HTTP ${res.status}: ${message}`);
    }
    return await res.json();
  } catch (err) {
    if (err.cause?.code || err.code) {
      throw new Error(`Network failure connecting to GitHub API (${err.cause?.code || err.code}): ${err.message}`);
    }
    throw err;
  }
}

async function findRun(options, headSha) {
  const base = `https://api.github.com/repos/${options.repo}/actions`;

  if (options.runId) {
    const run = await fetchJson(`${base}/runs/${options.runId}`);
    return { run, source: `Run ID ${options.runId}` };
  }

  const targetSha = options.sha || (options.head ? headSha : null);

  if (targetSha) {
    const data = await fetchJson(`${base}/runs?head_sha=${targetSha}&per_page=5`);
    if (data.workflow_runs && data.workflow_runs.length > 0) {
      return { run: data.workflow_runs[0], source: `commit ${targetSha.slice(0, 7)}` };
    }
    if (options.sha || options.head) {
      return { run: null, source: `commit ${targetSha}` };
    }
  }

  // Default behavior or --latest: if headSha is detected and no explicit flag, try HEAD first
  if (!options.latest && headSha && !targetSha) {
    const data = await fetchJson(`${base}/runs?head_sha=${headSha}&per_page=5`);
    if (data.workflow_runs && data.workflow_runs.length > 0) {
      return { run: data.workflow_runs[0], source: `git HEAD (${headSha.slice(0, 7)})` };
    }
  }

  // Fallback to latest run
  const data = await fetchJson(`${base}/runs?per_page=5`);
  if (!data.workflow_runs || data.workflow_runs.length === 0) {
    return { run: null, source: 'latest runs' };
  }

  return { run: data.workflow_runs[0], source: 'latest repository run' };
}

function displayRunDetails(run, jobs) {
  const startTime = new Date(run.run_started_at || run.created_at).getTime();
  const endTime = run.status === 'completed'
    ? new Date(run.updated_at).getTime()
    : Date.now();
  const duration = formatDuration(endTime - startTime);

  console.log('\n=============================================================');
  console.log(` Workflow:    ${run.name || 'CI'}`);
  console.log(` Run ID:      ${run.id}`);
  console.log(` Status:      ${run.status}`);
  console.log(` Conclusion:  ${run.conclusion || '(in progress)'}`);
  console.log(` Branch:      ${run.head_branch || '(unknown)'}`);
  console.log(` Commit SHA:  ${run.head_sha}`);
  console.log(` Duration:    ${duration}`);
  console.log(` URL:         ${run.html_url}`);
  console.log('=============================================================\n');

  if (!jobs || jobs.length === 0) {
    console.log('No jobs found or jobs have not started yet.\n');
    return;
  }

  console.log('Jobs & Steps Breakdown:');
  let hasFailedSteps = false;

  for (const job of jobs) {
    const jobStatus = job.conclusion ? job.conclusion.toUpperCase() : job.status.toUpperCase();
    const icon = job.conclusion === 'success' ? '✔' : job.conclusion === 'failure' ? '✖' : '●';
    console.log(`  ${icon} [${jobStatus}] ${job.name}`);

    for (const step of job.steps || []) {
      if (step.conclusion === 'failure') {
        hasFailedSteps = true;
        console.log(`       --> [FAILED STEP #${step.number}]: ${step.name}`);
      } else if (step.status === 'in_progress') {
        console.log(`       --> [IN PROGRESS STEP #${step.number}]: ${step.name}`);
      }
    }
  }

  console.log('');
  if (run.status === 'completed') {
    if (run.conclusion === 'success') {
      console.log('Verdict: CI PASSED ✔');
    } else {
      console.log(`Verdict: CI ${run.conclusion ? run.conclusion.toUpperCase() : 'FAILED'} ✖`);
    }
  } else {
    console.log(`Verdict: CI IS IN PROGRESS (${run.status}) ●`);
  }
}

async function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  const headSha = getLocalHeadSha();

  try {
    let { run, source } = await findRun(options, headSha);

    if (!run) {
      console.log(`No workflow runs found for ${source}.`);
      return;
    }

    let jobsData = await fetchJson(`${run.jobs_url}?per_page=100`);
    let jobs = jobsData.jobs || [];

    displayRunDetails(run, jobs);

    if (options.watch && run.status !== 'completed') {
      console.log(`\nWatching run ${run.id}. Polling every ${options.interval}s... (Press Ctrl+C to stop)`);
      while (run.status !== 'completed') {
        await sleep(options.interval);
        try {
          run = await fetchJson(`https://api.github.com/repos/${options.repo}/actions/runs/${run.id}`);
          jobsData = await fetchJson(`${run.jobs_url}?per_page=100`);
          jobs = jobsData.jobs || [];
          const nowStr = new Date().toISOString().slice(11, 19);
          console.log(`[${nowStr}] Status: ${run.status}, Conclusion: ${run.conclusion || 'pending'}`);
        } catch (pollErr) {
          console.warn(`Polling warning: ${pollErr.message}`);
        }
      }

      console.log('\nRun finished!');
      displayRunDetails(run, jobs);
    }

    if (run.status === 'completed' && run.conclusion !== 'success') {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
