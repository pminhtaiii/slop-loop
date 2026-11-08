# Task Verification Contract

This reference sets the worker-brief and handoff requirements. The linked skills provide the detailed procedures; this contract does not authorize scope or change acceptance criteria.

## Brief and first checkpoint

A worker brief names the approved acceptance sources, exact owned paths, applicable commands, evidence location, and explicitly instructs the worker to use the [verify-task skill](../../.agents/skills/verify-task/SKILL.md) before handoff.

Set an early checkpoint in the brief. During the first bounded work pass, the worker reports one runnable relevant check, a proposed scoped edit, or a concrete blocker with its next action. This is a progress checkpoint, not acceptance evidence.

For a blocker, retain the exact failure, reuse prior results only while their inputs and environment remain applicable, and try one narrow recovery tied to that failure or the brief's explicit bound. If it persists, report the blocker and next action before any replacement launch. Read sources when they are missing, changed, or needed to assess a criterion; do not impose arbitrary read limits. File-write absence alone does not establish worker liveness; use explicit status or host evidence.

## Criterion evidence and handoff

Before handoff, invoke the [verify-task skill](../../.agents/skills/verify-task/SKILL.md) against the approved brief or feature artifacts. Keep criteria unchanged and provide its criterion-level evidence table; any required criterion without passing applicable evidence leaves verification incomplete. Self-verification does not replace integration, convergence, independent review, or contributor publication gates.

## Focused mutation evidence

After relevant unmodified focused tests pass, use the [mutation-testing skill](../../.agents/skills/mutation-testing/SKILL.md) for authorized refusal, security, or boundary logic changes and test-quality work. Otherwise, record a brief scope-based reason. Keep the run within approved source and related tests; a whole-repository Stryker run or score threshold is not a completion gate.

Retain the skill's isolated run, exact-assertion kill, restoration, and final-baseline evidence. Mutation results describe scoped test fault detection; they do not change criteria or replace behavioral evidence.
