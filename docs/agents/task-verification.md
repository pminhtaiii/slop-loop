# Task Verification Contract

This reference sets the worker and merger verification requirements. The linked skills provide the detailed procedures; this contract does not authorize scope or change acceptance criteria.

## Brief and first checkpoint

A worker brief names the approved acceptance sources, exact owned paths, applicable commands, evidence location, and explicitly instructs the worker to use the [verify-task skill](../../.agents/skills/verify-task/SKILL.md) before handoff.

Set an early checkpoint in the brief. During the first bounded work pass, the worker reports one runnable relevant check, a proposed scoped edit, or a concrete blocker with its next action. This is a progress checkpoint, not acceptance evidence.

For a blocker, retain the exact failure, reuse prior results only while their inputs and environment remain applicable, and try one narrow recovery tied to that failure or the brief's explicit bound. If it persists, report the blocker and next action before any replacement launch. Read sources when they are missing, changed, or needed to assess a criterion; do not impose arbitrary read limits. File-write absence alone does not establish worker liveness; use explicit status or host evidence.

## Criterion evidence and handoff

Before handoff, invoke the [verify-task skill](../../.agents/skills/verify-task/SKILL.md) against the approved brief or feature artifacts. Keep criteria unchanged and provide its criterion-level evidence table; any required criterion without passing applicable evidence leaves verification incomplete. Self-verification does not replace integration, convergence, independent review, or contributor publication gates.

## Merger integration and verification

The coordinator must spawn a merger sub-agent distinct from the implementers and coordinator for every contributor implementation batch, including a batch authored directly by the coordinator. Reserve capacity for it before dispatching implementers. Reuse that merger across the batch; record its host agent identity, assigned scope, and evidence location in the managed session. If spawning is unavailable, keep integration acceptance blocked and report the prerequisite instead of silently taking over the role.

The brief supplies the approved acceptance sources, exact integration branch/checkout, worker handoffs and owned paths, relevant commands, and candidate/source snapshots. Register the assignment and verify its bindings through the existing lifecycle. The merger integrates one handoff at a time into the authorized feature branch, checking recorded base, ancestry, scope, ownership, and handoff hashes. This is local contributor integration; remote publication remains with the coordinator and protected-branch merge authority remains with the human.

After integration, the merger invokes the [verify-task skill](../../.agents/skills/verify-task/SKILL.md) on the integrated candidate. Derive expected outcomes from the approved requirements before using implementation details to select checks. Map every required criterion to evidence; independently exercise the changed user-facing or public boundary and relevant persisted effects. Challenge plausible wrong behavior, including an applicable failure/refusal path and meaningful cross-component flow. For documentation-only changes, verify the requested rules and their callers for contradictions and run the applicable documentation checks; do not invent a runtime journey. Add checks within assigned ownership or report the missing scope to the coordinator. Reuse applicable bound worker receipts, but worker claims, green lint, build success, or passing implementation-authored tests alone do not establish behavioral acceptance. Keep mocks, controlled execution, real execution, and restart evidence distinct; existing authorization gates still apply.

Return the agent identity, integrated candidate identity, snapshots, and the skill's criterion-level evidence table to the coordinator. Give each failure a stable ID, requirement/source, expected and observed behavior, reproducing command or document passage, evidence pointer, and next action. Any required `FAIL`, `BLOCKED`, or `NOT-RUN` criterion blocks acceptance of its task and dependent work; a mechanically merged change is not yet accepted. Independent ready work may continue. Before final review/publication, verify the selected batch's final candidate and refresh affected evidence after repairs or later integrations; an earlier task pass does not establish batch acceptance.

The merger reports implementation defects without repairing them or changing acceptance criteria. The coordinator dispatches an authorized repair assignment, then returns its handoff to the merger for integration and affected verification. Apply the existing bounded recovery policy; unresolved failures stay incomplete. Independent standards/spec review, convergence, CI, and publication gates remain separate. Retain a short retrospective in the session: defects caught, gaps reported later, and unnecessary verification effort. No separate benchmark is required for this workflow.

## Focused mutation evidence

After relevant unmodified focused tests pass, use the [mutation-testing skill](../../.agents/skills/mutation-testing/SKILL.md) for authorized refusal, security, or boundary logic changes and test-quality work. Otherwise, record a brief scope-based reason. Keep the run within approved source and related tests; a whole-repository Stryker run or score threshold is not a completion gate.

Retain the skill's isolated run, exact-assertion kill, restoration, and final-baseline evidence. Mutation results describe scoped test fault detection; they do not change criteria or replace behavioral evidence.
