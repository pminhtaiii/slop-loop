/** Host-file loading and assembly resolution for the evaluation CLI. Trusted binding comes from the host, never argv. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkflowDriver } from '../../eval/uc03/types.ts';
import type { EvaluationConsoleFactory } from '../runtime/evaluation-console-host.ts';
import { prepareUC03Host, type UC03HostInputs, type UC03HostPins, type UC03HostReadiness } from '../runtime/uc03-host-bootstrap.ts';
import { UC03_PRODUCTION_COMPONENTS_V02, type UC03ProductionComponentV02 } from '../uc03/graph-types-v02.ts';
import { isEvaluationControlBindings, type EvaluationControlBindings } from './evaluate-control.ts';

export interface EvaluateCliResult {
  readonly exitCode: number;
  readonly output: string;
  readonly close?: (() => Promise<void>) | undefined;
}

export type UC03HostReady = Extract<UC03HostReadiness, { status: 'ready' }>;

/** Host-supplied adapter wiring. Pins and identity come from the host-only configuration file. */
export type HostAssembly = Omit<UC03HostInputs, 'pins' | 'identity'>;

/** A host-only configuration file. It resolves references; it never carries authority. */
export interface HostConfiguration {
  readonly identity: Readonly<Record<string, string>>;
  readonly pins: UC03HostPins;
  readonly profileDigest: string;
  readonly configDigest: string;
  readonly pricingDigest: string;
  readonly requestedModel: string;
  readonly adapterVersions: readonly string[];
  /** Reference to an operator-supplied assembly module. A path, never a port, fact or credential. */
  readonly assembly?: string | undefined;
}

export type HostConfigurationLoad = Readonly<{ ok: true; value: HostConfiguration }> | Readonly<{ ok: false; error: EvaluateCliResult }>;

export type HostProduction = (ready: UC03HostReady) => WorkflowDriver;

/** The validated §(i) projection. Exactly these keys, each already checked against its pattern. */
export type HostMetadata = Readonly<{
  profileDigest: string;
  endpointDigest: string;
  endpointScheme: 'https' | 'http';
  insecureHttpAcknowledged: boolean;
  model: string;
  imageId: string;
}>;

export type HostPreflight = () => Promise<Readonly<{ ok: true; dockerServerVersion: string; imageId: string }> | Readonly<{ ok: false; reasonCode: 'docker-unavailable' | 'image-mismatch' }>>;

/** The only operational outcomes §(i) projects. Anything else is the dead-daemon refusal. */
export type HostOperational = 'ready' | 'docker-unavailable' | 'image-mismatch';

const DOCKER_SERVER_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/u;

/**
 * A preflight is imported host code, so its result is `unknown`: only the two allowlisted variants
 * are accepted, each field against its own pattern, and anything else becomes the fixed dead-daemon
 * refusal. No field of a rejected result is ever projected, so a URL or a key in it cannot be echoed.
 */
export function classifyPreflightResult(value: unknown): HostOperational {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined;
  if (record?.['ok'] === true) {
    return typeof record['dockerServerVersion'] === 'string' && DOCKER_SERVER_VERSION.test(record['dockerServerVersion']) && typeof record['imageId'] === 'string' && SHA256.test(record['imageId'])
      ? 'ready'
      : 'docker-unavailable';
  }
  const reason = record?.['ok'] === false ? record['reasonCode'] : undefined;
  return reason === 'docker-unavailable' || reason === 'image-mismatch' ? reason : 'docker-unavailable';
}

/** What the operator's assembly module contributes: the host wiring and an optional route binding. */
export type HostAssemblyResolution = Readonly<{
  host: HostAssembly;
  production?: HostProduction | undefined;
  control?: EvaluationControlBindings | undefined;
  console?: EvaluationConsoleFactory | undefined;
  /** Static §(i) metadata, validated by the caller; `unknown` because a module is untrusted input. */
  metadata?: unknown;
  preflight?: HostPreflight | undefined;
}>;

/** The one name an assembly module must export. It is a factory, so the module decides its own wiring. */
const ASSEMBLY_FACTORY = 'createHostAssembly';

const HOST_KEYS = new Set(['profileId', 'profileDigest', 'configDigest', 'pricingDigest', 'requestedModel', 'adapterVersions', 'contractVersion', 'revisions', 'assembly']);
const CREDENTIAL = /credential|secret|token|password|api[-_]?key/iu;
const IDENTIFIER = /^[A-Za-z0-9._:/@-]{1,256}$/u;
const REVISION = /^[a-f0-9]{40,64}$/u;
/** A path, not a value: bounded and control-character-free, and it may contain Windows separators. */
const REFERENCE = /^[^\u0000-\u001f]{1,1024}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const METADATA_KEYS = new Set(['profileDigest', 'endpointDigest', 'endpointScheme', 'insecureHttpAcknowledged', 'model', 'imageId']);

/**
 * Contract §(i): exactly the allowlisted keys, each against its fixed pattern. An assembly module is
 * untrusted input, so anything else — an extra key, a wrong type, a malformed digest — is refused as
 * a whole, and nothing from the rejected value is echoed.
 */
export function validateHostMetadata(value: unknown): HostMetadata | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(raw);
  if (keys.length !== METADATA_KEYS.size || keys.some(key => !METADATA_KEYS.has(key))) return undefined;
  const { profileDigest, endpointDigest, endpointScheme, insecureHttpAcknowledged, model, imageId } = raw;
  if (typeof profileDigest !== 'string' || !SHA256.test(profileDigest)) return undefined;
  if (typeof endpointDigest !== 'string' || !SHA256.test(endpointDigest)) return undefined;
  if (endpointScheme !== 'https' && endpointScheme !== 'http') return undefined;
  if (typeof insecureHttpAcknowledged !== 'boolean') return undefined;
  if (typeof model !== 'string' || !IDENTIFIER.test(model)) return undefined;
  if (typeof imageId !== 'string' || !SHA256.test(imageId)) return undefined;
  return Object.freeze({ profileDigest, endpointDigest, endpointScheme, insecureHttpAcknowledged, model, imageId });
}

export function cliError(exitCode: number, code: string, message: string): EvaluateCliResult {
  return { exitCode, output: JSON.stringify({ error: code, message }) };
}

/**
 * Read the operator configuration. An unknown key is how a port, a policy fact or a credential
 * would arrive, so the whole file is refused instead — and no value is ever echoed back.
 */
export function loadHostConfiguration(filePath: string): HostConfigurationLoad {
  const refused = (code: string): HostConfigurationLoad => ({ ok: false, error: cliError(2, code, 'Host configuration was refused; values are not echoed') });
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(filePath), 'utf8'));
  } catch {
    return refused('HOST_CONFIG_ERROR');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return refused('HOST_CONFIG_ERROR');
  const raw = parsed as Readonly<Record<string, unknown>>;
  if (Object.keys(raw).some(key => !HOST_KEYS.has(key))) return refused('HOST_CONFIG_UNSUPPORTED_FIELD');
  if (Object.entries(raw).some(([key, value]) => CREDENTIAL.test(key) || CREDENTIAL.test(typeof value === 'string' ? value : ''))) return refused('HOST_CONFIG_UNSAFE_FIELD');

  const { profileId, profileDigest, configDigest, pricingDigest, requestedModel, adapterVersions, contractVersion, revisions, assembly } = raw;
  const text = (value: unknown): string => (typeof value === 'string' && IDENTIFIER.test(value) ? value : '');
  const id = text(profileId);
  const profile = text(profileDigest);
  const config = text(configDigest);
  const pricing = text(pricingDigest);
  const model = text(requestedModel);
  const contract = text(contractVersion);
  if ([id, profile, config, pricing, model, contract].some(value => value === '')) return refused('HOST_CONFIG_INCOMPLETE');
  // A reference only: the path is resolved later and never echoed.
  if (assembly !== undefined && (typeof assembly !== 'string' || !REFERENCE.test(assembly) || assembly.trim() === '')) return refused('HOST_CONFIG_INCOMPLETE');
  if (!Array.isArray(adapterVersions) || adapterVersions.length === 0 || adapterVersions.length > 64 || adapterVersions.some(value => text(value) === '')) return refused('HOST_CONFIG_INCOMPLETE');
  if (adapterVersions.some(value => typeof value === 'string' && CREDENTIAL.test(value))) return refused('HOST_CONFIG_UNSAFE_FIELD');
  if (typeof revisions !== 'object' || revisions === null || Array.isArray(revisions)) return refused('HOST_CONFIG_INCOMPLETE');
  const pinned: Record<string, string> = {};
  for (const [component, revision] of Object.entries(revisions)) {
    if (!UC03_PRODUCTION_COMPONENTS_V02.includes(component as UC03ProductionComponentV02) || typeof revision !== 'string' || !REVISION.test(revision)) return refused('HOST_CONFIG_INCOMPLETE');
    pinned[component] = revision;
  }

  return {
    ok: true,
    value: Object.freeze({
      identity: Object.freeze({ profileId: id, profileDigest: profile, configDigest: config, pricingDigest: pricing }),
      pins: Object.freeze({ contractVersion: contract, revisions: Object.freeze(pinned) }),
      profileDigest: profile,
      configDigest: config,
      pricingDigest: pricing,
      requestedModel: model,
      adapterVersions: Object.freeze(adapterVersions as readonly string[]),
      ...(typeof assembly === 'string' ? { assembly } : {}),
    }),
  };
}

/**
 * Resolve the operator's assembly reference. Every failure — absent file, throwing import, absent
 * factory, throwing factory, non-object result — collapses to the same named prerequisite gap, so no
 * exception text, path or imported value can reach the output.
 */
async function resolveAssembly(reference: string): Promise<HostAssemblyResolution | undefined> {
  try {
    // Trust: the host file is operator-owned, so a module path in it is an execution capability by
    // design; the loader keeps it a reference, never a port, fact or credential.
    // shortcut: the reference resolves against the process CWD, as `--host` already does, so a
    // relative path loads whatever sits there in the invocation directory; make it config-file-relative
    // (or require absolute) if operators keep host files away from the checkout.
    const module: unknown = await import(pathToFileURL(resolve(reference)).href);
    const factory: unknown = typeof module === 'object' && module !== null ? Reflect.get(module, ASSEMBLY_FACTORY) : undefined;
    if (typeof factory !== 'function') return undefined;
    const resolved: unknown = (factory as () => unknown)();
    if (typeof resolved !== 'object' || resolved === null) return undefined;
    const host: unknown = Reflect.get(resolved, 'host');
    const production: unknown = Reflect.get(resolved, 'production');
    const control: unknown = Reflect.get(resolved, 'control');
    const consoleFactory: unknown = Reflect.get(resolved, 'console');
    // §(i) members are optional: an assembly without them keeps the pre-T060 output exactly.
    const metadata: unknown = Reflect.get(resolved, 'metadata');
    const preflight: unknown = Reflect.get(resolved, 'preflight');
    if (typeof host !== 'object' || host === null) return undefined;
    if (production !== undefined && typeof production !== 'function') return undefined;
    if (control !== undefined && !isEvaluationControlBindings(control)) return undefined;
    if (consoleFactory !== undefined && typeof consoleFactory !== 'function') return undefined;
    if (preflight !== undefined && typeof preflight !== 'function') return undefined;
    // A preflight the CLI would never run is a broken assembly, not a benign extra: `observe` only
    // probes once metadata exists, so refuse the pair rather than silently drop the operator's probe.
    if (preflight !== undefined && metadata === undefined) return undefined;
    return {
      host: host as HostAssembly,
      ...(production === undefined ? {} : { production: production as HostProduction }),
      ...(control === undefined ? {} : { control }),
      ...(consoleFactory === undefined ? {} : { console: consoleFactory as EvaluationConsoleFactory }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(preflight === undefined ? {} : { preflight: preflight as HostPreflight }),
    };
  } catch {
    return undefined;
  }
}

/**
 * The assembly the CLI will use: a caller-supplied one always wins, so an operator file reference can
 * never override the programmatic path; otherwise the file's own reference is resolved.
 */
export async function resolveHostAssembly(configuration: HostConfiguration, supplied?: HostAssembly | undefined): Promise<HostAssemblyResolution | undefined> {
  if (supplied !== undefined) return { host: supplied };
  return configuration.assembly === undefined ? undefined : resolveAssembly(configuration.assembly);
}

/**
 * Run the host bootstrap over an operator-supplied assembly. Host objects and nested deliveries may
 * carry throwing getters, so only this bounded assembly/bootstrap operation is translated to a gap.
 */
export function prepareAssembly(host: HostAssembly, configuration: HostConfiguration): UC03HostReadiness | undefined {
  try {
    return prepareUC03Host({ ...host, pins: configuration.pins, identity: configuration.identity });
  } catch {
    return undefined;
  }
}
