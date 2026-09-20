# Slop Loop Context

Shared language for Slop Loop, the local coding-agent system and its developer-facing CLI.

## Language

**Slop Loop**:
The product being built: a controlled local coding-agent application. The name defines the SLOP_LOOP_* application configuration namespace but does not yet define a public package, SDK, or CLI contract.
_Avoid_: Coding Agent as a product name, Slop

**Application configuration variable**:
An environment variable owned by Slop Loop and prefixed with SLOP_LOOP_; Phase 0 recognizes only explicitly declared names within this namespace.
_Avoid_: CODING_AGENT_*, SLOP_*, unprefixed application settings

**Target repository**:
The developer repository on which the coding agent performs analysis, proposes changes, and eventually runs trusted verification profiles. The first target repositories are Python repositories; pytest, Ruff, and mypy belong to those repositories, not to Slop Loop's implementation.
_Avoid_: host repository, implementation repository

**Modular monolith**:
A single-process application whose real subsystem boundaries are introduced only when concrete behavior creates them. Phase 0 starts without speculative subsystem directories or dependency-boundary machinery.
_Avoid_: microservices, distributed MVP


**Developer prompt**:
The request a developer enters to start a repository question or code-editing task.
_Avoid_: tool call, command

**Session**:
A continuous interaction with one agent context and its temporary permissions. A session starts with a fresh context and ends when the developer uses `/clear`, exits the CLI, or starts with a new context; the MVP does not persist session history.
_Avoid_: saved session, permanent permission

**Task mode**:
The developer-selected `Ask` or `Edit` mode for the current session. The developer may switch modes during the session; switching into `Edit` does not restore permissions that were previously revoked.
_Avoid_: model-selected permission

**Agent tool**:
A registered operation the agent may request within the capabilities granted to its session.
_Avoid_: arbitrary command

**File permission**:
The developer's authorization for the agent to update or create one or more named repository-relative files during the current session and branch state. A single request may list several files, and the permission is renewed when a later session or branch change invalidates it.
_Avoid_: blanket edit permission, repository-wide approval

**File edit request**:
The agent's request for permission to update or create one or more named repository-relative paths during an Edit session.
_Avoid_: patch proposal, repository-wide edit request

**Branch state**:
The Git branch and checkout state selected by the developer. A branch switch preserves the conversation, but permissions for files the agent actually changed before the switch must be revalidated and may require one grouped reauthorization request.
_Avoid_: agent-owned branch

**Verification profile**:
A trusted, named set of checks such as tests, lint, type checking, or a build that the runtime can execute in an ephemeral sandbox copy. The model cannot supply arbitrary shell commands.
_Avoid_: arbitrary command, host execution
**Operational log**:
Structured diagnostic output used to understand application behavior. It is separate from canonical audit evidence and is not the authorization record.
_Avoid_: audit event, audit chain
**Audit event**:
One bounded, structured record in a session's canonical append-only JSONL evidence stream.
_Avoid_: log message, database row

**Logical test target**:
The existing test file or test node the model requests through a verification tool.
_Avoid_: command line, shell argument

**Validated test target**:
The trusted profile and target that deterministic verification maps from a logical test target and actually executes.
_Avoid_: model command

---

**Repository content**:
Untrusted repository data whose tool result retains source-path and retrieval-method provenance. It may influence model intent but never system instructions or deterministic policy.
_Avoid_: repository instructions, trusted prompt

**Operation-bound file permission**:
Authorization for one canonical repository-relative path and one operation: update or create. Create is exclusive.
_Avoid_: filename-only permission, generic write permission

**Trusted verification profile**:
A profile loaded at session start after schema validation and allowlisting. In-session changes wait for a later session.
_Avoid_: model command, live repository policy

**Audit chain**:
Canonical UTF-8 JSONL events linked by SHA-256 hashes and closed by a manifest with event count and final hash.
_Avoid_: database authority, debug log


