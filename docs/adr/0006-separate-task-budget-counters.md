# Count model turns, tool calls, and internal events separately

Status: accepted design; implementation pending.

Phase 1 currently charges a single `agentSteps` counter for model proposals and several trusted lifecycle events. This makes the amount of reasoning available to a task depend on how many internal events its implementation emits. Before real tools are integrated, an agent step will mean a model turn. Tool invocations will have a separate count, and internal lifecycle events will not spend either count merely because the runner processes them. Trusted admission and policy will set finite limits; the model cannot increase them.

This decision supersedes ADR 0004 only where it says each automatic event consumes an agent step. The existing Phase 1 code retains that behavior until the budget refinement is implemented and verified. `coding-agent-context/context/progress-checker.md` continues to describe implemented reality.

The MVP budget profiles are fixed as follows:

| Profile | Model turns | Tool-call attempts | General retries | Active work time |
| --- | ---: | ---: | ---: | ---: |
| Small | 30 | 60 | 3 | 30 minutes |
| Medium | 60 | 120 | 5 | 30 minutes |
| Large | 120 | 240 | 8 | 30 minutes |

These limits are design choices for initial measurement, not claims that a task of a given size needs those amounts. Active work time includes model and verification execution and excludes waits for developer input. Internal lifecycle events consume neither model turns nor tool-call attempts. Jev selects the initial size category through the tested three-option `Choice` response; trusted admission maps a valid choice to this fixed table. If classification fails or returns an unusable response, admission uses Medium. Handling a valid but low-confidence choice remains open; the returned probabilities are retained as evidence. The coding model cannot select a profile or numeric limits. There is no separate wall-clock ceiling in the MVP. Provider token and cost limits remain separate later-phase controls.

When a Small or Medium task exhausts its model-turn, tool-call, or retry allowance, trusted budget policy promotes it once to the next fixed profile. Usage is cumulative; promotion does not reset counters or the 30-minute active-work clock. Large is the maximum profile. Reaching a limit at Large, or the shared active-work deadline at any profile, ends the task with `BUDGET_EXHAUSTED` and a portable handoff for a later task. The handoff format and storage boundary still need a separate decision. The existing Phase 1 code has no promotion or automatic handoff; the progress checker remains the source of implemented status.
