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
  tagName: string;
  children: FakeEl[];
  parentNode: FakeEl | null;
  firstChild: FakeEl | null;
  handlers: Record<string, (event: FakeEvent) => void>;
  addEventListener(type: string, handler: (event: FakeEvent) => void): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeEl): void;
  insertBefore(child: FakeEl): void;
  removeChild(child: FakeEl): void;
}

/** Minimal element: `textContent` is a real text sink and also clears children on assignment. */
function fakeEl(tagName: string): FakeEl {
  let text = '';
  const el = {
    value: '',
    disabled: false,
    tagName,
    children: [] as FakeEl[],
    parentNode: null as FakeEl | null,
    handlers: {} as Record<string, (event: FakeEvent) => void>,
    addEventListener(type: string, handler: (event: FakeEvent) => void): void {
      el.handlers[type] = handler;
    },
    getAttribute(): string | null {
      return null;
    },
    appendChild(child: FakeEl): void {
      el.children.push(child);
      child.parentNode = el;
    },
    insertBefore(child: FakeEl): void {
      el.children.push(child);
      child.parentNode = el;
    },
    removeChild(child: FakeEl): void {
      const index = el.children.indexOf(child);
      if (index >= 0) el.children.splice(index, 1);
    },
  } as unknown as FakeEl;
  Object.defineProperty(el, 'textContent', {
    get: () => text,
    set: (v: string) => {
      text = String(v);
      el.children.length = 0;
    },
  });
  Object.defineProperty(el, 'firstChild', { get: () => el.children[0] ?? null });
  for (const sink of ['innerHTML', 'outerHTML']) {
    Object.defineProperty(el, sink, {
      set() {
        throw new Error(`HTML sink ${sink} used`);
      },
    });
  }
  return el;
}
interface FetchCall {
  readonly path: string;
  readonly init: { readonly headers: Record<string, string>; readonly body?: string | null };
}

const EVENT: FakeEvent = { preventDefault: () => undefined };

function bootPage(responder: (path: string) => unknown) {
  const els = new Map<string, FakeEl>();
  for (const match of page.matchAll(/\sid="([^"]+)"/gu)) {
    els.set(match[1] ?? '', fakeEl('div'));
  }
  const body = fakeEl('body');
  body.getAttribute = () => 'uc03-runtime-evaluation-v1';
  const calls: FetchCall[] = [];
  let seq = 0;
  let lost = false;
  const context = {
    document: {
      body,
      getElementById: (id: string) => {
        const el = els.get(id);
        if (!el) throw new Error(`no element ${id}`);
        return el;
      },
      createElement: (tag: string) => fakeEl(tag),
    },
    crypto: { randomUUID: () => `key-${(seq += 1)}` },
    setInterval: () => 1,
    clearInterval: () => undefined,
    fetch: (path: string, init: FetchCall['init']) => {
      calls.push({ path, init });
      if (lost) return Promise.reject(new Error('lost response'));
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
  /** Clarification groups the script appends to the document body. */
  const groups = () => body.children.filter(child => child.tagName === 'section');
  /** Simulates a committed request whose response never reaches the page. */
  const loseResponse = (value: boolean) => {
    lost = value;
  };
  return { el, body, calls, settle, loadExperiment, groups, loseResponse };
}

/** Concatenates textContent over a fake subtree, as a reader would see it. */
function textOf(el: FakeEl): string {
  return el.textContent + el.children.map(textOf).join('');
}

function textareasOf(el: FakeEl): FakeEl[] {
  return el.tagName === 'textarea' ? [el] : el.children.flatMap(textareasOf);
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
  const mk = (count: number, diagnostic: string) => Array.from({ length: count }, (_, i) => caseResult({ caseId: `C${i}`, diagnostic, artifacts: [`a${i}`] }));
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
  assert.equal(
    b.calls.some(call => call.path.includes('passwd')),
    false,
  );
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

const REPORT_LEAKS = ['aaaa', 'bbbb', 'ffff', 'secret-model', '/etc/passwd', 'hidden-limitation', 'limitations', 'returnedModel', 'repositoryId', 'graderDigest', 'workflowReport', 'outcome', '{'];

test('page executes: mutation responses show only a bounded receipt in the result pane', async () => {
  // isRealVerified: true makes the report invalid, so a raw "outcome": "pass" must not surface anywhere.
  const experiment = viewOf({ workflowReport: reportOf({ isRealVerified: true }) });
  const receipt = { receiptId: 'rcpt-1', kind: 'answer', idempotencyKey: 'key-1', experimentId: 'exp-1', version: 4, extra: '/etc/passwd' };
  for (const button of ['submit-experiment', 'submit-answer', 'submit-direction', 'submit-continue', 'submit-decision']) {
    const b = bootPage(() => ({ ok: true, result: { experiment, receipt } }));
    b.el('token-form').handlers.submit?.(EVENT);
    b.el('experiment-id').value = 'exp-1';
    b.el(button).handlers.click?.(EVENT);
    await b.settle();
    const result = b.el('result').textContent;
    assert.match(result, /^ok 200\nkind: answer\nreceiptId: rcpt-1\nexperimentId: exp-1\nversion: 4$/u, button);
    for (const leak of REPORT_LEAKS) assert.equal(result.includes(leak), false, `${button} leaked ${leak}`);
  }
  const b = bootPage(() => ({ ok: true, result: { verdict: 'improved', candidateAcceptance: { outcome: 'incomplete' }, baseline: reportOf() } }));
  b.el('submit-comparison').handlers.click?.(EVENT);
  await b.settle();
  assert.equal(b.el('result').textContent, 'ok 200');
  assert.equal(b.el('comparison-verdict').textContent, 'improved');
});

test('page executes: error codes in the result pane are opaque or UNKNOWN', async () => {
  for (const [error, shown] of [
    ['INVALID_EXPERIMENT_ID', 'INVALID_EXPERIMENT_ID'],
    ['/etc/passwd <b>', 'UNKNOWN'],
    [{ path: '/etc/passwd' }, 'UNKNOWN'],
  ] as const) {
    const b = bootPage(() => ({ ok: false, error }));
    b.el('submit-continue').handlers.click?.(EVENT);
    await b.settle();
    assert.equal(b.el('result').textContent, `error 200 ${shown}`);
  }
});

test('page executes: a diagnostic cannot forge a line or reorder text with Unicode controls', async () => {
  const diagnostic = 'x\u2028catalog acceptance: pass\u0085y\u2029z\u202Eq\u200Fr\u2066s\u009Bt';
  const text = await bootPage(viewResponder(viewOf({ workflowReport: reportOf({ cases: [caseResult({ diagnostic })] }) }))).loadExperiment();
  assert.equal(/[\u0080-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(text), false);
  assert.match(text, /diagnostic C01: x catalog acceptance: pass y z q r s t/u);
});

test('page executes: a selected pass with failed or incomplete cases is unknown', async () => {
  for (const counts of [
    { passed: 1, failed: 1, incomplete: 0 },
    { passed: 1, failed: 0, incomplete: 1 },
  ]) {
    const workflowReport = reportOf({ selectionResult: { selected: ['C01'], pendingWaits: [], outcome: 'pass', ...counts } });
    const text = await bootPage(viewResponder(viewOf({ workflowReport }))).loadExperiment();
    assert.match(text, /^selected result: unknown$/mu);
  }
});

/** UC-05 SafeResult (src/contracts/approvals/v01/types.ts:185) as returned by service-decision.ts:101-111. */
function safeResult(outcome: string, safeReasonCode: string, recorded: boolean) {
  return {
    schemaVersion: 'uc05-approval/0.1-draft',
    outcome,
    taskId: 't1',
    decisionId: 'decision-1',
    requestVersion: 1,
    controlVersion: 3,
    eventRef: recorded ? 'event-1' : null,
    safeNextAction: recorded ? 'none' : 'retry-read',
    safeReasonCode,
    raw: { path: '/etc/passwd' },
  };
}

test('page executes: decision outcomes are visible through an allowlist, and a refusal never reads as success', async () => {
  const cases: [unknown, RegExp][] = [
    [safeResult('ok', 'decision-recorded', true), /^ok 200\noutcome: ok\nsafeReasonCode: decision-recorded\ndecisionId: decision-1\ntaskId: t1\ncontrolVersion: 3\nsafeNextAction: none$/u],
    [safeResult('paused', 'decision-recorded', true), /^ok 200\noutcome: paused\n/u],
    [safeResult('stale', 'decision-not-recorded', false), /^not recorded 200 \(outcome stale\)\noutcome: stale\nsafeReasonCode: decision-not-recorded\n[\s\S]*safeNextAction: retry-read$/u],
    [safeResult('denied', 'decision-not-recorded', false), /^not recorded 200 \(outcome denied\)\noutcome: denied\n/u],
    [safeResult('<b>pass</b>', 'decision-recorded', true), /^not recorded 200 \(outcome unknown\)\n/u],
    [{ decision: 'approved' }, /^ok 200\ndecision: approved$/u],
  ];
  for (const [value, expected] of cases) {
    const b = bootPage(() => ({ ok: true, result: value }));
    b.el('experiment-id').value = 'exp-1';
    b.el('submit-decision').handlers.click?.(EVENT);
    await b.settle();
    const result = b.el('result').textContent;
    assert.match(result, expected, result);
    for (const leak of ['{', '/etc/passwd', 'schemaVersion', 'uc05-approval', 'event-1', 'requestVersion', '<b>']) assert.equal(result.includes(leak), false, `leaked ${leak}`);
  }
});

// ---- Graph clarification group (SP-01, host-composition §8: 1-16 questions) ----

/** A waiting-info catalog view with a generated graph clarification and no intake submission. */
function clarificationView(questions: { questionId: string; text: string }[]) {
  return viewOf({
    version: 7,
    status: 'waiting-info',
    submission: null,
    workflowClarification: { questionId: 'gq-group-1', questionDigest: 'a'.repeat(64), questions },
  });
}

test('page executes: a paused graph clarification shows its question text', async () => {
  const b = bootPage(viewResponder(clarificationView([{ questionId: 'gq-1', text: 'Which module owns retries?' }])));
  await b.loadExperiment();
  const group = b.groups().find(section => /Which module owns retries\?/u.test(textOf(section)));
  assert.ok(group, 'clarification group with the question text was rendered');
  // The group id and digest are shown so the operator can bind the answer request to them.
  assert.match(textOf(group), /gq-group-1/u);
  assert.match(textOf(group), new RegExp('a'.repeat(64), 'u'));
});

test('page executes: several questions submit one answer per question in order with the group binding', async () => {
  const questions = [
    { questionId: 'gq-1', text: 'Which module owns retries?' },
    { questionId: 'gq-2', text: 'What is the retry ceiling?' },
    { questionId: 'gq-3', text: 'Which test proves it?' },
  ];
  const view = clarificationView(questions);
  const b = bootPage(path =>
    path.endsWith('/answers')
      ? { ok: true, result: { experiment: view, receipt: { receiptId: 'rcpt-1', kind: 'answer', idempotencyKey: 'key-1', experimentId: 'exp-1', version: 8 } } }
      : { ok: true, result: view },
  );
  await b.loadExperiment();
  const group = b.groups().find(section => /Which module owns retries\?/u.test(textOf(section)));
  assert.ok(group);
  const inputs = textareasOf(group);
  assert.equal(inputs.length, 3, 'one input per question');
  inputs.forEach((input, index) => {
    input.value = `answer-${index + 1}`;
  });
  const button = group.children.find(child => child.tagName === 'button');
  assert.ok(button, 'explicit submit control');
  button.handlers.click?.(EVENT);
  await b.settle();
  const call = b.calls.find(item => item.path === '/api/experiments/exp-1/answers');
  assert.ok(call, 'answer request sent');
  const body = JSON.parse(call.init.body ?? '{}') as Record<string, unknown>;
  // Service shape: one group id/digest, expectedVersion, and one answer per question in order.
  assert.equal(body['questionId'], 'gq-group-1');
  assert.equal(body['questionDigest'], 'a'.repeat(64));
  assert.equal(body['expectedVersion'], 7);
  assert.deepEqual(body['answers'], ['answer-1', 'answer-2', 'answer-3']);
  assert.equal(typeof body['idempotencyKey'], 'string');
});

test('page executes: hostile clarification text is shown as sanitized text only', async () => {
  const hostile = '<img src=x onerror=alert(1)>\u202eevil\u2028control';
  const b = bootPage(viewResponder(clarificationView([{ questionId: 'gq-1', text: hostile }])));
  await b.loadExperiment();
  const group = b.groups().find(section => /alert\(1\)/u.test(textOf(section)));
  assert.ok(group, 'the hostile question reaches the page');
  const text = textOf(group);
  assert.ok(text.includes('<img src=x onerror=alert(1)>'), 'markup stays literal text');
  assert.equal(/[\u0080-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(text), false, 'no raw bidi/control characters');
});

/** Clicks the rendered group's submit control and returns the request body it sent, if any. */
async function submitGroup(b: ReturnType<typeof bootPage>, text: RegExp) {
  const group = b.groups().find(section => text.test(textOf(section)));
  assert.ok(group, 'clarification group rendered');
  textareasOf(group).forEach((input, index) => {
    input.value = `answer-${index + 1}`;
  });
  const before = b.calls.length;
  group.children.find(child => child.tagName === 'button')?.handlers.click?.(EVENT);
  await b.settle();
  const call = b.calls.slice(before).find(item => item.path.endsWith('/answers'));
  return { group, call, body: call ? (JSON.parse(call.init.body ?? '{}') as Record<string, unknown>) : null };
}

test('page executes: an uncertain retry of the same unanswered group reuses its key and payload', async () => {
  const view = clarificationView([{ questionId: 'gq-1', text: 'Which module owns retries?' }]);
  const b = bootPage(viewResponder(view));
  await b.loadExperiment();

  // The first submit never reaches a response, so the key is retained for a safe retry.
  b.loseResponse(true);
  const first = await submitGroup(b, /Which module owns retries\?/u);
  assert.ok(first.call, 'first submit sent');
  b.loseResponse(false);

  // A poll shows the same group still unanswered: the retry must replay the identical request.
  const before = b.calls.length;
  await b.loadExperiment();
  assert.equal(b.calls.length, before + 1, 'the reload itself did not submit');
  const retry = await submitGroup(b, /Which module owns retries\?/u);
  assert.ok(retry.body, 'retry sent');
  assert.equal(retry.body['idempotencyKey'], first.body?.['idempotencyKey'], 'identical retry reuses the key');
  assert.equal(retry.body['questionId'], first.body?.['questionId']);
  assert.equal(retry.body['questionDigest'], first.body?.['questionDigest']);
  assert.equal(retry.body['expectedVersion'], first.body?.['expectedVersion']);
  assert.deepEqual(retry.body['answers'], first.body?.['answers']);
});

test('page executes: a retry after an edit replays the submitted answers with the retained key', async () => {
  const view = clarificationView([{ questionId: 'gq-1', text: 'Which module owns retries?' }]);
  const b = bootPage(viewResponder(view));
  await b.loadExperiment();

  // The server may have recorded the answer; only the response was lost.
  b.loseResponse(true);
  const first = await submitGroup(b, /Which module owns retries\?/u);
  assert.ok(first.body, 'first submit sent');
  b.loseResponse(false);

  // The operator edits an answer before retrying; the service fingerprints answers, so an edited
  // payload under the same key would be refused as a conflicting replay.
  await b.loadExperiment();
  const group = b.groups().find(section => /Which module owns retries\?/u.test(textOf(section)));
  assert.ok(group, 'clarification group rendered');
  textareasOf(group).forEach(input => {
    input.value = 'edited after the lost response';
  });
  const before = b.calls.length;
  group.children.find(child => child.tagName === 'button')?.handlers.click?.(EVENT);
  await b.settle();
  const call = b.calls.slice(before).find(item => item.path.endsWith('/answers'));
  assert.ok(call, 'retry sent');
  const body = JSON.parse(call.init.body ?? '{}') as Record<string, unknown>;
  assert.equal(body['idempotencyKey'], first.body?.['idempotencyKey'], 'retry reuses the key');
  assert.deepEqual(body['answers'], first.body?.['answers'], 'retry replays the submitted answers');
  assert.equal((body['answers'] as unknown[])[0], 'answer-1');
});

test('page executes: a pending group A response leaves group B controls and its key intact', async () => {
  const viewA = clarificationView([{ questionId: 'gq-1', text: 'Which module owns retries?' }]);
  const viewB = viewOf({
    id: 'exp-2',
    version: 5,
    status: 'waiting-info',
    workflowClarification: { questionId: 'gq-group-2', questionDigest: 'b'.repeat(64), questions: [{ questionId: 'gq-9', text: 'Which test proves it?' }] },
  });
  let release!: (value: unknown) => void;
  const held = new Promise<unknown>(resolve => {
    release = resolve;
  });
  let answerCalls = 0;
  const b = bootPage(path => {
    if (!path.endsWith('/answers')) return { ok: true, result: path.includes('exp-2') ? viewB : viewA };
    answerCalls += 1;
    return answerCalls === 1 ? held : { ok: true, result: viewB };
  });

  // Group A's request is in flight and unanswered.
  await b.loadExperiment();
  const a = await submitGroup(b, /Which module owns retries\?/u);
  assert.ok(a.call, 'group A request sent');

  // The operator loads another experiment and submits its group B, whose response is also lost.
  b.el('experiment-id').value = 'exp-2';
  b.el('load-experiment').handlers.click?.(EVENT);
  await b.settle();
  b.loseResponse(true);
  const firstB = await submitGroup(b, /Which test proves it\?/u);
  assert.ok(firstB.body, 'group B request sent');
  b.loseResponse(false);

  // Group A's late 200 must not remove B's controls or release B's pending key.
  release({ ok: true, result: { experiment: viewA, receipt: { receiptId: 'rcpt-a', kind: 'answer', idempotencyKey: 'key-a', experimentId: 'exp-1', version: 8 } } });
  await b.settle();
  assert.ok(
    b.groups().some(section => /Which test proves it\?/u.test(textOf(section))),
    'group B controls survive',
  );
  const retryB = await submitGroup(b, /Which test proves it\?/u);
  assert.equal(retryB.body?.['idempotencyKey'], firstB.body?.['idempotencyKey'], 'group B keeps its pending key');
});

test('page executes: a key retained past an answered group is retired, so a later group submits a fresh one', async () => {
  let view: unknown = clarificationView([{ questionId: 'gq-1', text: 'Which module owns retries?' }]);
  const b = bootPage(() => ({ ok: true, result: view }));
  await b.loadExperiment();

  // The first submit commits on the server, but the response is lost and the key is retained.
  b.loseResponse(true);
  const first = await submitGroup(b, /Which module owns retries\?/u);
  assert.ok(first.call, 'first submit sent');
  b.loseResponse(false);

  // The authoritative view shows that group answered: its controls go away, and its key must go with them.
  view = viewOf({
    version: 8,
    status: 'running',
    answers: [{ questionId: 'gq-group-1', questionDigest: 'a'.repeat(64), answers: ['answer-1'], recordedAt: 'now' }],
  });
  await b.loadExperiment();
  assert.equal(b.groups().length, 0, 'answered group controls are removed');

  // A different group must not replay the retired key with a different question/digest/version:
  // the service would answer CONFLICTING_REPLAY and the operator could never answer again.
  view = viewOf({
    version: 9,
    status: 'waiting-info',
    workflowClarification: { questionId: 'gq-group-2', questionDigest: 'b'.repeat(64), questions: [{ questionId: 'gq-9', text: 'Which test proves it?' }] },
  });
  await b.loadExperiment();
  const next = await submitGroup(b, /Which test proves it\?/u);
  assert.ok(next.body, 'new group sent');
  assert.notEqual(next.body['idempotencyKey'], first.body?.['idempotencyKey'], 'answered group key is retired');
  assert.equal(next.body['questionId'], 'gq-group-2');
  assert.equal(next.body['questionDigest'], 'b'.repeat(64));
  assert.equal(next.body['expectedVersion'], 9);
  assert.deepEqual(next.body['answers'], ['answer-1']);
});
