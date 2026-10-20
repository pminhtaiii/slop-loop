# 09: End-to-End Multi-Step Feature Workflow & Process Crash Suite

**What to build:**  
Complete automated end-to-end integration and chaos suite proving all UC-04 verification criteria:
1. Multi-step feature execution across step transitions.
2. Real OS process kill (SIGKILL) mid-step, followed by new process invocation.
3. Proof that completed work is never repeated and budget survives.
4. Human approval pause and valid continuation.
5. Verification evidence against the `State, checkpoint, and recovery` matrix.

**Blocked by:**  
- 06: LangGraph Custom Durable Checkpointer
- 07: Human-in-the-Loop Workflow Pause & Approval Binding Resumption
- 08: Context Compactor & Advisory Long-Term Memory Store

**Status:**  
`completed`

- [x] Create fixture multi-step task with 3 sequential coding steps.
- [x] Implement automated test spawning child Node process running step 1 to completion.
- [x] Simulate sudden process death before step 2 starts; spawn new child process.
- [x] Assert step 1 is skipped, step 2 and step 3 execute to completion.
- [x] Test crash during active budget reservation; assert reservation remains charged and is settled upon recovery.
- [x] Test human approval required on step 2; assert child process pauses and exits cleanly with `waiting_approval`.
- [x] Run test suite via `pnpm run test:runtime` or `node --test` and record verification evidence.
