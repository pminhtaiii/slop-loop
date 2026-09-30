# Implementation Plan: Policy Engine and Capabilities

**Branch**: feat/004-policy-engine-capabilities | **Date**: 2026-09-28 | **Spec**: [spec.md](spec.md)

## Summary

Build a pure PolicyEngine behind the mandatory ToolGateway. The gateway privately holds fake executor references and proves allow-only invocation, fresh authority checks, budget accounting, pre-execution evidence, and safe result handling. Reconcile the Phase 1 runner with ADR 0006/0007 before integration. Phase 2 registry source is a prerequisite. Real filesystem, grant, process, and JSONL adapters remain later work.

## Technical Context

- **Language/Version**: TypeScript 5.8, Node.js 24, ESM.
- **Dependencies**: Existing Zod 4 and Pino 10; no new production package.
- **Storage**: In-memory task state and fake audit/grant stores for tests. Phase 12 owns canonical JSONL.
- **Testing**: Vitest 3, TypeScript, ESLint, Prettier, pinned pnpm 12.5.1.
- **Platform**: Local Windows and Ubuntu CLI.
- **Performance**: Deterministic in-process checks per dispatched call; no model-based similarity pass.
- **Constraints**: One in-flight call per task; no executor call without explicit allow and committed pre-evidence; bounded output/evidence; fail closed on untrustworthy authority facts.
- **Scope**: Nine fixed Phase 2 tool names; one active checkout slot; one in-memory session with multiple tasks.

## Authority and Integration Gates

The constitution file is still a template. Apply CONTEXT.md, the context map, tool policy, workflow, testing guide, progress checker, and ADR 0001/0002/0005/0006/0007/0008. The existing runner's mutable mode, single agent-step counter, and wall-clock deadline conflict with ADR 0006/0007. Reconcile and re-verify them before gateway integration. Phase 2's planned registry is not implemented in this checkout. Phase 0's exit gate and the combined pinned-manager quality gate remain prerequisites. Fake Phase 3 proofs must not be described as integrated containment or durable audit enforcement.

## Implementation Sequence

### 1. Reconcile the Phase 1 runner

Update src/orchestration/task.ts, budget.ts, transitions.ts, runner.ts, and existing tests. Fix one mode at admission; remove same-task mode transitions. Count model turns on model requests and tool attempts on individual gateway dispatch, including invalid, unknown, and denied calls. Internal events spend neither. Use ADR 0006 Small/Medium/Large turn and attempt limits, cumulative trusted promotions, and a 30-minute active-work deadline excluding human waits. Seal the shared retry ceiling from the initial profile. Verification/repair, model recovery, and denial recovery spend that counter; exhaustion ends without promotion. Produce a bounded handoff for every finite-budget terminal outcome. Stop blocks new work, signals abort, fences late results, and holds the checkout slot through safe cleanup. Revise tests encoding superseded behavior.

### 2. Extend the closed tool definition

Use Phase 2's nine-name registry as the sole source for input schema, trusted capability/effect metadata, mutation/execution classification, and selection. Do not create a second policy name list. Define output, runtime, and output-size contracts before each real adapter is enabled; Phase 3 fake executors use explicit fixture contracts. Registry validation alone never authorizes. If Phase 2 source is absent, wait for its implementation rather than duplicating it.

### 3. Implement pure policy and authority facts

Add src/policy with TaskCapabilityCeiling, invocation-scoped trusted context, and ALLOW/NEEDS_FILE_PERMISSION/DENY decisions. Admission seals task/session/workspace identity, mode, eligible tools and resources, promotion schedule, and initial retry ceiling. Evaluate validated calls and immutable facts only. A workspace port supplies trusted canonical repository-relative path facts; a grant port supplies exact revocable update/create facts. Reads do not prompt. A validly forbidden path is DENY; missing/invalid trusted facts and policy exceptions become FAILED / POLICY_FAILURE at the gateway/runner boundary. Phase 3 uses fakes; Phase 4 and Phase 7 own real providers.

### 4. Implement the mandatory gateway

Add src/tools/gateway.ts as the only application-facing invoke path. Keep executor instances and dispatch mapping private to composition scope; no outside module receives an executor reference or direct invoke function. On each serial dispatch: verify task/slot and one-in-flight rule; assign correlation ID and charge one attempt via runner-owned budget state; revalidate against registry; gather fresh trusted facts; evaluate policy; append bounded canonical request/decision evidence; invoke exactly one executor only on ALLOW with confirmed pre-append; validate, bound, normalize, sanitize, and redact the result; append bounded result evidence. Audit is an execution prerequisite, never policy input. Unknown/malformed calls still get bounded evidence without raw arguments. Failed pre-append blocks all model-visible calls, including reads, as BLOCKED / AUDIT_UNAVAILABLE with zero executor calls.

After pre-evidence commits, atomically recheck the task's cancellation generation before executor start; a stop that won during awaited fact collection or append skips execution. Effect status is separate from output validity. If result append fails after a possible effect, notify the developer, halt dispatch, and retry a small finite number of times through appendIfAbsent with the same event ID and payload. Never replay the executor or start a background queue. Unconfirmed evidence is BLOCKED / AUDIT_INCOMPLETE. Invalid output after an effect is typed contract failure; do not infer unchanged checkout. Real adapters later must cap captured bytes before unbounded materialization. Phase 3 fake tests post-capture handling.

### 5. Integrate runner, gateway, and fakes

Drive model proposals serially through runner → gateway → fake executor. The first ordinary DENY discards remaining proposals in that response; only the dispatched call spends an attempt. A new model response after denial spends one shared recovery retry. Exhaustion ends at the current profile without promotion. Test stop during an in-flight call, audit outage, uncertain append acknowledgement, stale grants, path-fact failure, malformed/unknown calls, invalid results, and budget handoffs.

## Project Structure

- specs/004-policy-engine-capabilities/: spec.md, plan.md, research.md, data-model.md, quickstart.md, contracts/, tasks.md.
- src/orchestration/: existing Phase 1 task, budget, transitions, runner.
- src/policy/: pure policy types and engine.
- src/tools/: Phase 2 registry/selection and Phase 3 gateway.
- tests/orchestration/, tests/policy/, tests/tools/: revised lifecycle, pure policy, fake gateway proof.

Keep the existing single-project layout. Policy lives apart from gateway side effects. Fakes live with tests, not as product adapters.

## Verification and Exit Evidence

Follow [quickstart.md](quickstart.md). Focused tests must show zero executor calls on every non-allow path, one call only after committed pre-evidence, no duplicate executor/event after uncertain result append, separate budget counters, fixed mode, stop fencing, and complete terminal handoffs. Run pinned pnpm lint, format, typecheck, test, build, and smoke on the combined checkout. Update testing.md and progress-checker.md only when implementation evidence exists. Actual Phase 4/7/12 integrations are separate exit gates.
