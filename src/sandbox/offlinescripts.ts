import { createHash } from "node:crypto";
import { z } from "zod";
import { isValidatedGraph, type LockedGraph } from "./downloads.js";
import { validateNormalizedPackage, type VerifiedPackage } from "./packagecontent.js";

const policySchema = z
  .array(
    z.strictObject({
      nodeKey: z.string().min(1).max(2048),
      integrity: z.string().min(1).max(256),
      phase: z.enum(["preinstall", "install", "postinstall"]),
      commandHash: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
  )
  .max(30_000);
export type ExactScriptApproval = z.infer<typeof policySchema>[number];
export interface OfflineScriptInstruction {
  readonly nodeKey: string;
  readonly root: string;
  readonly integrity: string;
  readonly phase: "preinstall" | "install" | "postinstall";
  readonly command: string;
}
const plans = new WeakSet<object>();
export function isOfflineScriptPlan(value: unknown): value is readonly OfflineScriptInstruction[] {
  return typeof value === "object" && value !== null && plans.has(value);
}
export function offlineScriptPolicyIdentity(policy: readonly ExactScriptApproval[]): string {
  const canonical = policySchema
    .parse(policy)
    .map((entry) => JSON.stringify(entry))
    .sort();
  return createHash("sha256")
    .update(`offline-script-policy-v1:${JSON.stringify(canonical)}`)
    .digest("hex");
}

/** Derivation only. Execution must additionally be fenced by sealed tree and CAS-free recipient. */
export function planOfflineScripts(
  graph: LockedGraph,
  packages: readonly VerifiedPackage[],
  policy: readonly ExactScriptApproval[],
): readonly OfflineScriptInstruction[] {
  if (!isValidatedGraph(graph)) throw new Error("Untrusted locked graph");
  const approvals = policySchema.parse(policy);
  const matched = new Set<ExactScriptApproval>();
  const instructions: OfflineScriptInstruction[] = [];
  const identities = new Map(packages.map((pkg) => [pkg.identity, pkg]));
  if (identities.size !== packages.length) throw new Error("Duplicate verified package identity");
  for (const node of graph.nodes) {
    const pkg = identities.get(node.artifact);
    if (!pkg) throw new Error("Missing verified package");
    validateNormalizedPackage(pkg, pkg.files);
    if (
      graph.artifacts.find((artifact) => `${artifact.name}@${artifact.version}` === pkg.identity)
        ?.integrity !== pkg.integrity
    )
      throw new Error("Script artifact identity mismatch");
    for (const phase of ["preinstall", "install", "postinstall"] as const) {
      const command = pkg.scripts[phase];
      if (command === undefined) continue;
      const commandHash = createHash("sha256").update(command).digest("hex");
      const candidates = approvals.filter(
        (approval) =>
          approval.nodeKey === node.key &&
          approval.integrity === pkg.integrity &&
          approval.phase === phase &&
          approval.commandHash === commandHash,
      );
      if (candidates.length !== 1) throw new Error("Exact dependency script approval unavailable");
      matched.add(candidates[0]!);
      instructions.push(
        Object.freeze({
          nodeKey: node.key,
          root: node.root,
          integrity: pkg.integrity,
          phase,
          command,
        }),
      );
    }
  }
  if (matched.size !== approvals.length)
    throw new Error("Script policy does not match authenticated content");
  const plan = Object.freeze(instructions);
  plans.add(plan);
  return plan;
}
