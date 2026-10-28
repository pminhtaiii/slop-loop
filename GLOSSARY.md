# Glossary

## Product runtime

The slop-loop system being built to carry out coding tasks in an approved target repository. Distinct from the contributor agents developing slop-loop.

## Contributor agent

An assistant helping a contributor develop or maintain slop-loop. A contributor agent may coordinate work or perform an assigned part of it.

## Task

A requested unit of work with a goal and acceptance criteria. A product-runtime task can span multiple runs. Contributor assignments and feature-ledger tasks belong to the development workflow; they are not automatically product-runtime tasks.

## Run

One attempt by the product runtime to advance a task. Starting another run preserves the task's identity and any task-scoped limits.

## Bug task

A task to correct a specific observed behavior in a target repository. Its acceptance criteria describe the intended behavior and any existing behavior that must be preserved.

## Issue triage

Assessment of a reported issue to classify it, recommend severity, identify supporting evidence and missing information, and recommend a destination for further handling. Triage does not itself authorize or carry out that handling.

## Severity recommendation

An assessment of an issue's impact on functionality and affected users, considering available workarounds. It is distinct from business priority or scheduling order.

## Clarification

A request for missing facts or intended behavior needed to understand a task. Providing clarification does not authorize an action.

## Acceptance criteria

Explicit conditions that define a satisfactory outcome for a task. They express what must be true, rather than prescribing how the agent implements the change.

## Task scope

The work authorized by the user's request and agreed acceptance criteria. An improvement outside that scope requires additional user permission.

## Harness

The part of the product runtime that controls execution, permissions, workflow state, limits, verification, and completion. The model proposes actions and outcomes; the harness governs their execution and acceptance.

## Baseline

Evidence of repository behavior before a proposed fix, including reproduction of the reported failure and the results of required existing checks.

## Verification

The process of checking a proposed result against agreed acceptance criteria and required checks using observable evidence. Verification of a reported bug does not establish that the entire codebase is free of bugs.

## Regression test

A test that checks a specific behavior to detect its unintended recurrence or change. For a bug fix, it demonstrates the reported failure before the fix and the intended behavior afterward.

## Mutation testing

Evaluation of a test suite by introducing small changes to the code under test and observing whether the tests detect those changes. It supplies evidence about fault detection for the exercised mutations, rather than proof of correctness.

## Mutant

A changed version of the code used in mutation testing. A mutant is killed when a test fails while the change is active, and survives when the tests pass. An equivalent mutant preserves observable behavior within the intended contract.

## Completion gate

The harness-controlled decision that required verification and review evidence satisfies the task's agreed completion requirements. An agent's proposal that work is finished does not itself pass this gate.

## Milestone update

A concise user-facing account of meaningful progress, its evidence, and the next action. It communicates the work's status rather than raw internal chain of thought.

## Session

A grouping of contributor work and its temporary artifacts. A contributor session is distinct from a product-runtime run.

## Checkpoint

A durable recovery point containing the authoritative state needed to resume a product-runtime workflow. A conversation summary alone is not a checkpoint.

## User-requested pause

A person's request to stop progress on one selected product-runtime task until they explicitly resume it. Other tasks continue. The request does not cancel completed work or erase a separate approval or recovery hold.

## Handoff

A concise account of current work, evidence, blockers, and the next action for a person or another agent. A handoff communicates state; it does not replace authoritative state or approve further actions.
