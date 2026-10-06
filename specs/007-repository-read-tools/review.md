# Planning Review: Repository Read Tools

**Date:** 2026-10-06. Scope: spec, plan, contracts and ordered tasks, not implementation.

## Independent Reviews

Two independent parent-model subagents reviewed the artifacts and actual code seams. Luna 6 with xhigh reasoning performed the requested codebase exploration. Reviewers rechecked the fixes and reported no remaining blocking findings.

| Axis | Finding | Resolution |
| --- | --- | --- |
| Security/architecture | Raw unknown proposed tool names could expose sensitive text in audit | T135/T136 require registered names or a closed sentinel plus a secret-bearing-name regression |
| Security/architecture | Slow final success could bypass active-work accounting; executor lacked remaining task budget | Trusted remaining-work callback/authority, pre/post TICK, final-call accounting and late-payload suppression specified with planned tests in T135/T136 |
| Spec/executability | Tasks named a nonexistent retrieval regression suite | Actual read-bounds/search-bounds suites and affected gateway/sandbox fake outputs explicitly migrate |
| Spec/executability | Factory enablement/composition after performance gates was unspecified | T154 adds trusted gateway composition after T151–T153, followed by full review/verification and readiness at T158 |
| Spec/bounding | Unique-reference cap left raw preprocessing/omissions unbounded | Inspect <=32 raw references of <=1,024 characters, admit <=4 unique refs, bound omissions and summarize remainder |

Additional exploration findings are incorporated: TypeScript and native read-capacity guards both need the private +1 probe, file search scope needs factsFor classification, listing sanitization must not fabricate canonical paths, directory high-fanout fails closed, and synchronous primitive cancellation is cooperative rather than hard preemption.

Explicit developer references to nested instruction files are ordinary reference content; no nested instructions are automatically discovered. This resolves the distinction between root-only instruction discovery and deliberate reference input without expanding repository authority.

## Self Review

- FR-001–FR-024 map to tasks; all runtime task boxes remain unchecked.
- Strict names/input schemas, finite output/work caps, existing heuristic and bootstrap/task authority are preserved.
- No extra dependency/search process, broad scanner, provider, CLI, durable audit writer or retrieval snapshot lifecycle is introduced.
- Current development status is preserved: Phase 5 Windows Docker gate OPEN; Phase 4 T088 unavailable exception is explicit.
- Unratified constitution placeholders are identified rather than treated as accepted principles.
- Spec Kit setup-plan/setup-tasks/prerequisite scripts were run against Feature 007. Optional after_specify/after_plan agent-context hook was executed; phase-specific pointers were preserved after the generic updater replaced its block. No mandatory hooks or task/taskstoissues hooks were registered.

## Validation Evidence

Artifact format, link, task consistency and final publication evidence are recorded below after execution. No source runtime tests or performance measurements are claimed for this documentation-only change. Future implementation must run quickstart.md and keep unavailable evidence explicit.

- Spec Kit prerequisite JSON resolves Feature 007 and all required planning artifacts.
- Artifact check passed: 27 sequential unchecked tasks T132–T158 with concrete paths, 24 functional requirements, no unresolved feature placeholders and every local feature-document link resolves.
- `git diff --check` passed.
- Changed-document formatting passed using the installed Prettier CLI under Node 24.14.0. Corepack's local cache write was sandbox-restricted; invoking the already installed formatter directly avoided a dependency install.
- Existing GitHub issues were fetched across all open/closed pages from verified origin `pminhtaiii/slop-loop`; no T132–T158 issue existed before publication.
