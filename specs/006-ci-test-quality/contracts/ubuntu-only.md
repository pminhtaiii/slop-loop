# Ubuntu-only CI amendment

## Scope and authorization

On 2026-10-30 (Asia/Saigon), the user selected Ubuntu-only CI. This supersedes
the dual-platform requirement in spec FR-001, SC-002, plan target platform and
the CI-check contract for this bounded replacement. All responsibilities and
complete test inventories remain; real Windows verification is deliberately
retired. Other feature tasks and runtime gates are unchanged.

## Implementation plan

- Add immutable `ci-v3`: static-lint, static-types, repository-policy, pr-metadata,
  build (ubuntu-latest), contributor-tooling-tests (ubuntu-latest), runtime-tests
  (ubuntu-latest). Activate it in the shared policy; preserve ci-v1/ci-v2 lists.
- Limit the three canonical build/test matrices to Ubuntu. Retain matrix-qualified
  names and run/attempt/head/OS artifact identity, complete selectors and all
  existing validators. Keep the four legacy transition checks unchanged for now.
- Historical ci-v2 is accepted only for an exact audited merged identity, through
  the existing binding mechanism. New/open revisions always require ci-v3.
- Update workflow/policy/consumer regressions and current workflow/context prose.
  Historical evidence remains labelled with its original policy.

## Rollout and external gate

Read-only observation on 2026-10-30: development protection still requires
contributor-checks (ubuntu-latest) and contributor-checks (windows-latest), both
app ID 15368, strict=true and admin enforcement enabled. No settings were changed.

Publish the replacement with legacy jobs retained. After exact-head ci-v3 checks
pass, present a concrete operator change replacing the required names with all
seven ci-v3 names, preserving other protection settings. Obtain explicit operator
authorization before that write. Read back the change and verify a fresh candidate
before separately removing both legacy matrix jobs. Until then the pipeline is
staged for Ubuntu-only and still runs legacy Windows compatibility jobs.

## Acceptance

- Workflow contracts prove all seven names execute their existing commands, only
  Ubuntu runs the canonical jobs, and legacy requirements still have counterparts.
- Policy tests preserve both old lists and enforce immutable exact-head, trusted
  app, latest-rerun, completed-success rules for the new list.
- Historical ci-v2 bindings admit only exact merged identities; open/unbound
  revisions cannot downgrade to either historical policy.
- Focused consumer suites verify readiness, eligibility and paired completion.
- Context consistency, integrated review and ordinary contributor publication
  gates pass. Local source acceptance is distinct from hosted CI and live rollout.

## Task

Bounded maintenance task `ubuntu-only-ci` implements the source stage above.
Remote migration and legacy cleanup remain external follow-up gates; no original
task is marked complete by this amendment.
