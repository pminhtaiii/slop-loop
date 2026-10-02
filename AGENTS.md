<!-- SPECKIT START -->
For approved Phase 1 design, read `specs/002-task-domain-orchestrator/plan.md`.
Phase 1 source work was authorized before Phase 0 completion; the Phase 0
exit gate remains prerequisite for Phase 1 integration readiness.

For planned Phase 2 closed tool registry work, read
`specs/003-closed-tool-registry/plan.md`.

For planned Phase 3 policy engine and tool gateway work, read
`specs/004-policy-engine-capabilities/plan.md`.

For planned Phase 4 workspace-boundary work, read
`specs/005-workspace-boundary/plan.md`.

For planned Phase 5 offline verification sandbox and developer preparation,
read `specs/006-offline-verification-sandbox/plan.md`. Real sandbox integration
requires the complete Phase 4 workspace-boundary exit gate.
<!-- SPECKIT END -->

## Slop Loop Project Context

Before implementing or reviewing repository changes:

- Read `CONTEXT.md` for authoritative shared vocabulary.
- Read `coding-agent-context/README.md` for the context map and reading order.
- Treat `coding-agent-context/context/tool-policy.md` as authoritative for model-accessible tool, capability, and security policy.
- Follow `coding-agent-context/context/workflow.md` for the mandatory feature-development workflow.
- Read `coding-agent-context/context/testing.md` for phase-specific verification commands and expected behavior.
- Use `coding-agent-context/context/progress-checker.md` as the source of truth for implemented, planned, and deferred status.
- Read relevant ADRs under `docs/adr/` before changing an accepted architectural decision.

Do not infer implementation status from architecture or planning documents alone. The Spec Kit-managed plan pointer above is feature-specific context and does not override these project-wide authority documents.
