# Glossary

## Product runtime

The slop-loop system being built to carry out coding tasks in an approved target repository. Distinct from the contributor agents developing slop-loop.

## Contributor agent

An assistant helping a contributor develop or maintain slop-loop. A contributor agent may coordinate work or perform an assigned part of it.

## Task

A requested unit of work with a goal and acceptance criteria. A product-runtime task can span multiple runs. Contributor assignments and feature-ledger tasks belong to the development workflow; they are not automatically product-runtime tasks.

## Run

One attempt by the product runtime to advance a task. Starting another run preserves the task's identity and any task-scoped limits.

## Session

A grouping of contributor work and its temporary artifacts. A contributor session is distinct from a product-runtime run.

## Checkpoint

A durable recovery point containing the authoritative state needed to resume a product-runtime workflow. A conversation summary alone is not a checkpoint.

## Handoff

A concise account of current work, evidence, blockers, and the next action for a person or another agent. A handoff communicates state; it does not replace authoritative state or approve further actions.
