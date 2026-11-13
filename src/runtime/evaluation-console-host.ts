/** Same-process console composition over one already-validated UC-03 readiness object. */

import { createConsoleServer, type ConsoleAddress, type ConsoleApprovalPort, type ConsoleArtifact } from './console-server.ts';
import { createEvaluationService, type EvaluationService, type ServiceControl } from './evaluation-service.ts';
import { createUC03EvaluationGraph, type UC03EvaluationGraphRoute } from './evaluation-graph.ts';
import { isAdmittedEvaluationProfile, type CatalogEntry, type EvaluationProfile } from './evaluation-profile.ts';
import { catalogDigestOf } from './evaluation-profile-primitives.ts';
import type { UC03ControlledHostReadiness, UC03HostReadiness } from './uc03-host-bootstrap.ts';

type ReadyHost = Extract<UC03HostReadiness, { readonly status: 'ready' }> | Extract<UC03ControlledHostReadiness, { readonly status: 'controlled-ready' }>;

export interface EvaluationConsoleConfiguration {
  readonly identity: Readonly<Record<string, string>>;
  readonly profileDigest: string;
  readonly configDigest: string;
  readonly pricingDigest: string;
  readonly requestedModel: string;
  readonly adapterVersions: readonly string[];
}

export interface EvaluationConsoleAssembly {
  readonly profile: EvaluationProfile;
  readonly catalog: readonly CatalogEntry[];
  readonly repositoryIds: readonly string[];
  readonly checkSetIds: readonly string[];
  readonly control: ServiceControl;
  readonly approval: ConsoleApprovalPort;
  readonly artifacts?: ReadonlyMap<string, ConsoleArtifact> | undefined;
  readonly routesFor: (readiness: ReadyHost, catalog: readonly CatalogEntry[]) => ReadonlyMap<string, UC03EvaluationGraphRoute>;
  readonly customRoute?: UC03EvaluationGraphRoute | undefined;
  readonly operatorToken: () => string;
}

export type EvaluationConsoleFactory = (input: Readonly<{ readiness: ReadyHost; configuration: EvaluationConsoleConfiguration }>) => EvaluationConsoleAssembly;

export interface EvaluationConsoleHost {
  readonly address: ConsoleAddress;
  close(): Promise<void>;
}

export type EvaluationConsoleHostResult =
  | Readonly<{ ok: true; host: EvaluationConsoleHost }>
  | Readonly<{ ok: false; reasonCode: 'HOST_CONSOLE_UNAVAILABLE' | 'HOST_CONSOLE_LISTEN_FAILED' }>;

const unavailable = (): EvaluationConsoleHostResult => ({ ok: false, reasonCode: 'HOST_CONSOLE_UNAVAILABLE' });
const IDENTIFIER = /^[A-Za-z0-9._:/@-]{1,256}$/u;

function matchesEntry(left: CatalogEntry | undefined, right: CatalogEntry): boolean {
  return left !== undefined && left.catalogEntryId === right.catalogEntryId && left.caseId === right.caseId && left.version === right.version &&
    left.caseDigest === right.caseDigest && left.publicTaskDigest === right.publicTaskDigest && left.initialRepositoryDigest === right.initialRepositoryDigest &&
    left.fixturePath === right.fixturePath && left.fixtureDigest === right.fixtureDigest && left.grader.version === right.grader.version &&
    left.grader.digest === right.grader.digest && left.grader.path === right.grader.path;
}

function budgetFits(route: UC03EvaluationGraphRoute, profile: EvaluationProfile): boolean {
  const budget = route.coderBudget;
  return Number.isSafeInteger(budget.maxModelCalls) && budget.maxModelCalls > 0 && budget.maxModelCalls <= profile.limits.totalModelCalls &&
    Number.isFinite(budget.maxActiveMs) && budget.maxActiveMs > 0 && budget.maxActiveMs <= profile.limits.activeExecutionMs &&
    Number.isSafeInteger(budget.maxRepairs) && budget.maxRepairs > 0 && budget.maxRepairs <= profile.limits.repairs &&
    Number.isSafeInteger(budget.maxReplans) && budget.maxReplans > 0 && budget.maxReplans <= profile.limits.materialReplans;
}

function validRoute(route: UC03EvaluationGraphRoute, readiness: ReadyHost, profile: EvaluationProfile): boolean {
  return route.readiness === readiness && typeof route.resolveTask === 'function' && typeof route.resolveDirection === 'function' && budgetFits(route, profile) &&
    (route.expectedWait === null || route.expectedWait === 'waiting-approval' || route.expectedWait === 'waiting-info');
}

function matchesIdentity(readiness: ReadyHost, configuration: EvaluationConsoleConfiguration, profile: EvaluationProfile): boolean {
  const expected = {
    profileId: profile.profileId,
    profileDigest: configuration.profileDigest,
    configDigest: configuration.configDigest,
    pricingDigest: configuration.pricingDigest,
  };
  return Object.entries(expected).every(([key, value]) => configuration.identity[key] === value && readiness.identity[key] === value) &&
    profile.profileDigest === configuration.profileDigest && profile.configDigest === configuration.configDigest &&
    profile.pricingDigest === configuration.pricingDigest && profile.model === configuration.requestedModel &&
    profile.adapterVersions.length === configuration.adapterVersions.length && profile.adapterVersions.every((value, index) => value === configuration.adapterVersions[index]);
}

function validAssembly(readiness: ReadyHost, configuration: EvaluationConsoleConfiguration, assembly: EvaluationConsoleAssembly): boolean {
  const { profile, catalog, repositoryIds, checkSetIds } = assembly;
  if (!isAdmittedEvaluationProfile(profile) || !matchesIdentity(readiness, configuration, profile) || !Array.isArray(catalog) || catalog.length === 0) return false;
  if (catalogDigestOf(catalog) !== profile.catalogDigest || !Array.isArray(repositoryIds) || !repositoryIds.length || repositoryIds.some(id => typeof id !== 'string' || !IDENTIFIER.test(id))) return false;
  if (!Array.isArray(checkSetIds) || !checkSetIds.length || checkSetIds.some(id => typeof id !== 'string' || !IDENTIFIER.test(id))) return false;
  if (typeof assembly.control?.issue !== 'function' || typeof assembly.approval?.presentation !== 'function' || typeof assembly.approval?.decide !== 'function' || typeof assembly.routesFor !== 'function' || typeof assembly.operatorToken !== 'function') return false;
  return true;
}

/**
 * Builds the graph, service and listener once. A controlled-ready value is accepted only when a
 * controlled test passes it explicitly; the production CLI supplies only `ready` from prepareUC03Host.
 */
export async function createEvaluationConsoleHost(
  readiness: UC03HostReadiness | UC03ControlledHostReadiness,
  configuration: EvaluationConsoleConfiguration,
  factory: EvaluationConsoleFactory,
): Promise<EvaluationConsoleHostResult> {
  let server: ReturnType<typeof createConsoleServer> | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closePromise) closePromise = server ? server.close() : Promise.resolve();
    return closePromise;
  };
  try {
    if ((readiness.status !== 'ready' && readiness.status !== 'controlled-ready') || typeof factory !== 'function') return unavailable();
    const assembly = factory({ readiness, configuration });
    if (!validAssembly(readiness, configuration, assembly)) return unavailable();

    const routes = assembly.routesFor(readiness, assembly.catalog);
    if (!(routes instanceof Map) || routes.size !== assembly.catalog.length) return unavailable();
    for (const entry of assembly.catalog) {
      const route = routes.get(entry.caseId);
      if (!route || !validRoute(route, readiness, assembly.profile) || !matchesEntry(route.entry, entry)) return unavailable();
    }

    const customRoute = assembly.customRoute;
    if (customRoute !== undefined && (!validRoute(customRoute, readiness, assembly.profile) || customRoute.workflowReport !== undefined)) return unavailable();
    const graph = createUC03EvaluationGraph({ catalogRoutes: routes, ...(customRoute === undefined ? {} : { customRoute }) });
    const service: EvaluationService = createEvaluationService({
      profile: assembly.profile,
      catalog: assembly.catalog,
      repositoryIds: assembly.repositoryIds,
      checkSetIds: assembly.checkSetIds,
      control: assembly.control,
      graph,
    });
    const token = assembly.operatorToken();
    if (typeof token !== 'string' || token.length < 16 || token.length > 512) return unavailable();
    server = createConsoleServer({
      service,
      catalog: assembly.catalog,
      operatorToken: token,
      approval: assembly.approval,
      ...(assembly.artifacts === undefined ? {} : { artifacts: assembly.artifacts }),
      workflowReportLookup: {
        getWorkflowReport(experimentId) {
          const result = service.getExperiment(experimentId);
          return result.ok ? result.value.workflowReport : null;
        },
      },
    });
    const address = await server.listen();
    return { ok: true, host: { address, close } };
  } catch {
    await close().catch(() => undefined);
    return { ok: false, reasonCode: server ? 'HOST_CONSOLE_LISTEN_FAILED' : 'HOST_CONSOLE_UNAVAILABLE' };
  }
}
