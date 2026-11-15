/**
 * Dependency-neutral brand for the production UC-04 journal (real-tier contract §(b)5).
 *
 * This module imports nothing: approval code must be able to ask "is this journal the production
 * state port?" without importing `src/persistence/`, which already imports `src/approvals/`
 * (`state-port-v02-storage.ts:7`) and would cycle. Only `DurableStatePortV02`'s constructor
 * registers, so a bare `provenance: 'real'` string is a declaration, never proof.
 */
const productionJournals = new WeakSet<object>();

/** Called by the DurableStatePortV02 constructor only; see the `src` call-site test in T043. */
export function registerProductionJournal(port: object): void {
  productionJournals.add(port);
}

/** True only for an instance that constructor registered; every other value, including a forged one, is false. */
export function isProductionJournal(value: unknown): boolean {
  return typeof value === 'object' && value !== null && productionJournals.has(value);
}
