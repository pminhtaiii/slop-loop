import { z } from "zod";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  readonly logLevel: LogLevel;
}

const projectedConfigSchema = z
  .object({
    SLOP_LOOP_LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  })
  .strict();

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function removeControlCharacters(str: string): string {
  let result = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code >= 0 && code <= 31) || (code >= 127 && code <= 159)) {
      result += " ";
    } else {
      result += str[i];
    }
  }
  return result;
}

export function formatDiagnosticValue(value: unknown, maxLength = 64): string {
  if (typeof value !== "string") {
    return String(value);
  }
  const sanitized = removeControlCharacters(value).replace(/\s+/g, " ").trim();
  if (sanitized.length <= maxLength) {
    return sanitized;
  }
  return `${sanitized.slice(0, maxLength)}...`;
}

function projectEnvironment(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("SLOP_LOOP_")) {
      projected[key] = value;
    }
  }
  return projected;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const projected = projectEnvironment(env);
  const parseResult = projectedConfigSchema.safeParse(projected);

  if (!parseResult.success) {
    const unrecognizedIssue = parseResult.error.issues.find(
      (issue) => issue.code === "unrecognized_keys",
    );
    if (unrecognizedIssue && "keys" in unrecognizedIssue) {
      const unknownKeys = unrecognizedIssue.keys
        .map((key) => formatDiagnosticValue(key, 64))
        .join(", ");
      throw new ConfigurationError(`Unknown application configuration setting(s): ${unknownKeys}`);
    }

    const rawLogLevel = formatDiagnosticValue(env.SLOP_LOOP_LOG_LEVEL);
    throw new ConfigurationError(
      `Invalid SLOP_LOOP_LOG_LEVEL '${rawLogLevel}'. Accepted values: ${LOG_LEVELS.join(", ")}`,
    );
  }

  return Object.freeze({
    logLevel: parseResult.data.SLOP_LOOP_LOG_LEVEL,
  });
}
