# Runtime Policy Contract

This document defines cross-cutting operational requirements for the planned slop-loop runtime. It is a target contract, not evidence that enforcement exists. [Tools and permissions](tools_permissions.md) remains authoritative for permission classes, tool rules, and role access. [State and memory](state_and_memory.md) remains authoritative for persisted state and checkpoint contents.

## Trusted configuration and protected data

Provider credentials are trusted runtime configuration available only through the explicit provider boundary. They are not model context, repository-tool data, command arguments, child-process environment, traces, or logs. Repository secrets and other protected payloads remain governed by [tools and permissions](tools_permissions.md); a provider credential does not grant tools access to them.

## Paths, commands, and subprocesses

- Resolve repository paths to canonical filesystem locations and verify that each remains inside the approved workspace. Check symlinks and Windows junctions after resolution; write operations must also validate the canonical parent of a not-yet-created path and recheck containment immediately before use.
- Validate each command against a configured executable and argument policy. Pass an executable and structured argument vector directly to process creation. Do not interpolate model or repository text into a shell command, enable shell parsing, or accept an unconfigured executable.
- Run repository subprocesses in a sandbox with workspace-scoped filesystem access, network blocked by default, and explicit CPU, memory, process, time, and output bounds. Give child processes only a minimal configured environment; never inherit the host environment or provider credentials wholesale. Provider network access belongs to the provider adapter, not repository commands.

## Approval identity

Bind each approval to the exact normalized action, repository identity and relevant revision/worktree state, and policy identity/version. Persist that binding with the approval decision. On resume, revalidate all bound identities before execution; a materially changed action, repository state, or policy invalidates the approval and requires a new decision. Approval authorizes only that action.

## Finite limits and interruption

Timeout, output, CPU, memory, process, repair, reviewer-iteration, token, and cost limits must be finite and configured before the operation they constrain begins. Their values and configuration source remain `OPEN`; this document sets no defaults. If a required limit is absent, invalid, or unlimited, reject the affected operation before its side effect.

After interruption, reconcile whether a non-idempotent action took effect before retrying it. Use recorded evidence or inspect the current repository and external outcome; never blindly replay an action whose outcome is uncertain. Retry only when the operation is idempotent or duplicate effects are prevented, as specified by the relevant tool policy.

## Trace and diagnostic data

Record enough metadata to explain a run: stable task/run and event identifiers, timestamps and durations, workflow node, tool or action type, outcome, policy and approval references, and bounded result counts. Approved command details may be recorded only after sanitization and within configured size limits. Do not record raw prompts, credentials, raw tool output, or protected payloads.

Only bounded, redacted test and command diagnostics may enter model context or logs; raw tool output is never included. When full evidence is needed, store it as a separately protected artifact and record an access-controlled reference, size, and digest; do not inline an unbounded dump. Apply the same data boundary to review input and final reports.
