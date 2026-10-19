# Classification and Identity Policy: UC-05

**Status**: Logical decision-table contract agreed through the T001 confirmation in [decisions](decisions.md). Mandatory boundaries come from [permissions](../../../context/tools_permissions.md), [runtime policy](../../../context/runtime_policy.md) and [ADR-0006](../../../docs/adr/0006-uc05-cli-and-human-control.md). Configured production values remain owner-selected inputs; no runtime implementation is claimed.

## Input and authority

Classify canonical validated actions plus trusted role/task authority, policy/config version, registered continuation, admitted path/content/patch facts and command rules. Tai supplies canonical containment (including symlinks/junctions and new-path parents), secret/test-protection and isolation facts. Missing facts deny the affected action; raw model path strings or a "safe" flag are not evidence. Authoritative task-control admission precedes any dispatch, independent of permission class.

## Precedence table

Apply rows in order; a later approval cannot override an earlier denial.

| Condition | Result / behavior |
|---|---|
| Missing/malformed trusted context, required profile, bound, registered action, or unsupported operation | Typed invalid/prerequisite denial; zero dispatch, no human override of absent enforcement |
| Workspace escape, protected path/content, hidden grading, policy bypass, test weakening, unrestricted/injected command, command writes to source/test volume, reviewer write/execute attempt | FORBIDDEN; safe reason; no approvable request |
| Production patch lacks fresh exact-state fix-plan approval | Request fix-plan gate first; no patch; later evaluate action-specific permission separately |
| New material strategy proposal | Require trusted materiality and UC-04 allowance; fresh fix-plan approval before edits; cap three |
| Valid approve_fix_plan action | APPROVAL_REQUIRED; explicit trusted human response, never autoapproval |
| Dependency declaration/install, file deletion, structural move/rename, sensitive configuration (CI/security/workflow/requirements/pyproject), or patch exceeds configured breadth | APPROVAL_REQUIRED within all hard boundaries; missing thresholds deny rather than assume ordinary scope |
| Admitted command matches configured executable + structured argv rule | ALLOWED, subject to task control, bounds, sandbox and applicable plan prerequisites |
| Command outside allowlist but within an explicitly supported constrained executor capability | APPROVAL_REQUIRED, still bounded/isolated; approval does not extend executor capabilities |
| Command cannot be classified/safely supported, uses shell chaining/evaluation or unconfigured interpreter execution | Deny (FORBIDDEN for known banned form, otherwise typed unsupported); never execute to discover risk |
| Ordinary bounded source patch within configured breadth and valid plan | ALLOWED; covered auth/authorization path alone adds no prompt |
| Other input | Typed unsupported denial; zero effects |

Source reads/list/search use the same trusted hard boundaries and task control in Tai's existing read guard. Tests are structured configured commands; read-only command views prevent subprocess source/test writes. Network is disabled for task containers; dependency approval cannot override the prepared-image/no-download runtime requirement.

## Command rules

Policies identify a resolved executable and structured argument grammar/exact permitted positions, permitted cwd and finite resource configuration. No shell-string interpolation, concatenation, eval, unrestricted scripts or heuristic splitting on spaces. For example, an explicitly configured pytest invocation can be supported while python -c or an alternate unconfigured module is denied; a familiar executable name alone grants nothing. Rules are compiled at startup and immutable by policy version, but action/repository/control facts are revalidated immediately before effects.

## Exact identity and anti-bypass

- Use canonical computeActionDigest on the validated action, including actionId. Preserve argv order and patch bytes. Validate lexical/canonical paths with the shared foundation rather than silently normalizing security-relevant forms.
- Execution bindings include repositoryId via trusted workspace metadata, working-tree/revision digest, policy identity/version and complete fix-plan fields when relevant. Git HEAD alone is insufficient.
- A separate transport submissionKey deduplicates identical pending creation; reuse with changed identity conflicts. Response keys and request versions prevent decision races.
- Persistent task rejection blocks every alternate action/tool/ID until an explicit direction; forbidden rules still apply after it. No claim that equal hashes capture all equivalent commands.
- Ordinary security-path edits covered by a valid plan do not request another patch approval solely for their path. Repository drift, changed strategy, dependency/deletion/breadth/config rules are concrete separate reasons.

## Finite profile contract

Required production inputs include per-operation read/transaction deadlines and bounded attempts; action/patch/argv/path/presentation/event byte/count bounds; configured patch file/line breadth; registered command capabilities; safe diagnostic/retention policy; and the shared execution/budget profile. Invalid/non-finite/unlimited required inputs deny affected work. Human waiting has no autoapprove/auto-resume deadline. There is no new latency SLA or benchmark default.

Explicit fixture profile `uc05-local-v1` proposes patch 8 files/400 added+deleted lines, 65,536 action bytes, 32 argv entries/4,096 bytes each, 8,192 presentation bytes per page, 1,024 event bytes, 3 pages/24,576 total inspectable bytes, 2,000 ms operation deadline and one mutation attempt. These are test vectors only, not production recommendations. Unknown fields, zero/negative/NaN/infinite values, over-budget artifacts and uninspectable protected contents are denial cases. Actual executor CPU/memory/process/network/token/cost limits remain explicit shared fixture/production inputs; this local profile cannot authorize real execution.

## Mapping to validation

T002 validates profiles, T005/T006 implement policy through test-first C01–C05/C18–C20/C22–C23 cases, and T020 proves real enforcement with external adapters. Unit classification does not establish filesystem isolation, command safety or provider admission.
