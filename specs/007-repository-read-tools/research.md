# Research: Repository Read Tools

**Date:** 2026-10-06. Evidence is local code and authoritative project documents; no new third-party API facts or dependency decisions are needed.

## 1. Execution boundary

**Decision:** Reuse `WorkspaceBoundary` and `ToolGateway`; inspection remains on the host and does not create Docker containers.

**Rationale:** ADR 0008 requires fresh call authority and pre-execution audit; ADR 0009 confines safe reads to one sealed checkout. `src/workspace/boundary.ts` supplies `openRegularRead`, `openDirectory` and `factsFor`; `src/tools/gateway.ts` owns executor references. `src/sandbox/gateway.ts` distinguishes inspection from verification execution.

**Alternatives considered:** Independent pathname reads or executable traversal would bypass established enforcement; sandbox copies would introduce another retrieval lifecycle and stale state.

## 2. Literal search and safe oversized-file detection

**Decision:** Use in-process case-sensitive literal matching over complete safe-open file bytes; remove ripgrep/grep executable requirements.

**Rationale:** Accepted grilling decision; `src/workspace/retrieval.ts` already uses `line.includes(query)`. Boundary reads currently reject capacities above 4 MiB, so search must add a private 4 MiB+1 probe before treating bytes as complete. `factsFor` currently treats search scope as a directory; file scopes need explicit trusted classification. Public schema remains query/scope/count only.

**Alternatives considered:** Regex adds execution/syntax concerns. Running ripgrep/grep on live paths independently is unsafe; staging bytes for a subprocess is unnecessary for MVP keyword behavior.

## 3. Live evidence

**Decision:** Return content identity computed from the bytes consumed by each read/search; make no task-wide consistency promise.

**Rationale:** User accepted live checkout for MVP. Existing safe reads validate membership/identity before and after held-handle reads but do not make atomic file snapshots. Hashes identify evidence, not authority. Verification's snapshot/verdict contract remains independent (ADR 0011).

**Alternatives considered:** Task/file retrieval snapshots with protection and renewal remain deferred ideas rather than source requirements.

## 4. Narrow heuristic

**Decision:** Retain current gateway redaction and whole-result read/search contract failure on changes, with no additional general secret scanner.

**Rationale:** `src/tools/gateway.ts` redacts case-insensitive `token|secret|password=...` text and secret-like object keys; `tests/tools/output-contracts.test.ts` verifies affected read/search is not returned rewritten. Tool policy requires this defense in depth. User chose option B and required latency evidence.

**Alternatives considered:** Removing the heuristic conflicts with current accepted policy. A broader scanner adds false positives/cost without completeness. Returning rewritten source breaks faithful evidence; partial sanitized search would require a different explicit contract.

## 5. Bootstrap

**Decision:** Runtime-origin registered retrieval uses the same runner/gateway, ceilings, tool attempts and audit. Auto-discover root `AGENTS.md` only; nested instructions require explicit requests. Explicit developer references are structured input.

**Rationale:** ADR 0012 and accepted root-only instruction decision. A separate loader would bypass security and budgets. Runtime origin must never be read from model arguments. Current `TaskRunner.dispatchProposals` must refresh clocks during asynchronous work and propagate trusted audit origin; normal deny/failure recovery remains unchanged.

**Alternatives considered:** Free bootstrap reads, parsing model/repository text for authority-bearing references and loading every nested instruction waste tokens or expand trust. Explicitly referenced nested files are ordinary developer references rather than automatic instruction discovery.

## 6. Finite work and cancellation

**Decision:** Trusted finite files/directories/depth/source bytes plus cooperative elapsed checks and bounded yields; no new worker framework.

**Rationale:** `src/workspace/git.ts` uses synchronous bounded-output Git commands with 10-second timeout. `openDirectory` has a 1,024-entry native cap and fails closed at that limit. These cannot honestly promise instant or hard 5-second interruption. Stop further work after a deadline/abort, close handles, fence results after execution and preserve authority failures distinctly from partial search.

**Alternatives considered:** Unbounded scans after output saturation violate work bounds. A complete asynchronous native/Git redesign is disproportionate without measured need; performance evidence may justify a later reviewed change.

## 7. Retrieval evaluation and latency

**Decision:** Deterministic gateway traces and evidence-property expectations now; live answer correctness stays unmeasured. Dedicated warmed per-host benchmark gates precede enablement.

**Rationale:** Provider integration remains Phase 10. Fixture metrics must measure delivered content separately from discovery and not claim scripted choices prove model reasoning. Baseline-derived timing gates avoid claiming uncollected performance evidence and noisy ordinary unit timing assertions.

**Alternatives considered:** A live provider benchmark would add credentials/network/provider dependencies outside Phase 6. Pure mock executor tests cannot prove actual workspace confinement.

## 8. Prerequisite reconciliation

**Decision:** Preserve current progress: Phase 4 complete for available fixtures under T088; Phase 5 implementation has Linux evidence and an open Windows Docker gate. Phase 6 host retrieval can be implemented/verified independently without asserting full Edit integration readiness.

**Rationale:** Fetching current `development` revealed later status correction superseding the earlier tracker excerpt used during grilling. `coding-agent-context/context/progress-checker.md` is authoritative; unavailable evidence is not PASS. Feature 006 tasks retain T129/T131 open.

**Alternatives considered:** Copying the earlier closed-gate claim would misrepresent project reality; blocking specification work on unrelated Docker fixtures would prevent useful authorized planning.
