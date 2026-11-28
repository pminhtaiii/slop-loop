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

/** Client script; same-origin only, no HTML sinks. */
export const SCRIPT = `
(function () {
  'use strict';
  var token = '';
  var keys = { experiment: null, decision: null, answer: null, group: null, direction: null, continuation: null, comparison: null };
  var pollTimer = null;
  var currentId = null;
  var profile = document.body.getAttribute('data-profile');

  function byId(id) { return document.getElementById(id); }
  function val(id) { return byId(id).value.trim(); }
  function onClick(id, fn) { byId(id).addEventListener('click', fn); }
  function show(id, value) { byId(id).textContent = value; }
  function freshKey() { return crypto.randomUUID(); }

  function api(method, path, body) {
    var headers = { 'X-Operator-Token': token };
    if (body !== null) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: method, headers: headers, body: body === null ? null : JSON.stringify(body), cache: 'no-store', credentials: 'omit', redirect: 'error' })
      .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); });
  }

  // Result pane: allowlisted scalars only; ok/paused means recorded.
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

  // One idempotency key per pending action.
  function send(button, slot, path, build) {
    if (button.disabled) return null;
    if (!keys[slot]) keys[slot] = freshKey();
    button.disabled = true;
    var key = keys[slot];
    return api('POST', path, build(key)).then(function (out) {
      button.disabled = false;
      if (out.status < 500 && out.status !== 409 && keys[slot] === key) keys[slot] = null;
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

  // Explicit allowlists only.
  var OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function pick(v, allowed) { return typeof v === 'string' && allowed.indexOf(v) >= 0 ? v : 'unknown'; }
  function cnt(v) { return typeof v === 'number' && v >= 0 && v <= 1000000 && Math.floor(v) === v ? v : null; }
  function text1(v, max) { return String(v).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]+/g, ' ').slice(0, max); }
  var OUTCOMES = ['pass', 'fail', 'incomplete'];
  var MK = 'task_started investigation_completed plan_proposed plan_approved plan_rejected patch_applied verification_completed review_completed replan_triggered budget_exhausted task_completed task_failed task_interrupted'.split(' ');
  var MO = 'success failure pending info'.split(' ');
  function u8ok(s, max) {
    var b = 0, i = 0, c, n;
    for (; i < s.length; i += 1) {
      c = s.charCodeAt(i);
      if (c < 128) b += 1;
      else if (c < 2048) b += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        n = s.charCodeAt(i + 1);
        if (n >= 0xdc00 && n <= 0xdfff) { b += 4; i += 1; } else b += 3;
      } else b += 3;
      if (b > max) return false;
    }
    return true;
  }

  function formatMilestones(view) {
    var raw = Array.isArray(view.milestones) ? view.milestones : [];
    var out = [], i, m, sum;
    for (i = 0; i < raw.length && out.length < 64; i += 1) {
      m = raw[i];
      if (!isObj(m) || MK.indexOf(m.kind) < 0 || MO.indexOf(m.outcome) < 0 || typeof m.node !== 'string' || !OPAQUE.test(m.node) || m.node.length > 64 || typeof m.timestamp !== 'string' || !m.timestamp.trim() || !u8ok(m.timestamp, 64) || text1(m.timestamp, 64) !== m.timestamp || typeof m.summary !== 'string' || !u8ok(m.summary, 512)) continue;
      sum = text1(m.summary, 512).trim();
      if (!sum) continue;
      out.push('milestone: ' + m.kind + ' [' + m.node + '] ' + m.outcome + ' ' + m.timestamp + ' - ' + sum);
    }
    return out.length ? out : ['milestones: none'];
  }

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

  function ctrlOf(v) {
    var c = isObj(v.control) ? v.control : null;
    return c && cnt(c.taskVersion) !== null && cnt(c.controlVersion) !== null ? c : null;
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
    var ctrl = ctrlOf(view);
    out.push('control: ' + (ctrl ? 'task=' + ctrl.taskVersion + ' control=' + ctrl.controlVersion : 'none'));
    (view.submission ? view.submission.questions : []).forEach(function (q) {
      out.push('question ' + q.questionId + ': ' + q.text + ' [digest ' + q.questionDigest + ']');
    });
    return out.concat(formatMilestones(view), formatReport(view)).join('\\n');
  }

  function renderExperiment(view) {
    currentId = view.id;
    byId('experiment-id').value = view.id;
    var ctrl = ctrlOf(view);
    byId('direction-task-version').value = String(ctrl ? ctrl.taskVersion : 0);
    byId('direction-control-version').value = String(ctrl ? ctrl.controlVersion : 0);
    show('experiment', formatExperiment(view));
    renderClarification(view);
  }

  // Generated clarification group (1-16 questions); textContent only.
  var groupNode = null;
  var groupKey = null;
  var groupSent = null;
  var groupVersion = 0;

  function el(tag, text) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clearGroup() {
    if (groupNode && groupNode.parentNode) groupNode.parentNode.removeChild(groupNode);
    groupNode = null;
    groupKey = null;
    groupSent = null;
    // Retire group key on clear.
    keys.group = null;
  }

  function renderClarification(view) {
    var c = view.workflowClarification;
    var answered = isObj(c) && Array.isArray(view.answers) && view.answers.some(function (a) { return isObj(a) && a.questionId === c.questionId; });
    if (answered || !isObj(c) || typeof c.questionId !== 'string' || typeof c.questionDigest !== 'string' ||
        !Array.isArray(c.questions) || c.questions.length < 1 || c.questions.length > 16 ||
        !c.questions.every(function (q) { return isObj(q); })) { clearGroup(); return; }
    var key = view.id + '/' + c.questionId + '/' + c.questionDigest;
    if (key === groupKey) { groupVersion = view.version; return; }
    clearGroup();
    var section = el('section');
    section.appendChild(el('h2', 'Task questions'));
    section.appendChild(el('p', 'Question group ' + text1(c.questionId, 128) + ' (digest ' + text1(c.questionDigest, 128) + '). Answers are reporter data; they never resume.'));
    var inputs = [];
    c.questions.forEach(function (q, index) {
      var id = 'group-question-' + (index + 1);
      var label = el('label', 'Question ' + (index + 1) + ': ' + text1(q.text, 512));
      label.htmlFor = id;
      var input = el('textarea');
      input.id = id;
      inputs.push(input);
      section.appendChild(label);
      section.appendChild(input);
    });
    var button = el('button', 'Submit group answers');
    button.type = 'button';
    // Bound to group id/digest; clearGroup retires key.
    button.addEventListener('click', function () {
      send(button, 'group', experimentPath('/answers'), function (key) {
        // Replay retained payload on retry.
        if (groupSent && groupSent.idempotencyKey === key) return groupSent;
        groupSent = {
          idempotencyKey: key,
          questionId: c.questionId,
          questionDigest: c.questionDigest,
          expectedVersion: groupVersion,
          answers: inputs.map(function (input) { return input.value; })
        };
        return groupSent;
      }).then(function (out) {
        // Ignore late responses for superseded groups.
        if (out && out.status === 200 && groupKey === key) clearGroup();
      });
    });
    section.appendChild(button);
    document.body.appendChild(section);
    groupNode = section;
    groupKey = key;
    groupVersion = view.version;
  }

  function stopPolling() {
    if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
    byId('poll-state').textContent = 'paused';
  }

  // Poll at most once per second while waiting.
  function startPolling() {
    stopPolling();
    byId('poll-state').textContent = 'polling';
    pollTimer = setInterval(function () {
      if (!currentId || !token) return;
      api('GET', '/api/experiments/' + encodeURIComponent(currentId), null).then(function (out) {
        if (out.status === 200) renderExperiment(out.data.result);
      }, function () {});
    }, 1000);
  }

  byId('token-form').addEventListener('submit', function (event) {
    event.preventDefault();
    token = byId('operator-token').value;
    byId('operator-token').value = '';
    byId('token-state').textContent = token ? 'token held in page memory' : 'no token';
  });

  onClick('load-catalog', function () {
    api('GET', '/api/catalog', null).then(function (out) {
      if (!out.data || !out.data.ok) { show('catalog', 'error ' + out.status); return; }
      var text = ['profile: ' + out.data.result.profileId];
      out.data.result.cases.forEach(function (entry) {
        text.push(entry.caseId + ' v' + entry.version + ' ' + (entry.ready ? 'ready' : 'not-ready') + ' caseDigest=' + entry.caseDigest + ' grader=' + entry.graderDigest);
      });
      show('catalog', text.join('\\n'));
    }, function () { show('catalog', 'catalog unavailable'); });
  });

  function onExp(out) {
    if (out && out.status === 200 && out.data && out.data.result && out.data.result.experiment) renderExperiment(out.data.result.experiment);
  }

  onClick('submit-experiment', function () {
    send(byId('submit-experiment'), 'experiment', '/api/experiments', function (key) {
      if (byId('source-kind').value === 'bug') {
        return {
          profileId: profile, idempotencyKey: key,
          source: {
            kind: 'bug', repositoryId: val('repository-id'), checkSetId: val('check-set-id'),
            bugInput: { goal: byId('bug-goal').value, observedBehavior: byId('bug-observed').value, expectedBehavior: byId('bug-expected').value, reproduction: byId('bug-reproduction').value, acceptanceCriteria: lines(byId('bug-acceptance').value) }
          }
        };
      }
      return { profileId: profile, idempotencyKey: key, source: { kind: 'catalog', caseIds: lines(byId('case-ids').value) } };
    }).then(onExp);
  });

  onClick('load-experiment', function () {
    api('GET', '/api/experiments/' + encodeURIComponent(val('experiment-id')), null).then(function (out) {
      if (out.data && out.data.ok) renderExperiment(out.data.result); else show('experiment', describe(out));
    }, function () { show('experiment', 'unavailable'); });
  });

  onClick('toggle-poll', function () {
    if (pollTimer === null) startPolling(); else stopPolling();
  });

  onClick('load-approval', function () {
    api('GET', experimentPath('/approval'), null).then(function (out) {
      show('approval', out.data && out.data.ok ? JSON.stringify(out.data.result, null, 2) : describe(out));
    }, function () { show('approval', 'approval unavailable'); });
  });

  function experimentPath(suffix) { return '/api/experiments/' + encodeURIComponent(val('experiment-id')) + suffix; }

  onClick('submit-decision', function () {
    send(byId('submit-decision'), 'decision', experimentPath('/decision'), function (key) {
      return { idempotencyKey: key, decision: byId('decision-choice').value, expectedVersion: num('decision-version'), presentationDigest: val('decision-digest') };
    });
  });

  onClick('submit-answer', function () {
    send(byId('submit-answer'), 'answer', experimentPath('/answers'), function (key) {
      return { idempotencyKey: key, questionId: byId('answer-question').value, questionDigest: val('answer-digest'), expectedVersion: num('answer-version'), answers: [byId('answer-text').value] };
    });
  });

  onClick('submit-direction', function () {
    send(byId('submit-direction'), 'direction', experimentPath('/directions'), function (key) {
      return { idempotencyKey: key, kind: byId('direction-kind').value, expectedTaskVersion: num('direction-task-version'), expectedControlVersion: num('direction-control-version'), decisionRef: val('direction-decision-ref') || undefined, feedback: val('direction-feedback') || undefined };
    }).then(onExp);
  });

  onClick('submit-continue', function () {
    send(byId('submit-continue'), 'continuation', experimentPath('/continue'), function (key) {
      return { idempotencyKey: key, directionRef: val('continue-direction-ref'), expectedVersion: num('continue-version') };
    }).then(onExp);
  });

  onClick('load-artifact', function () {
    var id = val('artifact-id');
    if (!OPAQUE.test(id)) { show('artifact', 'artifact unavailable'); return; }
    api('GET', '/api/artifacts/' + encodeURIComponent(id), null).then(function (out) {
      show('artifact', out.data && out.data.ok ? out.data.result.mediaType + ' sha256:' + out.data.result.digest + '\\n' + out.data.result.text : describe(out));
    }, function () { show('artifact', 'artifact unavailable'); });
  });

  onClick('submit-comparison', function () {
    send(byId('submit-comparison'), 'comparison', '/api/comparisons', function (key) {
      return { idempotencyKey: key, baselineId: val('compare-baseline'), candidateId: val('compare-candidate'), policy: byId('compare-policy').value };
    }).then(function (out) {
      if (!out || out.status !== 200) { show('comparison-verdict', 'not compared'); show('comparison-acceptance', 'not compared'); return; }
      // Verdict and candidate acceptance are separate authoritative values.
      show('comparison-verdict', String(out.data.result.verdict || 'unavailable'));
      show('comparison-acceptance', String((out.data.result.candidateAcceptance || {}).outcome || 'unavailable'));
    });
  });
})();
`;
