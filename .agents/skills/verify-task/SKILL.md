---
name: verify-task
description: Use before worker handoff or when a merger verifies an integrated contributor candidate against approved acceptance criteria. Code review and contributor publication remain separate.
---

# Verify a task

Produce acceptance evidence for the assigned scope. The factory owns the acceptance criteria; the assigned worker or merger exercises them. Mergers follow the [integration verification contract](../../../docs/agents/task-verification.md#merger-integration-and-verification). This skill supplies instructions, not tool-enforced protection or completion authority.

## Bind the scope

Use the supplied task brief and source references. Reuse context only when its declared sources still match; inspect missing or changed passages rather than rereading unrelated documents. Honor repository-required reads. For approved features, resolve the relevant spec, plan, task and decision-record requirements; task excerpts alone may omit acceptance criteria. For maintenance, use the approved brief.

Record candidate HEAD and dirty paths. Pin the governing acceptance sources and affected implementation/test files with `node scripts/agents/agent-context.mjs snapshot --files` and save its JSON in the registered session. Run `node scripts/agents/agent-context.mjs verify --snapshot` before relying on that snapshot and before handoff. Both require path arguments; use `--help` for syntax. Verification reports HEAD drift separately: evaluate it explicitly, and rerun affected checks when candidate inputs change.

Keep governing criteria, expected outputs, required fixtures and evaluation oracles unchanged. Report contradictions or missing prerequisites to the coordinator. Add coverage within assigned ownership; changing the judging materials requires separate factory authorization.

## Exercise the behavior

Map each applicable criterion to an observable expected result from its acceptance source, then select a runnable check. Take commands from the relevant quickstart, testing guidance, package scripts or harness. An independent merger checks the integrated behavior against those expectations and challenges plausible wrong outcomes; replaying worker tests alone is insufficient. Record unmapped criteria as gaps.

- **Launch:** prepare the documented build/profile in isolated task state; confirm the entry point is usable. A library check may need no persistent process.
- **Doctor:** confirm candidate, dependencies and required profile. Missing setup is a blocker, not a product failure or permission to fabricate a replacement.
- **Drive:** run the actual CLI, library boundary or authorized evaluation route named by the criterion. Check outputs and persisted effects; for refusals, check absence of forbidden effects. Unit formatting tests do not establish CLI behavior. Mock runs establish only their exercised mock behavior; real/restart claims need corresponding execution evidence. Respect existing real-execution and provider gates.
- **Evidence:** retain exact commands, exit statuses, relevant output, expected-versus-observed results and artifact paths under the registered `.agent-work/` session. Reuse prior results only when candidate inputs and environment remain applicable. Build success alone establishes no behavioral acceptance.
- **Cleanup:** release only resources created by this run. Retain evidence and confirm it survives cleanup.

Implementing workers repair failures within authorized scope and rerun affected checks. Mergers report defects to the coordinator for repair assignment, then verify the corrected candidate. Stop at a concrete blocker or configured limit; keep the task incomplete.

## Handoff

Return a compact table: `criterion/source | check | expected/observed | PASS/FAIL/BLOCKED/NOT-RUN | evidence`. Include candidate identity, snapshot path, evidence tier, overall verdict and next action. A required criterion without passing applicable evidence leaves verification incomplete. Separate task-scoped success from full-feature acceptance.

Submit through the existing worker handoff lifecycle. The merger returns its candidate-bound verdict and reproducible findings to the coordinator for acceptance or repair dispatch. Independent code review, publication and human merge authority remain separate gates; worker self-verification also precedes independent merger verification.

Adapted from pstack's launch/doctor/drive/evidence/cleanup approach. See [source provenance](references/pstack/SOURCE.md); load the upstream generator only when changing this verification method.
