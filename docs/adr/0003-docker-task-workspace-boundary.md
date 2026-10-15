# Docker for the task execution environment

Accepted on 2026-10-15 during the UC-03 workspace discussion. Use Docker for the task execution environment containing the working repository and Python/pytest tooling. Docker was selected over Podman because the project owner has practical experience with Docker and its surrounding tooling. This selects a target technology, not an implemented or verified isolation capability.

Enforce access to the assigned repository and task-specific scratch area, with controlled read-only access to required runtime dependencies. Deny access to other host files through both repository tools and executed processes, including tests. Refuse execution when required restrictions cannot be established. Container mounts, permissions, network policy, resource limits, and escape-resistant path checks still require concrete design and verification.

The trusted host owns the agent loop, LangGraph, task state/checkpoints, policy engine, model proxy and API credentials, Docker controller, and hidden grading. The task container contains only the working repository, task-specific scratch area, Python, pytest, and prepared dependencies. Repository code is treated as untrusted and receives no access to agent runtime files, credentials, Docker control, or hidden grading. Repository content and command output remain untrusted inputs even when filesystem isolation is enforced.

For the first local version, the host policy gate authorizes structured tool operations and a host-side tool executor performs them through Docker's existing execution interface. Do not introduce a separate REST or gRPC service for this slice. Keep the tool contract independent of transport; reconsider gRPC if a separate or remote execution service becomes necessary.

Task containers run without network access. Prepare required dependencies before task execution; a missing dependency is an environment prerequisite to report, not permission to download packages. The trusted host retains model API access. Network denial reduces exposure but does not make repository content or executable tests trusted.

Each new task receives a fresh container, repository copy, and scratch area. Reuse a prepared image rather than rebuilding dependencies for each task. A resumed task retains its workspace identity through UC-04's recovery contract; a different task must not inherit writable workspace state. Exact persistence, retention, and teardown mechanics remain open.
