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
