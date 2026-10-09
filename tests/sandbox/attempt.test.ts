import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { VerificationAttempt } from "../../src/sandbox/attempt.js";
import { createGitCheckout } from "../workspace/fixtures.js";
import { selectWorkspace, closeWorkspace } from "../../src/workspace/admission.js";
import { createTask, admitTask } from "../../src/orchestration/task.js";
import { advanceTask } from "../../src/orchestration/transitions.js";
import { TaskRunner, TaskCheckoutSlot } from "../../src/orchestration/runner.js";
import { DEFAULT_SANDBOX_LIMITS, createPreparationFingerprint } from "../../src/sandbox/config.js";
import type { SandboxBackend } from "../../src/sandbox/types.js";
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
function fixture() {
  const checkout = createGitCheckout();
  cleanups.push(() => checkout.cleanup());
  const manifest = '{"name":"fixture","private":true}';
  const lock = "lockfileVersion: 9.0";
  checkout.write("package.json", manifest);
  checkout.write("pnpm-lock.yaml", lock);
  const selected = selectWorkspace(checkout.root);
  if (selected.kind !== "SELECTED") throw new Error("Required safe workspace unavailable");
  cleanups.push(() => closeWorkspace(selected.workspace));
  let task = admitTask(
    createTask({ taskId: "source-attempt", objective: "verify", mode: "Edit" }),
    0,
    "Medium",
    { sessionId: "session", workspace: selected.workspace },
  );
  for (const state of [
    "INSPECTING",
    "PLANNING",
    "WAITING_FOR_FILE_PERMISSION",
    "IMPLEMENTING",
    "SANDBOX_READY",
    "VERIFYING",
  ] as const)
    task = advanceTask(task, state);
  const runner = new TaskRunner(task, new TaskCheckoutSlot());
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const inputs = {
    manifestHash: hash(manifest),
    lockfileHash: hash(lock),
    managerConfigHash: "trusted-config",
    scriptPolicyId: "exact-policy",
    nodeVersion: "24.14.0",
    pnpmVersion: "12.5.1",
    architecture: "linux-x64",
    baseImageDigest: "sha256:" + "a".repeat(64),
    recipeHash: "trusted-recipe",
  };
  const image = {
    imageId: "sha256:" + "b".repeat(64),
    fingerprint: createPreparationFingerprint(inputs),
    architecture: "linux-x64",
    status: "READY" as const,
  };
  return { checkout, workspace: selected.workspace, runner, inputs, image };
}
it("retains one real captured snapshot across four audited gateway calls before issuing a receipt", async () => {
  const f = fixture();
  const snapshots: string[] = [];
  const events: import("../../src/tools/gateway.js").AuditEvent[] = [];
  const backend: SandboxBackend = {
    readiness: () => Promise.resolve({ status: "READY" }),
    executeCheck: (input) => {
      snapshots.push(input.snapshot.snapshotId);
      const ack = input.runtime.cleanup?.hold("source-resource-" + input.target.check);
      ack?.("CONFIRMED");
      const { argv: _argv, ...target } = input.target;
      void _argv;
      return Promise.resolve({
        ...target,
        snapshotId: input.snapshot.snapshotId,
        imageId: input.image.imageId,
        preparationFingerprint: input.image.fingerprint,
        status: "PASS" as const,
        cleanup: "CONFIRMED" as const,
        exitCode: 0,
        truncated: false,
        terminationReason: "EXITED" as const,
        nativePrelude: "NOT_REQUIRED" as const,
      });
    },
  };
  const attempt = new VerificationAttempt({
    ...f,
    backend,
    limits: DEFAULT_SANDBOX_LIMITS,
    audit: {
      appendIfAbsent: (event: import("../../src/tools/gateway.js").AuditEvent) => {
        events.push(event);
        return Promise.resolve({ status: "COMMITTED" as const, eventId: event.eventId });
      },
    },
  });
  for (const [index, call] of [
    { name: "run_tests", arguments: { profile: "ordinary" } },
    { name: "run_linter", arguments: { profile: "lint" } },
    { name: "run_typecheck", arguments: { profile: "typecheck" } },
    { name: "run_build", arguments: { profile: "build" } },
  ].entries()) {
    const result = await attempt.dispatch(call, index + 1);
    expect(result[0]).toMatchObject({ kind: "EXECUTED" });
    expect(f.runner.task.state).toBe(index === 3 ? "REVIEWING" : "VERIFYING");
  }
  expect(events.filter((event) => event.kind === "RESULT")).toHaveLength(4);
  for (const event of events.filter((event) => event.kind === "RESULT"))
    expect(event).toHaveProperty(
      "verificationEvidenceDigest",
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
  expect(snapshots).toHaveLength(4);
  expect(new Set(snapshots).size).toBe(1);
  f.checkout.write("src/tracked.ts", "export const drift=99;");
  expect(f.runner.process({ kind: "MODEL_PROPOSAL", action: "COMPLETE" }, 5).status).toBe(
    "ACTION_REJECTED",
  );
}, 60000);

it("rejects concurrent dispatch before sharing pending canonical evidence", async () => {
  const f = fixture();
  const backend: SandboxBackend = {
    readiness: () => Promise.resolve({ status: "READY" }),
    executeCheck: () => Promise.reject(new Error("fixture stops before execution")),
  };
  const attempt = new VerificationAttempt({
    ...f,
    backend,
    limits: DEFAULT_SANDBOX_LIMITS,
    audit: {
      appendIfAbsent: (event) => Promise.resolve({ status: "COMMITTED", eventId: event.eventId }),
    },
  });
  const first = attempt.dispatch({ name: "run_tests", arguments: { profile: "ordinary" } }, 1);
  try {
    await expect(
      attempt.dispatch({ name: "run_linter", arguments: { profile: "lint" } }, 2),
    ).rejects.toThrow("Verification dispatch already active");
  } finally {
    await first;
  }
}, 60000);

it("blocks captured dependency drift before invoking the verification backend", async () => {
  const f = fixture();
  f.checkout.write("package.json", '{"name":"changed-dependency-input"}');
  let executions = 0;
  const backend: SandboxBackend = {
    readiness: () => Promise.resolve({ status: "READY" }),
    executeCheck: () => {
      executions++;
      return Promise.reject(new Error("must not execute drifted dependencies"));
    },
  };
  const attempt = new VerificationAttempt({
    ...f,
    backend,
    limits: DEFAULT_SANDBOX_LIMITS,
    audit: {
      appendIfAbsent: (event) => Promise.resolve({ status: "COMMITTED", eventId: event.eventId }),
    },
  });
  await attempt.dispatch({ name: "run_tests", arguments: { profile: "ordinary" } }, 1);
  expect(executions).toBe(0);
  expect(f.runner.task.state).toBe("BLOCKED");
  expect(f.runner.task.outcome?.reason).toBe("IMAGE_STALE");
}, 60000);
