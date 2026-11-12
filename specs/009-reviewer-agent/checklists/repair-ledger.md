# Planning Repair Ledger: UC-06

Final disposition: all findings resolved by both independent R3 lanes; no downgrade. Runtime verification remains future work. R1/R2 reports retain their original candidates.

| ID | Severity | Reproducer / criterion | Repair and planned regression | Final candidate |
|---|---|---|---|---|
| STD-UC06-001 | P1 | BaselineEvidenceWriter baseline-only; required observation ACK had no API | review-context section 6: exact UC-04 supplement; T002/T006 schemas, write/read/ACK/current lookup and controlled fixture | R3 resolved |
| STD-UC06-002 | P2 | T014 omitted affected context ownership | T014 architecture/evaluation/testing owned paths and evidence-based updater | R3 resolved |
| TEST-UC06-001 | P1 | response.text/outer+inner JSON before reviewer cap | Host-bound response/content caps, bounded reader, T005 byte/usage/coder compatibility witnesses | R3 resolved |
| TEST-UC06-002 | P1 | Quality inherited separately gated R18 restart | Per-milestone IDs/tiers; T009/T010 quality-pass/restart-full-incomplete regression | R3 resolved |
| TEST-UC06-003 | P1 | Lost ACK before graph CAS leaves no lookup locator on TaskState-only resume | recoverObservation by owner current candidate, atomic discovery index/latest request; T002/T006 reconstruction and T013 actual kill before ACK/CAS | R3 resolved |

R3 snapshot SHA-256: d84cbf17ba5d64fb6f435f8316df93df2bcd043c1c9a67de02cb3c5bb095e8aa. HEAD/branch unchanged. Source hashes below are the final reviewed bytes. See planning-validation.md for lane/report/candidate provenance.

## Current source SHA-256

- contracts/review-context.md: 5edf8b1833f633cd6f4536a7e586768db3f9d9e3f12412018b3ca9c075949e6a
- contracts/evaluation.md: 90d41c600441ceb56c336294a56abf4de9e270d076f9cde6ba1f8112c9a8de16
- contracts/decisions.md: 40a519e9c9ede2bc86e135cd4ab503cdefb95608ec996a85e724a49ac08da5da
- plan.md: 573ee677026a478dd0ba4c25765f4b0919b43a51ab7aa570b0ce611cc48217fb
- tasks.md: eadf6a53637cebeb2e676d736bdab5402113dcdf45c7602540e254c8b80bb254
- data-model.md: 67f15ad596af9f164d799b53cb798cc88ba55ee8886932595b134ea3079190c1
- quickstart.md: 764a9e2136682835a7960b68cf23a2ea73e0a9d3f7f01ff676ed584deb8c7866
- research.md: 9d34ea5ba6b0f6e242672ea09352a1efb596a0481cf93260434d8a4367980927
