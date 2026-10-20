# Trusted Operator CLI: UC-05

**Status**: Logical protocol agreed through T001; see [decisions](decisions.md). T007 and separately authorized T010 supply list/show/inspect/decide/control parsing and actual subprocess tests through explicit mock composition. Direct executable entry is unconfigured and returns unavailable; real connection to UC-04 remains gated at T020. SIGINT/SIGTERM checks observe parent-retained mock snapshots, not durable runtime restart. This introduces no project-wide CLI framework.

## Trust and commands

The host composition supplies operator capability, store and trusted context independently of task inputs. Repository containers, tools, model output and agent roles have no operator capability or access to host approval state. Possession of a request ID or JSON actor string is not authentication. Initial trust is the signed-in local OS developer; access by a different malicious host user is outside the single-operator deployment profile and must be denied through host permissions, not simulated identity fields.

Proposed command entry point after build: `node dist/src/approvals/cli.js`. No package.json bin or new dependency is required for the first version.

| Command / required arguments | Behavior |
|---|---|
| list --task TASK | Bounded current request/control metadata; never all tasks by implicit default |
| show --task TASK --request DECISION | Five decision elements, binding fingerprint, versions, status and presentation digest |
| inspect --task TASK --request DECISION --page N | Bounded safely admitted exact command/patch page, stable digest/version; no arbitrary file/artifact path |
| decide --task TASK --request DECISION --task-version V --request-version R --presentation-digest DIGEST --decision approve or reject --response-key KEY | Submit explicit response to the displayed version; no repository execution; duplicate same response returns original result |
| control --task TASK --task-version V --direction resume or revise or end --response-key KEY | Explicit task direction; never approval; preserves rejection and uncertain claims |

Arguments are structured tokens; the phrase "approve or reject" above denotes two accepted values, not a literal multiword argument. Reject missing/duplicate/unknown flags, foreign task/request, malformed versions/digests, unbounded input, terminal escape/control characters in IDs, and conflicting response keys. Optional feedback is excluded in this slice: factual answers go to the task's separate clarification path, not control commands.

## Presentation and input behavior

- Show action, necessity, targets, consequences, verification status and permitted exact details reference before a decision. Request/presentation digests bind to the same registered action/context. A changed presentation or binding conflicts and requires renewed inspection, rather than silently approving changed work.
- Human-readable stdout contains bounded escaped metadata. Inspection is an explicit protected-data-checked display, never a copy of raw tool streams. No secret-bearing input is persisted for redaction later. If full required action details exceed the admitted inspection bound, refuse that operation with a safe explanation rather than permit approval of hidden/truncated semantics.
- Escape control sequences, ANSI/OSC and bidirectional formatting characters in untrusted labels; isolate trusted controls visually from task data. User-controlled text cannot introduce commands or spoof approve/reject controls.
- A CLI invocation is bounded and exits with task pause retained. Empty/malformed input, EOF, Ctrl+C, terminal loss, storage timeout and uncertain commit never imply approval, resume or rejection reversal. A retry reads authoritative status first.
- Exact operator response is accepted only through host operator composition; identical strings in source, diagnostics or prompts remain data. Test subprocesses use an explicitly injected test driver, which is unavailable in production composition.

## Result/exit contract

Structured result metadata (if requested by a configured host adapter) contains schemaVersion, outcome, safeReasonCode, taskId, decisionId when applicable, versions, event reference, and safe next action. It excludes action bodies, unrestricted note text, credentials and protected source. Human output and JSON use the same projection.

| Exit | Meaning |
|---|---|
| 0 | Read/decision/direction recorded or idempotently confirmed; approval does not mean action executed |
| 2 | Invalid arguments/input |
| 3 | Pending, paused, stale or conflicting request; developer action/inspection required |
| 4 | Forbidden operation or operator authority denied |
| 5 | Store unavailable, failed or uncertain; task remains non-runnable pending reconciliation |

No command supports force, autoapprove, ignore-policy, reset-budget or direct tool execution. CLI parser tests use real subprocesses; storage/executor mock tests are labelled as such. T020 validates the host capability boundary and real store; T021 checks process/terminal interruption and durable pause retention.

## Phase 4 control clarification (planning only)

The existing control command has exactly four required selectors: task, task-version, direction and response-key. It has no request selector and must not inherit the decide parser's request requirement. Resume/revise can release only a rejection hold with healthy records and no outstanding claims; waiting, recovery-blocked and ended modes remain blocked. End is accepted from any non-ended mode and preserves unresolved evidence. For a new response, host context supplies the registered safe scope and current epoch for CAS; missing scope is denial, not an implicit active task or caller-provided authority. For a retry, the same four argv selectors identify the accepted direction in authoritative history: validate the original submitted version/direction and reuse its stored scope/epoch and receipt identity, without rebinding to current state.

A recorded or identically confirmed direction exits 0 with `approval-cli-recorded`, including end whose outcome remains paused. Unrecorded paused/conflict/stale outcomes retain exit 3 and `approval-cli-denied`; invalid, denied and unavailable/uncertain retain exits 2, 4 and 5. A duplicate response cannot clear later holds. No command runs repository work or creates approval.

Input remains argv-only. Closed stdin/EOF supplies no response. Before a valid response commits, empty/malformed input, Ctrl+C or terminal loss supplies no consent and retains the pause. After commit, interruption cannot undo the accepted response; an uncertain result requires authoritative readback, not blind retry. Forced termination may provide only an OS signal/exit observation, without a structured envelope. Phase 4 proves these paths only with an explicit subprocess test driver and parent-retained mock state; durable terminal/restart acceptance remains T021.
