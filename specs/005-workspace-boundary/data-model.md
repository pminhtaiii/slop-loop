# Data Model: Workspace Boundary

This is the trusted in-process model for [spec.md](spec.md). It does not create persistent storage or a model-visible authority token.

## CheckoutSelection

- **Inputs**: Trusted launch directory, sanitized Git discovery environment.
- **Fields**: Canonical physical root; held root directory handle and OS file identity (Linux device/inode or Windows volume/file ID); private worktree gitdir identity; opaque workspace ID; platform/backend readiness.
- **Validation**: Must be a non-bare current worktree whose canonical launch directory lies within the returned root. Admission and each real access/resume compare current path and Git discovery with the held root and gitdir identities. A same-path replacement, different repository, or unavailable boundary backend is rejected.
- **Lifetime**: Held root and identity are sealed at task admission and released with the task. Phase 9 may refresh branch evidence without replacing this identity.

## RepositoryPathRequest

- **Fields**: Requested repository-relative path or implicit root, operation (`read`, `update`, or `create`), originating registered tool, task workspace ID.
- **Validation**: Strict path syntax, no absolute/drive/UNC path, no `..` component, no NUL or malformed encoding. Tool argument schemas remain the first validation layer.
- **Relationship**: One tool call may produce multiple requests; every relevant path must have a fact before policy can allow the call.

## ResolvedTarget

- **Fields**: Canonical repository-relative path; requested alias; opened target identity; file kind; hard-link count; mount/reparse classification; Git membership; denied-pattern decision.
- **Validation**: Both alias and target pass containment and deny rules. A read target is regular, has one link, stays on the selected root's mount boundary, and does not enter another repository. Mutation paths have no symlink component. A directory target may be opened for bounded traversal; visited opened identities stop cycles.
- **Authority**: Internal only. A path string is not an open handle or authorization for later use.

## TrustedPathFacts

- **Fields**: `workspaceId`, normalized `requestedPath` (`.` for implicit root), `operation`, `canonicalPath`, `status` (`ALLOWED` or `FORBIDDEN`). The requested alias extends the Phase 3 policy seam.
- **Scope**: Produced for one gateway invocation from current trusted state. Implicit-root list/search and `search_code.scope` produce facts too. The gateway requires an exact, duplicate-free one-to-one match with independently derived path-operation requests.
- **Failure**: If identity, Git membership, native boundary, or path state cannot be evaluated safely, fact production fails rather than returning `ALLOWED`.
- **Relationship**: Policy consumes facts; the future executor still opens through the boundary at point of use.

## OpenedWorkspaceTarget

- **Fields**: Opaque held OS handle, canonical relative path, type/identity metadata, workspace ID, validated read or directory-traversal operation.
- **Lifecycle**: Opened beneath a held root, checked before bytes or entries are returned, closed on success, failure, cancellation, and task cleanup.
- **Rule**: The handle cannot be rebound to another workspace or upgraded from read to write. Phase 7 adds separate operation-specific mutation primitives.

## BoundedRetrieval

- **Whole-file read**: Content is at most 64 KiB and must fit a 64 KiB encoded model-visible result. An exceeded limit returns an explicit typed result with no partial content. Binary content is rejected.
- **Search**: At most 200 matches, 32 KiB encoded output, 4 KiB per returned line, and files at most 4 MiB. Omitted matches and shortened lines are distinct flags. Skipped large/binary files have bounded counts or reasons, not content.
- **Provenance**: Any model-visible content carries canonical repository-relative source path and retrieval method, and remains untrusted data.
