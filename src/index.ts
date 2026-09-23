import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DestinationStream } from "pino";
import { type AppConfig, ConfigurationError, loadConfig } from "./config.js";
import { createLogger } from "./logging.js";

export interface StartOptions {
  env?: NodeJS.ProcessEnv;
  destination?: DestinationStream;
}

export interface StartResult {
  status: "started";
  config: AppConfig;
}

export function start(options: StartOptions = {}): StartResult {
  const config = loadConfig(options.env);
  const logger = createLogger({
    level: config.logLevel,
    destination: options.destination,
  });

  logger.info({ status: "started", logLevel: config.logLevel }, "Application started");

  return {
    status: "started",
    config,
  };
}

function main(): void {
  try {
    start();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`Configuration error: ${error.message}\n`);
    } else {
      process.stderr.write(`Startup error: ${(error as Error).message}\n`);
    }
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
) {
  main();
}
