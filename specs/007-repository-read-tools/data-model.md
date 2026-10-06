# Data Model: Repository Read Tools

All entities are bounded in-memory values; there is no retrieval persistence layer.

## Read evidence

`ReadResult` keeps existing `CONTENT | SIZE_LIMIT | BINARY` kinds. `CONTENT` adds `contentHash` (64 lowercase hexadecimal SHA-256 characters) of exact consumed bytes, canonical `path`, `method: workspace-read` and complete `content`. Noncontent results carry no content hash. Every serialized field counts toward 65,536 bytes. A hash is evidence, not a grant or immutable snapshot.

## Directory evidence

`ListResult`: `kind: LIST_RESULT`, `scope` (canonical relative path or `.`), `method: workspace-list`, `entries` (at most 100 `{path, kind: file|directory}`), `omittedEntries` boolean. Entries are canonical eligible children sorted by code-point order and deduplicated. Whole result <=16,384 serialized UTF-8 bytes. No denied names are retained. Native authority failures produce no list result.

## Search evidence

`SearchResult` keeps `kind: SEARCH_RESULT`, `method: workspace-search`, `matches`, `skipped`, `omittedMatches`, `shortenedLines`, `omittedFiles`. Each match adds consumed-file `contentHash` alongside canonical path, 1-based line number, text and `shortened`. `skipped` contains eligible path plus `SIZE_LIMIT|BINARY` reason only.

Add `complete` boolean and `incompleteReason: null|RESULT_LIMIT|BYTE_LIMIT|FILE_LIMIT|DIRECTORY_LIMIT|DEPTH_LIMIT|SOURCE_BYTE_LIMIT|DEADLINE`. `complete` describes traversal under the documented size/binary policy, not whether every line is unshortened. A non-null reason implies `complete=false`. If output saturation stops traversal, mark potential omitted matches, not a precise count. Shortened lines have their own flag. All metadata fits 32,768 bytes; never accumulate hashes for every searched nonmatching file in the model-visible result.

## Trusted retrieval origin and audit

`RetrievalOrigin = AGENT|BOOTSTRAP` is trusted dispatch metadata, defaulting existing callers to AGENT. Add it to bounded request/result audit events; do not expose it as a model argument or a source of capability. Counts/byte usage are bounded integers; query/content/raw external references are absent. Hashing does not permit sensitive payloads to bypass gateway sanitization.

## Bootstrap input and output

`BootstrapInput`: structured developer-supplied repository-reference strings; model/repository text cannot populate it. Inspect at most 32 raw references and validate each as 1–1,024 characters before deduplication; never clone or iterate an unbounded input first. Admit at most 4 unique references, at most 32 index/reason omission entries, and summarize the uninspected remainder by count only.

`BootstrapContext`: `fragments` (untrusted successful gateway results), `omissions` (bounded `{source: TREE|ROOT_INSTRUCTIONS|REFERENCE, referenceIndex?:number, reason}`), `attemptsUsed`, `serializedBytes`, and `stopped` outcome metadata. Reason values are closed and contain no raw path or error string. Root discovery distinguishes known absence from incomplete `NOT_DISCOVERED`. Maximum 8 actual calls and 96 KiB aggregate encoded bytes remain subordinate to task allowances and per-tool caps. Root instructions/reference duplicates are read once.

Explicitly referenced nested instruction files are ordinary reference content; the adapter does not discover other nested instruction files, give them authority or load them after descendant access.

## Fixture expectations and metrics

Fixtures declare `requiredContentFiles`, `helpfulContentFiles`, `forbiddenFiles`, `trace`, `expectedProperties`, `expectedVerificationSelection` and per-trace recall/precision targets. Forbidden delivery never becomes acceptable through a fixture metric exception. Paths are relative to isolated fixture checkouts.

Let R be required content paths, H helpful paths, D unique paths whose actual content was delivered, and F forbidden paths. Metadata-only listing does not add to D. Partial search snippets count as content delivery but satisfy a required property only if the declared evidence assertion passes.

- Required-file recall: `|D intersect R| / |R|`; when R is empty return 1 with denominator 0 recorded.
- Content precision: `|D intersect (R union H)| / |D|`; when D is empty return 1 with denominator 0 recorded. Property/recall checks prevent an empty trace from passing a nonempty required set.
- Irrelevant content volume: delivered UTF-8 content bytes attributable to paths outside R union H; report total encoded result bytes separately.
- Forbidden deliveries: count of delivered paths/content in F, always required to be zero. Denied attempts are counted separately, including expected negative fixture probes.
- Tool calls: all dispatched attempts, including bootstrap, malformed and denied requests; actual executed calls are a separate count.
- Retrieved bytes: encoded model-context bytes actually accepted into fragments, including envelopes; omitted bootstrap results are not counted as delivered but still count execution/audit.
- Property correctness: passed declared evidence assertions / total assertions; empty denominator yields 1 with denominator recorded. This is scripted evidence correctness.
- Verification selection: exact agreement with declared diagnostic target/profile expectation; no Phase 8 execution is implied.
- Live-model answer correctness: `NOT_MEASURED`, never a synthetic numeric score.

## Lifecycle

Admitted task -> trusted call selection -> charged attempt -> fresh policy/path facts -> request/decision evidence -> executor safe opens -> complete bounded result -> sanitizer/schema/cancellation fence -> result evidence -> untrusted fragment. All exits close handles. Later calls reobserve the live checkout; fragments remain historical evidence, not grants. Bootstrap cannot reset allowances or restore a terminal task.
