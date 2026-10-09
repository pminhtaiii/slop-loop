import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface NativeWorkspaceBackend {
  readonly abi: number;
  readonly platform: string;
  readonly arch: string;
  readonly capability: string;
  openRoot(root: string): number;
  openRelative(rootFd: number, relativePath: string, directory: boolean): number;
  openChild(rootFd: number, parentFd: number, name: string, directory: boolean): number;
  probeWalk(rootFd: number): void;
  closeDescriptor(fd: number): void;
  targetPath(fd: number): string;
  targetIdentity(fd: number): {
    device: string;
    inode: string;
    links: number;
    directory: boolean;
    size: number;
    mode: number;
  };
  readTarget(fd: number, capacity: number): Buffer;
  listDirectory(fd: number, limit: number): string[];
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
    backend.abi !== 2 ||
    backend.capability !== "identity-v3" ||
    backend.platform !== process.platform ||
    backend.arch !== process.arch ||
    typeof backend.openRoot !== "function" ||
    typeof backend.openRelative !== "function" ||
    typeof backend.openChild !== "function" ||
    typeof backend.probeWalk !== "function" ||
    typeof backend.closeDescriptor !== "function" ||
    typeof backend.targetPath !== "function" ||
    typeof backend.targetIdentity !== "function" ||
    typeof backend.readTarget !== "function" ||
    typeof backend.listDirectory !== "function" ||
    (process.platform !== "win32" && process.platform !== "linux")
  ) {
    return { kind: "UNAVAILABLE", reason: "UNSUPPORTED_BACKEND" };
  }
  return { kind: "READY", backend: Object.freeze({ ...backend }) as NativeWorkspaceBackend };
}

function requiredBackend(): NativeWorkspaceBackend {
  const loaded = loadNativeWorkspaceBackend();
  if (loaded.kind !== "READY") throw new Error("Native workspace boundary unavailable");
  return loaded.backend;
}

/** The native runtime owns this descriptor; node:fs descriptors are not interchangeable on Windows. */
export function openNativeRoot(root: string): number {
  return requiredBackend().openRoot(root);
}

export function openNativeTarget(
  rootFd: number,
  relativePath: string,
  kind: "file" | "directory",
): number {
  return requiredBackend().openRelative(rootFd, relativePath, kind === "directory");
}

export function openNativeChild(
  rootFd: number,
  parentFd: number,
  name: string,
  kind: "file" | "directory",
): number {
  return requiredBackend().openChild(rootFd, parentFd, name, kind === "directory");
}

/** Confirms that the native backend can walk an existing child of the held root. */
export function probeNativeWalk(rootFd: number): void {
  requiredBackend().probeWalk(rootFd);
}

export function closeNativeDescriptor(fd: number): void {
  requiredBackend().closeDescriptor(fd);
}

export function nativeTargetPath(fd: number): string {
  return requiredBackend().targetPath(fd);
}

export function nativeTargetIdentity(fd: number): {
  device: string;
  inode: string;
  links: number;
  directory: boolean;
  size: number;
  mode: number;
} {
  return requiredBackend().targetIdentity(fd);
}

export function readNativeTarget(fd: number, capacity: number): Buffer {
  return requiredBackend().readTarget(fd, capacity);
}

export function listNativeDirectory(fd: number, limit: number): readonly string[] {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1024)
    throw new Error("Invalid native directory limit");
  return requiredBackend().listDirectory(fd, limit);
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
