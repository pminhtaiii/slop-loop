import { admitTask as admitTrustedTask } from "../../src/orchestration/task.js";
import type { TaskAdmissionAuthority, TaskContext } from "../../src/orchestration/task.js";
import { selectWorkspace } from "../../src/workspace/admission.js";
import { closeWorkspace } from "../../src/workspace/admission.js";
import { createGitCheckout } from "../workspace/fixtures.js";

const fixture = createGitCheckout();
const selected = selectWorkspace(fixture.root);
if (selected.kind !== "SELECTED") {
  fixture.cleanup();
  throw new Error(`Test checkout selection failed: ${selected.reason}`);
}
const selectedWorkspace = selected.workspace;
process.on("exit", () => {
  closeWorkspace(selectedWorkspace);
  fixture.cleanup();
});

export const TEST_WORKSPACE_ID = selectedWorkspace.workspaceId;

/** Existing domain tests use a real selected checkout while varying task inputs. */
type DomainTestAuthority = Omit<TaskAdmissionAuthority, "workspace"> & {
  readonly workspaceId?: string;
};

export function admitTask(
  task: TaskContext,
  now: number,
  requestedProfile: unknown = "Medium",
  authority?: DomainTestAuthority,
): ReturnType<typeof admitTrustedTask> {
  const input: TaskAdmissionAuthority = {
    sessionId: authority?.sessionId ?? "test-session",
    workspace: selectedWorkspace,
    ...(authority?.eligibleTools === undefined ? {} : { eligibleTools: authority.eligibleTools }),
    ...(authority?.capabilities === undefined ? {} : { capabilities: authority.capabilities }),
  };
  return admitTrustedTask(task, now, requestedProfile, input);
}
