---
status: accepted
---

# Resume an active task after a branch switch in the same checkout

The developer may switch branches while a task is active and continue that task in the same validated checkout. When trusted checks detect the switch, Slop Loop invalidates every prior file grant and any pending file-permission prompt, pauses further tool dispatch, and refreshes branch, `HEAD`, status, diff, and relevant file evidence before the agent decides whether work remains. Git status or diff alone does not prove task completion or unchanged target identity. An explicit developer instruction to continue resumes without a separate confirmation; otherwise the UI offers a small resume choice. A resumed Edit task requests fresh exact path-operation permission only when it next needs to mutate a file. The task keeps its sealed mode, workspace identity, tools, and budgets; replacing the checkout with another repository requires a new task.

Trusted runtime checks occur at admission, immediately before mutation, after tool calls, and on resume; they do not require the model to poll Git during a call. The runtime gives the model a bounded, trusted branch/`HEAD`/status snapshot when work starts or is refreshed. `git_diff` remains the sole model-visible Git tool in the MVP; there is no `git_status` tool. A transient switch away and back entirely between checks is outside the MVP detection guarantee. An observed change during a call makes that call's result stale until the runtime reconciles the actual checkout and any effect before continuation.

This favors continuity of the developer's task while making old branch permissions unusable. It supersedes ADR 0001's narrower rule that only affected grants become unavailable on a branch switch; external changes to individual targets still invalidate their grants independently.
