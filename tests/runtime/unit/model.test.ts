import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAdmittedForProduction,
  type TaskState,
  type SourceEvidence,
  type ProviderRequest,
} from '../../../src/contracts/uc03.ts';
import {
  HostModelPort,
  type HostModelTransport,
  type HostModelTransportPayload,
  type AuthoritativeAdmissionLoader,
} from '../../../src/foundation/model.ts';
import {
  createFixtureTaskState,
  createFixtureSourceEvidence,
  createFixtureAdmissionContext,
} from '../support/uc03/port-fixtures.ts';

class StubTransport implements HostModelTransport {
  callCount = 0;
  lastPayload: HostModelTransportPayload | null = null;
  response: unknown = {
    proposal: {
      proposalId: 'proposal-valid-001',
      content: 'Proposed fix for zero division',
    },
    observedUsage: {
      inputTokens: 150,
      outputTokens: 75,
      billableTokens: 225,
      costUsd: 0.005,
    },
  };
  throwError: Error | null = null;

  async execute(payload: HostModelTransportPayload): Promise<unknown> {
    this.callCount++;
    this.lastPayload = payload;
    if (this.throwError) {
      throw this.throwError;
    }
    return this.response;
  }
}

function createValidSetup() {
  const transport = new StubTransport();
  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence({ revisionDigest: state.repositoryRevisionDigest })];
  const { context, request } = createFixtureAdmissionContext();

  const admissionLoader: AuthoritativeAdmissionLoader = async (req: ProviderRequest) => {
    if (req.providerRequestId === request.providerRequestId) {
      return context;
    }
    return null;
  };

  const port = new HostModelPort({
    transport,
    admissionLoader,
    providerConfig: {
      providerId: request.providerId,
      modelId: request.modelId,
      configId: request.configId,
      pricingPolicyId: request.pricingPolicyId,
    },
  });

  return { port, transport, state, evidence, request, context, admissionLoader };
}

// ----------------------------------------------------------------------------
// 1. Production Admissibility and Provenance
// ----------------------------------------------------------------------------

test('HostModelPort: provenance is "real" and admitted for production', () => {
  const { port } = createValidSetup();
  assert.equal(port.provenance, 'real');
  assert.equal(isAdmittedForProduction([port]), true);
});

// ----------------------------------------------------------------------------
// 2. Behavioral Verification: Transport called ONCE on valid admission
// ----------------------------------------------------------------------------

test('HostModelPort: valid admitted request dispatches transport once with enforced caps and untrusted context', async () => {
  const { port, transport, state, evidence, request } = createValidSetup();

  const result = await port.propose(state, evidence, request);

  assert.equal(transport.callCount, 1);
  assert.equal(result.outcome, 'observed');
  if (result.outcome === 'observed') {
    assert.equal(result.result.proposal.proposalId, 'proposal-valid-001');
    assert.equal(result.result.observedUsage.inputTokens, 150);
  }

  // Verify enforced envelope caps were passed to transport
  assert.ok(transport.lastPayload);
  const payload = transport.lastPayload;
  assert.equal(payload.caps.timeoutMs, request.timeoutMs);
  assert.equal(payload.caps.maxInputTokens, request.maxInputTokens);
  assert.equal(payload.caps.maxOutputTokens, request.maxOutputTokens);
  assert.equal(payload.caps.maxBillableTokens, request.maxBillableTokens);
  assert.equal(payload.caps.maxCostUsd, request.maxCostUsd);

  // Verify untrusted context tagging
  assert.equal(payload.untrustedContext.evidenceItems.length, evidence.length);
  assert.equal(payload.untrustedContext.evidenceItems[0]?.isUntrustedRepositoryContent, true);
});

// ----------------------------------------------------------------------------
// 3. Behavioral Verification: ZERO transport calls on invalid state/evidence/request/admission
// ----------------------------------------------------------------------------

test('HostModelPort: ZERO transport calls on invalid TaskState', async () => {
  const { port, transport, state, evidence, request } = createValidSetup();

  // Invalid state: stateVersion must be a positive integer (0 is invalid)
  const invalidState = { ...state, stateVersion: 0 };

  const result = await port.propose(invalidState as unknown as TaskState, evidence, request);

  assert.equal(transport.callCount, 0, 'Transport must NOT be called for invalid TaskState');
  assert.equal(result.outcome, 'invalid');
  if (result.outcome === 'invalid') {
    assert.ok(result.errors.length > 0);
  }
});

test('HostModelPort: ZERO transport calls on invalid SourceEvidence path', async () => {
  const { port, transport, state, request } = createValidSetup();

  // Invalid evidence: protected path (.env)
  const invalidEvidence: SourceEvidence[] = [
    {
      path: '.env',
      revisionDigest: state.repositoryRevisionDigest,
      boundedExcerpt: 'SECRET_KEY=12345',
      resultCount: 1,
      truncated: false,
    },
  ];

  const result = await port.propose(state, invalidEvidence, request);

  assert.equal(transport.callCount, 0, 'Transport must NOT be called for invalid SourceEvidence');
  assert.equal(result.outcome, 'invalid');
});

test('HostModelPort: ZERO transport calls on stale SourceEvidence revision', async () => {
  const { port, transport, state, request } = createValidSetup();

  // Stale evidence: revisionDigest does not match state.repositoryRevisionDigest
  const staleEvidence: SourceEvidence[] = [
    createFixtureSourceEvidence({ revisionDigest: 'sha256:stale-rev-digest' }),
  ];

  const result = await port.propose(state, staleEvidence, request);

  assert.equal(transport.callCount, 0, 'Transport must NOT be called for stale SourceEvidence');
  assert.equal(result.outcome, 'invalid');
  if (result.outcome === 'invalid') {
    assert.ok(result.errors.some((e) => e.code === 'STALE_EVIDENCE_REVISION'));
  }
});

test('HostModelPort: ZERO transport calls on invalid ProviderRequest (invalid role)', async () => {
  const { port, transport, state, evidence, request } = createValidSetup();

  const invalidRequest = { ...request, role: 'unauthorized_role' };

  const result = await port.propose(state, evidence, invalidRequest as unknown as ProviderRequest);

  assert.equal(transport.callCount, 0, 'Transport must NOT be called for invalid ProviderRequest');
  assert.equal(result.outcome, 'invalid');
});

test('HostModelPort: ZERO transport calls on missing/invalid caps in ProviderRequest', async () => {
  const { port, transport, state, evidence, request } = createValidSetup();

  // maxBillableTokens must be >= maxInputTokens + maxOutputTokens
  const invalidCapsRequest = {
    ...request,
    maxInputTokens: 2000,
    maxOutputTokens: 1000,
    maxBillableTokens: 1000, // < 3000
  };

  const result = await port.propose(state, evidence, invalidCapsRequest);

  assert.equal(transport.callCount, 0, 'Transport must NOT be called when caps are violated');
  assert.equal(result.outcome, 'invalid');
});

test('HostModelPort: ZERO transport calls on request/state identity mismatch', async () => {
  const { port, transport, state, evidence, request } = createValidSetup();

  const mismatchRequest = {
    ...request,
    taskId: 'other-task-id',
  };

  const result = await port.propose(state, evidence, mismatchRequest);

  assert.equal(transport.callCount, 0, 'Transport must NOT be called on taskId mismatch');
  assert.equal(result.outcome, 'invalid');
});

test('HostModelPort: ZERO transport calls on host-injected providerConfig mismatch', async () => {
  const { transport, state, evidence, request, context } = createValidSetup();

  // Host configured with different providerId
  const port = new HostModelPort({
    transport,
    admissionLoader: async () => context,
    providerConfig: {
      providerId: 'host-configured-provider-different',
    },
  });

  const result = await port.propose(state, evidence, request);

  assert.equal(transport.callCount, 0, 'Transport must NOT be called on host providerConfig mismatch');
  assert.equal(result.outcome, 'invalid');
});

test('HostModelPort: ZERO transport calls on missing admission context (bare client reservation ref)', async () => {
  const { transport, state, evidence, request } = createValidSetup();

  // Bare reservation ref: admission loader returns null/undefined
  const port = new HostModelPort({
    transport,
    admissionLoader: async () => null,
  });

  const result = await port.propose(state, evidence, request);

  assert.equal(transport.callCount, 0, 'Transport must NOT be called for bare client reservation refs');
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') {
    assert.match(result.reason, /UNTRUSTED_DISPATCH_AUTHORIZATION/);
  }
});

test('HostModelPort: ZERO transport calls when admission loader throws error', async () => {
  const { transport, state, evidence, request } = createValidSetup();

  const port = new HostModelPort({
    transport,
    admissionLoader: async () => {
      throw new Error('Database connection failed');
    },
  });

  const result = await port.propose(state, evidence, request);

  assert.equal(transport.callCount, 0, 'Transport must NOT be called when loader throws');
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') {
    assert.match(result.reason, /ADMISSION_LOADER_FAILED/);
  }
});

test('HostModelPort: ZERO transport calls on canonical admission denial (exhausted budget)', async () => {
  const transport = new StubTransport();
  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence({ revisionDigest: state.repositoryRevisionDigest })];

  // Exhausted budget
  const { context: exhaustedContext, request } = createFixtureAdmissionContext({
    taskTokensConsumed: 100000,
    taskTokensLimit: 100000,
  });

  const port = new HostModelPort({
    transport,
    admissionLoader: async () => exhaustedContext,
  });

  const result = await port.propose(state, evidence, request);

  assert.equal(transport.callCount, 0, 'Transport must NOT be called on exhausted budget');
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') {
    assert.match(result.reason, /BUDGET_EXHAUSTED/);
  }
});

test('HostModelPort: ZERO transport calls on partial reservation bundle', async () => {
  const transport = new StubTransport();
  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence({ revisionDigest: state.repositoryRevisionDigest })];

  // Omit run cost reservation
  const { context: partialContext, request } = createFixtureAdmissionContext({
    omitRunCostRes: true,
  });

  const port = new HostModelPort({
    transport,
    admissionLoader: async () => partialContext,
  });

  const result = await port.propose(state, evidence, request);

  assert.equal(transport.callCount, 0, 'Transport must NOT be called on partial reservation bundle');
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') {
    assert.match(result.reason, /PARTIAL_RESERVATION/);
  }
});

test('HostModelPort: ZERO transport calls on uncertain stored request in history', async () => {
  const transport = new StubTransport();
  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence({ revisionDigest: state.repositoryRevisionDigest })];

  const { context: uncertainContext, request } = createFixtureAdmissionContext({
    includeUncertainStoredRequest: true,
  });

  const port = new HostModelPort({
    transport,
    admissionLoader: async () => uncertainContext,
  });

  const result = await port.propose(state, evidence, request);

  assert.equal(transport.callCount, 0, 'Transport must NOT be called with uncertain request history');
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') {
    assert.match(result.reason, /UNRESOLVED_ACCOUNTING/);
  }
});

// ----------------------------------------------------------------------------
// 4. Raw Provider Response Handling: observed, invalid, uncertain
// ----------------------------------------------------------------------------

test('HostModelPort: returns invalid outcome with observed usage when provider returns malformed proposal', async () => {
  const { port, transport, state, evidence, request } = createValidSetup();

  // Malformed proposal (missing proposalId) but valid observedUsage
  transport.response = {
    proposal: {
      content: 'Missing proposal ID',
    },
    observedUsage: {
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.003,
    },
  };

  const result = await port.propose(state, evidence, request);

  assert.equal(transport.callCount, 1);
  assert.equal(result.outcome, 'invalid');
  if (result.outcome === 'invalid') {
    assert.ok(result.errors.length > 0);
    assert.equal(result.observedUsage?.inputTokens, 100);
  }
});

test('HostModelPort: returns invalid outcome when observed usage exceeds reserved caps', async () => {
  const { port, transport, state, evidence, request } = createValidSetup();

  // Usage exceeds maxInputTokens
  transport.response = {
    proposal: {
      proposalId: 'prop-exceed-001',
      content: 'valid content',
    },
    observedUsage: {
      inputTokens: request.maxInputTokens + 500, // Exceeds cap
      outputTokens: 50,
      costUsd: 0.003,
    },
  };

  const result = await port.propose(state, evidence, request);

  assert.equal(transport.callCount, 1);
  assert.equal(result.outcome, 'invalid');
  if (result.outcome === 'invalid') {
    assert.ok(result.errors.some((e) => e.code === 'USAGE_EXCEEDS_CAPS'));
  }
});

test('HostModelPort: returns uncertain outcome when transport throws timeout', async () => {
  const { port, transport, state, evidence, request } = createValidSetup();

  const timeoutErr = new Error('Request timed out after 30000ms');
  timeoutErr.name = 'TimeoutError';
  transport.throwError = timeoutErr;

  const result = await port.propose(state, evidence, request);

  assert.equal(transport.callCount, 1);
  assert.equal(result.outcome, 'uncertain');
  if (result.outcome === 'uncertain') {
    assert.match(result.reason, /PROVIDER_TIMEOUT/);
  }
});

test('HostModelPort: returns uncertain outcome without leaking secrets when transport throws network error', async () => {
  const { port, transport, state, evidence, request } = createValidSetup();

  // Transport error containing sensitive simulated API key
  const secretKey = 'sk-secret-key-1234567890';
  const networkErr = new Error(`Connection error with api_key=${secretKey} to https://provider.test/v1`);
  transport.throwError = networkErr;

  const result = await port.propose(state, evidence, request);

  assert.equal(transport.callCount, 1);
  assert.equal(result.outcome, 'uncertain');
  if (result.outcome === 'uncertain') {
    assert.equal(result.reason.includes(secretKey), false, 'Error message must not leak credentials');
    assert.match(result.reason, /PROVIDER_ERROR/);
  }
});

// ----------------------------------------------------------------------------
// 5. Tool execution prohibition: model proposals never execute tools
// ----------------------------------------------------------------------------

test('HostModelPort: proposal with actions is observed and returned, never executed', async () => {
  const { port, transport, state, evidence, request } = createValidSetup();

  transport.response = {
    proposal: {
      proposalId: 'prop-with-actions-001',
      content: 'Fixing bug by command',
      actions: [
        {
          actionId: 'act-run-001',
          kind: 'run_command',
          executable: 'pytest',
          argv: ['-q'],
          workingDirectory: 'tests',
        },
      ],
    },
    observedUsage: {
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.003,
    },
  };

  const result = await port.propose(state, evidence, request);

  assert.equal(transport.callCount, 1);
  assert.equal(result.outcome, 'observed');
  if (result.outcome === 'observed') {
    assert.equal(result.result.proposal.actions?.length, 1);
    assert.equal(result.result.proposal.actions?.[0]?.kind, 'run_command');
  }
});
