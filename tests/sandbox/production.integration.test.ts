import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { LocalDockerPort } from "../../src/sandbox/localdocker.js";
import { VerificationAttempt } from "../../src/sandbox/attempt.js";
import { captureSnapshot } from "../../src/sandbox/snapshot.js";
import { DEFAULT_SANDBOX_LIMITS, createPreparationFingerprint } from "../../src/sandbox/config.js";
import { validatePreparedImage } from "../../src/sandbox/preparation.js";
import { selectWorkspace, closeWorkspace } from "../../src/workspace/admission.js";
import { createGitCheckout } from "../workspace/fixtures.js";
import { createTask, admitTask } from "../../src/orchestration/task.js";
import { advanceTask } from "../../src/orchestration/transitions.js";
import { TaskRunner, TaskCheckoutSlot } from "../../src/orchestration/runner.js";
import type { AuditSink } from "../../src/tools/gateway.js";

// Only a developer-provisioned private fixture record is accepted. No pull/install/preparation.
const fixtureSchema = z.object({
  workspacePath: z.string().min(1),
  image: z.object({ imageId: z.string(), fingerprint: z.string(), architecture: z.string() }),
  inputs: z.object({
    manifestHash: z.string(),
    lockfileHash: z.string(),
    managerConfigHash: z.string(),
    scriptPolicyId: z.string(),
    nodeVersion: z.string(),
    pnpmVersion: z.string(),
    architecture: z.string(),
    baseImageDigest: z.string(),
    recipeHash: z.string(),
  }),
});
it("verifies edited TypeScript and native source through the production Docker composition", async ({
  skip,
}) => {
  const port = new LocalDockerPort();
  try {
    const readiness = await port.readiness();
    if (!readiness.limitsEnforced)
      skip("UNAVAILABLE: supported trusted local Docker Engine is not accessible");
  } finally {
    expect(port.dispose()).toBe("CONFIRMED");
  }
  const recordPath = process.env.SLOP_LOOP_PREPARED_FIXTURE_RECORD;
  if (!recordPath) skip("UNAVAILABLE: developer-provisioned prepared fixture record is missing");
  const record = fixtureSchema.parse(JSON.parse(fs.readFileSync(recordPath!, "utf8")));
  const image = validatePreparedImage(record.image);
  expect(image.fingerprint).toBe(createPreparationFingerprint(record.inputs));
  const original = selectWorkspace(record.workspacePath);
  if (original.kind !== "SELECTED") throw new Error("Fixture safe workspace unavailable");
  const copied = await captureSnapshot(original.workspace, {
    ...DEFAULT_SANDBOX_LIMITS,
    exclusionPolicyId: "reference-v1",
  }).finally(() => closeWorkspace(original.workspace));
  const checkout = createGitCheckout();
  let workspace: ReturnType<typeof selectWorkspace> | undefined;
  try {
    for (const entry of copied.entries) {
      const destination = path.join(checkout.root, ...entry.path.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, entry.content);
      fs.chmodSync(path.join(checkout.root, ...entry.path.split("/")), entry.mode);
    }
    workspace = selectWorkspace(checkout.root);
    if (workspace.kind !== "SELECTED") throw new Error("Fixture safe clone unavailable");
    const selected = workspace.workspace;
    const log = path.join(
      path.dirname(checkout.root),
      path.basename(checkout.root) + "-canonical.jsonl",
    );
    const persisted = new Map<string, string>();
    const audit: AuditSink = {
      appendIfAbsent: async (event) => {
        const encoded = JSON.stringify(event),
          previous = persisted.get(event.eventId);
        if (previous !== undefined)
          return previous === encoded
            ? { status: "COMMITTED", eventId: event.eventId }
            : { status: "INTEGRITY_FAILURE" };
        const file = await fs.promises.open(log, "a", 0o600);
        try {
          await file.writeFile(encoded + "\n");
          await file.sync();
          persisted.set(event.eventId, encoded);
          return { status: "COMMITTED", eventId: event.eventId };
        } finally {
          await file.close();
        }
      },
    };
    const newAttempt = (id: string) => {
      let task = admitTask(
        createTask({ taskId: id, objective: "verify captured changes", mode: "Edit" }),
        0,
        "Large",
        { sessionId: "production-fixture", workspace: selected },
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
      return {
        runner,
        attempt: new VerificationAttempt({
          runner,
          workspace: selected,
          image,
          inputs: record.inputs,
          audit,
          limits: DEFAULT_SANDBOX_LIMITS,
        }),
      };
    };
    try {
      const full = newAttempt("production-full");
      for (const [index, call] of [
        { name: "run_tests", arguments: { profile: "ordinary" } },
        { name: "run_linter", arguments: { profile: "lint" } },
        { name: "run_typecheck", arguments: { profile: "typecheck" } },
        { name: "run_build", arguments: { profile: "build" } },
      ].entries())
        expect((await full.attempt.dispatch(call, index + 1))[0]).toMatchObject({
          kind: "EXECUTED",
          result: { status: "PASS", cleanup: "CONFIRMED", nativePrelude: "PASS" },
        });
      expect(full.runner.task.state).toBe("REVIEWING");
      const tsPath = "src/index.ts";
      const tsOriginal = fs.readFileSync(path.join(checkout.root, tsPath), "utf8");
      checkout.write(
        tsPath,
        tsOriginal + "\nconst milestoneTypeError: number = 'changed captured source';\n",
      );
      const ts = newAttempt("production-typescript-change");
      const tsResult = (
        await ts.attempt.dispatch({ name: "run_typecheck", arguments: { profile: "typecheck" } }, 1)
      )[0];
      expect(tsResult).toMatchObject({
        kind: "EXECUTED",
        result: {
          status: "FAIL",
          terminationReason: "EXITED",
          nativePrelude: "PASS",
          cleanup: "CONFIRMED",
        },
      });
      const diagnostics = z
        .object({ exitCode: z.number(), output: z.string() })
        .parse(tsResult?.kind === "EXECUTED" ? tsResult.result : null);
      expect(diagnostics.exitCode).not.toBe(0);
      expect(diagnostics.output).toContain("TS2322");
      expect(ts.runner.task.state).toBe("VERIFYING");
      checkout.write(tsPath, tsOriginal);
      const nativePath = "native/workspace/addon.cc";
      checkout.write(nativePath, "#error MILESTONE_2_CAPTURED_NATIVE_SOURCE\n");
      const native = newAttempt("production-native-change");
      const failed = (
        await native.attempt.dispatch({ name: "run_build", arguments: { profile: "build" } }, 1)
      )[0];
      expect(failed).toMatchObject({
        kind: "EXECUTED",
        result: {
          status: "FAIL",
          nativePrelude: "FAIL",
          terminationReason: "EXITED",
          cleanup: "CONFIRMED",
        },
      });
      expect(
        z.object({ output: z.string() }).parse(failed?.kind === "EXECUTED" ? failed.result : null)
          .output,
      ).toContain("MILESTONE_2_CAPTURED_NATIVE_SOURCE");
      expect(native.runner.task.state).toBe("VERIFYING");
      expect(fs.readFileSync(path.join(checkout.root, nativePath), "utf8")).toBe(
        "#error MILESTONE_2_CAPTURED_NATIVE_SOURCE\n",
      );
    } finally {
      if (fs.existsSync(log)) fs.unlinkSync(log);
    }
  } finally {
    if (workspace?.kind === "SELECTED") closeWorkspace(workspace.workspace);
    checkout.cleanup();
  }
}, 1200000);
