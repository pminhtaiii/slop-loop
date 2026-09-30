# Implementation Plan: Workspace Boundary

**Branch**: `feat/005-workspace-boundary` | **Date**: 2026-09-30 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md), ADR 0008/0009/0010, authoritative tool policy, and [research.md](research.md).

## Summary

Create a real, checkout-bound workspace authority for Phase 3's policy gateway. Trusted admission discovers and seals one Git worktree root; path evaluation excludes other repositories, ignored and secret content, hard links, nested mounts, and unsafe file types. A narrow OS-backed open/traversal layer closes the path-check/open race before later read or patch adapters can be enabled. Phase 4 also defines and verifies the agreed read/search bounds and per-tool output contracts. Complete model-visible read/search, write grants, Git evidence, and CLI resume behavior remain later phases.

## Technical Context

- **Language/Version**: TypeScript 5.8 on Node.js 24, native ESM; a small C/C++ Node-API addon for OS filesystem access.
- **Primary Dependencies**: Existing Zod 4, Pino 10, Vitest 3; add `node-gyp` as a build dependency only. No new model or network dependency.
- **Storage**: In-memory checkout identity and open handles for one active task; no persistent state.
- **Testing**: Vitest adversarial filesystem fixtures, native helper tests on Windows and Ubuntu, TypeScript typecheck, ESLint, Prettier, pinned pnpm gate.
- **Target Platform**: Local Windows and Ubuntu CLI. Linux backend requires `openat2` support (kernel 5.6+); unavailable native enforcement fails closed.
- **Project Type**: Private single-package, single-process application.
- **Performance Goals**: No new latency SLO; bound read/search content and avoid host-wide or unbounded traversal.
- **Constraints**: One selected checkout per task; no host escape, no arbitrary shell or network; 64 KiB whole-file read/result, 200 search matches, 32 KiB search output, 4 KiB line, 4 MiB searched-file cap; one in-flight gateway call.
- **Scale/Scope**: One active checkout slot. Phase 4 supplies boundary primitives and real policy facts, not complete Phase 6/7/9/13 adapters.

## Constitution Check

The checked-in `.specify/memory/constitution.md` is an unratified template and contains no operative gates. Apply the project authority hierarchy instead: `CONTEXT.md` vocabulary, `coding-agent-context/context/tool-policy.md` security policy, `workflow.md` development sequence, `testing.md` verification, `progress-checker.md` implemented status, and ADR 0001/0003/0005/0008/0009/0010. ADR 0003 favors one TypeScript process; the native addon is a justified, single-process exception required for race-resistant cross-platform file access. Do not claim Phase 4 integration until the native helper, adversarial fixtures, and pinned quality gate pass on both supported platforms. This gate is rechecked after the design below.

## Authority and Integration Boundaries

- Phase 3 is implemented with fake `WorkspaceFactsPort` data. Phase 4 supplies the real trusted checkout/path provider and safe access primitive; policy and gateway remain the only execution authority.
- At admission, trusted fixed-argv Git discovery plus physical canonicalization produces a sealed opaque workspace identity before `admitTask`. Seal the held root's OS file identity and worktree Git metadata identity, not just their path strings; compare current discovery to those held identities before real access or resume. Ignore model/repository-supplied Git environment overrides. The physical host root never enters model-visible facts.
- The boundary evaluates requested and resolved path, effective Git membership, secret deny rules, repository identity, file type, symlink policy, mount/reparse status, and operation. The opened target must match the safely verified resolved target, including after an in-root symlink swap. Every returned fact is scoped to one request. The later executor must use the safe open primitive again at point of use; a preflight fact alone never authorizes a path-based open.
- `list_files` without a path and `search_code` without a scope require explicit root facts. `search_code.scope` must be evaluated as a path. The gateway derives expected requested path-operation pairs and checks an exact one-to-one match with returned facts before policy can allow. Phase 7 extends this derivation to parsed `apply_patch` targets; Phase 4 does not parse patches or store grants, so no real patch executor may be enabled yet.
- Phase 9 owns branch/`HEAD`/status/diff snapshots and branch-switch detection. The workspace identity contract permits continuation only in the same checkout; Phase 4 does not add a `git_status` tool.
- Phase 6 owns actual list/search/read executors and result provenance. Phase 4 establishes their safe filesystem and output contracts, with fixture-level proof that content cannot escape.

## Implementation Sequence

### 1. Contracts and build gate

Define the workspace identity, requested operation, canonical path fact, safe opened-handle/read/walk operations, bounded result types, and explicit failure classes in [contracts/workspace-boundary.md](contracts/workspace-boundary.md). Add an explicit native build script and Windows/Ubuntu CI prerequisites. Loading failure, unsupported kernel, or unavailable OS capability must produce a typed fail-closed result and keep real file adapters disabled.

### 2. Admission and Git membership

Implement trusted root discovery from the launch directory using fixed argv and sanitized Git environment. Canonicalize and validate the worktree root, held-root OS identity, worktree gitdir identity, and launch-path containment before sealing the workspace ID. Integrate selection into the trusted task-admission entry point so a caller cannot admit with a missing or invented workspace ID. Reject same-path checkout replacement by comparing current discovery with the sealed identities before real access or resume. Use NUL-delimited tracked/nonignored-untracked enumeration and reject gitlinks, nested repositories, ignored paths, and `.git` internals. Git output is candidate data; OS boundary and deny policy decide actual access.

### 3. Path policy and OS-backed access

Reject malformed, absolute, drive-qualified, and `..` paths; canonicalize requested aliases and apply deny patterns to alias and resolved target. Implement root-anchored native open/traversal. Linux uses `openat2` confinement and no-cross-device flags; Windows uses handle-relative traversal and reparse-tag inspection. Permit only in-repository symlinks for reads/list/search, including safely resolved absolute aliases; stop directory cycles. Revalidate the resolved target and match its identity to the opened handle before bytes or entries return, so an in-root swap to ignored or secret content cannot pass. Reject write symlinks, hard links, nested mounts, nonregular content, and unknown reparse tags. Keep handles pinned through validation and bounded read. Define a later write-adapter contract requiring a fresh point-of-use open/check.

### 4. Policy/gateway and output contracts

Bind the existing `WorkspaceFactsPort` to the real provider keyed by sealed workspace ID. Make all repository read tools require exactly one matching requested-alias fact for each expected path-operation pair, including implicit root and `search_code.scope`; missing, duplicate, or extra facts fail closed. Preserve Phase 3's fail-closed policy and audit ordering. Give `search_code` its own 1–200 input limit while `list_files` remains 1–100. Register output schemas and per-tool byte maxima in the closed catalog, then have the gateway validate and enforce them, preserving smaller limits elsewhere. Define complete-or-limit `read_file` and bounded/truncated `search_code` result contracts for later Phase 6 executors.

### 5. Adversarial verification and context sync

Write tests first for each contract: root/subdirectory/sibling/nested/submodule and same-path linked-worktree replacement; Git environment override; ignored/tracked membership; traversal/absolute/case/Unicode; symlink alias/escape/cycle; hard links; nested mounts/junctions; nonregular paths; target swaps from eligible to outside, ignored, or secret content; file/search/output bounds; missing, duplicate, extra, and wrong-alias gateway facts. Use real OS fixtures for mount/reparse behavior where the environment permits, and do not treat a skipped critical fixture as passed exit evidence. Run [quickstart.md](quickstart.md) and the full pinned gate. Update testing/progress only with observed implementation evidence.

## Threat Review

| Threat | Boundary response | Required evidence |
| --- | --- | --- |
| Relative/absolute traversal or prefix collision | Strict relative parser, physical containment, held-root open | Adversarial path fixtures |
| Symlink alias or parent swap | Alias and target policy; native root-relative open; post-open identity | In-root, escape, cycle, and swap fixtures |
| Hard link or special file | Opened-handle type and link-count rejection | Hard-link, pipe, device/socket fixtures |
| Nested bind mount or junction | Linux no-cross-device open; Windows reparse-tag deny | Real mount/junction fixture or gate remains open |
| Nested Git repository/submodule or ignored content | Git membership plus metadata-boundary check | Tracked/untracked/ignored/gitlink fixtures |
| Secret-path alias | Deny on both requested and resolved path | Secret symlink and case-variant fixtures |
| Output flood | Per-tool caps and explicit limit/truncation signals | Byte-bound and long-line fixtures |
| Unavailable native boundary or path facts | Fail closed before executor access | Loader/kernel/fact-failure fixtures |

## Project Structure

### Documentation

`specs/005-workspace-boundary/` contains `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/workspace-boundary.md`, `quickstart.md`, `tasks.md`, and `checklists/requirements.md`.

### Source and tests

`src/workspace/` contains trusted admission, Git membership, relative-path policy, native loader, and the real boundary/provider. `native/workspace/` contains one Node-API addon with Linux and Windows backends and build configuration. `src/policy/engine.ts` and `src/tools/gateway.ts` receive only the minimal fact and per-tool output-contract integration; `src/tools/registry.ts` gets the search-specific limit. `tests/workspace/` and `tests/tools/workspace-gateway.test.ts` prove the real boundary and gateway seam. Existing Phase 3 fake-port tests remain.

**Structure Decision**: Add a real workspace module only because Phase 4 now has concrete behavior. Keep OS-specific code behind one small addon and the application as one process/package. No Phase 6 read adapter, Phase 7 grant ledger, or Phase 9 Git evidence module is created by this plan.

## Complexity Tracking

| Choice | Why needed | Simpler alternative rejected because |
| --- | --- | --- |
| Node-API native addon | OS handle-relative open and nested-mount/reparse enforcement are required for the exit gate | Pure Node path preflight cannot close parent-component path-swap races |
| Separate real boundary provider | One trusted path authority serves policy and later adapters | Per-tool validation would drift and could bypass the gateway |

## Post-Design Constitution Check

No operative constitution rule is violated. The native addon is the only deviation from the TypeScript-first implementation style in ADR 0003; it preserves the single-process private package and is confined to OS filesystem enforcement. The project authority files and phase ownership remain consistent. If native support or the required adversarial fixture cannot be verified on a supported platform, Phase 4 is not integration-ready and later repository executors remain disabled.
