import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { createLocalPreparationConfiguration } from "../src/sandbox/preparationcomposition.js";
import { createPreparationAction } from "../src/sandbox/preparation.js";
import {
  prepareVerification,
  type PreparationResult,
} from "../src/sandbox/preparationcoordinator.js";
import { selectWorkspace, closeWorkspace } from "../src/workspace/admission.js";

/** Developer-only entry; trusted substitutions let tests exercise the helper without real Docker effects. */
export async function runDeveloperPreparation(
  factory: () => ReturnType<
    typeof createLocalPreparationConfiguration
  > = createLocalPreparationConfiguration,
  ui: {
    readonly launchDirectory?: string;
    readonly prompt?: (challenge: string) => Promise<string>;
  } = {},
): Promise<PreparationResult> {
  let composed: Awaited<ReturnType<typeof createLocalPreparationConfiguration>>;
  try {
    composed = await factory();
  } catch {
    return {
      status: "BLOCKED",
      reason: "Local preparation configuration unavailable",
      cleanup: "CONFIRMED",
    };
  }
  const selected = selectWorkspace(ui.launchDirectory ?? process.cwd());
  if (selected.kind !== "SELECTED")
    return { status: "BLOCKED", reason: "Preparation workspace unavailable", cleanup: "CONFIRMED" };
  let readline: ReturnType<typeof createInterface> | undefined;
  const abort = new AbortController();
  let enteredPreparation = false;
  const cancel = () => abort.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const action = createPreparationAction(selected.workspace, composed.policy);
    const prompt =
      ui.prompt ??
      ((challenge: string) => {
        readline = createInterface({ input: process.stdin, output: process.stderr });
        return readline.question(
          `Type the exact confirmation to prepare this workspace:\n${challenge}\n> `,
          { signal: abort.signal },
        );
      });
    const receipt = action.confirm(await prompt(action.challenge));
    enteredPreparation = true;
    return await prepareVerification({ action, receipt }, composed.configuration, abort.signal);
  } catch {
    if (enteredPreparation)
      return {
        status: abort.signal.aborted ? "CANCELLED" : "BLOCKED",
        reason: "Preparation outcome unconfirmed",
        cleanup: "UNCERTAIN",
      };
    return {
      status: abort.signal.aborted ? "CANCELLED" : "BLOCKED",
      reason: "Developer preparation confirmation unavailable",
      cleanup: "CONFIRMED",
    };
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    readline?.close();
    closeWorkspace(selected.workspace);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runDeveloperPreparation();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "READY") process.exitCode = 1;
}
