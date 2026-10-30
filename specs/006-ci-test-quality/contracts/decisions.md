# Scope and Authorization

## Ubuntu-only replacement — 2026-10-30 (Asia/Saigon)

The user requested CI consolidation and selected Ubuntu-only CI. The bounded
[Ubuntu-only amendment](ubuntu-only.md) supersedes the earlier requirement to
retain both OS lanes. Source implementation and ordinary contributor publication
are released after independent targeted design review. Live protection changes,
legacy-job removal before verified migration, and merges remain gated.

Targeted design gate: automated planning validation passed; independent standards/architecture and testability reviews found zero P0/P1 issues against the amendment. This releases its source stage only.

## Confirmed direction — 2026-10-28 (Asia/Saigon)

The user selected Stryker, requested an initial telemetry experiment, and agreed to separate named CI responsibilities while retaining both OS behavioral lanes. Subsequent answers explicitly withdrew pre-PR mutation enforcement, selected direct required jobs with a shared names list, allowed only `.env.example` as an environment example, and chose a manual/report-only mutation CI pilot. The user then requested the planning workflow and specifications for CI changes and mutation-guided test improvements.

This authorizes creation, refinement and independent review of these planning artifacts. It does **not** authorize implementation, live branch-protection changes, publication to the default branch, a pre-PR hook, a numeric mutation gate, automatic merging or broader runtime work. Existing scoped contributor authority is unchanged; no merge is authorized here.

## Planning choices proposed for approval

The associated contracts define ten directly required new check names, a staged remote rollout, an explicit historical merged-head policy, a pinned secret scanner, strict placeholder examples and a whole-module manual telemetry profile. They are implementation proposals derived from the agreed direction, not observed deployed capabilities. Sharding is deferred until measured evidence supports another scope.

**Do not chase every survivor or force a 100% mutation score.** Meaningful behavior-changing survivors get assertions. Equivalent/redundant changes get specific explanations. Harness problems get calibrated separately. Unreviewed or unresolved survivors remain visible.

The original experiment is retained locally at `.agent-work/2026-10-28/mutation-ci-trial/observations.md`. Its final excerpt baseline is 222 mutants: 136 killed, 85 survived and one timeout, 61.71%. The earlier 66.67% run was inflated by timing noise. The exact-limit assertion exists only in the disposable pilot. None of these results establishes whole-module, whole-repository or production-runtime quality.

## Implementation authorization — 2026-10-29 (Asia/Bangkok)

The user explicitly asked for the remaining implementation phases of this feature to be implemented, and
for the already-implemented Phase 1–3 work to be marked complete. This is the gate-2 user approval for a
bounded implementation batch:

- Released: T007–T019 (Phases 4–6 and the documentation/integration task) as local source, test and
  workflow-file changes, including the single reviewed `ci-v2` activation in `scripts/ci/required-checks.mjs`.
- Not released: T020, T021, T023 and therefore T022/T024 dependants require live observation, an
  explicitly authorized operator protection change, or default-branch promotion. They remain unchecked.
- Not released by this approval: any remote setting change, any default-branch push or promotion, any
  merge, a pre-PR hook, a numeric mutation gate, automatic mutation on PR/push, or broader runtime work.

Stage A1 (T001–T006) was implemented and its leaves merged into PR #122 evidence rows; those rows are
local-gate evidence only. Marking a task complete records implemented source and exercised local
behavior; it does not assert a live CI or remote-protection observation.

The 2026-10-29 review-and-repair batch on the same branch falls inside this authorization. Every repair
was a behaviour-preserving correction to a file already owned by T007–T019 (`check-tracked-files.mjs`,
`check-env-examples.mjs`, `scan-secrets.mjs`, `pr-conventions.mjs`, `pr-metadata.yml`, `run-mutation.mjs`,
`tests/runtime/unit/telemetry.test.ts` and their tests and contract prose); none added a required check,
a live setting, a mutation gate or a new scope, so no separate decision is needed. Its evidence is
local-gate only and is recorded in `tasks.md` T019 and the `ci-rollout.md` evidence log.

The second review-and-repair round on the same day also falls inside this authorization, on the same
terms. Its one behavioural change is in `scripts/agents/pr-conventions.mjs`, which `T007` already owns:
the description contract now ignores a review bot's generated block, identified by its own comment
markers, so a machine-appended summary cannot fail the required `pr-metadata` lane. The three canonical
sections and every refusal rule are unchanged; only the bot's own block is exempt, and a human adding a
fourth section or writing the same heading without the markers is still refused. The remaining repairs
are corrections to `scan-secrets.mjs`, `quickstart.md` and `tests/ci/workflow-contracts.test.mjs`. No
required check, live setting, mutation gate or scope was added, and no remote fact was observed.

## Gates

1. Automated planning validation plus current-artifact independent standards/architecture and testability reviews with no unresolved P0/P1 findings.
2. Separate user approval releasing a bounded implementation batch; unchecked tasks do not establish approval.
3. Ordinary contributor review/publication and exact-head CI evidence for implemented changes.
4. Explicit authorization and read-back evidence before changing live branch requirements or promoting workflow files to the default branch. Remove transitional jobs only after the replacement requirements are observed.

Planning-gate results are recorded after review; absence of a result is not a pass.

## Planning quality gate — 2026-10-28 (Asia/Saigon)

Automated artifact/task-DAG validation passed. Independent R1 reviews identified activation-frontier, candidate-tree secret coverage, transitional inventory-count and PR head/merge identity gaps; the correction batch also clarified context ownership and mutation-report terminality. Both independent R2 axes found no blocking issues, and their separate strict-format verdicts each passed the repository review evaluator with zero P0/P1/P2 findings. The coordinator passes the planning quality gate for this bounded design.

Reviewed design identity and detailed evidence are retained locally at `.agent-work/2026-10-28/mutation-ci-trial/ci-planning-r2-snapshot.json`, with the standards/testability R2 reports and verdicts alongside it. The 22 declared design/governance inputs verified unchanged before/after the reviews. Subsequent changes to this decision footer, the spec status and the checklist record the gate result only; they add no implementation authorization or requirements.

This is artifact readiness for implementation approval, not approval to implement any task or perform live rollout. All 24 tasks remain unchecked. Proposed technical choices and external gates retain the scope above.
