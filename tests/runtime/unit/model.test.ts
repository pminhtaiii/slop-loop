import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAdmittedForProduction,
  type TaskState,
  type SourceEvidence,
  type ProviderRequest,
  type ProviderAdmissionContextV02,
  computeCanonicalSha256,
} from '../../../src/contracts/foundation/uc03.ts';
import {
  HostModelPortV02,
} from '../../../src/foundation/model.ts';
import {
  MemoryStatePortV02,
} from '../support/uc03/memory-state.ts';
import {
  createTestAdmissionTaskStateV02,
  createTestProviderAdmissionContextV02,
  createTestProviderRequest,
} from '../support/uc03/state-fixtures.ts';
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

function authorityForV02(context: ProviderAdmissionContextV02) {
  return {
    policyId: context.providerIdentity.pricingPolicyId,
    policyVersion: context.providerIdentity.pricingPolicyVersion,
    configId: context.providerIdentity.configId,
    configVersion: context.providerIdentity.configVersion,
    issuerKeyRef: context.providerIdentity.issuerKeyRef,
    decisionAuthorityGeneration: context.providerIdentity.decisionAuthorityGeneration,
  };
}

function createValidV02Setup(options?: {
  role?: 'coder' | 'reviewer';
  planApplicability?: 'pre-plan-diagnostic' | 'approved-plan';
  requestId?: string;
  statePort?: MemoryStatePortV02;
  transport?: StubTransport;
}) {
  const role = options?.role ?? 'coder';
  const planApplicability = options?.planApplicability ?? 'approved-plan';
  const requestId = options?.requestId ?? 'req-prov-v02-001';

  const transport = options?.transport ?? new StubTransport();
  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence({ revisionDigest: state.repositoryRevisionDigest })];

  const dummyReq = createTestProviderRequest({
    providerRequestId: requestId,
    taskId: state.taskId,
    runId: state.runId,
    role,
    contextDigest: 'sha256:placeholder',
  });

  const dummyContext = createTestProviderAdmissionContextV02({
    taskId: state.taskId,
    runId: state.runId,
    planApplicability,
    runnableNode: planApplicability === 'pre-plan-diagnostic' ? 'Investigate' : 'Repair',
    ...(planApplicability === 'pre-plan-diagnostic'
      ? {
          diagnosticPurpose: 'baseline diagnostic',
          taskCriteriaDigest: computeCanonicalSha256(state.acceptanceCriteria),
          planBindingDigest: undefined,
          planDecisionRef: undefined,
        }
      : {}),
    providerRequest: dummyReq,
  });

  const initialTaskState = createTestAdmissionTaskStateV02(dummyContext);
  const taskState: TaskState = {
    ...initialTaskState,
    repositoryRevisionDigest: state.repositoryRevisionDigest,
  };

  const contextDigest = computeContextDigest(taskState, evidence);

  const baseRequest = createTestProviderRequest({
    providerRequestId: requestId,
    taskId: taskState.taskId,
    runId: taskState.runId,
    role,
    contextDigest,
  });

  const baseContext = createTestProviderAdmissionContextV02({
    taskId: taskState.taskId,
    runId: taskState.runId,
    planApplicability,
    runnableNode: planApplicability === 'pre-plan-diagnostic' ? 'Investigate' : 'Repair',
    ...(planApplicability === 'pre-plan-diagnostic'
      ? {
          diagnosticPurpose: 'baseline diagnostic',
          taskCriteriaDigest: computeCanonicalSha256(taskState.acceptanceCriteria),
          planBindingDigest: undefined,
          planDecisionRef: undefined,
        }
      : {}),
    providerRequest: baseRequest,
  });

  const context: ProviderAdmissionContextV02 = baseContext;
  const authority = authorityForV02(context);
  const statePort = options?.statePort ?? new MemoryStatePortV02({
    initialTaskState: taskState,
    initialAuthorityRef: authority,
    initialControlVersion: context.expectedControlVersion,
    initialEpoch: context.expectedEpoch,
  });

  const actor = { adapterIdentity: 'test-provider', processIncarnation: randomUUID(), fencingGeneration: 1 };
  const port = new HostModelPortV02({
    transport,
    statePort,
    executorIdentity: actor,
    currentExecutorIdentity: () => actor,
    providerConfig: {
      providerId: baseRequest.providerId,
      modelId: baseRequest.modelId,
      configId: baseRequest.configId,
      pricingPolicyId: baseRequest.pricingPolicyId,
    },
  });

  return { port, transport, statePort, actor, state: taskState, evidence, request: baseRequest, context, contextDigest, authority };
}

// ----------------------------------------------------------------------------
// 8. Versioned ModelPortV02 Tests (T051 RED / T052 GREEN)
// ----------------------------------------------------------------------------

test('HostModelPortV02: mock-backed facade cannot enter production', () => {
  const { port } = createValidV02Setup();
  assert.equal(port.provenance, 'mock');
  assert.equal(isAdmittedForProduction([port]), false);
});

test('HostModelPortV02: positive coder dispatch succeeds and settles outcome (T052 GREEN)', async () => {
  const { port, transport, state, evidence, request, context, statePort } = createValidV02Setup({ role: 'coder' });

  const result = await port.propose(state, evidence, request, context);

  assert.equal(transport.callCount, 1);
  assert.equal(result.outcome, 'observed');
  const journal = statePort.getJournalSnapshot();
  assert.equal(journal.outcomes.length, 1);
  assert.equal(journal.outcomes[0]?.outcome, 'observed');
});

test('HostModelPortV02: positive reviewer dispatch succeeds and settles outcome (T052 GREEN)', async () => {
  const { port, transport, state, evidence, request, context, statePort } = createValidV02Setup({ role: 'reviewer' });

  const result = await port.propose(state, evidence, request, context);

  assert.equal(transport.callCount, 1);
  assert.equal(result.outcome, 'observed');
  const journal = statePort.getJournalSnapshot();
  assert.equal(journal.outcomes.length, 1);
  assert.equal(journal.outcomes[0]?.outcome, 'observed');
});

test('HostModelPortV02: ZERO transport calls on missing admission context', async () => {
  const { port, transport, state, evidence, request } = createValidV02Setup();

  const result = await port.propose(state, evidence, request, null as unknown as ProviderAdmissionContextV02);

  assert.equal(transport.callCount, 0, 'Transport must not be called on missing admission context');
  assert.equal(result.outcome, 'denied');
});

test('HostModelPortV02: ZERO transport calls on stale evidence revision', async () => {
  const { port, transport, state, request, context } = createValidV02Setup();
  const staleEvidence: SourceEvidence[] = [
    createFixtureSourceEvidence({ revisionDigest: 'sha256:stale-rev-digest' }),
  ];

  const result = await port.propose(state, staleEvidence, request, context);

  assert.equal(transport.callCount, 0, 'Transport must not be called on stale evidence revision');
  assert.equal(result.outcome, 'invalid');
});

test('HostModelPortV02: ZERO transport calls on cross-role context (coder request with reviewer context)', async () => {
  const coderSetup = createValidV02Setup({ role: 'coder' });
  const reviewerSetup = createValidV02Setup({ role: 'reviewer' });

  const result = await coderSetup.port.propose(coderSetup.state, coderSetup.evidence, coderSetup.request, reviewerSetup.context);

  assert.equal(coderSetup.transport.callCount, 0, 'Transport must not be called on cross-role context');
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') {
    assert.match(result.reason ?? '', /ROLE_MISMATCH/);
  }
});

test('HostModelPortV02: ZERO transport calls on request ID mismatch', async () => {
  const { port, transport, state, evidence, request, context } = createValidV02Setup();
  const mismatchedRequest = { ...request, providerRequestId: 'req-mismatched-id' };

  const result = await port.propose(state, evidence, mismatchedRequest, context);

  assert.equal(transport.callCount, 0, 'Transport must not be called on request ID mismatch');
  assert.equal(result.outcome, 'denied');
});

test('HostModelPortV02: ZERO transport calls on request content digest mismatch', async () => {
  const { port, transport, state, evidence, request, context } = createValidV02Setup();
  const tamperedContext: ProviderAdmissionContextV02 = {
    ...context,
    requestContentDigest: 'sha256:tampered-digest-000000000000000000000000000000000000000000000000',
  };

  const result = await port.propose(state, evidence, request, tamperedContext);

  assert.equal(transport.callCount, 0, 'Transport must not be called on request content digest mismatch');
  assert.equal(result.outcome, 'denied');
});

// ----------------------------------------------------------------------------
// 9. Section 10 Mapped Seam Checks (Cases 9, 14, 15, 16, 19)
// ----------------------------------------------------------------------------

test('HostModelPortV02 Section 10 Case 9: crash or timeout records uncertain outcome and hold disposition in journal', async () => {
  const { port, transport, state, evidence, request, context, statePort } = createValidV02Setup();
  const timeoutErr = new Error('Transport timed out after 30000ms');
  timeoutErr.name = 'TimeoutError';
  transport.throwError = timeoutErr;

  const result = await port.propose(state, evidence, request, context);

  assert.equal(transport.callCount, 1);
  assert.equal(result.outcome, 'uncertain');
  const journal = statePort.getJournalSnapshot();
  assert.equal(journal.outcomes.length, 1);
  assert.equal(journal.outcomes[0]?.outcome, 'uncertain');
});

test('HostModelPortV02 Section 10 Case 9: network error records uncertain outcome without leaking secrets', async () => {
  const { port, transport, state, evidence, request, context, statePort } = createValidV02Setup();
  const secretKey = 'sk-model-leak-test-9999999999';
  transport.throwError = new Error(`Connection failed with api_key=${secretKey}`);

  const result = await port.propose(state, evidence, request, context);

  assert.equal(transport.callCount, 1);
  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.reason?.includes(secretKey), false, 'Reason must not leak secret');
  const journal = statePort.getJournalSnapshot();
  assert.equal(journal.outcomes.length, 1);
  assert.equal(journal.outcomes[0]?.outcome, 'uncertain');
});

test('HostModelPortV02 Section 10 Case 14: duplicate request reuses claim and never invokes transport twice', async () => {
  const { port, transport, state, evidence, request, context } = createValidV02Setup();

  const firstResult = await port.propose(state, evidence, request, context);
  assert.equal(transport.callCount, 1);
  assert.equal(firstResult.outcome, 'observed');

  // Second propose call with exact duplicate request reuses result without invoking transport again
  const secondResult = await port.propose(state, evidence, request, context);
  assert.equal(transport.callCount, 1, 'Transport must NEVER be called twice for duplicate request');
  assert.deepEqual(secondResult, firstResult);
});

test('HostModelPortV02 Section 10 Case 14: competing request denied with zero transport when active claim exists', async () => {
  const setup1 = createValidV02Setup({ requestId: 'req-competing-001' });
  const setup2 = createValidV02Setup({ requestId: 'req-competing-002', statePort: setup1.statePort });

  // Start propose 1, claiming the active lease
  const claim1 = await setup1.statePort.claim(setup1.context);
  assert.ok(claim1.claimId);

  // Competing request 2 tries to propose while claim 1 is active in statePort
  const result2 = await setup2.port.propose(setup2.state, setup2.evidence, setup2.request, setup2.context);

  assert.equal(setup2.transport.callCount, 0, 'Transport must not be called on competing request');
  assert.equal(result2.outcome, 'denied');
});

test('HostModelPortV02 retries only a pre-claim denial after the competing claim settles', async () => {
  let releaseFirstDispatch!: () => void;
  let enterFirstDispatch!: () => void;
  const firstDispatchEntered = new Promise<void>((resolve) => { enterFirstDispatch = resolve; });
  const firstDispatchBarrier = new Promise<void>((resolve) => { releaseFirstDispatch = resolve; });
  const firstTransport = new StubTransport();
  const executeFirst = firstTransport.execute.bind(firstTransport);
  firstTransport.execute = async (payload) => {
    enterFirstDispatch();
    await firstDispatchBarrier;
    return await executeFirst(payload);
  };

  const first = createValidV02Setup({ requestId: 'req-active-claim', transport: firstTransport });
  const firstResultPromise = first.port.propose(first.state, first.evidence, first.request, first.context);
  await firstDispatchEntered;

  const competing = createValidV02Setup({ requestId: 'req-retry-after-claim', statePort: first.statePort });
  const beforeDenial = first.statePort.getJournalSnapshot();
  const ledgersBeforeDenial = first.statePort.getUnderlying().getLedgers();
  const denied = await competing.port.propose(competing.state, competing.evidence, competing.request, competing.context);
  assert.equal(denied.outcome, 'denied');
  assert.match(denied.reason ?? '', /^CLAIM_DENIED:/u);
  assert.equal(competing.transport.callCount, 0);
  assert.deepEqual(first.statePort.getJournalSnapshot(), beforeDenial);
  assert.deepEqual(first.statePort.getUnderlying().getLedgers(), ledgersBeforeDenial);

  releaseFirstDispatch();
  assert.equal((await firstResultPromise).outcome, 'observed');
  const refreshedContext = createTestProviderAdmissionContextV02({
    providerRequest: competing.request,
    expectedTaskStateVersion: competing.context.expectedTaskStateVersion,
    expectedControlVersion: first.statePort.getJournalSnapshot().controlVersion,
    expectedEpoch: competing.context.expectedEpoch,
    runnableNode: competing.context.runnableNode,
    planApplicability: competing.context.planApplicability,
    planBindingDigest: competing.context.planBindingDigest,
    planDecisionRef: competing.context.planDecisionRef,
    budgetRefs: competing.context.budgetRefs,
  });
  const retried = await competing.port.propose(competing.state, competing.evidence, competing.request, refreshedContext);

  assert.equal(retried.outcome, 'observed');
  assert.equal(competing.transport.callCount, 1);
  const journal = first.statePort.getJournalSnapshot();
  assert.equal(journal.claims.length, 2);
  assert.equal(journal.attempts.length, 2);
  assert.equal(journal.outcomes.length, 2);
  assert.equal(journal.activeClaimId, null);
});

test('HostModelPortV02 Section 10 Case 15: provider branch for coder and reviewer both settle cleanly', async () => {
  const coderSetup = createValidV02Setup({ role: 'coder', requestId: 'req-branch-coder' });
  const coderResult = await coderSetup.port.propose(coderSetup.state, coderSetup.evidence, coderSetup.request, coderSetup.context);
  assert.equal(coderSetup.transport.callCount, 1);
  assert.equal(coderResult.outcome, 'observed');
  assert.equal(coderSetup.statePort.getJournalSnapshot().outcomes[0]?.outcome, 'observed');

  const reviewerSetup = createValidV02Setup({ role: 'reviewer', requestId: 'req-branch-reviewer' });
  const reviewerResult = await reviewerSetup.port.propose(reviewerSetup.state, reviewerSetup.evidence, reviewerSetup.request, reviewerSetup.context);
  assert.equal(reviewerSetup.transport.callCount, 1);
  assert.equal(reviewerResult.outcome, 'observed');
  assert.equal(reviewerSetup.statePort.getJournalSnapshot().outcomes[0]?.outcome, 'observed');
});

test('HostModelPortV02 Section 10 Case 16: pre-plan diagnostic vs approved plan settlement', async () => {
  const prePlanSetup = createValidV02Setup({ planApplicability: 'pre-plan-diagnostic', requestId: 'req-preplan-001' });
  const prePlanResult = await prePlanSetup.port.propose(prePlanSetup.state, prePlanSetup.evidence, prePlanSetup.request, prePlanSetup.context);
  assert.equal(prePlanSetup.transport.callCount, 1);
  assert.equal(prePlanResult.outcome, 'observed');
  assert.equal(prePlanSetup.statePort.getJournalSnapshot().outcomes[0]?.outcome, 'observed');

  const approvedPlanSetup = createValidV02Setup({ planApplicability: 'approved-plan', requestId: 'req-approved-001' });
  const approvedResult = await approvedPlanSetup.port.propose(approvedPlanSetup.state, approvedPlanSetup.evidence, approvedPlanSetup.request, approvedPlanSetup.context);
  assert.equal(approvedPlanSetup.transport.callCount, 1);
  assert.equal(approvedResult.outcome, 'observed');
  assert.equal(approvedPlanSetup.statePort.getJournalSnapshot().outcomes[0]?.outcome, 'observed');
});

test('HostModelPortV02 Section 10 Case 19: provider budget exhaustion in statePort denies claim with zero transport', async () => {
  const dummyContext = createTestProviderAdmissionContextV02({
    providerRequest: createTestProviderRequest({ role: 'coder', contextDigest: 'sha256:placeholder' }),
  });
  const baseTaskState = createTestAdmissionTaskStateV02(dummyContext);

  // Exhausted budget: consumed equals limit
  const exhaustedTaskState: TaskState = {
    ...baseTaskState,
    budgetLedgers: (baseTaskState.budgetLedgers ?? []).map((ledger) => ({
      ...ledger,
      consumed: ledger.limit,
      reservations: [],
    })),
  };

  const evidence = [createFixtureSourceEvidence({ revisionDigest: exhaustedTaskState.repositoryRevisionDigest })];
  const contextDigest = computeContextDigest(exhaustedTaskState, evidence);

  const request = createTestProviderRequest({
    providerRequestId: 'req-budget-exhausted-001',
    taskId: exhaustedTaskState.taskId,
    runId: exhaustedTaskState.runId,
    role: 'coder',
    contextDigest,
  });

  const context = createTestProviderAdmissionContextV02({
    taskId: exhaustedTaskState.taskId,
    runId: exhaustedTaskState.runId,
    planApplicability: 'approved-plan',
    providerRequest: request,
  });

  const authority = authorityForV02(context);
  const exhaustedStatePort = new MemoryStatePortV02({
    initialTaskState: exhaustedTaskState,
    initialAuthorityRef: authority,
    initialControlVersion: context.expectedControlVersion,
    initialEpoch: context.expectedEpoch,
  });
  const ledgersBefore = exhaustedStatePort.getUnderlying().getLedgers();

  const transport = new StubTransport();
  const actor = { adapterIdentity: 'test-provider', processIncarnation: randomUUID(), fencingGeneration: 1 };
  const port = new HostModelPortV02({
    transport,
    statePort: exhaustedStatePort,
    executorIdentity: actor,
    currentExecutorIdentity: () => actor,
    providerConfig: {
      providerId: request.providerId,
      modelId: request.modelId,
      configId: request.configId,
      pricingPolicyId: request.pricingPolicyId,
    },
  });

  const result = await port.propose(exhaustedTaskState, evidence, request, context);

  assert.equal(transport.callCount, 0, 'Transport must NEVER be called when budget is exhausted');
  assert.equal(result.outcome, 'denied');
  assert.equal(result.reason, 'CLAIM_DENIED: Mismatched provider claim');
  assert.equal(exhaustedStatePort.getJournalSnapshot().attempts.length, 0);
  assert.deepEqual(exhaustedStatePort.getUnderlying().getLedgers(), ledgersBefore);
});

for (const field of ['processIncarnation', 'adapterIdentity', 'payloadDigest', 'fencingGeneration', 'taskId', 'claimId', 'epoch', 'preAttemptControlVersion', 'postBeginTaskStateVersion', 'status']) {
  test(`HostModelPortV02 authenticates attempt ${field} before transport`, async () => {
    const s = createValidV02Setup();
    const begin = s.statePort.beginAttempt.bind(s.statePort);
    s.statePort.beginAttempt = async (...args) => {
      const receipt = await begin(...args);
      if (field in receipt.executorIdentity) {
        return { ...receipt, executorIdentity: { ...receipt.executorIdentity, [field]: field === 'fencingGeneration' ? 2 : 'foreign' } };
      }
      return { ...receipt, [field]: typeof receipt[field as keyof typeof receipt] === 'number' ? 99 : 'foreign' };
    };
    const result = await s.port.propose(s.state, s.evidence, s.request, s.context);
    assert.equal(result.outcome, 'denied');
    assert.equal(s.transport.callCount, 0);
    assert.equal(s.statePort.getJournalSnapshot().outcomes.length, 0);
    assert.equal(s.statePort.getJournalSnapshot().claims[0]?.status, 'attempting');
  });
}

test('HostModelPortV02 exact immutable replay rejects changed admission and protects cached output', async () => {
  const s = createValidV02Setup();
  const first = await s.port.propose(s.state, s.evidence, s.request, s.context);
  const before = s.statePort.getJournalSnapshot();
  const changed = { ...s.context, requestReservationReceipt: 'different-reservation' };
  const denied = await s.port.propose(s.state, s.evidence, s.request, changed);
  assert.equal(denied.outcome, 'denied');
  assert.deepEqual(s.statePort.getJournalSnapshot(), before);
  try { (first as { outcome: string }).outcome = 'invalid'; } catch { /* immutable result */ }
  const retry = await s.port.propose(s.state, s.evidence, s.request, s.context);
  assert.equal(retry.outcome, 'observed');
  assert.equal(s.transport.callCount, 1);
  assert.equal(before.claims.length, 1);
});

for (const mode of ['recorded-unsettled', 'already-recorded', 'uncertain', 'wrong-receipt', 'rejected', 'lost-response'] as const) {
  test(`HostModelPortV02 pending recording ${mode} preserves immutable recovery and never redispatches`, async () => {
    const s = createValidV02Setup();
    const record = s.statePort.recordOutcome.bind(s.statePort);
    s.statePort.recordOutcome = async (receipt) => {
      if (mode === 'rejected') return { outcome: 'uncertain', receiptId: 'rejected' };
      await record(receipt);
      if (mode === 'lost-response') throw new Error('response lost after commit');
      return { outcome: mode === 'wrong-receipt' ? 'settled' : mode, receiptId: mode === 'wrong-receipt' ? 'foreign' : receipt.receiptId };
    };
    const first = await s.port.propose(s.state, s.evidence, s.request, s.context);
    assert.equal(first.outcome, 'uncertain');
    assert.ok('recovery' in first && first.recovery);
    assert.equal(Object.isFrozen(first.recovery), true);
    const before = s.statePort.getJournalSnapshot();
    const retry = await s.port.propose(s.state, s.evidence, s.request, s.context);
    assert.deepEqual(retry, first);
    assert.deepEqual(s.statePort.getJournalSnapshot(), before);
    assert.equal(before.outcomes.length, mode === 'rejected' ? 0 : 1);
    assert.equal(s.transport.callCount, 1);
  });
}

for (const mode of ['malformed-proposal', 'invalid-usage', 'overcap', 'denied', 'unknown'] as const) {
  test(`HostModelPortV02 post-network ${mode} accounts exactly once in canonical state`, async () => {
    const s = createValidV02Setup();
    const usage = { inputTokens: 150, outputTokens: 75, billableTokens: 225, costUsd: 0.005 };
    s.transport.response = mode === 'malformed-proposal' ? { proposal: {}, observedUsage: usage }
      : mode === 'invalid-usage' ? { proposal: {}, observedUsage: { ...usage, costUsd: -1 } }
      : mode === 'overcap' ? { proposal: {}, observedUsage: { ...usage, billableTokens: 9999999 } }
      : mode === 'denied' ? { outcome: 'denied', reason: 'post-network refusal' } : {};
    const first = await s.port.propose(s.state, s.evidence, s.request, s.context);
    assert.equal(first.outcome, mode === 'malformed-proposal' ? 'invalid' : 'uncertain');
    const journal = s.statePort.getJournalSnapshot();
    const persisted = await s.statePort.loadTask(s.state.taskId);
    assert.equal(journal.outcomes.length, 1);
    assert.equal(journal.outcomes[0]?.outcome, mode === 'malformed-proposal' ? 'observed' : 'uncertain');
    const ledger = persisted?.budgetLedgers?.find((item) => item.scope === 'task' && item.kind === 'tokens');
    assert.equal(ledger?.consumed, mode === 'malformed-proposal' ? 225 : 0);
    assert.equal(ledger?.reservations.length, mode === 'malformed-proposal' ? 0 : 1);
    for (const scope of ['task', 'run']) {
      const tokens = persisted?.budgetLedgers?.find((item) => item.scope === scope && item.kind === 'tokens');
      const cost = persisted?.budgetLedgers?.find((item) => item.scope === scope && item.kind === 'cost');
      assert.equal(tokens?.consumed, mode === 'malformed-proposal' ? 225 : 0);
      assert.equal(cost?.consumed, mode === 'malformed-proposal' ? 0.005 : 0);
      assert.equal(tokens?.reservations[0]?.amount, mode === 'malformed-proposal' ? undefined : 10000);
      assert.equal(cost?.reservations[0]?.amount, mode === 'malformed-proposal' ? undefined : 0.5);
    }
    assert.equal(journal.activeClaimId === null, mode === 'malformed-proposal');
    if (mode !== 'malformed-proposal') assert.ok(first.recovery);
    assert.deepEqual(await s.port.propose(s.state, s.evidence, s.request, s.context), first);
    assert.deepEqual(s.statePort.getJournalSnapshot(), journal);
    assert.deepEqual(await s.statePort.loadTask(s.state.taskId), persisted);
    assert.equal(s.transport.callCount, 1);
  });
}

for (const field of ['taskId', 'runId', 'subjectKind', 'planApplicability', 'preClaimTaskStateVersion', 'preClaimControlVersion', 'postClaimControlVersion', 'epoch', 'reservationRefs', 'claimDigest', 'status']) {
  test(`HostModelPortV02 authenticates claim ${field} before begin and transport`, async () => {
    const s = createValidV02Setup();
    const claim = s.statePort.claim.bind(s.statePort);
    s.statePort.claim = async (context) => {
      const receipt = await claim(context);
      const wrong = { ...receipt, [field]: field === 'reservationRefs' ? ['foreign'] : typeof receipt[field as keyof typeof receipt] === 'number' ? 99 : 'foreign' };
      return { ...wrong, claimDigest: field === 'claimDigest' ? 'foreign' : computeCanonicalSha256({ ...wrong, claimDigest: undefined }) };
    };
    assert.equal((await s.port.propose(s.state, s.evidence, s.request, s.context)).outcome, 'denied');
    assert.equal(s.transport.callCount, 0);
    assert.equal(s.statePort.getJournalSnapshot().attempts.length, 0);
    assert.equal(s.statePort.getJournalSnapshot().claims[0]?.status, 'claimed');
  });
}

test('HostModelPortV02 awaits admission with current fence and detached actor records', async () => {
  const s = createValidV02Setup();
  const begin = s.statePort.beginAttempt.bind(s.statePort);
  s.statePort.beginAttempt = async (...args) => {
    const receipt = await begin(...args);
    s.actor.fencingGeneration = 2;
    return receipt;
  };
  assert.equal((await s.port.propose(s.state, s.evidence, s.request, s.context)).outcome, 'denied');
  assert.equal(s.transport.callCount, 0);
  assert.equal(s.statePort.getJournalSnapshot().claims[0]?.status, 'attempting');
});

test('HostModelPortV02 serializes concurrent retries and rejects reconstructed and restarted actors', async () => {
  const s = createValidV02Setup();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const execute = s.transport.execute.bind(s.transport);
  s.transport.execute = async (payload) => { const response = await execute(payload); await barrier; return response; };
  const claim = s.statePort.claim.bind(s.statePort);
  const begin = s.statePort.beginAttempt.bind(s.statePort);
  let savedClaim: Awaited<ReturnType<typeof claim>> | undefined;
  let savedAttempt: Awaited<ReturnType<typeof begin>> | undefined;
  s.statePort.claim = async (...args) => { savedClaim = await claim(...args); return savedClaim; };
  s.statePort.beginAttempt = async (...args) => { savedAttempt = await begin(...args); return savedAttempt; };
  const first = s.port.propose(s.state, s.evidence, s.request, s.context);
  const duplicate = s.port.propose(s.state, s.evidence, s.request, s.context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(s.transport.callCount, 1);
  assert.ok(savedClaim && savedAttempt);
  const claimed = savedClaim;
  const attempted = savedAttempt;
  s.statePort.claim = async () => claimed;
  s.statePort.beginAttempt = async () => attempted;
  for (const actor of [s.actor, { ...s.actor, processIncarnation: randomUUID() }]) {
    const reconstructed = new HostModelPortV02({ ...s.port.options, executorIdentity: actor, currentExecutorIdentity: () => actor });
    assert.equal((await reconstructed.propose(s.state, s.evidence, s.request, s.context)).outcome, 'denied');
  }
  release();
  assert.deepEqual(await first, await duplicate);
  assert.equal(s.transport.callCount, 1);
  assert.equal(s.statePort.getJournalSnapshot().claims.length, 1);
  assert.equal(s.statePort.getJournalSnapshot().attempts.length, 1);
  assert.equal(s.statePort.getJournalSnapshot().outcomes.length, 1);
});

for (const field of ['taskId', 'runId', 'role', 'planDecisionRef', 'providerIdentity', 'providerAdmissionReceipt', 'budgetRefs', 'finiteBounds', 'expectedControlVersion']) {
  test(`HostModelPortV02 cached replay denies changed ${field} without state effects`, async () => {
    const s = createValidV02Setup();
    await s.port.propose(s.state, s.evidence, s.request, s.context);
    const before = s.statePort.getJournalSnapshot();
    const changed = { ...s.context, [field]: field === 'budgetRefs' ? ['foreign'] : field === 'expectedControlVersion' ? 99 : 'foreign' };
    const result = await s.port.propose(s.state, s.evidence, s.request, changed as unknown as ProviderAdmissionContextV02);
    assert.equal(result.outcome, 'denied');
    assert.equal(s.transport.callCount, 1);
    assert.deepEqual(s.statePort.getJournalSnapshot(), before);
  });
}

test('HostModelPortV02 detaches provider observation before awaited settlement', async () => {
  const s = createValidV02Setup();
  const original = s.transport.response as { proposal: { content: string }; observedUsage: { billableTokens: number } };
  const record = s.statePort.recordOutcome.bind(s.statePort);
  s.statePort.recordOutcome = async (receipt) => {
    original.proposal.content = 'changed after observation';
    original.observedUsage.billableTokens = 999;
    return record(receipt);
  };
  const result = await s.port.propose(s.state, s.evidence, s.request, s.context);
  assert.equal(result.outcome, 'observed');
  assert.equal((result.result as { proposal: { content: string } }).proposal.content, 'Proposed fix for zero division');
  assert.equal(result.observedUsage?.billableTokens, 225);
  assert.equal((await s.statePort.loadTask(s.state.taskId))?.budgetLedgers?.find((item) => item.kind === 'tokens')?.consumed, 225);
});

test('HostModelPortV02 requires explicit trusted actor configuration without changing state', async () => {
  const s = createValidV02Setup();
  const port = new HostModelPortV02({ transport: s.transport, statePort: s.statePort });
  const before = s.statePort.getJournalSnapshot();
  assert.equal((await port.propose(s.state, s.evidence, s.request, s.context)).outcome, 'denied');
  assert.deepEqual(s.statePort.getJournalSnapshot(), before);
  assert.equal(s.transport.callCount, 0);
});

test('HostModelPortV02 mixed composition stays outside production admission', () => {
  const s = createValidV02Setup();
  Object.defineProperty(s.statePort, 'provenance', { value: 'real' });
  const port = new HostModelPortV02(s.port.options);
  assert.equal(port.provenance, 'mock');
  assert.equal(isAdmittedForProduction([port]), false);
});

test('HostModelPortV02 refuses executable claim records without evaluating accessors', async () => {
  const s = createValidV02Setup();
  const claim = s.statePort.claim.bind(s.statePort);
  let getterCalls = 0;
  s.statePort.claim = async (...args) => {
    const receipt = await claim(...args);
    return Object.defineProperty({ ...receipt }, 'claimId', { enumerable: true, get: () => { getterCalls++; return receipt.claimId; } });
  };
  assert.equal((await s.port.propose(s.state, s.evidence, s.request, s.context)).outcome, 'denied');
  assert.equal(getterCalls, 0);
  assert.equal(s.transport.callCount, 0);
  assert.equal(s.statePort.getJournalSnapshot().attempts.length, 0);
});


for (const mode of ['outcome-getter', 'usage-getter', 'nested-getter', 'proxy'] as const) {
  test(`HostModelPortV02 hostile transport ${mode} retains canonical uncertainty without executing getters`, async () => {
    const s = createValidV02Setup();
    let getters = 0;
    const hostile = Object.defineProperty({}, mode === 'usage-getter' ? 'observedUsage' : 'outcome', {
      enumerable: true, get() { getters++; throw new Error('MARKER_SECRET unsafe injected object'); },
    });
    s.transport.response = mode === 'nested-getter' ? { proposal: hostile, observedUsage: {} }
      : mode === 'proxy' ? new Proxy({}, { ownKeys() { throw new Error('MARKER_SECRET proxy'); } }) : hostile;
    const result = await s.port.propose(s.state, s.evidence, s.request, s.context);
    assert.equal(result.outcome, 'uncertain');
    assert.ok(result.recovery);
    assert.equal(getters, 0);
    assert.equal(JSON.stringify(result).includes('MARKER_SECRET'), false);
    const { receipt, admission, claim, attempt } = result.recovery;
    assert.equal(Object.isFrozen(receipt.proposedEffects.accounting.reservationRefs), true);
    assert.equal(Object.isFrozen(result.recovery), true);
    assert.equal(receipt.claimId, claim.claimId);
    assert.equal(receipt.attemptId, attempt.attemptId);
    assert.deepEqual(receipt.executorIdentity, attempt.executorIdentity);
    assert.equal(receipt.requestContentDigest, admission.requestContentDigest);
    assert.deepEqual(receipt.proposedEffects.accounting.reservationRefs,
      [s.context.requestReservationReceipt, ...s.context.budgetRefs]);
    const journal = s.statePort.getJournalSnapshot();
    assert.equal(journal.outcomes.length, 1);
    assert.deepEqual(journal.outcomes[0], {
      receiptId: receipt.receiptId, receiptDigest: receipt.receiptDigest,
      claimId: receipt.claimId, attemptId: receipt.attemptId, outcome: 'uncertain',
    });
    assert.equal(journal.claims[0]?.status, 'uncertain');
    assert.ok(journal.activeClaimId);
    const persisted = await s.statePort.loadTask(s.state.taskId);
    for (const scope of ['task', 'run']) {
      for (const kind of ['tokens', 'cost']) {
        const ledger = persisted?.budgetLedgers?.find(item => item.scope === scope && item.kind === kind);
        assert.equal(ledger?.consumed, 0);
        assert.equal(ledger?.reservations[0]?.amount, kind === 'tokens' ? 10000 : 0.5);
      }
    }
    assert.deepEqual(await s.port.propose(s.state, s.evidence, s.request, s.context), result);
    assert.deepEqual(s.statePort.getJournalSnapshot(), journal);
    assert.deepEqual(await s.statePort.loadTask(s.state.taskId), persisted);
    assert.equal(s.transport.callCount, 1);
  });
}


for (const mode of ['inherited', 'accessor', 'throwing-accessor', 'proxy'] as const) {
  test(`HostModelPortV02 hostile settlement ${mode} requires plain own data and recovers exact receipt`, async () => {
    const s = createValidV02Setup();
    const record = s.statePort.recordOutcome.bind(s.statePort);
    let getters = 0;
    s.statePort.recordOutcome = async (receipt) => {
      if (mode === 'inherited') return Object.assign(
        Object.create({ outcome: 'settled', receiptId: receipt.receiptId }), { unrelatedA: 1, unrelatedB: 2 });
      if (mode === 'proxy') return new Proxy({ outcome: 'settled' as const, receiptId: receipt.receiptId }, {
        ownKeys() { throw new Error('MARKER_SECRET proxy'); },
      });
      return Object.defineProperties({}, {
        outcome: { enumerable: true, get() {
          getters++;
          if (mode === 'throwing-accessor') throw new Error('MARKER_SECRET accessor');
          return 'settled';
        } },
        receiptId: { enumerable: true, get() { getters++; return receipt.receiptId; } },
      });
    };
    const result = await s.port.propose(s.state, s.evidence, s.request, s.context);
    assert.equal(result.outcome, 'uncertain');
    assert.equal(getters, 0);
    assert.ok(result.recovery);
    assert.equal(JSON.stringify(result).includes('MARKER_SECRET'), false);
    const { receipt } = result.recovery;
    assert.equal(receipt.outcome, 'observed');
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(Object.isFrozen(receipt.proposedEffects.accounting), true);
    const pending = s.statePort.getJournalSnapshot();
    assert.equal(pending.outcomes.length, 0);
    assert.equal(pending.claims[0]?.status, 'attempting');
    assert.ok(pending.activeClaimId);
    const held = await s.statePort.loadTask(s.state.taskId);
    for (const scope of ['task', 'run']) {
      for (const kind of ['tokens', 'cost']) {
        const ledger = held?.budgetLedgers?.find(item => item.scope === scope && item.kind === kind);
        assert.equal(ledger?.consumed, 0);
        assert.equal(ledger?.reservations[0]?.amount, kind === 'tokens' ? 10000 : 0.5);
      }
    }
    assert.deepEqual(await s.port.propose(s.state, s.evidence, s.request, s.context), result);
    assert.deepEqual(s.statePort.getJournalSnapshot(), pending);
    assert.deepEqual(await s.statePort.loadTask(s.state.taskId), held);
    assert.equal((await record(receipt)).outcome, 'settled');
    const settled = s.statePort.getJournalSnapshot();
    const persisted = await s.statePort.loadTask(s.state.taskId);
    assert.equal(settled.outcomes.length, 1);
    assert.equal(settled.outcomes[0]?.receiptDigest, receipt.receiptDigest);
    assert.equal(settled.activeClaimId, null);
    assert.equal(settled.claims[0]?.status, 'settled');
    for (const scope of ['task', 'run']) {
      for (const kind of ['tokens', 'cost']) {
        const ledger = persisted?.budgetLedgers?.find(item => item.scope === scope && item.kind === kind);
        assert.equal(ledger?.consumed, kind === 'tokens' ? 225 : 0.005);
        assert.equal(ledger?.reservations.length, 0);
      }
    }
    assert.equal((await record(receipt)).outcome, 'already-recorded');
    assert.deepEqual(s.statePort.getJournalSnapshot(), settled);
    assert.deepEqual(await s.statePort.loadTask(s.state.taskId), persisted);
    assert.deepEqual(await s.port.propose(s.state, s.evidence, s.request, s.context), result);
    assert.equal(s.transport.callCount, 1);
    assert.equal(getters, 0);
  });
}

test('HostModelPortV02 accepts detached null-prototype settlement data from canonical journal', async () => {
  const s = createValidV02Setup();
  const record = s.statePort.recordOutcome.bind(s.statePort);
  s.statePort.recordOutcome = async receipt => Object.assign(Object.create(null), await record(receipt));
  assert.equal((await s.port.propose(s.state, s.evidence, s.request, s.context)).outcome, 'observed');
  assert.equal(s.statePort.getJournalSnapshot().activeClaimId, null);
  assert.equal(s.statePort.getJournalSnapshot().outcomes.length, 1);
  assert.equal(s.transport.callCount, 1);
});


for (const mode of ['then-null-rejection', 'error-message-getter', 'coercion-getter', 'rejection-proxy'] as const) {
  test(`HostModelPortV02 hostile rejection ${mode} retains canonical uncertainty with safe diagnostics`, async () => {
    const s = createValidV02Setup();
    let getters = 0;
    const marker = 'MARKER_SECRET api_key=sk-rejection-credential';
    if (mode === 'then-null-rejection') {
      s.transport.response = Object.defineProperty({}, 'then', {
        get() { getters++; throw Object.create(null); },
      });
    } else {
      const rejection: unknown = mode === 'error-message-getter'
        ? Object.defineProperty(new Error('transport failed'), 'message', {
          get() { getters++; throw new Error(marker); },
        })
        : mode === 'coercion-getter' ? Object.defineProperty({}, Symbol.toPrimitive, {
          get() { getters++; throw new Error(marker); },
        }) : new Proxy({}, {
          get() { getters++; throw new Error(marker); },
          getPrototypeOf() { throw new Error(marker); },
          getOwnPropertyDescriptor() { throw new Error(marker); },
        });
      s.transport.execute = async () => { s.transport.callCount++; throw rejection; };
    }
    const result = await s.port.propose(s.state, s.evidence, s.request, s.context);
    assert.equal(result.outcome, 'uncertain');
    assert.equal(result.reason, 'PROVIDER_OUTCOME_PENDING');
    assert.ok(result.recovery);
    assert.equal(getters, mode === 'then-null-rejection' ? 1 : 0);
    assert.equal(JSON.stringify(result).includes('MARKER_SECRET'), false);
    assert.equal(JSON.stringify(result).includes('sk-rejection-credential'), false);
    const { receipt, admission, claim, attempt } = result.recovery;
    assert.equal(Object.isFrozen(receipt.proposedEffects.accounting.reservationRefs), true);
    assert.equal(Object.isFrozen(result.recovery), true);
    assert.equal(receipt.claimId, claim.claimId);
    assert.equal(receipt.attemptId, attempt.attemptId);
    assert.deepEqual(receipt.executorIdentity, attempt.executorIdentity);
    assert.equal(receipt.executorIdentity.adapterIdentity, s.actor.adapterIdentity);
    assert.equal(receipt.executorIdentity.processIncarnation, s.actor.processIncarnation);
    assert.equal(receipt.executorIdentity.fencingGeneration, s.actor.fencingGeneration);
    assert.equal(receipt.providerRequestId, s.request.providerRequestId);
    assert.equal(receipt.outcome, 'uncertain');
    assert.equal(receipt.requestContentDigest, admission.requestContentDigest);
    assert.deepEqual(receipt.proposedEffects.accounting.reservationRefs,
      [s.context.requestReservationReceipt, ...s.context.budgetRefs]);
    const journal = s.statePort.getJournalSnapshot();
    assert.equal(journal.outcomes.length, 1);
    assert.deepEqual(journal.outcomes[0], {
      receiptId: receipt.receiptId, receiptDigest: receipt.receiptDigest,
      claimId: receipt.claimId, attemptId: receipt.attemptId, outcome: 'uncertain',
    });
    assert.equal(journal.claims[0]?.status, 'uncertain');
    assert.equal(journal.activeClaimId, receipt.claimId);
    const persisted = await s.statePort.loadTask(s.state.taskId);
    for (const scope of ['task', 'run']) {
      for (const kind of ['tokens', 'cost']) {
        const ledger = persisted?.budgetLedgers?.find(item => item.scope === scope && item.kind === kind);
        assert.equal(ledger?.consumed, 0);
        assert.equal(ledger?.reservations[0]?.amount, kind === 'tokens' ? 10000 : 0.5);
      }
    }
    assert.deepEqual(await s.port.propose(s.state, s.evidence, s.request, s.context), result);
    assert.deepEqual(s.statePort.getJournalSnapshot(), journal);
    assert.deepEqual(await s.statePort.loadTask(s.state.taskId), persisted);
    assert.equal(s.transport.callCount, 1);
  });
}


for (const mode of ['own-name', 'own-message', 'name-accessor'] as const) {
  test(`HostModelPort safely classifies rejection ${mode} with fixed diagnostics`, async () => {
    const s = createValidSetup();
    let getters = 0;
    const rejection = new Error(mode === 'own-message' ? 'Request timed out api_key=sk-rejection-credential' : 'transport failed');
    if (mode === 'own-name') rejection.name = 'TimeoutError';
    if (mode === 'name-accessor') Object.defineProperty(rejection, 'name', {
      get() { getters++; throw new Error('MARKER_SECRET'); },
    });
    s.transport.throwError = rejection;
    const result = await s.port.propose(s.state, s.evidence, s.request);
    assert.equal(result.outcome, 'uncertain');
    if (result.outcome === 'uncertain') assert.equal(result.reason, mode === 'name-accessor'
      ? 'PROVIDER_ERROR: Model transport request failed'
      : 'PROVIDER_TIMEOUT: Model transport request timed out');
    assert.equal(getters, 0);
    assert.equal(s.transport.callCount, 1);
  });
}
