# 03: Step State Machine & Checkpoint Lifecycle Transitions

**What to build:**  
Deterministic state transition engine for multi-step task execution. Plan steps transition explicitly between `todo`, `doing`, `done`, and `failed`. Transitions bump a monotonic `stateVersion` and produce immutable checkpoint records.

**Blocked by:**  
- 01: Data Contracts and Runtime Validation for State & Checkpoints

**Status:**  
`completed`

- [x] Implement `StepStateMachine` in `src/state/step-machine.ts`.
- [x] Enforce valid forward transitions: `todo` -> `doing` -> `done` or `failed`.
- [x] Reject backwards or illegal transitions (e.g. `done` -> `todo`, or transitioning an unstarted step).
- [x] Record timing metrics, error reasons, changed files, and verification references on step completion.
- [x] Add unit test suite in `tests/runtime/uc04/step-machine.test.ts` verifying all valid and invalid state transitions.
