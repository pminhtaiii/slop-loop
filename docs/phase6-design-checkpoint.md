# Phase 6 read tools design checkpoint

This records accepted design decisions from the 2026-10-06 grilling session. Phase 6 remains planned; these are not implementation or verification claims. The subsequent request to generate reviewed Spec Kit artifacts confirms the shared design. See specs/007-repository-read-tools/ for the specification and implementation plan.

## Q1: Narrow sensitive-content heuristic

Retain denied-path checks and the existing gateway heuristic for secret-like fields and `token=`, `secret=`, and `password=` text. Do not add a general repository-content secret scanner for the MVP. Preserve the existing fail-closed read/search contract when heuristic redaction would alter a payload; never present rewritten text as complete. This heuristic is defense in depth and cannot establish that allowed files are free of secrets.

The user requires performance tests before real retrieval is enabled. Measure heuristic/sanitization overhead separately from filesystem traversal and search, using ordinary and adversarial payloads at the maximum registered read/search sizes, including repeated candidate strings, long values, nested structured results, Unicode, and no-match cases. Record warmed latency distributions and end-to-end overhead on reference hosts; select enforceable performance thresholds from measured baselines during planning. Correctness and output confidentiality must not be relaxed to meet latency targets. No performance evidence has been collected yet.

## Q2: Automatic context authority

Accepted: automatic context uses the same authorized retrieval path and task allowances as task-requested retrieval. See ADR 0012 for the boundary and rationale.

## Q3: Search implementation and semantics

Accepted: remove the requirement to use ripgrep. MVP `search_code` provides case-sensitive literal keyword matching over safely opened bytes, using the existing in-process search behavior. The agent may make additional scoped search, listing, and read calls to gather context, within the task's sealed budgets. No grep executable or regular-expression capability is introduced. Search must preserve the existing workspace boundary and runtime-owned limits.

## Q4: Live-checkout retrieval

Accepted: MVP retrieval observes the live checkout per call, attaches content identity to retrieved evidence, and does not claim a consistent task-wide snapshot. Later mutation must revalidate its targets, and verification retains its separate snapshot contract. Content identity is evidence, not authority, and does not prove that a file stayed unchanged between calls.

Deferred idea: retrieval snapshots with explicit identity, stale-state detection, and a lifecycle for renewing individual-file or broader snapshots. Snapshot scope, protection, retention, and renewal semantics remain undecided; this is not an MVP requirement.

## Q5: Search context acquisition

Accepted in the follow-up: use the existing `search_code` tool for MVP; additional context comes from further budgeted retrieval calls. This settles the literal-search recommendation in Q3.

## Q6: Instruction discovery

Accepted: automatically load only root `AGENTS.md` as repository instruction context. Nested instruction files are retrieved explicitly by the agent when needed; do not automatically load them when their descendants are accessed. Instruction content remains untrusted repository data, subject to the same security checks, narrow heuristic, output bounds, audit requirements, and task allowances as other reads. The automatic context tree and explicit developer references remain within the previously accepted small-context scope; this decision narrows instruction discovery only.

## Planning defaults

Use deterministic provider-neutral retrieval fixtures and scripted gateway traces for Phase 6. Prove tool behavior, confinement, provenance, bounding, and retrieval metrics without depending on a real model; do not claim measured live-model answer correctness from scripted traces. Real provider integration remains Phase 10.

Select deterministic listing order, scope traversal, finite work limits, cancellation checks, and explicit incomplete-search indications during planning. An interrupted or work-limited search must not be represented as a complete no-match result. Additional retrieval remains budgeted and never runs until the model declares itself satisfied without a finite ceiling.

## Design status

The consequential decisions identified in this interview are settled, and the developer authorized specification/planning. This checkpoint does not claim Phase 6 completion. Current development supersedes the older status read at the interview's start: Phase 5 implementation has Linux evidence, but its Windows Docker gate remains OPEN. The ripgrep and automatic-context wording is reconciled as planned design during the Feature 007 workflow. Root-only automatic instruction discovery does not prohibit an explicitly developer-referenced nested instruction file from entering as ordinary referenced content.

Routine listing order, bounding details, fixture mechanics, and performance-test implementation will be selected during planning within accepted policy.
