# Data Model: Task Domain and Orchestrator

## TaskContext

| Field | Meaning | Rule |
| --- | --- | --- |
| `taskId` | Identity of one developer objective | Stable and nonempty |
| `objective` | Original work request | Bounded, nonempty, immutable |
| `intent` | Trusted classification of the original request as `INFORMATIONAL` or `CHANGE` | Immutable; only `CHANGE` permits Edit work |
| `mode` | Current developer-selected `Ask` or `Edit` | Only a trusted mode-change event may alter it |
| `state` | Current `TaskState` | Changed only through a validated transition |
| `budget` | Frozen `TaskBudget` | System-owned and fixed at admission |
| `usage` | Agent steps and general retries already consumed | Monotone and never above the corresponding limit |
| `admittedAt` | Start of task deadline | Set once at admission by the trusted clock |
| `pausedFrom` | Edit state recorded on entry to `PAUSED_FOR_MODE` | Present only while paused; informational, never an automatic resume target |
| `verification` | Trusted Phase 1 fixture status for required Edit checks | An Edit completion with changes requires `PASSED` for the current attempt; reset on repair or Edit resumption; no real check is executed in Phase 1 |
| `retryAuthorized` | One-transition internal marker set only after a retry allowance is consumed | Required to enter `REPAIRING`, then cleared immediately; never model-controlled |
| `outcome` | Typed `TaskOutcome` | Present exactly when `state` is terminal; immutable thereafter |

The task objective is not reinterpreted as a new work request when mode changes. Phase 1 handles one task instance at a time; the future session controller enforces one unfinished task per session.

## TaskState

Active states: `RECEIVED`, `ADMITTED`, `INSPECTING`, `ANSWERING`, `PLANNING`, `WAITING_FOR_FILE_PERMISSION`, `IMPLEMENTING`, `SANDBOX_READY`, `VERIFYING`, `REPAIRING`, `REVIEWING`, `PAUSED_FOR_MODE`.

Terminal states: `COMPLETED`, `FAILED`, `BLOCKED`, `CANCELLED`.

### Normal transition graph

| From | To | Condition |
| --- | --- | --- |
| `RECEIVED` | `ADMITTED` | Trusted admission; budget becomes immutable |
| `ADMITTED` | `INSPECTING` | Start work |
| `INSPECTING` | `ANSWERING` | Current mode is Ask |
| `INSPECTING` | `PLANNING` | Current mode is Edit |
| `INSPECTING` | `COMPLETED` | Edit objective has trusted no-change conclusion |
| `ANSWERING` | `COMPLETED` | Answer accepted for the unchanged objective |
| `ANSWERING` | `PLANNING` | Trusted Ask→Edit switch for the same edit-capable objective |
| `PLANNING` | `WAITING_FOR_FILE_PERMISSION` | Edit work needs a file operation |
| `PLANNING` | `COMPLETED` | Trusted no-change conclusion |
| `WAITING_FOR_FILE_PERMISSION` | `IMPLEMENTING` | Required permission is confirmed by a future authority; a Phase 1 fixture represents this event |
| `IMPLEMENTING` | `SANDBOX_READY` | Change produced; future sandbox boundary confirms readiness |
| `SANDBOX_READY` | `VERIFYING` | Required checks begin |
| `VERIFYING` | `REVIEWING` | Trusted required checks passed |
| `VERIFYING` | `REPAIRING` | Check failed and an explicit repair retry is allowed |
| `REPAIRING` | `WAITING_FOR_FILE_PERMISSION` | Another path-operation permission is needed |
| `REPAIRING` | `IMPLEMENTING` | Existing permission remains valid; future policy rechecks at use |
| `REVIEWING` | `COMPLETED` | Changed-file result and passing verification evidence are present |
| `REVIEWING` | `REPAIRING` | Review found an issue and an explicit retry is allowed |

The runner may enter `FAILED`, `BLOCKED`, or `CANCELLED` from any active state for the matching typed reason. It never accepts a normal transition out of a terminal state. `COMPLETED` is restricted to the paths above. Either edge into `REPAIRING` requires a retry allowance already consumed by the runner; calling the transition reducer directly without that one-use marker fails `INVALID_TRANSITION`.

### Mode pause and resume

- A trusted Edit→Ask event in an active Edit task enters `PAUSED_FOR_MODE`, records `pausedFrom`, and signals that prior file permissions are unavailable. No Edit action is allowed while mode is Ask.
- A trusted Ask→Edit event for that paused task returns to `INSPECTING`. The previous state is retained only as a checkpoint for explanation; current conditions and permissions must be re-established on the normal path.
- Returning to Edit invalidates any earlier passing verification fixture. Entering `REPAIRING` or a new `IMPLEMENTING` attempt also invalidates it; only a trusted check result from the current `VERIFYING` stage may permit `REVIEWING → COMPLETED`.
- A trusted Ask→Edit event while `INSPECTING` or `ANSWERING` may enter `PLANNING` only for the same objective with `CHANGE` intent. An informational task refuses Edit mode. Mode change alone cannot create a new objective or alter intent.
- Progress questions observe the context without a state transition or step charge.
- The deadline continues while paused. Clock advancement to the deadline terminalizes the task with `BUDGET_EXHAUSTED`.

## TaskBudget and TaskUsage

| Resource | Initial limit | Phase 1 enforcement |
| --- | ---: | --- |
| Agent steps | 30 | Every autonomous runner cycle, including refusal and retry |
| General retries | 3 | Every explicit retry event; no automatic retry |
| Task elapsed time | 900 seconds | At each clock-driven check, including while paused |

The architecture also proposes 60 tool calls, three patch attempts, 120 seconds per tool call, and 65,536 output bytes. Those are later-phase limits, not Phase 1 usage fields. A last allowed step can complete. If a requested operation would exceed a limit, the operation does not run and the task becomes terminal. Usage records the consumed amount; exhaustion evidence records the attempted amount separately.

## TaskEvent

Task events have a trusted origin classification:

| Origin | Examples | Authority |
| --- | --- | --- |
| Developer | Mode switch, cancellation, progress inquiry | May change mode or cancel, never raise budget or change objective |
| Model proposal | Request an action or propose completion | May be refused; cannot directly select a state, grant permission, or change budget |
| Trusted runner / fixture | Admission, lifecycle progress, verification result, clock advancement | May request only graph-legal transitions; an illegal request is a fatal internal outcome |

Phase 1 supplies deterministic fixtures for later authorities. It does not implement model transport, session UI, permission storage, sandbox readiness, or verification execution.

## TaskOutcome

`TaskOutcome` is a tagged terminal reason paired with a terminal `TaskState`:

| State | Initial outcome reasons |
| --- | --- |
| `COMPLETED` | `ANSWERED`, `EDIT_VERIFIED`, `NO_CHANGE_NEEDED` |
| `FAILED` | `INVALID_TRANSITION`, `BUDGET_EXHAUSTED`, `VERIFICATION_FAILED`, `INTERNAL_ERROR` |
| `BLOCKED` | `POLICY_DENIED`, `DEPENDENCY_UNAVAILABLE` |
| `CANCELLED` | `CANCELLED_BY_DEVELOPER` |

`BUDGET_EXHAUSTED` includes resource kind, configured limit, observed use, and attempted use. Later audit integration adds whether the triggering tool result was committed before termination, as required by the architecture; Phase 1 has no tool result or canonical audit stream to report.

Outcome schemas validate the reason together with its state and evidence. `ANSWERED` cannot carry Edit verification evidence; `EDIT_VERIFIED` requires a current passing result; `VERIFICATION_FAILED` requires a recorded failed check. The terminal snapshot and nested budget evidence are frozen.

An individual action refusal is a typed nonterminal result, not a `TaskOutcome`. It leaves the task state unchanged, consumes an agent step, and can be followed by a different permitted proposal while budget remains.
