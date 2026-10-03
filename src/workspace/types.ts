import type { ToolName } from "../tools/registry.js";

export type WorkspaceFailureReason =
  | "NATIVE_UNAVAILABLE"
  | "UNSUPPORTED_BACKEND"
  | "NOT_A_CHECKOUT"
  | "INVALID_IDENTITY"
  | "GIT_UNAVAILABLE";

export interface SelectedWorkspace {
  readonly workspaceId: string;
  /** Private trusted root; never passed to a model-visible result. */
  readonly root: string;
}

export type WorkspaceSelectionResult =
  | { readonly kind: "SELECTED"; readonly workspace: SelectedWorkspace }
  | { readonly kind: "REJECTED"; readonly reason: WorkspaceFailureReason };

export interface RepositoryPathRequest {
  readonly workspaceId: string;
  readonly requestedPath: string;
  readonly operation: "read" | "update" | "create";
  readonly tool: ToolName;
}

interface OpenedTargetBase {
  readonly workspaceId: string;
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly identity: string;
  close(): void;
}
export interface OpenedRegularTarget extends OpenedTargetBase {
  readonly kind: "regular";
  /** Reads from the validated held handle, never from a path string. */
  read(maxBytes: number): Buffer;
}

export interface OpenedDirectoryTarget extends OpenedTargetBase {
  readonly kind: "directory";
  /** Returns one validated snapshot; each call revalidates the whole directory operation. */
  entries(): readonly { readonly name: string; readonly canonicalPath: string }[];
}

export type OpenedWorkspaceTarget = OpenedRegularTarget | OpenedDirectoryTarget;

export type WorkspaceAccessResult<T extends OpenedWorkspaceTarget> =
  | { readonly kind: "OPENED"; readonly target: T }
  | { readonly kind: "FORBIDDEN"; readonly reason: "PATH_DENIED" | "TARGET_DENIED" }
  | {
      readonly kind: "UNAVAILABLE";
      readonly reason: "IDENTITY_CHANGED" | "NATIVE_UNAVAILABLE" | "INSPECTION_FAILED";
    };

/** A snapshot for permission planning; it never authorizes a later write. */
export type MutationPathInspection =
  | {
      readonly kind: "INSPECTED";
      readonly canonicalPath: string;
      readonly operation: "update" | "create";
      readonly parentIdentity: string;
      readonly targetIdentity: string | null;
    }
  | { readonly kind: "FORBIDDEN"; readonly reason: "PATH_DENIED" | "TARGET_DENIED" }
  | { readonly kind: "UNAVAILABLE"; readonly reason: "IDENTITY_CHANGED" | "INSPECTION_FAILED" };
