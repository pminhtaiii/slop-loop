# Local Coding Agent MVP

Label: wayfinder:map

## Destination

An implementation-ready specification for a secure local coding agent MVP, aligned with the context pack: an interactive CLI that answers questions about Python repositories and fixes a small bug in an isolated Git worktree, runs trusted checks, and returns a reviewable diff and verification report.

## Notes

The agreed baseline is recorded in [First Local MVP](../../coding-agent-context/context/project-overview.md#first-local-mvp). Read the context pack before resolving a ticket, especially `tool-policy.md` and `progress-checker.md`. Use the grilling and domain-modeling skills for human decisions. This map plans the MVP; it does not implement the runtime. Tickets are local Markdown issues under `issues/`.

## Decisions so far

<!-- Closed ticket pointers go here. Decisions settled before this map are in the context pack linked above. -->

## Not yet specified

- How task admission and capability grants should be expressed in the CLI once the input contract is clear.
- How task cancellation, restart, worktree retention, and failure recovery should behave once the worktree lifecycle is decided.
- Which audit records and final report fields are needed after the CLI interaction and execution boundaries are defined.
- How much repository context to select for the model and how to measure answer quality after the first workflows are specified precisely.
- How the first model provider is configured and evaluated after its selection criteria are agreed.

## Out of scope

- Web interface and API transport for the first MVP.
- Changing an active task's scope through conversation.
- Git push, pull request creation, merge, deployment, dependency installation, and unrestricted shell access.
