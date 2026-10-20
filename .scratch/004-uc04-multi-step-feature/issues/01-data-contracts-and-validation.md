# 01: Data Contracts and Runtime Validation for State & Checkpoints

**What to build:**  
Strict TypeScript data contracts and validation schemas for all state, checkpoint, step, budget, and approval entities. Any untrusted or deserialized input from disk or memory must be validated and narrowed at runtime before use.

**Blocked by:**  
None (can start immediately)

**Status:**  
`completed`

- [x] Define `TaskState`, `PlanStep`, and `StepStatus` (`todo`, `doing`, `done`, `failed`) interfaces in `src/state/types.ts`.
- [x] Define `BudgetLedger`, `ReservationBundle`, `BudgetReservation`, and `ProviderUsage` interfaces.
- [x] Define `ApprovalRequestBinding` and `WorkspaceBaseline` interfaces.
- [x] Implement runtime validator functions (`validateTaskState`, `validatePlanStep`, `validateBudgetLedger`) in `src/contracts/uc04.ts`.
- [x] Add unit test suite in `tests/runtime/uc04/types.test.ts` covering valid inputs and rejecting malformed or unknown fields.
