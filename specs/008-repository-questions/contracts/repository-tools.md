# Additive repository evidence tools — question-repository/1

Owned contracts: `src/contracts/questions/contracts.ts`, runtime validators in `validation.ts`. Foundation additions in `repository-types.ts`, `repository-read.ts`, `repository-tools.ts`; Q&A adapter in `src/questions/repository.ts`. Existing canonical repair interfaces/method behavior unchanged.

## Binding and surface

Host supplies immutable `{repositoryId, workspaceId, revisionDigest, policyDigest}` plus an already-authorized read guard and rooted filesystem. The model supplies only tool arguments, never workspace roots/identity/policy. Host `checkBinding()` checks current repository revision and active owner read control; returns exact binding or typed stale/denied/unavailable. Check before evidence reuse and final delivery as well as around filesystem operations. No port exposes mutation, Python execution or shell access.

Source identity additionally requires a trusted immutable per-run snapshot, identified by snapshotId and a canonical path-to-original-byte-digest manifest bound to revisionDigest. The trusted host acquires it under an owner-guaranteed stable source read lease (or an already immutable supplied source); ordinary sequential hashes over a mutable tree are not sufficient admission. Snapshot creation/manifest traversal consumes finite host-admission work/time limits, is outside model authority, applies workspace/protected-data policy, and is rejected if stable acquisition cannot be established. Source changes during acquisition invalidate the attempt; no automatic retry. Snapshot and manifest cannot be updated during a run. Reads/list/search use only this snapshot; every opened file must match its expected manifest byte digest before an excerpt is issued. An arbitrary filesystem object's compatibility flag is not proof of immutability. Controlled tests inject an immutable fixture plus trusted admission; live snapshot acquisition/owner lease is an additional G-LIVE prerequisite, not implemented by trusting model text or copying without a stable lease. Current selected-workspace freshness is checked separately via checkBinding; even an A -> B -> A workspace change cannot cause B bytes to be issued as A because evidence comes from immutable A.

```text
listDirectory({path, cursor?}) -> DirectoryPage
readSpan({path, startLine, endLine}) -> SpanResult
searchLiteral({query, pathPrefix?, cursor?}) -> SearchPage
```

Every method returns validated `ok` or typed `denied | stale | invalid | unavailable | exhausted | cancelled` and safe reason codes. Empty search is not a tool failure. No arbitrary error text is model-visible. Inputs/outputs are untrusted until runtime-validated, copied and frozen. Source IDs are issued by the host registry, not selected by the model.

## Directory pages

Root path is `.`; other paths canonical relative. Children are lexically sorted canonical paths with file/directory kind, no protected/escaping entries. Per-page entry/output bounds apply. Opaque cursor binds query/path, binding, policy and ordering position; cannot be reused at another revision or alter scope. Return `nextCursor` when more eligible entries exist, `coverage: complete | partial` and fixed omission categories. No silently truncated list presented as complete. Implementation may use bounded in-memory cursor state; expired cursor is invalid, never restarts silently.

## Line semantics

Lines are 1-based inclusive; LF separates lines, CRLF normalized to LF for model-visible text. A terminal newline does not add a phantom line; empty files have zero lines. Ranges are safe positive integers with start <= end. End beyond EOF clamps to EOF; start beyond EOF yields `out-of-range` without evidence. Reject NUL/binary (NUL or invalid UTF-8) and oversized files before source admission. Configure finite per-file raw-byte limit and charge scan bytes even for rejected eligible files.

Return whole lines only under maxSpanBytes/maxSpanLines. If the requested range cannot fit, return the largest fitting prefix of whole lines with explicit actual range/truncation and continuation line. If even one line cannot fit, return `line-too-large` with no citable span; never fabricate full-line evidence from a byte fragment. File text is checked for protected content before selecting a range, so an embedded secret outside the requested span still excludes the file. Inspect only within the finite file limit. Canonical file digest hashes original bytes; excerpt digest hashes returned normalized text, both bound to repository revision.

`AdmittedSpan` contains host-issued evidenceId, binding, snapshotId/manifest digest, path, actual startLine/endLine, excerpt text/digest, file digest and truncation metadata. Internal tool results are registered for the current task/run; serialized copies alone cannot establish issuance. A verified span reused in a follow-up is reissued under its current run after binding/content checks against the admitted snapshot.

## Literal search

Case-sensitive literal substring over original decoded text, matching existing search expectations. No regex/synonyms/tokenization/ranking. Query nonempty, no NUL, within maxQueryBytes; reject newline-bearing query in this version. Optional canonical directory prefix narrows search. Model may issue several queries, charged individually.

Traverse deterministically: directory queue, sorted entries per directory, files/lines/match columns in traversal order; skip protected/escaping/unreadable/binary/oversized content. Return one hit per matching line, with first-match 1-based UTF-16 column and match length; matching itself occurs on line text excluding CRLF terminators. Repeated matches on that line do not duplicate hits. Include up to configured before/after context lines with actual exposed range. Hit line must be fully exposed; if too large, record omission, never claim a citable hit. Multiple hits may share a registered span.

Return bounded hits/bytes, `nextCursor` if resumable, `coverage` and reason categories for omissions/scan limits. Completeness means eligible scanned scope only; protected/unreadable exclusions prevent an exhaustive codebase-absence claim. Cursors bind all query parameters and binding. On scan-budget exhaustion, return explicit partial status and no resumable cursor until host permits further budget; model cannot raise caps. Return no source from any operation detecting drift.

## Work limits and cancellation

Q&A requires finite positive safe-integer limits: maxFileBytes, maxSpanBytes, maxSpanLines, maxPageEntries, maxSearchHits, maxQueryBytes, maxPathBytes, per-task maxScannedFiles/maxScannedBytes/maxReturnedBytes, and timeout/call budgets from the runtime contract. Metadata/guards/digest traversal also count against work/time limits; returning zero matches cannot create an unbounded scan. Require AbortSignal/deadline checks before each directory/file/chunk and after awaited operations. If an underlying owner/filesystem cannot stop, stop accepting results and forbid later dispatch; do not claim process-level preemption. Oversized directory enumeration/digest traversal must be bounded at the filesystem adapter or operation admission rejects the adapter. Do not pretend Promise.race cancels IO.

Path/protected-content checks and revision validation reuse foundation helpers before/after access, including symlink/junction containment. Revision must cover relevant dirty/untracked eligible file bytes, not only Git HEAD. Host filesystem binding/digest implementation must satisfy finite traversal and drift requirements; unsupported adapters are denied, not treated as compatible from a boolean marker. Controlled adapters prove exercised protocol behavior only.

## Compatibility acceptance

Existing readFile/searchCode/listDir tests retain old prefix/string signatures and results. New tests cover later ranges, exact matching, line bounds, Unicode/CRLF, protected content, file-size enforcement, deterministic paging, stale/forged cursors, work exhaustion, cancellation, directory/digest work bounds and filesystem root isolation. Add A -> B -> A mutation during a read, mutation during snapshot acquisition, corrupt manifest/file bytes and unsupported stable-lease admission vectors. Controlled v0.2 read fencing must still run; no source is admitted through an unfenced route. Unsupported optional capabilities fail closed before reads.
