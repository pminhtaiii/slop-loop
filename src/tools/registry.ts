import { z } from "zod";

export interface ToolMetadata {
  readonly requiredCapability:
    "repository_read" | "git_evidence" | "workspace_write" | "verification";
  readonly risk: "LOW" | "MEDIUM";
  readonly effect: "read" | "workspace_mutation" | "sandbox_execution";
  readonly mutation: "none" | "workspace";
  readonly execution: "none" | "trusted_profile";
}

export type ToolCapability = ToolMetadata["requiredCapability"];

const pathSchema = z.string().min(1).max(1024);
const querySchema = z.string().min(1).max(512);
const profileSchema = z.string().min(1).max(64);
const resultLimitSchema = z.number().int().min(1).max(100);
const searchLimitSchema = z.number().int().min(1).max(200);

const sourcePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes(":") &&
      !value.includes("\0") &&
      value
        .split("/")
        .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
  );
const readOutputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("CONTENT"),
    path: sourcePath,
    method: z.literal("workspace-read"),
    content: z.string(),
  }),
  z.strictObject({
    kind: z.literal("SIZE_LIMIT"),
    path: sourcePath,
    method: z.literal("workspace-read"),
  }),
  z.strictObject({
    kind: z.literal("BINARY"),
    path: sourcePath,
    method: z.literal("workspace-read"),
  }),
]);
const searchOutputSchema = z.strictObject({
  kind: z.literal("SEARCH_RESULT"),
  method: z.literal("workspace-search"),
  matches: z
    .array(
      z.strictObject({
        path: sourcePath,
        lineNumber: z.number().int().positive(),
        line: z.string().refine((line) => new TextEncoder().encode(line).byteLength <= 4_096),
        shortened: z.boolean(),
      }),
    )
    .max(200),
  skipped: z.array(z.strictObject({ path: sourcePath, reason: z.enum(["SIZE_LIMIT", "BINARY"]) })),
  omittedMatches: z.boolean(),
  shortenedLines: z.boolean(),
  omittedFiles: z.boolean(),
});

const toolDefinitions = {
  list_files: {
    description: "List repository paths within a bounded scope.",
    arguments: z.strictObject({ path: pathSchema.optional(), limit: resultLimitSchema.optional() }),
    output: { schema: z.unknown(), maxBytes: 16_384 },
    metadata: {
      requiredCapability: "repository_read",
      risk: "LOW",
      effect: "read",
      mutation: "none",
      execution: "none",
    },
  },
  search_code: {
    description: "Search repository text within a bounded scope.",
    arguments: z.strictObject({
      query: querySchema,
      scope: pathSchema.optional(),
      limit: searchLimitSchema.optional(),
    }),
    output: { schema: searchOutputSchema, maxBytes: 32_768 },
    metadata: {
      requiredCapability: "repository_read",
      risk: "LOW",
      effect: "read",
      mutation: "none",
      execution: "none",
    },
  },
  read_file: {
    description: "Read one repository file.",
    arguments: z.strictObject({ path: pathSchema }),
    output: { schema: readOutputSchema, maxBytes: 65_536 },
    metadata: {
      requiredCapability: "repository_read",
      risk: "LOW",
      effect: "read",
      mutation: "none",
      execution: "none",
    },
  },
  git_diff: {
    description: "Inspect read-only Git diff evidence.",
    arguments: z.strictObject({}),
    output: { schema: z.unknown(), maxBytes: 16_384 },
    metadata: {
      requiredCapability: "git_evidence",
      risk: "LOW",
      effect: "read",
      mutation: "none",
      execution: "none",
    },
  },
  apply_patch: {
    description: "Propose a bounded text patch for later authorization.",
    arguments: z.strictObject({ patch: z.string().min(1).max(65_536) }),
    output: { schema: z.unknown(), maxBytes: 16_384 },
    metadata: {
      requiredCapability: "workspace_write",
      risk: "MEDIUM",
      effect: "workspace_mutation",
      mutation: "workspace",
      execution: "none",
    },
  },
  run_tests: {
    description: "Request a trusted test profile and optional logical target.",
    arguments: z.strictObject({ profile: profileSchema, target: pathSchema.optional() }),
    output: { schema: z.unknown(), maxBytes: 16_384 },
    metadata: {
      requiredCapability: "verification",
      risk: "MEDIUM",
      effect: "sandbox_execution",
      mutation: "none",
      execution: "trusted_profile",
    },
  },
  run_build: {
    description: "Request a trusted build profile.",
    arguments: z.strictObject({ profile: profileSchema }),
    output: { schema: z.unknown(), maxBytes: 16_384 },
    metadata: {
      requiredCapability: "verification",
      risk: "MEDIUM",
      effect: "sandbox_execution",
      mutation: "none",
      execution: "trusted_profile",
    },
  },
  run_linter: {
    description: "Request a trusted lint profile.",
    arguments: z.strictObject({ profile: profileSchema }),
    output: { schema: z.unknown(), maxBytes: 16_384 },
    metadata: {
      requiredCapability: "verification",
      risk: "MEDIUM",
      effect: "sandbox_execution",
      mutation: "none",
      execution: "trusted_profile",
    },
  },
  run_typecheck: {
    description: "Request a trusted typecheck profile.",
    arguments: z.strictObject({ profile: profileSchema }),
    output: { schema: z.unknown(), maxBytes: 16_384 },
    metadata: {
      requiredCapability: "verification",
      risk: "MEDIUM",
      effect: "sandbox_execution",
      mutation: "none",
      execution: "trusted_profile",
    },
  },
} as const satisfies Record<
  string,
  {
    readonly description: string;
    readonly arguments: z.ZodType;
    readonly output: { readonly schema: z.ZodType; readonly maxBytes: number };
    readonly metadata: ToolMetadata;
  }
>;

export type ToolName = keyof typeof toolDefinitions;

export function outputContractForName(name: ToolName): {
  readonly schema: z.ZodType;
  readonly maxBytes: number;
} {
  return Object.freeze({ ...toolDefinitions[name].output });
}

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

// Classification is trusted catalog data; it does not authorize or execute a call.
export function toolMetadataForName(name: string): ToolMetadata {
  if (!isToolName(name)) {
    throw new TypeError("Unknown tool name");
  }
  return Object.freeze({ ...toolDefinitions[name].metadata });
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
