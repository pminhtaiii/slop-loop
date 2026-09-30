# Internal Contract: Task Orchestrator

This is an internal domain contract for later adapters. Phase 1 has no public CLI, API, model tool, or persistence interface.

## Inputs and ownership

- The trusted composition layer creates a task from `taskId`, bounded objective, immutable `INFORMATIONAL`/`CHANGE` intent, developer-selected mode, and system-owned budget. It supplies an injectable clock.
- The trusted runner accepts typed developer and lifecycle fixtures through a discriminated event union. A separate model-proposal entry point accepts unknown input through a strict closed schema before producing a model event. A model proposal cannot contain an arbitrary destination state, budget update, mode change, or permission grant.
- The runner returns a new task snapshot and a typed processing result with old/new state, usage, and a bounded reason for refusals. Callers cannot mutate an earlier snapshot or nested terminal evidence to change authority.

## Processing result

| Result | Meaning |
| --- | --- |
| `ACCEPTED` | A legal transition or terminalization occurred; include old/new state and usage |
| `ACTION_REJECTED` | A proposal was refused before execution; state unchanged, agent step charged, bounded reason returned |
| `ALREADY_TERMINAL` | Further work refused; original state/outcome unchanged |
| `PAUSED` | Edit work suspended after trusted mode switch; no Edit execution permitted |
| `BUDGET_EXHAUSTED` | Requested operation did not execute; terminal failure includes resource, limit, observed, attempted |

The exact TypeScript names may be refined during implementation without weakening these semantics.

## Safety invariants

1. `RECEIVED` is followed by admission before work states.
2. Every recorded transition is a declared graph edge or a typed terminal path.
3. Model proposals do not directly transition state or alter budget, objective, or mode.
4. Each autonomous processing cycle consumes at most one agent step and is checked against the fixed limit before execution.
5. Explicit retries consume one step and one retry allowance before a one-use authorization permits `REPAIRING`. They never replay a side effect automatically; a direct transition to `REPAIRING` without that authorization fails.
6. Terminal state and outcome are sealed together and cannot be revised by a later event.
7. Edit work is unavailable in Ask and during `PAUSED_FOR_MODE`.
8. An informational task cannot enter Edit work through a mode change; a new change request requires a new task.
9. Resuming Edit after a pause returns through inspection and the permission stage before future mutation.
10. A changed-file completion requires trusted passing-verification evidence from the current change attempt. Repair and Edit resumption invalidate earlier passing evidence. A no-change completion states that no verification was performed if none was.
11. The task deadline includes paused and permission-waiting time. Phase 1 verifies expiry when the injected clock is advanced; later runtime integration must schedule checks in real time.

## Failure boundaries

- Invalid model proposal: `ACTION_REJECTED`, no state mutation, step charged.
- Invalid trusted transition: terminal `FAILED / INVALID_TRANSITION`, never enter the requested illegal state.
- One policy-denied action: nonterminal refusal if another authorized route remains; terminal `BLOCKED / POLICY_DENIED` only when the objective cannot proceed.
- Required verification failed with no allowed repair: terminal `FAILED / VERIFICATION_FAILED` with the actual failure result.
- Developer cancellation: terminal `CANCELLED / CANCELLED_BY_DEVELOPER`, no rollback of any later-phase persisted edit.

## Phase 1 boundary

Scripted events may stand in for permission grants, sandbox readiness, and verification results solely to test the domain graph. Those fixtures are not proof that the real capability exists. The future policy/tool/sandbox/verification adapters must provide the corresponding trusted events, with their own boundary tests.
