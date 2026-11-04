/**
 * Local operator page for the runtime-evaluation console (T016).
 *
 * A self-contained HTML+CSS+JS document served only over the loopback console. It holds no
 * authority: the only mutable inputs are the profile-pinned case/bug text and opaque ids/keys.
 * All dynamic text is written through `textContent`, so a payload in an experiment or diagnostic
 * string cannot become markup.
 */

import { SCRIPT, STYLE } from './console-page-assets.ts';

const PROFILE_ID = 'uc03-runtime-evaluation-v1';

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escapes text for any server-rendered interpolation; the client renders via textContent. */
export function escapeConsoleText(value: string): string {
  return value.replace(/[&<>"']/gu, char => ESCAPES[char] ?? char);
}

const ROUTE_LEGEND: readonly string[] = [
  'POST /api/experiments - catalog case set or typed public bug',
  'GET /api/experiments/:id - attempt, version, milestones, grade',
  'GET /api/experiments/:id/approval - UC-05 safe presentation',
  'POST /api/experiments/:id/decision - explicit approve/reject',
  'POST /api/experiments/:id/answers - bounded reporter answers (never resumes)',
  'POST /api/experiments/:id/directions - explicit resume/revise/end',
  'POST /api/experiments/:id/continue - consume a direction receipt',
  'GET /api/artifacts/:opaqueId - bounded allowlisted evidence',
  'POST /api/comparisons - read-only stored-attempt comparison',
];

/** Returns the operator page. The token is entered in-page and never appears in a URL or the markup. */
export function renderConsolePage(): string {
  const legend = ROUTE_LEGEND.map(route => `<li>${escapeConsoleText(route)}</li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UC-03 Evaluation Console</title>
<style>${STYLE}</style>
</head>
<body data-profile="${escapeConsoleText(PROFILE_ID)}">
<header>
<h1>UC-03 Evaluation Console</h1>
<p class="hint">Local loopback operator page. The token stays in this page's memory; requests carry it in a header, never in a URL.</p>
</header>

<section aria-labelledby="session-heading">
<h2 id="session-heading">Operator session</h2>
<form id="token-form">
<label for="operator-token">Operator token <span class="hint">(host-issued, entered locally)</span></label>
<input id="operator-token" type="password" autocomplete="off" spellcheck="false" required>
<button type="submit" id="use-token">Use token</button>
</form>
<p id="token-state" role="status">no token</p>
</section>

<section aria-labelledby="catalog-heading">
<h2 id="catalog-heading">Configured catalog</h2>
<p class="hint">Readiness only; fixture and grader paths are never exposed.</p>
<button type="button" id="load-catalog">Refresh catalog</button>
<pre id="catalog" tabindex="0">not loaded</pre>
</section>

<section aria-labelledby="start-heading">
<h2 id="start-heading">Start experiment</h2>
<label for="source-kind">Source kind</label>
<select id="source-kind">
<option value="catalog">Prepared catalog case set</option>
<option value="bug">Typed public bug</option>
</select>
<label for="case-ids">Catalog case ids <span class="hint">(one per line)</span></label>
<textarea id="case-ids" spellcheck="false">case-001</textarea>
<label for="repository-id">Configured repository id <span class="hint">(host-configured id, not a path)</span></label>
<input id="repository-id" type="text" spellcheck="false">
<label for="check-set-id">Configured check set id</label>
<input id="check-set-id" type="text" spellcheck="false">
<fieldset>
<legend>Public bug report</legend>
<label for="bug-goal">Goal</label>
<textarea id="bug-goal"></textarea>
<label for="bug-observed">Observed behavior</label>
<textarea id="bug-observed"></textarea>
<label for="bug-expected">Expected behavior</label>
<textarea id="bug-expected"></textarea>
<label for="bug-reproduction">Reproduction steps</label>
<textarea id="bug-reproduction"></textarea>
<label for="bug-acceptance">Acceptance criteria <span class="hint">(one per line)</span></label>
<textarea id="bug-acceptance"></textarea>
</fieldset>
<button type="button" id="submit-experiment">Start experiment</button>
<pre id="result" tabindex="0" role="status" aria-live="polite">no result</pre>
</section>

<section aria-labelledby="experiment-heading">
<h2 id="experiment-heading">Experiment state</h2>
<label for="experiment-id">Experiment id</label>
<input id="experiment-id" type="text" spellcheck="false" autocomplete="off">
<button type="button" id="load-experiment">Load</button>
<button type="button" id="toggle-poll">Toggle polling</button>
<span id="poll-state" role="status">paused</span>
<pre id="experiment" tabindex="0">not loaded</pre>
</section>

<section aria-labelledby="approval-heading">
<h2 id="approval-heading">UC-05 approval</h2>
<p class="hint">The presentation below is the owner's; this page never reconstructs it.</p>
<button type="button" id="load-approval">Load current presentation</button>
<pre id="approval" tabindex="0">not loaded</pre>
<label for="decision-choice">Decision</label>
<select id="decision-choice">
<option value="approve">Approve</option>
<option value="reject">Reject</option>
</select>
<label for="decision-version">Current presentation version</label>
<input id="decision-version" type="number" min="0" step="1" value="0">
<label for="decision-digest">Current presentation digest</label>
<input id="decision-digest" type="text" spellcheck="false" autocomplete="off">
<button type="button" id="submit-decision">Record decision</button>
</section>

<section aria-labelledby="answer-heading">
<h2 id="answer-heading">Reporter answers</h2>
<p class="hint">Answers are recorded against the bound question. They never approve, resume or continue.</p>
<label for="answer-question">Question id</label>
<input id="answer-question" type="text" spellcheck="false" autocomplete="off">
<label for="answer-digest">Question digest</label>
<input id="answer-digest" type="text" spellcheck="false" autocomplete="off">
<label for="answer-version">Current experiment version</label>
<input id="answer-version" type="number" min="0" step="1" value="0">
<label for="answer-text">Answer <span class="hint">(bounded reporter text)</span></label>
<textarea id="answer-text"></textarea>
<button type="button" id="submit-answer">Submit answer</button>
</section>

<section aria-labelledby="direction-heading">
<h2 id="direction-heading">Explicit direction</h2>
<label for="direction-kind">Direction</label>
<select id="direction-kind">
<option value="resume">Resume</option>
<option value="revise">Revise</option>
<option value="end">End</option>
</select>
<label for="direction-task-version">Expected task version</label>
<input id="direction-task-version" type="number" min="0" step="1" value="0">
<label for="direction-control-version">Expected control version</label>
<input id="direction-control-version" type="number" min="0" step="1" value="0">
<label for="direction-decision-ref">Decision reference <span class="hint">(optional)</span></label>
<input id="direction-decision-ref" type="text" spellcheck="false" autocomplete="off">
<label for="direction-feedback">Revision feedback <span class="hint">(optional reporter input)</span></label>
<textarea id="direction-feedback"></textarea>
<button type="button" id="submit-direction">Issue direction</button>
</section>

<section aria-labelledby="continue-heading">
<h2 id="continue-heading">Continue</h2>
<label for="continue-direction-ref">Direction receipt reference</label>
<input id="continue-direction-ref" type="text" spellcheck="false" autocomplete="off">
<label for="continue-version">Current experiment version</label>
<input id="continue-version" type="number" min="0" step="1" value="0">
<button type="button" id="submit-continue">Continue experiment</button>
</section>

<section aria-labelledby="artifact-heading">
<h2 id="artifact-heading">Artifact</h2>
<label for="artifact-id">Opaque artifact id</label>
<input id="artifact-id" type="text" spellcheck="false" autocomplete="off">
<button type="button" id="load-artifact">Load artifact</button>
<pre id="artifact" tabindex="0">not loaded</pre>
</section>

<section aria-labelledby="comparison-heading">
<h2 id="comparison-heading">Comparison</h2>
<label for="compare-baseline">Baseline attempt id</label>
<input id="compare-baseline" type="text" spellcheck="false" autocomplete="off">
<label for="compare-candidate">Candidate attempt id</label>
<input id="compare-candidate" type="text" spellcheck="false" autocomplete="off">
<label for="compare-policy">Comparison policy</label>
<select id="compare-policy">
<option value="guarded">Guarded (refuse incompatible attempts)</option>
<option value="strict">Strict same-configuration</option>
</select>
<button type="button" id="submit-comparison">Compare</button>
<dl>
<dt>Comparison verdict</dt><dd id="comparison-verdict">not compared</dd>
<dt>Candidate suite acceptance</dt><dd id="comparison-acceptance">not compared</dd>
</dl>
</section>

<section aria-labelledby="routes-heading">
<h2 id="routes-heading">Routes</h2>
<ul>${legend}</ul>
</section>

<script>${SCRIPT}</script>
</body>
</html>
`;
}
