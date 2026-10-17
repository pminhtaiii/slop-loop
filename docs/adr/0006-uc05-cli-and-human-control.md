# UC-05 starts with a CLI and prioritizes explicit human control

The project owner selected a CLI for the first UC-05 approval experience on 2026-10-17 (Asia/Saigon), avoiding the additional scope of a web application. The owner confirmed the consolidated shared understanding and closed this grilling session on the same date. These are accepted design decisions, not implementation authorization or a complete implementation specification. Detailed checker rules, latency targets, and fixtures/benchmarks remain deferred. Publication aligns the owning permissions/state guidance and approval matrix with these decisions; future specification work must reconcile implementation contracts and acceptance fixtures before implementation.

Human approval must precede actual production-code changes after investigation and understanding of the problem, preserving the existing UC-03 diagnosis/fix-plan gate. The owner prioritizes human control over autonomous safer workarounds: when a human rejects a request, every agent working on that task stops, including reviewers and background investigation; unrelated tasks may continue. Block new work immediately and cancel running operations where possible. The harness may still record outcomes, stop processes, and preserve recovery state. Report already-completed effects and uncertain outcomes rather than implying rejection reversed them.

The task remains paused until the developer explicitly directs it to resume, revise, or end. Feedback alone does not resume execution, and application restart does not clear the pause. Revised approval-required actions need fresh approval. These stop and continuation decisions were confirmed by the owner on 2026-10-17. They deliberately tighten the previous general reject/adapt behavior in tools_permissions.md. Existing UC-03 plan rejection already waits for human feedback.

UC-05 owns approval classification and decision validity, UC-04 owns durable waiting and recovery, and Tai's shared foundation owns controlled tools and execution. Reuse those boundaries and the accepted shared contracts. UC-01 currently recommends a destination without dispatching work; connecting its output to UC-03 is a later validated integration, not an existing automatic pipeline. Approval never overrides a forbidden action.

## Low-latency action checks

On 2026-10-17, the owner agreed to record and defer the policy-checker direction. Use small deterministic TypeScript helper functions inside the running shared execution gate to validate structured actions against task authority and configured policy before execution. UC-05 owns classification; Tai's foundation invokes it; UC-04 supplies durable approval and pause state. Do not create a competing execution or persistence layer.

Keep the common path inexpensive: load and compile stable policy once, inspect affected paths and patch content rather than scanning the whole repository per action, and avoid a new script process or LLM call for each check. Cache only stable inputs and revalidate mutable repository state immediately before execution. Checks establish permission under policy, not proof that arbitrary code is harmless; isolation and controlled tools remain required.

Implementation, detailed classification rules, latency targets, and fixture/benchmark scope remain deferred. Recording this direction does not authorize runtime implementation.

## Approval authority and prompt

During the interview, the owner expressed no objection to a first version with one developer operating the trusted local CLI as approver. Agent-generated text and repository content cannot themselves submit an approval. The owner accepted a prompt that explains the proposed change, necessity, affected targets, meaningful consequences, and verification status, with the exact command or patch available for inspection. Distinguish plan approval from action-specific permission.

## Plan coverage and enforced boundaries

The owner confirmed that security restrictions remain enforced despite human approval: tests and other repository code must not gain access to .env files, host SSH keys, or other protected data. Approval does not waive isolation, workspace restrictions, or forbidden-action rules. For a known supported risk, explicit approval may authorize the action under those boundaries; it does not provide missing executor controls. The owner expressed no objection to stopping and reporting an unsupported operation when required isolation cannot be established.

An approved fix plan that identifies the affected authentication/authorization areas, intended behavior, and verification covers ordinary implementation edits in those areas. Do not request additional patch approval solely because the paths are security-sensitive. The owner favors fewer redundant interruptions and noted that Git can reverse code changes. Git reversibility does not undo credential disclosure or external side effects, so those remain subject to the enforced boundaries above. Material strategy/scope changes require renewed approval, and existing action-specific gates such as dependency changes and deletion still apply. This rejects the interview's proposed extra security-path patch gate; it does not weaken the existing shared policy.

## Pending and stale requests

The owner confirmed that the entire task pauses while approval is pending, including further model calls and background investigation. The harness may preserve state and handle cancellation, but agents do no additional work until the developer responds. Required approval gates pause their task; ordinary permitted investigation before a gate remains governed by existing policy.

If bound repository state, policy, or action identity changes before execution, revalidate and obtain fresh approval rather than reuse a stale decision. Explain the changed binding to the developer so the renewed prompt has a concrete reason. UC-05 validates the decision, UC-04 retains the durable pending state, and the shared execution gate enforces the pause before effects.
