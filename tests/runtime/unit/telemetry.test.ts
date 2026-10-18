import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type ActivityEvent,
  type ProviderUsage,
  isAdmittedForProduction,
} from '../../../src/contracts/uc03.ts';
import {
  SanitizedTelemetry,
  sanitizeText,
  sanitizeDiagnostic,
  isProtectedPayload,
} from '../../../src/foundation/telemetry.ts';

const VALID_EVENT: ActivityEvent = {
  eventId: 'evt-1001',
  taskId: 'task-uc03-001',
  runId: 'run-001',
  timestamp: new Date().toISOString(),
  node: 'Investigate',
  actionType: 'run_tests',
  outcome: 'pass',
  durationMs: 150,
  evidenceRefs: ['evidence-baseline-001'],
};

test('TelemetryPort provenance admission', () => {
  const realPort = new SanitizedTelemetry();
  assert.equal(realPort.provenance, 'real');
  assert.equal(isAdmittedForProduction([realPort]), true);

  const mockPort = new SanitizedTelemetry({ provenance: 'mock' });
  assert.equal(mockPort.provenance, 'mock');
  assert.equal(isAdmittedForProduction([mockPort]), false);
});

test('sanitizeText redacts custom and builtin secret patterns', () => {
  const raw = 'diagnostic info with MARKER_SECRET_RAW_TOKEN and Bearer eyJhbGciOi';
  const result = sanitizeText(raw);
  assert.equal(result.includes('MARKER_SECRET_RAW_TOKEN'), false);
  assert.equal(result.includes('eyJhbGciOi'), false);
  assert.match(result, /\[REDACTED\]/);

  const custom = sanitizeText('secret key is custom-token-xyz', ['custom-token-xyz']);
  assert.equal(custom.includes('custom-token-xyz'), false);
  assert.match(custom, /\[REDACTED\]/);
});

test('sanitizeText redacts secrets without capture groups and prevents offset/prefix leakage', () => {
  // Built-in marker secret at offset 0
  const markerResult = sanitizeText('MARKER_SECRET_0123');
  assert.equal(markerResult, '[REDACTED]');
  assert.equal(markerResult.includes('0123'), false);
  assert.equal(markerResult.includes('MARKER_SECRET'), false);

  // Custom regex without capture group matching string with digit 0 at offset 0
  const customResult = sanitizeText('SENSITIVE0TOKEN', [/SENSITIVE0TOKEN/g]);
  assert.equal(customResult, '[REDACTED]');
  assert.equal(customResult.includes('SENSITIVE'), false);
  assert.equal(customResult.includes('TOKEN'), false);

  // Custom regex without capture groups matching at non-zero offset
  const textWithOffset = 'preceding-data MARKER_SECRET_98765 post';
  const offsetResult = sanitizeText(textWithOffset);
  assert.equal(offsetResult, 'preceding-data [REDACTED] post');
  assert.equal(offsetResult.includes('MARKER_SECRET'), false);
  assert.equal(offsetResult.includes('98765'), false);

  // Multiple marker secrets
  const multiResult = sanitizeText('MARKER_SECRET_000 and MARKER_SECRET_111');
  assert.equal(multiResult, '[REDACTED] and [REDACTED]');
});

test('emitActivity enforces whitelisted metadata and rejects unknown keys', async () => {
  const telemetry = new SanitizedTelemetry();

  // Valid event passes
  await telemetry.emitActivity(VALID_EVENT);
  const events = telemetry.getEvents(VALID_EVENT.taskId);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.eventId, VALID_EVENT.eventId);

  // Unknown property / unwhitelisted metadata is rejected
  const maliciousEvent = {
    ...VALID_EVENT,
    eventId: 'evt-1002',
    rawPrompt: 'system prompt: solve the bug with instructions',
    sourceBody: 'def secret_algorithm(): return 42',
  };
  await assert.rejects(
    () => telemetry.emitActivity(maliciousEvent as unknown as ActivityEvent),
    /Unknown property/
  );
});

test('emitActivity validates required fields and types', async () => {
  const telemetry = new SanitizedTelemetry();

  await assert.rejects(
    () =>
      telemetry.emitActivity({
        ...VALID_EVENT,
        eventId: '',
      }),
    /INVALID_STRING|non-empty string/
  );

  await assert.rejects(
    () =>
      telemetry.emitActivity({
        ...VALID_EVENT,
        durationMs: -5,
      }),
    /INVALID_NON_NEGATIVE_INTEGER|durationMs/
  );

  await assert.rejects(
    () =>
      telemetry.emitActivity({
        ...VALID_EVENT,
        timestamp: 'not-a-timestamp',
      }),
    /INVALID_TIMESTAMP|ISO 8601/
  );
});

test('marker-secret sanitization on success path', async () => {
  const customSecret = 'custom-api-token-998877';
  const telemetry = new SanitizedTelemetry({
    secretPatterns: [customSecret],
  });
  const markerSecret = 'MARKER_SECRET_SUCCESS_ALPHA_12345';

  const successEvent: ActivityEvent = {
    ...VALID_EVENT,
    eventId: 'evt-success-01',
    outcome: `success: verified with secret=${markerSecret} and token=${customSecret}`,
    evidenceRefs: [`evidence-ref-${markerSecret}`, 'evidence-clean'],
  };

  await telemetry.emitActivity(successEvent);
  const recorded = telemetry.getEvents(successEvent.taskId);
  assert.equal(recorded.length, 1);
  const event = recorded[0];
  assert.ok(event);

  assert.equal(event.outcome.includes(markerSecret), false, 'Marker secret must not leak in outcome');
  assert.equal(event.outcome.includes(customSecret), false, 'Custom secret must not leak in outcome');
  assert.match(event.outcome, /\[REDACTED\]/);

  for (const ref of event.evidenceRefs) {
    assert.equal(ref.includes(markerSecret), false, 'Marker secret must not leak in evidenceRefs');
    assert.equal(ref.includes(customSecret), false, 'Custom secret must not leak in evidenceRefs');
  }
});

test('marker-secret sanitization on error path', async () => {
  const telemetry = new SanitizedTelemetry();
  const markerSecret = 'MARKER_SECRET_ERROR_BETA_67890';
  const privateKeySecret = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----';

  const errorEvent: ActivityEvent = {
    ...VALID_EVENT,
    eventId: 'evt-error-01',
    outcome: `error: Provider failed with authorization token ${markerSecret} and ${privateKeySecret}`,
    evidenceRefs: ['evidence-err-1'],
  };

  await telemetry.emitActivity(errorEvent);
  const recorded = telemetry.getEvents(errorEvent.taskId);
  assert.equal(recorded.length, 1);
  const event = recorded[0];
  assert.ok(event);

  assert.equal(event.outcome.includes(markerSecret), false, 'Marker secret must not leak in error outcome');
  assert.equal(event.outcome.includes('BEGIN RSA PRIVATE KEY'), false, 'Private key must not leak');
  assert.match(event.outcome, /\[REDACTED\]/);
});

test('bounded redacted diagnostics truncates and hashes diagnostic refs', () => {
  const markerSecret = 'MARKER_SECRET_DIAG_99999';
  const rawDiagnostic = `Error output:\nTraceback: secret=${markerSecret}\n` + 'X'.repeat(2000);

  const diag = sanitizeDiagnostic(rawDiagnostic, { maxBytes: 500 });
  assert.equal(diag.redacted, true);
  assert.equal(diag.truncated, true);
  assert.equal(diag.sanitizedContent.includes(markerSecret), false);
  assert.match(diag.sanitizedContent, /\[REDACTED\]/);
  assert.match(diag.sanitizedContent, /\[TRUNCATED\]/);
  assert.ok(diag.byteCount <= 500);
  assert.equal(Buffer.byteLength(diag.sanitizedContent, 'utf8'), diag.byteCount);
  assert.match(diag.diagnosticRef, /^diag:sha256:[a-f0-9]{64}$/);

  // Short diagnostic is not truncated
  const shortDiag = sanitizeDiagnostic('clean short diagnostic message', { maxBytes: 500 });
  assert.equal(shortDiag.truncated, false);
  assert.equal(shortDiag.redacted, false);
  assert.equal(shortDiag.sanitizedContent, 'clean short diagnostic message');
  assert.equal(shortDiag.byteCount, Buffer.byteLength('clean short diagnostic message', 'utf8'));
});

test('bounded redacted diagnostics enforces byte bounds INCLUDING suffix and safe UTF-8 split', () => {
  // Tiny bound maxBytes: 1
  const diag1 = sanitizeDiagnostic('abcdef', { maxBytes: 1 });
  assert.equal(diag1.truncated, true);
  assert.ok(diag1.byteCount <= 1, `Expected byteCount <= 1, got ${diag1.byteCount}`);
  assert.equal(Buffer.byteLength(diag1.sanitizedContent, 'utf8'), diag1.byteCount);
  assert.ok(Buffer.byteLength(diag1.sanitizedContent, 'utf8') <= 1);

  // Tiny bound maxBytes: 3
  const diag3 = sanitizeDiagnostic('abcdef', { maxBytes: 3 });
  assert.equal(diag3.truncated, true);
  assert.ok(diag3.byteCount <= 3, `Expected byteCount <= 3, got ${diag3.byteCount}`);
  assert.equal(Buffer.byteLength(diag3.sanitizedContent, 'utf8'), diag3.byteCount);
  assert.ok(Buffer.byteLength(diag3.sanitizedContent, 'utf8') <= 3);

  // Bound equal to truncation notice length (15 bytes)
  const diag15 = sanitizeDiagnostic('long diagnostic content', { maxBytes: 15 });
  assert.equal(diag15.truncated, true);
  assert.ok(diag15.byteCount <= 15, `Expected byteCount <= 15, got ${diag15.byteCount}`);
  assert.equal(Buffer.byteLength(diag15.sanitizedContent, 'utf8'), diag15.byteCount);

  // Bound slightly above truncation notice (20 bytes)
  const diag20 = sanitizeDiagnostic('long diagnostic content', { maxBytes: 20 });
  assert.equal(diag20.truncated, true);
  assert.ok(diag20.byteCount <= 20, `Expected byteCount <= 20, got ${diag20.byteCount}`);
  assert.equal(Buffer.byteLength(diag20.sanitizedContent, 'utf8'), diag20.byteCount);
  assert.match(diag20.sanitizedContent, /\[TRUNCATED\]/);

  // UTF-8 multibyte 2-byte character split ('é' is 2 bytes: 0xC3 0xA9)
  const diagUtf8 = sanitizeDiagnostic('é'.repeat(100), { maxBytes: 21 });
  assert.equal(diagUtf8.truncated, true);
  assert.ok(diagUtf8.byteCount <= 21, `Expected byteCount <= 21, got ${diagUtf8.byteCount}`);
  assert.equal(Buffer.byteLength(diagUtf8.sanitizedContent, 'utf8'), diagUtf8.byteCount);
  assert.equal(diagUtf8.sanitizedContent.includes('\uFFFD'), false, 'Must not contain replacement character');

  // UTF-8 multibyte 4-byte emoji ('🚀' is 4 bytes)
  const diagEmoji = sanitizeDiagnostic('🚀'.repeat(50), { maxBytes: 19 });
  assert.equal(diagEmoji.truncated, true);
  assert.ok(diagEmoji.byteCount <= 19, `Expected byteCount <= 19, got ${diagEmoji.byteCount}`);
  assert.equal(Buffer.byteLength(diagEmoji.sanitizedContent, 'utf8'), diagEmoji.byteCount);
  assert.equal(diagEmoji.sanitizedContent.includes('\uFFFD'), false, 'Must not contain replacement character');
});

test('missing or invalid finite diagnostic limits fail closed', () => {
  // sanitizeDiagnostic without maxBytes or with invalid maxBytes
  assert.throws(
    () => sanitizeDiagnostic('some text', {} as unknown as { readonly maxBytes: number }),
    /INVALID_DIAGNOSTIC_LIMIT/
  );
  assert.throws(
    () => sanitizeDiagnostic('some text', undefined as unknown as { readonly maxBytes: number }),
    /INVALID_DIAGNOSTIC_LIMIT/
  );
  assert.throws(
    () => sanitizeDiagnostic('some text', { maxBytes: 0 }),
    /INVALID_DIAGNOSTIC_LIMIT/
  );
  assert.throws(
    () => sanitizeDiagnostic('some text', { maxBytes: -10 }),
    /INVALID_DIAGNOSTIC_LIMIT/
  );
  assert.throws(
    () => sanitizeDiagnostic('some text', { maxBytes: NaN }),
    /INVALID_DIAGNOSTIC_LIMIT/
  );
  assert.throws(
    () => sanitizeDiagnostic('some text', { maxBytes: 1.5 }),
    /INVALID_DIAGNOSTIC_LIMIT/
  );
  assert.throws(
    () => sanitizeDiagnostic('some text', { maxBytes: Infinity }),
    /INVALID_DIAGNOSTIC_LIMIT/
  );

  // SanitizedTelemetry with invalid maxDiagnosticBytes constructor option
  assert.throws(
    () => new SanitizedTelemetry({ maxDiagnosticBytes: 0 }),
    /INVALID_DIAGNOSTIC_LIMIT/
  );
  assert.throws(
    () => new SanitizedTelemetry({ maxDiagnosticBytes: -5 }),
    /INVALID_DIAGNOSTIC_LIMIT/
  );
  assert.throws(
    () => new SanitizedTelemetry({ maxDiagnosticBytes: NaN }),
    /INVALID_DIAGNOSTIC_LIMIT/
  );

  // SanitizedTelemetry without maxDiagnosticBytes fails closed when recordDiagnostic is invoked
  const unconfiguredTelemetry = new SanitizedTelemetry();
  assert.throws(
    () => unconfiguredTelemetry.recordDiagnostic('task-1', 'run-1', 'raw error trace'),
    /INVALID_DIAGNOSTIC_LIMIT/
  );
});

test('recordDiagnostic stores and retrieves redacted diagnostics', () => {
  const telemetry = new SanitizedTelemetry({ maxDiagnosticBytes: 256 });
  const raw = 'Failure log with MARKER_SECRET_TRACE_001 details ' + 'Y'.repeat(300);

  const record = telemetry.recordDiagnostic('task-1', 'run-1', raw);
  assert.ok(record.diagnosticRef);
  assert.equal(record.sanitizedContent.includes('MARKER_SECRET_TRACE_001'), false);
  assert.equal(record.truncated, true);

  const fetched = telemetry.getDiagnostic(record.diagnosticRef);
  assert.deepEqual(fetched, record);
});

test('sink dispatch receives sanitized events', async () => {
  const dispatched: ActivityEvent[] = [];
  const telemetry = new SanitizedTelemetry({
    sink: (evt) => {
      dispatched.push(evt);
    },
  });

  const evt: ActivityEvent = {
    ...VALID_EVENT,
    outcome: 'pass with MARKER_SECRET_SINK_1122',
  };

  await telemetry.emitActivity(evt);
  assert.equal(dispatched.length, 1);
  const firstDispatched = dispatched[0];
  assert.ok(firstDispatched);
  assert.equal(firstDispatched.outcome.includes('MARKER_SECRET_SINK_1122'), false);
  assert.match(firstDispatched.outcome, /\[REDACTED\]/);
});

test('protected payload detection identifies secrets and forbidden patterns', () => {
  assert.equal(isProtectedPayload('.env'), true);
  assert.equal(isProtectedPayload('/workspace/.env.local'), true);
  assert.equal(isProtectedPayload('id_rsa'), true);
  assert.equal(isProtectedPayload('-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBA==\n-----END PRIVATE KEY-----'), true);
  assert.equal(isProtectedPayload('MARKER_SECRET_PAYLOAD_TEST'), true);
  assert.equal(isProtectedPayload('ordinary diagnostic message: test passed'), false);

  // Object payloads with nested secrets
  assert.equal(
    isProtectedPayload({
      token: 'sk-1234567890abcdef1234567890',
    }),
    true
  );
  assert.equal(
    isProtectedPayload({
      cleanKey: 'safe-value',
    }),
    false
  );
});

test('recordUsage projects per-run usage and cost while keeping ledger external', async () => {
  const telemetry = new SanitizedTelemetry();
  const taskId = 'task-uc03-001';
  const runId = 'run-001';

  const usage1: ProviderUsage = {
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.002,
    billableTokens: 150,
  };

  await telemetry.recordUsage(taskId, runId, usage1);
  const runUsage1 = telemetry.getRunUsage(taskId, runId);
  assert.deepEqual(runUsage1, usage1);

  // Second usage for same run aggregates
  const usage2: ProviderUsage = {
    inputTokens: 200,
    outputTokens: 100,
    costUsd: 0.004,
    billableTokens: 300,
  };

  await telemetry.recordUsage(taskId, runId, usage2);
  const aggregated = telemetry.getRunUsage(taskId, runId);
  assert.deepEqual(aggregated, {
    inputTokens: 300,
    outputTokens: 150,
    costUsd: 0.006,
    billableTokens: 450,
  });

  // Different run has isolated usage
  const runUsageOther = telemetry.getRunUsage(taskId, 'run-002');
  assert.equal(runUsageOther, undefined);

  // Invalid usage inputs are rejected
  await assert.rejects(
    () =>
      telemetry.recordUsage(taskId, runId, {
        inputTokens: -10,
        outputTokens: 10,
        costUsd: 0.01,
      }),
    /INVALID_NON_NEGATIVE_INTEGER: inputTokens/
  );

  await assert.rejects(
    () =>
      telemetry.recordUsage(taskId, runId, {
        inputTokens: 10,
        outputTokens: -10,
        costUsd: 0.01,
      }),
    /INVALID_NON_NEGATIVE_INTEGER: outputTokens/
  );

  await assert.rejects(
    () =>
      telemetry.recordUsage(taskId, runId, {
        inputTokens: 10,
        outputTokens: 10,
        costUsd: -0.01,
      }),
    /INVALID_NON_NEGATIVE_NUMBER: costUsd/
  );

  await assert.rejects(
    () =>
      telemetry.recordUsage('', runId, {
        inputTokens: 10,
        outputTokens: 10,
        costUsd: 0.01,
      }),
    /non-empty taskId/
  );

  await assert.rejects(
    () =>
      telemetry.recordUsage(taskId, '', {
        inputTokens: 10,
        outputTokens: 10,
        costUsd: 0.01,
      }),
    /non-empty runId/
  );
});

test('fail-closed validation rejects protected stable identifiers with zero sink and stored effects', async () => {
  const sink: ActivityEvent[] = [];
  const telemetry = new SanitizedTelemetry({
    sink: (e) => {
      sink.push(e);
    },
  });

  const protectedFields: Partial<ActivityEvent>[] = [
    { eventId: 'MARKER_SECRET_ID_0123' },
    { taskId: 'MARKER_SECRET_TASK_0123' },
    { runId: 'MARKER_SECRET_RUN_0123' },
    { node: 'MARKER_SECRET_NODE' },
    { actionType: 'MARKER_SECRET_ACTION' },
    { eventId: '.env' },
    { taskId: 'id_rsa' },
  ];

  for (const fieldOverride of protectedFields) {
    const invalidEvent = { ...VALID_EVENT, ...fieldOverride };
    await assert.rejects(
      () => telemetry.emitActivity(invalidEvent),
      /Protected identifier rejected|protected/i
    );
    assert.equal(sink.length, 0, 'Sink must have zero effects on protected identifier');
    assert.equal(telemetry.getEvents().length, 0, 'Stored events must have zero effects on protected identifier');
  }
});

test('fail-closed validation rejects protected path refs with zero sink and stored effects', async () => {
  const sink: ActivityEvent[] = [];
  const telemetry = new SanitizedTelemetry({
    sink: (e) => {
      sink.push(e);
    },
  });

  const protectedRefsList = [
    ['.env'],
    ['.env.local'],
    ['id_rsa'],
    ['credentials.json'],
    ['secrets.json'],
    ['.git/config'],
    ['.agents/workflow.md'],
    ['eval/uc03/private/secret.key'],
    ['safe-ref-1', '.env'],
  ];

  for (const evidenceRefs of protectedRefsList) {
    const invalidEvent = { ...VALID_EVENT, evidenceRefs };
    await assert.rejects(
      () => telemetry.emitActivity(invalidEvent),
      /Protected path reference rejected|protected/i
    );
    assert.equal(sink.length, 0, 'Sink must have zero effects on protected path ref');
    assert.equal(telemetry.getEvents().length, 0, 'Stored events must have zero effects on protected path ref');
  }
});

test('no marker in sink for every emitted field and preserves valid events unchanged', async () => {
  const sink: ActivityEvent[] = [];
  const telemetry = new SanitizedTelemetry({
    sink: (e) => {
      sink.push(e);
    },
  });

  // 1. Preserves valid clean event unchanged
  await telemetry.emitActivity(VALID_EVENT);
  assert.equal(sink.length, 1);
  assert.deepEqual(sink[0], VALID_EVENT);
  assert.deepEqual(telemetry.getEvents(VALID_EVENT.taskId)[0], VALID_EVENT);

  // 2. Emitting an event with secret in outcome and permitted ref redacts them so no marker in sink
  const markerOutcome = 'pass with MARKER_SECRET_OUTCOME_VAL';
  const markerRef = 'evidence-ref-MARKER_SECRET_EVID';
  const eventWithSecrets: ActivityEvent = {
    ...VALID_EVENT,
    eventId: 'evt-clean-123',
    outcome: markerOutcome,
    evidenceRefs: [markerRef, 'clean-evidence-ref'],
  };

  await telemetry.emitActivity(eventWithSecrets);
  assert.equal(sink.length, 2);
  const emitted = sink[1];
  assert.ok(emitted);

  // Verify no marker in ANY emitted field
  const markerRegex = /MARKER_SECRET/i;
  assert.equal(markerRegex.test(emitted.eventId), false);
  assert.equal(markerRegex.test(emitted.taskId), false);
  assert.equal(markerRegex.test(emitted.runId), false);
  assert.equal(markerRegex.test(emitted.timestamp), false);
  assert.equal(markerRegex.test(emitted.node), false);
  assert.equal(markerRegex.test(emitted.actionType), false);
  assert.equal(markerRegex.test(emitted.outcome), false);
  assert.match(emitted.outcome, /\[REDACTED\]/);
  for (const ref of emitted.evidenceRefs) {
    assert.equal(markerRegex.test(ref), false);
  }
  assert.match(emitted.evidenceRefs[0] ?? '', /\[REDACTED\]/);
  assert.equal(emitted.evidenceRefs[1], 'clean-evidence-ref');
});

test('runUsage and recordDiagnostic enforce consistent identity validation', async () => {
  const telemetry = new SanitizedTelemetry({ maxDiagnosticBytes: 256 });
  const validUsage: ProviderUsage = {
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.001,
  };

  // Protected taskId in recordUsage
  await assert.rejects(
    () => telemetry.recordUsage('MARKER_SECRET_TASK_0123', 'run-1', validUsage),
    /Protected identifier rejected/i
  );
  assert.equal(telemetry.getRunUsage('MARKER_SECRET_TASK_0123', 'run-1'), undefined);

  // Protected runId in recordUsage
  await assert.rejects(
    () => telemetry.recordUsage('task-clean-1', 'MARKER_SECRET_RUN_0123', validUsage),
    /Protected identifier rejected/i
  );
  assert.equal(telemetry.getRunUsage('task-clean-1', 'MARKER_SECRET_RUN_0123'), undefined);

  // Protected taskId in recordDiagnostic
  assert.throws(
    () => telemetry.recordDiagnostic('MARKER_SECRET_TASK_0123', 'run-1', 'diag content'),
    /Protected identifier rejected/i
  );

  // Protected runId in recordDiagnostic
  assert.throws(
    () => telemetry.recordDiagnostic('task-clean-1', 'MARKER_SECRET_RUN_0123', 'diag content'),
    /Protected identifier rejected/i
  );

  // Valid identities record correctly
  await telemetry.recordUsage('task-clean-1', 'run-clean-1', validUsage);
  assert.deepEqual(telemetry.getRunUsage('task-clean-1', 'run-clean-1'), validUsage);
});

test('recordUsage and getRunUsage isolate usage across delimiter-collision task and run identities', async () => {
  const telemetry = new SanitizedTelemetry();

  const usage1: ProviderUsage = {
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.002,
    billableTokens: 150,
  };

  const usage2: ProviderUsage = {
    inputTokens: 200,
    outputTokens: 100,
    costUsd: 0.005,
    billableTokens: 300,
  };

  // Identities that collide under naive `${taskId}:${runId}` concatenation
  // Task "a:b" with Run "c" vs Task "a" with Run "b:c"
  await telemetry.recordUsage('a:b', 'c', usage1);
  await telemetry.recordUsage('a', 'b:c', usage2);

  const res1 = telemetry.getRunUsage('a:b', 'c');
  const res2 = telemetry.getRunUsage('a', 'b:c');

  assert.deepEqual(res1, usage1, 'Task a:b run c usage must not cross-correlate with task a run b:c');
  assert.deepEqual(res2, usage2, 'Task a run b:c usage must not cross-correlate with task a:b run c');

  // Additional delimiter variations
  const usage3: ProviderUsage = {
    inputTokens: 50,
    outputTokens: 25,
    costUsd: 0.001,
  };
  await telemetry.recordUsage('a:b:c', 'd', usage3);

  assert.deepEqual(telemetry.getRunUsage('a:b:c', 'd'), usage3);
  assert.deepEqual(telemetry.getRunUsage('a:b', 'c'), usage1);
  assert.deepEqual(telemetry.getRunUsage('a', 'b:c'), usage2);
  assert.equal(telemetry.getRunUsage('a', 'b:c:d'), undefined);
});
