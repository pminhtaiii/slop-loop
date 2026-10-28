# Decisions, Provenance and Release Gates: UC-04

## Authorization and source baseline

The 2026-10-21 request authorizes reading, authoring, validation, independent planning reviews, a new feature branch, scoped commits and paired PR publication against development. Its final explicit publication instructions supersede its earlier no-push/no-PR sentence for this documentation assignment. It authorizes no runtime/test implementation, foreign feature edits, capability promotion, issue changes or merge.

The user subsequently stated: “21/10/2026 12:28, Thanh Tân nhờ tôi viết spec giúp cho UC4”. Record this as user-relayed authoring delegation from Thanh Tan, at 12:28 Asia/Saigon (session timezone). It is not direct owner contact, acceptance of this new package, production selection or implementation authorization.

Authoring branch: `feat/037-uc04-recovery-spec`, created from fetched public development `c0adbe1b80229609cdfcbfdde7f8cfd51a60d205`. Local branches, both live head inventories and paginated all-state PR histories were inspected on 2026-10-21. Identifier 034 is used by UC-01, maximum observed was 036; 037 was unused. No UC-04 artifacts existed under `specs/` at that base. The read-only UC-04 assignment returned `NEEDS_PLANNING`, owner Thanh Tan; that report grants no authority. Before publication, public PR #77 was observed merged externally; this branch fast-forwarded to public development `7b6f83190ca9bebccb11266d7f3654f5909f797b`. The fetched public and submission development tracked trees then matched exactly, permitting a paired diff confined to these UC-04 artifacts. This assignment performed no merge of a PR or write to either base.

## Existing agreements reused without expansion

| Source | Established boundary | Evidence limit |
|---|---|---|
| [ADR-0007](../../../docs/adr/0007-uc04-task-pause-and-recovery-foundation.md), accepted 2026-10-20 Asia/Saigon | Scripted foundation first; task pause; bounded in-flight completion; early-resume refusal; deliberate pause survives restart; validated automatic recovery; drift reassessment; safe requested status; inspectable local history | Planning behavior, not implementation or backend selection |
| [UC-03 decisions](../../001-verified-code-repair/contracts/decisions.md), user confirmation 2026-10-16 | v0.1 shared ownership: Thanh Tan `src/persistence/`, StatePort/accounting/recovery; Tai contracts/execution/verification; Trong Tan approvals | Historical agreement on that contract, not this extension or adapter delivery |
| [UC-03 interfaces](../../001-verified-code-repair/contracts/interfaces.md), canonical schema 0.1.0 | CAS, atomic multi-budget reservation, stable request identity, original pricing, charged uncertainty, command-view identity; both model roles | Pure validators/mock checks do not prove durable behavior |
| [UC-05 decisions](../../003-uc05-human-approval/contracts/decisions.md), confirmation 2026-10-19 | User-relayed three-owner agreement: companion control/journal/claim transactions, epoch fencing, immutable resolution and exact-digest renewal | Reuse `uc05-approval/0.1-draft`; do not infer agreement on deliberate-pause representation |
| [UC-05 interfaces](../../003-uc05-human-approval/contracts/interfaces.md) and [data model](../../003-uc05-human-approval/data-model.md) | Store atomic pending+pause, resolution, stale-pending replacement and directions; shared epoch/claim linearization; no runnable gap | UC-05 owns decision validity, not storage; real adapter/restart gates remain |
| [ADR-0004](../../../docs/adr/0004-uc03-adaptive-workflow-and-replan-limit.md), [ADR-0006](../../../docs/adr/0006-uc05-cli-and-human-control.md) | UC-03 strategy/replans; UC-05 human control, pending/rejection stop, fresh binding | UC-04 stores accounting/control, does not extend those workflows |

## Conflicts and evidence hygiene

- AGENTS.md restricts UC-03 to Phase 2 while its decisions/spec/ledger record Phase 3 authorization. Do not resolve this by choosing the broader grant. UC-04 references only stable contract semantics; any UC-03 implementation/integration release requires owner reconciliation of that conflict.
- Initial IDE branch `feat/033-uc05-exact-plan-binding` at `ac6e09b` contained UC-05 amendments absent from the initial public development snapshot. Those record T011–T013 and T025–T027 local checks. They subsequently arrived through externally merged public PR #77 and the fast-forward above, not as authored UC-04 changes. Their local evidence still proves no durable delivery; inspect exact dependency revisions before integration and retain source authorization boundaries.
- The delegation map says UC-04 artifacts are “Not created”; this was true at the base. This draft does not change that row to approved. The assignment report may continue `NEEDS_PLANNING` until an authorized context update links approved artifacts.
- The constitution is an unratified placeholder. Existing AGENTS/context/ADRs govern; no artificial constitution pass or owner approval is recorded.
- User scope restricts the PR to UC-04 feature artifacts. The usual plan-skill AGENTS managed-block update is therefore deferred, as are delegation/context edits. The ignored `.specify/feature.json` selects this feature locally. Context review must record no runtime capability change.

## Open decisions and external gates

These are explicit release dependencies, not silently resolved defaults. The backend-neutral proposal can be reviewed/published while implementation readiness remains closed. No unresolved choice is deemed approved by a clean marker scan.

| Gate | Required decision/evidence | Accountable owner | Release affected |
|---|---|---|---|
| G-AUTH | Explicit phase/task authorization and confirmed public test seams | User with Thanh Tan | Every ledger task; all currently unauthorized |
| G-EXTENSION | Review this logical recovery extension: independent deliberate-pause record, compatibility mapping, exact method/receipt schemas and detailed owned paths | Thanh Tan + Trong Tan + Tai | T002 onward; no new canonical/approval modes by assumption |
| G-STORE | Select storage/checkpointer and crash/concurrency transaction design, durability acknowledgment, supported local host, schema/migration/corruption policy and storage isolation | Thanh Tan, Tai for shared composition | T004 and all durability claims |
| G-CONTROL | Select trusted UC-04 pause/resume/status surface and authority; agree composition with UC-05 direction semantics | Thanh Tan + Trong Tan + Tai | T007 and real control integration; no invented CLI grammar |
| G-PROFILE | Explicit finite bounds, pricing/config identity, artifact/redaction/access profile; authorized increase protocol | Owning foundation/policy owners with Thanh Tan | Real budgeted actions; fixture values are not defaults |
| G-RETENTION | Local inspection/deletion authorization, format and mechanics protecting unresolved data; no automatic TTL selected | Thanh Tan + project owner | Deletion/history lifecycle; read-only inspection can precede it |
| X05-GATE | Actual UC-05 validity/decision/control adapter and ledger/revision evidence | Trong Tan | Integrated approval cases; scripted seam does not deliver this |
| X03-ADMISSION | Actual shared task-wide provider/tool/reviewer admission, executor fencing/reconciliation, current repository/view and verification evidence; UC-03 authorization conflict resolved where relevant | Tai | Real integration and feature workflow |
| G-FEATURE | Separately approve representative integrated feature input/strategy/completion contract and shared paths | Thanh Tan + Tai + Trong Tan where approval changes | Later feature-workflow phase, no implementation tasks released here |
| G-MEMORY | Separately specify cross-task repository knowledge, stale checks and user lifecycle | Thanh Tan + project owner | Later memory phase; not claimed by compaction |

## Recorded authorizations and implementation selections (2026-10-21)

On 2026-10-21 (Asia/Saigon), the user authorized execution of Phases 1 through 7 (Tasks T001 through T012) on branch `feat/037-uc04-recovery-spec`:
- **G-AUTH**: Full authorization granted for T001–T012 under TDD.
- **G-EXTENSION**: Confirmed logical recovery extension `uc04-recovery/0.1-draft` and paths in `src/persistence/` (`contracts.ts`, `store.ts`, `recovery.ts`, `task-control.ts`, `accounting.ts`, `inspection.ts`), test paths in `tests/runtime/uc04/`, and support paths in `tests/runtime/support/uc04/`. Independent deliberate pause record is composed via sidecar, preserving canonical UC-03 and UC-05 companion contracts without altering foreign files.
- **G-STORE**: Selected durable atomic file-backed JSON store adapter (`DurableStore`) with atomic temp write + rename, checksums, CAS versions, and coherent checkpoint directory layout (`.slop-loop/state/` or injected test root).
- **G-CONTROL**: Deliberate pause / resume / task status interface defined behind `src/persistence/task-control.ts` interacting with `ApprovalStore` without modifying UC-05 mode enums.
- **G-PROFILE**: Test profile with explicit finite token/cost/repair limits and pricing identifiers registered in `tests/runtime/support/uc04/scenarios.ts`.
- **Public test seams**: Confirmed public exports in `src/persistence/` and controlled ports in `tests/runtime/support/uc04/controlled-ports.ts`.

Review quality, contract agreement, adapter evidence and implementation authorization are four separate facts.
