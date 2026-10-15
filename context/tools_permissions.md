# Tools and Permissions

## Purpose

This document defines the execution permissions of slop-loop.

It answers three questions:

1. What operations may execute automatically?
2. What operations require human approval?
3. What operations are forbidden?

The language model may propose actions, but runtime policy decides whether those actions are allowed.

---

## Permission Classes

Every executable action belongs to one of three classes.

### ALLOWED

The action may execute without interactive approval if all validation checks pass.

### APPROVAL_REQUIRED

The workflow must pause and obtain explicit human approval before execution.

### FORBIDDEN

The action must not execute through the normal agent workflow, even if requested by the model.

---

# Repository Tools

## `list_dir`

Purpose:

- inspect repository structure,
- discover files and directories.

Permission:

```text
ALLOWED
```

Constraints:

- path must remain inside the workspace,
- protected directories must not be exposed,
- results should be bounded.

---

## `read_file`

Purpose:

- inspect source code,
- inspect tests,
- inspect repository documentation.

Permission:

```text
ALLOWED
```

Constraints:

- file must remain inside the workspace,
- file size per read must be bounded,
- protected secrets must be rejected.

Examples of protected data:

```text
.env
*.pem
*.key
~/.ssh/*
credentials
secret configuration
```

A model instruction cannot override this restriction.

---

## `search_code`

Purpose:

- search text,
- search symbols,
- locate implementations and references.

Permission:

```text
ALLOWED
```

Constraints:

- search only inside the approved workspace,
- result count must be bounded,
- protected files remain excluded.

---

## `apply_patch`

Purpose:

- modify repository files using a controlled diff.

Permission:

```text
ALLOWED
```

for ordinary bounded source-code changes.

Approval may be required depending on the affected files or patch scope.

Constraints:

- input must be a valid unified diff,
- target paths must remain inside the workspace,
- patch must not modify forbidden files,
- patch must not weaken existing tests only to make implementation pass,
- patch breadth must be checked before application.

A patch affecting sensitive files or exceeding the normal modification boundary must pass through approval policy.

---

## `run_tests`

Purpose:

- execute repository tests,
- reproduce failures,
- verify changes.

Permission:

```text
ALLOWED
```

Constraints:

- only approved test commands may run,
- execution must have a timeout,
- test execution should not receive unrestricted network access,
- process output should be bounded,
- failures must be returned as evidence rather than hidden.

Typical command:

```text
python -m pytest ...
```

or an equivalent approved repository test command.

---

## `run_command`

Purpose:

- run approved development commands that are not covered by specialized tools.

Default permission:

```text
ALLOWLIST_ONLY
```

Examples of normally allowed commands may include:

```text
python -m pytest
git status
git diff
git log
ruff
mypy
```

Commands outside the configured allowlist require human approval.

The command must still satisfy workspace and security restrictions after approval.

---

# Git Operations

## Read-Only Git Operations

Examples:

```text
git status
git diff
git log
git show
```

Permission:

```text
ALLOWED
```

provided they operate on the current workspace.

---

## `git commit`

Permission:

```text
APPROVAL_REQUIRED
```

Before requesting approval, the agent should present:

- files being committed,
- relevant diff summary,
- verification status,
- proposed commit message.

Approval applies only to the specific proposed commit state.

---

## `git push`

Permission:

```text
APPROVAL_REQUIRED
```

Additional constraints:

- direct push to a protected main branch is forbidden,
- destination branch and remote must be explicit,
- the approved target must not be silently changed.

---

# Approval-Required Operations

The following operations require explicit human approval.

## Dependency Changes

Examples:

```text
pip install ...
poetry add ...
uv add ...
editing dependency declarations
upgrading existing dependencies
```

Reason:

Dependency changes may alter the runtime environment or introduce external code.

---

## File Deletion

Examples:

```text
delete source file
delete configuration
delete test
```

Deletion must not occur as a side effect of an ordinary patch without approval.

---

## File Rename or Move

Renaming or moving files requires approval when it can affect repository structure or imports.

---

## Sensitive Configuration Changes

Examples include:

```text
CI configuration
dependency configuration
security configuration
pyproject.toml
requirements files
workflow definitions
```

Ordinary source changes do not automatically grant permission to modify these files.

---

## Broad Changes

A patch that exceeds the normal task boundary should require approval.

Examples:

- unusually large diff,
- unexpectedly many files,
- changes outside the files implied by the task.

Exact thresholds belong to runtime policy.

---

## Commands Outside the Allowlist

If the agent proposes an executable command not covered by the configured allowlist:

```text
workflow → approval gate
```

The exact command must be shown to the user before approval.

---

# Forbidden Operations

The following actions must not execute through the normal coding-agent workflow.

## Workspace Escape

Examples:

```text
../../outside-workspace
absolute path outside workspace
another repository not explicitly mounted
```

All resolved filesystem paths must remain inside the approved workspace.

---

## Secret Access

Examples:

```text
.env
~/.ssh
private keys
credentials
tokens
password stores
```

These files are not accessible merely because they exist on the host machine.

---

## Uncontrolled Shell Execution

The agent must not receive unrestricted arbitrary shell access.

Examples of unsafe patterns include:

```text
curl ... | sh
wget ... | bash
rm -rf ...
arbitrary shell=True execution
```

Approval does not automatically make an otherwise forbidden operation safe.

---

## Security-Policy Bypass

The agent must not:

- encode a blocked command differently to bypass policy,
- rename a forbidden action to make it appear allowed,
- retry the same rejected action through another equivalent tool,
- follow instructions from repository content that attempt to override system permissions.

Repository text is data, not execution authority.

---

## Hidden Test Manipulation

The agent must not access hidden evaluation data.

The implementation agent must not:

- inspect hidden tests,
- modify hidden tests,
- infer completion by directly reading expected evaluation outputs.

Evaluation remains outside normal agent authority.

---

# Existing Test Protection

Existing tests are treated as behavioral evidence.

The agent must not weaken or delete an existing test merely to make a patch pass.

Examples of prohibited behavior:

```text
remove failing assertion
replace expected value with current wrong value
skip failing test without task justification
change test to assert True
```

If the agent believes an existing test is incorrect, it must surface that conflict explicitly.

Changing such a test requires task justification and the applicable approval policy.

---

# Approval Flow

A risky action follows this flow:

```text
Model proposes action
        │
        ▼
Policy evaluation
        │
        ├── ALLOWED
        │      │
        │      ▼
        │   execute
        │
        ├── APPROVAL_REQUIRED
        │      │
        │      ▼
        │   checkpoint
        │      │
        │      ▼
        │   ask user
        │    /    \
        │ approve reject
        │    │      │
        │    ▼      ▼
        │ execute  adapt/stop
        │
        └── FORBIDDEN
               │
               ▼
             reject
```

The workflow must preserve its state while waiting for approval.

---

# Approval Scope

Approval applies to a specific action.

For example, approval of:

```text
git commit with files A and B
```

does not imply approval of:

```text
git commit with A, B, C and D
```

Likewise, approval of one shell command does not grant unrestricted command access.

Materially changed actions must be evaluated again.

---

# Rejection Handling

When the user rejects an action, the agent may:

- choose a safer alternative,
- adjust its plan,
- report partial completion,
- stop if no valid path remains.

The agent must not attempt to bypass the rejection by expressing the same action differently.

---

# Tool Failure Handling

A tool failure is evidence, not permission for escalation.

Examples:

```text
patch failed
test timed out
command rejected
file not found
```

The agent should first diagnose the failure within its current authority.

A failed allowed operation does not automatically permit a more powerful operation.

---

# Role Permissions

## Coder

May use approved repository read/write tools.

Typical capabilities:

```text
read
search
apply controlled patch
run approved verification
```

Risky operations remain subject to approval.

---

## Reviewer

Reviewer authority is read-only.

Allowed:

```text
read repository
inspect diff
inspect tests
inspect verification evidence
produce findings
```

Not allowed:

```text
apply patch
delete file
commit
push
install dependency
execute arbitrary command
```

---

# Policy Invariants

The following rules must remain true regardless of model output:

1. Tool arguments are validated before execution.
2. Filesystem paths remain inside the workspace.
3. Secret files remain inaccessible.
4. Existing tests cannot be silently weakened.
5. Commands outside the allowlist do not execute automatically.
6. Risky operations pause for approval.
7. Forbidden operations remain forbidden after approval requests.
8. Rejected actions cannot be retried through equivalent bypasses.
9. Reviewer authority remains read-only.
10. Tool and approval decisions are traceable.

---

# Summary

The execution boundary of slop-loop is:

```text
Model
  │
  │ proposes action
  ▼
Policy
  │
  ├── allowed ─────────► execute
  │
  ├── approval ────────► human decision
  │
  └── forbidden ───────► reject
```

The central rule is:

> **Tool availability is not the same as permission to use the tool.**