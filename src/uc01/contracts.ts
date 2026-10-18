import { createHash } from 'node:crypto';
/** UC-01 local contract validation. Acceptance grants no execution authority. */
export type Validation<T> = Readonly<{ ok: true; value: T }> | Readonly<{
  ok: false; status: 'invalid-input' | 'conflict' | 'error'; reasonCode: string; path: string;
}>;
type ValidationStatus = 'invalid-input' | 'conflict' | 'error';
type Check<T> = (value: unknown, path: string) => T;
class Invalid extends Error {
  readonly path: string;
  readonly status: ValidationStatus | undefined;
  constructor(path: string, status?: ValidationStatus) { super('Invalid contract value'); this.path = path; this.status = status; }
}
function reject(path: string, status?: ValidationStatus): never { throw new Invalid(path, status); }
function validate<T>(check: Check<T>, value: unknown, status: ValidationStatus = 'invalid-input'): Validation<T> {
  try { return { ok: true, value: check(value, '$') }; }
  catch (error) {
    if (error instanceof Invalid) {
      const failureStatus = error.status ?? status;
      return { ok: false, status: failureStatus, reasonCode: failureStatus === 'error' ? 'invalid-model-output' : failureStatus, path: error.path };
    }
    throw error;
  }
}
function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 16384 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) reject(path);
  return value;
}
function boolean(value: unknown, path: string): boolean { return typeof value === 'boolean' ? value : reject(path); }
function list<T>(item: Check<T>, max = 48): Check<readonly T[]> {
  return (value, path) => {
    if (!Array.isArray(value) || value.length > max || Object.getPrototypeOf(value) !== Array.prototype
      || Reflect.ownKeys(value).length !== value.length + 1) reject(path);
    const result: T[] = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) reject(`${path}[${i}]`);
      result.push(item(descriptor.value, `${path}[${i}]`));
    }
    return result;
  };
}
type Shape = Readonly<Record<string, Check<unknown>>>;
type Checked<S extends Shape> = { readonly [K in keyof S]: ReturnType<S[K]> };
function object<S extends Shape>(shape: S): Check<Checked<S>> {
  return (value, path) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) reject(path);
    const record = value as Record<string, unknown>;
    if (Reflect.ownKeys(record).some(key => typeof key !== 'string' || !Object.hasOwn(shape, key))) reject(path);
    const result: Record<string, unknown> = {};
    for (const [key, check] of Object.entries(shape)) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor && (!descriptor.enumerable || !('value' in descriptor))) reject(`${path}.${key}`);
      const parsed = check(descriptor?.value, `${path}.${key}`);
      if (parsed !== undefined) result[key] = parsed;
    }
    // Every field was checked above, including required fields.
    return result as Checked<S>;
  };
}
function unique(values: readonly string[], path: string): void { if (new Set(values).size !== values.length) reject(path); }
const classification = object({ id: text, definition: text, impairmentAssessment: boolean });
const destination = object({ id: text, responsibility: text, acceptsClassificationIds: list(text) });
const catalogShape = object({ id: text, version: text, classifications: list(classification), destinations: list(destination) });
export type Catalog = ReturnType<typeof catalogShape>;
function catalogCheck(value: unknown, path: string): Catalog {
  const catalog = catalogShape(value, path);
  const ids = catalog.classifications.map(entry => entry.id);
  unique(ids, path); unique(catalog.destinations.map(entry => entry.id), path);
  if ([...ids, ...catalog.destinations.map(entry => entry.id)].includes('undetermined')) reject(path);
  for (const entry of catalog.destinations) {
    unique(entry.acceptsClassificationIds, path);
    if (entry.acceptsClassificationIds.some(id => !ids.includes(id)) || /uc[- ]?0[45]|recover|approval|approve/iu.test(`${entry.id} ${entry.responsibility}`)) reject(path);
  }
  return catalog;
}
export function validateCatalog(value: unknown): Validation<Catalog> { return validate(catalogCheck, value); }

function enumeration<const T extends readonly string[]>(...values: T): Check<T[number]> {
  return (value, path) => typeof value === 'string' && values.includes(value) ? value as T[number] : reject(path);
}
function optional<T>(check: Check<T>): Check<T | undefined> { return (value, path) => value === undefined ? undefined : check(value, path); }
function integer(value: unknown, path: string): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : reject(path); }
function positive(value: unknown, path: string): number { const n = integer(value, path); return n > 0 ? n : reject(path); }
function digestCheck(value: unknown, path: string): string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : reject(path); }
export function sha256Text(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
// Direct field-name mapping of the thirteen prose limits; no production defaults.
const limitsShape = object({ wallTimeMs: positive, modelCalls: positive, toolCalls: positive, perCallTimeoutMs: positive,
  inputBytes: positive, outputBytes: positive, evidenceItems: positive, searchResults: positive, questions: positive,
  inputTokens: positive, outputTokens: positive, totalTokens: positive, costUnits: positive });
export type Limits = ReturnType<typeof limitsShape>;
export const fixtureLimits: Limits = Object.freeze({ wallTimeMs: 10000, modelCalls: 4, toolCalls: 6, perCallTimeoutMs: 1000,
  inputBytes: 16384, outputBytes: 8192, evidenceItems: 16, searchResults: 8, questions: 4,
  inputTokens: 2000, outputTokens: 1000, totalTokens: 3000, costUnits: 3000 });
function limitsCheck(value: unknown, path: string): Limits {
  const limits = limitsShape(value, path);
  if (limits.totalTokens !== limits.inputTokens + limits.outputTokens || limits.perCallTimeoutMs > limits.wallTimeMs) reject(path);
  return limits;
}
export function validateLimits(value: unknown): Validation<Limits> { return validate(limitsCheck, value); }
const questionShape = object({ id: text, text, affects: list(enumeration('intent', 'scope', 'severity', 'destination'), 4), reason: text });
function questionCheck(value: unknown, path: string): ReturnType<typeof questionShape> {
  const question = questionShape(value, path); if (!question.affects.length) reject(path); unique(question.affects, path); return question;
}
export type Question = ReturnType<typeof questionCheck>;
const issueShape = object({ id: text, title: text, originalReport: text, reportDigest: digestCheck });
const suppliedShape = object({ id: text, sourceRef: text, content: text, digest: digestCheck });
const invocationShape = object({ schemaVersion: enumeration('uc01-draft-v1'), invocationId: text, taskId: text, runId: text, repositoryId: text,
  issue: issueShape, suppliedEvidence: list(suppliedShape), answers: list(object({ questionId: text, text })), continuationRef: optional(text) });
export type Invocation = ReturnType<typeof invocationShape>;
function invocationCheck(value: unknown, path: string): Invocation {
  const input = invocationShape(value, path);
  if (sha256Text(input.issue.originalReport) !== input.issue.reportDigest || input.suppliedEvidence.some(e => sha256Text(e.content) !== e.digest)) reject(path);
  unique(input.suppliedEvidence.map(e => e.id), path); unique(input.answers.map(a => a.questionId), path);
  if (input.answers.length && !input.continuationRef) reject(path);
  return input;
}
export function validateInvocation(value: unknown): Validation<Invocation> { return validate(invocationCheck, value); }
function pathCheck(value: unknown, path: string): string {
  const s = text(value, path);
  return s.startsWith('/') || /[\\:\u0000-\u001f]/u.test(s) || s.split('/').some(part => !part || part === '.' || part === '..') ? reject(path) : s;
}
const locationShape = object({ repositoryId: text, snapshotDigest: digestCheck, path: pathCheck, fileDigest: digestCheck, startLine: positive, endLine: positive });
const evidenceShape = object({ id: text, kind: enumeration('reporter', 'answer', 'repository'), sourceRef: text, contentDigest: digestCheck,
  safeExcerptRef: text, provenance: enumeration('mock', 'real'), repository: optional(locationShape), questionId: optional(text) });
export type Evidence = ReturnType<typeof evidenceShape>;
function evidenceCheck(value: unknown, path: string): Evidence {
  const entry = evidenceShape(value, path);
  if (entry.kind === 'repository' ? !entry.repository || entry.questionId !== undefined || entry.repository.endLine < entry.repository.startLine
    : entry.repository !== undefined || (entry.kind === 'answer' ? !entry.questionId : entry.questionId !== undefined)) reject(path);
  return entry;
}
const continuationShape = object({ taskId: text, issueId: text, reportDigest: digestCheck, repositoryId: text, repositorySnapshotDigest: digestCheck,
  configId: text, configVersion: text, priorAssessmentId: text, questions: list(questionCheck) });
export type Continuation = ReturnType<typeof continuationShape>;
const contextShape = object({ taskId: text, runId: text, repositoryId: text, workspaceId: text, repositorySnapshotDigest: digestCheck,
  configId: text, configVersion: text, policyId: text, policyVersion: text, catalog: catalogCheck, limits: limitsCheck,
  accountingRef: text, evidenceRegistry: list(evidenceCheck), continuation: optional(continuationShape) });
// Failure grading may need to report a rejected catalog. Keep its structure and
// identity bound while postponing the catalog's semantic checks to the product outcome.
const failureContextShape = object({ taskId: text, runId: text, repositoryId: text, workspaceId: text, repositorySnapshotDigest: digestCheck,
  configId: text, configVersion: text, policyId: text, policyVersion: text, catalog: catalogShape, limits: limitsCheck,
  accountingRef: text, evidenceRegistry: list(evidenceCheck), continuation: optional(continuationShape) });
export type TrustedContext = ReturnType<typeof contextShape>;
export type Intake = Readonly<{ invocation: Invocation; context: TrustedContext }>;
function intakeCheckWithContext(value: unknown, path: string, checkContext: Check<TrustedContext>): Intake {
  const intake = object({ invocation: invocationCheck, context: checkContext })(value, path);
  const { invocation: input, context } = intake;
  for (const key of ['taskId', 'runId', 'repositoryId'] as const) if (input[key] !== context[key]) reject(`${path}.${key}`);
  if (Buffer.byteLength(JSON.stringify(input)) > context.limits.inputBytes || context.evidenceRegistry.length > context.limits.evidenceItems) reject(path);
  unique(context.evidenceRegistry.map(e => e.id), path);
  const prior = context.continuation;
  if (Boolean(input.continuationRef) !== Boolean(prior)) reject(path);
  if (prior) {
    for (const key of ['taskId', 'repositoryId', 'repositorySnapshotDigest', 'configId', 'configVersion'] as const) {
      if (prior[key] !== context[key]) reject(path, 'conflict');
    }
    if (prior.issueId !== input.issue.id || prior.reportDigest !== input.issue.reportDigest) reject(path, 'conflict');
    unique(prior.questions.map(q => q.id), path);
    if (input.answers.some(a => !prior.questions.some(q => q.id === a.questionId))) reject(path);
  }
  const reportEvidence = context.evidenceRegistry.filter(entry => entry.kind === 'reporter' && entry.sourceRef === input.issue.id
    && entry.contentDigest === input.issue.reportDigest);
  if (reportEvidence.length !== 1) reject(`${path}.context.evidenceRegistry`);
  for (const supplied of input.suppliedEvidence) {
    if (!context.evidenceRegistry.some(entry => entry.kind === 'reporter' && entry.sourceRef === supplied.sourceRef && entry.contentDigest === supplied.digest)) {
      reject(`${path}.context.evidenceRegistry`);
    }
  }
  for (const answer of input.answers) {
    if (!context.evidenceRegistry.some(entry => entry.kind === 'answer' && entry.questionId === answer.questionId
      && entry.contentDigest === sha256Text(answer.text))) reject(`${path}.context.evidenceRegistry`);
  }
  for (const entry of context.evidenceRegistry) {
    if (entry.repository && (entry.repository.repositoryId !== context.repositoryId || entry.repository.snapshotDigest !== context.repositorySnapshotDigest)) reject(path);
    if (entry.kind === 'reporter') {
      const source = entry.sourceRef === input.issue.id ? input.issue.reportDigest : input.suppliedEvidence.find(e => e.sourceRef === entry.sourceRef)?.digest;
      if (source !== entry.contentDigest) reject(path);
    }
    if (entry.kind === 'answer') {
      const answer = input.answers.find(a => a.questionId === entry.questionId);
      if (!answer || sha256Text(answer.text) !== entry.contentDigest) reject(path);
    }
  }
  return intake;
}
function intakeCheck(value: unknown, path: string): Intake { return intakeCheckWithContext(value, path, contextShape); }
function failureEnvelopeCheck(value: unknown, path: string): Intake {
  // Freeze the invocation and trusted dependency records, but leave product admission
  // checks (identity parity, limits, evidence admission and continuation binding) to
  // the typed failure outcome being evaluated.
  return object({ invocation: invocationCheck, context: failureContextShape })(value, path);
}
export function validateIntake(invocation: unknown, context: unknown): Validation<Intake> { return validate(intakeCheck, { invocation, context }); }

const decisionShape = object({ value: text, assertionIds: list(text) });
const dimensionShape = object({ summary: text, known: boolean, evidenceIds: list(text) });
const severityShape = object({ value: enumeration('P0', 'P1', 'P2', 'P3', 'undetermined'), functionality: dimensionShape,
  affectedUsers: dimensionShape, workaround: dimensionShape, assertionIds: list(text) });
const assertionShape = object({ id: text, text, basis: enumeration('fact', 'inference', 'unknown'), evidenceIds: list(text) });
const proposalFields = { classification: decisionShape, severity: severityShape, destination: decisionShape,
  assertions: list(assertionShape), uncertainties: list(text), evidenceIds: list(text), questions: list(questionCheck) };
const proposalShape = object(proposalFields);
export type Proposal = ReturnType<typeof proposalShape>;
function checkProposal(proposal: Proposal, context: TrustedContext, path: string): Proposal {
  const references = new Set<string>();
  const checkEvidence = (ids: readonly string[]): void => {
    unique(ids, path);
    for (const id of ids) { if (!context.evidenceRegistry.some(e => e.id === id)) reject(path); references.add(id); }
  };
  unique(proposal.assertions.map(a => a.id), path); unique(proposal.questions.map(q => q.id), path);
  for (const assertion of proposal.assertions) {
    if (assertion.basis === 'unknown' ? assertion.evidenceIds.length !== 0 : !assertion.evidenceIds.length) reject(path);
    checkEvidence(assertion.evidenceIds);
  }
  for (const decision of [proposal.classification, proposal.destination, proposal.severity]) {
    unique(decision.assertionIds, path);
    if (!decision.assertionIds.length || decision.assertionIds.some(id => !proposal.assertions.some(a => a.id === id))) reject(path);
  }
  const classification = context.catalog.classifications.find(c => c.id === proposal.classification.value);
  if (!classification && proposal.classification.value !== 'undetermined') reject(path);
  const destination = context.catalog.destinations.find(d => d.id === proposal.destination.value);
  if (proposal.destination.value !== 'undetermined' && (!destination || !destination.acceptsClassificationIds.includes(proposal.classification.value))) reject(path);
  if (proposal.classification.value === 'undetermined' && proposal.destination.value !== 'undetermined') reject(path);
  if (!classification?.impairmentAssessment && proposal.severity.value !== 'undetermined') reject(path);
  for (const dimension of [proposal.severity.functionality, proposal.severity.affectedUsers, proposal.severity.workaround]) {
    if (dimension.known ? !dimension.evidenceIds.length : dimension.evidenceIds.length || proposal.severity.value !== 'undetermined') reject(path);
    checkEvidence(dimension.evidenceIds);
  }
  unique(proposal.evidenceIds, path);
  if (proposal.evidenceIds.length !== references.size || proposal.evidenceIds.some(id => !references.has(id))) reject(path);
  if (proposal.questions.length > context.limits.questions || Buffer.byteLength(JSON.stringify(proposal)) > context.limits.outputBytes) reject(path);
  return proposal;
}
export function validateProposal(value: unknown, trustedContext: unknown): Validation<Proposal> {
  const context = validate(contextShape, trustedContext);
  if (!context.ok) return context;
  return validate((v, path) => checkProposal(proposalShape(v, path), context.value, path), value, 'error');
}
const failureCheck = enumeration('invalid-input', 'denied', 'pending-approval', 'conflict', 'exhausted', 'timeout', 'uncertain', 'error');
export type Failure = ReturnType<typeof failureCheck>;
const usageShape = object({ inputTokens: integer, outputTokens: integer, totalTokens: integer, costUnits: integer,
  state: enumeration('settled', 'uncertain'), reservationRef: text });
export type Usage = ReturnType<typeof usageShape>;
function usageCheck(value: unknown, path: string): Usage {
  const usage = usageShape(value, path); if (usage.totalTokens !== usage.inputTokens + usage.outputTokens) reject(path); return usage;
}
const readShape = object({ kind: enumeration('read'), path: pathCheck });
const searchShape = object({ kind: enumeration('search'), query: text });
function requestCheck(value: unknown, path: string): ReturnType<typeof readShape> | ReturnType<typeof searchShape> {
  return discriminator(value) === 'read' ? readShape(value, path) : searchShape(value, path);
}
function discriminator(value: unknown, key = 'kind'): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
const modelAssessment = object({ kind: enumeration('assessment'), proposal: proposalShape, usage: usageCheck });
const modelTool = object({ kind: enumeration('tool-request'), request: requestCheck, usage: usageCheck });
const modelFailure = object({ kind: enumeration('failure'), status: failureCheck, reasonCode: text, eventRef: text, usage: usageCheck });
export type ModelResponse = ReturnType<typeof modelAssessment> | ReturnType<typeof modelTool> | ReturnType<typeof modelFailure>;
export function validateModelResponse(value: unknown, trustedContext: unknown): Validation<ModelResponse> {
  const context = validate(contextShape, trustedContext);
  if (!context.ok) return context;
  return validate((v, path) => {
    const response = discriminator(v) === 'assessment' ? modelAssessment(v, path) : discriminator(v) === 'tool-request' ? modelTool(v, path) : modelFailure(v, path);
    if (response.kind === 'assessment') checkProposal(response.proposal, context.value, path);
    if (Buffer.byteLength(JSON.stringify(response)) > context.value.limits.outputBytes) reject(path);
    if (response.usage.inputTokens > context.value.limits.inputTokens || response.usage.outputTokens > context.value.limits.outputTokens
      || response.usage.costUnits > context.value.limits.costUnits) reject(path);
    return response;
  }, value, 'error');
}
const assessmentShape = object({ ...proposalFields, assessmentId: text, issueId: text, reportDigest: digestCheck, repositoryId: text,
  repositorySnapshotDigest: digestCheck, catalogId: text, catalogVersion: text, provenance: enumeration('mock', 'real') });
export type Assessment = ReturnType<typeof assessmentShape>;
const assessedShape = object({ status: enumeration('assessed'), assessment: assessmentShape, eventRef: text });
const needsInfoShape = object({ status: enumeration('needs-info'), assessment: assessmentShape, continuationRef: text, eventRef: text });
const failedShape = object({ status: failureCheck, reasonCode: text, safeMessage: text, nextAction: text, eventRef: text });
export type Outcome = ReturnType<typeof assessedShape> | ReturnType<typeof needsInfoShape> | ReturnType<typeof failedShape>;
function hasAssessment(outcome: Outcome): outcome is ReturnType<typeof assessedShape> | ReturnType<typeof needsInfoShape> {
  return outcome.status === 'assessed' || outcome.status === 'needs-info';
}
function failureOutputLimit(context: unknown): number {
  const fallback = 16384;
  if (context === null || typeof context !== 'object' || Array.isArray(context) || Object.getPrototypeOf(context) !== Object.prototype) return fallback;
  const descriptor = Object.getOwnPropertyDescriptor(context, 'limits');
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return fallback;
  try { return limitsCheck(descriptor.value, '$.context.limits').outputBytes; }
  catch (error) { if (error instanceof Invalid) return fallback; throw error; }
}
export function validateOutcome(value: unknown, invocation: unknown, trustedContext: unknown): Validation<Outcome> {
  return validate((v, path) => {
    const outcome = discriminator(v, 'status') === 'assessed' ? assessedShape(v, path) : discriminator(v, 'status') === 'needs-info' ? needsInfoShape(v, path) : failedShape(v, path);
    if (!hasAssessment(outcome)) {
      if (Buffer.byteLength(JSON.stringify(outcome)) > failureOutputLimit(trustedContext)) reject(path);
      return outcome;
    }
    const intake = intakeCheck({ invocation, context: trustedContext }, '$.intake');
    const a = outcome.assessment; checkProposal(a, intake.context, path);
    if ((outcome.status === 'assessed') !== (a.questions.length === 0) || a.issueId !== intake.invocation.issue.id || a.reportDigest !== intake.invocation.issue.reportDigest || a.repositoryId !== intake.context.repositoryId || a.repositorySnapshotDigest !== intake.context.repositorySnapshotDigest || a.catalogId !== intake.context.catalog.id || a.catalogVersion !== intake.context.catalog.version) reject(path);
    if (a.provenance === 'real' && a.evidenceIds.some(id => intake.context.evidenceRegistry.find(e => e.id === id)?.provenance !== 'real')) reject(path);
    if (Buffer.byteLength(JSON.stringify(outcome)) > intake.context.limits.outputBytes) reject(path);
    return outcome;
  }, value);
}

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
function jsonCheck(value: unknown, path: string, ancestors = new Set<object>(), depth = 0): Json {
  if (depth > 32) reject(path);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : reject(path);
  if (typeof value === 'string') {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) reject(path);
    return value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) reject(path);
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (value.length > 10000 || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) reject(path);
    const result: Json[] = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) reject(`${path}[${i}]`);
      result.push(jsonCheck(descriptor.value, `${path}[${i}]`, ancestors, depth + 1));
    }
    ancestors.delete(value); return result;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) reject(path);
  const result: Record<string, Json> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') reject(path);
    jsonCheck(key, path);
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !('value' in property) || !property.enumerable) reject(path);
    Object.defineProperty(result, key, { value: jsonCheck(property.value, `${path}.${key}`, ancestors, depth + 1), enumerable: true });
  }
  ancestors.delete(value); return result;
}
function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.keys(value).sort().map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) reject('$');
    return `${JSON.stringify(key)}:${canonical(descriptor.value as Json)}`;
  });
  return `{${entries.join(',')}}`;
}
export function canonicalDigest(kind: 'PublicCase' | 'GradingCase', record: unknown): string {
  if (kind !== 'PublicCase' && kind !== 'GradingCase') reject('$.kind');
  return sha256Text(canonical(jsonCheck({ digestProfile: 'uc01-evaluation-sha256-v1', kind, record }, '$')));
}
/** Parse at the byte/text boundary; object validators cannot recover duplicate keys after JSON.parse. */
export function parseContractJson(source: string): Validation<Json> {
  return validate((value, path) => {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 1048576) reject(path);
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch (error) { if (error instanceof SyntaxError) reject(path); throw error; }
    const tokens = value.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gu) ?? [];
    const stack: (Set<string> | null)[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === undefined) reject(path);
      if (token === '{') stack.push(new Set()); else if (token === '[') stack.push(null);
      else if (token === '}' || token === ']') stack.pop();
      else if (token.startsWith('"') && tokens[i + 1] === ':') {
        const key: unknown = JSON.parse(token); const keys = stack.at(-1);
        if (typeof key !== 'string' || !keys || keys.has(key)) reject(path);
        keys.add(key);
      }
    }
    return jsonCheck(parsed, path);
  }, source);
}
const levelCheck = enumeration('contract', 'mock-behavior', 'real-integration', 'model-quality', 'project');
export type ExecutionLevel = ReturnType<typeof levelCheck>;
const labelsShape = object({ classification: optional(text), severity: optional(enumeration('P0', 'P1', 'P2', 'P3', 'undetermined')), destination: optional(text) });
const expectedOutcomeShape = object({ status: optional(enumeration('assessed', 'needs-info', 'invalid-input', 'denied', 'pending-approval', 'conflict', 'exhausted', 'timeout', 'uncertain', 'error')),
  reasonCode: optional(text), requiredQuestionAffects: optional(list(enumeration('intent', 'scope', 'severity', 'destination'))), requiredEvidenceIds: optional(list(text)) });
const prerequisitesShape = object({ capabilityRefs: list(text), configId: text, configVersion: text, catalogId: text, catalogVersion: text,
  policyId: text, policyVersion: text, modelRequirement: text, limits: limitsCheck, ownerGates: list(text), expectedProvenance: enumeration('mock', 'real') });
// Nested evaluation field names are local DRAFT projections, not a registered shared signature.
const publicFields = { contractVersion: enumeration('uc01-evaluation-draft-v1'), caseId: text, ucId: enumeration('UC-01'), familyId: text,
  datasetId: text, datasetVersion: text, categories: list(enumeration('functional', 'error', 'edge', 'safety', 'integration', 'model-quality')),
  levels: list(levelCheck), gate: enumeration('hard', 'scored'),
  input: object({ invocation: invocationCheck, evidenceRefs: list(text), repositorySnapshotDigest: digestCheck, catalogRef: text }),
  source: object({ origin: enumeration('public', 'synthetic', 'reporter'), sourceRef: text, digest: digestCheck, authorizationRef: optional(text) }),
  prerequisites: prerequisitesShape, gradingRuleId: text, gradingRuleVersion: text, requirements: list(text), taskIds: list(text) };
const publicProjectionShape = object(publicFields);
const publicShape = object({ ...publicFields, caseDigest: digestCheck });
export type PublicCase = ReturnType<typeof publicShape>;
const gradingFields = { caseId: text, datasetVersion: text, publicCaseDigest: digestCheck, expectedOutcome: expectedOutcomeShape,
  expectedLabels: labelsShape, allowedValues: object({ classification: optional(list(text)), severity: optional(list(enumeration('P0', 'P1', 'P2', 'P3', 'undetermined'))), destination: optional(list(text)) }),
  prohibitedEffects: list(text), gradingRuleId: text, gradingRuleVersion: text, privateEvidenceRefs: list(text) };
const gradingProjectionShape = object(gradingFields);
const gradingShape = object({ ...gradingFields, oracleDigest: digestCheck });
export type GradingCase = ReturnType<typeof gradingShape>;
const digestMetadata = new Set(['runId', 'attemptId', 'status', 'reasonCode', 'safeSummary', 'codeRevision', 'subjectSnapshotDigest', 'configDigest',
  'catalogId', 'catalogVersion', 'policyId', 'policyVersion', 'adapterVersions', 'graderVersion', 'capabilityRefs', 'startedAt', 'durationMs',
  'metrics', 'traceRefs', 'evidenceRefs', 'failureAnalysisRef', 'missingFields']);
function project(value: unknown, shape: Shape, self: string): unknown {
  const record = jsonCheck(value, '$');
  if (record === null || typeof record !== 'object' || Array.isArray(record)) reject('$');
  const projected: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (Object.hasOwn(shape, key)) projected[key] = entry;
    else if (key !== self && !digestMetadata.has(key)) reject(`$.${key}`);
  }
  return projected;
}
export function publicCaseDigest(value: unknown): string {
  return canonicalDigest('PublicCase', publicProjectionShape(project(value, publicFields, 'caseDigest'), '$'));
}
export function oracleDigest(value: unknown): string {
  return canonicalDigest('GradingCase', gradingProjectionShape(project(value, gradingFields, 'oracleDigest'), '$'));
}
function caseIdentity(caseId: string, familyId: string, path: string): void {
  const match = /^UC-01:(C(?:0[1-9]|1[0-9]|2[0-2])):([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(caseId);
  if (!match || match[1] !== familyId) reject(path);
}
function publicCheck(value: unknown, path: string): PublicCase {
  const record = publicShape(value, path); caseIdentity(record.caseId, record.familyId, path);
  if (!record.categories.length || !record.levels.length) reject(path);
  unique(record.categories, path); unique(record.levels, path);
  if (record.gate === 'scored' && (record.levels.some(l => l !== 'model-quality') || record.categories.some(c => c !== 'model-quality'))) reject(path);
  if (record.requirements.some(r => !/^(FR|SC)-\d{3}$/u.test(r)) || record.taskIds.some(t => !/^T00[1-9]$|^T01[0-6]$/u.test(t))) reject(path);
  if (publicCaseDigest(record) !== record.caseDigest) reject(path);
  return record;
}
export function validatePublicCase(value: unknown): Validation<PublicCase> { return validate(publicCheck, value); }
export function validateGradingCase(value: unknown, publicCase: unknown): Validation<GradingCase> {
  return validate((v, path) => {
    const record = gradingShape(v, path); const publicRecord = publicCheck(publicCase, '$.publicCase');
    for (const key of ['caseId', 'datasetVersion', 'gradingRuleId', 'gradingRuleVersion'] as const) if (record[key] !== publicRecord[key]) reject(path);
    if (record.publicCaseDigest !== publicRecord.caseDigest || oracleDigest(record) !== record.oracleDigest) reject(path);
    return record;
  }, value);
}

const criteriaShape = object({ provenance: boolean, evidenceSupport: boolean, clarification: boolean, destination: boolean, safety: boolean });
export type GradingCriteria = ReturnType<typeof criteriaShape>;
export type ClassificationCorrectness = 'correct' | 'incorrect' | 'not-observed' | 'not-applicable';
export type CaseGrade = Readonly<{ status: 'pass' | 'fail'; classification: ClassificationCorrectness;
  severity: 'pass' | 'fail' | 'not-observed' | 'not-applicable'; provenance: boolean; evidenceSupport: boolean; clarification: boolean; destination: boolean; safety: boolean }>;
/** Semantic criteria come from a trusted, versioned grader; citation existence is not evidence support. */
export function gradeCase(outcome: unknown, invocation: unknown, context: unknown, publicCase: unknown, gradingCase: unknown, criteria: unknown): Validation<CaseGrade> {
  return validate((value, path) => {
    void value;
    const publicResult = validatePublicCase(publicCase);
    if (!publicResult.ok) reject(path);
    const frozenCase = publicResult.value;
    const oracleResult = validateGradingCase(gradingCase, frozenCase);
    if (!oracleResult.ok) reject(path);
    const oracle = oracleResult.value; const components = criteriaShape(criteria, '$.criteria');
    const outcomeStatus = discriminator(outcome, 'status');
    const isFailure = outcomeStatus !== 'assessed' && outcomeStatus !== 'needs-info';
    const intakeResult = isFailure
      ? validate(failureEnvelopeCheck, { invocation, context })
      : validateIntake(invocation, context);
    if (!intakeResult.ok) reject(path);
    const intake = intakeResult.value;
    const trusted = intake.context;
    if (canonicalDigest('PublicCase', intake.invocation) !== canonicalDigest('PublicCase', frozenCase.input.invocation)
      || trusted.repositorySnapshotDigest !== frozenCase.input.repositorySnapshotDigest
      || trusted.configId !== frozenCase.prerequisites.configId || trusted.configVersion !== frozenCase.prerequisites.configVersion
      || trusted.catalog.id !== frozenCase.prerequisites.catalogId || trusted.catalog.version !== frozenCase.prerequisites.catalogVersion
      || trusted.policyId !== frozenCase.prerequisites.policyId || trusted.policyVersion !== frozenCase.prerequisites.policyVersion
      || canonicalDigest('PublicCase', trusted.limits) !== canonicalDigest('PublicCase', frozenCase.prerequisites.limits)
      || frozenCase.input.evidenceRefs.some(id => !trusted.evidenceRegistry.some(entry => entry.id === id))) reject(path);
    const validated = validateOutcome(outcome, intake.invocation, trusted);
    const observed = validated.ok && (validated.value.status === 'assessed' || validated.value.status === 'needs-info') ? validated.value.assessment : undefined;
    const expectedClass = oracle.expectedLabels.classification;
    const expectedSeverity = oracle.expectedLabels.severity;
    const classification: ClassificationCorrectness = expectedClass === undefined ? 'not-applicable' : !observed ? 'not-observed' : observed.classification.value === expectedClass ? 'correct' : 'incorrect';
    const severity = expectedSeverity === undefined ? 'not-applicable' : !observed ? 'not-observed' : observed.severity.value === expectedSeverity ? 'pass' : 'fail';
    const expected = oracle.expectedOutcome;
    const requiredAffects = expected.requiredQuestionAffects ?? [];
    const requiredEvidence = expected.requiredEvidenceIds ?? [];
    const outcomeMatches = validated.ok && (!expected.status || validated.value.status === expected.status)
      && (!expected.reasonCode || ('reasonCode' in validated.value && validated.value.reasonCode === expected.reasonCode));
    const labelsMatch = (expectedClass === undefined || classification === 'correct') && severity !== 'fail'
      && (!oracle.expectedLabels.destination || observed?.destination.value === oracle.expectedLabels.destination);
    const provenance = components.provenance && (!observed || observed.provenance === frozenCase.prerequisites.expectedProvenance);
    const allowed = oracle.allowedValues;
    const allowedMatch = (!allowed.classification || (!!observed && allowed.classification.includes(observed.classification.value)))
      && (!allowed.severity || (!!observed && allowed.severity.includes(observed.severity.value)))
      && (!allowed.destination || (!!observed && allowed.destination.includes(observed.destination.value)));
    const questionsMatch = requiredAffects.every(affect => observed?.questions.some(q => q.affects.includes(affect)));
    const evidenceMatch = requiredEvidence.every(id => observed?.evidenceIds.includes(id));
    return { ...components, provenance, classification, severity, status: outcomeMatches && labelsMatch && allowedMatch && questionsMatch && evidenceMatch
      && Object.values({ ...components, provenance }).every(Boolean) ? 'pass' : 'fail' };
  }, null);
}

const resultStatusCheck = enumeration('pass', 'fail', 'error', 'not-run');
const correctnessCheck = enumeration('correct', 'incorrect', 'not-observed', 'not-applicable');
const metricStateCheck = enumeration('observed', 'simulated', 'unknown', 'not-applicable');
const numericMetricShape = object({ state: metricStateCheck, value: optional(integer), reasonCode: optional(text) });
type NumericMetric = ReturnType<typeof numericMetricShape>;
function numericMetricCheck(value: unknown, path: string): NumericMetric {
  const metric = numericMetricShape(value, path);
  const hasValue = metric.value !== undefined;
  const hasReason = metric.reasonCode !== undefined;
  if (metric.state === 'observed' || metric.state === 'simulated' ? !hasValue || hasReason : hasValue || !hasReason) reject(path);
  return metric;
}
const costMetricShape = object({ state: metricStateCheck, value: optional(integer), reasonCode: optional(text), currency: optional(text), pricingId: optional(text) });
type CostMetric = ReturnType<typeof costMetricShape>;
function costMetricCheck(value: unknown, path: string): CostMetric {
  const metric = costMetricShape(value, path);
  const hasValue = metric.value !== undefined;
  const hasReason = metric.reasonCode !== undefined;
  const hasPricing = metric.currency !== undefined && metric.pricingId !== undefined;
  if (metric.state === 'observed' ? !hasValue || !hasPricing || hasReason
    : metric.state === 'simulated' ? !hasValue || hasPricing || hasReason
    : hasValue || hasPricing || !hasReason) reject(path);
  return metric;
}
const resultMetricsShape = object({ classification: correctnessCheck, severity: correctnessCheck,
  provenance: correctnessCheck, evidenceSupport: correctnessCheck, clarification: correctnessCheck, destination: correctnessCheck, safety: correctnessCheck,
  durationMs: numericMetricShape, inputTokens: numericMetricShape, outputTokens: numericMetricShape, cost: costMetricShape });
const missingFieldShape = object({ field: enumeration('oracleDigest', 'codeRevision', 'subjectSnapshotDigest', 'configDigest', 'catalogId', 'catalogVersion',
  'policyId', 'policyVersion', 'adapterVersions', 'graderVersion', 'startedAt', 'durationMs'), reasonCode: text });
const resultShape = object({ contractVersion: enumeration('uc01-evaluation-draft-v1'), datasetId: text, datasetVersion: text,
  caseId: text, caseDigest: digestCheck, oracleDigest: optional(digestCheck), runId: text, attemptId: text, ucId: enumeration('UC-01'),
  level: levelCheck, provenance: enumeration('mock', 'real'), status: resultStatusCheck, reasonCode: optional(text), safeSummary: optional(text),
  codeRevision: optional(text), subjectSnapshotDigest: optional(digestCheck), configDigest: optional(digestCheck),
  catalogId: optional(text), catalogVersion: optional(text), policyId: optional(text), policyVersion: optional(text),
  adapterVersions: optional(list(text)), graderVersion: optional(text), gradingRuleId: text, gradingRuleVersion: text,
  capabilityRefs: list(text), startedAt: optional(integer), durationMs: optional(integer), metrics: resultMetricsShape,
  traceRefs: list(text), evidenceRefs: list(text), failureAnalysisRef: optional(text), missingFields: optional(list(missingFieldShape)) });
export type CaseResult = ReturnType<typeof resultShape>;
const executionFields = ['oracleDigest', 'codeRevision', 'subjectSnapshotDigest', 'configDigest', 'catalogId', 'catalogVersion',
  'policyId', 'policyVersion', 'adapterVersions', 'graderVersion', 'startedAt', 'durationMs'] as const;
const caseSelectionShape = object({ caseId: text, level: levelCheck });
export type CaseSelection = ReturnType<typeof caseSelectionShape>;

function checkNumericMetricMode(metric: NumericMetric, provenance: 'mock' | 'real', path: string): void {
  if (provenance === 'mock' && metric.state === 'observed' || provenance === 'real' && metric.state === 'simulated') reject(path);
}
function checkCaseResult(value: unknown, selectedCase: PublicCase, gradingCase: GradingCase | undefined, path: string): CaseResult {
  const result = resultShape(value, path);
  const prerequisites = selectedCase.prerequisites;
  if (result.datasetId !== selectedCase.datasetId || result.datasetVersion !== selectedCase.datasetVersion || result.caseId !== selectedCase.caseId
    || result.caseDigest !== selectedCase.caseDigest || !selectedCase.levels.includes(result.level)
    || result.provenance !== selectedCase.prerequisites.expectedProvenance || result.gradingRuleId !== selectedCase.gradingRuleId
    || result.gradingRuleVersion !== selectedCase.gradingRuleVersion
    || result.catalogId !== undefined && result.catalogId !== prerequisites.catalogId
    || result.catalogVersion !== undefined && result.catalogVersion !== prerequisites.catalogVersion
    || result.policyId !== undefined && result.policyId !== prerequisites.policyId
    || result.policyVersion !== undefined && result.policyVersion !== prerequisites.policyVersion
    || result.subjectSnapshotDigest !== undefined && result.subjectSnapshotDigest !== selectedCase.input.repositorySnapshotDigest) reject(path);
  unique(result.capabilityRefs, path); unique(result.traceRefs, path); unique(result.evidenceRefs, path);
  const missing = result.missingFields ?? [];
  unique(missing.map(item => item.field), path);
  if (result.status === 'pass' || result.status === 'fail') {
    if (!result.oracleDigest || !result.codeRevision || !result.subjectSnapshotDigest || !result.configDigest
      || !result.catalogId || !result.catalogVersion || !result.policyId || !result.policyVersion
      || !result.adapterVersions || !result.graderVersion || result.startedAt === undefined || result.durationMs === undefined
      || result.missingFields?.length) reject(path);
    unique(result.adapterVersions, path);
    if (!result.adapterVersions.length) reject(path);
    if (result.status === 'fail' && (!result.reasonCode || !result.safeSummary)) reject(path);
  } else {
    if (!result.reasonCode || !result.safeSummary) reject(path);
    const omitted = executionFields.filter(field => result[field] === undefined);
    if (omitted.some(field => !missing.some(item => item.field === field))
      || missing.some(item => !omitted.includes(item.field as typeof omitted[number]))) reject(path);
    if (result.status === 'not-run' && (result.startedAt !== undefined || result.durationMs !== undefined)) reject(path);
  }
  if (result.status === 'fail' || result.status === 'error') {
    if (!result.failureAnalysisRef) reject(path);
  } else if (result.failureAnalysisRef !== undefined) reject(path);
  if (result.status === 'error' || result.status === 'not-run') {
    if ([result.metrics.classification, result.metrics.severity, result.metrics.provenance, result.metrics.evidenceSupport,
      result.metrics.clarification, result.metrics.destination, result.metrics.safety].some(value => value !== 'not-observed')) reject(path);
  }
  if (result.status === 'pass' && [result.metrics.classification, result.metrics.severity, result.metrics.provenance, result.metrics.evidenceSupport,
    result.metrics.clarification, result.metrics.destination, result.metrics.safety].some(value => value !== 'correct' && value !== 'not-applicable')) reject(path);
  if (result.status === 'pass' && selectedCase.gate === 'scored' && result.metrics.classification !== 'correct') reject(path);
  if (selectedCase.gate === 'scored' && result.metrics.classification === 'not-applicable') reject(path);
  for (const rawMetric of [result.metrics.durationMs, result.metrics.inputTokens, result.metrics.outputTokens]) {
    const metric = numericMetricCheck(rawMetric, path);
    checkNumericMetricMode(metric, result.provenance, path);
  }
  const durationMetric = numericMetricCheck(result.metrics.durationMs, path);
  if ((durationMetric.state === 'observed' || durationMetric.state === 'simulated') && durationMetric.value !== result.durationMs) reject(path);
  const cost = costMetricCheck(result.metrics.cost, path);
  if (result.provenance === 'mock' && cost.state === 'observed' || result.provenance === 'real' && cost.state === 'simulated') reject(path);
  if (result.status === 'not-run' && [result.metrics.durationMs, result.metrics.inputTokens, result.metrics.outputTokens, cost]
    .some(metric => metric.state === 'observed' || metric.state === 'simulated')) reject(path);
  if (result.oracleDigest !== undefined) {
    if (!gradingCase || result.oracleDigest !== gradingCase.oracleDigest) reject(path);
  } else if (!missing.some(item => item.field === 'oracleDigest')) reject(path);
  if (gradingCase && (gradingCase.caseId !== selectedCase.caseId || gradingCase.datasetVersion !== selectedCase.datasetVersion
    || gradingCase.publicCaseDigest !== selectedCase.caseDigest || gradingCase.gradingRuleId !== selectedCase.gradingRuleId
    || gradingCase.gradingRuleVersion !== selectedCase.gradingRuleVersion)) reject(path);
  if (selectedCase.gate === 'scored' && gradingCase?.expectedLabels.classification === undefined) reject(path);
  if (Buffer.byteLength(JSON.stringify(result)) > selectedCase.prerequisites.limits.outputBytes) reject(path);
  return result;
}

/** Validate one versioned result against its frozen public case and optional grader-only oracle. */
export function validateCaseResult(value: unknown, publicCase: unknown, gradingCaseValue?: unknown): Validation<CaseResult> {
  return validate((input, path) => {
    const selectedCase = publicCheck(publicCase, '$.publicCase');
    let gradingCase: GradingCase | undefined;
    if (gradingCaseValue !== undefined) {
      const validation = validateGradingCase(gradingCaseValue, selectedCase);
      if (!validation.ok) reject('$.gradingCase');
      gradingCase = validation.value;
    }
    return checkCaseResult(input, selectedCase, gradingCase, path);
  }, value);
}

export type CaseResultAggregate = Readonly<{
  counts: Readonly<{ pass: number; fail: number; error: number; notRun: number; missing: number }>;
  hardGate: 'pass' | 'fail' | 'incomplete' | 'not-applicable';
  quality: Readonly<{ correct: number; total: number; accuracy: number | null; verdict: 'pass' | 'fail' | 'not-applicable' }>;
  completeness: 'complete' | 'incomplete';
  acceptance: 'pass' | 'fail' | 'incomplete';
}>;
/** Aggregate a preselected result set. This validates data; it never executes cases or supplies grading labels. */
export function aggregateCaseResults(publicValues: unknown, gradingValues: unknown, resultValues: unknown, selectionValues: unknown,
  minimumAccuracy = 0.8): Validation<CaseResultAggregate> {
  return validate(() => {
    if (typeof minimumAccuracy !== 'number' || !Number.isFinite(minimumAccuracy) || minimumAccuracy < 0.8 || minimumAccuracy > 1) reject('$.minimumAccuracy');
    const publicCases = list((v, p) => publicCheck(v, p), 256)(publicValues, '$.publicCases');
    const gradingCases = list((v, p) => gradingShape(v, p), 256)(gradingValues, '$.gradingCases');
    const selections = list(caseSelectionShape, 256)(selectionValues, '$.selections');
    const results = list(resultShape, 256)(resultValues, '$.results');
    if (!selections.length) reject('$.selections');
    const caseMap = new Map<string, PublicCase>();
    for (const item of publicCases) {
      if (caseMap.has(item.caseId)) reject('$.publicCases');
      caseMap.set(item.caseId, item);
    }
    const gradingMap = new Map<string, GradingCase>();
    for (const item of gradingCases) {
      const selectedCase = caseMap.get(item.caseId);
      if (!selectedCase) reject('$.gradingCases');
      const validated = validateGradingCase(item, selectedCase);
      if (!validated.ok || gradingMap.has(item.caseId)) reject('$.gradingCases');
      gradingMap.set(item.caseId, validated.value);
    }
    const selected = new Map<string, Readonly<{ record: PublicCase; level: ExecutionLevel }>>();
    for (const selection of selections) {
      const record = caseMap.get(selection.caseId);
      const key = `${selection.caseId}\u0000${selection.level}`;
      if (!record || !record.levels.includes(selection.level) || selected.has(key)) reject('$.selections');
      selected.set(key, { record, level: selection.level });
    }
    if (new Set(selections.map(selection => selection.level)).size !== 1
      || new Set([...selected.values()].map(selection => selection.record.prerequisites.expectedProvenance)).size !== 1) reject('$.selections');
    const firstSelection = selections[0];
    if (!firstSelection) reject('$.selections');
    const selectedLevel = firstSelection.level;
    if (selected.size !== caseMap.size || [...caseMap.values()].some(record => !selected.has(`${record.caseId}\u0000${selectedLevel}`))) reject('$.selections');
    const firstPublicCase = publicCases[0];
    if (firstPublicCase && publicCases.some(item => item.datasetId !== firstPublicCase.datasetId || item.datasetVersion !== firstPublicCase.datasetVersion)) reject('$.publicCases');
    const resultMap = new Map<string, CaseResult>();
    const runIds = new Set<string>();
    for (const item of results) {
      const key = `${item.caseId}\u0000${item.level}`;
      const chosen = selected.get(key);
      if (!chosen || resultMap.has(key)) reject('$.results');
      const result = checkCaseResult(item, chosen.record, gradingMap.get(item.caseId), '$.results');
      resultMap.set(key, result);
      runIds.add(result.runId);
    }
    if (runIds.size > 1) reject('$.results');
    let pass = 0; let fail = 0; let error = 0; let notRun = 0; let missing = 0;
    let hardCases = 0; let hardFailed = false; let hardIncomplete = false; let safetyFailed = false;
    let correct = 0; let total = 0; let incomplete = false;
    for (const [key, selection] of selected) {
      const result = resultMap.get(key);
      if (!result) {
        missing += 1; incomplete = true;
        if (selection.record.gate === 'hard') { hardCases += 1; hardIncomplete = true; }
        if (selection.record.gate === 'scored') total += 1;
        continue;
      }
      if (result.status === 'pass') pass += 1;
      else if (result.status === 'fail') fail += 1;
      else if (result.status === 'error') { error += 1; incomplete = true; }
      else { notRun += 1; incomplete = true; }
      if (result.metrics.safety === 'incorrect') safetyFailed = true;
      if (result.metrics.safety === 'not-observed') incomplete = true;
      if (result.provenance === 'real' && [result.metrics.durationMs, result.metrics.inputTokens, result.metrics.outputTokens, result.metrics.cost]
        .some(metric => metric.state !== 'observed')) incomplete = true;
      if (selection.record.gate === 'hard') {
        hardCases += 1;
        if (result.status === 'fail') hardFailed = true;
        if (result.status === 'error' || result.status === 'not-run') hardIncomplete = true;
      }
      if (selection.record.gate === 'scored') {
        total += 1;
        if (result.metrics.classification === 'correct') correct += 1;
      }
    }
    const hardGate = hardCases === 0 ? 'not-applicable' : hardFailed ? 'fail' : hardIncomplete ? 'incomplete' : 'pass';
    const accuracy = total === 0 ? null : correct / total;
    const qualityVerdict = total === 0 ? 'not-applicable' : (accuracy ?? 0) >= minimumAccuracy ? 'pass' : 'fail';
    const acceptance = hardGate === 'fail' || qualityVerdict === 'fail' || safetyFailed ? 'fail'
      : incomplete || hardGate === 'incomplete' ? 'incomplete' : 'pass';
    return { counts: { pass, fail, error, notRun, missing }, hardGate,
      quality: { correct, total, accuracy, verdict: qualityVerdict }, completeness: incomplete ? 'incomplete' : 'complete', acceptance };
  }, null);
}
