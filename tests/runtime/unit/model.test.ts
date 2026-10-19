import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAdmittedForProduction,
  type TaskState,
  type SourceEvidence,
  type ProviderRequest,
} from '../../../src/contracts/foundation/uc03.ts';
import {
  HostModelPort,
  computeContextDigest,
  containsProtectedContent,
  type HostModelTransport,
  type HostModelTransportPayload,
  type AuthoritativeAdmissionLoader,
} from '../../../src/foundation/model.ts';
import {
  createFixtureTaskState,
  createFixtureSourceEvidence,
  createFixtureAdmissionContext,
  createFixtureProviderRequest,
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
  const contextDigest = computeContextDigest(state, evidence);
  const baseRequest = createFixtureProviderRequest({ contextDigest });
  const { context, request } = createFixtureAdmissionContext({ request: baseRequest });

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

  return { port, transport, state, evidence, request, context, admissionLoader, contextDigest };
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
  const contextDigest = computeContextDigest(state, evidence);

  // Exhausted budget
  const { context: exhaustedContext, request } = createFixtureAdmissionContext({
    request: createFixtureProviderRequest({ contextDigest }),
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
  const contextDigest = computeContextDigest(state, evidence);

  // Omit run cost reservation
  const { context: partialContext, request } = createFixtureAdmissionContext({
    request: createFixtureProviderRequest({ contextDigest }),
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
  const contextDigest = computeContextDigest(state, evidence);

  const { context: uncertainContext, request } = createFixtureAdmissionContext({
    request: createFixtureProviderRequest({ contextDigest }),
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

// ----------------------------------------------------------------------------
// 6. Context Digest and Protected Content Boundary Verification (T008-a Fixes)
// ----------------------------------------------------------------------------

test('computeContextDigest: deterministic and binds state/evidence semantics', () => {
  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence({ revisionDigest: state.repositoryRevisionDigest })];

  const digest1 = computeContextDigest(state, evidence);
  const digest2 = computeContextDigest({ state, evidence });
  assert.equal(digest1, digest2, 'Digest must be deterministic across parameter styles');
  assert.match(digest1, /^sha256:[a-f0-9]{64}$/);

  // Changing evidence boundedExcerpt alters digest
  const modifiedExcerpt = [createFixtureSourceEvidence({ revisionDigest: state.repositoryRevisionDigest, boundedExcerpt: 'different content' })];
  assert.notEqual(computeContextDigest(state, modifiedExcerpt), digest1);

  // Changing evidence path alters digest
  const modifiedPath = [createFixtureSourceEvidence({ path: 'src/other.py', revisionDigest: state.repositoryRevisionDigest })];
  assert.notEqual(computeContextDigest(state, modifiedPath), digest1);

  // Changing evidence revisionDigest alters digest
  const modifiedRev = [createFixtureSourceEvidence({ revisionDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' })];
  assert.notEqual(computeContextDigest(state, modifiedRev), digest1);

  // Changing state semantics alters digest
  const modifiedState = { ...state, goal: 'completely altered goal' };
  assert.notEqual(computeContextDigest(modifiedState, evidence), digest1);
});

test('containsProtectedContent: detects marker secrets, keys, and tokens', () => {
  assert.equal(containsProtectedContent('MARKER_SECRET_UNAPPROVED_CONTEXT'), true);
  assert.equal(containsProtectedContent('something MARKER_SECRET present'), true);
  assert.equal(containsProtectedContent('SECRET_KEY=abcdef123456'), true);
  assert.equal(containsProtectedContent('sk-secret-key-12345'), true);
  assert.equal(containsProtectedContent('api_key=secret-token-xyz'), true);
  assert.equal(containsProtectedContent('-----BEGIN RSA PRIVATE KEY-----'), true);
  assert.equal(containsProtectedContent('def divide(a, b):\n    return a / b\n'), false);
});

test('HostModelPort: ZERO transport calls when evidence excerpt is swapped to unapproved content', async () => {
  const { port, transport, state, request } = createValidSetup();

  // Swapped evidence excerpt without updating request contextDigest
  const unapprovedEvidence = [
    createFixtureSourceEvidence({
      revisionDigest: state.repositoryRevisionDigest,
      boundedExcerpt: 'def divide(a, b):\n    return a / (b or 1)\n',
    }),
  ];

  const result = await port.propose(state, unapprovedEvidence, request);

  assert.equal(transport.callCount, 0, 'Transport must NEVER be called on unapproved evidence excerpt');
  assert.equal(result.outcome, 'invalid');
  if (result.outcome === 'invalid') {
    assert.ok(result.errors.some((e) => e.path === 'contextDigest' && e.code === 'REQUEST_IDENTITY_MISMATCH'));
  }
});

test('HostModelPort: ZERO transport calls on MARKER_SECRET_UNAPPROVED_CONTEXT and no secret leak', async () => {
  const { port, transport, state, request } = createValidSetup();

  const secretMarker = 'MARKER_SECRET_UNAPPROVED_CONTEXT';
  const unapprovedEvidence = [
    createFixtureSourceEvidence({
      revisionDigest: state.repositoryRevisionDigest,
      boundedExcerpt: secretMarker,
    }),
  ];

  const result = await port.propose(state, unapprovedEvidence, request);

  assert.equal(transport.callCount, 0, 'Transport must NEVER dispatch secret marker');
  assert.equal(result.outcome, 'invalid');
  if (result.outcome === 'invalid') {
    assert.ok(result.errors.some((e) => e.code === 'PROTECTED_CONTENT_FORBIDDEN'));
    // Verify secret marker is not leaked in error messages
    const serialized = JSON.stringify(result.errors);
    assert.equal(serialized.includes(secretMarker), false, 'Secret marker must not be leaked in errors');
  }
});

test('HostModelPort: ZERO transport calls on embedded secret in schema-valid path', async () => {
  const { port, transport, state, request } = createValidSetup();

  const rawSecret = 'sk-prod-api-key-99999999';
  const embeddedSecretEvidence = [
    createFixtureSourceEvidence({
      path: 'src/calculator.py', // Schema-valid path
      revisionDigest: state.repositoryRevisionDigest,
      boundedExcerpt: `def get_client():\n    return Client(api_key='${rawSecret}')\n`,
    }),
  ];

  const result = await port.propose(state, embeddedSecretEvidence, request);

  assert.equal(transport.callCount, 0, 'Transport must NOT be called for embedded secret even in schema-valid path');
  assert.equal(result.outcome, 'invalid');
  if (result.outcome === 'invalid') {
    assert.ok(result.errors.some((e) => e.code === 'PROTECTED_CONTENT_FORBIDDEN'));
    const serialized = JSON.stringify(result.errors);
    assert.equal(serialized.includes(rawSecret), false, 'Raw secret must not be leaked in error message');
  }
});

test('HostModelPort: ZERO transport calls when caller reuses old valid request against modified payload', async () => {
  const { transport, state } = createValidSetup();

  // Create baseline context and request
  const baselineEvidence = [createFixtureSourceEvidence({ revisionDigest: state.repositoryRevisionDigest })];
  const baselineDigest = computeContextDigest(state, baselineEvidence);
  const { context, request: oldRequest } = createFixtureAdmissionContext({
    request: createFixtureProviderRequest({ contextDigest: baselineDigest }),
  });

  const port = new HostModelPort({
    transport,
    admissionLoader: async () => context,
  });

  // Modified evidence with new digest
  const modifiedEvidence = [
    createFixtureSourceEvidence({
      revisionDigest: state.repositoryRevisionDigest,
      boundedExcerpt: 'def divide(a, b):\n    return a // b\n',
    }),
  ];
  const newDigest = computeContextDigest(state, modifiedEvidence);

  // Attempt 1: Caller passes old request with old receipt digest -> fails in validateProviderRequest
  const result1 = await port.propose(state, modifiedEvidence, oldRequest);
  assert.equal(transport.callCount, 0);
  assert.equal(result1.outcome, 'invalid');

  // Attempt 2: Caller updates request.contextDigest to newDigest without host re-approval
  // Host loader still returns context with old expectedRequest.contextDigest
  const forgedRequest: ProviderRequest = {
    ...oldRequest,
    contextDigest: newDigest,
  };
  const result2 = await port.propose(state, modifiedEvidence, forgedRequest);
  assert.equal(transport.callCount, 0);
  assert.equal(result2.outcome, 'denied');
});

test('HostModelPort: caller boolean flags cannot bypass admission', async () => {
  const { port, transport, state, evidence, request } = createValidSetup();

  // Caller attempts to attach extra bypass flags
  const tamperedRequest = {
    ...request,
    isApproved: true,
    bypassAdmission: true,
  };

  const result = await port.propose(state, evidence, tamperedRequest as unknown as ProviderRequest);

  assert.equal(transport.callCount, 0, 'Transport must NOT be called on tampered request with unauthorized keys');
  assert.equal(result.outcome, 'invalid');
});

// ----------------------------------------------------------------------------
// 7. Synchronous Deep Snapshot & Mutation Resistance (T008-a-immutable)
// ----------------------------------------------------------------------------

test('HostModelPort: caller async mutation of evidence boundedExcerpt during admission loader wait does NOT alter dispatched transport payload', async () => {
  const transport = new StubTransport();
  const state = createFixtureTaskState();
  const originalExcerpt = 'def divide(a, b):\n    return a / b\n';
  const evidence = [createFixtureSourceEvidence({ revisionDigest: state.repositoryRevisionDigest, boundedExcerpt: originalExcerpt })];
  const contextDigest = computeContextDigest(state, evidence);
  const baseRequest = createFixtureProviderRequest({ contextDigest });
  const { context, request } = createFixtureAdmissionContext({ request: baseRequest });

  let releaseLoader!: () => void;
  const loaderWait = new Promise<void>((resolve) => {
    releaseLoader = resolve;
  });

  const admissionLoader: AuthoritativeAdmissionLoader = async (req: ProviderRequest) => {
    await loaderWait;
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

  // Start propose seam
  const pending = port.propose(state, evidence, request);

  // Synchronously mutate caller evidence while admission is deferred
  (evidence[0] as { boundedExcerpt: string }).boundedExcerpt = 'MARKER_SECRET_ASYNC_MUTATION';
  (evidence as SourceEvidence[]).push(
    createFixtureSourceEvidence({
      path: 'src/secret.py',
      revisionDigest: state.repositoryRevisionDigest,
      boundedExcerpt: 'UNAPPROVED_CONTEXT_MARKER',
    })
  );

  // Resume admission loader
  releaseLoader();
  const result = await pending;

  assert.equal(transport.callCount, 1);
  assert.equal(result.outcome, 'observed');
  assert.ok(transport.lastPayload);
  assert.equal(transport.lastPayload.evidence.length, 1);
  assert.equal(transport.lastPayload.evidence[0]?.boundedExcerpt, originalExcerpt);
  assert.equal(transport.lastPayload.untrustedContext.evidenceItems.length, 1);
  assert.equal(transport.lastPayload.untrustedContext.evidenceItems[0]?.content, originalExcerpt);

  // Secret marker must be completely absent from transport payload and result
  const serializedPayload = JSON.stringify(transport.lastPayload);
  assert.equal(serializedPayload.includes('MARKER_SECRET'), false);
  assert.equal(serializedPayload.includes('UNAPPROVED_CONTEXT'), false);
  const serializedResult = JSON.stringify(result);
  assert.equal(serializedResult.includes('MARKER_SECRET'), false);
});

test('HostModelPort: caller async mutation of state arrays and taskContext during admission loader wait does NOT alter dispatched transport payload', async () => {
  const transport = new StubTransport();
  const state = createFixtureTaskState();
  const originalCriteria = [...state.acceptanceCriteria];
  const originalGoal = state.goal;
  const originalTaskContextGoal = state.taskContext?.goal;

  const evidence = [createFixtureSourceEvidence({ revisionDigest: state.repositoryRevisionDigest })];
  const contextDigest = computeContextDigest(state, evidence);
  const baseRequest = createFixtureProviderRequest({ contextDigest });
  const { context, request } = createFixtureAdmissionContext({ request: baseRequest });

  let releaseLoader!: () => void;
  const loaderWait = new Promise<void>((resolve) => {
    releaseLoader = resolve;
  });

  const admissionLoader: AuthoritativeAdmissionLoader = async (req: ProviderRequest) => {
    await loaderWait;
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

  const pending = port.propose(state, evidence, request);

  // Mutate state nested arrays, taskContext, and fields while loader waits
  (state.acceptanceCriteria as string[]).push('MUTATED_CRITERIA_UNAPPROVED');
  (state.constraints as string[]).push('MUTATED_CONSTRAINT_UNAPPROVED');
  (state.changedPaths as string[]).push('src/mutated.py');
  if (state.taskContext) {
    (state.taskContext as { goal: string }).goal = 'MUTATED_TASK_CONTEXT_GOAL';
    (state.taskContext.acceptanceCriteria as string[]).push('MUTATED_CRITERIA_UNAPPROVED');
  }
  (state as { goal: string }).goal = 'MUTATED_TOP_LEVEL_GOAL';

  releaseLoader();
  const result = await pending;

  assert.equal(transport.callCount, 1);
  assert.equal(result.outcome, 'observed');
  assert.ok(transport.lastPayload);
  assert.deepEqual(transport.lastPayload.state.acceptanceCriteria, originalCriteria);
  assert.equal(transport.lastPayload.state.goal, originalGoal);
  assert.equal(transport.lastPayload.state.taskContext?.goal, originalTaskContextGoal);

  const serializedPayload = JSON.stringify(transport.lastPayload);
  assert.equal(serializedPayload.includes('MUTATED_CRITERIA_UNAPPROVED'), false);
  assert.equal(serializedPayload.includes('MUTATED_TASK_CONTEXT_GOAL'), false);
  assert.equal(serializedPayload.includes('MUTATED_TOP_LEVEL_GOAL'), false);
});

test('HostModelPort: caller async mutation of request and host providerConfig during admission loader wait does NOT alter caps or identity', async () => {
  const transport = new StubTransport();
  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence({ revisionDigest: state.repositoryRevisionDigest })];
  const contextDigest = computeContextDigest(state, evidence);
  const baseRequest = createFixtureProviderRequest({ contextDigest });
  const { context, request: fixtureRequest } = createFixtureAdmissionContext({ request: baseRequest });
  const request = { ...fixtureRequest };
  const originalCost = request.maxCostUsd;
  const originalInputTokens = request.maxInputTokens;

  let releaseLoader!: () => void;
  const loaderWait = new Promise<void>((resolve) => {
    releaseLoader = resolve;
  });

  const admissionLoader: AuthoritativeAdmissionLoader = async (req: ProviderRequest) => {
    await loaderWait;
    if (req.providerRequestId === request.providerRequestId) {
      return context;
    }
    return null;
  };

  const providerConfig = {
    providerId: request.providerId,
    modelId: request.modelId,
    configId: request.configId,
    pricingPolicyId: request.pricingPolicyId,
  };

  const port = new HostModelPort({
    transport,
    admissionLoader,
    providerConfig,
  });

  const pending = port.propose(state, evidence, request);

  // Mutate caller request and host config while loader is deferred
  (request as { maxCostUsd: number }).maxCostUsd = 999999;
  (request as { maxInputTokens: number }).maxInputTokens = 999999;
  (providerConfig as { providerId: string }).providerId = 'MUTATED_HOST_PROVIDER_CONFIG';

  releaseLoader();
  const result = await pending;

  assert.equal(transport.callCount, 1);
  assert.equal(result.outcome, 'observed');
  assert.ok(transport.lastPayload);
  assert.equal(transport.lastPayload.request.maxCostUsd, originalCost);
  assert.equal(transport.lastPayload.caps.maxCostUsd, originalCost);
  assert.equal(transport.lastPayload.caps.maxInputTokens, originalInputTokens);
  assert.equal(transport.lastPayload.request.providerId, request.providerId);
});

test('HostModelPort: caller objects are NOT frozen or shallow-cloned, internal payload is frozen', async () => {
  const { port, transport, state, evidence, request } = createValidSetup();

  const result = await port.propose(state, evidence, request);

  assert.equal(result.outcome, 'observed');
  assert.equal(transport.callCount, 1);

  // Caller objects must NOT be frozen
  assert.equal(Object.isFrozen(state), false, 'Caller state must not be frozen');
  assert.equal(Object.isFrozen(state.acceptanceCriteria), false, 'Caller state arrays must not be frozen');
  assert.equal(Object.isFrozen(evidence), false, 'Caller evidence must not be frozen');
  assert.equal(Object.isFrozen(evidence[0]), false, 'Caller evidence item must not be frozen');
  assert.equal(Object.isFrozen(request), false, 'Caller request must not be frozen');

  // Internal transport payload must be deeply frozen
  assert.ok(transport.lastPayload);
  assert.equal(Object.isFrozen(transport.lastPayload), true, 'Transport payload must be frozen');
  assert.equal(Object.isFrozen(transport.lastPayload.state), true, 'Snapshot state must be frozen');
  assert.equal(Object.isFrozen(transport.lastPayload.evidence), true, 'Snapshot evidence must be frozen');
  assert.equal(Object.isFrozen(transport.lastPayload.request), true, 'Snapshot request must be frozen');
  assert.equal(Object.isFrozen(transport.lastPayload.caps), true, 'Snapshot caps must be frozen');
  assert.equal(Object.isFrozen(transport.lastPayload.untrustedContext), true, 'Snapshot untrustedContext must be frozen');
});

test('HostModelPort: admission loader attempting to mutate request argument cannot alter transport payload', async () => {
  const transport = new StubTransport();
  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence({ revisionDigest: state.repositoryRevisionDigest })];
  const contextDigest = computeContextDigest(state, evidence);
  const baseRequest = createFixtureProviderRequest({ contextDigest });
  const { context, request } = createFixtureAdmissionContext({ request: baseRequest });
  const originalCost = request.maxCostUsd;

  const admissionLoader: AuthoritativeAdmissionLoader = async (loaderReq: ProviderRequest) => {
    try {
      (loaderReq as { maxCostUsd: number }).maxCostUsd = 999999;
    } catch {
      // TypeError expected because loaderReq is frozen
    }
    return context;
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

  const result = await port.propose(state, evidence, request);

  assert.equal(transport.callCount, 1);
  assert.equal(result.outcome, 'observed');
  assert.ok(transport.lastPayload);
  assert.equal(transport.lastPayload.request.maxCostUsd, originalCost);
  assert.equal(transport.lastPayload.caps.maxCostUsd, originalCost);
});

test('HostModelPort: fail-closed ZERO transport calls when unapproved secret is present initially even with deferred loader', async () => {
  const transport = new StubTransport();
  const state = createFixtureTaskState();
  const secretMarker = 'MARKER_SECRET_INITIAL_UNAPPROVED';
  const unapprovedEvidence = [
    createFixtureSourceEvidence({
      revisionDigest: state.repositoryRevisionDigest,
      boundedExcerpt: secretMarker,
    }),
  ];
  const baseRequest = createFixtureProviderRequest({ contextDigest: 'sha256:dummy' });
  const { context, request } = createFixtureAdmissionContext({ request: baseRequest });

  let loaderInvoked = false;
  const admissionLoader: AuthoritativeAdmissionLoader = async () => {
    loaderInvoked = true;
    return context;
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

  const result = await port.propose(state, unapprovedEvidence, request);

  assert.equal(transport.callCount, 0, 'Transport must NEVER be called');
  assert.equal(loaderInvoked, false, 'Admission loader must not be invoked on invalid initial snapshot');
  assert.equal(result.outcome, 'invalid');
  if (result.outcome === 'invalid') {
    assert.ok(result.errors.some((e) => e.code === 'PROTECTED_CONTENT_FORBIDDEN'));
    const serialized = JSON.stringify(result.errors);
    assert.equal(serialized.includes(secretMarker), false, 'Secret marker must not be leaked');
  }
});
