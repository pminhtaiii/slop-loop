import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_DIR = resolve(__dirname, "../..");
const CONTEXT_PATH = resolve(ROOT_DIR, "CONTEXT.md");

describe("Phase 5 spec domain entities synchronization (T131)", () => {
  const contextContent = readFileSync(CONTEXT_PATH, "utf-8");

  const requiredEntities = [
    "Verification snapshot",
    "Prepared verification environment",
    "Verification profile",
    "Verification verdict",
    "Preparation action",
    "Owned execution resource",
  ];

  it.each(requiredEntities)("verifies CONTEXT.md defines key domain entity: %s", (entity) => {
    expect(contextContent).toContain(`**${entity}**:`);
  });

  it("verifies CONTEXT.md includes Phase 5 domain entity definitions", () => {
    expect(contextContent).toContain(
      "Content-identified eligible working-tree inputs and relevant metadata used by one verdict",
    );
    expect(contextContent).toContain(
      "Immutable dependency/toolchain environment bound to a preparation fingerprint and trusted provenance",
    );
    expect(contextContent).toContain(
      "Trusted named checks and their finite limits, selected without arbitrary model-provided commands",
    );
    expect(contextContent).toContain(
      "Aggregate evidence for one snapshot/environment/profile combination, with separate current-checkout freshness",
    );
    expect(contextContent).toContain(
      "Explicit developer authority to build a replacement environment under the trusted recipe and policy",
    );
    expect(contextContent).toContain(
      "Disposable execution object whose ownership is sufficient for bounded cleanup and restart reconciliation",
    );
  });
});
