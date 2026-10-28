# Technical Research

## Observed baseline

At planning start the checkout is `6d823b152ed72e2b7ef0335f7e1e53d8bb120ee2`. Existing contributor/runtime workflows bundle multiple checks and duplicate lint. Existing selectors cover 58 runtime test files and 41 helper test files at the earlier trial snapshot; implementation must discover the current inventories rather than hard-code these counts.

The prior local trial in `.agent-work/2026-10-28/mutation-ci-trial/observations.md` exercised an excerpt, not the whole telemetry module. Calibration changed 30 timeouts to one and the reported score from 66.67% to 61.71%. A pilot-only exact-limit test killed the known surviving comparison. This supports scoped mutation work and conservative reporting, not a merge threshold.

## Decisions and alternatives

| Decision | Rationale | Alternatives considered |
| --- | --- | --- |
| One feature, four independent stories, bounded delivery batches | CI behavior and test evidence share quality goals while allowing small reviewable increments | Separate unrelated specs would duplicate check-policy/mutation authority |
| Ten direct required names and a pure shared module | Matches user preference and prevents drift across three consumers | Aggregate required gate rejected by user |
| Responsibility/OS split first, timing evidence before numerical shards | Preserves complete inventories without speculative balancing | Immediate arbitrary shard counts add omission and drift risk |
| Exact historical merged-head bindings | Paired-issue completion consumes old immutable heads that can never emit new names | Unconditional name replacement strands old tickets; old-or-new fallback weakens new heads |
| Two-step preparation/activation, then temporary old jobs until protection read-back | ci-v1 remains sole current policy until every ci-v2 counterpart exists; existing live protection still needs old names | Activating absent jobs blocks publication; removing old jobs first risks blocked or weakened protection |
| Read-only pull_request metadata workflow plus fresh live validation | Covers edited bodies without privileged candidate execution or stale same-head acceptance | Target-event candidate execution and CI-only cached metadata rejected |
| Strict placeholder examples plus pinned Gitleaks full-tree and range scans | Complete candidate-tree scanning covers unchanged secrets; an additional range covers added-then-deleted secrets | Range-only misses unchanged candidate credentials; filename-only admission misses secrets |
| Pinned Stryker command runner with direct TypeScript tests | Matches exercised Node 24 source execution and existing test runner | Framework migration/custom plugin deferred; stale emitted tests rejected |
| Whole-module named manual profile, no automatic event or score gate | Makes selection maintainable without fragile fixed source-line ownership | Automatically mutating every PR or asserting full-suite adequacy exceeds agreed scope |
| Selected survivor dispositions and exact-mutant witnesses | Preserves meaningful assertions and explains equivalence | Forcing 100% encourages brittle tests and unjustified exclusions |

## Live inspection and rollout facts

Read-only inspection on 2026-10-28 found development protection requiring only contributor-checks Ubuntu/Windows, bound to GitHub Actions app ID 15368, strict:true and admin enforcement. No rulesets or open public PRs were returned. Treat these as point-in-time observations and reobserve before rollout. No remote state was changed. Retained historical identities still need implementation-time inventory; no fabricated exception rows are planned.

An identity follow-up inspected [public PR117](https://github.com/pminhtaiii/slop-loop/pull/117) and its [contributor job](https://github.com/pminhtaiii/slop-loop/actions/runs/40675219354/job/122771778714): native checks/run associate with H=`2bc7c9fe8547b21fa54a757b586322640e3460e8`, but the default checkout log reports synthetic M=`31a362a7cad13d063d212fbe31129706a913c476` with B=`f72cd5327c06a00f70cddafd05183b8958111fb2`. Thus native exact-H association is supported, but it is not executed-source proof. The proposal explicitly checks out/verifies H and records B/M separately; artifacts include run_attempt because reruns retain run ID. Strict up-to-date protection remains necessary before merge. This observation does not establish implementation of the new manifest logic.

The constitution file is an unfilled template, not ratified policy. No extension hook configuration is present. Resolve Spec Kit templates through the repository helper; preserve the existing branch. The optional agent-context extension executable is absent, so update only the existing managed AGENTS block manually without replacing other feature entries.

## Primary references

- [Stryker configuration](https://stryker-mutator.io/docs/stryker-js/configuration/) supports command/build options; the installed pilot demonstrated command-runner limits.
- [Stryker outcomes](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/) defines detected as killed plus timeout and explains score denominators.
- [Stryker incremental limitations](https://stryker-mutator.io/docs/stryker-js/incremental/) documents command-runner test-reporting limitations; reuse is disabled here.
- [Reference CI](https://github.com/morluto/rea/blob/main/.github/workflows/ci.yml) separates static/build/test/report responsibilities; its dry-run mutation preflight is not full mutation evidence.
- [GitHub event semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) covers edited PR events and default-branch requirements for manual dispatch.
- [Gitleaks v8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1) is the inspected pinned CLI release; use its checksums and redacted output, not an unpinned latest installer.

All design choices needed for this bounded plan are specified. Future live protection/manifest identities and observed CI results are rollout evidence, not unresolved architecture or permission to execute rollout.
