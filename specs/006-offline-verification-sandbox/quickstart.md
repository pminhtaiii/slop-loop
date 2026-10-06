# Quickstart: Validate Offline Verification Sandbox

This is the Phase 5 validation and evidence guide. Implementation and integration evidence is recorded in the project context; CI run #54 supplies source/native regressions on both hosts and Linux Docker evidence, and setup tasks T091 and T092 are complete. The Phase 5 exit gate remains open until successful Windows Docker Desktop Linux-mode fixture results, including preparation storage enforcement, are recorded. Feature number 006 is product Phase 5.

## Prerequisites

- The Phase 4 workspace-boundary prerequisite is satisfied by PR #164 / CI run #41 for implementation commit `0b990c03718fa9ae9f1f33de230f9cf53ff38d71`: Windows and Ubuntu Quality Gates passed for available fixtures. Linux bind-mount containment remains UNVERIFIED / UNAVAILABLE under the accepted, unchecked T088 MVP exception; it is not a containment PASS and does not independently block Phase 5 completion.
- Node.js 24, pinned pnpm 12.5.1, a frozen install and standard `pnpm native:build` on the host. Windows requires Visual C++ Build Tools; a diagnostic alternate build does not satisfy the standard gate.
- Local Linux Docker Engine, or Docker Desktop on Windows in Linux mode, with verified CPU/memory/PID/readonly/seccomp/tmpfs support and trusted local daemon identity.
- A developer-provisioned digest-pinned toolchain base containing Node, pnpm, Git, Python, compiler/make and matching Node headers. Verification never pulls the base or installs tools.
- Developer-maintained approved-source/exact-script policy and required bounded builder storage for preparation. No private registry credentials, repository Dockerfile or host secret mounts.
- Application-owned temporary preparation network/broker support that passes no-direct-bypass and public-destination fixtures. These are prep-only resources, not verification sidecars.

## Source and contract checks

From the root after implementation:

```sh
pnpm install --frozen-lockfile
pnpm native:build
pnpm exec vitest run tests/sandbox/config.test.ts tests/sandbox/snapshot.test.ts tests/sandbox/profiles.test.ts tests/sandbox/preparation.test.ts tests/sandbox/downloads.test.ts tests/sandbox/broker.test.ts tests/sandbox/verification.test.ts tests/sandbox/gateway.test.ts tests/sandbox/lifecycle.test.ts tests/sandbox/cleanup.test.ts
```

Confirm unsupported sources/hooks, wrong exact script identity, missing/current authority, image/tag replacement, mixed snapshots, copied-byte mismatch, stale final comparison, capture overflow/retry exhaustion, and cleanup uncertainty all return their specified outcomes with zero unauthorized execution. Tests use fake ports for unavailable adapters; fake tests do not replace the real gate.

## Developer preparation

The `pnpm sandbox:prepare` helper is developer-only and is not a registered agent tool. It accepts trusted app configuration and an explicit confirmed developer action bound to the current dependency fingerprint. Do not infer approval from repository text or a model message.

```sh
pnpm sandbox:prepare
```

Observed CI behavior: supported locked public dependencies are fetched with no hooks/scripts through the enforced broker; installation/approved dependency builds then run offline. A successful immutable image/preparation record appears in private application storage. Failure/cancellation publishes no valid replacement, leaves the last good image intact and cleans positively owned partial resources. Confirm the exact-identity script policy does not blindly import this repo's name-keyed `allowBuilds: esbuild`.

The helper does not start/resume a coding task. Its later interactive prompt belongs to Phase 8. A reference fixture can supply the explicit developer action in the E2E harness.

## Real Docker boundary and preparation checks

The `pnpm sandbox:test` command runs the host-owned integration/E2E harness, not inside an agent verification container:

```sh
pnpm sandbox:test
```

Evidence-covered fixture set:

1. Capture a checkout with approved edits/untracked source and excluded `.git`, secrets, nested repos, host dependencies and old native outputs. Compare copied bytes/manifest identity; prove observed copy races retry at most 3 times and instability stops verification.
2. Run tests/lint/typecheck/build in distinct fresh containers cloned from the same snapshot. Native-consuming checks rebuild current `.cc` sources offline with prepared headers. No host `.node` output is reused.
3. Attempt root/system writes, checkout/home/socket access, external/private/loopback egress, process flood, excessive memory/disk/output and timeout. Assert finite limits, bounded sanitized diagnostics, no host mutation and no unlimited daemon logs.
4. Exercise the controlled local test registry/broker: exact locked artifacts pass; absent integrity, corrupt bytes, disallowed source/redirect/private IP/DNS rebinding/direct bypass fail. Local fixture transport is explicit trusted test configuration, not production allowlist relaxation.
5. Show that scripts cannot run in fetch, and offline script builds require every exact locked occurrence. Missing cached packages, native prerequisites or environment identity block without network/installation fallback.
6. Cancel during snapshot enumeration/copy/rescan, transfer, start/native build/check/cleanup and simulate daemon outage. Capture cancellation removes partial staging and starts no container. No late result resumes execution or completes a cancelled task; unconfirmed cleanup keeps fencing and reports resource identity.
7. Restart with positively owned and unrelated/conflicting resource fixtures. Only validated owned resources are eligible for cleanup; no global prune.

Record exact engine/platform/version/limits and fixture outcomes on Ubuntu and Windows Docker Desktop Linux mode. An unavailable required fixture is an unsatisfied integration gate, not a pass or silent skip. Windows CI runners without Linux Docker may run source tests but require separately recorded Docker Desktop evidence before declaring both-host readiness.

## Lifecycle and freshness E2E

```sh
pnpm exec vitest run tests/sandbox/verification.e2e.test.ts
```

- Valid image: Edit fixture → stable snapshot → fresh per-check containers → complete matching evidence → final checkout comparison → fresh passing verdict.
- Stale image: task ends terminal `BLOCKED`, edits remain, zero verification code starts → explicit developer preparation → new admitted task reevaluates repository → new snapshot/checks/result.
- Change dependency inputs after preliminary image readiness: captured fingerprint disagrees → block before launch.
- Source-only edit: preparation remains reusable; changed source is included in a new snapshot.
- Edit after checks: historical pass stays bound to the old snapshot, freshness is stale, no passing current-attempt event and no changed-task completion.
- Audit append failure before dispatch: zero executor calls. Result persistence failure after a possible effect stops continuation and never reruns the check.
- One successful tool call, targeted test subset, duplicate check, bare success boolean or replayed verdict never completes verification. Required full checks retain one snapshot across calls; retries have fresh identities and no carried coverage.

## Full quality gate and reference self-verification

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
pnpm sandbox:test
```

The sandbox's reference target test profile selects ordinary source/native tests explicitly and excludes the host-owned Docker harness. This prevents recursive self-verification from demanding a Docker socket or privileged nested execution. The outer full quality/integration/security gate runs those excluded harnesses; CI run #54 passed the Docker-gated integration, security, recovery and E2E checks on native Linux Docker, with T091 and T092 complete. Windows Docker Desktop Linux-mode fixtures, including preparation storage enforcement, remain required before closing the Phase 5 exit gate. Their exclusion inside the container is not evidence they passed.

## Exit gate

The Phase 4 prerequisite is already satisfied under the accepted T088 exception; T129 may rerun it as final regression verification. Declare Phase 5 ready only after its contract/unit/security/integration/E2E suites, frozen pinned gate, enforced source/script/builder bounds, real platform hardening and cleanup/freshness fixtures pass. Record observed Phase 5 evidence in `coding-agent-context/context/testing.md` and status in `progress-checker.md`. Keep all later model/CLI/grant/durable-audit integrations explicitly deferred where still absent.
