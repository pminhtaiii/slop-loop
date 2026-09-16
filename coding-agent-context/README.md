# Coding Agent Context Pack

This folder is a context package for building a secure coding agent MVP.

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
1. project-overview.md
2. architecture.md
3. tool-policy.md
4. code-standards.md
5. library-docs.md
6. workflow.md
7. progress-checker.md
```

Before implementing a specific feature, the agent should then inspect the relevant production code and tests.

## Key Principle

```text
LLM proposes.
Policy authorizes.
Sandbox executes.
Tests verify.
Audit records.
```

The model itself is never the authority for permissions.
