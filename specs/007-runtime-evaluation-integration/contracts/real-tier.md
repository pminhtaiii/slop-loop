# Contract: uc03-real-tier/1 — real-tier prerequisites before T011

Status: planning contract, 2026-11-14 (Asia/Saigon). Authority is the "Real-tier prerequisite release — 2026-11-14" entry in [decisions](decisions.md) (`decisions.md:95-104`): planning is released now; implementation of T040–T055 follows only after automated validation and both independent planning lanes pass. This contract supplements [host-composition](host-composition.md) (`uc03-host-composition/2`) and [integration](integration.md) (`runtime-evaluation/1`); it changes no canonical v0.1/v0.2 signature and no T001–T039 text. Amended the same day by the "Real-tier operator decisions — 2026-11-14" entry (`decisions.md:106-109`): no economic cap, pricing left as an unverified placeholder, a self-hosted endpoint pinned by the operator, and worker-built owner code counting toward X04-STATE/X05-GATE for these runs.

**Provenance, restated exactly.** The UC-04 and UC-05 implementations planned here are built by the coordinator's workers under one user's delegated direction. They are **not** Thanh Tan's or Trong Tan's deliveries or signatures; G-OWNERS stays single-attested (`decisions.md:61`, `:104`). A real-ready readiness result built from them is a prerequisite, never G-OWNERS evidence.

## (a) Gap inventory with evidence

Inspected at HEAD `c1eba127` (source reading only; no test, container or provider was run for this inventory).

| Surface | State | Evidence | Planned task |
|---|---|---|---|
| Real-tier assembly gate | **Exists** | `prepareUC03Host` refuses any `mock` component (`src/runtime/uc03-host-bootstrap.ts:88-89,131-137`); all 12 components are required (`src/uc03/graph-types-v02.ts:109-123,140-152`) | T050 builds the inputs |
| DeepSeek transport | **Exists** (controlled-tested only) | Hard-coded `PINNED_ENDPOINT = https://api.deepseek.com/anthropic/v1/messages`, and `assertPinnedEndpoint` refuses any other URL (`src/foundation/deepseek-transport.ts:56,89-93`), so the user's self-hosted endpoint cannot be reached today. Pre-dispatch `denied` outcome (`:277-278`); `x-api-key` header (`:288`). The credential is an option, and nothing reads the environment (`grep process.env src eval` → no hits) | T047 (profile/credential), T049 (operator-pinned endpoint, runaway stop) |
| Model provenance | **Exists** | `derivedModelProvenance` is `real` only for the branded transport (`src/foundation/model-v02.ts:145-147`) | — |
| Reviewer ingress | **Exists** | `createRuntimeReviewer` requires a real `HostModelPortV02` (`src/foundation/reviewer.ts:61,250`) | — |
| Docker controller | **Exists** (controlled-tested only) | `--network=none --read-only --cap-drop=ALL`, memory/cpu/pids flags (`src/foundation/docker-controller-argv.ts:88-110`); image referenced as `${image}@${imageDigest}` (`:109`) | T048 |
| Docker spawn environment | **Gap** | `spawn(command, args, { shell:false, … })` passes no `env`, so the Docker CLI inherits the whole host environment including `ANTHROPIC_API_KEY` (`src/foundation/docker-spawn.ts:37`); `context/runtime_policy.md:13` forbids wholesale inheritance | T048 |
| Runtime image | **Controlled-only** | `docker/uc03/Dockerfile` uses an unpinned `python:3.12-alpine` tag; `docker/uc03/profile.json` pins a digest of unknown origin, consumed by the unrun probe `tests/runtime/security/uc03-real-containment-probe.ts:16-19` | T048, T051 |
| Operator profile and usage limits | **Controlled-only** | `EvaluationProfile` carries `credentialRef`, pricing numerators and `spendPolicy: 'derived-exposure'` (`src/runtime/evaluation-profile-types.ts:17-60`); `deriveExposureCeiling` gives a derived per-run figure (`src/runtime/evaluation-profile-exposure.ts:15-46`). There is no operator loader, and no per-run token/call stop outside UC-04 task accounting | T047, T049 |
| UC-04 task/control/journal store | **Exists as candidate** | `DurableStatePortV02` is file-backed, defaults to `real` provenance and implements the ten required state methods (`src/persistence/adapters/state-port-v02.ts:56-160`); it is not a pinned owner delivery (`host-composition.md:62`) | T040, T043 extend it |
| UC-04 read-fencing protocol | **Missing** | `createGuardedReadCapability` requires an owner `observeReadControl`/`fenceReadControl` (`src/foundation/guarded-read-capability.ts:43-46,117`); no implementer in `src` | T040 |
| UC-04 exact-operation uncertainty lookup | **Missing** | replan `uncertain` returns `operationRef` and stops (`src/uc03/replan.ts:271`); no owner lookup exists | T040 |
| UC-04 baseline evidence store | **Missing** | the T023 adapter consumes an `OwnerBaselineEvidenceDelivery` (`src/runtime/baseline-evidence-adapter.ts:31-36`); no `persist`/`load` implementer in `src` | T041 |
| UC-04 approval store interop | **Defective** | UC05-STORE-RECEIPTS and UC05-STORE-MAPPING (`specs/003-uc05-human-approval/contracts/decisions.md:154-157`); `default-repo`/`default-ws` seed (`src/persistence/adapters/approval-types.ts:110-111`) | T042 |
| UC-04 authority publication / recovery admission | **Missing** | UC-05 calls `journal.publishAuthority` and `recovery.loadAdmission` (`src/approvals/control-v02.ts:33-40`, `src/approvals/recovery-v02.ts:63-67`); `DurableStatePortV02` has neither (`state-port-v02.ts:84-160`) | T043 |
| UC-04 material replan transaction | **Missing** | interface only (`src/uc03/graph-types-v02.ts:99-102`); sole consumer `src/uc03/replan.ts:250` | T044 |
| UC-05 policy/decision/presentation | **Exists** | `createApprovalService` with `show`/`decide`/`control` (`src/approvals/service-v02.ts:73`, `src/approvals/service-data.ts:67-75`) | reused |
| UC-05 real control/continuation | **Mock-only** | `publishAuthorityV02` returns `paused` unless the journal says `mock` (`src/approvals/control-v02.ts:188`); recovery the same (`src/approvals/recovery-v02.ts:67-73`) | T045 |
| Production `ConsoleApprovalPort` | **Missing** | interface only (`src/runtime/console-server.ts:33-36`); every implementer is test-supplied (`quickstart.md:93`) | T046 |
| Production assembly module | **Missing** | the CLI imports an operator `createHostAssembly()` factory (`src/cli/evaluate.ts:64-66,230-255`); none exists in `src` | T050 |
| Host producers (guarded read, snapshot, action context, baseline adapter, diff, retained source) | **Exist** (T021–T025, T032, T033) | `src/foundation/guarded-read-capability.ts`, `src/runtime/trusted-host-snapshot.ts`, `src/runtime/host-action-context.ts:100,194`, `src/runtime/baseline-evidence-adapter.ts`, `src/foundation/repository-diff.ts`, `src/runtime/repository-baseline-source.ts` | consumed by T050 |
| UC-03 T026/T066 recorded gaps | **Open** | `specs/001-verified-code-repair/tasks.md:197` (replan baseline/renewed approval, STD-R3-002, SPEC-R3-001), `:527` (SPEC-R1-003 and listed Section 10 gaps) | T053 |

## (b) Production UC-04 implementations

All four honour the T019-agreed surfaces (`decisions.md:13`, `host-composition.md:38-58`). They build on the existing durable store and lock (`src/persistence/store.ts`, `src/persistence/lock.ts`); no second engine, no in-memory fallback.

1. **Read fencing (T040).** `createStateReadFence(port: DurableStatePortV02, binding)` returns a `GuardedReadOwnerPort`. `observeReadControl` reads the persisted control head for the bound task/workspace/repository and returns `{controlVersion, mode, holdRef, fencingGeneration, policyDigest, readAllowed}`; `readAllowed` is true only for `runnable` with no hold. `fenceReadControl(observation)` re-reads the head under the task lock and returns a receipt only when every field still matches; any drift returns `null`. A pause or fence after observation therefore refuses the read (agreed "read fencing").
2. **Exact-operation lookup (T040).** `lookupOperation(operationRef) -> {status: 'committed', state, receipts} | {status: 'absent'} | {status: 'unknown'}` reads only the journal; `unknown` keeps continuation blocked. It is the "uncertainty lookup" surface and never re-executes anything.
3. **Baseline evidence store (T041).** Implements `OwnerBaselineEvidenceDelivery` (`baseline-evidence-adapter.ts:31-36`) with `provenance: 'real'`. `persist` writes the canonical candidate and its digest atomically, keyed by `(taskId, workspaceId, repositoryId, evidenceId)`; it returns `durable` only after the atomic rename succeeds, `denied` for a conflicting ID with different content, and `uncertain({operationRef})` when the write outcome is unknown. `load` returns `found` with byte-identical content and acknowledgement, `missing`, or `uncertain`.
4. **Approval store interop (T042).** Missing decision lookups return the consumer's `invalid/unknown-decision`; first request creation returns `pending` with the committed request-event ID; initial control takes the actual task repository/workspace mapping instead of the `default-repo/default-ws` seed. Durable-file semantics are unchanged; no compound-transaction claim.
5. **Authority publication and recovery admission (T043).** `DurableStatePortV02.publishAuthority(options)` persists an authority publication with monotonic generation and returns the receipt shape `control-v02.ts:18-25` validates; `loadAdmission(decisionId)` returns the persisted admission record recovery needs. A module-private brand marks ports constructed by this class with `provenance: 'real'` (`isProductionStatePortV02`), the same pattern as `isDeepSeekTransport` (`deepseek-transport.ts:47-53`).
6. **Material replan transaction (T044).** `createMaterialReplanPort({ state, verifyDirection })` implements `MaterialReplanPortV02.accept` under the task lock: recompute the canonical candidate `FixPlan` digest before any mutation; check CAS on prior task/control versions, the expected prior/next count and a UC-05-verified current revise direction; then one atomic journal write records the allowance, the plan transition to renewed approval and invalidation of prior edit/decision/review authority. Same request replay → `already-accepted` with the identical committed state and receipts and no charge; same proposal ID with different content or digest → `denied`; the fourth material replan → `denied` before mutation; unknown write outcome → `uncertain({operationRef})`, resolvable only through `lookupOperation`.

## (c) Production UC-05 implementation

Reuse `src/approvals/` unchanged for policy, decision, presentation and history; do not duplicate them.

1. **Real control and continuation (T045).** Replace the `provenance === 'mock'` acceptance at `control-v02.ts:188` and `recovery-v02.ts:67-73` with: accept `mock` (unchanged, controlled), or `real` only when `isProductionStatePortV02(journal)` is true and the required methods exist. An object that merely declares `provenance: 'real'` stays `paused`/`approval-recovery-unavailable`. Both files stay ≤ 20,000 bytes (`control-v02.ts` is 19,906 bytes today), so the shared acceptance predicate lives in a new `src/approvals/journal-acceptance-v02.ts`.
2. **Current admission.** Continuation keeps re-observing and revalidating through the existing service (`service-v02.ts:83-112`); this contract adds no shortcut.
3. **Production `ConsoleApprovalPort` (T046).** `createConsoleApprovalPort(service: ApprovalService, resolveTask)` maps `presentation(experimentId)` to `service.show(taskId, currentDecisionId)` and `decide(input)` to `service.decide(input)` after validating the bound fields, returning `ConsoleOutcome`. It never records a decision the operator did not submit, and stale/duplicate decisions keep the service's own refusals.
4. **Policy profile.** The canonical `PolicyProfile.profileId` is the literal `'uc05-local-v1'` (`src/contracts/approvals/v01/types.ts:133-135`). The real-tier profile keeps that literal, which is a contract constraint, and distinguishes itself by `profileVersion: 'real-tier-2026-11-14'` and its own `policyIdentity`. Changing the literal needs a UC-05 contract amendment and is out of scope.

## (d) G-PROFILE operator profile

**Location.** Outside every checkout, so it can never be staged: `%USERPROFILE%\.slop-loop\uc03-real-tier\` (Windows) or `~/.slop-loop/uc03-real-tier/`. The loader (T047) refuses a profile, state root or artifact path that resolves inside the repository root. The environment variable `UC03_REAL_TIER_PROFILE` names the profile file, because the CLI calls `createHostAssembly()` with no arguments (`src/cli/evaluate.ts:237`).

**Credentials.** Read once from `process.env.ANTHROPIC_API_KEY` inside the assembly and passed only to `createDeepSeekTransport` (`deepseek-transport.ts:38-41`). The name is fixed, not configurable. The value is never logged, persisted, hashed into a digest, written to a report, or passed to any child process (T048's spawn allowlist). An absent or empty variable makes readiness `unavailable` with reason `credential-missing`. Retained-evidence checks scan every retained file for the key's bytes and fail without printing it.

**Endpoint and model (operator-pinned).** The user serves the model from a self-hosted Anthropic-compatible endpoint, not `api.deepseek.com`. The assembly resolves exactly one endpoint and one model id, then freezes both for the process:

- **Endpoint.** The profile's `provider.endpoint` (an exact `<base>/messages` URL), or, when that is absent, `process.env.ANTHROPIC_BASE_URL` plus `/messages` (the variable holds a `http://<host>:<port>/v1`-shaped base). If both are set and differ, readiness refuses (`endpoint-ambiguous`). If neither is set, the current pinned `https://api.deepseek.com/anthropic/v1/messages` stays the default.
- **Validation** (T047 at load and T049 in the transport, both required). The value must be an absolute URL with no username, password, query or fragment, and its path must end in `/messages`. The protocol must be `https:`, or `http:` only when the profile sets `"allowInsecureHttp": true`; otherwise the profile refuses to load (`insecure-endpoint-unacknowledged`). The transport stores the normalized `href` at construction and compares it exactly before every `fetch`. No model-, task-, request- or browser-supplied URL is ever accepted, and redirects stay refused.
- **Model id.** The profile's `provider.model`, or else `process.env.ANTHROPIC_MODEL`; if both are set and differ, readiness refuses (`model-ambiguous`). The user's id is `po/deepseek-ai/deepseek-v4.1-flash-1017` (supplied by the user, as `decisions.md:108` anticipated; it supersedes the earlier `deepseek-flash` alias), and it already satisfies the host file's identifier rule (`src/cli/evaluate.ts:69`). Readiness pins it as `requestedModel` in `host.json`. The transport already records requested and returned identities (`deepseek-transport.ts:317`). The T054 conformance call requires the returned identity to equal the pinned id exactly and stops the campaign on mismatch; the coordinator then asks the user rather than accepting another string.
- **Two pinning sites change** (T049). The transport's `assertPinnedEndpoint` (`deepseek-transport.ts:89-93`) and the profile's `endpointOf` (`src/runtime/evaluation-profile-primitives.ts:102-106`, today `https` on `api.deepseek.com` only) both accept the operator-pinned endpoint under the same rule, and both keep the current default.

**Cleartext risk.** A plain-`http` endpoint on a public address sends the `x-api-key` header, prompts (which contain repository excerpts) and responses unencrypted. Anyone on the path can read or alter them, and a captured key gives full use of the deployment. `allowInsecureHttp: true` is the operator's explicit acceptance of that risk. Neither the transport nor the profile can make an `http` hop safe. Recommendation: put TLS in front of the deployment, or tunnel it (`ssh -N -L 127.0.0.1:<local-port>:127.0.0.1:<port> <user>@<host>`) and point the profile at `http://127.0.0.1:<local-port>/v1/messages`, where the cleartext hop is loopback-only. Readiness output and evidence records state `transport: insecure-http-acknowledged` whenever the flag is in force.

**Privacy.** This repository is public. No tracked file (docs, tests, fixtures, snapshots, commit messages) may contain the real host, port or full URL. Docs use `http://<host>:<port>/v1`; tests use reserved documentation values such as `http://192.0.2.10:8080/v1` (RFC 5737) or `http://model.invalid:8080/v1`. Readiness output and retained evidence record only `endpointDigest` (sha256 of the normalized URL) and the scheme. They never record the URL itself, so evidence copied into a ticket or PR leaks nothing. Before each commit or publication from a real-tier session, the coordinator runs `git grep -nF -e "$env:ANTHROPIC_BASE_URL"` (and the host on its own) over the staged tree, expecting no match; the value comes from the environment and is never echoed.

**Shape** (`uc03-real-tier-profile/1`; unknown keys refuse):

```json
{
  "schema": "uc03-real-tier-profile/1",
  "campaignId": "uc03-real-tier-2026-11",
  "stateRoot": "C:/Users/<you>/.slop-loop/uc03-real-tier/state",
  "provider": {
    "endpoint": "http://<host>:<port>/v1/messages",
    "allowInsecureHttp": true,
    "model": "po/deepseek-ai/deepseek-v4.1-flash-1017",
    "mode": "nonstreaming",
    "timeoutMs": 60000
  },
  "pricing": {
    "pricingId": "placeholder-unverified",
    "denominator": 1000000,
    "inputRate": 2000000, "cacheRate": 2000000, "outputRate": 8000000, "overheadRate": 0
  },
  "runLimits": { "perRunInputTokens": 400000, "perRunOutputTokens": 80000 },
  "limits": {
    "totalModelCalls": 24, "inputTokensPerRequest": 32768, "outputTokensPerRequest": 8192,
    "providerTimeoutMs": 60000, "activeExecutionMs": 900000, "repairs": 2, "reviewerIterations": 2,
    "materialReplans": 3, "commandTimeoutMs": 60000, "outputBytes": 1048576,
    "memoryBytes": 1073741824, "cpus": 1, "processes": 128
  },
  "image": {
    "label": "uc03-pytest:real-tier", "imageId": "sha256:<64 hex>",
    "base": "python:3.12-alpine@sha256:<64 hex>", "platform": "linux/amd64", "user": "1000:1000"
  },
  "catalog": { "path": "C:/coding agent/fixtures/uc03/catalog.json" },
  "artifacts": { "retainRoot": "C:/Users/<you>/.slop-loop/uc03-real-tier/artifacts", "retainRawStreams": false },
  "approvalPolicy": { "profileVersion": "real-tier-2026-11-14" }
}
```

`provider.endpoint` and `provider.model` may be omitted when `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` are set. `allowInsecureHttp` is required, and must be `true`, whenever the resolved endpoint is `http:`.

- **Pricing table.** The transport requires pricing numerators (`deepseek-transport.ts:249-252`) and the profile requires a pricing identity, so a placeholder table stays only to satisfy those inputs and to report an estimate. It is not a price claim, and the user may replace it with their own figures at any time (`decisions.md:108`). Every cost figure the runs report is labelled `estimate-unverified`, and becomes `unknown` whenever usage is missing. It is never reported as zero, never compared with a cap, and never used to block a call.
- **Image.** `docker/uc03/Dockerfile` takes a required `ARG PYTHON_BASE`, which must be a digest-pinned reference. It installs `pytest==8.3.4` and its pinned dependencies at **build** time and creates user `1000:1000`. The run-time identity is the built image ID (`docker image inspect --format '{{.Id}}'`). T048 changes `runArguments` to reference the image by that content-addressed ID with `--pull=never`, so a run never contacts a registry; `--network=none` already blocks the container.
- **Limits.** Container: 60 s command, 1 GiB memory, 1 CPU, 128 pids, 1 MiB output, the values `docker/uc03/profile.json` already validates. Model and run limits are the reviewed `plan.md:69` proposal, except the command timeout (60 s instead of 30 s, to absorb container start on Docker Desktop).
- **Protected artifact profile.** Never retained: the credential, the endpoint URL/host/port, raw prompts, raw provider bodies, raw container streams (`retainRawStreams` must be `false`), hidden grader payloads and fixture sources. Retained under `artifacts.retainRoot` and the session evidence directory: sanitized reports, usage and receipt records, digests (including `endpointDigest`), bounded sanitized diagnostics and the diff. Fixtures stay local-only (`specs/001-verified-code-repair/contracts/decisions.md:188-190`).

## (e) Usage limits: runaway stop, no economic cap

The user serves the model on their own deployment and asked not to limit usage, so FR-006's "no user economic cap" stands (`spec.md:82`, `decisions.md:51,107`). There is no USD cap, no cross-run spend ledger and no budget command. What remains is a **runaway stop**: finite per-run token and call limits, enforced in code before dispatch and failing closed, as `context/runtime_policy.md:23` requires for every token limit.

| Limit | Default | Enforcement |
|---|---|---|
| Per call | 32,768 input, 8,192 output tokens | Existing profile limits and transport admission (`deepseek-transport.ts:151-152`) |
| Calls per run | 24 (`limits.totalModelCalls`) | UC-04 task accounting (existing) and the run limiter below |
| Tokens per run | 400,000 input, 80,000 output (`runLimits`) | Run limiter below |

**Run limiter (T049).** `createRunUsageLimiter(limits)` is passed to `createDeepSeekTransport` as a new `runLimiter` option and runs inside `execute` after `admit` and before `fetchFn` (`deepseek-transport.ts:277-283`).

1. Key the counters by the request's `(taskId, runId)`. A request without both refuses.
2. Before the call, refuse with `{outcome:'denied', reason:'RUN_USAGE_LIMIT_REACHED'}` when the run has already made `totalModelCalls` calls, or when the run's charged tokens plus this request's admitted maxima would exceed either per-run token limit. This is the transport's existing pre-dispatch path, so UC-04 records an undispatched outcome.
3. Count the call before `fetch`, and charge its admitted maxima as provisional tokens.
4. After the call, replace the provisional charge with the observed usage **only** for a validated 2xx response with parsed usage. In every other case after `fetch` was invoked (timeout, abort, network error, 4xx/5xx/429, malformed or usage-less body), the call keeps its full admitted maxima, so unknown usage never counts as zero.
5. Counters are in-memory, per transport instance. A run never spans processes in this scope, because restart is excluded. A process that starts a new run gets new counters, and UC-04 task accounting remains the durable authority for task budgets (`data-model.md:3`).
6. Absent, non-integer or non-positive limits refuse construction, so readiness is `unavailable` (`run-limits-invalid`).

**Cost reporting.** Each call records usage tokens (or `unknown`) and an `estimate-unverified` cost computed from the placeholder table. Run totals sum only known parts and say `incomplete` when any part is unknown. No figure is labelled actual or billed.

## (f) Evidence runs

All runs use the T050 production assembly and the operator profile, and retain artifacts under `.agent-work/<date>/uc03-real-tier/evidence/<task>/` (ignored). Detailed reports go to the ignored `docs/verification/` files the UC-03 ledger names. **The UC-03 ledger (`specs/001-verified-code-repair/tasks.md`) records acceptance of T024/T025/T026/T066/T028; this feature's ledger records only that its run task delivered the evidence.** Per the operator decision (`decisions.md:109`), worker-built UC-04/UC-05 code counts toward X04-STATE/X05-GATE for these runs. Every UC-03 acceptance entry must state that this rests on the user's single delegated attestation and is not Thanh Tan's or Trong Tan's delivery or signature.

| Run | Cases and command | Pass criteria | Fail / not-run |
|---|---|---|---|
| **T024 containment** (T051), zero model calls | C06–C11 from `tests/runtime/security/uc03-isolation.test.ts`, re-run through the production guard/view/executor in real containers: `node dist/tests/runtime/security/uc03-real-containment-probe.js` with `UC03_REAL_TIER_PROFILE` set | Hostile pytest cannot read `.env`/key/embedded-secret sentinels, write source or existing tests, or reach the network; no writable canonical volume; required secret-bearing source refuses before execution; admitted bytes match canonical digests; scratch cannot replace canonical files; OOM/timeout rows are killed within limits; no-shell argv recorded; zero transport fetches | Any sentinel read, write or network success, a missing image/daemon, or an unsupported junction platform: fail or not-run, never pass |
| **T025 approval gating** (T052), zero model calls | C13 allowed/pending/approved/rejected/revised/stale/forbidden decisions, and plan approval before edits, with the production UC-04 store (temp root) and UC-05 service: `node --test tests/runtime/integration/uc03-approvals.test.ts`; Docker rows: `node dist/tests/runtime/integration/uc03-approvals-real-probe.js` | No edit before explicit plan approval; stale/rejected/forbidden decisions cause zero patches and zero executor calls; a revised plan needs a fresh decision; continuation re-observes; no `ScriptedApprovalPort` on the path | Any automatic approval or edit before a decision: fail |
| **T026/T066 route and matrix** (T053), controlled, zero model calls | Each gap recorded at UC-03 `tasks.md:197,527`: `node --test tests/runtime/unit/uc03-graph.test.ts tests/runtime/contract/atomic-admission-matrix.test.ts` plus emitted counterparts | Every recorded gap has an asserting row that failed before its fix and passes after (or is explicitly re-dispositioned with evidence); all 22 matrix cases assert the Section 10 fields | A gap without a witness keeps the task open |
| **T028 real success route** (T054), live model calls | Step 1, conformance: one call, requiring the returned model identity to equal `po/deepseek-ai/deepseek-v4.1-flash-1017` exactly. Then C01 (≤ 2 attempts), C02 (1 attempt), C16 report from the C01 run, and C10 refusal rows: `node dist/tests/runtime/integration/uc03-success-real-run.js --case <id>`. Checker: `node dist/tests/runtime/integration/uc03-success-real-evidence.js --evidence <dir>` | C01: baseline failure persisted, explicit plan approval, model-generated patch, focused/regression passes, protected tests unchanged, fresh reviewer accepts, independent snapshot grade passes on the same final snapshot. C02: expected clarification pause. C16: safe report. C10: a call over the per-run limit (or with absent limits) gives zero dispatch; pre-network durable reservation and observed-usage settlement in UC-04 accounting recorded. Requested/returned model, `endpointDigest`, scheme, profile, image, command-view digest and owner revisions recorded; cost labelled `estimate-unverified` or `unknown` | Model identity mismatch: stop, not-run. Failed repairs are retained observations. Credential bytes or the endpoint URL/host in any artifact: fail. Runaway stop reached: honest incomplete. **No G-REAL/SC-001 claim and no T011 change, whatever the outcome** |

The T028 runner drives `runUC03GraphV02` (`src/uc03/graph-v02.ts:93`) and `createSnapshotGrader` (`eval/uc03/workflow-grade.ts:261`) directly. It does not run the evaluation service or the `evaluate run` CLI, which are T011's path. The runners are named `*-probe.ts`/`*-run.ts`/`*-evidence.ts`, so the CI globs (`scripts/ci/run-runtime-tests.mjs:20-21`) never run Docker or live model calls.

## (g) Non-goals and provenance limits

Not released and not planned here: running T011, any G-REAL/SC-001 claim, T017 browser acceptance, G-RESTART or any restart claim, merge, T039. G-OWNERS stays single-attested, and the workers' UC-04/UC-05 code is not Thanh Tan's or Trong Tan's delivery. It counts toward X04-STATE/X05-GATE for these evidence runs only, by the user's decision (`decisions.md:109`). Also out of scope: an economic cap or spend ledger, verified pricing, a provider SDK, streaming, thinking mode, provider tools, automatic retry, a second task ledger, canonical schema changes, a production default profile in the repository, any real endpoint value in a tracked file, and changes to T001–T039 text or checkboxes.

## (h) Failure and recovery

| Failure | Required behaviour |
|---|---|
| Provider timeout after possible dispatch | Transport `uncertain`; the run limiter keeps the full admitted maxima; the UC-04 attempt stays uncertain. No retry; the run ends incomplete. Rerun only by an explicit new operator command on a fresh task |
| Provider 5xx / 429 | Observed failure; usage unknown, so the full admitted maxima stay counted. No retry or backoff loop; the run ends incomplete with a `provider` diagnostic. The operator waits and starts a fresh run |
| Run usage limit reached mid-run | Next call refused before `fetch` (`RUN_USAGE_LIMIT_REACHED`), zero dispatch; the graph ends incomplete and the task stays recoverable |
| Endpoint unreachable / connection refused | Treated as possible dispatch (`uncertain`), no retry; T054 stops after the conformance call fails |
| Insecure endpoint without acknowledgement | Profile refuses to load (`insecure-endpoint-unacknowledged`); zero effects |
| Endpoint or model ambiguous, or URL drift | Readiness refuses (`endpoint-ambiguous` / `model-ambiguous`); a per-call `href` mismatch is denied before `fetch` |
| Returned model identity mismatch | T054 stops the campaign after the conformance call; no further calls |
| Container OOM / timeout | Executor reports a failed check with the kill reason; no pass and no retry beyond the existing bounded repair allowance; the container is removed with cleanup that preserves uncertain evidence (T004) |
| Docker daemon absent | Readiness `unavailable` (`docker-unavailable`) before any task allocation; probes report not-run with a nonzero exit |
| Uncertain effects (patch, replan, baseline write, provider) | Continuation blocked until the owner `lookupOperation` returns `committed`/`absent`; `unknown` keeps it blocked; never blind replay (`context/runtime_policy.md:25`) |
| Stale approvals | UC-05 service refuses stale or changed bindings; a fresh decision is required; zero patch or executor effect |
| Credential missing | Readiness `unavailable` (`credential-missing`), zero effects |
