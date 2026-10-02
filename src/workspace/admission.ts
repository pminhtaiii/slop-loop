import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  closeNativeDescriptor,
  loadNativeWorkspaceBackend,
  nativeTargetIdentity,
  openNativeRoot,
  probeNativeWalk,
} from "./native.js";
import { runTrustedGit } from "./git.js";
import type {
  SelectedWorkspace,
  WorkspaceFailureReason,
  WorkspaceSelectionResult,
} from "./types.js";

interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface HeldCheckout {
  readonly root: string;
  readonly gitdir: string;
  readonly rootFd: number;
  readonly gitdirFd: number;
  readonly nativeRootFd: number;
  readonly rootIdentity: Identity;
  readonly gitdirIdentity: Identity;
}

const held = new WeakMap<SelectedWorkspace, HeldCheckout>();
const selectedById = new Map<string, SelectedWorkspace>();

function identityFor(fd: number): Identity {
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Not a directory");
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(first: Identity, second: Identity): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function containsPhysicalDirectory(root: string, launch: string): boolean {
  const rootIdentity = fs.statSync(root, { bigint: true });
  if (!rootIdentity.isDirectory()) return false;
  let current = launch;
  while (true) {
    if (sameIdentity(rootIdentity, fs.statSync(current, { bigint: true }))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function gitValue(cwd: string, option: string): string {
  const result = runTrustedGit(cwd, ["rev-parse", option]).toString("utf8");
  return result.replace(/\r?\n$/, "");
}

function discoverCheckout(launchDirectory: string): { root: string; gitdir: string } {
  const launch = fs.realpathSync(launchDirectory);
  if (!fs.statSync(launch).isDirectory()) throw new Error("Launch path is not a directory");
  if (gitValue(launch, "--is-inside-work-tree") !== "true") throw new Error("Not a worktree");
  if (gitValue(launch, "--is-bare-repository") !== "false") throw new Error("Bare repository");
  const root = fs.realpathSync(gitValue(launch, "--show-toplevel"));
  if (!containsPhysicalDirectory(root, launch)) {
    throw new Error("Launch path escapes checkout");
  }
  return { root, gitdir: fs.realpathSync(gitValue(launch, "--absolute-git-dir")) };
}

function failure(reason: WorkspaceFailureReason): WorkspaceSelectionResult {
  return Object.freeze({ kind: "REJECTED", reason });
}

export function selectWorkspace(launchDirectory: string): WorkspaceSelectionResult {
  const native = loadNativeWorkspaceBackend();
  if (native.kind !== "READY") return failure(native.reason);
  let launchFd: number | undefined;
  let rootFd: number | undefined;
  let gitdirFd: number | undefined;
  let nativeRootFd: number | undefined;
  let discoveryComplete = false;
  try {
    const launch = fs.realpathSync(launchDirectory);
    launchFd = fs.openSync(launch, "r");
    const launchIdentity = identityFor(launchFd);
    const checkout = discoverCheckout(launch);
    discoveryComplete = true;
    rootFd = fs.openSync(checkout.root, "r");
    gitdirFd = fs.openSync(checkout.gitdir, "r");
    const rootIdentity = identityFor(rootFd);
    const gitdirIdentity = identityFor(gitdirFd);
    nativeRootFd = openNativeRoot(checkout.root);
    probeNativeWalk(nativeRootFd);
    const nativeIdentity = nativeTargetIdentity(nativeRootFd);
    if (
      !nativeIdentity.directory ||
      nativeIdentity.device !== rootIdentity.dev.toString() ||
      nativeIdentity.inode !== rootIdentity.ino.toString()
    )
      return failure("INVALID_IDENTITY");
    const currentRoot = fs.statSync(checkout.root, { bigint: true });
    const currentGitdir = fs.statSync(checkout.gitdir, { bigint: true });
    if (!sameIdentity(rootIdentity, currentRoot) || !sameIdentity(gitdirIdentity, currentGitdir)) {
      return failure("INVALID_IDENTITY");
    }
    const rediscovered = discoverCheckout(launch);
    if (
      rediscovered.root !== checkout.root ||
      rediscovered.gitdir !== checkout.gitdir ||
      !sameIdentity(launchIdentity, fs.statSync(launch, { bigint: true })) ||
      !sameIdentity(rootIdentity, fs.statSync(checkout.root, { bigint: true })) ||
      !sameIdentity(gitdirIdentity, fs.statSync(checkout.gitdir, { bigint: true }))
    ) {
      return failure("INVALID_IDENTITY");
    }
    const workspace: SelectedWorkspace = Object.freeze({
      workspaceId: randomUUID(),
      root: checkout.root,
    });
    held.set(workspace, {
      ...checkout,
      rootFd,
      gitdirFd,
      nativeRootFd,
      rootIdentity,
      gitdirIdentity,
    });
    selectedById.set(workspace.workspaceId, workspace);
    rootFd = undefined;
    gitdirFd = undefined;
    nativeRootFd = undefined;
    return Object.freeze({ kind: "SELECTED", workspace });
  } catch {
    return failure(discoveryComplete ? "INVALID_IDENTITY" : "NOT_A_CHECKOUT");
  } finally {
    try {
      if (launchFd !== undefined) fs.closeSync(launchFd);
    } finally {
      try {
        if (rootFd !== undefined) fs.closeSync(rootFd);
      } finally {
        try {
          if (gitdirFd !== undefined) fs.closeSync(gitdirFd);
        } finally {
          if (nativeRootFd !== undefined) closeNativeDescriptor(nativeRootFd);
        }
      }
    }
  }
}

export function verifyWorkspace(workspace: SelectedWorkspace): boolean {
  const record = held.get(workspace);
  if (record === undefined) return false;
  try {
    const current = discoverCheckout(record.root);
    if (current.root !== record.root || current.gitdir !== record.gitdir) return false;
    const rootAtPath = fs.statSync(record.root, { bigint: true });
    const gitdirAtPath = fs.statSync(record.gitdir, { bigint: true });
    return (
      nativeTargetIdentity(record.nativeRootFd).device === record.rootIdentity.dev.toString() &&
      nativeTargetIdentity(record.nativeRootFd).inode === record.rootIdentity.ino.toString() &&
      sameIdentity(record.rootIdentity, identityFor(record.rootFd)) &&
      sameIdentity(record.gitdirIdentity, identityFor(record.gitdirFd)) &&
      sameIdentity(record.rootIdentity, rootAtPath) &&
      sameIdentity(record.gitdirIdentity, gitdirAtPath)
    );
  } catch {
    return false;
  }
}

/** Internal native root authority, never passed to model-visible tools. */
export function nativeRootForWorkspace(workspace: SelectedWorkspace): number | null {
  const record = held.get(workspace);
  return record !== undefined && verifyWorkspace(workspace) ? record.nativeRootFd : null;
}

export function trustedWorkspaceId(workspace: unknown): string | null {
  if (workspace === null || typeof workspace !== "object") return null;
  const selected = workspace as SelectedWorkspace;
  return verifyWorkspace(selected) ? selected.workspaceId : null;
}

/** Resolves an opaque task ID only while its original checkout remains valid. */
export function workspaceForId(workspaceId: string): SelectedWorkspace | null {
  const workspace = selectedById.get(workspaceId);
  if (workspace === undefined) return null;
  if (verifyWorkspace(workspace)) return workspace;
  closeWorkspace(workspace);
  return null;
}

export function closeWorkspace(workspace: SelectedWorkspace): void {
  const record = held.get(workspace);
  if (record === undefined) return;
  held.delete(workspace);
  selectedById.delete(workspace.workspaceId);
  try {
    fs.closeSync(record.rootFd);
  } finally {
    try {
      fs.closeSync(record.gitdirFd);
    } finally {
      closeNativeDescriptor(record.nativeRootFd);
    }
  }
}
