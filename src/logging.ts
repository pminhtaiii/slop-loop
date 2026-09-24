import pino, { type DestinationStream, type Logger } from "pino";
import type { LogLevel } from "./config.js";

export interface LoggerOptions {
  level?: LogLevel;
  destination?: DestinationStream;
}

export const REDACTED_PATHS = [
  "password",
  "secret",
  "token",
  "key",
  "apiKey",
  "api_key",
  "authorization",
  "Authorization",
  "*.password",
  "*.secret",
  "*.token",
  "*.key",
  "*.apiKey",
  "*.api_key",
  "*.authorization",
  "*.Authorization",
  "*.*.password",
  "*.*.secret",
  "*.*.token",
  "*.*.key",
  "*.*.apiKey",
  "*.*.api_key",
  "*.*.authorization",
  "*.*.Authorization",
  "*.*.*.password",
  "*.*.*.secret",
  "*.*.*.token",
  "*.*.*.key",
  "*.*.*.apiKey",
  "*.*.*.api_key",
  "*.*.*.authorization",
  "*.*.*.Authorization",
] as const;

export const UNTRUSTED_DATA_CATEGORIES = ["repository", "model", "tool"] as const;
export type UntrustedDataCategory = (typeof UNTRUSTED_DATA_CATEGORIES)[number];

/**
 * Wraps untrusted or external data (such as repository contents, model responses,
 * or tool execution outputs) under an application-controlled namespace field so
 * it cannot overwrite core operational log metadata.
 */
export function nestUntrusted(
  category: UntrustedDataCategory,
  data: unknown,
): Record<string, unknown> {
  return {
    [category]: data,
  };
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const destination = options.destination;

  const pinoOptions: pino.LoggerOptions = {
    level,
    base: undefined,
    redact: {
      paths: [...REDACTED_PATHS],
      censor: "[REDACTED]",
    },
  };

  if (destination) {
    return pino(pinoOptions, destination);
  }

  return pino(pinoOptions);
}
