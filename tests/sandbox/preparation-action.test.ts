import { afterEach, expect, it } from "vitest";
import { createGitCheckout } from "../workspace/fixtures.js";
import { selectWorkspace, closeWorkspace } from "../../src/workspace/admission.js";
import * as preparation from "../../src/sandbox/preparation.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
it("requires a locally issued current confirmation instead of a developer-labelled object", () => {
  const checkout = createGitCheckout();
  cleanups.push(() => checkout.cleanup());
  checkout.write("package.json", '{"name":"fixture","private":true}');
  checkout.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const selected = selectWorkspace(checkout.root);
  if (selected.kind !== "SELECTED") throw new Error("Safe workspace unavailable");
  cleanups.push(() => closeWorkspace(selected.workspace));
  const action = preparation.createPreparationAction(selected.workspace, {
    nodeVersion: "24.14.0",
    pnpmVersion: "12.5.1",
    architecture: "linux-x64",
    baseImageDigest: "sha256:" + "a".repeat(64),
    recipeHash: "b".repeat(64),
    managerConfigHash: "c".repeat(64),
    scriptPolicyId: "d".repeat(64),
  });
  expect(() => action.consume({ confirmedBy: "developer" })).toThrow(
    "Preparation confirmation unavailable",
  );
  const receipt = action.confirm(action.challenge);
  checkout.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n# changed\n");
  expect(() => action.consume(receipt)).toThrow("Preparation inputs changed");
});
it("does not reuse or borrow a receipt across preparation actions", () => {
  const checkout = createGitCheckout();
  cleanups.push(() => checkout.cleanup());
  checkout.write("package.json", '{"name":"fixture","private":true}');
  checkout.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const selected = selectWorkspace(checkout.root);
  if (selected.kind !== "SELECTED") throw new Error("Safe workspace unavailable");
  cleanups.push(() => closeWorkspace(selected.workspace));
  const policy = {
    nodeVersion: "24.14.0",
    pnpmVersion: "12.5.1",
    architecture: "linux-x64",
    baseImageDigest: "sha256:" + "a".repeat(64),
    recipeHash: "b".repeat(64),
    managerConfigHash: "c".repeat(64),
    scriptPolicyId: "d".repeat(64),
  };
  const first = preparation.createPreparationAction(selected.workspace, policy);
  const second = preparation.createPreparationAction(selected.workspace, policy);
  const receipt = first.confirm(first.challenge);
  expect(() => second.consume(receipt)).toThrow("Preparation confirmation unavailable");
  expect(first.consume(receipt).fingerprint).toBe(first.fingerprint);
  expect(() => first.consume(receipt)).toThrow("Preparation confirmation unavailable");
});
