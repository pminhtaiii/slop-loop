# 04: Cumulative Budget Ledger & Two-Phase Reservation Engine

**What to build:**  
Durable accounting for finite execution limits: LLM tokens, monetary cost (USD), repair retry cycles, and reviewer iterations. Budgets are scoped to `task` or `run` and MUST survive process termination without resetting. Supports two-phase reservation (`reserve` -> `settle` / `reconcileUncertain`).

**Blocked by:**  
- 01: Data Contracts and Runtime Validation for State & Checkpoints

**Status:**  
`completed`

- [x] Implement `BudgetTracker` in `src/state/budget-tracker.ts`.
- [x] Implement atomic `reserve(items)`: check remaining allowance against limits; reserve atomically before operation starts.
- [x] Implement `settle(requestId, observedUsage)`: deduct consumed usage and release outstanding reservation.
- [x] Implement `reconcileUncertain(requestId, { observedUsage, reason })`: keep reservation charged until reconciled; reconcile with verified evidence.
- [x] Enforce that a new `runId` under the same `taskId` cannot reset task-scoped budgets.
- [x] Add unit test suite in `tests/runtime/uc04/budget-accounting.test.ts`.
