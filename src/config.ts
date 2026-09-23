import { z } from "zod";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  readonly logLevel: LogLevel;
}

const logLevelSchema = z.enum(LOG_LEVELS);

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const unknownKeys = Object.keys(env).filter(
    (key) => key.startsWith("SLOP_LOOP_") && key !== "SLOP_LOOP_LOG_LEVEL",
  );

  if (unknownKeys.length > 0) {
    throw new ConfigurationError(
      `Unknown application configuration setting(s): ${unknownKeys.join(", ")}`,
    );
  }

  const rawLogLevel = env.SLOP_LOOP_LOG_LEVEL ?? "info";

  const parseResult = logLevelSchema.safeParse(rawLogLevel);
  if (!parseResult.success) {
    throw new ConfigurationError(
      `Invalid SLOP_LOOP_LOG_LEVEL '${rawLogLevel}'. Accepted values: ${LOG_LEVELS.join(", ")}`,
    );
  }

  return Object.freeze({
    logLevel: parseResult.data,
  });
}
