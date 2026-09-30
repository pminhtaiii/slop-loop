# Research: Task Domain and Orchestrator

This feature is a domain boundary. Its design inputs are the approved Phase 1 discussion, `CONTEXT.md`, the context pack, ADR 0003, and the Phase 0 plan. No external service or new library is required.

## Decision 1: Build a deterministic in-memory runner

**Decision**: Process a bounded sequence of typed task events through a state reducer. The runner owns state, step use, retry use, and terminalization. Time is supplied by a controllable clock for tests. No model or tool adapter is invoked in Phase 1.

**Rationale**: Pure transition helpers alone cannot exercise the Phase 1 exit gate across a whole task. A bounded runner proves orchestration behavior without prematurely implementing Phase 2–13 systems.

**Alternatives considered**: Transition functions without a runner do not prove loop termination. A provider or tool loop would cross the Phase 1 scope boundary.

## Decision 2: Use the full lifecycle graph, with two approved additions

**Decision**: Define the Ask/Edit states in `architecture.md` now. Add `PAUSED_FOR_MODE` for a mid-task Edit→Ask switch and `CANCELLED` as a terminal state. Preserve `COMPLETED`, `FAILED`, and `BLOCKED`. Allow an Edit task to complete early as `NO_CHANGE_NEEDED` from inspection or planning.

**Rationale**: The developer selected a full state contract and mid-task mode switching. The architecture sketch lacks a pause state and a distinct developer-cancellation state, so these additions make the agreed behavior representable.

**Alternatives considered**: A `paused` flag alongside an Edit state would require every state consumer to remember an extra check. Mapping cancellation to `BLOCKED` would misstate why the task stopped.

## Decision 3: Keep task identity and objective stable while mode changes

**Decision**: A task owns one immutable objective, trusted `INFORMATIONAL`/`CHANGE` intent, and one finite budget. The current mode may change only on a trusted developer event. Edit→Ask records a pause checkpoint; Ask→Edit re-enters `INSPECTING` so subsequent work revalidates current conditions and passes through the permission gate before mutation. An informational task refuses Edit mode; a new change request needs a new task. Progress questions are observations and do not create a task. A session permits one unfinished task.

**Rationale**: Mode is a capability selector, not a change to the developer's requested work. Reinspection after a pause avoids assuming permissions, repository state, or a future sandbox remain valid.

**Alternatives considered**: Resuming directly in `IMPLEMENTING` risks bypassing permission revalidation. Creating a new task on every mode switch loses budget continuity. Multiple concurrent tasks need a session scheduler outside Phase 1.

## Decision 4: Enforce only budgets Phase 1 can observe

**Decision**: Use the architecture's initial 30 agent steps and 900-second task deadline, plus the developer-approved separate maximum of three general retries. Each automatic runner cycle consumes one step, even when it rejects a model proposal; explicit retry also consumes retry allowance. Developer mode changes and status questions do not consume steps. Limits lock at admission and never reset. The last permitted step may complete; a requested step or retry beyond its limit does not run.

**Rationale**: These limits bound the Phase 1 loop. The architecture also suggests 60 tool calls, three patch attempts, 120 seconds per tool, and 65,536 bytes of tool output; those counters become enforceable only when their operations exist.

**Alternatives considered**: Dormant tool counters in Phase 1 would look implemented without any integration test. Reusing patch attempts as generic retries would conflate different resources.

## Decision 5: Separate recoverable proposals from internal transition failures

**Decision**: Model proposals cannot select arbitrary task states. A proposal incompatible with the current state is rejected before state mutation, consumes a step, and may be corrected within remaining budget. An illegal transition attempted by trusted orchestration ends the task `FAILED / INVALID_TRANSITION`. A denied action is not terminal unless no authorized path to the objective remains.

**Rationale**: The model is an untrusted proposer, while the orchestrator is the authority for lifecycle transitions. A recoverable proposal error should not destroy a coding task; a broken internal transition must fail visibly.

**Alternatives considered**: Fatalizing every rejected model action is brittle. Ignoring rejected actions without step accounting permits unbounded churn.

## Decision 6: Treat completion as evidence-gated

**Decision**: Normal Ask completion follows `ANSWERING`. Edit completion with changes follows `REVIEWING` after a trusted verification-passed event. Early `NO_CHANGE_NEEDED` completion is available from `INSPECTING` or `PLANNING` and must not claim verification ran. The model may propose completion; only the runner accepts a legal terminal transition. A failed required check without remaining recovery ends `FAILED` with actual verification evidence.

**Rationale**: A model's declaration is not evidence. Phase 1 verifies the event contract with fixtures; later phases bind trusted test and review results to those events.

**Alternatives considered**: Allowing `COMPLETED` from any state would hide skipped admission, verification, or review.

## Decision 7: Keep the time guarantee honest

**Decision**: The task deadline includes paused and human-waiting time. A clock-driven check transitions an overdue task to `FAILED / BUDGET_EXHAUSTED`. Phase 1 tests use a simulated clock and do not claim to schedule a real wake-up or interrupt a hung external call. Later integration must trigger deadline checks and enforce per-tool timeouts.

**Rationale**: A synchronous domain reducer can prove finite processing and expiry rules, but cannot wake itself while no caller invokes it. The future runtime owns real timers and cancellation.

**Alternatives considered**: Counting only active time permits an indefinitely paused task. Adding a real scheduler to Phase 1 would expand the scope beyond a deterministic core.

## Dependency and status

At the time of this design decision, Phase 1 was unimplemented and Phase 0 had not passed its runtime exit gate. Phase 0 is now complete on `development` and its source has been merged into the Phase 1 checkout. `coding-agent-context/context/progress-checker.md` remains authoritative for current implementation and verification status.
