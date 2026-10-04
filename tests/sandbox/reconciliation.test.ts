import { describe, expect, it } from "vitest";

import { createVerificationLabels, reconcileOwnedContainers } from "../../src/sandbox/cleanup.js";

describe("owned container reconciliation", () => {
  it("reconciles only positively owned verification containers", async () => {
    const removed: string[] = [];
    const result = await reconcileOwnedContainers(
      [
        { id: "owned", labels: createVerificationLabels("task-1", "owned") },
        { id: "other", labels: { "com.example.owner": "other" } },
        { id: "unlabeled", labels: {} },
      ],
      {
        stop: (id) => {
          removed.push(`stop:${id}`);
          return Promise.resolve();
        },
        remove: (id) => {
          removed.push(`remove:${id}`);
          return Promise.resolve();
        },
        inspect: () => Promise.resolve(false),
      },
    );

    expect(result).toEqual([{ id: "owned", status: "CONFIRMED", attempts: 1 }]);
    expect(removed).toEqual(["stop:owned", "remove:owned"]);
  });

  it("does not expose a global prune operation", () => {
    expect("prune" in reconcileOwnedContainers).toBe(false);
  });
});
