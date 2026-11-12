# Subagent Review Report

```text
Reviewer: /root/testability_review; independent Testability & Edge Cases lane.
Candidate: candidate-r2.snapshot.json; SHA-256 60ccd6a576841acd42ade56c197695a5600caa805e33c6c0bb5aea3226a68cf0.
Git: feat/uc06-reviewer-planning; HEAD 540a185011365f7ef68741a1e26abf1d2eb4cdb9.
Verified 86/86 declared inputs before review and again after substantive inspection.
Read r2-delta.md and every changed feature document: review-context/evaluation/decisions contracts, plan/tasks/data-model/quickstart/research; checked connected StatePortV02 public recovery surface and retained R1 source context. Did not consult other lane report or edit judging/runtime sources.

R1 dispositions:
TEST-UC06-001 resolved: trusted profile-bound maxOutputBytes/maxResponseBytes now reach transport options; received bytes are bounded before outer parse, decoded content before inner parse, absent/false lengths/multibyte/escaped bodies/cancellation and observed-versus-uncertain accounting have explicit T005 witnesses.
TEST-UC06-002 resolved: milestone table identifies Q01–Q12 quality and current controlled safety separately from R18 actual restart; explicit quality-pass/restart-and-full-incomplete regression is assigned to T009/T010.

The new ReviewEvidencePortV1 request/result/ACK contract and controlled fixture address observation persistence/lookup explicitly, and graph.ts Deliver plus TaskState-only continuation are now in task ownership. One introduced recovery locator gap remains below. Automated planning validation passes but cannot judge that semantic gap.
```

## Findings

| Severity | Code | Title | Description | Recommendation |
| --- | --- | --- | --- | --- |
| P1 | TEST-UC06-003 | Define a durable locator for the lost-ACK pre-transition window | review-context.md section 6 requires loadObservation to receive exact providerRequestId/contextDigest/observationDigest (:92), but persists the observation before the graph CAS writes its refs (:94). Kill after the owner commits persistObservation and before the acknowledgment arrives/CAS stores refs: resumed TaskState still represents pre-review state and lacks those new digests/request ID. The supplement has only persist/load, its uncertain operationRef is not accepted by load, and StatePortV02 loadTask/recover expose only TaskState, not a review-record discovery operation. The sentence that TaskState-only continuation resolves the key from owner evidence therefore has no specified callable path. A same-process lost-ACK test can pass using retained local request fields while the actual T013 restart case cannot recover that record without inventing another API or relying on private owner journal access. | Specify an owner-serialized, task/candidate-bound locator/discovery or reconciliation operation, or an atomic owner transaction that durably links the record key before acknowledgment, including exact closed request/result schema and stale/multiple/unknown-record outcomes. Keep the operation read-only/no replay and owner-controlled. Add T006 controlled reconstruction with all graph-local keys discarded after committed-but-lost ACK and T013 actual kill at that window; assert recovery finds the original immutable observation/ACK with zero provider re-dispatch or allowance reset. If unavailable, fail closed explicitly and keep the corresponding restart acceptance unmet rather than claim generic restoration. |

## Checks

```text
node scripts/agents/planning-workflow.mjs validate --dir specs/009-reviewer-agent: passed.
node scripts/agents/agent-context.mjs verify --snapshot .agent-work/2026-11-12/uc06-reviewer-planning/candidate-r2.snapshot.json: 86/86 unchanged.
No runtime/provider/container execution was performed by this reviewer. Report format evaluation is separate from substantive review.
```
