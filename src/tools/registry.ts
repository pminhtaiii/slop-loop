import { z } from "zod";

const pathSchema = z.string().min(1).max(1024);
const querySchema = z.string().min(1).max(512);
const profileSchema = z.string().min(1).max(64);
const resultLimitSchema = z.number().int().min(1).max(100);

const toolDefinitions = {
  list_files: {
    description: "List repository paths within a bounded scope.",
    arguments: z.strictObject({ path: pathSchema.optional(), limit: resultLimitSchema.optional() }),
  },
  search_code: {
    description: "Search repository text within a bounded scope.",
    arguments: z.strictObject({
      query: querySchema,
      scope: pathSchema.optional(),
      limit: resultLimitSchema.optional(),
    }),
  },
  read_file: {
    description: "Read one repository file.",
    arguments: z.strictObject({ path: pathSchema }),
  },
  git_diff: {
    description: "Inspect read-only Git diff evidence.",
    arguments: z.strictObject({}),
  },
  apply_patch: {
    description: "Propose a bounded text patch for later authorization.",
    arguments: z.strictObject({ patch: z.string().min(1).max(65_536) }),
  },
  run_tests: {
    description: "Request a trusted test profile and optional logical target.",
    arguments: z.strictObject({ profile: profileSchema, target: pathSchema.optional() }),
  },
  run_build: {
    description: "Request a trusted build profile.",
    arguments: z.strictObject({ profile: profileSchema }),
  },
  run_linter: {
    description: "Request a trusted lint profile.",
    arguments: z.strictObject({ profile: profileSchema }),
  },
  run_typecheck: {
    description: "Request a trusted typecheck profile.",
    arguments: z.strictObject({ profile: profileSchema }),
  },
} as const;

export type ToolName = keyof typeof toolDefinitions;

export type ValidatedToolCall = {
  [Name in ToolName]: {
    readonly name: Name;
    readonly arguments: z.output<(typeof toolDefinitions)[Name]["arguments"]>;
  };
}[ToolName];

export type ValidationResult =
  | { readonly ok: true; readonly call: ValidatedToolCall }
  | {
      readonly ok: false;
      readonly code: "INVALID_CALL" | "UNKNOWN_TOOL" | "INVALID_ARGUMENTS";
    };

export interface ModelToolSchema {
  readonly name: ToolName;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

const proposedCallSchema = z.strictObject({
  name: z.string().min(1).max(64),
  arguments: z.unknown().nonoptional(),
});

function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(toolDefinitions, name);
}

export function validateToolCall(call: unknown): ValidationResult {
  const proposed = proposedCallSchema.safeParse(call);
  if (!proposed.success) {
    return { ok: false, code: "INVALID_CALL" };
  }

  const { name, arguments: rawArguments } = proposed.data;
  if (!isToolName(name)) {
    return { ok: false, code: "UNKNOWN_TOOL" };
  }

  const parsed = toolDefinitions[name].arguments.safeParse(rawArguments);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_ARGUMENTS" };
  }

  return { ok: true, call: { name, arguments: parsed.data } as ValidatedToolCall };
}

export function modelVisibleToolsForNames(names: readonly string[]): readonly ModelToolSchema[] {
  for (const name of names) {
    if (!isToolName(name)) {
      throw new TypeError("Unknown selected tool name");
    }
  }

  const selected = new Set(names);
  return (Object.keys(toolDefinitions) as ToolName[])
    .filter((name) => selected.has(name))
    .map((name) => {
      const definition = toolDefinitions[name];
      return {
        name,
        description: definition.description,
        parameters: z.toJSONSchema(definition.arguments, {
          io: "input",
          target: "draft-2020-12",
          cycles: "throw",
          unrepresentable: "throw",
        }),
      };
    });
}
