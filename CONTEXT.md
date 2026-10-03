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
The developer repository on which the coding agent performs analysis, proposes changes, and eventually runs trusted verification profiles. The first target repositories are TypeScript repositories, initially Slop Loop itself.
_Avoid_: host repository, implementation repository

**Workspace**:
The validated current checkout of one target repository that bounds repository tool access. It spans the checkout even when Slop Loop starts in a subdirectory; other repositories, whether sibling or nested, remain outside it.
_Avoid_: launch folder, collection of repositories

**Modular monolith**:
A single-process application whose real subsystem boundaries are introduced only when concrete behavior creates them. Phase 0 starts without speculative subsystem directories or dependency-boundary machinery.
_Avoid_: microservices, distributed MVP


**Developer prompt**:
The request a developer enters to start a repository question or code-editing task.
_Avoid_: tool call, command

**Session**:
A continuous in-memory interaction in one CLI process that can contain multiple tasks and temporary permissions. It ends on `/clear`, CLI exit, or a new context; restoring an ended session is deferred.
_Avoid_: saved session, permanent permission

**Task mode**:
The developer-selected `Ask` or `Edit` mode bound to one task from start to terminal outcome. A different mode requires a new task.
_Avoid_: model-selected permission

**Active task**:
The one task occupying a target checkout's execution slot, including while it waits for developer permission. The slot is released when the task reaches a terminal outcome.
_Avoid_: running task, unfinished task

**Agent tool**:
A registered operation the agent may request within the capabilities granted to its session.
_Avoid_: arbitrary command

**Closed tool registry**:
The authoritative catalog of agent tool names and call contracts from which model-visible tool schemas are derived. It does not grant permission or perform operations.
_Avoid_: tool executor, permission list

**Tool gateway**:
The mandatory boundary between a validated agent tool request and its executor. It permits execution only after current task authority and policy allow the call.
_Avoid_: tool registry, executor

**Policy decision context**:
The trusted task, permission, budget, and environment facts assembled for one agent tool request. It is scoped to that request and cannot authorize a later call.
_Avoid_: reusable policy snapshot, model-supplied authority

**Model-visible tool set**:
The registered tools selected for presentation to the model from trusted session state, including the developer-selected task mode. Visibility does not authorize a call.
_Avoid_: granted capabilities, executable tools

**Task capability ceiling**:
The maximum authority sealed for one task at admission, bound to its session, workspace, fixed mode, eligible tools, resource limits, and trusted budget promotion schedule. Later file permissions and model requests cannot expand it.
_Avoid_: file permission, model-visible tool set

**Work capacity budget**:
The finite model-turn and tool-attempt allowances for one task. Trusted policy may promote the active profile only within the schedule sealed at admission.
_Avoid_: model-selected budget, recovery budget

**Recovery budget**:
The one shared task-level allowance for verification/repair, model, and denial recovery, fixed by the initial admitted profile. Promotion never enlarges it, and exhaustion ends the task.
_Avoid_: work capacity budget, unlimited retry

**Budget handoff**:
A bounded developer-facing summary emitted when a task ends with `BUDGET_EXHAUSTED`, for use when starting a later task. It does not restore the ended session or carry authority forward.
_Avoid_: restorable session, continuation permission

**File permission**:
The developer's authorization for exact file `update` or `create` operations during the current session and observed branch/file state. A valid grant may be reused across Edit tasks and repairs in that session, but a branch switch revokes all grants and external target changes invalidate affected grants; one request may batch several exact canonical repository-relative path-operation pairs.
_Avoid_: blanket edit permission, repository-wide approval

**File edit request**:
The agent's request during an Edit session for the developer to authorize one or more exact canonical repository-relative path-operation pairs.
_Avoid_: patch proposal, repository-wide edit request

**Branch state**:
The Git branch and checkout state selected by the developer. A branch switch within the same workspace may preserve the active task and conversation after repository evidence is refreshed, but revokes all earlier file grants and pending permission prompts.
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
An atomic authorization for one canonical repository-relative path and exactly one operation: `update` or `create`. Permission for `update` does not authorize `create`, and create is exclusive.
_Avoid_: filename-only permission, generic write permission

**Trusted verification profile**:
A profile loaded at session start after schema validation and allowlisting. In-session changes wait for a later session.
_Avoid_: model command, live repository policy

**Audit chain**:
Canonical UTF-8 JSONL events linked by SHA-256 hashes and closed by a manifest with event count and final hash.
_Avoid_: database authority, debug log


