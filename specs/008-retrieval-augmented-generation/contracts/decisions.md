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

## 2026-11-13 — UC-02 planning alignment

Authority: user-provided UC-02 requirements and confirmed Q1–Q14, including logical splitting with original-definition linkage and budgeted expansion, exact token admission, compatibility, persistence and benchmark conditions. Replace the literal-only retrieval choice. Keep the read-only Python target and controlled source tools, durable index with incremental refresh, and in-memory question sessions. Feature 008 moves to specs/008-retrieval-augmented-generation; new UC-02 branches use feat/rag-*. Historical planning snapshots and reports refer to their original candidate and cannot certify this revision.

G-PLAN requires fresh automated and independent review of this revision. G-IMPLEMENT remains a separate task/path/tier release. G-LIVE and G-QUALITY still govern real owner/provider and answer-quality acceptance. Durable store compatibility and real local embedding benchmark runs require explicit implementation/test release. Planning and review are authorized; issue publication follows approval of the proposed ticket breakdown and configured paired tracker access.

## 2026-11-14 — T001–T006 controlled implementation release

After the UC-02 planning review, the user explicitly requested implementation of T001–T006 in [`tasks.md`](../tasks.md), with Luna Max implementing and Sol medium reviewing and repairing the batch. G-IMPLEMENT covers those six task scopes at the source and controlled-test tier, including the assigned foundation, question contracts, fixture, budget, and evidence paths.

T007 onward, live owner/provider composition, production defaults, durable storage and restart acceptance, embedding experiments, and real-model quality acceptance require their own releases and evidence. The contributor workflow governs publication and the human merge decision.

## 2026-11-17 — T019, T022 and T020 implementation release

The user requested T019, T020 and T022 and selected the `feat/rag-retrieval-foundation` branch. The selected scope covers pinned dependency and SQLite compatibility checks, the controlled and local embedding adapters, and guarded corpus segmentation. Execute T019, then T022, then T020 in dependency order. The existing Ubuntu CI verifies the SQLite extension in the emitted build. Verify Windows on a Windows checkout.

T021, serving and runtime composition, real embedding quality measurement, production defaults and merge remain separately gated.

## 2026-11-20 — T021 and T023 implementation release

The user explicitly requested implementation of T021 and T023 in the canonical task ledger and selected `feat/rag-persistent-hybrid-retrieval`. Execute T021 before T023, retaining T019, T020 and T022 as prerequisites. The release covers the persistent incremental index, hybrid retrieval, guarded evidence re-admission and scoped coverage receipts under the existing retrieval contract, with disposable local storage and controlled embedding tests.

This release does not authorize successor graph/runtime composition, production defaults, real embedding quality measurement under T026, live-provider experiments or a protected-branch merge. Store restart checks establish only the exercised index behavior, not durable question-session recovery or real-model answer quality. Contributor publication follows the existing paired PR workflow and human merge decision.

## 2026-11-22 — T007–T010 controlled implementation release

The user explicitly requested T007, T008, T009 and T010 and selected `feat/rag-question-model-and-investigation`. Execute these tasks in dependency order with the completed foundation and retrieval tasks as prerequisites. The release covers the question model protocol, deterministic complete-request compilation, supplied host transport/accounting boundaries, sequential investigation graph, typed clarification/stop outcomes and adversarial fixtures at the source/controlled-test tier.

T011 onward, actual live-provider/owner admission, production defaults, real-model quality, embedding experiments and protected-branch merging remain separately gated. Controlled transports and counters establish only exercised protocol behavior. Contributor publication and independent merger/review checks follow the existing workflow.
