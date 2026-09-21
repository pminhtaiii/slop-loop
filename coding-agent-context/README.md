# Slop Loop Context Pack

This folder is a context package for building the secure Slop Loop MVP.

## Files

```text
context/
├── project-overview.md   # Product goal, scope, flows, success criteria
├── architecture.md       # Components, trust boundaries, data and runtime architecture
├── code-standards.md     # Implementation conventions and engineering invariants
├── library-docs.md       # Project-specific third-party library usage rules
├── tool-policy.md        # Authoritative model tool/capability security policy
├── workflow.md           # Required feature-development workflow
└── progress-checker.md   # Implemented-vs-planned status tracker
```

## Suggested Reading Order for an Agent

```text
1. ../CONTEXT.md
2. project-overview.md
3. architecture.md
4. tool-policy.md
5. code-standards.md
6. library-docs.md
7. workflow.md
8. progress-checker.md
```

Before implementing a specific feature, the agent should then inspect the relevant production code and tests.

## Authority and Reading Notes

- `../CONTEXT.md` is the authoritative shared vocabulary.
- `context/tool-policy.md` is authoritative for model-accessible tool permissions, capabilities, and security rules.
- `context/progress-checker.md` is the source of truth for implemented, planned, and deferred status.
- Accepted architectural decisions and their rationale are recorded under `../docs/adr/`.
- `project-overview.md` and `architecture.md` may describe intended or future behavior; neither proves that behavior is implemented.

## Key Principle

```text
LLM proposes.
Policy authorizes.
Sandbox executes.
Tests verify.
Audit records.
```

The model itself is never the authority for permissions.
