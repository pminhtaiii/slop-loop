/** Static document assets for the local operator page, interpolated by console-page.ts. */

export const STYLE = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0 auto; max-width: 72rem; padding: 1rem; line-height: 1.4; }
section { border: 1px solid #8884; border-radius: .5rem; padding: .75rem 1rem; margin: 1rem 0; }
label { display: block; margin: .4rem 0 .15rem; font-weight: 600; }
input, select, textarea, button { font: inherit; max-width: 100%; }
input:not([type=radio]):not([type=checkbox]), textarea, select { width: 100%; box-sizing: border-box; }
textarea { min-height: 3rem; }
button { margin: .5rem .5rem .5rem 0; padding: .35rem .9rem; }
fieldset { border: 0; margin: 0; padding: 0; }
legend { font-weight: 700; }
pre { white-space: pre-wrap; word-break: break-word; background: #8881; padding: .5rem; border-radius: .35rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem .75rem; }
dt { font-weight: 700; }
dd { margin: 0; word-break: break-word; }
.hint { font-weight: 400; font-size: .85em; opacity: .8; }
`;

/** Client script. No network endpoints beyond same-origin relative paths; no HTML sinks. */
export const SCRIPT = `
(function () {
  'use strict';
  var token = '';
  var keys = { experiment: null, decision: null, answer: null, direction: null, continuation: null, comparison: null };
  var pollTimer = null;
  var currentId = null;
  var profile = document.body.getAttribute('data-profile');

  function byId(id) { return document.getElementById(id); }
  function show(id, value) { byId(id).textContent = value; }
  function freshKey() { return crypto.randomUUID(); }

  function api(method, path, body) {
    var headers = { 'X-Operator-Token': token };
    if (body !== null) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: method,
      headers: headers,
      body: body === null ? null : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error'
    }).then(function (response) {
      return response.json().then(function (data) { return { status: response.status, data: data }; });
    });
  }

  // Result pane: allowlisted receipt/decision scalars only; views render via formatExperiment, never wholesale.
  // A UC-05 decision arrives as a 200 SafeResult; only outcome ok/paused means it was recorded.
  function describe(out) {
    var d = isObj(out.data) ? out.data : {};
    if (d.ok !== true) return 'error ' + out.status + ' ' + (typeof d.error === 'string' && OPAQUE.test(d.error) ? d.error : 'UNKNOWN');
    var r = isObj(d.result) ? (isObj(d.result.receipt) ? d.result.receipt : d.result) : {};
    var o = typeof r.outcome === 'string' && OPAQUE.test(r.outcome) ? r.outcome : 'unknown';
    var text = [r.outcome === undefined || o === 'ok' || o === 'paused' ? 'ok ' + out.status : 'not recorded ' + out.status + ' (outcome ' + o + ')'];
    ['outcome', 'decision', 'status', 'safeReasonCode', 'reasonCode', 'kind', 'receiptId', 'receiptRef', 'decisionId', 'experimentId', 'taskId', 'version', 'controlVersion', 'safeNextAction'].forEach(function (k) {
      if ((typeof r[k] === 'string' && OPAQUE.test(r[k])) || cnt(r[k]) !== null) text.push(k + ': ' + r[k]);
    });
    return text.join('\\n');
  }

  // One key per pending action: a disabled control plus the retained key makes a double submit harmless.
  function send(button, slot, path, build) {
    if (button.disabled) return null;
    if (!keys[slot]) keys[slot] = freshKey();
    button.disabled = true;
    var payload = build(keys[slot]);
    return api('POST', path, payload).then(function (out) {
      button.disabled = false;
      if (out.status === 200) keys[slot] = null;
      show('result', describe(out));
      return out;
    }, function () {
      button.disabled = false;
      show('result', 'Request failed; the idempotency key is retained for a safe retry.');
      return null;
    });
  }

  function lines(text) { return text ? text.split('\\n').map(function (line) { return line.trim(); }).filter(Boolean) : []; }
  function num(id) { return Number(byId(id).value); }

  // Safe report projection: explicit allowlists only; nothing is stringified wholesale.
  var OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function pick(v, allowed) { return typeof v === 'string' && allowed.indexOf(v) >= 0 ? v : 'unknown'; }
  function cnt(v) { return typeof v === 'number' && v >= 0 && v <= 1000000 && Math.floor(v) === v ? v : null; }
  function text1(v, max) { return String(v).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]+/g, ' ').slice(0, max); }
  var OUTCOMES = ['pass', 'fail', 'incomplete'];

  function formatReport(view) {
    if (view.graded !== true || view.scope === 'exploratory') return ['workflow report: custom submission, ungraded; no grade or acceptance shown'];
    var r = view.workflowReport;
    var sel = isObj(r) ? r.selectionResult : null;
    var suite = isObj(r) ? r.suiteAcceptance : null;
    if (!isObj(r) || r.suite !== 'uc03' || r.contractVersion !== 'uc03-workflow-evaluation/1' || r.isRealVerified !== false ||
        (r.tier !== 'controlled' && r.tier !== 'real-integration') || !isObj(sel) || !isObj(suite) || !Array.isArray(r.cases)) {
      return ['workflow report: unavailable or invalid; acceptance unknown'];
    }
    var p = cnt(sel.passed), f = cnt(sel.failed), i = cnt(sel.incomplete);
    var selOut = pick(sel.outcome, OUTCOMES);
    if (p === null || f === null || i === null || (selOut === 'pass' && (f !== 0 || i !== 0))) selOut = 'unknown';
    var need = cnt(suite.requiredCases), have = cnt(suite.satisfiedCases);
    var suiteOut = pick(suite.outcome, OUTCOMES.concat(['not-applicable']));
    if (need === null || have === null || (suiteOut === 'pass' && have !== need)) suiteOut = 'unknown';
    var out = [
      'workflow report: available (' + r.tier + ')',
      'real verified: no',
      'selected result: ' + selOut + (selOut === 'unknown' ? '' : ' (' + p + ' passed, ' + f + ' failed, ' + i + ' incomplete)'),
      pick(suite.scope, ['catalog', 'exploratory']) + ' acceptance: ' + suiteOut + (need === null || have === null ? '' : ' (' + have + ' of ' + need + ' required)')
    ];
    var refs = [];
    r.cases.slice(0, 32).forEach(function (c) {
      if (!isObj(c)) { out.push('case unknown'); return; }
      var id = typeof c.caseId === 'string' && OPAQUE.test(c.caseId) ? c.caseId : 'unknown';
      out.push('case ' + id + ': workflow ' + pick(c.workflowOutcome, ['COMPLETED', 'IMPLEMENTED_UNVERIFIED', 'FAILED', 'INCOMPLETE', 'waiting-approval', 'waiting-info', 'not-observed']) +
        '; grade ' + pick(c.grade, ['pass', 'fail', 'not-run']) + ' (' + (typeof c.gradeReason === 'string' && OPAQUE.test(c.gradeReason) ? c.gradeReason : 'unknown') + ')' +
        '; effects ' + pick(c.effects, ['none', 'observed', 'uncertain']) + '; usage ' + pick(c.usage, ['observed', 'uncertain', 'unavailable']));
      if (typeof c.diagnostic === 'string' && c.diagnostic) out.push('diagnostic ' + id + ': ' + text1(c.diagnostic, 512));
      (Array.isArray(c.artifacts) ? c.artifacts.slice(0, 16) : []).forEach(function (a) {
        if (typeof a === 'string' && OPAQUE.test(a) && refs.indexOf(a) < 0 && refs.length < 16) refs.push(a);
      });
    });
    if (r.cases.length > 32) out.push('additional items omitted');
    if (refs.length) out.push('artifact refs: ' + refs.join(', '));
    var joined = out.join('\\n');
    return joined.length > 8192 ? [joined.slice(0, 8192), 'additional items omitted'] : out;
  }

  function formatExperiment(view) {
    var out = [];
    out.push('id: ' + view.id);
    out.push('version: ' + view.version);
    out.push('status: ' + view.status);
    out.push('scope: ' + view.scope + (view.graded ? ' (graded)' : ' (ungraded)'));
    out.push('task: ' + (view.taskId || 'none'));
    out.push('run: ' + (view.runId || 'none'));
    out.push('workspace: ' + (view.workspaceId || 'none'));
    out.push('usage: ' + (view.usage ? view.usage.tokensConsumed + ' tokens / $' + view.usage.costUsd : 'unavailable'));
    if (view.bindings.length) out.push('cases: ' + view.bindings.map(function (b) { return b.caseId + '@' + b.version + ' sha256:' + b.caseDigest; }).join(', '));
    if (view.submission) out.push('submission: ' + view.submission.submissionId + ' repository=' + view.submission.repositoryId + ' checks=' + view.submission.checkSetId);
    out.push('answers recorded: ' + view.answers.length);
    out.push('directions: ' + (view.directions.length ? view.directions.join(', ') : 'none'));
    (view.submission ? view.submission.questions : []).forEach(function (q) {
      out.push('question ' + q.questionId + ': ' + q.text + ' [digest ' + q.questionDigest + ']');
    });
    return out.concat(formatReport(view)).join('\\n');
  }

  function renderExperiment(view) {
    currentId = view.id;
    byId('experiment-id').value = view.id;
    show('experiment', formatExperiment(view));
  }

  function stopPolling() {
    if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
    byId('poll-state').textContent = 'paused';
  }

  // The console polls at most once per second; the server refuses nothing here, the page just waits.
  function startPolling() {
    stopPolling();
    byId('poll-state').textContent = 'polling';
    pollTimer = setInterval(function () {
      if (!currentId || !token) return;
      api('GET', '/api/experiments/' + encodeURIComponent(currentId), null).then(function (out) {
        if (out.status === 200) renderExperiment(out.data.result);
      }, function () { /* a dropped poll is not an error the operator must act on */ });
    }, 1000);
  }

  byId('token-form').addEventListener('submit', function (event) {
    event.preventDefault();
    token = byId('operator-token').value;
    byId('operator-token').value = '';
    byId('token-state').textContent = token ? 'token held in page memory' : 'no token';
  });

  byId('load-catalog').addEventListener('click', function () {
    api('GET', '/api/catalog', null).then(function (out) {
      if (!out.data || !out.data.ok) { show('catalog', 'error ' + out.status); return; }
      var text = ['profile: ' + out.data.result.profileId];
      out.data.result.cases.forEach(function (entry) {
        text.push(entry.caseId + ' v' + entry.version + ' ' + (entry.ready ? 'ready' : 'not-ready') + ' caseDigest=' + entry.caseDigest + ' grader=' + entry.graderDigest);
      });
      show('catalog', text.join('\\n'));
    }, function () { show('catalog', 'catalog unavailable'); });
  });

  byId('submit-experiment').addEventListener('click', function () {
    send(byId('submit-experiment'), 'experiment', '/api/experiments', function (key) {
      var kind = byId('source-kind').value;
      if (kind === 'bug') {
        return {
          profileId: profile,
          idempotencyKey: key,
          source: {
            kind: 'bug',
            repositoryId: byId('repository-id').value.trim(),
            checkSetId: byId('check-set-id').value.trim(),
            bugInput: {
              goal: byId('bug-goal').value,
              observedBehavior: byId('bug-observed').value,
              expectedBehavior: byId('bug-expected').value,
              reproduction: byId('bug-reproduction').value,
              acceptanceCriteria: lines(byId('bug-acceptance').value)
            }
          }
        };
      }
      return { profileId: profile, idempotencyKey: key, source: { kind: 'catalog', caseIds: lines(byId('case-ids').value) } };
    }).then(function (out) {
      if (!out || out.status !== 200) return;
      if (out.data.result && out.data.result.experiment) renderExperiment(out.data.result.experiment);
    });
  });

  byId('load-experiment').addEventListener('click', function () {
    var id = byId('experiment-id').value.trim();
    api('GET', '/api/experiments/' + encodeURIComponent(id), null).then(function (out) {
      if (out.data && out.data.ok) renderExperiment(out.data.result); else show('experiment', describe(out));
    }, function () { show('experiment', 'unavailable'); });
  });

  byId('toggle-poll').addEventListener('click', function () {
    if (pollTimer === null) startPolling(); else stopPolling();
  });

  byId('load-approval').addEventListener('click', function () {
    var id = byId('experiment-id').value.trim();
    api('GET', '/api/experiments/' + encodeURIComponent(id) + '/approval', null).then(function (out) {
      show('approval', out.data && out.data.ok ? JSON.stringify(out.data.result, null, 2) : describe(out));
    }, function () { show('approval', 'approval unavailable'); });
  });

  function experimentPath(suffix) { return '/api/experiments/' + encodeURIComponent(byId('experiment-id').value.trim()) + suffix; }

  byId('submit-decision').addEventListener('click', function () {
    send(byId('submit-decision'), 'decision', experimentPath('/decision'), function (key) {
      return {
        idempotencyKey: key,
        decision: byId('decision-choice').value,
        expectedVersion: num('decision-version'),
        presentationDigest: byId('decision-digest').value.trim()
      };
    });
  });

  byId('submit-answer').addEventListener('click', function () {
    send(byId('submit-answer'), 'answer', experimentPath('/answers'), function (key) {
      return {
        idempotencyKey: key,
        questionId: byId('answer-question').value,
        questionDigest: byId('answer-digest').value.trim(),
        expectedVersion: num('answer-version'),
        answers: [byId('answer-text').value]
      };
    });
  });

  byId('submit-direction').addEventListener('click', function () {
    send(byId('submit-direction'), 'direction', experimentPath('/directions'), function (key) {
      return {
        idempotencyKey: key,
        kind: byId('direction-kind').value,
        expectedTaskVersion: num('direction-task-version'),
        expectedControlVersion: num('direction-control-version'),
        decisionRef: byId('direction-decision-ref').value.trim() || undefined,
        feedback: byId('direction-feedback').value.trim() || undefined
      };
    });
  });

  byId('submit-continue').addEventListener('click', function () {
    send(byId('submit-continue'), 'continuation', experimentPath('/continue'), function (key) {
      return {
        idempotencyKey: key,
        directionRef: byId('continue-direction-ref').value.trim(),
        expectedVersion: num('continue-version')
      };
    });
  });

  byId('load-artifact').addEventListener('click', function () {
    var id = byId('artifact-id').value.trim();
    if (!OPAQUE.test(id)) { show('artifact', 'artifact unavailable'); return; }
    api('GET', '/api/artifacts/' + encodeURIComponent(id), null).then(function (out) {
      show('artifact', out.data && out.data.ok ? out.data.result.mediaType + ' sha256:' + out.data.result.digest + '\\n' + out.data.result.text : describe(out));
    }, function () { show('artifact', 'artifact unavailable'); });
  });

  byId('submit-comparison').addEventListener('click', function () {
    send(byId('submit-comparison'), 'comparison', '/api/comparisons', function (key) {
      return {
        idempotencyKey: key,
        baselineId: byId('compare-baseline').value.trim(),
        candidateId: byId('compare-candidate').value.trim(),
        policy: byId('compare-policy').value
      };
    }).then(function (out) {
      if (!out || out.status !== 200) { show('comparison-verdict', 'not compared'); show('comparison-acceptance', 'not compared'); return; }
      // Verdict and candidate acceptance are separate authoritative values; never fold one into the other.
      show('comparison-verdict', String(out.data.result.verdict || 'unavailable'));
      show('comparison-acceptance', String((out.data.result.candidateAcceptance || {}).outcome || 'unavailable'));
    });
  });
})();
`;
