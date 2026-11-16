/**
 * Shared acceptance for the UC-04 journal behind real-tier UC-05 control and continuation
 * (real-tier contract §(c)1).
 *
 * A `mock` port is accepted unchanged, so the controlled path keeps its behaviour. A port that
 * declares `real` is accepted only when the T043 registry brands its construction and every
 * required method is present: a bare `provenance: 'real'` string is a declaration, never proof.
 * Value access reads data descriptors along the prototype chain, so a class's inherited methods
 * count but a getter cannot stand in for one; an unregistered lookalike fails the brand check.
 *
 * This module imports only the dependency-neutral registry (§(b)5); reaching into `src/persistence/`
 * would close the cycle through `state-port-v02-storage.ts`.
 */
import { isProductionJournal } from '../foundation/production-journal-registry.ts';

function descriptorV02(target: unknown, key: string): PropertyDescriptor | null {
  if (target === null || typeof target !== 'object') return null;
  try {
    let owner: object | null = target;
    for (let depth = 0; owner && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) return descriptor;
      owner = Object.getPrototypeOf(owner) as object | null;
    }
  } catch {
    return null;
  }
  return null;
}

export function dataMethodV02(target: unknown, key: string): ((...args: unknown[]) => unknown) | null {
  const descriptor = descriptorV02(target, key);
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'function' ? (descriptor.value.bind(target) as (...args: unknown[]) => unknown) : null;
}

export function dataPropertyV02(target: unknown, key: string): unknown {
  const descriptor = descriptorV02(target, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** `mock` unchanged; `real` only through the registry brand with every required method present. */
export function acceptsJournalV02(journal: unknown, required: readonly string[] = []): boolean {
  const provenance = dataPropertyV02(journal, 'provenance');
  if (provenance === 'mock') return true;
  return provenance === 'real' && isProductionJournal(journal) && required.every(name => dataMethodV02(journal, name) !== null);
}

/** For ports UC-05 cannot brand by construction (the approval service): a declared mock/real only. */
export function acceptsProvenanceV02(port: unknown): boolean {
  const provenance = dataPropertyV02(port, 'provenance');
  return provenance === 'mock' || provenance === 'real';
}
