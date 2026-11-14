# Repository-question evaluation — question-evaluation/1

## Inventory and separation

Use evaluator-owned versioned inventory in `eval/questions/cases.ts` and disposable fixture builders in `tests/runtime/support/questions/fixtures.ts`. At least 36 cases: 4 exact function, 4 paraphrased behavior, 4 cross-file flow, 3 architecture, 5 clarification (including clear controls), 4 unsupported/insufficient, 4 session/revision, 8 adversarial/limits. Each has ID, split, question/turns, public repository digest, size band, required/optional, expected facts/acceptable uncertainty and clarification policy, relevant source spans, forbidden outcomes and rubric digest. Cases may exercise multiple dimensions; each ID counts once.

Generate nested source/docs/tests/config target trees around ~1k, ~10k, ~30k LOC outside slop-loop workspace root, with deterministic seed/content digests; put semantically necessary code in every size band, not only filler. At least one paraphrase, cross-file and budget-exhaustion case in every band. Target workspace contains only public case repository/input, never expected facts/rubric/answers/held-out inventory/provider config. Fixture generation is trusted evaluator setup; agent never executes Python.

Development/exploratory cases and stable development-regression cases may be inspected/tuned. Held-out cases are separate evaluator-controlled artifacts with access denied to agent/model/tools; do not place held-out questions/expected answers in agent-visible target guidance. Prepare at least 9 additional held-out cases (3/band) for the live evaluation gate through an evaluator-only input port, not committed plaintext masquerading as hidden. Run not admitted until material and isolation exist; unavailable held-out cases remain not-run. Once held-out results are used for tuning, retire/promote those cases to development and version a replacement held-out set. No current plan claims private material already exists.

## Profiles and experiments

Controlled fixture profiles only, not production defaults:

| Limit | Small | Medium | Large |
|---|---:|---:|---:|
| maxToolCalls | 12 | 36 | 72 |
| maxModelCalls | 16 | 48 | 96 |
| maxScannedFiles | 100 | 500 | 2000 |
| maxScannedBytes | 2 MiB | 16 MiB | 64 MiB |
| maxReturnedBytes | 32 KiB | 96 KiB | 256 KiB |
| maxBillableTokensTask | 32000 | 128000 | 384000 |
| maxCostMicrosTask | 100000 | 500000 | 1500000 |
| maxElapsedMsTask | 30000 | 120000 | 300000 |

All use maxFileBytes=1 MiB, maxSpanBytes=8 KiB, maxSpanLines=120, maxPageEntries=50, maxSearchHits=20, maxQueryBytes=256, maxPathBytes=1024, maxInputTokensPerCall=16000, maxOutputTokensPerCall=2000, maxClarificationRounds=3, maxConversationBytes=16 KiB, maxFinalBytes=16 KiB. Bytes use 1024-based units. These are experiment hypotheses; host pricing must permit a call's worst-case reservation or that profile returns exhausted. Configure finite IO chunk size (64 KiB) and deadline propagation. Clocks/accounting are injected for controlled timeout/cost tests.

Run identical cases/revisions/model/prompt/config except profile, use fixed seeds for scripted runs, and three live repetitions per case/profile for quality observations once admitted. Record model identity and sampling settings; do not claim real models are deterministic. Compare per case/category/size and aggregate with denominators and missing reasons. Do not infer a monotonic quality gain from higher budgets or tune defaults on held-out results. Selection of production defaults requires a later recorded decision, not automatic comparison output.

## Driver and grades

`runQuestionEvaluation({publicCase, profile, runtimeFactory, evaluatorPorts})` creates isolated session/task per case, runs only declared user turns, and collects typed observations. `evaluatorPorts` stay outside runtime/model context: private rubric/held-out input, semantic grader, adjudication, artifact sink. Controlled driver uses scripted decisions; it must be labeled controlled, not a quality benchmark for an autonomous LLM. Live transport/owner/accounting/isolation need G-LIVE and separate release.

Report binds reportVersion, experimentId, caseId/digest, repo/revision, runtime/prompt/config/profile/model digests, task/run IDs, actual outcome, evidence refs, tool/error metadata, durations, usage/reservations and grade evidence tier. Grade dimensions: provenance validity; expected-fact correctness/completeness; clarification appropriate/missed/unnecessary; unsupported claims; relevant-source discovery; forbidden effects; budget/deadline compliance. Disposition `pass | fail | pending-human | not-run`. Overall pass requires every mandatory dimension pass; absent usage/semantic judgment cannot yield pass. Human adjudication record carries evaluator identity, case/observation/rubric digests, verdict and bounded rationale; changing inputs invalidates the grade.

Deterministic checks validate citations, forbidden tool dispatch, bindings, limits and metadata shape. Semantic judge may be model-assisted but is independent of answer generation; disputed facts/clarification require human review. For release, human disposition is required for every required semantic case, not merely model agreement. Relevant-source metrics compare admitted span/file IDs with evaluator references; discovery is distinct from correct understanding. No aggregate hides safety failures or omits pending/not-run from the denominator.

## Diagnostics and artifacts

General traces contain stable IDs, timestamps/durations, tool kinds, safe reason codes, counts, digest of query rather than raw query, canonical source refs/ranges/digests and usage/outcome metadata. No raw prompts, source bodies, arbitrary tool errors or tool-output dumps. Query terms may carry secrets, so digest even model-generated strings. Inspect source later through guarded reads of the pinned fixture or approved evaluator artifact access; metadata does not authorize unrestricted copying.

Final displayed answer/question is content-filtered under existing policy. Retain a sanitized final result in the evaluator report only under explicit host artifact-access/retention configuration; otherwise retain digest/reference and mark semantic artifact unavailable, preventing semantic pass. Sink is host-only, outside target workspace, size-bound, access-controlled and configured before experiments; retention/cleanup owned by operator, no automatic deletion from this feature. Forbidden payload cannot be retained even in protected storage. Include canary-based absence checks for logs/reports/model-visible data. Trace references support diagnosis without promising replay of raw conversations.

## Acceptance

Controlled gate: 36 cases report expected deterministic outcomes and safety/provenance vectors all pass; semantic outputs of scripted model are fixture assertions only. Live gate: admitted profiles, all required cases plus isolated held-out inventory, all mandatory safety/provenance pass and every required semantic case human-reviewed pass, three repetitions reported individually. Pending/not-run/disputed cannot count as success. Thresholds may be revised only through a new scope decision, never by editing criteria to obtain a pass. No latency SLO or production defaults claimed.

## UC-02 retrieval acceptance

Freeze an evaluator-owned benchmark version, pinned corpus/manifest per turn, query and eligible gold spans before measurement. Each gold tuple is unique per question and binds revisionDigest, canonical case-sensitive path, original fileDigest and positive inclusive 1-based startLine/endLine. Reject malformed, duplicate, out-of-file or ineligible gold. Use minimal spans sufficient to establish each annotated evidence point, bounded so they can fit one valid retrieval chunk. Scored positive questions must have at least one gold span. Report coverage by scenario and language, per question and per repetition.

Take the final ordered, deduplicated hybrid list of up to five original chunks before supplemental reads. Reject a ranked list with invalid binding, oversized chunk (60 lines, 4096 normalized UTF-8 bytes or pinned embedding token limit), inconsistent source bytes, duplicate identity or post-ranking range expansion. A gold span is covered if one result has the same revisionDigest/path/fileDigest and its startLine <= gold.startLine and endLine >= gold.endLine. Partial overlap and combining separate results do not count. A gold contributes at most one hit. One bounded result may cover multiple distinct gold spans. Recall@5 per question is hits divided by gold count; the gate is the unrounded macro average across the pinned positive questions, >= 0.8 in each of three required measured repetitions of the pinned positive inventory. An empty list scores zero for a positive question. A required failed/unavailable/not-run measurement blocks acceptance and is reported rather than silently dropped. Absence cases have no gold and are evaluated separately.

### Mandatory scenario-family gates

Pin family membership and required gold spans or expected absence dispositions before running. Reject inventories without at least one required question in each positive family or without both required absence cases. Each required positive question must produce a valid complete ranking and cover every required gold span listed for its family gate. The aggregate Recall@5 still uses all pinned positive questions and their annotated gold spans. Required spans are a declared nonempty subset of each positive family question's gold spans, fixed before measurement.

| Family | Retrieval passes when |
| --- | --- |
| Exact function location | The top five contain the required span of the named definition. A reference or a different definition with the same simple name does not qualify. |
| Cross-file call flow | The top five cover the required call-flow spans in each annotated file, including the required call sites or definitions. Coverage in one file cannot substitute for another. |
| Run or configuration guidance | The top five cover each required span supporting the requested command or configuration. |
| Absent functionality | The confirmed-absence case has a fresh complete host coverage receipt and the scoped not-found outcome. The incomplete-coverage control must not produce not-found. Neither case enters the Recall@5 denominator. |
| Post-edit question | The top five cover each required span in the new revision, with no stale candidates. The refresh evidence verifies reuse for unchanged files and updates only affected paths. |

A family fails if any required case fails its rule, is missing, or is unavailable in a required repetition. All five families must pass independently of the macro threshold. These checks assess retrieval and coverage. Citation validity and independently judged answer support remain required under G-LIVE/G-QUALITY.


For edit/add/delete capture manifest delta and actual parse/embedding calls, demonstrate unchanged paths reuse vectors, verify deleted paths are absent and answers reflect new content. Add physical restart with no edits (zero corpus embeddings), restart with changed files, and interruption before commit followed by recovery. Exercise a long definition whose answer requires logic in multiple parts: verify logical split boundaries, original-definition linkage, bounded guarded expansion, explicit incomplete outcome under limits and unchanged scored ranking. Verify every delivered citation automatically and independently adjudicate semantic support for each required factual claim. Controlled scripted embeddings test mechanics only. Measure the threshold with the pinned local multilingual-e5-small candidate; if below 0.8 evaluate another candidate against unchanged criteria. Required semantic answer acceptance retains G-LIVE/G-QUALITY.

## Retrieval observations and resource profile

Each scored turn records the frozen ranked list separately from supplemental tool/evidence observations. Record the generation, manifest, policy, configuration, profile and embedding identity; for each rank record the chunk ID, lane, path, revision, original-file and normalized-excerpt digests, inclusive lines, normalized bytes and actual complete embedding input token count. Record complete/empty versus exhausted/stale/unavailable with reason codes, the gold inventory digest, per-gold matches and numerator/denominator. Keep only safe metadata; evaluator verifies sizes, tokens and digests from the pinned guarded fixture. The driver and comparator reject missing or incompatible observations and preserve all required runs.

Version the resource profile with positive finite limits and validate it before IO. Initial controlled fixture ceilings per target: 2,000 files, 20,000 chunks, 384 vector dimensions for the local candidate, batch size 32, one index writer and one retrieval worker, 512 MiB total index disk including staging/journal, 32 MiB SQLite cache, 1 GiB isolated retrieval-worker memory and 20,000 vectors per exact scan. Use a 120 s indexing deadline and 10 s retrieval deadline, also subject to remaining question budget. Controlled tests may pin smaller limits to exercise rejection. Record actual work and limit outcomes. These are fixture hypotheses; a required run that exceeds a limit is reported failed/unavailable and cannot be scored as complete. Changes to profiles require a new benchmark binding.
