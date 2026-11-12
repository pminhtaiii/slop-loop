# Scope and authorization decisions

## 2026-11-12 — Planning release

Authority: user conversation and [ADR-0008](../../../docs/adr/0008-read-only-target-repository-questions.md). Confirmed: read-only questions over a separate selected Python repo; existing tools with match-centered evidence/ranged reads; no BM25/semantic index; citations; configurable budgets selected experimentally; clarification evaluation; active-session follow-ups, one repo/investigation, no restart recovery; deterministic and human semantic judging. User requested coordinator-authored planning and independent review sub-agents using the coordinator's inherited model, not Luna.

Released now: planning artifacts, tasks, coordinator repairs and independent planning reviews. Not released: implementation, shared-owner changes, live effects, publication, production defaults, durable sessions or successor work. Task completion or clean automation grants no such authority.

## Gates

- G-PLAN: automated validation and independent standards/architecture plus testability/edge-case reviews of the current candidate; no unresolved P0/P1. Report shape alone cannot pass semantic review.
- G-IMPLEMENT: subsequent explicit user release of task IDs/paths/tier after G-PLAN. Existing feature owner gates remain unchanged.
- G-LIVE: approved provider/model/pricing, trusted complete-request token bounds/output caps, cumulative accounting, real guarded-read owner, stable immutable snapshot admission and artifact/grading admission. Missing prerequisites remain not-run; no fabricated receipts.
- G-QUALITY: pinned cases with mandatory safety/provenance passes and human-reviewed required semantic outcomes; scripted responses cannot establish LLM quality.

Production numeric budgets and accuracy/latency promises are deferred pending experiments; experiments always require finite explicit profiles.

## 2026-11-12 — Scoped planning publication

The user explicitly requested a PR and emphasized concurrent work by another agent. Released: an isolated branch from fetched development, containing only Feature 008 planning/review records, ADR-0008, the product-session glossary entry and AGENTS navigation, plus publication validation metadata. Publish a draft through the existing paired PR workflow. Do not include the other agent's runtime/Feature 007 changes or modify its checkout/index/branch. This publication release does not authorize any runtime task, production default, live-provider operation or merge.
