import { bindDeveloperPreparation } from "../src/sandbox/preparation.js";

const workspaceId = process.env.SLOP_LOOP_WORKSPACE_ID;
const inputFingerprint = process.env.SLOP_LOOP_PREPARATION_FINGERPRINT;
const recipeHash = process.env.SLOP_LOOP_RECIPE_HASH;

if (!workspaceId || !inputFingerprint || !recipeHash) {
  throw new Error(
    "Developer preparation requires SLOP_LOOP_WORKSPACE_ID, SLOP_LOOP_PREPARATION_FINGERPRINT, and SLOP_LOOP_RECIPE_HASH",
  );
}

const binding = bindDeveloperPreparation({
  confirmedBy: "developer",
  workspaceId,
  inputFingerprint,
  recipeHash,
});

process.stdout.write(`${JSON.stringify(binding)}\n`);
