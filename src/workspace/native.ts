import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface NativeWorkspaceBackend {
  readonly abi: number;
  readonly platform: string;
  readonly arch: string;
  readonly capability: string;
}

export type NativeLoadResult =
  | { readonly kind: "READY"; readonly backend: NativeWorkspaceBackend }
  | { readonly kind: "UNAVAILABLE"; readonly reason: "NATIVE_UNAVAILABLE" | "UNSUPPORTED_BACKEND" };

export function validateNativeBackend(candidate: unknown): NativeLoadResult {
  if (candidate === null || typeof candidate !== "object") {
    return { kind: "UNAVAILABLE", reason: "NATIVE_UNAVAILABLE" };
  }
  const backend = candidate as Partial<NativeWorkspaceBackend>;
  if (
    backend.abi !== 1 ||
    backend.capability !== "identity-v1" ||
    backend.platform !== process.platform ||
    backend.arch !== process.arch ||
    (process.platform !== "win32" && process.platform !== "linux")
  ) {
    return { kind: "UNAVAILABLE", reason: "UNSUPPORTED_BACKEND" };
  }
  return { kind: "READY", backend: Object.freeze({ ...backend }) as NativeWorkspaceBackend };
}

export function loadNativeWorkspaceBackend(): NativeLoadResult {
  if (process.platform !== "win32" && process.platform !== "linux") {
    return { kind: "UNAVAILABLE", reason: "UNSUPPORTED_BACKEND" };
  }
  try {
    const candidate: unknown = require("../../native/workspace/build/Release/workspace_boundary.node");
    return validateNativeBackend(candidate);
  } catch {
    return { kind: "UNAVAILABLE", reason: "NATIVE_UNAVAILABLE" };
  }
}
