import type { ToolName } from "./registry.js";

const ASK_NAMES = Object.freeze([
  "list_files",
  "search_code",
  "read_file",
  "git_diff",
] satisfies ToolName[]);

const EDIT_NAMES = Object.freeze([
  ...ASK_NAMES,
  "apply_patch",
  "run_tests",
  "run_build",
  "run_linter",
  "run_typecheck",
] satisfies ToolName[]);

export function selectedToolNamesForMode(mode: "Ask" | "Edit"): readonly ToolName[] {
  if (mode === "Ask") {
    return ASK_NAMES;
  }
  if (mode === "Edit") {
    return EDIT_NAMES;
  }
  throw new TypeError("Unknown task mode");
}
