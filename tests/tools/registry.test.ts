import { describe, expect, expectTypeOf, it } from "vitest";
import { modelVisibleToolsForNames, validateToolCall } from "../../src/tools/registry.js";
import { selectedToolNamesForMode } from "../../src/tools/selection.js";

const validCalls = [
  { name: "list_files", arguments: {} },
  { name: "search_code", arguments: { query: "TaskContext", scope: "src", limit: 20 } },
  { name: "read_file", arguments: { path: "src/index.ts" } },
  { name: "git_diff", arguments: {} },
  { name: "apply_patch", arguments: { patch: "*** Begin Patch\n*** End Patch" } },
  { name: "run_tests", arguments: { profile: "python", target: "tests/test_math.py" } },
  { name: "run_build", arguments: { profile: "typescript" } },
  { name: "run_linter", arguments: { profile: "typescript" } },
  { name: "run_typecheck", arguments: { profile: "typescript" } },
] as const;

describe("closed tool call validation (T031/T032)", () => {
  it("narrows parsed arguments when a caller checks the tool name", () => {
    const result = validateToolCall({ name: "read_file", arguments: { path: "src/index.ts" } });
    if (result.ok && result.call.name === "read_file") {
      expectTypeOf(result.call.arguments).toEqualTypeOf<{ path: string }>();
    }
  });

  it.each(validCalls)("accepts the registered $name contract", (call) => {
    expect(validateToolCall(call)).toEqual({ ok: true, call });
  });

  it.each([
    null,
    [],
    "read_file",
    {},
    { arguments: {} },
    { name: "read_file" },
    { name: "read_file", arguments: {}, extra: true },
    { name: 42, arguments: {} },
    { name: "", arguments: {} },
  ])("rejects a malformed outer call: %j", (call) => {
    expect(validateToolCall(call)).toEqual({ ok: false, code: "INVALID_CALL" });
  });

  it.each(["shell", "register_tool", "constructor", "__proto__"])(
    "rejects unregistered name %s",
    (name) => {
      expect(validateToolCall({ name, arguments: {} })).toEqual({
        ok: false,
        code: "UNKNOWN_TOOL",
      });
    },
  );

  it("bounds the outer tool name by Unicode code points", () => {
    for (const name of ["x".repeat(64), "😀".repeat(64)]) {
      expect(validateToolCall({ name, arguments: {} })).toEqual({
        ok: false,
        code: "UNKNOWN_TOOL",
      });
    }

    for (const name of ["x".repeat(65), "😀".repeat(65)]) {
      expect(validateToolCall({ name, arguments: {} })).toEqual({
        ok: false,
        code: "INVALID_CALL",
      });
    }
  });

  it.each(validCalls)("rejects unknown argument keys for $name", ({ name, arguments: args }) => {
    expect(validateToolCall({ name, arguments: { ...args, executable: "pwsh" } })).toEqual({
      ok: false,
      code: "INVALID_ARGUMENTS",
    });
  });

  it.each(validCalls)("rejects non-object arguments for $name", ({ name }) => {
    for (const args of [null, [], "", 1]) {
      expect(validateToolCall({ name, arguments: args })).toEqual({
        ok: false,
        code: "INVALID_ARGUMENTS",
      });
    }
  });

  it.each([
    { name: "list_files", arguments: { path: "" } },
    { name: "list_files", arguments: { limit: 0 } },
    { name: "list_files", arguments: { limit: 101 } },
    { name: "list_files", arguments: { limit: 1.5 } },
    { name: "search_code", arguments: {} },
    { name: "search_code", arguments: { query: "" } },
    { name: "search_code", arguments: { query: "x".repeat(513) } },
    { name: "search_code", arguments: { query: "x", scope: "" } },
    { name: "search_code", arguments: { query: "x", limit: "10" } },
    { name: "read_file", arguments: {} },
    { name: "read_file", arguments: { path: "x".repeat(1025) } },
    { name: "git_diff", arguments: { path: "src" } },
    { name: "apply_patch", arguments: {} },
    { name: "apply_patch", arguments: { patch: "" } },
    { name: "apply_patch", arguments: { patch: "x".repeat(65_537) } },
    { name: "run_tests", arguments: {} },
    { name: "run_tests", arguments: { profile: "p", target: "" } },
    { name: "run_build", arguments: { profile: "" } },
    { name: "run_linter", arguments: { profile: 12 } },
    { name: "run_typecheck", arguments: { profile: "x".repeat(65) } },
  ])("rejects missing, wrong-type, and out-of-range input for $name", (call) => {
    expect(validateToolCall(call)).toEqual({ ok: false, code: "INVALID_ARGUMENTS" });
  });

  it("counts supplementary-plane characters as one character at the advertised limit", () => {
    expect(validateToolCall({ name: "read_file", arguments: { path: "😀".repeat(1024) } }).ok).toBe(
      true,
    );
    expect(validateToolCall({ name: "read_file", arguments: { path: "😀".repeat(1025) } })).toEqual(
      { ok: false, code: "INVALID_ARGUMENTS" },
    );
  });

  it("keeps raw query and patch text out of validation errors", () => {
    for (const call of [
      { name: "search_code", arguments: { query: "private-query", shell: "pwsh" } },
      { name: "apply_patch", arguments: { patch: "private-patch", command: "pwsh" } },
    ]) {
      const result = validateToolCall(call);
      expect(result).toEqual({ ok: false, code: "INVALID_ARGUMENTS" });
      expect(JSON.stringify(result)).not.toContain("private-");
    }
  });
});

type ExpectedField =
  | { readonly type: "string"; readonly minLength: number; readonly maxLength: number }
  | { readonly type: "integer"; readonly minimum: number; readonly maximum: number };

interface ExpectedContract {
  readonly name: string;
  readonly validArguments: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
  readonly fields: Readonly<Record<string, ExpectedField>>;
}

const expectedContracts: readonly ExpectedContract[] = [
  {
    name: "list_files",
    validArguments: {},
    required: [],
    fields: {
      path: { type: "string", minLength: 1, maxLength: 1024 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
  {
    name: "search_code",
    validArguments: { query: "x" },
    required: ["query"],
    fields: {
      query: { type: "string", minLength: 1, maxLength: 512 },
      scope: { type: "string", minLength: 1, maxLength: 1024 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
  {
    name: "read_file",
    validArguments: { path: "x" },
    required: ["path"],
    fields: { path: { type: "string", minLength: 1, maxLength: 1024 } },
  },
  { name: "git_diff", validArguments: {}, required: [], fields: {} },
  {
    name: "apply_patch",
    validArguments: { patch: "x" },
    required: ["patch"],
    fields: { patch: { type: "string", minLength: 1, maxLength: 65_536 } },
  },
  {
    name: "run_tests",
    validArguments: { profile: "x" },
    required: ["profile"],
    fields: {
      profile: { type: "string", minLength: 1, maxLength: 64 },
      target: { type: "string", minLength: 1, maxLength: 1024 },
    },
  },
  {
    name: "run_build",
    validArguments: { profile: "x" },
    required: ["profile"],
    fields: { profile: { type: "string", minLength: 1, maxLength: 64 } },
  },
  {
    name: "run_linter",
    validArguments: { profile: "x" },
    required: ["profile"],
    fields: { profile: { type: "string", minLength: 1, maxLength: 64 } },
  },
  {
    name: "run_typecheck",
    validArguments: { profile: "x" },
    required: ["profile"],
    fields: { profile: { type: "string", minLength: 1, maxLength: 64 } },
  },
];

describe("trusted tool selection and advertised contracts (T033/T034)", () => {
  it("selects exactly four Ask and nine Edit names", () => {
    expect(selectedToolNamesForMode("Ask")).toEqual([
      "list_files",
      "search_code",
      "read_file",
      "git_diff",
    ]);
    expect(selectedToolNamesForMode("Edit")).toEqual([
      "list_files",
      "search_code",
      "read_file",
      "git_diff",
      "apply_patch",
      "run_tests",
      "run_build",
      "run_linter",
      "run_typecheck",
    ]);
  });

  it("advertises only selected names in stable catalog order", () => {
    const askNames = selectedToolNamesForMode("Ask");
    expect(modelVisibleToolsForNames(askNames).map((tool) => tool.name)).toEqual(askNames);
    expect(
      modelVisibleToolsForNames(selectedToolNamesForMode("Edit")).map((tool) => tool.name),
    ).toEqual(expectedContracts.map((contract) => contract.name));
    expect(
      modelVisibleToolsForNames(["run_tests", "read_file", "read_file"]).map((tool) => tool.name),
    ).toEqual(["read_file", "run_tests"]);
  });

  it("rejects the whole selection when any candidate is unregistered", () => {
    expect(() => modelVisibleToolsForNames(["read_file", "shell"])).toThrow();
    expect(() => modelVisibleToolsForNames(["__proto__"])).toThrow();
  });

  it("does not let callers change future trusted selections or schemas", () => {
    const ask = selectedToolNamesForMode("Ask");
    expect(() => (ask as string[]).push("apply_patch")).toThrow(TypeError);

    const first = modelVisibleToolsForNames(["read_file"])[0];
    expect(first).toBeDefined();
    if (!first) return;
    (first.parameters as { properties: Record<string, unknown> }).properties.path = {
      type: "number",
    };

    const second = modelVisibleToolsForNames(["read_file"])[0];
    expect(second?.parameters).toMatchObject({
      properties: { path: { type: "string", minLength: 1, maxLength: 1024 } },
    });
  });

  it.each(expectedContracts)("advertises and accepts the same strict $name inputs", (contract) => {
    const schema = modelVisibleToolsForNames([contract.name])[0];
    expect(schema).toBeDefined();
    expect(schema?.description.length).toBeGreaterThan(0);
    const parameters = schema?.parameters as {
      $schema: string;
      type: string;
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
      additionalProperties: boolean;
    };
    expect(parameters.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(parameters.type).toBe("object");
    expect(parameters.additionalProperties).toBe(false);
    expect(Object.keys(parameters.properties)).toEqual(Object.keys(contract.fields));
    expect(parameters.required ?? []).toEqual(contract.required);

    expect(validateToolCall({ name: contract.name, arguments: contract.validArguments }).ok).toBe(
      true,
    );

    for (const [field, expected] of Object.entries(contract.fields)) {
      expect(parameters.properties[field]).toMatchObject(expected);
      const withoutField = { ...contract.validArguments } as Record<string, unknown>;
      delete withoutField[field];
      expect(validateToolCall({ name: contract.name, arguments: withoutField }).ok).toBe(
        !contract.required.includes(field),
      );

      if (expected.type === "string") {
        const maxLength = expected.maxLength;
        for (const [value, accepted] of [
          ["x", true],
          ["😀".repeat(maxLength), true],
          ["", false],
          ["😀".repeat(maxLength + 1), false],
          [7, false],
        ] as const) {
          expect(
            validateToolCall({
              name: contract.name,
              arguments: { ...contract.validArguments, [field]: value },
            }).ok,
          ).toBe(accepted);
        }
      } else {
        for (const [value, accepted] of [
          [1, true],
          [100, true],
          [0, false],
          [101, false],
          [1.5, false],
          ["1", false],
        ] as const) {
          expect(
            validateToolCall({
              name: contract.name,
              arguments: { ...contract.validArguments, [field]: value },
            }).ok,
          ).toBe(accepted);
        }
      }
    }

    expect(
      validateToolCall({
        name: contract.name,
        arguments: { ...contract.validArguments, unexpected: true },
      }).ok,
    ).toBe(false);
  });
});
