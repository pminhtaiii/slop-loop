# Milestone 3 — trusted developer preparation evidence

Date: 2026-10-09. Scope F03/F04/F08. **IN PROGRESS; NOT ACCEPTED.** Phase 5 OPEN.

The sections through the original final verdict below preserve the preceding checkpoint. The continuation section supersedes its file inventory, verification counts and review outcome; it does not retrospectively upgrade the earlier evidence.

## Baseline

Branch feat/006-offline-verification-sandbox; HEAD 3ffc98653a1a6564e1cdbdc51b3cc3fb3b282033 (`feat(sandbox): wire trusted snapshots and verification execution`). Initial working tree clean. No commit/push/branch change or Milestone 4 work authorized.

## Scope and skill routing

Read developer attachment, context/standards, constitution (unratified template), ADR 0011, spec/plan/contracts and existing preparation/download/broker/archive adapters. Use scoped speckit-converge/implement methodology, codebase-design, TDD at the six developer-approved seams, code-review for independent Standards/Spec axes, verification-before-completion for fresh results. No global backlog execution or task-status rewrite. Existing ADR/context Linux implementation claims do not prove the missing preparation composition on this HEAD.

## Developer constraints and architecture decisions

Developer explicitly confirmed Docker, immutable base/toolchain and whole-builder quota have not been provisioned. No real downloads, builds, preparation, quota exhaustion or installation is authorized in this run. Source/contract implementation may proceed; missing prerequisites must BLOCK rather than trigger installation.

Developer approved supplementary application-owned Node tarball fetch in the same isolated fetch container, via the same CONNECT broker/no-bypass, alongside pinned `pnpm fetch`. Actual tarball SRI alone does not establish store integrity. Subsequent design decision: **normalized virtual-store**, not host SQLite/msgpackr decoding. After network shutdown, offline materialization disables all scripts/hooks. Validate complete package content per exact locked identity (paths/bytes/modes/links), classify only known trusted manager-generated wrappers/metadata, reject missing/extra/modified files, and discard CAS only after full validation. Exact-approved scripts run offline afterward; needing unverified CAS again must BLOCK. Producer freeze, bounded safe transfer, quota admission and immutable publication remain mandatory.

Research: [pnpm fetch documentation](https://pnpm.io/cli/fetch) describes virtual-store fetch and offline install. [Pinned store-index implementation](https://raw.githubusercontent.com/pnpm/pnpm/v12.5.1/pnpm/crates/store-dir/src/store_index.rs) uses v11/index.db and msgpackr records. Actual `pnpm.cmd store --help` has status/add/prune/path, no complete-manifest export. A usage/status result is not tarball-to-tree provenance. No new decoder dependency was added.

## Current RED/GREEN evidence

| Behavior                                                   | Observed RED                                                               | GREEN                                                                                                                                                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current developer confirmation from selected safe checkout | Missing createPreparationAction (production seam absent).                  | Safe held-handle manifest/lock reads, current fingerprint, action-local opaque receipts, exact challenge, single consumption and changed-input rejection. Legacy labelled binding is not used by this new seam. |
| Closed lock/config grammar                                 | Missing parseLockedGraph (production seam absent).                         | Strict Zod graph schema; validates pinned-manager plus application documents, importers, snapshots, references, platform metadata and manifest/lock agreement; strips root scripts from sanitized manifest.     |
| Reference graph coverage                                   | Unsupported locked graph because rollup carries npm engine metadata.       | Explicit bounded npm engine field; whole current lock graph passes. No unknown-field passthrough in lock graph.                                                                                                 |
| Exact download destination                                 | Credentials/nonstandard-port artifact URL accepted.                        | Credentials and non-443 ports rejected.                                                                                                                                                                         |
| Actual downloaded-byte integrity                           | Missing verifyArtifactBytes during observed regression run.                | Canonical digest encoding, expected digest length, actual digest and constant-time comparison; corrupt bytes rejected. This function still needs production fetch composition.                                  |
| Unsupported archive metadata                               | PAX record resolved successfully after tar-stream normalization.           | Raw bounded grammar rejects PAX/GNU/sparse before maintained parser; metadata/size/truncation checks.                                                                                                           |
| Special-use IPv6 broker destination                        | 2001:db8::1 and 2001::1 classified public.                                 | Narrow global-unicast policy rejects documentation/transition ranges. Encoded mapped-private regressions remain denied.                                                                                         |
| Actual tarball/package content                             | Missing packagecontent module; no collected tests in that first RED.       | SRI-verified gzip/tar bytes produce immutable per-file path/byte/mode/SHA256 manifests; exact package.json name/version checked. Extra executable rejected.                                                     |
| Control-character path                                     | NUL-containing path reached comparison instead of path-policy rejection.   | Shared archive sanitizer rejects ASCII controls before downstream filesystem use.                                                                                                                               |
| Normalized payload observation                             | Missing verifyNormalizedPackageTar function.                               | Hashes actual streamed regular bytes instead of trusting caller-supplied hashes. This is **package-only**, not complete-store provenance.                                                                       |
| Async artifact binding                                     | Mutating input integrity during parsing changed the issued manifest's SRI. | Frozen artifact copy at entry and retained byte copy preserve checked identity.                                                                                                                                 |
| Unexpected normalized directory                            | Extra directory resolved successfully.                                     | Every observed directory must be a canonical parent of an expected file, with mode 0755.                                                                                                                        |
| Digest preflight                                           | sha512-AA== admitted.                                                      | Strict graph checks canonical encoding and algorithm-specific digest length before fetch admission.                                                                                                             |
| Unsupported peer source                                    | git+ssh peer range admitted.                                               | Unsupported peer specifiers denied before network admission.                                                                                                                                                    |
| Manager importer coverage                                  | Manager document missing pnpm package/snapshot admitted.                   | Requires pnpm@12.5.1 package and snapshot in the manager graph.                                                                                                                                                 |
| Ordinary profile coverage                                  | Preparation provenance tests absent from explicit selection.               | Added all three new source-only suites; no Docker integration harness added.                                                                                                                                    |

Replay/cross-action receipt coverage was additionally run GREEN (not claimed as a separately observed RED cycle). Initial archive fixture typecheck found `pax` absent from tar-stream Headers typing; using a structurally typed header variable retains the actual PAX payload without a type assertion. Focused command `pnpm.cmd exec vitest run tests/sandbox/broker.test.ts tests/sandbox/archive.test.ts tests/sandbox/lockedgraph.test.ts tests/sandbox/preparation-action.test.ts`: **34 PASS, 0 FAIL**. No real network or Docker proof.

Additional GREEN coverage (not separately claimed RED): actual tar fixtures for missing/extra/modified files, mode mismatch, duplicate paths, symlink escape, independent complete payload, forged package authority and multiversion substitution. Focused final command:

`pnpm.cmd exec vitest run tests/sandbox/config.test.ts tests/sandbox/broker.test.ts tests/sandbox/archive.test.ts tests/sandbox/lockedgraph.test.ts tests/sandbox/preparation-action.test.ts tests/sandbox/packagecontent.test.ts`

**65 PASS, 0 FAIL**. These are owned archive/real safe-workspace source tests, not pnpm preparation integration. No download, offline installation, dependency script or Docker build was executed.

## Review outcomes

CodeRabbit CLI 0.8.0 supports `--agent --uncommitted --include-untracked`. Before transmission, scanned all modified/untracked paths for private keys and common credential/token assignments; no candidate secret matched. Files are source/tests/evidence, no unrelated temporary artifacts. In-sandbox auth status misleadingly reports signed-out; unrestricted auth status confirmed authentication without supplying an API key. Round 1 completed, exit 0, terminal `review_completed`, 11 reviewed files including all five untracked files at that time. Two minor findings:

1. Evidence omitted the new package-content seam: updated this record, focused command and observed counts.
2. Quadratic snapshot coverage: collect validated base identities in a Set, retain missing-package/missing-snapshot checks. Existing graph regressions GREEN; this is a review refactor rather than a new security authority.

Independent Standards review identified missing manager-importer references; independent Spec review identified unsupported peer sources. Both had observed RED failures and GREEN corrections. Spec review also identified incomplete whole-tree provenance: **OPEN blocker**, not waived by package-only stream comparison. Supporting review includes untracked files and the actual working-tree diff against 3ffc98653a1a6564e1cdbdc51b3cc3fb3b282033, not empty committed three-dot diff.

CodeRabbit round 2: completed, exit 0, terminal `review_completed`, **0 findings**, reviewed all 13 files listed in the inventory. Both round-1 minor findings resolved. Standards/Security re-review: no remaining definite source findings or reportable heuristic smells; acceptance blocker explicitly retained. No further CodeRabbit fix/review cycles run. Final evidence-only additions record the terminal results after review; no subsequent source/test change.

Independent final Specification review: **two P1 acceptance findings remain OPEN**: complete normalized-tree authority, and production preparation/effective quota composition. Earlier peer-source/manager/identity/profile corrections accepted at source level. No new definite source contradiction or scope creep identified. These open source gaps are independent of Docker availability; provisioning Docker alone would not make this implementation ready.

## Verification environment and commands

Windows x64; Node 24.14.0; pinned cached pnpm package 12.5.1, bootstrap shim 10.33.2. `pnpm.cmd --version` in restricted sandbox attempted manager bootstrap and failed EPERM; no successful install/download was performed. Disabling manager auto-selection reports the outer shim's 10.33.2, not the project's pinned manager. The existing cached pinned manager shim under `%LOCALAPPDATA%\pnpm\.tools\pnpm\12.5.1\bin\pnpm.cmd` returned **12.5.1**, exit 0, without provisioning. All successful quality commands use the existing unrestricted cached pinned manager. No frozen install performed in this dirty checkout, no lock/dependency changes.

Spec Kit prerequisites initially select persisted Feature 007 even with SPECIFY_FEATURE set to 006. Do not persist a different feature pointer or run global Feature 007 workflows; this milestone explicitly reads Feature 006 and applies scoped implementation/convergence methodology. No before/after implement/converge hooks configured.

| Command                                       | Observed outcome                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Native build using local Python/headers below | PASS, exit 0; node-gyp 12.4.0, Python 3.12.11, VS2026 BuildTools 18.10.12224.181                 |
| pnpm.cmd lint                                 | Initial FAIL on typing/regex/unbound-method rules; corrections applied; final PASS exit 0        |
| pnpm.cmd format:check                         | PASS exit 0                                                                                      |
| pnpm.cmd typecheck                            | PASS exit 0, source and test projects                                                            |
| pnpm.cmd test                                 | 609 PASS, 32 SKIPPED, 0 FAIL; 56 files; final rerun after all source corrections, exit 0, 52.99s |
| pnpm.cmd build                                | PASS exit 0                                                                                      |
| pnpm.cmd smoke                                | PASS exit 0, application started                                                                 |
| pnpm.cmd sandbox:test                         | 218 PASS, 15 SKIPPED, 0 FAIL; 30 files                                                           |
| git diff --check                              | PASS, no whitespace errors                                                                       |
| Get-Command docker                            | UNAVAILABLE: executable not found; no daemon/engine/image inspection, no Docker action           |

Native command: `$env:PYTHON='C:\msys64\ucrt64\bin\python.exe'; $env:npm_config_devdir=(Resolve-Path 'node_modules\.cache\node-gyp-plain').Path; pnpm.cmd native:build`. Existing local headers/toolchain used; no header download.

Skipped fixtures retain their actual classification: 15 sandbox Docker cases UNAVAILABLE, remaining full-suite skips require unavailable platform capabilities. Unit/fake-port integration-style tests are source/contract tests, not real Docker preparation proof. Linux dedicated builder and Windows Docker Desktop Linux mode preparation/no-bypass/quota-exhaustion fixtures were NOT RUN; no effective engine/storage/quota evidence.

## Changed-file inventory

Modified: src/sandbox/archive.ts, broker.ts, config.ts, downloads.ts, preparation.ts; tests/sandbox/archive.test.ts, broker.test.ts, config.test.ts.

Untracked additions: src/sandbox/packagecontent.ts; tests/sandbox/lockedgraph.test.ts, packagecontent.test.ts, preparation-action.test.ts; this milestone-3-evidence.md. They are included in review and fresh test discovery. No git staging/commit/push performed. Native build outputs and dist remain ignored generated output.

Final `git status --short`:

```text
 M src/sandbox/archive.ts
 M src/sandbox/broker.ts
 M src/sandbox/config.ts
 M src/sandbox/downloads.ts
 M src/sandbox/preparation.ts
 M tests/sandbox/archive.test.ts
 M tests/sandbox/broker.test.ts
 M tests/sandbox/config.test.ts
?? specs/006-offline-verification-sandbox/milestone-3-evidence.md
?? src/sandbox/packagecontent.ts
?? tests/sandbox/lockedgraph.test.ts
?? tests/sandbox/packagecontent.test.ts
?? tests/sandbox/preparation-action.test.ts
```

## Requirement-to-code matrix

| Gap | Implemented evidence                                                                                                                                                                | Acceptance still missing                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F03 | preparation.ts current safe inputs/action-local challenge/opaque single-use confirmation; preparation-action tests use owned real Git checkouts                                     | Integrated developer helper, concurrency admission, full preparation workflow/private atomic publication; existing scripts/prepare-verification.ts remains legacy diagnostic                               |
| F04 | downloads.ts strict whole graph and actual-byte SRI; broker.ts destination denial; archive.ts bounded raw grammar; packagecontent.ts actual tarball and exported-package comparison | Concrete restricted CONNECT/no-bypass fetch, offline materialization, complete normalized tree/peer edge/wrapper/link authority, CAS discard fence, exact scripts, producer freeze and safe final transfer |
| F08 | No effective quota implementation claimed                                                                                                                                           | Concrete independently enforced whole-builder quota/engine/storage admission, accounting and exact-platform exhaustion evidence                                                                            |

## Normalization proof blocker and proposed continuation

This run has **not established full normalized virtual-store provenance**. A successful `verifyNormalizedPackageTar` establishes only one package's supplied archive bytes. It does not establish producer freeze, placement/peer context, total tree coverage, pnpm-generated executable wrappers/metadata, complete dependency link closure or the absence of unchecked CAS use. It returns no preparation/publication receipt. No production caller was wired to treat this result as permission to run scripts, discard CAS or publish.

The next design must derive an application-owned expected normalized layout from the validated frozen graph plus verified artifact manifests, check every actual exported tree entry, bind every peer-context placement and relative link, and reproduce/check only explicitly trusted pinned-manager wrappers/metadata. Unknown generated executable bytes must block. Manager metadata, package names/versions, caller-supplied hashes or Windows host node_modules cannot supply that authority. This is further source work within Milestone 3, **not a claim that normalized equivalence is impossible** and not permission to fall back to a SQLite decoder or unchecked CAS.

Per developer's stop condition, do not connect the unproved comparison to privileged execution/publication. Source/contract acceptance remains blocked as well as real integration. Production pipeline is still incomplete; do not report these primitives as the requested end-to-end preparation pipeline.

## Remaining work before acceptance

Production broker/no-bypass, whole-tree normalized content authority, offline exact scripts, safe frozen import/export, effective quota adapter/admission, immutable image/private record publication and integrated helper are not yet complete. Docker/base/toolchain/whole-builder quota and exact engine/storage identity unavailable on this Windows x64 environment. Real preparation/storage integration remains UNAVAILABLE; no quota-exhaustion fixture run. Durable ownership/restart recovery remains Milestone 4. T162, T129 and T131 remain OPEN; T088 remains accepted UNVERIFIED/UNAVAILABLE; no task status changed and no final context synchronization performed. No commit/push/branch change or Milestone 4 work.

Final verdict: **BLOCKED — incomplete source/contract pipeline and unproved complete normalized-tree authority; real preparation/storage integration UNAVAILABLE.** Package-level/source regression PASS and CodeRabbit 0 findings do not satisfy Milestone 3 acceptance. Stop for developer review before further privileged preparation work or any next milestone.

## Continuation after developer decision BLOCKED — CONTINUE IMPLEMENTATION

Branch and HEAD rechecked: `feat/006-offline-verification-sandbox`, `3ffc98653a1a6564e1cdbdc51b3cc3fb3b282033`. The initial continuation working tree already contained the preceding uncommitted work; it was preserved. No reset, branch change, commit, push or Milestone 4 work. No actual downloads, Docker builds/preparation or quota-exhaustion actions. Research only read pinned upstream implementation sources.

Applied codebase-design and scoped speckit-implement/converge methodology at the approved graph/content/broker seams; TDD for the new behavior; code-review for independent Standards/Security and Specification axes; verification-before-completion for fresh gates. No task edits, spec/plan weakening, additional dependency or skill-file change.

### Architecture and source progress

`downloads.ts` now derives immutable Linux x64/glibc placements, importer roots and required/optional dependency edges from the authenticated frozen graph. Peer suffix artifacts must exist, and declared resolved peer contexts must match their dependency edge. Unsupported required platforms block. Slot names follow the pinned manager's escaping and SHA-256 shortening rather than caller-supplied placement evidence.

`packagecontent.ts` derives immutable bin paths and lifecycle commands from actual SRI-verified package.json bytes. Missing bin files and unsupported directory-bin declarations reject. Command metadata is not permission to execute scripts.

New `dependencytree.ts` compares actual streamed regular payload hashes/bytes/modes against those verified package manifests at derived locked placements. It checks root/dependency/bin links, collisions, total entry/byte/metadata limits and parent directories; unknown entries fail. A trusted executable-mode transformation accounts for signed bin files. Canonical relative target spelling is required before link-chain comparison; interior `..` cannot be collapsed across a symlink. This is **comparison only**, returning no execution/preparation/publication receipt. Manager metadata, per-context bin generation, frozen producer binding, sealed relay and CAS discard are not yet fully supported. Unsupported manager-generated entries reject rather than being ignored. No production consumer treats this diagnostic success as full-tree authority.

New `connectbroker.ts` implements a real Node HTTP CONNECT listener and production DNS/socket defaults: only `registry.npmjs.org:443`, fresh public-address validation, an IP-pinned upstream, no second DNS resolution, finite sessions/headers/bytes/connections and explicit owned socket cleanup. Ordinary HTTP requests reject. IPv4 documentation/special-purpose destinations now reject. This module is not yet composed with Docker's private preparation network, namespace firewall/no-bypass fixture or preparation orchestration; it cannot independently establish no-bypass or inspect encrypted artifact paths. No real upstream connection/download was performed by tests.

The ordinary source profile explicitly includes both new suites. Gateway, runner, verification receipt/observation and reducer source remain unchanged.

Pinned research sources: [placement escaping](https://raw.githubusercontent.com/pnpm/pnpm/v12.5.1/pnpm/crates/deps-path/src/dep_path_to_filename.rs), [slot shortening](https://raw.githubusercontent.com/pnpm/pnpm/v12.5.1/pnpm/crates/crypto-hash/src/lib.rs), [Unix bin-link option](https://raw.githubusercontent.com/pnpm/pnpm/v12.5.1/pnpm/crates/cmd-shim/src/link_bins.rs), [modules metadata format](https://raw.githubusercontent.com/pnpm/pnpm/v12.5.1/pnpm/crates/modules-yaml/src/lib.rs). These are implementation references, not real preparation evidence or approval of an incomplete normalization recipe.

### Additional RED → GREEN evidence

| Behavior                                         | Observed RED                                                    | Observed GREEN                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Signed bin/lifecycle metadata                    | `verified.bins` was undefined                                   | packagecontent suite 14 PASS                                                                          |
| Bin executable-mode transformation and root link | Dependency tree content mismatch for unchanged signed bin bytes | dependencytree positive bin case PASS                                                                 |
| Missing peer artifact                            | Graph admitted absent peer identity                             | lockedgraph suite rejects `Missing locked peer`                                                       |
| Declared peer edge binding                       | Graph admitted a resolved context without matching edge         | rejects `Locked peer edge mismatch`; current reference lock still PASS                                |
| Symlink traversal review correction              | Interior `..` after an alias resolved successfully              | rejects `Dependency tree link mismatch`                                                               |
| Special-purpose IPv4                             | Five reserved addresses returned public=true                    | broker suite 24 PASS; synthetic success fixture uses public literal, without making a network request |
| Concrete CONNECT                                 | Stub rejected `CONNECT broker unavailable`                      | owned loopback listener pins fake upstream address; suite PASS                                        |
| Idle owned socket cleanup                        | `close()` exceeded the test deadline                            | all accepted sockets tracked/destroyed; cleanup regression PASS                                       |
| Ordinary selection                               | New dependencytree suite missing from fixed profile             | config suite 15 PASS; both new suites selected                                                        |

Additional GREEN coverage: full-tree missing/modified/mode/duplicate/hardlink/escape/self-cycle negatives; forbidden CONNECT host/port/credential authorities are rejected before resolution; mixed public/private DNS never opens an upstream socket. These supplement the observed RED cycles and are not labelled as separately observed RED. The dependencytree suite has 13 tests, lockedgraph 9, packagecontent 14 and connectbroker 7.

### Fresh verification

Environment Windows x64, Node `24.14.0`, cached pinned pnpm `12.5.1`, Vitest `3.2.7`, node-gyp `12.4.0`, Python `3.12.11`, VS BuildTools `18.10.12224.181`. HEAD remains the baseline above.

| Command                                                                                               | Actual outcome                                                                                                                           |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Native build command recorded above                                                                   | PASS, exit 0; cached local headers/toolchain, no download                                                                                |
| `pnpm.cmd lint`                                                                                       | Initial FAIL: seven typing/require-await/prefer-const errors in new code; corrected; final PASS, exit 0                                  |
| `pnpm.cmd typecheck`                                                                                  | PASS, exit 0                                                                                                                             |
| `pnpm.cmd format:check`                                                                               | PASS, exit 0                                                                                                                             |
| `pnpm.cmd test`                                                                                       | **637 PASS, 32 SKIPPED, 0 FAIL**, 58 files; after final peer/source corrections                                                          |
| `pnpm.cmd build`                                                                                      | PASS, exit 0                                                                                                                             |
| `pnpm.cmd smoke`                                                                                      | PASS, exit 0, current built entrypoint                                                                                                   |
| `pnpm.cmd sandbox:test`                                                                               | **246 PASS, 15 SKIPPED, 0 FAIL**, 32 files                                                                                               |
| `pnpm.cmd exec vitest run tests/sandbox tests/orchestration tests/tools tests/policy tests/workspace` | Earlier continuation checkpoint: 576 PASS, 32 SKIPPED, 0 FAIL; subsequent negative/peer additions verified by the final full suite above |
| `git diff --check`                                                                                    | PASS, exit 0                                                                                                                             |
| `Get-Command docker -ErrorAction SilentlyContinue`                                                    | UNAVAILABLE: no Docker executable on this Windows environment                                                                            |

The 15 Docker fixture skips are **UNAVAILABLE**, not real Docker PASS. Full suite's other 17 skips remain platform-dependent. All new archive/content tests consume actual owned fixture bytes; CONNECT tests use an actual owned loopback server and fake upstream ports, with no real registry traffic. Neither classifies as real Docker/preparation E2E. Linux/Windows builder quota, base image/toolchain provisioning, effective engine/storage identity and quota exhaustion remain unverified. No frozen reinstall was necessary or run in this dirty checkout; existing cached dependencies retained.

### Independent review and CodeRabbit

Independent Specification review found a P1 link mismatch: lexical normalization could accept a dangling bin target through a symlink followed by `..` (contract sandbox.md relative links must resolve to existing in-root targets). Standards/Security separately reproduced the same defect with a self-referential root alias. Disposition: **FIXED** using canonical relative target validation, with observed RED → GREEN and both regression variants retained. No reduction of receipt/cleanup/overflow guarantees.

CodeRabbit CLI `0.8.0` authenticated; flags checked from current `review --help`. Prior to transmission, all modified/untracked files were enumerated, scoped and scanned for private keys/common key/token signatures without printing matched content. No signatures or unrelated temporary files identified. Actual credential material was not passed as an argument or added to artifacts.

Round 1: `coderabbit review --agent --uncommitted --include-untracked` **completed, exit 0**, structured `review_completed`/`outcome: completed`, **17 reviewed files, 1 minor finding**. Finding: evidence inventory/git-status and test counts were stale. Disposition: corrected by this continuation section and final inventory below. No critical/major finding emitted by CodeRabbit. Its review does not certify specification completeness or close the acknowledged P1 acceptance gaps. Round 2 is pending fresh completion; do not interpret pending/failed review as zero findings.

### Final current file inventory

Modified: `src/sandbox/archive.ts`, `broker.ts`, `config.ts`, `downloads.ts`, `preparation.ts`; `tests/sandbox/archive.test.ts`, `broker.test.ts`, `config.test.ts`.

Untracked: `src/sandbox/connectbroker.ts`, `dependencytree.ts`, `packagecontent.ts`; `tests/sandbox/connectbroker.test.ts`, `dependencytree.test.ts`, `lockedgraph.test.ts`, `packagecontent.test.ts`, `preparation-action.test.ts`; this evidence file. All 17 files were included by CodeRabbit, and new test suites were discovered by full/sandbox regressions. No staging performed.

```text
 M src/sandbox/archive.ts
 M src/sandbox/broker.ts
 M src/sandbox/config.ts
 M src/sandbox/downloads.ts
 M src/sandbox/preparation.ts
 M tests/sandbox/archive.test.ts
 M tests/sandbox/broker.test.ts
 M tests/sandbox/config.test.ts
?? specs/006-offline-verification-sandbox/milestone-3-evidence.md
?? src/sandbox/connectbroker.ts
?? src/sandbox/dependencytree.ts
?? src/sandbox/packagecontent.ts
?? tests/sandbox/connectbroker.test.ts
?? tests/sandbox/dependencytree.test.ts
?? tests/sandbox/lockedgraph.test.ts
?? tests/sandbox/packagecontent.test.ts
?? tests/sandbox/preparation-action.test.ts
```

### Acceptance reconciliation and remaining source blockers

| Requirement                | Continuation evidence                                                                                                             | Still required                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F04 normalized provenance  | Exact signed package content at frozen-graph placements, peer binding, root/dependency/bin link comparison and attack regressions | Complete per-context bins/closed generated metadata, positively frozen producer identity, safe sealed transfer, CAS discard safety and script-execution authority       |
| F04 restricted network     | Concrete CONNECT transport, pinned address, reserved-address denial and owned cleanup                                             | Private Docker network/namespace firewall composition and no-bypass fixture, exact-artifact fetch alongside fixed pnpm fetch, offline materialization and exact scripts |
| F03 production preparation | Previous safe confirmation/input contracts retained                                                                               | End-to-end production composition and integrated helper; current developer script remains diagnostic                                                                    |
| F08 storage                | No effective quota authority claimed                                                                                              | Actual whole-builder effective quota adapter/admission and accounting, engine/storage binding and platform exhaustion proof                                             |

The two developer P1 source blockers are **not closed**. In particular, the diagnostic tree comparison must not be connected as authorization for scripts, CAS deletion or publication. Production offline scripts, frozen transfer, immutable publication/private records and integrated helper are still unfinished. No claim that normalized equivalence is impossible, no formal check substituted for the missing proof, and no SQLite decoder added. Durable resource/restart recovery remains Milestone 4. T162/T129/T131 OPEN, T088 accepted UNVERIFIED/UNAVAILABLE, Phase 5 OPEN.

Current recommendation: **BLOCKED — source acceptance remains incomplete; real preparation/storage integration UNAVAILABLE.** Fresh source/contract test PASS is reported separately and cannot upgrade either acceptance gate.

### Final security correction checkpoint (supersedes continuation test counts)

Independent re-review found two additional P2 defects, both confirmed and fixed through observed RED → GREEN:

- A signed tarball containing regular files `a` and `a/b` passed package/tree comparison. `parseTarStream` now checks every present ancestor's kind before returning entries, including lowercase aliases; a regular file or symlink cannot be an imported parent directory. The actual signed hostile archive now rejects `Archive parent is not a directory`.
- Concurrent CONNECT clients all passed the socket check before awaiting DNS. An actual test with 31 owned loopback clients and deferred fake DNS opened 31 fake upstreams (RED); post-DNS admission now rechecks the shared stream budget synchronously before opening/registering the upstream (GREEN).

Self-review additionally reproduced startup/close concurrency: `close()` cancelled listening but left `start()` pending. Explicit startup rejection on close settles both operations; regression RED `Unsettled broker startup`, then GREEN. New packagecontent suite has 15 tests; connectbroker has 9. All fake upstreams remain in-process streams, with no public network connections.

Both independent reviewers rechecked these corrections and reported no additional concrete defect in the corrections. This limited result does not close the acknowledged P1 full-tree authority/composition/quota blockers.

Fresh after-correction gates: `pnpm.cmd test` **640 PASS, 32 SKIPPED, 0 FAIL**, 58 files, exit 0; `pnpm.cmd lint`, `typecheck`, `format:check`, `build`, `smoke` and `git diff --check` PASS, exit 0. Native source/toolchain unchanged since the successful native build in this run. Final `pnpm.cmd sandbox:test` completed **249 PASS, 15 SKIPPED, 0 FAIL**, 32 files, exit 0. The preceding 246/15 count is historical. No Docker PASS claimed.

CodeRabbit round 2 completed, exit 0, `outcome: completed`, **0 findings**, all 17 files. That snapshot preceded the late independent security corrections above, so it is not presented as review of the latest source. One final review follows this second fix/review cycle; no automatic third fix/review cycle is authorized. No source acceptance or real Docker PASS claimed.

### Final CodeRabbit outcome and delivery

Final review: `coderabbit review --agent --uncommitted --include-untracked`, CLI 0.8.0, **completed, exit 0, 0 findings**, structured `review_completed` and `outcome: completed`, all **17 modified/untracked files** listed by the CLI. This third review invocation closes the second fix/review cycle after the initial review: first cycle fixed evidence staleness; second cycle fixed late independent source defects. No additional fix/review cycle run. Final source has not changed since the final review; only this outcome was added to evidence.

Disposition summary: CodeRabbit's one initial minor evidence finding FIXED; independently reproduced symlink-normalization, regular-file-parent and concurrent-DNS defects FIXED with RED/GREEN; self-review startup/close race FIXED with RED/GREEN. Independent reviewers rechecked corrections. No remaining concrete defect was identified in those corrections. The previously declared **two P1 acceptance blockers remain OPEN**, and this result must not be called complete production preparation or accepted SOURCE/CONTRACT.

Final delivery: **BLOCKED — partial source progress; complete normalized/frozen/CAS authority and production preparation/quota composition remain unfinished. Real preparation/storage integration UNAVAILABLE.** Full regression 640 PASS / 32 SKIPPED / 0 FAIL; sandbox 249 PASS / 15 SKIPPED / 0 FAIL. Native/lint/format/typecheck/build/smoke/diff-check PASS as recorded. Branch, baseline HEAD, 8 modified and 9 untracked files unchanged; no commit/push/staging, no real downloads/preparation/quota fixture, no Milestone 4 and Phase 5 remains OPEN. Stop for developer review.

## 2026-10-10 — final source implementation continuation

This section supersedes the historical **source-acceptance and test-count** conclusions above; earlier checkpoints remain intact as history. Branch `feat/006-offline-verification-sandbox`, HEAD `3ffc98653a1a6564e1cdbdc51b3cc3fb3b282033`; 9 tracked modified and 38 untracked files, 47 total. No file staged, committed or pushed. The working tree was preserved from the interrupted implementation. Windows x64, Node `24.14.0`, pnpm `12.5.1`, Vitest `3.2.7`. No frozen clean install was run. `Get-Command docker` found no Docker executable, so every real Docker/platform fixture is **UNAVAILABLE**.

### Source acceptance matrix

| Deliverable                   | Source implementation and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Source verdict                                                                                                  | Real Docker proof                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| M3-A complete normalized tree | `downloads.ts`, `packagecontent.ts`, `dependencytree.ts`, `normalization.ts`: validated frozen graph and actual tarball SRI; exact multiversion/peer-context placements, dependency links, per-context bins and manager-generated metadata/wrappers; immutable tree identity. `lockedgraph`, `packagecontent`, `dependencytree`, `normalizedtree`, `normalization` suites cover positive complete fixture and missing/extra/mode/link/peer/metadata mutations.                                                                        | PASS, closed recipe for pinned pnpm output                                                                      | UNAVAILABLE: pinned pnpm real output equivalence                                       |
| M3-B storage                  | `preparationstorage.ts` reads a dedicated Linux loop-block whole-builder boundary; `preparationcomposition.ts` validates private engine/quota/exhaustion records, admits before effects and holds a generation/identity-fenced `wx+` cross-invocation action lock. `preparationstorage` and `preparationcomposition` cover exhaustion, drift, concurrent factories, replacement/replay, partial initialization and uncertain settlement. Accounted bytes **do not** free a reservation until trustworthy free-space evidence changes. | PASS for source contract on the explicitly supported Linux mechanism; unsupported Windows configuration BLOCKED | UNAVAILABLE: effective Linux/Windows enforcement and disposable quota exhaustion       |
| M3-C restricted fetch         | `connectbroker.ts`, `connectbrokerentry.ts`, `preparationnetwork.ts`, `preparationruntime.ts`, `preparationworker.ts`: private network, trusted firewall/namespace acknowledgement, fixed private broker address, no privileged fetch container, fixed pinned pnpm fetch and exact-artifact actual-byte SRI. `preparationnetwork`, `connectbroker`, `preparationruntime`, `preparationworker` tests check identity, no setup bypass, ownership, SRI, time bounds and cancellation.                                                    | PASS source contract                                                                                            | UNAVAILABLE: real no-direct-bypass proof                                               |
| M3-D frozen transfer          | `produceradapter.ts`, `frozentransfer.ts`, `archive.ts`, `safeimport.ts`: quiescent producer/generation, sealed bounded export, complete manifest and exclusive safe import; publication checks frozen content before staging. Producer/archive/import/publication tests exercise drift, hostile entries, ownership and interrupted cleanup.                                                                                                                                                                                          | PASS source contract                                                                                            | UNAVAILABLE: real Docker freeze/export and Windows symlink capability                  |
| M3-E offline exact scripts    | `preparationworker.ts`, `offlinescripts.ts`, `preparationruntime.ts`: network disconnect, scripts-disabled offline materialization, full normalization, fresh CAS-free recipient, confirmed old-producer removal, exact-identity approved scripts (including authenticated `binding.gyp` implicit install), post-script checked outputs. Worker/runtime tests deny premature scripts, wrong identity, old CAS and incomplete removal.                                                                                                 | PASS source contract                                                                                            | UNAVAILABLE: pinned pnpm/native prerequisites and CAS-free execution in real container |
| M3-F immutable publication    | `preparationpublication.ts`: complete frozen content validation, private staging/build-context journals before directory/build effects, app-owned Dockerfile, immutable inspect and prerequisite smoke, bounded owned cleanup, atomic record and identity-fenced rollback. Publication and journey tests cover unknown candidate, stage cleanup, failed build/inspection/smoke, failed settlement, abort and old-good preservation.                                                                                                   | PASS source contract                                                                                            | UNAVAILABLE: real image build, inspect and smoke                                       |
| M3-G helper                   | `scripts/prepare-verification.ts`, `preparationcli.ts`, `preparationcomposition.ts`, `preparationcoordinator.ts`: developer confirmation, current fingerprint, quota/lock admission, concrete runtime, typed outcome and no model tool. CLI/composition tests invoke this production factory/helper under controlled ports.                                                                                                                                                                                                           | PASS source contract                                                                                            | UNAVAILABLE: actual developer preparation action                                       |
| M3-H source journey           | `preparationjourney.test.ts` and `preparationruntime.test.ts` invoke the production coordinator and concrete runtime through confirmation → validated graph → quota/lock → restricted fetch → actual-byte SRI → offline tree → frozen/CAS fence → exact scripts → verified publication → settlement. Negative journeys stop downstream effects at SRI, policy drift, malformed metadata, cancellation, cleanup and record failures.                                                                                                   | PASS controlled source contract; external ports are controlled, not Docker E2E                                  | UNAVAILABLE: Linux and Docker Desktop Linux-mode E2E                                   |

Production path: `runDeveloperPreparation()` → `createLocalPreparationConfiguration()` → `prepareVerification()` → `PreparationStorage`/private action lock → `DockerPreparationRuntime` with `DockerPreparationNetwork`/`ConnectBroker` and `runPreparationWorkerPhase()` → `freezeAndSeal()`/`normalizePnpmOutput()` → CAS-free recipient and `planOfflineScripts()` → second frozen export → `PreparedImagePublisher.buildFrozen()` → `writePreparedImageRecord()`/lease settlement. No model-visible preparation tool, checkout mount, host dependency-script fallback or automatic blocked-task resume was added.

### Final P1 corrections and RED → GREEN

- **Cross-invocation admission:** the earlier process-local reservation could not serialize two independently composed helpers. Tests `serializes builder actions across independently composed configurations` and `atomically admits exactly one concurrent builder action across separate factories` observed the previous admission failure, then passed with private `active-action.json` created exclusively and held by descriptor/inode/byte/generation identity. Replacement, hard-link, uncertain partial initialization and replay regressions pass. Unknown ownership retains the lock and reservation; no stale-lock deletion is attempted.
- **Pre-candidate publication ownership:** `persists owned build identity before the first Docker build effect`, `records build-context ownership before creating its private directory`, and `records private frozen-input staging ownership before creating the build context` observed missing journals before implementation. Each now passes with private fsync'd ownership journals written before its side effect. `retains the owned image journal after candidate creation until discard is confirmed` and `retains and removes an unpublished image when sanitized staging cleanup fails after build` pass. Unknown candidate/build completion retains ownership and accounting; only confirmed owned cleanup removes a journal.
- **Atomic READY/settlement:** `preserves the previous READY record when lease settlement fails after publication` observed a dangling replacement record. The record writer now returns a one-use identity-fenced rollback closure. `rolls back publication when cancellation arrives during the atomic record write` passes; failed rollback yields BLOCKED/UNCERTAIN and retains candidate ownership. No READY is returned before cleanup and lease settlement confirm.
- Additional observed RED → GREEN corrections after initial CodeRabbit: transport timeout for bounded offline worker versus artifact copy, bounded Docker build timeout, ordinary profile selecting the new CLI tests, fixed private broker bind address, and typechecking that address. A DEL-link regression confirms the existing sanitizer rejects traversal before link materialization; a second normalization rule that would reject legitimate in-root pnpm links was not added.

### Fresh verification after the final source/test edits

| Command                                                            | Outcome                                                                                        |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `PYTHON=C:\msys64\ucrt64\bin\python3.12.exe pnpm.cmd native:build` | PASS, exit 0, cached Node headers, node-gyp `12.4.0`, VS BuildTools; no network                |
| `pnpm.cmd lint`                                                    | PASS, exit 0                                                                                   |
| `pnpm.cmd format:check`                                            | PASS, exit 0 after formatting the two reported files                                           |
| `pnpm.cmd typecheck`                                               | PASS, exit 0 after fixed broker-address type correction                                        |
| `pnpm.cmd test`                                                    | **777 PASS / 33 SKIPPED / 0 FAIL**, 72 files, exit 0; fresh after CodeRabbit helper correction |
| `pnpm.cmd sandbox:test`                                            | **386 PASS / 16 SKIPPED / 0 FAIL**, 46 files, exit 0; fresh after CodeRabbit helper correction |
| `pnpm.cmd build`                                                   | PASS, exit 0                                                                                   |
| `pnpm.cmd smoke`                                                   | PASS, exit 0                                                                                   |
| `git diff --check`                                                 | PASS, exit 0                                                                                   |

The first native-build attempt was denied by the sandbox's `D:` canonicalization, then succeeded under approved local execution. An earlier parallel test run while native rebuild failed produced `NATIVE_UNAVAILABLE`; it was diagnostic and was superseded by the sequential successful native build and full 777-test pass. The initial final-gate format/typecheck failures were fixed and rerun to PASS. Skips include Docker-dependent fixtures and Windows platform limitations; they are not integration PASS.

### Review, inventory and remaining gates

CodeRabbit CLI `0.8.0` first completed review, exit 0, terminal `review_completed`, `outcome: completed`, **47/47 modified/untracked files**, six finding records. Dispositions: bounded transport/build timeout finding(s) FIXED with observed RED/GREEN; reservation-subtraction suggestion REJECTED because accounting does not prove host free-space release and would over-admit; profile selection and private broker bind FIXED; DEL-link normalization suggestion rejected with the existing sanitizer's specific path rejection regression; stale evidence addressed in this section. The second completed review, exit 0, again covered all 47 files and emitted one Minor finding: `runDeveloperPreparation()` conflated a throw from `prepareVerification()` with pre-preparation confirmation failure, reporting cleanup CONFIRMED. This was valid. Observed RED test `does not report confirmed cleanup when the coordinator throws after confirmation` received `CONFIRMED`; after the helper distinguishes post-confirmation entry, the composition suite is 23 PASS and the full/sandbox counts above are GREEN. Unexpected coordinator outcome now yields BLOCKED/UNCERTAIN, while pre-preparation confirmation failure retains its former response. The final CLI invocation completed, exit 0, terminal `review_completed`, `outcome: completed`, **47/47 files**, with one new Minor finding: the helper uses one-shot `SIGINT`/`SIGTERM` listeners; a repeated signal could terminate the process during cleanup. Both independent reviewers confirmed this is a real availability/diagnostic issue but not an M3 source ownership bypass: the first signal aborts active work; if the process exits, the exclusive action lock and pre-effect ownership journals remain, so a later helper cannot treat cleanup as confirmed or publish READY. Graceful cleanup after repeated signals remains unproven. The two permitted correction/re-review cycles are exhausted, so this Minor is left open for developer review; there was no fourth CLI review. Independent Standards/Security and Specification reviews found no remaining P1/P2 M3 source blocker. Neither ran Docker.

Scope: tracked modified `scripts/prepare-verification.ts`; `src/sandbox/{archive,broker,config,downloads,preparation}.ts`; `tests/sandbox/{archive,broker,config}.test.ts`. Untracked source `src/sandbox/{connectbroker,connectbrokerentry,dependencytree,frozentransfer,normalization,offlinescripts,packagecontent,preparationcli,preparationcomposition,preparationcoordinator,preparationio,preparationnetwork,preparationpublication,preparationruntime,preparationstorage,preparationworker,produceradapter,safeimport}.ts`; untracked tests `tests/sandbox/{connectbroker,dependencytree,frozentransfer,lockedgraph,normalization,normalizedtree,packagecontent,preparation-action,preparationcli,preparationcomposition,preparationio,preparationjourney,preparationnetwork,preparationpublication,preparationruntime,preparationstorage,preparationworker,produceradapter,safeimport}.test.ts`; and this evidence file. All 47 were included in the first CodeRabbit review. No secret/key/token signature or unrelated temporary file was found in this inventory before the review.

Source/contract exit is supported by the matrix, fresh regressions and completed CodeRabbit review, with one unresolved Minor repeated-signal cleanup weakness disclosed above. **Real preparation/storage acceptance remains UNAVAILABLE**: provision immutable base/toolchain, trusted effective whole-builder quota and engine/storage identity on disposable Linux and Windows Docker Desktop Linux-mode hosts; run actual pnpm normalization equivalence, restricted-network/no-bypass, CAS-free native scripts, frozen transfer, image publication/smoke, quota-exhaustion and cleanup fixtures. Durable restart reconciliation remains Milestone 4. T162/T129/T131 remain OPEN; T088 remains accepted UNVERIFIED/UNAVAILABLE; Phase 5 remains OPEN. No real downloads, Docker preparation/build/pull, quota stress, commit or push occurred. Recommendation: **READY FOR DEVELOPER REVIEW — M3 SOURCE/CONTRACT COMPLETE; REAL DOCKER INTEGRATION UNAVAILABLE**. This is a review recommendation, not developer acceptance or Phase 5 closure.

## 2026-10-10 — developer conditional acceptance and ownership handoff

The developer and incoming team leader agreed to hand over all remaining Phase 5 work. M3-A–H in the final source matrix above are **conditionally accepted for SOURCE/CONTRACT scope only**. This decision does not upgrade the controlled-port journey to real Docker E2E, mark a skipped fixture PASS, accept effective quota enforcement, or close a security/phase exit gate. The final 777 PASS / 33 SKIPPED and 386 PASS / 16 SKIPPED counts above are historical observed results; no source test or Docker preparation was rerun during this documentation-only handoff.

The final CodeRabbit CLI review completed at exit 0 and covered all 47 then-modified/untracked source, test and evidence files. Its repeated-`SIGINT`/`SIGTERM` Minor remains **OPEN**: a second signal can interrupt graceful helper cleanup. The first abort fences work and the action lock/ownership journals retain uncertainty after process loss; that source argument is not a real crash/restart proof. The incoming team leader owns remediation and fresh RED/GREEN plus review evidence. M3 private ownership records do not implement the M4 durable restart reconciler.

The production quota adapter currently supports only the selected dedicated Linux whole-builder mechanism: `createLocalPreparationConfiguration()` rejects non-Linux platforms, and `readDedicatedLinuxStorage()` has no Windows Docker Desktop effective disk-image-limit reader. Windows quota admission can require platform-specific **source implementation**, followed by an independently enforced real disposable exhaustion fixture; it is not merely a missing test. Current M3 production preparation, real pnpm normalization equivalence, broker no-direct-bypass, frozen transfer, native prerequisite smoke and immutable publication remain **UNAVAILABLE** as real integration evidence. The earlier PR #167 / CI run #54 at `7a241b0` is historical evidence for older source, not the current `3ffc986` branch plus dirty M3 tree.

The full receiving-team checklist is [handoff.md](handoff.md). The incoming team leader owns this Minor, M4–M6, any required Windows quota adapter and all Phase 5 acceptance gates. T162, T129 and T131 remain OPEN; T088 stays accepted UNVERIFIED/UNAVAILABLE. Phase 5 remains OPEN. This handoff adds no commit, push, PR or new runtime evidence.
