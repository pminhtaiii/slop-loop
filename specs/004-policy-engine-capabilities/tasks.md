# Tasks: Policy Engine and Capabilities

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), and [contracts/](contracts/)

**Tests**: Required by every user story's independent test and Phase 3 exit gate.

## Phase 1: Setup and prerequisites

- [ ] T037 Check Phase 0/1 status and Phase 2 registry source using coding-agent-context/context/progress-checker.md and specs/003-closed-tool-registry/plan.md; note unmet gates in specs/004-policy-engine-capabilities/quickstart.md
- [ ] T038 Reconcile fixed task mode, legal transitions, and stop/checkout-slot lifecycle with ADR 0007 in src/orchestration/task.ts, src/orchestration/transitions.ts, and src/orchestration/runner.ts
- [ ] T039 Implement separate turn/attempt counters, paused active-work time, sealed cumulative promotion, and fixed shared retries in src/orchestration/budget.ts and src/orchestration/runner.ts
- [ ] T040 Revise old lifecycle tests and cover mode, budgets, waits, stop, and handoff in tests/orchestration/task.test.ts, tests/orchestration/budget.test.ts, tests/orchestration/runner.test.ts, and tests/orchestration/runner.e2e.test.ts
- [ ] T041 Extend Phase 2's nine-name registry with trusted capability/effect metadata in src/tools/registry.ts and tests/tools/registry.test.ts; keep fake result contracts in test fixtures

**Checkpoint**: The reconciled runner is verified and Phase 2's registry source is available. T041 waits for actual Phase 2 source; planning text alone is insufficient.

## Phase 2: User Story 1 — Only authorized tool calls execute (P1)

**Goal**: A pure decision engine behind the sole executor gateway.

**Independent test**: With a fake executor, explicit allow executes once; wrong mode, unknown/malformed, missing capability, forbidden, and failed authority calls execute zero times.

- [ ] T042 [P] [US1] Add failing pure decision tests for allow, deny, permission-needed, and trusted-fact failure in tests/policy/engine.test.ts
- [ ] T043 [US1] Implement admission-sealed TaskCapabilityCeiling, invocation-scoped PolicyDecisionContext, and side-effect-free PolicyEngine in src/policy/engine.ts
- [ ] T044 [US1] Add failing gateway routing and revalidation tests with a private fake executor mapping in tests/tools/gateway.test.ts
- [ ] T045 [US1] Implement single exported ToolGateway invocation and private executor dispatch, registry revalidation, fresh trusted-context assembly, and fail-closed outcomes in src/tools/gateway.ts
- [ ] T046 [US1] Integrate serial runner dispatch through ToolGateway, charging only received calls and discarding later proposals after first DENY, in src/orchestration/runner.ts and tests/orchestration/runner.e2e.test.ts

**Checkpoint**: No tested caller can reach a fake executor except through explicit gateway ALLOW.

## Phase 3: User Story 2 — File authority stays narrow and current (P1)

**Goal**: Exact write grants stay within a sealed task ceiling and current trusted path facts; reads do not prompt.

**Independent test**: Fake workspace/grant providers distinguish read, eligible missing grant, exact valid grant, forbidden path, external drift, restored bytes, and unavailable facts.

- [ ] T047 [P] [US2] Add fake path/grant policy cases, including irreversible external-edit invalidation and same-open-session grant reuse, in tests/policy/engine.test.ts
- [ ] T048 [US2] Add trusted workspace and grant fact ports with invocation-scoped canonical path and exact operation checks in src/policy/engine.ts and src/tools/gateway.ts
- [ ] T049 [US2] Prove gateway rechecks the new task ceiling and fresh path/grant facts before each fake execution in tests/tools/gateway.test.ts

**Checkpoint**: Fake facts enforce narrow grants; real containment and grant ledger remain Phase 4/7 gates.

## Phase 4: User Story 3 — Tasks remain bounded and stoppable (P1)

**Goal**: Fixed mode, separate capacity counters, finite shared recoveries, safe cancellation, and budget handoff survive gateway integration.

**Independent test**: Scripted runner and fake executor show promotion only on capacity, no retry refill, no late continuation after stop, and a handoff on every finite-budget terminal path.

- [ ] T050 [P] [US3] Add failing serial denial-loop, promotion, deadline, and shared retry fixtures in tests/orchestration/runner.e2e.test.ts
- [ ] T051 [US3] Connect runner-owned budget charging, sealed promotion, shared recovery reasons, and finite-budget handoff to gateway outcomes in src/orchestration/budget.ts and src/orchestration/runner.ts
- [ ] T052 [US3] Fence executor start after pending pre-append, abort in-flight work, and test safe slot release in src/orchestration/runner.ts, src/tools/gateway.ts, and tests/orchestration/runner.e2e.test.ts

**Checkpoint**: Every finite budget ends with bounded handoff; stop precludes later mutation/transition.

## Phase 5: User Story 4 — Evidence and results stay safe (P2)

**Goal**: Committed pre-evidence gates every executor call; output and result evidence are bounded; uncertain append never replays execution.

**Independent test**: Fake audit sink proves request/decision append before every read/effect, zero execution on outage, idempotent result retry, and invalid-result effect status.

- [ ] T053 [P] [US4] Add fake audit ordering and outage tests, including malformed/unknown request evidence and read-call blocking, in tests/tools/gateway.test.ts
- [ ] T054 [US4] Implement bounded canonical request/decision evidence and pre-execution append gate for every dispatched call in src/tools/gateway.ts
- [ ] T055 [US4] Add committed-but-unacknowledged append, duplicate-ID rejection, invalid output, oversize output, and possible-effect fixtures in tests/tools/gateway.test.ts
- [ ] T056 [US4] Implement output-contract validation, byte/size bounds, sanitization/redaction, effect-status separation, and finite synchronous appendIfAbsent result retries in src/tools/gateway.ts
- [ ] T057 [US4] Integrate AUDIT_UNAVAILABLE, AUDIT_INCOMPLETE, and TOOL_CONTRACT_FAILURE runner outcomes with stop-further-dispatch behavior in src/orchestration/runner.ts and tests/orchestration/runner.e2e.test.ts

**Checkpoint**: No fake execution without committed pre-evidence, no duplicate result event or executor replay.

## Phase 6: Cross-cutting validation

- [ ] T058 Run specs/004-policy-engine-capabilities/quickstart.md and the pinned pnpm quality gate; record evidence and deferred gates in coding-agent-context/context/testing.md and coding-agent-context/context/progress-checker.md

## Dependencies and order

- T037 precedes implementation. T038–T040 reconcile Phase 1 before T046. T041 requires completed Phase 2 source and precedes T042–T049.
- T042→T043 and T044→T045 are test-first pairs. T043, T045, and T046 complete User Story 1.
- T047→T048→T049 completes User Story 2 after User Story 1 policy/gateway types.
- T050→T051→T052 completes User Story 3 after the runner/gateway integration.
- T053→T054 and T055→T056→T057 complete User Story 4 after the gateway exists.
- T058 follows all stories. The main execution path is Phase 1 runner/registry → policy/gateway → path/grant facts → budget/stop integration → evidence/results → full gate.

## Parallel opportunities

- After T041, T042 and T044 may be drafted in different test files. T047 can be prepared alongside T050 once the shared contracts stabilize. T053 and T055 touch the same test file and should be sequenced, despite the individual test cases being independent.
- T038 and T039 touch the runner and should be coordinated rather than independently merged. One in-flight call per task is a runtime rule, not a limit on developers writing independent tests.

## Implementation strategy

The first demonstrable slice is T037–T046: explicit ALLOW is the only path to a fake executor. Follow with exact grant decisions, runner lifecycle integration, then audit and result safety. Do not mark Phase 3 complete until T058 and the combined prerequisites pass.
