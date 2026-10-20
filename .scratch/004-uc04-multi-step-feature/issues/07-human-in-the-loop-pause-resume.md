# 07: Human-in-the-Loop Workflow Pause & Approval Binding Resumption

**What to build:**  
Workflow pause and resumption mechanism for sensitive actions requiring human approval. Integrates with UC-05 approval classification. Persists approval binding hash (`actionDigest + repoCommit + policyVersion`) and transitions task to `waiting_approval`. On resume, ensures approval matches the exact current state before continuing.

**Blocked by:**  
- 05: Process Restart Recovery & Workspace Assumption Reconciliation
- 06: LangGraph Custom Durable Checkpointer

**Status:**  
`completed`

- [x] Implement `handleApprovalRequired(action, taskState, policyVersion)` in `src/workflow/human-pause.ts`.
- [x] Compute deterministic `ApprovalRequestBinding` hash and store in task state.
- [x] Set workflow status to `waiting_approval` and emit persistent checkpoint.
- [x] Implement `resumeWithApproval(taskId, decision)`:
  - Verify decision matches request ID and binding hash.
  - Reject stale decisions if git commit or policy changed.
  - Resume LangGraph workflow at interrupted node.
- [x] Add integration test suite in `tests/runtime/uc04/human-pause.test.ts`.
