/** Derive answer presence only from a validated current owner record matching the execution snapshot. */
import { computeCanonicalSha256, validateTaskState, type StatePortV02, type TaskState } from '../../src/contracts/foundation/uc03.ts';

export async function clarificationWasAnswered(state: TaskState, owner: Pick<StatePortV02, 'loadTask'> | undefined): Promise<boolean> {
  if (!state.clarification?.answer || !owner) return false;
  let current: unknown;
  try {
    current = await owner.loadTask(state.taskId);
  } catch {
    return false;
  }
  const checked = validateTaskState(current);
  return checked.ok && checked.value.clarification?.answer !== undefined && computeCanonicalSha256(checked.value) === computeCanonicalSha256(state);
}
