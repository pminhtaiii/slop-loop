# Proposed Contract: uc03-host-composition/2

Status: planning proposal, 2026-11-04, amended 2026-11-07 by sections 8 and 9. This supplements [runtime-evaluation/1](integration.md) for US1/FR-013–018. Sections 1–7 record no canonical change and no owner signoff; T019 requires exact owner acceptance before implementation of the supplemental authority. Production uses explicit v0.2 consumers; legacy test compatibility cannot confer authority. The T019 acceptance and the T020–T034 source/controlled-tier release are recorded in [decisions](decisions.md); that release covers no real tier and no owner delivery, so this proposal's real-tier prerequisites still block production composition.

Sections 8–9 are the two amendments agreed on 2026-11-07. They close the T026 clarification gap and the T025 isolation contradiction, and they are the only places this contract adds to canonical v0.1 state or changes a published seam. Both stay source/controlled-tier and release no owner delivery, real execution or merge.

## 1. Inputs, readiness and ownership

`prepareUC03Host(trustedInputs) -> ready({ports, config, identity}) | unavailable({reasons})` is the proposed host-only API. It is not callable with BugTask JSON or model-produced configuration. Inputs include operator-resolved profile/catalog/config/pricing identities, pinned component revisions/contracts/conformance evidence, accepted owner ports and identity/admission resolvers, Foundation transport/controller/filesystem options, finite bounds and protected artifact configuration. Credentials remain inside the existing provider boundary and are absent from outputs/digests/logs.

Readiness enumerates state/accounting/control, approval presentation/decision/continuation, baseline evidence write/read, trusted snapshot, read mediation, provider admission/transport, repository/guard/view lifecycle, reviewer and grader. Missing, ambiguous, stale, mismatched or test-only delivery yields bounded component/reason codes and no affected execution. Production admission checks full callable capability and pinned conformance/profile bindings, not only `provenance: real` or function names. Controlled readiness explicitly remains controlled; it cannot issue the evaluator's real capability receipt.

Assembly/preflight may read trusted configuration/owner observations; it creates no task, claim, reservation, workspace/container, provider call, command, patch or approval/control mutation. Existing service lifecycle owns experiment/task allocation and cleanup after execution admission. A ready assembly is not G-OWNERS or proof of real execution.

Two stages avoid needing a task before allocating it: static assembly validates profile, deliveries and resolver capabilities; after existing service allocation, task binding resolves current task/run/workspace facts before the graph can advance state or invoke tools/model. A binding failure retains the allocated task as blocked and uses existing safe cleanup; it neither dispatches nor conceals the lifecycle allocation. `ready` at the first stage means assembly-ready only, not task-specific execution authority.

| Capability | Accountable owner | Host responsibility |
|---|---|---|
| task/control/journal, baseline persistence, replan transaction | UC-04 / Thanh Tan | Consume accepted public capabilities; validate acknowledgements and freshness |
| policy/decision/presentation/control, current admission | UC-05 / Trong Tan | Observe facts and forward explicit operator choices; preserve owner decisions |
| read mediation, repository snapshot, action observation, controller/model/reviewer, bootstrap | Tai | Build scoped producers/consumers after release; enforce current owner authority |
| exact isolation/profile/route evidence | Existing named gates | Check identities and availability; report unavailable evidence honestly |

## 2. Versioned production consumers and accounting

`UC03GraphPortsV02` uses `StatePortV02`, `RepositoryPortV02`, `ModelPortV02`, current approval/reviewer/guard capability and the supplements below. Its production baseline capability requires both write and lookup, despite lookup being optional on the legacy interface. A separate production entry receives that type explicitly. The old graph/CLI API remains available for controlled callers without being admitted to production. Migrate all production call sites transitively, including investigation, check execution, patch/repair, feedback and completion; unsupported capabilities refuse before effects. Change composition validation to the new exact surface while retaining the old helper's controlled tests where needed.

Coder turn receives the exact `UC03CoderAdmission` resolved for current task/run/state/purpose/evidence. Its model call forwards `admission.request` and `admission.context` to `HostModelPortV02.propose`; validate result with existing canonical parsers before proposal use. Remove the graph's eager provider claim on this route: the model boundary is the sole claimant, attempt starter and outcome/uncertainty recorder. One logical request produces one reservation/claim/attempt chain. Duplicate/conflicting IDs, stale decision generation or mismatched evidence refuse; dispatch timeout after possible network send is uncertain and never blindly retried.

Coder inspect reads use guarded read methods. `run_check` resolves fresh repository admission for the exact configured check/action and calls the v0.2 repository boundary, retaining its execution receipt. It never casts a v0.2 method to the one-argument legacy signature. No provider reservation can stand in for a repository action. Repair uses v0.2 admission and settled repository receipts; its legacy branch stays controlled-only.

Generation is a bounded loop, not one proposal per graph node. On `inspect`, preserve the bounded sanitized observation (source evidence or safe check-result reference), update the next request's evidence/context digest, resolve fresh owner admission and perform another model turn. Do not discard the tool result or reuse a prior request/reservation. Each tool/model turn consumes the existing finite call/time/output allowance; an unknown/denied/uncertain tool result stops with its safe status rather than inventing evidence. `request-info` persists bound question IDs/input/evidence references and enters the existing clarification wait; no model/tool calls occur until complete reporter answers plus explicit valid direction permit continuation. `stop` produces an honest incomplete outcome, never completion. Only a validated purpose-appropriate plan/patch exits the loop into the next stage. Material strategy change still requires renewed approval.

Reviewer ingress also uses `HostModelPortV02` with its distinct reviewer role/config/current request and snapshot. Remove graph-review's eager claim on this route and the reviewer's raw transport dispatch: canonical model ingress alone claims, begins the attempt, dispatches and records outcome/uncertainty. Parse the returned unknown proposal through the existing strict review/diff-line validators. Reviewer has no repository write/tool authority. One request yields one durable chain and one transport call; stale/fenced/mismatched authority yields zero transport, and possible-dispatch timeout remains charged uncertain with no automatic retry. Coder/reviewer share the same task usage accounting without consuming each other's request identity.

## 3. Required host producers

### Guarded reads

`createGuardedReadCapability` produces the existing `ExecutionGuardReadCapability` for one task/workspace and an accepted current owner control/policy reader. For every `mediateRead`, validate safe kind/path/query and finite bounds, current task/workspace/repository identity, run/control mode/fencing and applicable read policy before invoking its closure once. Repository readers still enforce canonical path containment, protected-content exclusion, limits and sanitization; this capability does not duplicate those readers or create write authority. Refresh/serialize the control observation with dispatch using the owner-agreed read-fencing protocol; a stale observation cannot authorize a read after pause/fence. Missing protocol/delivery refuses rather than calling `execute`. No blanket execute-through implementation is accepted.

### Trusted snapshot

`createTrustedHostSnapshot` implements `TrustedHostPort.loadSnapshot` using configured workspace/filesystem measurement and accepted current owner identity. Compute actual revision/check-set/test-file identities from bounded approved paths. Bind request/task/workspace/repository and expected protected-test inventory; reject traversal, linked escapes, missing files, revision drift and partial measurement. Task JSON digests are comparison claims, not measurements; model content cannot define expected test inventory. Snapshot facts feed existing investigation validators, not a new policy authority.

### Baseline evidence

`createBaselineEvidenceAdapter` consumes an accepted UC-04 public evidence delivery; it implements no storage engine. `persistBaselineEvidence` validates the canonical candidate/digest and forwards unchanged. Return acknowledgement only after durable owner success, with exact evidence/task/workspace/repository/content/revision/criteria/check/test-protection identities. Require `loadBaselineEvidence` for production continuation, returning the same bound content/acknowledgement or an explicit missing outcome. Conflicting IDs, digest substitution, unknown durability or write uncertainty block investigation/continuation. No synthetic evidence ID/acknowledgement and no in-memory fallback can satisfy this contract.

### Observed action context

`createHostActionContext` produces `RealContextSource` from a host-only registry of normalized actions and measured facts/elements. Registration requires current task/run/repository/profile/action digest and accepted authority generation; unknown, replaced, expired or stale actions observe as unavailable. The registry stores identifiers/measurement references, validates freshness against current observations and never reconstructs authority from task/model declarations or old presentation text. `createRealContextProvider` retains durable binding validation; UC-05 continues to classify and issue decisions. Continuation re-observes and revalidates; changed context requires a fresh request. Real approval/control requires a separately accepted UC-05 path; the current mock-only guard is preserved until then.

## 4. Owner supplement: material replan

Proposed `MaterialReplanPortV02.accept(request)` is supplied by UC-04 with UC-05 control validation. It is not an addition to the legacy `StatePort` and cannot be implemented as a host-side reserve wrapper. Request binds task/run/workspace/repository/configuration, proposal ID, canonical candidate `FixPlan` payload and its digest, prior plan/state/control versions, explicit current revise direction and expected prior/next count. UC-03 computes materiality with its existing canonical comparison; the owner validates the payload/schema/digest and exact current direction/transition/allowance binding before a single durable transaction records the allowance/receipt and resulting plan transition to renewed approval. Prior edit/decision/review authority is invalidated atomically. Initial plan and nonmaterial clarification consume no material allowance.

Result is `accepted({state, reservationReceipt, transitionReceipt})`, `already-accepted({same committed state and receipts})`, `denied({reason})`, or `uncertain({operationRef})`. Receipts bind the complete request identity and updated count. Verify the canonical candidate payload digest before any mutation. Same proposal/request replay returns the same committed state and receipts without another charge; same ID with different content or a substituted digest denies. Concurrent proposals CAS against prior state/control; at most one wins. Three material replans after the initial plan is the maximum; the fourth denies before mutation. Denial leaves state/accounting unchanged; uncertain commit blocks continuation until owner lookup of the exact operation proves its state. No provider/repository claim stands in for this transaction. Actual public delivery/signature/receipt validators require T019 owner review; absent delivery keeps this branch unavailable.

## 5. Command view and recovery

Use the exact observed `CommandViewSnapshot` for exclusions policy, scratch identity, admitted file digests, revision, read-only property and isolation reference. Owner admission facts and Docker view must describe the same measured snapshot; neither side rewrites values to satisfy the other. The known literal exclusions/scratch mismatch must be corrected with UC-04 at its producer boundary before command dispatch. Missing/stale/mismatched facts refuse with no executor call.

Claim closure and attempt-start query handoffs are explicit accepted owner deliveries. Existing durable helpers may be reused only when accepted and matching this task/profile; local existence is not X04/X05 delivery. Unknown attempt-start, unfenced closure or unsupported patch reconciliation remains blocked. No permission check or recovery refusal is removed to make the bootstrap pass.

## 6. CLI and evidence contract

Direct CLI execution resolves operator-controlled configuration through a host-only loader, then invokes assembly and the existing service; task JSON/argv do not carry ports, approval facts or credentials. `evaluate` supports the planned preflight/run/decision/direction/continue path from quickstart; `uc03` shares the host loader for production run. Preserve existing validation/programmatic controlled behavior and legacy exits. Evaluation missing-prerequisite exit is 4, invalid input 2, unresolved human wait 3; the legacy UC-03 unavailable configuration exit remains 5. Readiness output is safe component/status/reason/identity references, with no filesystem secrets or fabricated real capability.

Controlled contract, unit and graph-backed integration tests must prove positive delivery and every missing/stale/substituted capability refusal, with returned result, owner state/accounting and downstream call counts. Real proof still requires G-OWNERS/G-PROFILE/G-ROUTE/G-ISOLATION/G-APPROVAL and separate execution release. UC-03 T024 hostile guard-composed proof and T025 real bound approval stay in their original ledger. T011/UC-03 T028 share actual successful first-case evidence; neither a readiness result nor controlled graph success checks those tasks. C02 expected wait versus C01 unresolved approval and selected-versus-suite reporting remain unchanged. Restart, patch recovery and broad suite completion receive no claim without their own evidence.

## 7. Repository diff producer

The current `ControlledRepositoryTools.inspectDiff` stub is another concrete missing producer. T032 implements its declared result using trusted bounded baseline/current snapshots, not a caller/model-supplied final diff. Apply the same guarded read, containment, protected-content and finite-output requirements as section 3. Bind base/current revision, exact changed paths and canonical diff digest; drift or unavailable baseline refuses. No write, shell interpolation, repository hooks or private-grader access is permitted. Binary/protected/oversized changes yield safe unsupported/unavailable outcomes before reviewer/grader consumption; a partial diff cannot certify completion. Bootstrap requires this callable, tested capability as part of its repository delivery.

T033 provides a host-owned `RepositoryBaselineSource` distinct from UC-04 baseline verification evidence. The trusted catalog/config supplies a retained initial repository tree and complete admitted-file manifest, outside task/model/container write authority; the service binds that source to task/workspace/repository and measured base revision before the first edit. Prepared custom repositories need the same pinned initial tree. No digest alone substitutes for retained bytes. `loadManifest(binding)` and bounded `readBaselineFile(binding, path)` return manifest/content from that exact immutable source; compare actual bytes/digests and reject source drift, missing files, wrong task/base, escape, protected content or unavailable retention. Capture or preparation belongs before execution admission, not a mutation inside static bootstrap. The artifact profile keeps the source available across continuation and explicit operator cleanup must not remove unresolved-run evidence. No new task/approval/accounting store is introduced.

Diff compares the full baseline admitted inventory with current measured admitted inventory, covering additions, deletions and changed files; validate manifests and base/current digests before returning any result. Required inventory omissions or changes outside approved scope refuse completion rather than silently returning a partial diff. Continuation resolves the same immutable baseline identity and bytes; absent source blocks. Bootstrap validates source capability/retention statically, then service task binding validates exact base/workspace before graph effects. T033/T032 tests cover changed/deleted/added files, source mutation, wrong-base substitution, absent retained source and continuation reload without using caller-supplied diff/solution bytes.

## 8. Amendment: bound clarification (T026) — 2026-11-07

Replaces the "[mid-run clarification still needs an owner-contract amendment]" limitation recorded in
`spec.md` and `quickstart.md`. Additive and version-preserving: v0.1 state gains one optional record
and two guarded transitions; no existing field, transition or validation is removed, and the intake
`Validate → NeedsInfo → Validate` path keeps working unchanged.

**Persisted record.** `TaskState.clarification` is optional and additive, rejected for unknown keys
like every other state field:

```text
clarification: {
  questionId, questionDigest, askedAtStateVersion, round,
  questions: { questionId, text }[],          // 1–16 items, ≤1024 bytes text each
  evidenceRefs: string[],                    // ⊆ next.evidenceRefs, which this write populates; ≤16, each ≤128 bytes
  answer?: { answerDigest, answeredAtStateVersion, recorderRef,
             items: { questionId, text }[] } // 1–16 items, ≤1024 bytes text each
}
```

`questionDigest` is the canonical sha256 of `{taskId, runId, askedAtStateVersion, round, questionId,
questions, evidenceRefs}`; `answerDigest` is the canonical sha256 of `{questionDigest, recorderRef,
items}`. Both use `computeCanonicalSha256`. The preimage lives entirely in the record: `taskId`/`runId`
come from the state carrying it and `questions` is stored, so `validateTaskState` can rehash from the
state it was handed alone. An earlier draft digested `questions` without persisting it, which made the
`Investigate → NeedsInfo` guard unverifiable for the unanswered record it exists to protect.

`askedAtStateVersion` is the version of the state that was current **when the question was asked** —
`prior.stateVersion` at the `Investigate → NeedsInfo` write, which is one less than the version of the
state carrying the record. It is a state version, not a clock, and it is the version guard
(`askedAtStateVersion === prior.stateVersion`) that binds a record to the write that created it. The
digest does **not** do that: its preimage is record-internal, so a verbatim copy of a record hashes
identically on any state. Only content changes fail to rehash.

The record-level `questionId` is derived, not supplied: it is `computeCanonicalSha256` over
`{taskId, runId, round, questions, evidenceRefs}`, cut to `sha256:` plus the **first 32 hex
characters** of that helper's 64-hex output. The prefix is kept. **Only `questionId` is cut**:
`questionDigest` and `answerDigest` are the full `sha256:` plus 64 hex that `computeCanonicalSha256`
returns, uncut. `askedAtStateVersion` is
deliberately **not** in the preimage: it is `prior.stateVersion`, exactly one less than the version of
the state that carries the record, so including it would make the `questionId` stored in a record
differ from the one that same record derives — the replay branch below compares against the
record-bearing prior state and could then never match. Version binding is the separate guard
(`askedAtStateVersion === prior.stateVersion`), which is what actually binds a record to its write.

Two different version senses are in play on the replay path and they must not be interchanged.
`prior.stateVersion` is the version of the state being inspected *now* — for a record-bearing state,
one **higher** than the version the record was written at. The record's own `askedAtStateVersion` is
the version it was written at. Because `askedAtStateVersion` is in `questionDigest`'s preimage, a
re-derivation that fed it `prior.stateVersion` would produce a digest that can never equal the stored
one, and every replay would be refused as a conflict. **Re-derive from the fields of
`prior.clarification` itself**, including its stored `askedAtStateVersion` — never from
`prior.stateVersion`. The `questionId` preimage has no version in it at all, so it re-derives the same
way either way; it is `questionDigest` that carries the hazard.
`questionId` is therefore a function of the content the record binds: two records with the same content
at the same round share it, which is what makes replay detectable, and a record whose content changed
gets a new one. The per-item `questionId`s inside `questions` are the proposal's own ids and are
unrelated to it.

`answer.items` must cover the asked set exactly: its `questionId`s are the same set as
`clarification.questions`, once each, with no additions. A partial answer is not a valid answered
record, because the resumed turn would reach the model with only some questions resolved under an
admission that hashes as if all were. `recorderRef` is a bounded non-empty identifier (≤128 bytes) of
the operator control that recorded it, and is **not** validated against any identity service — this
contract has no such source, so treat it as integrity-checked attribution, not authentication.

Both lists are non-empty. An empty ask would pause the task with nothing to answer, and an empty
answer would cover that nothing exactly, so the boundary refuses `0` items on either side rather than
relying on the producer's own minimum.

**Producer and writer.** Two digest constructors, `computeClarificationQuestionDigest` and
`computeClarificationAnswerDigest`, live in `src/contracts/foundation/uc03/identity.ts` beside
`computeCanonicalSha256` (`:24-28`). That is where they have to be: `validateTaskState`
(`src/contracts/foundation/uc03/v01/validation/state/task.ts:47`, whose `:56` call into
`rejectUnknownKeys` is the insertion point) re-derives both digests to reject a
mismatch, and it must do so in-layer — nothing under `src/contracts/**` imports `src/uc03/**` today,
and `task.ts:3` already imports from `../../../identity.ts`, so the recipe is reachable without
creating a contracts→uc03 edge. One new module, `src/uc03/clarification.ts`, is the only place the two
**records** are assembled, and it calls those constructors rather than restating the preimages. Its
signature is fixed here because the write-boundary idempotency guarantee has no other seam:

```text
askClarification(input: {
  statePort: Pick<StatePort, 'loadTask' | 'transition'>,
  prior: TaskState,                       // the state the proposal was produced against
  proposal: Extract<CoderProposal, { kind: 'request-info' }>,
}): Promise<{ state: TaskState; replayed: boolean }>
```

`Extract<CoderProposal, { kind: 'request-info' }>` is the real name — there is no exported
`CoderRequestInfoProposal`, the variant is an inline member of the `CoderProposal` union
(`agent-types.ts:52`), and `agent.ts:323` already uses the same single-variant
`Extract<CoderProposal, { kind: … }>` narrowing form — there for `'inspect'`, so cite it for the form,
not as a `'request-info'` precedent. Do not invent an alias.

`prior` is the state the caller already loaded, not a re-fetch: the guard binds the record to
`prior.stateVersion`, so re-loading inside the producer could silently rebind a stale proposal to a
newer version. On a replay — `prior.clarification` already carrying the same `questionId`, and a
`questionDigest` re-derived **from that record's own fields** (including its stored
`askedAtStateVersion`) equal to the stored one — it returns `{state: prior, replayed: true}` and
never calls the port. A digest re-derived from `prior.stateVersion` cannot match and would turn every
replay into a refusal; see the version-sense note above. The module
also exports `CLARIFICATION_ROUND_CAP = 3` as the single source of the bound, so the documentation
task cites the constant rather than restating a literal.

The second record has its own entry point in the same module, because the module is the only place
either record is built and a fixture that hand-wrote the answered record would bypass every check
below:

```text
recordClarificationAnswer(input: {
  statePort: Pick<StatePort, 'loadTask' | 'transition'>,
  prior: TaskState,                       // the NeedsInfo state carrying the open record
  answer: { recorderRef: string; items: readonly { questionId: string; text: string }[] },
}): Promise<{ state: TaskState; replayed: boolean }>
```

Both ports are `Pick<StatePort, 'loadTask' | 'transition'>`, not `'transition'` alone, because both
writes go through `transitionState` (`src/uc03/graph-transitions.ts`), which reloads after the write
and compares the persisted result against the proposed state. That reload is what makes the `+1`
version check and the echo assertion below load-bearing; a producer built on the bare port would have
to reproduce both itself.

It is deliberately **not** named `answerClarification`: that export already exists on the intake path
(`src/runtime/evaluation-service-lifecycle.ts:142`) and takes an untrusted submission keyed on
`submission.questions`. Two different producers of two different records must not share a name.

It computes `answerDigest` over `{questionDigest, recorderRef, items}`, stamps
`answeredAtStateVersion: prior.stateVersion`, and writes through the same owner transition as
`NeedsInfo → Investigate`, bumping `stateVersion` by exactly one. It requires `prior.clarification`
present and `items` covering the asked set exactly, and it accepts the record in either state: with
`answer` absent it writes normally; with `answer` present and an identical `answerDigest` it is a
replay returning `{state: prior, replayed: true}` and writing nothing; with `answer` present and a
different `answerDigest` it refuses. There is no separate replay-only precondition — an earlier draft
required the record unanswered *and* defined replay as already answered, which made the branch
unreachable. A missing or partial answer still refuses without calling the port. It
does **not** check the operator continuation authority: that receipt is consumed by the caller before
this module is reached, and re-implementing it here would create a second, unauthenticated control
path.

These digests are **integrity checks, not provenance**: any caller that knows the field values can
compute a self-consistent record, so they detect corruption and partial views, not forgery. What
actually refuses a substituted answer is the owner admission — the admitted context digest covers the
whole persisted state (§8 Continuation input) — plus the unanswered-record precondition on the write
boundary below. Validators never write: they recompute and reject a mismatch. Both writes go through
the existing owner
`StatePort.transition`, which is why the round-trip below matters: `validateTaskState` rebuilds its
result field by field, so `clarification` must be echoed back or every persisted question is silently
dropped on the next transition. The existing intake answer path (`answerClarification` in
`src/runtime/evaluation-service-lifecycle.ts`) is keyed on `submission.questions` and writes no task
state; it is unchanged and is **not** this record's producer.

**Who writes what.** The two states of the record are written by two different transitions, and each
write is complete on arrival — there is no third write and no same-node update:

- The **asked** record (no `answer`) is written by the `Investigate → NeedsInfo` transition, from the
  node that received the `request-info` proposal.
- The **answered** record is written by the `NeedsInfo → Investigate` transition itself: the operator
  continuation supplies `next.clarification.answer`, and that transition persists it while advancing
  the state version. `answer` is never written while the task sits at `NeedsInfo`.

An earlier draft said the answer was written by the continuation but guarded the same edge on
`prior.clarification.answer` already being present. Nothing could ever create it — the asked record
must have `answer` absent, `NeedsInfo → Validate` is refused once a record exists, the state port
hardcodes `allowSameNode: false` and requires `stateVersion + 1`, and the intake path is excluded.
That guard was unimplementable; the edge now requires the answer as **input**, not as prior state.

**Bounded rounds.** `round` starts at 1 and never decreases (both enforced by the transition guards
below — a first ask must carry exactly `1`, not merely a value in range); `Investigate → NeedsInfo` that replaces
an answered record requires `round === prior.round + 1`, and `round` may not exceed 3. That bounds
`Investigate ↔ NeedsInfo` cycling per task without a new top-level state field — each `request-info`
costs a model turn, so an unbounded loop is a spend path, not just a style problem. The cap of 3
mirrors the accepted three-material-replan limit; it is the one new numeric constant this amendment
adds, and T031 records it beside that precedent in `context/runtime_policy.md`.

**Transitions.** `ALLOWED_NODE_TRANSITIONS` gains exactly two successors:
`Investigate: ['AwaitPlan', 'NeedsInfo']` and `NeedsInfo: ['Validate', 'Investigate']`. Guarding is
structural, in `validateStateTransition`:

- `Investigate → NeedsInfo` requires `next.clarification` present, `next.clarification.answer`
  absent, `round` in 1..3, and `askedAtStateVersion === prior.stateVersion`. When `prior` carries no
  record, `round` must be exactly `1` — a first ask at `round: 3` is refused, or the task would silently
  lose its three remaining rounds. When `prior` carries an answered record, `round === prior.round + 1`;
  when `prior` carries an **unanswered** record, it refuses, so a second open question is impossible.
- `NeedsInfo → Investigate` requires `prior.clarification` present and **unanswered**, and
  `next.clarification.answer` present with `answeredAtStateVersion === prior.stateVersion`,
  `questionId` and `questionDigest` identical to the prior record, and `round` unchanged. The
  `answerDigest` is computed by the producer over the supplied items; this edge is its only writer.
- `NeedsInfo → Validate` stays available **only when no clarification record is present**. The intake
  path carries none, so it is unaffected; a task paused on a coder `request-info` cannot abandon the
  open question by going back through `Validate`, which would otherwise reach `Investigate` with
  neither an answer nor the continuation receipts below.
- Any other `NeedsInfo`/`Investigate` exit stays invalid, and neither new edge may run after
  `Deliver`/`Incomplete` or bypass the existing approval, replan and completion checks.
- Nodes outside the pair ignore `clarification`; it grants nothing on `AwaitPlan`, `Patch` or later.

**Evidence refs are carried into state at the ask write, then never re-checked.** `clarification.evidenceRefs`
must be a subset of `next.evidenceRefs` **at the `Investigate → NeedsInfo` write**, and that write is
required to **populate** `next.evidenceRefs` with them:
`next.evidenceRefs = prior.evidenceRefs ∪ clarification.evidenceRefs` (deduplicated, in the style the
other union-style builders already use). A bare subset check against `prior.evidenceRefs` is **wrong
and must not be implemented**: nothing populates `state.evidenceRefs` before a plan exists —
`investigation-baseline.ts` and `investigation.ts` never reference it, and `investigation-plan.ts` is
the only writer, on the later `AwaitPlan` path — while `bindProposal` (`src/uc03/agent.ts:74-76`)
deliberately allowlists the union of `state.evidenceRefs` and the **observed** evidence paths. A
`request-info` citing the file the coder just inspected therefore binds successfully, so checking its
refs against the unchanged prior state would refuse every such pause and throw
`Invalid transition state` at the owner write. Carrying them in also satisfies
`investigation-plan.ts`'s later `stateRefs.includes(ref)` provenance gate.

The anti-invention boundary is therefore **`bindProposal`, not the subset check**: a proposal may cite
only refs already in `state.evidenceRefs` or paths this turn actually observed, and the carry preserves
exactly that set. Once written, the subset is deliberately **not** re-checked by `validateTaskState`. A
clarification record is a historical fact — what was asked and on what evidence — and later transitions
legitimately invalidate evidence: `observedPatchTaskState`
(`src/persistence/adapters/state-port-v02-admission.ts`) filters refs the patch invalidated, and the
union-style builders (`investigation-plan.ts`, `investigation-plan-resume.ts`, `repair.ts`,
`graph-verify.ts`, `graph-review.ts`) each rewrite the array. Requiring the subset to hold forever
would make a persisted state fail its own validator after an ordinary patch, and the "fix" — re-unioning
a record's refs into **current** state at a later transition — would resurrect evidence the owner had
just invalidated. That is distinct from the write-time carry above and stays forbidden: the carry
happens once, in the transition that writes the record, over the array that write produces; no later
transition re-reads the record. So no transition needs to know the record exists. `validateTaskState`
re-derives the two digests and
re-runs `rejectUnknownKeys` over the extended `TASK_STATE_ALLOWED_KEYS` (that rejection is what makes
the additive field non-forward-compatible — see the versioning entry in `contracts/decisions.md`),
but it never interprets the
record, and the record survives as written. No task in this batch may add a union rule at any of these
later sites.

Two things this paragraph formerly claimed, and should not: `graph-completion.ts`,
`graph-patch-ancestry.ts` and `graph-feedback.ts` build `computeCanonicalSha256` preimages and
`FixPlan` values respectively — not `TaskState.evidenceRefs`. The two digest sites embed
`plan.evidenceRefs` in the plan-binding preimage, and `graph-feedback.ts` builds
`FixPlan.evidenceRefs` from `proposal.evidenceRefs`; editing any of them would change that preimage and
desynchronise an approval binding. They are out of scope, and the keys to leave alone are
`plan.evidenceRefs` and `proposal.evidenceRefs`.

**Record lifecycle.** A written record is never cleared or overwritten by any transition outside the
pair; `NeedsInfo → Investigate` carries it forward unchanged except for the same `answerDigest`.
Because the record persists, "a second `request-info` while a question is open refuses" is checkable
from state alone: `Investigate → NeedsInfo` requires `prior.clarification.answer` to be **present**
before it may replace the record, so an open (unanswered) question blocks a second one. `round`
therefore counts answered clarifications, not attempts.

**Idempotent replay.** The claim is about the write boundary, not the transition. `src/uc03/clarification.ts`
owns the comparison: before the asked record is offered to `StatePort.transition`, it inspects the
authoritative prior state, and re-derives both ids **from the record's own fields**: `questionId`
from `{taskId, runId, round, questions, evidenceRefs}` and `questionDigest` from
`{taskId, runId, askedAtStateVersion, round, questionId, questions, evidenceRefs}` as stored on the
record — never substituting `prior.stateVersion` for the record's `askedAtStateVersion`. An identical
replay — both re-derived ids equal to the stored ones — returns the already-persisted `TaskState`
unchanged (`{state: prior, replayed: true}`) and never calls the port. Because the id is derived from exactly the record's bound facts, a **changed** proposal
cannot present the same id: it derives a different `questionId` and is therefore not deduplicated —
it is a new question, and the unanswered-record precondition is what refuses it while the first is
still open. There is no "same id, different content" branch to implement, and none may be written;
the two refusals are distinct preconditions and each test row must name which one it exercises. A
replay must not be pushed through `validateStateTransition`: the state port hardcodes
`allowSameNode: false` (`state-port-v02-task.ts:55`) and requires `stateVersion + 1`, so a re-entered
guard cannot distinguish a replay from a malformed transition. This is a read of owner state before a
write, not a second state store.

**Continuation input.** The resumed coder turn reads the answer from `input.state.clarification` — it
does **not** gain a caller-supplied `clarification` field. A field fed from the request would let a
caller pass items under an admission bound to a different answer, since `coderAdmissionRefusal`
(`src/uc03/agent.ts`) compares request↔context digests and never re-derives the context digest from
the state. Deriving from `state` closes that by construction: the items the model sees are the items
the admission covers. `coderContextDigest` folds `state.clarification?.answerDigest` into its payload
**only when a record is present** — the key is omitted entirely otherwise, because
`canonicalJsonStringify` skips `undefined` but emits `null`, and adding `?? null` would change the
digest of every clarification-free state and invalidate existing legacy admission fixtures. The v0.2
`generateObservedPlan` route already binds with `computeContextDigest(state, evidence)` from
`src/foundation/model.ts`, which hashes the whole state and therefore covers the record without any
change. The required witness is on the v0.2 route: mutating `clarification.answerDigest` in state
changes the admitted context digest and the turn refuses with zero model calls. The resumed turn
receives the answer as reviewer-visible reporter data in its request context; it is not an approval,
direction or patch.

**Behaviour.** A `request-info` proposal is persisted as the bound unanswered record and leaves the
task at `NeedsInfo` with terminal `needs-info`; no further model or tool call occurs until the
reporter's complete answers and an explicit valid direction permit continuation, on the same gating
condition §2 states for the intake wait. That is a condition on the pause, not a whole-run call count:
producing the proposal is itself one `coder:propose-plan` dispatch, and the ask write adds no second
one. `stop` keeps its honest incomplete outcome, and loop/output/time exhaustion keep their existing
bounded refusals — none of them may be reported as completion. Until T027 wires the route, this edge is
contract-only. Today a `request-info` at `Investigate` does not reach `NeedsInfo` at all: it is a
successful generation that fails the wrong-kind check at `graph-nodes.ts:57` and reports `INCOMPLETE`
before any record is persisted. Once T026 persists the record, the `Investigate` edge's
terminal-outcome check (`graph.ts:103`) still returns `'Incomplete'` ahead of any node routing, so the
pause reads as `INCOMPLETE` until T027 adds the `needs-info` END case. T026 acceptance stops at the
validator/agent boundary; T027 owns the routing. Do **not** close this by adding `NeedsInfo` to
`WORKFLOW_NODES` — `NeedsInfo` is a pause, not a traversable workflow node.

A clean `needs-info` pause emits no diagnostic — `diagnosticForOutcome` already returns `{}` for that
outcome — so the `NeedsInfo → 'intake'` entry in `NODE_STAGES` is only reachable on a failure path
that ends incomplete. It is therefore left as it is: making it record-aware would mean teaching a
failure-path label to read `TaskState` for a distinction nothing reports. No task is asked to change it.

**Authority.** Answers are reporter data. Persisting or reading them grants nothing: the
`NeedsInfo → Investigate` edge additionally requires the operator continuation that section 6 and
`integration.md` §1 already define (`issueDirection` + `continueExperiment` receipts). This contract
adds no resume path, no control authority and no approval; a resumed run re-observes current owner
control exactly as any other continuation.

## 9. Amendment: owner-measured isolation binding (T025) — 2026-11-07

Resolves the recorded T025 contradiction. The published v0.1 `CommandView` stays unchanged — no new
field, no changed digest, no changed validator key set — and the caller-supplied
`admissionCommandView(view, isolationProfileRef)` argument is withdrawn as an authority source.

**Published measurement.** `buildDockerCommandView` already receives the owner's
`OwnerCommandViewMeasurementV02`, which includes `isolationProfileRef`. On a successful build it
issues one host-owned measurement record bound to the published view:

```text
MeasuredCommandViewIsolation = { viewId, viewDigest, isolationProfileRef }
```

`viewDigest` is the **v0.1 published** `view.viewDigest` (`computeCommandViewDigest` over the eight
v0.1 keys), copied verbatim — not the v0.2 digest recomputed during the lift, which would be
self-referential because it already covers `isolationProfileRef`.

Records are issued only from an accepted `ownerView` measurement, held in a module-private `WeakSet` in
`src/foundation/docker-view-builder.ts`. `buildDockerCommandView` returns them alongside the view as
`{ view, measured }` so the caller receives the capability rather than constructing one. A caller
cannot construct a record and cannot retype a string into one. When `ownerView` is absent the builder
issues no record, so a production admission that declares isolation has nothing to lift and refuses.

**Issuance spans one module.** Issue and check must live in the same file or the `WeakSet` proves
nothing: `admissionCommandView` lives in `repository-admission.ts`, so the builder exports one
module-scope predicate, `isMeasuredCommandViewIsolation(value)`, that answers membership and nothing
else. The set itself stays private; an exported boolean predicate cannot be used to mint a record.
This is the `eval/shared-admission.ts` shape (`issueRealExecutionAdmission` /
`isAdmittedRealExecutionAdmission`), and it is the reason the record type and the predicate are the
only things exported for the lift.

**Lift.** `admissionCommandView(view, measured)` accepts the record instead of a raw reference. It
requires four things, in this order: `isMeasuredCommandViewIsolation(measured)`; `measured.viewId ===
view.viewId`; `measured.viewDigest === view.viewDigest`; and `computeCommandViewDigest(view)` equals
`view.viewDigest`. That digest covers exactly the eight v0.1 keys and no others —
`viewId`, `taskId`, `workspaceId`, `canonicalRevisionDigest`, `admittedFiles`,
`exclusionsPolicyVersion`, `scratchIdentity`, `mountedReadOnly` — and a view carrying a ninth key is
not a v0.1 `CommandView`. The lift does not invoke `validateCommandView`; the refusal comes from the
recomputation itself, because `computeCommandViewDigest` deletes only `viewDigest` and therefore
hashes **every** other key present, ninth ones included. A mutated or extra-keyed view simply fails to
reproduce the declared digest. The four refusals throw, in order, `ISOLATION_RECORD_UNMEASURED`,
`ISOLATION_RECORD_VIEW_MISMATCH` (id), `ISOLATION_RECORD_DIGEST_MISMATCH` (declared digest) and
`ISOLATION_RECORD_VIEW_UNHASHED` (recomputation). `_DIGEST_MISMATCH` is the record's declared
digest not matching the view's declared digest; `_VIEW_UNHASHED` is the view's **own** declared
digest not re-deriving from its content. They are reachable by different mutations and must be
tested separately: a missing `viewDigest` fails the earlier comparison, so the fourth code is only
reached by a view whose declared digest still equals the record's and no longer equals its own
content. Precedence is **not** observable from one violation per fixture — a reordered implementation
still throws exactly one of the four for each. It is observable only from a fixture that violates
several codes at once: a record that is unmeasured **and** carries a foreign `viewId` **and** is paired
with a view that no longer re-hashes must yield `ISOLATION_RECORD_UNMEASURED`, not a later code. The
test therefore asserts reachability with four separate fixtures and precedence with that one combined
fixture; asserting only the four would leave "in order" unwitnessed. The recomputation is
load-bearing: string equality alone lets a caller copy a genuine `viewDigest` onto a view whose
`admittedFiles`, `scratchIdentity` or `canonicalRevisionDigest` were changed, and still lift the
owner's isolation ref onto the mutated view. Verifying the view hashes to its own declared digest is
what refuses that pairing. Only then is the v0.2 digest recomputed for the widened projection.

`viewId` is derived from the workspace and the initial revision only
(`view-${workspaceId}-${sha256(initialRev).slice(0, 12)}`), so it is **not** sensitive to admitted
content. That is why the claim here is stated over `viewDigest` and the recomputation, not over
`viewId`: the observable refusal is "a record whose `viewDigest` no longer matches the recomputed
digest of the view it is paired with is refused", and that is the case the required test exercises.

The resulting `CommandViewV02.isolationProfileRef` is therefore the owner's measured value for that
exact view, and `commandExecutionLimits` (`repository-admission.ts`, bounds/view/policy) is a real
cross-check on this path. `commandExecutionLimits` is exported and pure, so the positive predicate is
observable without execution: a view lifted from a record satisfies it with limits derived from the
measured ref, and a record whose ref differs from `policy.isolationProfileRef` throws
`COMMAND_RESOURCE_POLICY_MISMATCH`. The throw is the whole witness: do not also assert that
`executeContainer` was never called. `commandExecutionLimits` takes no controller and cannot reach an
executor, so a zero-call clause holds identically for a correct and a broken implementation. This
amendment claims the
admission boundary, not an executor traversal: `DockerContainerPlan` carries no isolation field and
`admissionCommandView` has no production caller outside the lift's own tests, so no task in this batch
may claim a real execution proved the measured profile was applied. The v0.2 → v0.1 projection
(`dockerCommandView`) still drops isolation, because that field is not part of the v0.1 contract; the
measurement lives beside the published view, not inside it.

**Scope of the guarantee.** This closes the hole on the `admissionCommandView` path only. Callers that
build a `RepositoryAdmissionContextV02` directly still reach
`validateRepositoryAdmissionV02` (`src/contracts/foundation/uc03/v02/admission/repository.ts`), which
accepts `commandView.isolationProfileRef` and `finiteBounds.isolationProfileRef` as plain non-empty
strings, and `state-port-v02-admission.ts` synthesizes `isolationProfileRef: context.executionProfileId`
outright. Requiring the measured record inside the canonical v0.2 admission validator would mean
editing `src/contracts/foundation/uc03/v02/**`, which this task's ownership excludes and which the
2026-11-07 agreement did not release. That residual hole is therefore recorded as **remaining
acceptance**, not silently claimed closed: the T025 criterion is satisfiable for the
`admissionCommandView` path, and the canonical-validator path needs its own owner-amended task. No task
in this batch may claim caller-supplied isolation authority is fully eliminated.

**Hand-off.** The manager gains one additive entry point beside the existing one:
`DockerWorkspaceManager.admitMeasuredCommandView(params: CommandViewOwnerBindingParams):
Promise<{ view: CommandView; measured?: MeasuredCommandViewIsolation }>` delegates to
`buildDockerCommandView` and returns its result unchanged. The existing
`admitCommandView(params: AdmitCommandViewParams): Promise<CommandView>` keeps its signature and
delegates to the same builder, returning only `view` — this is deliberate, because it has 68 call
sites across `tests/runtime/unit/docker-workspace.test.ts` (32),
`tests/runtime/security/uc03-isolation.test.ts` (24),
`tests/runtime/unit/repository-tools.test.ts` (6),
`tests/runtime/security/uc03-real-containment-probe.ts` (3, a test-tier probe with no `src`
counterpart) and `tests/runtime/contract/atomic-admission-matrix.test.ts` (3), and none of them
carries an owner measurement. (Those are invocation counts; a plain text search for the method name
returns more, because it also matches the definition, imports and type positions.) That count covers
the pre-existing sites only: T025's own test rewrite adds one further invocation in
`tests/runtime/unit/repository-view-bridge.test.ts`, which legitimately holds a plain view beside the
record it separately measures, bringing the shipped tree to 69. Widening that
return type would edit five files this task does not own
to buy a value they cannot use. `CommandViewOwnerBindingParams` already extends `AdmitCommandViewParams`
with `ownerView` and `trustedIsolationProfileRef`, so the measured entry point needs no new params type.

**What this does not reach.** There is no run-command admission producer in `src` that calls
`admissionCommandView`: its only callers are `repository-view-bridge.test.ts` and the new binding
tests. The v0.2 admission contexts are built elsewhere (`repository-receiver.ts` `runCommand`/`runTests`,
via `commandExecutionLimits`, and the canonical validators), and `repository-receiver.ts` is
deliberately outside this task. So the hand-off this amendment owns is the builder → manager seam, and
it is proved by controlled tests at that seam, not by an execution path. Wiring a production producer
that carries `measured` into `admissionCommandView` needs its own task and its own release; until then
no task may claim the measured isolation reaches a real command.

**Refusal.** Mismatch between the owner measurement and the trusted execution profile refuses at
build time (`OWNER_VIEW_MISMATCH`, zero executor calls, unchanged accounting) as today. New in this
amendment: a view built without an owner measurement cannot be lifted for a profile-declared
isolation, and an unmatched or foreign record refuses rather than defaulting. No permission check,
ownership boundary or existing Docker view regression is relaxed.
