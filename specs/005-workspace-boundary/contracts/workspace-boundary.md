# Contract: Workspace Boundary

This contract connects trusted task admission, the Phase 3 `WorkspaceFactsPort`, and later repository executors. It does not add a model-visible tool. The authoritative policy is `coding-agent-context/context/tool-policy.md`.

## Admission

`selectWorkspace(trustedLaunchDirectory)` returns an opaque workspace ID and private validated checkout record, or a typed admission failure. The runtime executes fixed-argv Git discovery with sanitized repository-location environment, canonicalizes the physical worktree root, checks launch containment, holds its root directory handle, records that handle's OS file identity (Linux device/inode; Windows volume/file ID) and the worktree gitdir identity, and verifies that the native boundary backend is ready. Trusted admission must call this selector before `admitTask`; a caller-supplied or missing workspace ID is not sufficient. A non-repository, bare repository, unsafe ownership, replacement checkout, or missing backend cannot produce an admitted workspace. Before each real repository access or resume, current path and Git discovery must still designate the held root and gitdir identities. The absolute root and Git metadata paths are never model-visible.

The task's existing `TaskCapabilityCeiling.workspaceId` seals the selected ID. The boundary maps that ID to the private root record. A branch change within the same checkout does not replace the ID; Phase 9 decides when to refresh Git evidence and Phase 7 invalidates grants.

## Path-fact request

For each validated gateway call, `WorkspaceFactsPort.factsFor(call, ceiling)` returns current `TrustedPathFacts[]` or an unavailable-facts failure. Phase 4 adds the normalized requested alias to the existing fact shape:

`{ workspaceId, requestedPath, operation: "read" | "update" | "create", canonicalPath, status: "ALLOWED" | "FORBIDDEN" }`

The gateway independently derives the expected normalized `(requestedPath, operation)` pairs from the validated call and requires one matching fact per pair, with no duplicate or extra facts. `read_file.path` and `list_files.path` are explicit. `list_files` without a path and `search_code` without a scope request the selected root as `.`; `search_code.scope` requests that scope. Phase 7 extends this derivation to every parsed update/create patch target before enabling mutation; Phase 4 does not authorize a real patch executor. No model-supplied path fact, root, capability, or permission is trusted.

A valid forbidden path returns `FORBIDDEN` and policy produces ordinary `DENY`. Missing workspace identity, unavailable native enforcement, inconsistent root, Git discovery failure, or uncheckable target identity returns no authoritative facts and leads to `FAILED / POLICY_FAILURE`. No executor starts on either outcome. Facts expire after that invocation.

## Safe filesystem access

The native boundary holds a handle to the selected root and offers operation-specific, root-relative access:

- `openRegularRead`: open and validate a regular, single-link, eligible file before any bytes are returned.
- `openDirectory` / `entries`: enumerate from held directory handles and return one validated snapshot per call. Enforce current Git membership and path rules for every opened child, and stop symlink cycles or repeated opened targets. A later call forms a new snapshot rather than reusing earlier eligibility evidence.
- `inspectMutationPath`: report current parent/target identity and reject any symlink component; it is preflight only. Phase 7's mutation adapter must use a separate fresh safe open/create operation at point of use and exclusive creation for `create`.

Every opened target is checked for workspace containment, selected-repository identity, deny patterns on alias and resolved target, ignored/`.git` exclusion, hard-link count, special file type, and nested mount/reparse crossing. The opened file identity must match the safely verified resolved target whose Git membership and deny policy were evaluated; an in-root alias swap to ignored or secret content must fail. Permitted read symlinks may resolve to an in-repository target, including an absolute alias to that same root, but may not bypass the held-root open. The root itself may be mounted. Unknown reparse tags, unsupported kernels, or unverifiable final identity fail closed. Handles close on completion, cancellation, or error.

A caller cannot turn a returned canonical path string into an authorized path-based open. Later adapters use these safe operations again; changed path state invalidates an earlier preflight result.

## Retrieval and output

| Tool | Input / content limit | Encoded model-visible result limit | Exceeded behavior |
| --- | --- | --- | --- |
| `read_file` | Whole eligible text file at most 64 KiB | 64 KiB | Typed size-limit result; no partial file |
| `search_code` | File at most 4 MiB, at most 200 matches, at most 4 KiB returned line | 32 KiB total | Bounded result; mark omitted matches and shortened lines separately |
| `list_files` | Existing caller limit 1–100 | Existing smaller contract | Bounded enumeration and explicit omission marker |

`search_code.limit` changes from 1–100 to 1–200; `list_files.limit` stays 1–100. Output schemas and caps live in the trusted closed tool catalog, not model arguments. The gateway validates the registered output schema and checks bytes after serialization before handing a result to the model. A sub-64 KiB file may still receive a size-limit result if its encoded envelope exceeds 64 KiB. Binary content is rejected. Content results carry canonical repository-relative source path and retrieval-method provenance and remain untrusted repository data. No raw denied path, secret content, or unbounded native error is returned. If gateway redaction would rewrite a read or search payload, the gateway returns a tool-contract failure instead of presenting altered bytes as complete source content.

## Ownership and compatibility

- Phase 4 implements admission, real facts, native boundary primitives, result contracts, and adversarial fixture proof.
- Phase 6 implements full `list_files`, `search_code`, and `read_file` executors against these primitives.
- Phase 7 implements patch target extraction, exact file grants, and safe point-of-use mutation.
- Phase 9 implements branch/`HEAD`/status/diff snapshots and branch-switch detection. `git_diff` remains the only model-visible Git tool.
- Phase 12 supplies durable audit storage; Phase 3's pre-execution audit gate remains mandatory.
- Phase 13 implements the resume UI. OS-temp handoff import, arbitrary terminal commands, and chunk-based reads remain out of scope.
