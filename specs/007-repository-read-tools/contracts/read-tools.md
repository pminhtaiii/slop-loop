# Read Tool and Bootstrap Contracts

## Inputs

Preserve existing strict catalog inputs and Zod-derived provider JSON Schema:

| Name | Fields | Defaults |
| --- | --- | --- |
| `read_file` | `path`: 1–1,024 characters | none |
| `list_files` | optional `path`; optional integer `limit`: 1–100 | root `.`, limit 100 |
| `search_code` | `query`: 1–512 characters; optional `scope`; optional integer `limit`: 1–200 | root `.`, limit 200 |

Reject unknown keys. Paths retain current normalization/containment rules. Literal search does not accept flags/executable/shell/regex/timeouts/byte limits. Newline-containing queries never match a single line; metacharacters and leading hyphens are literal. Scope may be an eligible regular file or directory; trusted `factsFor` must classify both without granting broader access.

## Outputs

Use [data-model.md](../data-model.md) as the exact field contract. Define strict closed output schemas in `src/tools/registry.ts`, rather than a second schema source. Read content hashes and per-match hashes are validated as SHA-256 lowercase hex. `scope='.'` is allowed only in scope metadata, never as a source file path.

| Tool | Serialized UTF-8 cap | Semantics |
| --- | --- | --- |
| read | 65,536 bytes | whole text or typed SIZE_LIMIT/BINARY; no partial file |
| list | 16,384 bytes | immediate eligible children, explicit valid omissions |
| search | 32,768 bytes | <=200 matches, <=4,096 bytes/line, explicit shortening/omission/incomplete traversal |

Metadata and JSON escaping count toward caps. Fit complete items, never return a broken envelope. Search reads only complete eligible files <=4 MiB, privately probing one extra byte through the safe boundary; oversize prefixes are not searched. `complete=false` with a closed reason is mandatory on runtime/output traversal stop. Binary/oversize skips do not imply an undocumented scan failure; their notices are bounded and omission flags remain truthful.

## Authority and failure mapping

- Gateway requires exact requested scope coverage and the sealed workspace identity before execution; scope authorization does not bypass child safe opens or child policy. Audit uses registered tool names or a closed invalid/unknown sentinel, never a raw malformed proposed name.
- Ordinary known path exclusion -> existing DENY and bounded runner recovery. Unavailable/invalid trusted facts -> POLICY_FAILURE. Executor failures follow existing EXECUTION_FAILURE; do not disguise them as ordinary exclusions.
- Native directory >=1,024 children currently fails authority inspection. Preserve fail-closed behavior; do not represent it as a valid truncated list.
- Gateway narrow heuristic changing read/search -> existing TOOL_CONTRACT_FAILURE, whole affected result withheld. No replacement text or unaffected-subset salvage.
- Sanitized listing metadata must still be faithful canonical evidence; if sanitization changes paths, reject the result rather than return invented paths.
- Required pre-evidence unavailable -> AUDIT_UNAVAILABLE with zero executor invocations. Result append uncertainty -> AUDIT_INCOMPLETE without executor replay.
- Post-execution generation/abort fence prevents context delivery from stopped calls; close handles and retain applicable result/effect audit metadata without reviving authority. Runner-owned remaining-active-work facts reach executors, TICK accounts elapsed work before execution and final settlement, and time exhaustion remains BUDGET_EXHAUSTED rather than developer cancellation. The final successful call cannot bypass time accounting just because no later request follows it.
- Deadline/work caps produce bounded incomplete search when authority is intact; explicit cancellation follows existing CANCELLED behavior with no late fragment.

## Bootstrap internal API

`collectInitialContext(runner, gateway, input, now)` consumes only structured trusted developer references and calls registered tools through `runner.dispatchProposals` with trusted BOOTSTRAP origin. No direct filesystem loader/executor path is available.

Caps: 8 calls, 96 KiB encoded aggregate including omissions, 4 unique references, tree depth 2, 100 total tree entries; all are subordinate to admitted remaining tool attempts/task deadline. Inspect only the first 32 raw references, validate 1–1,024 characters before deduplication and cap omission entries at 32; uninspected remainder is a count, not per-item processing. Priority is root listing -> root instructions -> references -> additional bounded tree listings. Root instruction discovery is literal `AGENTS.md` at the checkout root, subject to normal alias/deny/content rules. No nested instructions are discovered automatically; an explicit developer reference to one is ordinary referenced content, not instruction discovery. References to outside workspace never enter path authority.

Every attempted retrieval is charged/evidenced even if bootstrap later omits its result due to aggregate capacity. Deduplicate repeated references/root instruction requests. Omission metadata uses safe closed reasons/reference indexes, never raw external paths. A non-executed call stops the bootstrap batch under normal runner behavior; the adapter cannot waive denial recovery or ignore terminal failures. Audit/budget/policy/contract failure or cancellation suppresses all accumulated batch fragments and prevents starting a model turn from them; ordinary safe cap omissions may yield bounded partial context while current authority/fencing permits it.

## Compatibility

Existing tool names/inputs/mode selection stay unchanged. Output schema extensions require corresponding fixture updates across current read/search tests and fake executors; migrate existing `tests/workspace/read-bounds.test.ts`, `tests/workspace/search-bounds.test.ts` and hash-less `tests/tools/workspace-gateway.test.ts`/gateway/sandbox fake outputs deliberately. Origin defaults to AGENT for existing dispatch callers. Numeric fake-time dispatch remains supported; live adapters use a trusted fresh clock thunk. Final ready-to-compose `src/tools/read-gateway.ts` registration follows measured release gates; no runtime machine-baseline lookup is introduced.

Phase 6 supplies internal context fragments and scripted integration, not provider prompt roles, CLI parsing, durable audit writer, Git-write authority or mutation permissions.
