import pino, { type DestinationStream, type Logger } from "pino";
import type { LogLevel } from "./config.js";

export interface LoggerOptions {
  level?: LogLevel;
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const destination = options.destination;

  const pinoOptions: pino.LoggerOptions = {
    level,
    base: undefined,
    redact: {
      paths: ["*.password", "*.secret", "*.token", "*.key", "password", "secret", "token", "key"],
      censor: "[REDACTED]",
    },
  };

  if (destination) {
    return pino(pinoOptions, destination);
  }

  return pino(pinoOptions);
}
