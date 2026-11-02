/**
 * Host-side evaluation service for runtime-evaluation/1 (T009).
 *
 * This is the only new production module: it owns experiment lifecycle, intake, idempotency and
 * operator input forwarding. Owners (state, approval, repository, model, reviewer, UC-05 control)
 * arrive through injected dependencies; nothing here performs a provider, repository or container
 * effect itself. A `needs-info` submission is persisted non-executable and allocates no task.
 */
export * from './evaluation-service-types.ts';
export { createEvaluationService } from './evaluation-service-lifecycle.ts';
