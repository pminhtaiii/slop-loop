import { IssueAssessor, type AssessmentPorts, type ReserveCeiling } from './assess.ts';
import type { ExcerptAdmission } from './intake.ts';
import { admitProductionProfile, priceUsage, type ProductionProfile } from './production-profile.ts';
import { isProtectedPayload } from '../foundation/telemetry.ts';

export const COMPOSITION_VERSION = 'uc01-composition-v1';
const requirements = {
  policy: ['bound-action-policy', 'current-snapshot', 'cumulative-operation-limits'],
  accounting: ['durable-task-run-reservation', 'uncertain-ceiling-retained', 'restart-reconciliation'],
  model: ['triage-role', 'bounded-provider-dispatch', 'usage-and-pricing'],
  repository: ['guarded-read-search', 'verified-locators', 'protected-content'],
  continuation: ['durable-immutable-binding'], telemetry: ['sanitized-events'], excerpts: ['digest-bound-excerpts'],
} as const;
type Component = keyof typeof requirements;
type Components = Readonly<{
  policy: Pick<AssessmentPorts, 'guard'>;
  accounting: Pick<AssessmentPorts, 'reserve' | 'settle'>;
  model: Pick<AssessmentPorts, 'proposeAssessment'>;
  repository: Pick<AssessmentPorts, 'readEvidence' | 'searchEvidence'>;
  continuation: Pick<AssessmentPorts, 'bindContinuation' | 'resolveContinuation'>;
  telemetry: Pick<AssessmentPorts, 'emitSafeEvent'>;
  excerpts: ExcerptAdmission;
}>;
export type AdapterDelivery = { [K in Component]: Readonly<{
  id: string; component: K; contractVersion: 'uc01-consumer-v1'; revision: string; provenance: 'real' | 'mock';
  capabilities: readonly string[]; evidenceRef: string; adapter: Components[K];
}> }[Component];
export type CompositionConfiguration = Readonly<{ version: typeof COMPOSITION_VERSION;
  selected: Readonly<Record<Component, string>>; profile: ProductionProfile; ceiling: ReserveCeiling }>;
export type CompositionResult = Readonly<{ status: 'ready'; assessor: IssueAssessor; revisions: Readonly<Record<string, string>> }>
  | Readonly<{ status: 'denied'; reasonCode: 'incompatible-production-dependencies' }>;
const methods: Readonly<Record<Component, readonly string[]>> = {
  policy: ['guard'], accounting: ['reserve', 'settle'], model: ['proposeAssessment'], repository: ['readEvidence', 'searchEvidence'],
  continuation: ['bindContinuation', 'resolveContinuation'], telemetry: ['emitSafeEvent'], excerpts: ['resolveExcerpt'],
};

/** Registry is supplied by the trusted host, never by issue/model input. No adapter is called during admission. */
export function composeIssueAssessor(config: CompositionConfiguration, registry: readonly AdapterDelivery[], now: () => number = Date.now): CompositionResult {
  try {
    if (config.version !== COMPOSITION_VERSION || config.profile.profileId !== 'uc01-production-v1'
      || registry.length !== new Set(registry.map(item => item.id)).size || isProtectedPayload(config)) throw new Error('Invalid composition');
    const selected = new Map<Component, AdapterDelivery>();
    const revisions: Record<string, string> = {};
    for (const component of Object.keys(requirements) as Component[]) {
      const delivery = registry.find(item => item.id === config.selected[component]);
      if (!delivery || delivery.component !== component || delivery.contractVersion !== 'uc01-consumer-v1' || delivery.provenance !== 'real'
        || !/^[a-f0-9]{40,64}$/u.test(delivery.revision) || typeof delivery.evidenceRef !== 'string' || !delivery.evidenceRef.trim()
        || isProtectedPayload({ id: delivery.id, evidenceRef: delivery.evidenceRef })
        || Reflect.get(delivery.adapter, 'productionEligible') === false
        || (Reflect.has(delivery.adapter, 'provenance') && Reflect.get(delivery.adapter, 'provenance') !== 'real')
        || requirements[component].some(capability => !delivery.capabilities.includes(capability))
        || methods[component].some(method => typeof Reflect.get(delivery.adapter, method) !== 'function')) throw new Error('Missing delivery');
      selected.set(component, delivery); revisions[delivery.id] = delivery.revision;
    }
    const profile = admitProductionProfile(config.profile);
    const ceiling = Object.freeze({ ...config.ceiling });
    if (ceiling.pricingId !== profile.pricing.pricingId || ceiling.totalTokens !== ceiling.inputTokens + ceiling.outputTokens
      || ['inputTokens', 'outputTokens', 'totalTokens', 'costUnits'].some(key => {
        const value = ceiling[key as keyof Omit<ReserveCeiling, 'pricingId'>];
        return !Number.isSafeInteger(value) || value <= 0 || value > profile.limits[key as keyof typeof profile.limits];
      }) || priceUsage(profile.pricing, ceiling.inputTokens, ceiling.outputTokens) !== ceiling.costUnits) throw new Error('Invalid ceiling');
    // Capture bound methods now: later registry replacement cannot change admitted dependencies.
    const captured: Record<string, (...args: never[]) => unknown> = {};
    for (const [component, delivery] of selected) {
      for (const method of methods[component]) {
        const fn: unknown = Reflect.get(delivery.adapter, method);
        if (typeof fn !== 'function') throw new Error('Missing method');
        captured[method] = fn.bind(delivery.adapter) as (...args: never[]) => unknown;
      }
    }
    // Each required callable was captured and checked above; the component map fixes its public signature.
    const ports = Object.freeze({ ...captured, provenance: 'real' as const }) as unknown as AssessmentPorts;
    const excerpts = { resolveExcerpt: captured.resolveExcerpt } as ExcerptAdmission;
    return { status: 'ready', assessor: new IssueAssessor({ ports, excerpts, now, profileId: 'uc01-production-v1', production: profile, ceiling }),
      revisions: Object.freeze(revisions) };
  } catch { return { status: 'denied', reasonCode: 'incompatible-production-dependencies' }; }
}
