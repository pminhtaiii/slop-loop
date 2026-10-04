export type CleanupStatus = "CONFIRMED" | "UNCERTAIN";

export interface VerificationContainer {
  readonly id: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface CleanupPort {
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  inspect(id: string): Promise<boolean>;
}

export interface CleanupResult {
  readonly status: CleanupStatus;
  readonly attempts: number;
}

export class CleanupExecutionGate {
  private held = false;

  canStart(): boolean {
    return !this.held;
  }

  hold(): void {
    this.held = true;
  }

  settle(result: CleanupResult): void {
    if (result.status === "CONFIRMED") this.held = false;
    else this.held = true;
  }
}

export const VERIFICATION_OWNER_LABEL = "verification";

export function createVerificationLabels(
  taskId: string,
  containerId: string,
): Readonly<Record<string, string>> {
  if (taskId.trim().length === 0 || containerId.trim().length === 0) {
    throw new TypeError("Verification ownership identity is required");
  }
  return Object.freeze({
    "slop-loop.owner": VERIFICATION_OWNER_LABEL,
    "slop-loop.taskId": taskId,
    "slop-loop.containerId": containerId,
  });
}

function isOwned(container: VerificationContainer): boolean {
  return (
    container.labels["slop-loop.owner"] === VERIFICATION_OWNER_LABEL &&
    container.labels["slop-loop.taskId"] !== undefined &&
    container.labels["slop-loop.containerId"] === container.id
  );
}

export async function stopAndRemoveOwnedContainer(
  container: VerificationContainer,
  port: CleanupPort,
  options: { readonly maxAttempts?: number } = {},
): Promise<CleanupResult> {
  if (!isOwned(container)) throw new Error("Container is not positively owned");
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new RangeError("Cleanup attempt bound is invalid");
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await port.stop(container.id);
    } catch {
      // Reconciliation remains bounded and reports uncertainty below.
    }
    try {
      await port.remove(container.id);
    } catch {
      // A daemon failure must not be treated as confirmed cleanup.
    }
    try {
      if (!(await port.inspect(container.id))) {
        return Object.freeze({ status: "CONFIRMED", attempts: attempt });
      }
    } catch {
      // An inspection failure cannot establish absence.
    }
  }
  return Object.freeze({ status: "UNCERTAIN", attempts: maxAttempts });
}

export async function reconcileOwnedContainers(
  containers: readonly VerificationContainer[],
  port: CleanupPort,
  options: { readonly maxAttempts?: number } = {},
): Promise<readonly (CleanupResult & { readonly id: string })[]> {
  const results: Array<CleanupResult & { readonly id: string }> = [];
  for (const container of containers) {
    if (!isOwned(container)) continue;
    const result = await stopAndRemoveOwnedContainer(container, port, options);
    results.push(Object.freeze({ id: container.id, ...result }));
  }
  return Object.freeze(results);
}
