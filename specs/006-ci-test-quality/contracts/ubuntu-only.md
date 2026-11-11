# Ubuntu-only CI amendment

## Final cleanup and stable names — 2026-10-30 (Asia/Saigon)

The user explicitly approved the seven-check protection migration and then chose
to remove both redundant old jobs and OS suffixes from the remaining check names.
This final cleanup supersedes the staged source details below. It is a separately
reviewed batch updating PR #126; no merge is authorized.

The ci-v3 protection migration was applied and read back with all other settings
unchanged. Fresh exact-head runs on `fa5dee813ab31dc5eedcffb29db92541d478be31`
passed the shared seven-check evaluation after migration. Retained local evidence
is under `.agent-work/2026-10-30/ubuntu-only-ci/`; hosted source workflow attempts:
[contributor](https://github.com/pminhtaiii/slop-loop/actions/runs/40997729035/attempts/2)
and [runtime](https://github.com/pminhtaiii/slop-loop/actions/runs/40997729126/attempts/2).

- Remove the two legacy matrix jobs entirely, including their Ubuntu duplicates.
- Replace singleton canonical matrices with `runs-on: ubuntu-latest`. Job IDs
  produce bare `build`, `contributor-tooling-tests` and `runtime-tests` names;
  the other four names stay unchanged. Preserve all commands and artifact identity,
  using explicit Ubuntu artifact labels rather than the removed matrix expression.
- Add immutable ci-v4 with those seven bare names and activate it. Preserve all
  three earlier policy lists; historical ci-v3 remains exact merged-binding only.
- Update workflow/policy/consumer regressions, source protection mirror and current
  documentation. Do not mark original ci-v2 rollout tasks complete by inference.
- Keep live ci-v3 protection while publishing the renamed candidate. Its three
  absent suffixed requirements intentionally block merging during this transition.
  After all seven exact-head ci-v4 checks pass, replace required names with ci-v4,
  preserving all other settings. Read back and observe fresh exact-head checks.
  This sequence never admits a candidate using missing or failed checks.

Acceptance: the seven direct responsibilities still execute complete inventories;
no workflow declares a Windows runner, old duplicate job, or OS-qualified check;
artifact identity still binds repository/run/attempt/head/OS; all historical lists
and downgrade refusals remain tested. Run focused contracts, context refresh,
independent review and ordinary publication gates for this cleanup batch.

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
