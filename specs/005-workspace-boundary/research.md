# Research: Workspace Boundary

The feature specification is [spec.md](spec.md). The current policy and ADR 0009/0010 define product behavior; this document records the implementation choices used for Phase 4. Project Phase 4 is complete for available fixtures on implementation commit `0b990c03718fa9ae9f1f33de230f9cf53ff38d71`, verified by PR #164 / CI run #41. Linux bind-mount containment remains UNVERIFIED / UNAVAILABLE under the accepted, unchecked T088 MVP exception.

## Decision 1 — Use an OS-backed, handle-relative filesystem boundary

**Decision**: Keep policy, Git selection, and gateway integration in TypeScript. Add a small Node-API native addon for filesystem open and directory traversal, with Linux and Windows backends. The addon anchors operations to an already opened workspace root, checks the opened target before returning content, and fails closed if a required primitive or the addon is unavailable. Build it explicitly in the pinned install/CI workflow. Do not enable a model-visible read or write adapter solely on TypeScript preflight checks.

**Rationale**: Node 24 provides `realpath`, `lstat`, `open`, and handle metadata, but path validation followed by a path-based open can race with a changed parent component. `O_NOFOLLOW` protects only the final component on supported POSIX systems. Linux `openat2` can constrain resolution below a held root and reject nested mounts; Windows requires held-handle relative traversal and reparse-tag inspection. A real boundary is needed before Phase 6 or 7 enables file adapters. [Node filesystem documentation](https://nodejs.org/download/release/v24.17.0/docs/api/fs.html), [Linux openat2](https://man7.org/linux/man-pages/man2/openat2.2.html), [Windows reparse operations](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-point-operations), [Windows relative open](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile).

**Alternatives considered**: Pure TypeScript `realpath` plus `lstat` is simpler but proves only static eligibility, not open-time confinement under path swaps. A helper process would broaden the single-process architecture. A Node-API addon is the narrowest exception to ADR 0003; it adds an OS toolchain and needs explicit Windows and Ubuntu CI coverage. The implemented native contract and available two-host gate passed; a future regression would block dependent adapters until resolved.

## Decision 2 — Constrain each operating system's actual open

**Decision**: Linux uses a root directory handle and `openat2` with beneath, no-magic-link, and no-cross-device resolution; unsupported kernels fail closed. Windows uses a held root handle, component-relative opens, and explicit reparse-tag handling; junctions, mount points, and unknown tags fail closed. Both backends reject nonregular content targets and files with more than one hard link. The checkout root may itself be mounted; crossings introduced below it are denied.

**Rationale**: Linux `RESOLVE_NO_XDEV` rejects mount crossings including bind mounts, which path-aware string checks and `realpath` cannot reliably distinguish. Windows junctions and mounted folders use reparse points. An opened handle permits file-type, link-count, and identity checks before reading bytes. [openat2](https://man7.org/linux/man-pages/man2/openat2.2.html), [Windows file information by handle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle), [Windows mounted folders](https://learn.microsoft.com/en-us/windows/win32/fileio/determining-whether-a-directory-is-a-volume-mount-point).

**Alternatives considered**: Comparing device numbers alone misses same-filesystem bind mounts. Rejecting all symlinks would conflict with ADR 0009. The resolver must support eligible in-repository symlinks, including an absolute alias that resolves inside the selected root, by safely translating its target to a root-relative operation and revalidating alias identity; Linux `RESOLVE_BENEATH` alone rejects absolute links. Directory traversal tracks opened target identities to stop cycles and duplicate exposure. [openat2 resolution flags](https://man7.org/linux/man-pages/man2/openat2.2.html).

## Decision 3 — Discover and seal the Git checkout through trusted runtime code

**Decision**: At admission, run fixed-argv `git rev-parse --show-toplevel` with the trusted launch directory as cwd and sanitized Git discovery environment. Reject non-worktree, bare, dubious-ownership, or inconsistent results. Canonicalize the physical root, hold its directory handle, and bind the handle's OS file identity plus the worktree gitdir identity to the task's opaque workspace ID before `admitTask`. Compare current path and Git discovery to those sealed identities before real access or resume, including after same-path replacement. Keep host root paths out of model-visible facts. Recognize linked-worktree gitfiles and gitdir/common-dir metadata rather than assuming `.git` is a directory.

**Rationale**: Git's worktree-root command is the intended discovery primitive. Environment overrides such as `GIT_DIR` and `GIT_WORK_TREE` can redirect discovery; Git's `safe.directory` check should stay effective. [git rev-parse](https://git-scm.com/docs/git-rev-parse), [Git environment](https://git-scm.com/docs/git), [Git configuration](https://git-scm.com/docs/git-config), [Git worktrees](https://git-scm.com/docs/git-worktree).

**Alternatives considered**: Walking parents for a `.git` directory misses gitfiles, submodules, and linked worktrees. Letting the model choose a root would expand authority.

## Decision 4 — Use effective Git file membership, then enforce the OS boundary

**Decision**: Candidate enumeration uses Git's tracked plus nonignored untracked membership with NUL-delimited names. Tracked files remain eligible even if an ignore pattern later matches them, following normal Git semantics. Exclude gitlinks/submodules and any nested repository boundary. Every candidate still passes OS path, secret, file-type, and mount checks at use time; candidate membership is not an authorization token.

**Rationale**: `git ls-files --cached --others --exclude-standard -z --full-name` covers the intended visible set and handles unusual filenames. Git ignore rules target untracked files; Git metadata may be a directory or gitfile. [git ls-files](https://git-scm.com/docs/git-ls-files), [gitignore](https://git-scm.com/docs/gitignore), [repository layout](https://git-scm.com/docs/gitrepository-layout), [submodules](https://git-scm.com/docs/gitsubmodules).

**Alternatives considered**: Recursive filesystem walking alone includes ignored content and nested repositories. Treating tracked files as ignored would depart from Git behavior without a user requirement.

## Decision 5 — Supply real facts without importing later phases

**Decision**: A real workspace provider maps the task's sealed workspace identity to the validated root and implements the existing `WorkspaceFactsPort`. It supplies requested-alias and resolved-target facts for explicit file paths, `search_code.scope`, and implicit root-scoped `list_files`/`search_code`. The gateway independently derives each expected path-operation pair and requires exactly one matching fact; missing, duplicate, extra, or inconsistent facts fail closed. Phase 7 extends the request derivation to parsed patch targets before enabling writes. A safe opened-handle primitive is shared with future adapters; Phase 4 tests it directly, while actual model-visible read/search executors remain Phase 6 and patch/grant execution remains Phase 7.

**Rationale**: At the Phase 4 design checkpoint, Phase 3 asked the workspace port for fresh facts, but root-scoped list/search and `search_code.scope` lacked required path facts. Returning only a preflight verdict without a safe actual-open primitive would leave a time-of-check gap for future adapters. Branch/`HEAD`/status/diff snapshots and branch-switch handling remain Phase 9; no `git_status` tool is added. See `src/policy/engine.ts`, `src/tools/gateway.ts`, ADR 0008, and ADR 0010.

**Alternatives considered**: Duplicating path rules in each tool adapter would create inconsistent authority. Implementing the Phase 7 grant ledger or Phase 9 Git evidence here would blur the feature boundary.

## Decision 6 — Keep per-tool retrieval contracts

**Decision**: Make `search_code.limit` accept 1–200 without changing `list_files`'s existing 1–100 range. Register separate output schemas and output-byte maxima in the closed tool catalog: 64 KiB maximum result for `read_file`, 32 KiB for `search_code`, and smaller existing limits for unrelated tools. Phase 4 supplies bounded output/limit contracts and tests with fixture results; Phase 6 implements actual retrieval and source provenance. Whole-file reads above 64 KiB return an explicit limit result. Search limits include 200 matches, 4 KiB per returned line, 4 MiB per searched file, and a 32 KiB total with separate omitted-match and shortened-line indicators.

**Rationale**: At the Phase 4 design checkpoint, the registry shared a 100-match limit between list and search, and the fake gateway had one 32 KiB post-capture limit. Raising the global limit would expand unrelated tools. A content limit and the encoded result envelope must both be checked, so some files under 64 KiB can still receive a size-limit result.

**Alternatives considered**: Global 64 KiB gateway cap unnecessarily enlarges other tool outputs. Truncating `read_file` would make partial source appear complete. Chunked reads remain deferred.

## Decision 7 — Keep the existing phase gates visible

**Decision**: Phase 4 verification covers native boundary fixtures on Windows and Ubuntu, real-facts-to-gateway integration with fake executors, and the pinned quality gate. The Phase 4 exit claim is limited to the tested boundary/open primitives until Phase 6/7 adapters use them. The progress checker records completion only from implementation and required verification evidence.

**Rationale**: Phase 3's gateway is a fake-port proof. The accepted Phase 0 gate and Phase 1 runner reconciliation remain prerequisites; planning artifacts do not prove containment. See `coding-agent-context/context/progress-checker.md` and `coding-agent-context/context/testing.md`.
