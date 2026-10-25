# T022 typed receiver receipt handoff — approved amendment and historical proposal

Status: implemented and verified locally on 2026-10-25 (mock-only). The user-relayed shared-owner agreement and scoped approval are recorded in [decisions.md](decisions.md#t022-receiver-receipt-handoff-authorization); this is not a direct owner-message record. Final Standards R3 and Spec R3 report zero P0/P1/P2 findings against `.agent-work/2026-10-25/uc03-sol-corrections/effects-merger/review-snapshot.json` (SHA-256 `66bc2c1788eec6e45cc12fccf07326eaa0c63d1123c5ad70ca7463703e6d9586`; HEAD `c058ef1d4d3ce46cd4788c8d7f257b9e6b2bf732` plus the uncommitted candidate), verified 30/30 unchanged before documentation edits. Reports: `.agent-work/2026-10-25/uc03-sol-corrections/reviews/final-standards-r3.md` and `final-spec-r3.md`. The original investigation below is retained as historical proposal context; its pre-implementation failures and proposed scope are not current blockers.

## Historical recommendation and evidence

Use the existing receiver-owned admission/settlement seam, but amend its v0.2 return type to carry the exact records it already holds. There is no correct implementation confined to the two T022-owned files under the current canonical type.

`ports-v02.ts:363` defines UC-04's AttemptReceiptV02; `StatePortV02.beginAttempt` returns it at line 426. `RepositoryPortV02.applyPatch/runCommand` at lines 439–446 erase that identity, returning only effect data. StatePortV02 has no public read-only exact attempt lookup. `ExecutionGuardResultV02.attemptId` is optional, but optionality does not satisfy the existing exact-identity acceptance assertion.

The real seam exists internally: `beginRepositoryAttemptWithClaim` in `src/foundation/repository-receiver.ts` validates the returned claim and attempt, preserving the exact pair. Command execution constructs its outcome, and `RepositoryOutcomeRecoveryV02.record` returns a validated OutcomeRecordResultV02. Patch execution does the same in `repository-outcome.ts:193–204`. Both only return ordinary observed results after `settled`; their public facades discard the receipt records. `FakeRepositoryPort` similarly retains local claim/attempt/outcome variables but returns only effect data and currently discards the recordOutcome response. Its `v02Calls` log is diagnostic history, not authority.

The original R1 reviews required an agreed typed owner handoff: `uc03-per-task/reviews/final-standards-r1.md` STD-002 and `final-spec-r1.md` SPEC-001. The correction handoff reports 23/24 current guard tests, with exact identity still failing; that is reported historical evidence, not a fresh test result here.

Rejected alternatives: inspecting private/mock history; treating an extra uncontracted attemptId as authoritative; synthesizing identity; calling claim/beginAttempt from the guard again; wrapping StatePort to capture the last call; adding a new lookup/recovery journal; weakening the exact identity assertion. The first five violate ownership or binding; the others expand scope unnecessarily.

## Approved exact canonical type diff

In `src/contracts/foundation/uc03/ports-v02.ts`, import RepositoryActionOutcomeReceiptV02 alongside the existing receipt imports, then:

```diff
+/** Exact receiver handoff, issued only after an observed outcome is settled. */
+export interface RepositoryExecutionReceiptV02 {
+  readonly claim: ClaimReceiptV02;
+  readonly attempt: AttemptReceiptV02;
+  readonly outcome: RepositoryActionOutcomeReceiptV02;
+  readonly settlement: OutcomeRecordResultV02 & { readonly outcome: 'settled' };
+}
+
+export type RepositoryPatchResultV02 = {
+  readonly applied: boolean;
+  readonly newRevisionDigest: string;
+  readonly executionReceipt: RepositoryExecutionReceiptV02;
+};
+
+export type RepositoryCommandResultV02 = {
+  readonly exitCode: number;
+  readonly stdout: string;
+  readonly stderr: string;
+  readonly executionReceipt: RepositoryExecutionReceiptV02;
+};

 export interface RepositoryPortV02 extends PortIdentity {
   // read methods unchanged
   applyPatch(
     patch: ApplyPatchAction,
     context: RepositoryAdmissionContextV02
-  ): Promise<{ readonly applied: boolean; readonly newRevisionDigest: string }>;
+  ): Promise<RepositoryPatchResultV02>;
   runCommand(
     action: RunCommandAction,
     context: RepositoryAdmissionContextV02
-  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
+  ): Promise<RepositoryCommandResultV02>;
```

No StatePort, ApprovalPort, provider port, v0.1 port, or ExecutionGuardResultV02 signature changes. Existing barrel `src/contracts/foundation/uc03.ts` already exports ports-v02.ts. This is a required field, never an optional success fallback. Keep raw output in the result only; journal receipts continue using safe references/digests.

Keep runTests' public CheckResult unchanged: it lowers to the same receipted command path, checks settlement and maps the result to CheckResult as today. It must not consume a second attempt. No successor investigation/verification migration is part of this correction.

The result's old fields remain at their current locations. Dual v0.1/v0.2 concrete classes need explicit overloads: the context-bearing overload returns the required v0.2 result; the no-context signature retains the existing v0.1 return type and current fail-closed behavior. Do not modify ports.ts or make the required receipt optional to make implements clauses compile.

## Ownership and binding

UC-04 alone creates claim/attempt identities and returns settlement acknowledgments. The trusted repository receiver forwards those exact records and the exact outcome it submitted, without minting another identity or recording again. UC-05's policy/approval authority is unchanged. Guard only validates the handoff and projects `executionReceipt.attempt.attemptId`; it never reserves, begins, settles, recovers or invokes again.

Required validation before reporting guard success:

1. Validate the bundle as unknown input. Validate the claim against the independently validated admission using existing `validateRepositoryClaimV02`; validate the attempt with `validateAttemptReceiptV02` and match its ancestry, epoch and version progression to that claim. Match all executor identity fields between attempt and outcome, including the exact admitted payload digest. The authenticated receiver remains responsible for validating actual configured actor/incarnation/fence; the guard must not treat receipt self-consistency as independent proof of issuer authenticity.
2. Match outcome claimId/claimDigest/attemptId, executor, admission digest, action digest, subjectKind, operation and plan applicability; match branch-specific policy/decision/plan or diagnostic fields, reservations, and every version binding. Verify canonical receipt digest and allowed keys. Wrong task/run, branch, payload, policy or ancestry must fail closed.
3. Require outcome `observed`, settlement `settled`, and settlement.receiptId equal to the exact outcome.receiptId. For patch, require applied=true and the returned revision equal to observedResultRevisionDigest. For command, require valid bounded command data; nonzero exit remains an observed command result, not successful task verification. Bind command output to the existing resultRef digest using the producer's existing normalization/digest algorithm, not a new algorithm.
4. On valid success, return existing effect result plus the exact owner-issued attemptId. Missing/malformed/mismatched bundle must never yield success or an invented ID. Since the receiver has already been called, malformed returned evidence means uncertain-effect/recovery required, not proof of zero dispatch. Do not invoke again.

Reuse existing producer-side `validateRepositoryActionOutcomeReceiptV02` before StatePort recording. Its validation context explicitly requires current durable records/status. Do NOT call it from the guard with invented `currentClaimStatus: attempting` or stale pre-settlement versions: settled is already past that validation phase. Add a small handoff validator for post-settlement shape/digest/binding checks in `attempt-v02.ts`, reusing pure comparisons/digest helpers where applicable. It validates a trusted receiver handoff, not an independent durable lookup. Do not weaken the existing current-journal validator or claim it authenticates a forged receiver.

## Failure, uncertainty and settlement

This proposal changes fulfilled v0.2 results only, preserving the receiver's existing rejection/recovery protocol:

- Pre-admission/pre-attempt refusal: no successful result or fabricated attempt receipt. Existing fenced closeUnattemptedClaim handling remains with the receiver. Guard-local refusal before calling the receiver remains denied with zero effects.
- Known failed/partial patch: no fulfilled successful patch result; retain the consumed repair allowance and the exact uncertain/outcome evidence through the existing receiver recovery handoff. No refund/reapply. Do not manufacture observed revision evidence.
- Command nonzero exit: when observed and settled, return its exact receipt and exit code; verification decides pass/fail. Timeout/lost/malformed observation is not an observed success.
- Observed-unsettled, already-recorded or uncertain record result: no settled success bundle. Preserve pending receipt, claim, accounting, lease and recovery path. In particular already-recorded never implies settlement.
- recordOutcome throw/lost response, or ambiguous beginAttempt response: no claimed successful identity at the guard; keep existing owner recovery and fencing. Unknown receiver exceptions after invocation are conservatively uncertain-effect, without parsing error messages into permission to retry. Any old timeout test that assumes a generic exception proves non-dispatch must be corrected without weakening exact success identity.
- This correction does not expose pending receipts as successful handoffs, add recovery methods, close claims, change holds or add receipt replay execution. Existing exact-predecessor observed/uncertain recovery remains intact.

## Historical proposed implementation scope

Mandatory source/type paths:

- `src/contracts/foundation/uc03/ports-v02.ts`: required types above.
- `src/contracts/foundation/uc03/attempt-v02.ts`: post-settlement handoff validator; existing validators retain semantics. If shared pure helpers need exporting, restrict to `admission-v02/attempt-outcome-common-v02.ts` rather than creating another validation framework.
- `src/foundation/repository-receiver.ts`: retain exact command claim/attempt/outcome/record response through executeAdmittedCommand and public runCommand; runTests maps the command result without losing admission/settlement checks.
- `src/foundation/repository-outcome.ts`: return bundle only from the existing observed/settled branch.
- `src/foundation/repository-tools.ts`: typed overloads and transparent forwarding.
- `src/foundation/execution-guard.ts`: validate returned handoff; project exact attemptId; conservatively handle unverified receiver responses/errors.
- `tests/runtime/support/uc03/fake-repository.ts`: context-bearing overloads; return local exact records, retain and validate recordOutcome result, refuse receipt-free v0.2 success; FakeRepositoryPortV02 forwards exact results. Preserve no-context test-only behavior and zero-effect denial checks. No log scraping.

Mandatory tests/callers to migrate:

- `tests/runtime/contract/atomic-admission.test.ts`: validator vectors.
- `tests/runtime/contract/execution-guard.test.ts`: public forwarding wrapper (defined in this file), exact-identity assertion retained, patch and command positives; missing/tampered/cross-branch records, foreign attempts, revisions and settlement statuses; no second claim/begin/record/invoke.
- `tests/runtime/unit/repository-tools.test.ts`: exact receiver handoff, patch/command/runTests normalization, unchanged pending/lease recovery assertions.
- `tests/runtime/support/uc03/provider-mocks.test.ts` and `tests/runtime/contract/uc03-port-conformance.test.ts`: receipt-forwarding results and negative admissions; no fake successful data on refusal.

Inspect compile fallout in `tests/runtime/unit/uc03-repair.test.ts` (public forwarding result annotations/test expectations) and `tests/runtime/support/uc03/port-fixtures.ts` (composition). Change only actual receipt forwarding/type expectations if needed; the latter has no direct applyPatch/runCommand implementation. Existing repair consumers use unknown guard result data, so no repair.ts/repair-types.ts production edit is proposed. Do not extend T061 accounting acceptance, UC-05 mocks, provider ingress, cutover, matrix or real adapters.

Checks after implementation: typecheck, build, scoped lint, source/emitted focused suites above; retain the existing missing-context/unavailable-state zero-effects checks. Test forged/missing receipt after simulated dispatch returns uncertainty with one invocation and no retry. Check settlement failure/response loss preserves pending owner state. No full acceptance or real/restart claim from these tests. Coordinator assigns shared files explicitly before work; the original two-path T022 worker cannot silently take them.

## Historical authority analysis

Explicit: `spec.md:112` says **"Shared contract proposals require owner agreement; mocks may then support early work."** This applies directly to changing required RepositoryPortV02 return shapes. `contracts/decisions.md`, Shared Ownership and Responsibilities, assigns Tai canonical/shared foundation and receivers; UC-04 owns state/settlement/recovery and UC-05 policy/approval. Amendment section 5 says only the designated effect adapter gate may call beginAttempt, and section 7/plan Authority and invocation ownership prohibit duplicate consumption by guard/executor.

Explicit: `contracts/decisions.md`, Atomic Admission Amendment Approval and Task Preparation, says **"Canonical implementation release remains a separate scoped step after task decomposition and planning review"**. The later release entries are scope-specific, not blanket authority. Some older amendment/plan release prose is stale relative to local task progress and the final reviews' released-T022 scope; do not use it to deny the already authorized guard correction, or use progress to release new shared paths.

Explicit: plan Versioned migration requires v0.1 source compatibility and additive v0.2 contracts. `context/planning.md` requires automated planning validation and two independent reviews before declaring planning complete/starting implementation; it says that quality gate does not grant implementation authorization. This artifact is a proposal, not a passed planning gate. This brief expressly prohibits delegation, so no review subagents were dispatched.

Interpretation: forwarding existing records preserves the accepted protocol, so no new atomic-admission lifecycle design or new UC-05 authority method is needed. Nevertheless, required return-type migration is a shared contract proposal under spec.md:112, not a routine edit confined to guard internals. Record owner agreement and scoped implementation permission before adopting it. This is narrower than demanding fresh three-owner protocol negotiation: there is no identified policy-semantic change, but existing owner agreement must not be fabricated or assumed to cover an unreviewed type diff.

At the original investigation checkpoint, authority covered this proposal only. The later recorded user approval and relayed owner agreement released the exact handoff implementation; changed admission/settlement/ownership semantics still require re-evaluation.

The original coordinator approval question was answered by the user and recorded in decisions.md. It is no longer pending; successor and real-adapter gates remain separate.

## Historical investigation limits

Read the feature spec/plan/task ledger/decisions/amendment, actual port/receiver/facade/mocks, receipt validators, current guard, correction handoff and both final reviews. This was static investigation; no tests, typecheck/build, new independent review, commit, remote operation, worktree or delegation. Existing dirty tracked files were not edited. At that historical checkpoint, proposal review and implementation verification were still required and exact-identity acceptance was blocked. The implemented scope and final R3 evidence below supersede that blocker.

## Implemented scope and verification

The required v0.2 receiver handoff forwards exact UC-04 claim/attempt/outcome/settled records. The guard validates post-settlement identity, digest, admission and effects, projects the exact owner attempt ID, and never repeats claim/begin/record/consume or retries. Approved patches require Patch -> Verify; commands/diagnostics preserve task state and handoffs carry empty named invalidations. Missing context or unavailable authoritative state fails closed before dispatch. Invalid returned evidence or unknown exceptions after dispatch yield uncertain-effect without invented identity. Repair requires supplied authority and leaves reservation, consumption, settlement and revision/Verify accounting with the receiver/UC-04 journal; failed/partial and observed-unsettled paths retain one consumed allowance, pending evidence and lease for exact recovery without refund or reapply. UC-05 mocks transparently forward journal operations and exact owner responses rather than minting authority.

T022 implementation covers the source/type paths and mandatory tests listed above, including the shared pure helper in `src/contracts/foundation/uc03/admission-v02/attempt-outcome-common-v02.ts`. The bounded effect correction additionally owns `tests/runtime/support/uc03/state-fixtures.ts` and `tests/runtime/contract/atomic-admission-mocks.test.ts`: the default handoff fixture matches the receiver’s empty named invalidations, while three direct owner-journal tests explicitly retain their original named invalidation inputs and assertions. The repair wrapper migration and accounting regressions remain under existing T061 ownership (`src/uc03/repair.ts`, `src/uc03/repair-types.ts`, `tests/runtime/unit/uc03-repair.test.ts`); UC-05 forwarding corrections remain T058. No task IDs or policy authority are added. The approved required type and ownership/settlement semantics above remain intact. Command wrappers forward complete observation metadata so the existing resultRef digest can be validated; runTests retains CheckResult and uses one receipted command attempt.

Final effect-focused source/emitted checks pass 413/413 each and the independent effect reproducer passes 6/6; exact commands/exits are in `.agent-work/2026-10-25/uc03-sol-corrections/effects-merger/replay-results.json`. Typecheck, build and scoped lint exit 0 in `.agent-work/2026-10-25/uc03-sol-corrections/t022-effects/checks.json`. The earlier broader repair/receiver source/emitted selection passed 470/470 each (`.agent-work/2026-10-25/uc03-sol-corrections/t061-finish/checks.json`); it is separate historical evidence, not the final 413-test selection. T062–T066 remain unchecked; this stopping point does not release successor work. No current full runtime/contributor suite, publication or CI pass is claimed. Real adapters, production configuration, durable persistence, actual containment/restart, full Phase 5 acceptance and Phase 6 remain gated.
