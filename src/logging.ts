import pino, { type DestinationStream, type Logger } from "pino";
import type { LogLevel } from "./config.js";

export interface LoggerOptions {
  level?: LogLevel;
  destination?: DestinationStream;
}

export const REDACTION_TARGET_KEYS = [
  "password",
  "secret",
  "token",
  "key",
  "apiKey",
  "api_key",
  "authorization",
  "Authorization",
  "access_token",
  "accessToken",
  "client_secret",
  "clientSecret",
] as const;

export const REDACTED_PATHS: readonly string[] = [
  ...REDACTION_TARGET_KEYS,
  ...REDACTION_TARGET_KEYS.map((k) => `*.${k}`),
  ...REDACTION_TARGET_KEYS.map((k) => `*.*.${k}`),
  ...REDACTION_TARGET_KEYS.map((k) => `*.*.*.${k}`),
  ...REDACTION_TARGET_KEYS.map((k) => `*.*.*.*.${k}`),
  ...REDACTION_TARGET_KEYS.map((k) => `*.*.*.*.*.${k}`),
  ...REDACTION_TARGET_KEYS.map((k) => `*.*.*.*.*.*.${k}`),
  ...REDACTION_TARGET_KEYS.map((k) => `*.*.*.*.*.*.*.${k}`),
];

export const UNTRUSTED_DATA_CATEGORIES = ["repository", "model", "tool"] as const;
export type UntrustedDataCategory = (typeof UNTRUSTED_DATA_CATEGORIES)[number];

export const MAX_UNTRUSTED_STRING_LENGTH = 1024;
export const MAX_UNTRUSTED_KEY_LENGTH = 128;
export const MAX_UNTRUSTED_ARRAY_LENGTH = 50;
export const MAX_UNTRUSTED_OBJECT_KEYS = 50;
export const MAX_UNTRUSTED_DEPTH = 5;
export const MAX_UNTRUSTED_TOTAL_NODES = 500;

interface TraversalState {
  nodeCount: number;
}

const SENSITIVE_KEY_NAMES = new Set([
  "password",
  "secret",
  "token",
  "key",
  "apikey",
  "api_key",
  "authorization",
  "access_token",
  "accesstoken",
  "client_secret",
  "clientsecret",
]);

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_NAMES.has(key.toLowerCase());
}

export function boundUntrustedData(
  data: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  state: TraversalState = { nodeCount: 0 },
): unknown {
  state.nodeCount++;
  if (state.nodeCount > MAX_UNTRUSTED_TOTAL_NODES) {
    return "[TRUNCATED_NODES]";
  }
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === "string") {
    if (data.length > MAX_UNTRUSTED_STRING_LENGTH) {
      return `${data.slice(0, MAX_UNTRUSTED_STRING_LENGTH)}... [truncated]`;
    }
    return data;
  }

  if (typeof data === "number" || typeof data === "boolean") {
    return data;
  }

  if (typeof data === "bigint") {
    return data.toString();
  }

  if (depth >= MAX_UNTRUSTED_DEPTH) {
    return "[TRUNCATED_DEPTH]";
  }

  if (typeof data === "object") {
    if (seen.has(data)) {
      return "[CIRCULAR]";
    }
    seen.add(data);

    try {
      if (typeof (data as { toJSON?: unknown }).toJSON === "function") {
        try {
          const json = (data as { toJSON: () => unknown }).toJSON();
          if (json !== data) {
            return boundUntrustedData(json, depth, seen, state);
          }
        } catch {
          return "[UNSERIALIZABLE]";
        }
      }

      if (Array.isArray(data)) {
        const isTruncated = data.length > MAX_UNTRUSTED_ARRAY_LENGTH;
        const sliced = data.slice(0, MAX_UNTRUSTED_ARRAY_LENGTH);
        const boundedArray = sliced.map((item) => boundUntrustedData(item, depth + 1, seen, state));
        if (isTruncated) {
          boundedArray.push("[TRUNCATED_ITEMS]");
        }
        return boundedArray;
      }

      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      let keyCount = 0;
      let isTruncated = false;

      for (const key in data) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) {
          continue;
        }
        if (keyCount >= MAX_UNTRUSTED_OBJECT_KEYS) {
          isTruncated = true;
          break;
        }
        keyCount++;

        let targetKey = key;
        if (targetKey.length > MAX_UNTRUSTED_KEY_LENGTH) {
          targetKey = `${targetKey.slice(0, MAX_UNTRUSTED_KEY_LENGTH)}...`;
          let collisionIndex = 1;
          while (targetKey in result) {
            targetKey = `${key.slice(0, MAX_UNTRUSTED_KEY_LENGTH)}..._${collisionIndex++}`;
          }
        }

        if (isSensitiveKey(key)) {
          result[targetKey] = "[REDACTED]";
        } else {
          result[targetKey] = boundUntrustedData(
            (data as Record<string, unknown>)[key],
            depth + 1,
            seen,
            state,
          );
        }
      }

      if (isTruncated) {
        result._truncated = "[TRUNCATED_KEYS]";
      }

      return result;
    } finally {
      seen.delete(data);
    }
  }

  if (typeof data === "symbol") {
    return data.toString();
  }

  if (typeof data === "function") {
    return data.name ? `[Function: ${data.name}]` : "[Function]";
  }

  return "[UNKNOWN]";
}

/**
 * Wraps untrusted or external data (such as repository contents, model responses,
 * or tool execution outputs) under an application-controlled namespace field so
 * it cannot overwrite core operational log metadata, bounding size and depth
 * and redacting sensitive credentials.
 */
export function nestUntrusted(
  category: UntrustedDataCategory,
  data: unknown,
): Record<string, unknown> {
  return {
    [category]: boundUntrustedData(data),
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
