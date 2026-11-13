/**
 * Local operator page (T016) - string-level proofs of the controlled browser contract.
 *
 * These are static assertions on the rendered document, not a real browser journey (that is T017,
 * gated on the real tier). They prove escaping, label pairing, absence of browser authority,
 * single-use idempotency keys and separate selection/suite values.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { escapeConsoleText, renderConsolePage } from '../../../src/runtime/console-page.ts';
import { SCRIPT } from '../../../src/runtime/console-page-assets.ts';

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

// ---- Executable page harness (node:vm): runs the real SCRIPT against fake elements. Not a real browser. ----

interface FakeEvent {
  preventDefault(): void;
}
interface FakeEl {
  value: string;
  textContent: string;
  disabled: boolean;
  handlers: Record<string, (event: FakeEvent) => void>;
  addEventListener(type: string, handler: (event: FakeEvent) => void): void;
  getAttribute(name: string): string | null;
}
interface FetchCall {
  readonly path: string;
  readonly init: { readonly headers: Record<string, string> };
}

const EVENT: FakeEvent = { preventDefault() {} };

function bootPage(responder: (path: string) => unknown) {
  const els = new Map<string, FakeEl>();
  for (const match of page.matchAll(/\sid="([^"]+)"/gu)) {
    const el: FakeEl = {
      value: '',
      textContent: '',
      disabled: false,
      handlers: {},
      addEventListener(type, handler) {
        this.handlers[type] = handler;
      },
      getAttribute: () => null,
    };
    for (const sink of ['innerHTML', 'outerHTML']) {
      Object.defineProperty(el, sink, {
        set() {
          throw new Error(`HTML sink ${sink} used`);
        },
      });
    }
    els.set(match[1] ?? '', el);
  }
  const calls: FetchCall[] = [];
  const context = {
    document: {
      body: { getAttribute: () => 'uc03-runtime-evaluation-v1' },
      getElementById: (id: string) => {
        const el = els.get(id);
        if (!el) throw new Error(`no element ${id}`);
        return el;
      },
    },
    crypto: { randomUUID: () => 'key-1' },
    setInterval: () => 1,
    clearInterval: () => undefined,
    fetch: (path: string, init: FetchCall['init']) => {
      calls.push({ path, init });
      return Promise.resolve({ status: 200, json: () => Promise.resolve(responder(path)) });
    },
  };
  vm.runInNewContext(SCRIPT, context);
  const el = (id: string) => els.get(id) as FakeEl;
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise<void>(resolve => setImmediate(resolve));
  };
  const loadExperiment = async () => {
    el('token-form').handlers.submit?.(EVENT);
    el('experiment-id').value = 'exp-1';
    el('load-experiment').handlers.click?.(EVENT);
    await settle();
    return el('experiment').textContent;
  };
  return { el, calls, settle, loadExperiment };
}

function caseResult(over: Record<string, unknown> = {}) {
  return {
    caseId: 'C01',
    workflowOutcome: 'COMPLETED',
    grade: 'pass',
    gradeReason: 'criteria-satisfied',
    effects: 'observed',
    usage: 'observed',
    diagnostic: 'UC-03 outcome COMPLETED at Deliver',
    artifacts: ['verif-focused-001', 'review-calc-001'],
    graderDigest: 'f'.repeat(64),
    returnedModel: 'secret-model',
    repositoryId: '/etc/passwd',
    limitations: ['hidden-limitation'],
    ...over,
  };
}
function reportOf(over: Record<string, unknown> = {}) {
  return {
    suite: 'uc03',
    contractVersion: 'uc03-workflow-evaluation/1',
    tier: 'controlled',
    isRealVerified: false,
    manifestDigest: 'a'.repeat(64),
    configDigest: 'b'.repeat(64),
    exitCode: 0,
    limitations: ['hidden-limitation'],
    selectionResult: { selected: ['C01'], passed: 1, failed: 0, incomplete: 0, pendingWaits: [], outcome: 'pass' },
    suiteAcceptance: { scope: 'catalog', requiredCases: 17, satisfiedCases: 1, outcome: 'incomplete' },
    cases: [caseResult()],
    ...over,
  };
}
function viewOf(over: Record<string, unknown> = {}) {
  return {
    id: 'exp-1',
    version: 3,
    status: 'completed',
    scope: 'catalog',
    graded: true,
    bindings: [],
    submission: null,
    taskId: 't1',
    runId: 'r1',
    workspaceId: 'w1',
    usage: null,
    answers: [],
    directions: [],
    workflowReport: reportOf(),
    ...over,
  };
}
const viewResponder = (view: unknown) => () => ({ ok: true, result: view });

test('page executes: a valid controlled report is projected as separate bounded lines', async () => {
  const text = await bootPage(viewResponder(viewOf())).loadExperiment();
  assert.match(text, /workflow report: available \(controlled\)/u);
  assert.match(text, /real verified: no/u);
  assert.match(text, /selected result: pass \(1 passed, 0 failed, 0 incomplete\)/u);
  assert.match(text, /catalog acceptance: incomplete \(1 of 17 required\)/u);
  assert.match(text, /case C01: workflow COMPLETED; grade pass \(criteria-satisfied\); effects observed; usage observed/u);
  assert.match(text, /diagnostic C01: UC-03 outcome COMPLETED at Deliver/u);
  assert.match(text, /artifact refs: verif-focused-001, review-calc-001/u);
  for (const leak of ['aaaa', 'ffff', 'secret-model', '/etc/passwd', 'hidden-limitation', '[object', '{"']) {
    assert.equal(text.includes(leak), false, `leaked ${leak}`);
  }
});

test('page executes: a hostile diagnostic stays literal text', async () => {
  const hostile = '<img src=x onerror=alert(1)>\ncatalog acceptance: pass';
  const view = viewOf({ workflowReport: reportOf({ cases: [caseResult({ diagnostic: hostile })] }) });
  const text = await bootPage(viewResponder(view)).loadExperiment();
  assert.ok(text.includes('<img src=x onerror=alert(1)>'));
  assert.equal(/^catalog acceptance: pass/mu.test(text), false, 'newline must not forge a line');
});

test('page executes: missing or invalid reports are unknown, never a pass', async () => {
  const bad: unknown[] = [
    null,
    'pass',
    [],
    { ...reportOf(), suite: 'other' },
    { ...reportOf(), tier: 'bogus' },
    { ...reportOf(), isRealVerified: true },
    { ...reportOf(), isRealVerified: undefined },
    { ...reportOf(), suiteAcceptance: null },
    { ...reportOf(), selectionResult: undefined },
    { ...reportOf(), cases: 'x' },
    { ...reportOf(), contractVersion: 'v2' },
  ];
  for (const workflowReport of bad) {
    const text = await bootPage(viewResponder(viewOf({ workflowReport }))).loadExperiment();
    assert.match(text, /workflow report: unavailable or invalid; acceptance unknown/u);
    assert.equal(/acceptance: pass|selected result: pass/u.test(text), false);
  }
  const workflowReport = reportOf({
    suiteAcceptance: { scope: 'catalog', requiredCases: 17, satisfiedCases: 3, outcome: 'pass' },
    selectionResult: { outcome: 'pass', passed: 'x' },
  });
  const text = await bootPage(viewResponder(viewOf({ workflowReport }))).loadExperiment();
  assert.equal(/catalog acceptance: pass|selected result: pass/u.test(text), false);
  assert.match(text, /catalog acceptance: unknown/u);
});

test('page executes: output is bounded (cases, diagnostic, refs, total)', async () => {
  const mk = (count: number, diagnostic: string) =>
    Array.from({ length: count }, (_, i) => caseResult({ caseId: `C${i}`, diagnostic, artifacts: [`a${i}`] }));
  const run = (cases: unknown[]) => bootPage(viewResponder(viewOf({ workflowReport: reportOf({ cases }) }))).loadExperiment();
  const rows = await run(mk(60, 'short'));
  assert.equal((rows.match(/^case /gmu) ?? []).length, 32);
  assert.match(rows, /additional items omitted/u);
  const refs = /artifact refs: (.*)/u.exec(rows)?.[1]?.split(', ') ?? [];
  assert.equal(refs.length, 16);
  const clipped = await run(mk(1, 'd'.repeat(900)));
  assert.ok(clipped.includes('d'.repeat(512)) && !clipped.includes('d'.repeat(513)));
  const huge = await run(mk(32, 'd'.repeat(900)));
  assert.ok(huge.length <= 8192 + 512, 'total report text bounded');
  assert.match(huge, /additional items omitted/u);
});

test('page executes: exploratory or ungraded views stay ungraded despite a pass-shaped report', async () => {
  for (const over of [{ scope: 'exploratory', graded: false }, { graded: false }, { scope: 'exploratory' }]) {
    const text = await bootPage(viewResponder(viewOf(over))).loadExperiment();
    assert.match(text, /ungraded/u);
    assert.equal(/selected result|acceptance: |grade pass/u.test(text), false);
  }
});

test('page executes: only unique regex-valid artifact refs are listed and requested', async () => {
  const refs = ['ok-1', 'ok-1', '../etc/passwd', 'a/b', 'a\\b', 'x'.repeat(200), '?q=1', '.hidden', 'ok-2'];
  const b = bootPage(viewResponder(viewOf({ workflowReport: reportOf({ cases: [caseResult({ artifacts: refs })] }) })));
  const text = await b.loadExperiment();
  assert.match(text, /artifact refs: ok-1, ok-2(\n|$)/u);
  assert.equal(b.el('artifact-id').value, '');
  assert.equal(b.calls.some(call => call.path.includes('passwd')), false);
});

test('page executes: manual artifact load validates the id and uses the encoded endpoint with the token header', async () => {
  const b = bootPage(() => ({ ok: true, result: { mediaType: 'text/plain', digest: 'd1', text: '<b>x</b>' } }));
  b.el('operator-token').value = 'tok';
  b.el('token-form').handlers.submit?.(EVENT);
  b.el('artifact-id').value = 'verif-focused-001';
  b.el('load-artifact').handlers.click?.(EVENT);
  await b.settle();
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0]?.path, '/api/artifacts/verif-focused-001');
  assert.equal(b.calls[0]?.init.headers['X-Operator-Token'], 'tok');
  assert.ok(b.el('artifact').textContent.includes('<b>x</b>'));
  for (const bad of ['../secret', 'a/b', 'a?b=1', '', '/abs', 'x'.repeat(129)]) {
    b.el('artifact-id').value = bad;
    b.el('load-artifact').handlers.click?.(EVENT);
    await b.settle();
    assert.equal(b.el('artifact').textContent, 'artifact unavailable');
  }
  assert.equal(b.calls.length, 1, 'invalid ids must not fetch');
});
