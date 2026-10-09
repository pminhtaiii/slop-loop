# Milestone 1 — Task lifecycle and result authority

Date: 2026-10-09 (Asia/Bangkok). Verdict: **READY FOR REVIEW — Milestone 1 source/contract scope only**.

Baseline branch: `feat/006-offline-verification-sandbox`.
Baseline and final HEAD: `934fc40e6ff000b4a802aa1b0522d64db0a5f93d`.
The local `origin/feat/006-offline-verification-sandbox` reference resolves to the same SHA.
Initial working tree was clean. Changes remain uncommitted; no branch switch,
merge, rebase, reset, cherry-pick, commit or push was performed.

## Audit confirmation and scope

| Finding | Baseline evidence | Remediation and acceptance limit |
| --- | --- | --- |
| F01 confirmed | `runner.ts` accepted `VERIFICATION_RESULT { passed: true }`, set `PASSED`, and allowed `EDIT_VERIFIED` | Typed in-memory completion receipts are issued only for complete reference checks, explicit execution/native metadata, matching task/attempt/workspace identities, consistent snapshot/image/preparation/profile/native identities, exact full-check targets, committed canonical results and confirmed cleanup. Receipt consumption and final completion recheck trusted freshness. Real coordinator/composition/capture remain later milestones. |
| F02 confirmed | `settleToolAttempt` released checkout ownership after stop without a resource-bound cleanup acknowledgement; slot settlement was an anonymous boolean/status | Outstanding resource holds retain checkout ownership and deny new admission. Exact task/resource/generation acknowledgements settle once. Slot-wide generations and settled-identity rejection prevent replay across runners and within an attempt. Trusted gateway/backend hooks register resources before container execution and acknowledge cleanup separately from tool output. Persistent records, staging ownership and restart/daemon reconciliation are not proved or completed here. |
| F10 confirmed | `DockerCliExecution` truncated before returning; the backend inferred overflow only from returned output length | Explicit `OUTPUT_LIMIT`, `TIMEOUT`, `CANCELLED` or `EXITED` and truncation metadata survive process close, including overflow plus AbortError and zero exit. Backend and coordinator deny passing execution when output overflow or termination/native failure is present. Real Docker overflow fixtures remain unavailable. |

No initial finding was disproved. Changes are limited to these three findings;
Phase 6 source, preparation, snapshot capture and durable recovery were not implemented.
Specifications/ADR/security requirements were not weakened.

## Changed interfaces

- `src/orchestration/task.ts` and `transitions.ts`: deterministic verification-attempt identity from task ID and a stored monotonic sequence when entering `VERIFYING`; current identity is invalidated on implementation/repair while the sequence is retained. Admission authority, rather than unpredictability of this ID, provides cross-task binding.
- `src/sandbox/verification.ts`: strict full completion evidence validation, unforgeable in-memory receipt registry, task/attempt binding, one-use consumption and freshness recheck at final completion. Canonical-result confirmation is an injected trusted application callback; repository/model output cannot supply it.
- `src/orchestration/runner.ts`: typed receipt event, pure reducer with explicit authenticated observations, stateful trusted ingress for receipt consumption/final freshness, resource cleanup holds, matching acknowledgements, monotonic generations, cancellation/terminal fencing, and zero-executor outcomes releasing only their attempt guard. Terminal failures remain visible while resource cleanup is uncertain.
- `src/tools/gateway.ts`: forwards the trusted cleanup tracker to the executor authority.
- `src/sandbox/docker.ts`: connects optional trusted resource tracking to container cleanup, cleans the registered identity rather than a mismatching result ID, preserves termination/truncation and prevents overflow PASS.
- `src/sandbox/dockerprocess.ts` and `types.ts`: explicit process termination/truncation and native-prelude evidence contracts. Startup/control failures still reject; execution termination returns bounded failure evidence.
- Tests: runner/authority/lifecycle/process/backend/coordinator regressions plus existing lifecycle fixtures migrated from booleans to complete source-only coordinator receipts. These fixtures are explicitly not real Docker evidence.

## RED → GREEN evidence

Each row records an observed failure before its corresponding behavior fix,
then the same test passing after the fix. Commands used `pnpm.cmd exec vitest run`.
Failures were assertions of the security behavior, not syntax/startup failures.

| Test selection | RED observation | GREEN observation |
| --- | --- | --- |
| `tests/orchestration/runner.test.ts -t 'bare success boolean'` | `ACCEPTED` instead of `ACTION_REJECTED` | Boolean rejected; no PASS/completion authority |
| `tests/orchestration/runner.test.ts -t 'matching resource cleanup'` | Checkout owner became null after cancellation settlement | Owner retained until all exact confirmations; wrong task/resource/generation and replay rejected |
| `tests/orchestration/runner.test.ts -t 'without an adapter'` | No hold after cancelled verification settlement | Unacknowledged verification attempt remains held |
| `tests/orchestration/runner.test.ts -t 'name is reused'` | Old callback returned true against a later runner's hold | Old callback returns false |
| `tests/orchestration/runner.test.ts -t 'recycle a settled'` | Settled identity could be registered again | Same-attempt identity reuse rejected |
| `tests/sandbox/dockerprocess.test.ts -t 'overflow\|combined stdout'` | Missing overflow metadata; AbortError rejected instead of preserving evidence | Explicit overflow, bounded UTF-8 prefix, zero-exit and AbortError evidence preserved |
| `tests/sandbox/docker.test.ts -t 'process-truncated'` | Zero-exit truncated result became PASS, `truncated: false` | FAIL with `OUTPUT_LIMIT`, `truncated: true` |
| `tests/sandbox/docker.test.ts -t 'without explicit termination'` | An adapter result omitting termination/truncation metadata became PASS | Mandatory typed process metadata; incomplete runtime result is FAIL |
| `tests/sandbox/docker.test.ts -t 'mismatching returned identity'` | Cleanup targeted the other result ID | Cleanup targets the registered owned identity |
| `tests/sandbox/verification.test.ts -t 'evidence reports output'` | Coordinator produced PASS for overflow metadata | Coordinator produces FAIL |
| `tests/orchestration/verification-authority.test.ts` selections | Missing exit/native metadata accepted; second receipt for consumed attempt accepted; native failure passed; drift after receipt acceptance completed | Malformed/partial/stale/cross-task/cross-attempt/serialized/replayed/targeted receipts rejected; failed native/termination evidence cannot PASS |
| Authority tests `-t 'ends policy failure\|records terminal failure'` | Cleanup guard swallowed terminal failure, leaving outcome undefined | Zero-executor policy failure releases guard; resource uncertainty retains owner while preserving terminal reason |

Additional regressions cover canonical result confirmation for every check,
multiple resources, late registration after stop, uncertain acknowledgements,
deadline exhaustion, cancellation, retry budgets and existing Ask/Edit behavior.

## Environment and verification

Observed local environment: Windows x64, Node `v24.14.0`, pnpm `12.5.1`,
TypeScript `5.9.3`, Vitest `3.2.7`. Existing native workspace addon was available
and exercised by the full source suite. No native source changed; native rebuild,
frozen installation and the two-platform Docker matrix belong to later milestones.

| Command | Observed outcome |
| --- | --- |
| `pnpm.cmd exec vitest run tests/orchestration tests/tools tests/policy tests/sandbox` | Initial related regression: 34 files, 390 PASS, 14 SKIPPED, 0 FAIL. Follow-up review fixes are covered by the final full suite below. |
| `pnpm.cmd test` (final run) | 49 files, **556 PASS, 31 SKIPPED, 0 FAIL**, 587 total; 27.41 seconds (reducer-determinism correction run). Includes existing Phase 0–4 source/native regressions and source-level sandbox journey tests. |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd typecheck` | PASS, including test TypeScript project |
| `pnpm.cmd format:check` | PASS; only intentionally modified TypeScript files were formatted |
| `pnpm.cmd build` | PASS in the reducer-determinism correction run. The original Milestone 1 run needed the already approved escalation after an initial EPERM; that failed attempt was not counted as PASS. |
| `pnpm.cmd smoke` | PASS against the rebuilt application |
| `git diff --check` | PASS |
| `docker version` | **UNAVAILABLE**: Docker command absent on PATH; integration fixture probe reports local daemon inaccessible |

The full-suite skips include **14 Docker-required fixtures** and **17 existing
platform/configuration-dependent fixtures**. Neither group is counted as PASS.
No Linux Engine or Windows Docker Desktop engine/storage identity, effective
limits, quota-exhaustion evidence or real Docker outcomes were obtained here.
T088 remains UNVERIFIED/UNAVAILABLE under its existing exception, unchanged.

The initial unqualified `pnpm exec ...` invocation unexpectedly performed
dependency synchronization rather than the requested test; it is not counted as
RED evidence. Subsequent commands explicitly used `pnpm.cmd`. No dependency,
lockfile, package-manager pin or tracked installation input was changed.

## Independent review and final convergence

Standards/security and specification reviews independently inspected the full
working diff against the baseline, including new test fixtures.

- Standards/security initially found zero-executor guard leaks and terminal
  failure suppression under cleanup holds. Both were reproduced RED, fixed and
  verified GREEN. Final rereview: **no remaining blocking findings**.
- Specification review found same-attempt acknowledgement replay after resource
  re-registration. It was reproduced RED, fixed and verified GREEN. Final
  rereview: **no remaining blocking findings in F01/F02/F10**.
- Self-review checked the full diff, scope, retained authority, finite output,
  cancellation/late effects, task/resource generations and acceptance mapping.
  No new model-visible tool, dependency or execution privilege was introduced.

T159–T161 describe **source/contract acceptance only**. T162 remains unchecked
for real/durable integration. T129 and T131 remain unchecked; historical checked
T103/T104/T118/T119/T123/T126/T130 do not establish new audited end-to-end
acceptance. Full re-review/gate synchronization remains required in Milestone 6.
Phase 5 is not closed. Stop here for developer review before any later milestone.


## Independent review findings A/B/C — follow-up evidence

The follow-up began with the existing Milestone 1 changes uncommitted on the
same branch and HEAD. No commit, push, staging, branch operation or Milestone 2
work was performed.

| Finding | Confirmation, fix and evidence |
| --- | --- |
| A — deterministic orchestrator | Confirmed: repeating the same admitted initial task and six trusted transition events produced unequal task states because `randomUUID()` differed. RED: `pnpm.cmd exec vitest run tests/orchestration/runner.e2e.test.ts -t 'same initial task and event sequence'` failed deep equality specifically on attempt IDs. GREEN: the same script now produces `deterministic-edit:verification:1` and equal complete results. A stored safe-integer sequence increments only on entering VERIFYING and survives repair; invalid/overflow sequences fail closed. Additional regressions prove a legal repair creates attempt 2 and independently admitted tasks with identical textual IDs cannot consume each other's receipts. Existing cross-attempt and one-use replay regressions remain passing. |
| B — verdict metadata consistency | Confirmed fail-closed gap, with no documented compatibility requirement for absent execution metadata. Consumer search found `verdict()` calls only in sandbox verification, contract and journey tests; there is no current production caller. RED: `pnpm.cmd exec vitest run tests/sandbox/verification.test.ts -t 'execution metadata'` produced four assertion failures, PASS rather than FAIL when exitCode, terminationReason, truncated or nativePrelude was absent. GREEN: all four return FAIL; passing aggregation requires explicit zero exit, EXITED, false truncation and PASS/NOT_REQUIRED native prelude. Valid diagnostic fixtures now supply explicit metadata. `issueCompletion()` was not weakened or changed for this fix. |
| C — untracked review completeness | All three requested new files exist and were read in full and included explicitly in both independent review axes. The authority suite has 20 passing tests; the support helper is exercised by lifecycle/runner tests and is explicitly labelled source-only. This evidence document records actual outcomes. All three remain untracked and nonignored; plain `git diff` does not include them. The delivery manifest below must accompany any later developer-authorized commit. |

Diagnostic `verdict()` still reports snapshot execution status separately from
freshness: a complete successful stale snapshot can report PASS + STALE.
This is intentional diagnostics, covered by its existing regression; it grants
no completion authority. `issueCompletion()` requires CURRENT, four full
reference checks and complete canonical/identity evidence. That A/B/C round tested transition identity determinism only. The subsequent
reducer-determinism correction below supersedes that limited conclusion and
now verifies repeated reduction of authenticated receipt and completion inputs.

Follow-up targeted command:
`pnpm.cmd exec vitest run tests/orchestration tests/sandbox/verification.test.ts tests/sandbox/contracts.test.ts tests/sandbox/verification.e2e.test.ts`
returned **127 PASS, 2 SKIPPED, 0 FAIL**, nine files. The two skips were Docker
UNAVAILABLE. The final full regression and all quality gates are recorded above.
An initial added repair test used an unsupported MODEL_PROPOSAL action, causing
an assertion failure; it was corrected to the existing trusted RETRY event.
That fixture error is not counted as a product RED observation.

### Delivery manifest for new files

These files must be included with the tracked Milestone 1 diff after developer
review; they have not been staged automatically:

- `tests/orchestration/verification-authority.test.ts`
- `tests/support/verification.ts`
- `specs/006-offline-verification-sandbox/milestone-1-evidence.md`

During the earlier A/B/C round, the separately present user-owned
`milestone-1.patch` was inspected read-only
and left unchanged (SHA-256
`0698f0524348c90e8f45c4b4b2cce51f3043d2933720048ed2f0b3f77aa7a2c8`).
It uses UTF-16 encoding, which `git apply --stat` rejects as no valid patch;
decoding it read-only shows the old randomUUID transition and omission of all
three new files above. It is a stale review artifact, not a complete delivery
of the current changes; do not use it alone for acceptance or a later commit.

Both follow-up independent review axes inspected `git diff HEAD` and explicitly
read the new source/test/evidence files. Specification/security review found
no remaining source/contract blocker in A/B/C. Standards review found zero documented-standard violations and no actionable
heuristic findings. Self-review verified identity derivation,
admission binding, retry preservation, strict metadata and complete file scope.

Verdict remains **READY FOR REVIEW — Milestone 1 source/contract only**.
Real Docker, durable cleanup/recovery and Phase 5 exit gates remain open;
T162, T129 and T131 remain unchecked. Developer review is required before
proceeding to another milestone.


## Reducer determinism — review correction

Finding confirmed against `coding-agent-context/context/architecture.md`:
"The orchestrator owns deterministic task state" and Phase 1 uses
"deterministic in-memory events and simulated time". No specified exception
permits the reducer to consume receipt authority or invoke live freshness
callbacks. The prior implementation violated this contract. The Phase 5
`contracts/sandbox.md` requirement that replayed/stale verdicts cannot authorize
success remains enforced at trusted runtime ingress.

### Observed RED and GREEN

- `pnpm.cmd exec vitest run tests/orchestration/verification-authority.test.ts -t 'same verification input'`:
  RED before implementation: the same task, receipt event and time yielded
  ACCEPTED/REVIEWING first, then ACTION_REJECTED/VERIFYING because receipt
  consumption mutated WeakMaps. GREEN after separating ingress: one immutable
  observation is acquired before reduction; repeated reduction with identical
  input task/event/time/observation gives equal complete results. A new runtime
  ingress attempt with the consumed receipt is still rejected.
- `pnpm.cmd exec vitest run tests/orchestration/verification-authority.test.ts -t 'different event time'`:
  RED before time binding: an observation acquired at time 1 was accepted at
  time 2. GREEN: observations bind the exact task input, event time, purpose
  and receipt, so reuse with a different time is rejected.

### Interface and security review

`observeTaskEvent()` is the stateful trusted ingress. It preflights the pure
reducer to reject ineligible states, invalid clocks and exhausted budgets
before consuming a receipt or taking a freshness observation.
`TaskRunner.process()` calls ingress only after terminal, stopping, tool-flight
and cleanup fences, then immediately reduces and stores the resulting task.

`runTaskEvent()` is now a pure transition. Its optional fourth argument is an
explicit immutable `TrustedVerificationObservation`. The reducer validates
its private runtime brand and fixed bindings, reads captured PASS/FAIL facts,
and never reads/mutates the receipt WeakMaps or invokes freshness callbacks.
The observation constructor requires a module-private key; plain objects,
serialization and prototype-only copies cannot forge its private brand.
Raw receipts alone are consistently rejected by pure reduction. COMPLETE in
Edit mode similarly requires a fresh, bound observation from runtime ingress.
`runModelProposal()` and `runTaskScript()` remain pure; scripted entries can
carry explicit observations and do not perform implicit receipt consumption.

Freshness is sampled at each new runtime completion proposal. Repeating a
previously observed pure transition has the same result even if the live
freshness callback changes; a new runner proposal rechecks freshness and
rejects drift. Pure replay computes state only and does not perform execution,
cleanup or completion side effects. The runner never accepts an external
observation as receipt authority; it creates its own observation from the raw
trusted receipt or current freshness after its fences.

Regression coverage also proves:

- No freshness callback calls occur during repeated receipt/completion reduction.
- Observations cannot transfer to a copied/cross-task input, another receipt,
  a changed failed-verification task or a different time.
- Pure rejection does not consume a receipt; in-flight and outstanding cleanup
  holds also reject without consuming it, allowing the legitimate event once
  the matching cleanup acknowledgement arrives.
- A runner reconstructed from the same admitted task within the same process
  rejects a previously consumed receipt and a second receipt for that attempt.
  This is in-process replay evidence, not durable process-restart recovery.
- Existing bare boolean, partial/serialized/stale/cross-task/cross-attempt
  verdict, retry, cleanup-generation and output-overflow regressions remain GREEN.

The test support module now explicitly exercises trusted ingress before pure
reduction for runtime authority cases. Reducer determinism tests import and
call the pure reducer separately. Existing lifecycle fixtures were migrated
without relaxing their behavior assertions or `issueCompletion()` validation.
Correction scope: runner and verification modules, test support, authority
suite, four affected orchestration fixture files and this evidence document.
No preparation, capture, production composition or durable recovery was added.

### Verification and limitations

- Related regression: `pnpm.cmd exec vitest run tests/orchestration tests/sandbox tests/tools tests/policy`:
  **412 PASS, 14 SKIPPED, 0 FAIL**, 34 files; all skips Docker UNAVAILABLE.
- Full source suite: `pnpm.cmd test`: **556 PASS, 31 SKIPPED, 0 FAIL**,
  49 files, 587 total; 27.41 seconds on the same Windows environment above.
- Lint initially found two unsafe-any arguments in the forged-observation test.
  They were corrected to explicit unknown values and an intentional invalid
  runtime-input type expectation, with no source or assertion behavior change.
  The authority suite was rerun afterwards: **26 PASS, 0 FAIL**. Typecheck and
  format check were rerun and PASS. Final `pnpm.cmd lint` rerun PASS (exit code 0).
- Build and rebuilt-application smoke PASS. `git diff --check` PASS; new files
  were additionally checked as readable UTF-8 without trailing whitespace.
- Standards and Spec independent rereviews inspected the full tracked diff
  plus untracked source/support/evidence files: **0 blocking findings on each
  axis**. Self-review checked determinism, trust authenticity, receipt one-use,
  freshness timing, budget eligibility, late/cleanup fences and scope.

The three files in the delivery manifest remain untracked and must accompany
any eventual developer-authorized commit. The earlier user-owned patch is
absent from the working tree at this correction's initial inspection; no patch
file was modified or deleted during this correction.

No real Docker PASS or durable restart recovery is claimed. Observations and
receipts are in-memory and deliberately cannot restore authority through
serialization. T162, T129 and T131 remain open; Phase 5 is not completed.
Verdict: **READY FOR REVIEW — Milestone 1 source/contract correction only**.
No staging, commit/push, branch operation or Milestone 2 work was performed.
