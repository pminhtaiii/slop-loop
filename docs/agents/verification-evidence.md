# Verification evidence guide

## Local timeout escalation

If a local test/check reaches its timeout without a concrete result, retain its command, candidate, elapsed time, partial output and termination status as inconclusive (`BLOCKED`, never PASS). Stop that check and further local retries, timeout increases, alternate wrappers and full-suite diagnosis for the same unresolved timeout. Continue independent implementation or review work, then commit the coherent scoped candidate and use the authorized [PR-first push-only publication](pr-workflow.md#publish-a-draft). Standing coordinator publication authority applies; workers return their evidence and next action to the coordinator.

Use the matching current-head GitHub Actions result to resolve the deferred check. Retain the local inconclusive receipt separately from the CI result. An assertion, compilation or collection failure already observed is a concrete failure and remains failed even if a later part times out. Diagnose actual CI failures within the authorized repair scope. Pending CI, cancelled/timed-out CI, missing relevant coverage or an unavailable required profile leaves the criterion incomplete; green unrelated jobs do not establish acceptance. If the existing workflow does not run the deferred check, record the coverage gap and obtain applicable CI evidence within the authorized scope.

Full local suites are optional when explicitly requested; do not run them as a prerequisite for draft publication. This policy changes where evidence is obtained, not the acceptance criteria, exact-head CI gates or human merge authority.

## Focused compiled boundaries

For changed CLI entry points, generated modules or subprocess fixtures, select a focused source test and its freshly built emitted counterpart. Literal `.ts` specifiers inside generated module text survive TypeScript import rewriting; use the executing layout to resolve those paths. A source-only pass does not establish emitted behavior.

When local focused execution is usable, build through the existing package build command, then invoke the matching file under `dist/tests/` with `node --test`; never use stale emitted files as evidence. Run only the selected test, not the whole runtime lane. The existing CI build/runtime lanes can provide this evidence instead. Record the boundary as awaiting exact-head CI when deferred, and apply the timeout policy above if the local build or test times out without a concrete result.

## Retained verification evidence

Before contributor completion, the coordinator records the independent merger's verdict separately from code review. Draft publication and CI can proceed while this verdict is incomplete. A required criterion without applicable passing evidence keeps task acceptance incomplete; successful publication or green unrelated jobs do not close it.

Freeze a clean committed candidate. In the ignored managed session, the coordinator pins an immutable schema-v1 manifest and retains its SHA-256 separately from worker-controlled evidence. The manifest contains:

- `head`: full current commit SHA.
- `coordinator`: `{ owner, agentId }`; `implementers`: a nonempty array of the same shape, including the coordinator when it authored changes.
- `merger`: `{ owner, task, session, agentId }`, matching its registered worker assignment in this checkout and session. Its owner and host agent ID differ from the coordinator and every implementer. The coordinator is also registered in the same session.
- Nonempty `sources` and `inputs`: `{ path, sha256 }` arrays naming the approved acceptance sources and relevant implementation/test/configuration files.
- `criteria`: `{ id, source, expected, allowedTiers, requiredChecks }` entries. `source` names a pinned source path; `expected` is the factory-owned outcome, and `requiredChecks` lists exact check IDs. Preserve these criteria across repairs.

The merger supplies a separate schema-v1 receipt containing `head`, `manifestSha256`, and `criteria`. Each result has `{ id, status, tier, observed, checks }`; statuses are `passed`, `failed`, `blocked`, or `not-run`. Each check has `{ id, status, command, exitCode, artifacts }`, with artifacts as `{ path, sha256 }`. A passing criterion requires every declared check to pass with exit 0 and nonempty retained artifacts. Missing criteria appear as `not-run`; failure or inconclusive evidence can be recorded but cannot complete the assignment. For a CI-deferred criterion retain the exact-head job URL and relevant output as artifacts after CI actually runs; pending CI supplies no pass.

```powershell
node scripts/agents/pr-workflow.mjs record-verification --manifest .agent-work/<date>/<session>/verification-manifest.json --manifest-sha256 <coordinator-retained-sha256> --receipt .agent-work/<date>/<session>/merger-evidence.json
```

Recording and completion check the clean current head, source/input hashes, registry binding, manifest/receipt hashes and artifact bytes. Paths stay in the checkout and cross no symbolic links. Completion re-reads the retained evidence; changing the head, manifest, receipt, source, input or artifact requires affected verification against the new candidate. Use a new artifact path rather than overwriting dispatched evidence. `status` exposes the stored criterion summary separately from publication/CI status; it is not a fresh artifact validation. A historical review or CI result cannot be repinned to claim a new run.

This is trusted local coordinator accounting. The registry and supplied host IDs are not host-authenticated attestations, and a hash cannot determine whether a claimed observation is true. Independent behavioral verification and semantic review remain necessary. Workers report missing scope or judging-material gaps rather than changing the manifest to obtain a pass.
