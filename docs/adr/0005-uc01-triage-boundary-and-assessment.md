# UC-01 assesses issues through shared foundations

Accepted with the project owner on 2026-10-17. Thai owns UC-01 research and triage; Tai owns the shared foundation and UC-03 debugging and repair. This records agreed planning decisions for Thai's future spec, not implementation authorization or evidence of runtime capability.

UC-01 initially handles one supplied issue for one selected repository. The LLM produces classification, an impact-based severity recommendation and rationale, supporting evidence, missing information, and a recommended backend destination. There is no separate LLM call to rewrite the report: its extra latency does not justify an additional interpretation stage. Preserve the original report and distinguish reporter claims from repository findings. Cite only supplied evidence or evidence actually returned by available shared tools; explicitly identify assessments based solely on the reporter's account.

Ask for clarification when an unknown could materially change intended behavior, scope, or the next route. Otherwise continue bounded research and retain uncertainty. UC-01 returns missing-information questions to its caller and accepts supplied answers on a later invocation. Clarification supplies facts or intent; it does not authorize an action. UC-05 retains action classification and approval authority, and UC-04 retains durable waiting and recovery. Standalone fixtures can exercise these interactions before integration.

## Shared boundary and routing

Thai consumes Tai's shared repository read/search interfaces rather than implementing competing tools. Develop against controlled fixtures while foundations are unavailable; agree additional shared capabilities with Tai before changing interfaces. UC-01 depends on the foundation, not on UC-03 execution. Command execution, reproduction, verified diagnosis, edits, and repair remain UC-03 responsibilities. Existing UC-03 contracts and approved artifacts are unchanged.

The application supplies an explicit list of supported backend destinations and their responsibilities. The LLM recommends only from that list or returns `undetermined`; UC-01 does not dispatch work. UC-04 recovery and UC-05 approval are shared capabilities, not ordinary issue destinations. Later integration must validate the receiving workflow's input and preserve its authority. Recommendation now and dispatch later avoid coupling Thai's first delivery to the other use cases.

## Severity recommendation

P0–P3 express impact-based severity here, not business priority, scheduling order, or response deadlines. Evaluate affected functionality, affected users, and available workarounds using identifiable evidence rather than reporter urgency. Feature requests do not automatically receive defect-severity ratings.

| Level | Meaning |
|---|---|
| P0 | Widespread loss of essential functionality, ongoing data loss, or comparably severe impact; no viable workaround |
| P1 | Major functionality blocked for a substantial affected group; no reasonable workaround |
| P2 | Meaningful impairment with limited impact or a reasonable workaround |
| P3 | Minor inconvenience or cosmetic defect with little functional impact |
| undetermined | Available information cannot support a level |

Thai's spec must make these qualitative thresholds testable with examples. It must define the detailed schema, configured classifications/destinations, bounded model/tool behavior, validation, and evaluation cases. These implementation details were not selected by this discussion. Contributor GitHub triage helpers and labels do not establish product-runtime UC-01 behavior. This planning effort fits one grilling session; a multi-session Wayfinder map is unnecessary for the agreed scope.
