/**
 * Local operator page (T016) - string-level proofs of the controlled browser contract.
 *
 * These are static assertions on the rendered document, not a real browser journey (that is T017,
 * gated on the real tier). They prove escaping, label pairing, absence of browser authority,
 * single-use idempotency keys and separate selection/suite values.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeConsoleText, renderConsolePage } from '../../../src/runtime/console-page.ts';

const page = renderConsolePage();

/** Every `id` the script reaches, so a missing or renamed control fails here rather than in a browser. */
const CONTROL_IDS = [
  'operator-token',
  'token-form',
  'token-state',
  'load-catalog',
  'catalog',
  'source-kind',
  'case-ids',
  'repository-id',
  'check-set-id',
  'bug-goal',
  'bug-observed',
  'bug-expected',
  'bug-reproduction',
  'bug-acceptance',
  'submit-experiment',
  'result',
  'experiment-id',
  'load-experiment',
  'toggle-poll',
  'poll-state',
  'experiment',
  'load-approval',
  'approval',
  'decision-choice',
  'decision-version',
  'decision-digest',
  'submit-decision',
  'answer-question',
  'answer-digest',
  'answer-version',
  'answer-text',
  'submit-answer',
  'direction-kind',
  'direction-task-version',
  'direction-control-version',
  'direction-decision-ref',
  'direction-feedback',
  'submit-direction',
  'continue-direction-ref',
  'continue-version',
  'submit-continue',
  'artifact-id',
  'load-artifact',
  'artifact',
  'compare-baseline',
  'compare-candidate',
  'compare-policy',
  'submit-comparison',
  'comparison-verdict',
  'comparison-acceptance',
];

test('escaping neutralises script, quote and apostrophe payloads', () => {
  const payload = `<script>alert("x")</script>' onmouseover='y'`;
  const escaped = escapeConsoleText(payload);
  assert.equal(escaped, '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39; onmouseover=&#39;y&#39;');
  assert.equal(escapeConsoleText('&'), '&amp;');
  assert.equal(escapeConsoleText('>'), '&gt;');
  // The page itself carries no unescaped interpolation point for dynamic text.
  assert.equal(page.includes('<script>alert'), false);
});

test('the page and script contain no dynamic HTML sink', () => {
  assert.equal(page.includes('innerHTML'), false);
  assert.equal(page.includes('outerHTML'), false);
  assert.equal(page.includes('insertAdjacentHTML'), false);
  assert.equal(page.includes('document.write'), false);
  assert.equal(page.includes('eval('), false);
});

test('every interactive control is present and labelled with a matching for/id pair', () => {
  const ids = [...page.matchAll(/\sid="([^"]+)"/gu)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate element id');
  const forIds = new Set([...page.matchAll(/<label for="([^"]+)"/gu)].map(match => match[1]));
  const controls = /<(input|select|textarea|button)\s[^>]*\sid="([^"]+)"/gu;
  for (const match of page.matchAll(controls)) {
    const tag = match[1];
    const id = match[2];
    assert.ok(id !== undefined, 'control without id');
    if (tag === 'button') continue;
    assert.ok(forIds.has(id), `${tag}#${id} has no <label for=>`);
  }
  // Buttons are named by their text, and the token field is a labelled password input.
  assert.ok(page.includes('<input id="operator-token" type="password"'));
  assert.ok(page.includes('autocomplete="off"'));
  for (const id of CONTROL_IDS) assert.ok(page.includes(`id="${id}"`), `missing control ${id}`);
});

test('no script or style reaches the network and no external resource is referenced', () => {
  assert.equal(/<script[^>]+src=/iu.test(page), false);
  assert.equal(/<link[^>]+href=/iu.test(page), false);
  assert.equal(/https?:\/\//iu.test(page), false);
  assert.equal(/@import/iu.test(page), false);
});

test('no browser authority: no input can set config, pricing, limits, model or a path', () => {
  const forbidden = [
    'pricing',
    'price',
    'limit',
    'model',
    'endpoint',
    'credential',
    'api-key',
    'apikey',
    'fixture',
    'grader-path',
    'repository-path',
    'working-directory',
    'executable',
    'shell',
    'config-digest',
  ];
  const inputs = [...page.matchAll(/<(?:input|textarea|select)\s[^>]*id="([^"]+)"/gu)].map(match => match[1] ?? '');
  for (const id of inputs) {
    for (const word of forbidden) assert.equal(id.toLowerCase().includes(word), false, `input #${id} looks like authority (${word})`);
  }
  // The only identifiers the page can send are profile, case, bug text and opaque keys/digests.
  assert.equal(page.includes('data-profile="uc03-runtime-evaluation-v1"'), true);
});

test('decisions, answers and directions are explicit labelled operator actions', () => {
  assert.ok(page.includes('<label for="decision-choice">Decision</label>'));
  assert.ok(page.includes('<option value="approve">Approve</option>') && page.includes('<option value="reject">Reject</option>'));
  assert.ok(page.includes('<label for="direction-kind">Direction</label>'));
  for (const kind of ['resume', 'revise', 'end']) assert.ok(page.includes(`<option value="${kind}">`), `missing direction ${kind}`);
  assert.ok(page.includes('They never approve, resume or continue.'));
  // No click-only handlers: interaction is bound with addEventListener on real controls.
  assert.equal(/\son(click|change|submit|input|keydown)=/iu.test(page), false);
});

test('mutations carry one retained idempotency key and disable the control', () => {
  assert.ok(page.includes('function freshKey()'));
  assert.ok(page.includes('if (button.disabled) return null;'));
  assert.ok(page.includes('if (!keys[slot]) keys[slot] = freshKey();'));
  assert.ok(page.includes('button.disabled = true;'));
  assert.equal((page.match(/crypto\.randomUUID\(\)/gu) ?? []).length, 1);
  // The token travels in a header, never in a URL or query string.
  assert.ok(page.includes("'X-Operator-Token': token"));
  assert.equal(/[?&]token=/iu.test(page), false);
});

test('verdict and candidate acceptance are distinct labelled values, never merged', () => {
  assert.ok(page.includes('<dt>Comparison verdict</dt><dd id="comparison-verdict">'));
  assert.ok(page.includes('<dt>Candidate suite acceptance</dt><dd id="comparison-acceptance">'));
  assert.ok(page.includes("show('comparison-verdict'"));
  assert.ok(page.includes("show('comparison-acceptance'"));
  // Reads fields a real WorkflowComparisonReport actually carries, not invented ones.
  assert.ok(page.includes('out.data.result.verdict'));
  assert.ok(page.includes('out.data.result.candidateAcceptance'));
  assert.equal(page.includes('selectionOutcome'), false);
  assert.equal(page.includes('suiteOutcome'), false);
});

test('polling is bounded to at most once per second', () => {
  assert.ok(/setInterval\(function \(\) \{[\s\S]*?\}, 1000\)/u.test(page));
  assert.equal(/setInterval\([^)]*,\s*(?:[0-9]|[0-9]{2}|[0-9]{3})\)/u.test(page), false);
});
