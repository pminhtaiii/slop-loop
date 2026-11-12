# Subagent Review Report

```text
Reviewer: `/root/testability_review`, independent Testability & Edge Cases lane.
Date: 2026-11-12 (Asia/Saigon).
Candidate: `candidate-r1.snapshot.json`, SHA-256 `efb8dd112798e9b4aa002efa011495d2456174ffd31a7c8747d15f902ed581d1`; 83/83 declared inputs verified before and after inspection. Git branch `feat/uc06-reviewer-planning`, HEAD `540a185011365f7ef68741a1e26abf1d2eb4cdb9`, unchanged during this review.
```

## Coverage and judgment

```text
Read every feature top-level planning artifact and every file under contracts/, the generated testability brief, planning/review workflow, runtime permissions/policy, and relevant existing reviewer, DeepSeek transport, model caps and shared admission code. Checked story/FR/SC coverage against tasks, old/new/revision locations, evidence/rationale validation, prompt injection/read-only constraints, missing/stale verification, request/iteration/accounting/recovery, independent labels and tier separation. Did not read the other review lane's report. No runtime/source or remote changes.

The package correctly reuses the reviewer, identifies empty graph evidence and planner-only prompting, separates owner authorization from planning quality, and leaves implementation tasks unchecked. Two contract gaps need resolution before implementation. Explicit external owner/delivery gates themselves are not findings.
```

## Findings

| Severity | Code | Title | Description | Recommendation |
| --- | --- | --- | --- | --- |
| P1 | TEST-UC06-001 | Define trusted transport byte-limit propagation before parsing | review-context.md:39 gives arbitrary profile maxOutputBytes, :43 defines the new trusted transport option as exactly version/digest while keeping caps/request unchanged, and :54 requires byte rejection before JSON parsing/forwarding. Existing deepseek-transport.ts:244 reads the entire response with response.text(), :250 parses the outer JSON and :194 parses inner model JSON before RuntimeReviewer receives content; HostModelCaps has no byte field. The reviewer can only apply its profile cap after these earlier parse/forward boundaries, and the planned exact transport option carries no cap. A conforming implementation can therefore pass the fake reviewer oversized-output test while its real transport allocates/parses unbounded or above-profile payloads. T005's general output-limit phrase does not specify the required trusted bound/propagation or over-limit accounting behavior. | Define a host-owned, profile-bound transport byte-cap seam (without trusting synthetic repository evidence for policy), distinguish outer response bytes from inner reviewer-content bytes, enforce bounded reading/inner cap before their respective parses, and specify charged uncertainty/observed-usage behavior when the cap prevents usage parsing. Add T005/T007 chunked/misleading-content-length and above-profile inner-content witnesses plus preserved coder compatibility. |
| P1 | TEST-UC06-002 | Give quality and restart distinct required coverage sets | evaluation.md:20 makes all R01–R20 required suite coverage; :24 includes R18 in the additional R05–R20 handling cases; :32 requires all adversarial handling cases to pass for real quality; :42 says a required-case not-run makes quality incomplete. R18 is actual process restart owned by T013, but tasks.md makes T012 quality and T013 restart independent successors of T011 and the spec/plan promise separate quality/restart milestones. With a valid 12-case model run and all ordinary safety handling passing while G-RESTART is closed, one implementer must fail quality because R18 is not-run, while another can report quality pass from its selected score. The intended independent milestone acceptance is not deterministic. | Define exact required IDs/tiers per controlled handling, real integrated review, real quality and restart acceptance, and a separate full-feature/suite aggregate that retains all R01–R20. State explicitly whether R18 can remain not-run while the bounded quality milestone passes; if it must block quality, add the actual dependency and revise the claimed separation. Add a grading/report regression for 12 quality cases passing with restart unavailable, asserting both the quality-specific outcome and incomplete full acceptance. |

## Verification

```text
`node scripts/agents/agent-context.mjs verify --snapshot .agent-work/2026-11-12/uc06-reviewer-planning/candidate-r1.snapshot.json`: 83/83 unchanged before and after review.

Report-format evaluation is recorded separately; a structurally valid report with these two P1 rows is a blocking semantic result, not a planning pass. No source tests or real execution were run by this reviewer.
```
