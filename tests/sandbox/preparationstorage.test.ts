import { expect, it } from "vitest";
import * as storage from "../../src/sandbox/preparationstorage.js";

const observation = {
  engineId: "engine-fixture",
  dataRoot: "/dedicated/docker",
  boundary: "/dedicated",
  mechanism: "dedicated-block-device" as const,
  device: "/dev/loop7",
  deviceBytes: 16 * 1024 ** 3,
  filesystemBytes: 15 * 1024 ** 3,
  availableBytes: 10 * 1024 ** 3,
  mountId: "47",
  dedicated: true as const,
  imageStorage: "classic-overlay2" as const,
  builder: "legacy-local" as const,
};

it("does not admit a replacement engine while an earlier reservation remains unsettled", async () => {
  let current = observation;
  const reader = new storage.PreparationStorage(() => Promise.resolve(current));
  const first = await reader.admit("first", 1024);
  current = { ...observation, engineId: "replacement-engine" };
  await expect(reader.admit("second", 1024)).rejects.toThrow("Preparation storage changed");
  first.settle("CONFIRMED");
  const next = await reader.admit("second", 1024);
  next.settle("CONFIRMED");
});

it("admits an enforced dedicated whole-builder boundary and retains an uncertain reservation", async () => {
  const reader = new storage.PreparationStorage(() => Promise.resolve(observation));
  const lease = await reader.admit("workspace", 4 * 1024 ** 3);
  lease.account("download", 1024);
  await expect(reader.admit("workspace", 1024)).rejects.toThrow("Preparation already active");
  lease.settle("UNCERTAIN");
  await expect(reader.admit("workspace", 1024)).rejects.toThrow("Preparation already active");
  lease.settle("CONFIRMED");
  const next = await reader.admit("workspace", 1024);
  next.settle("CONFIRMED");
});

it("revalidates shared commitments after external storage consumption", async () => {
  let current = { ...observation, availableBytes: 5 * 1024 ** 3 };
  const reader = new storage.PreparationStorage(() => Promise.resolve(current));
  const first = await reader.admit("first", 2 * 1024 ** 3);
  const second = await reader.admit("second", 2 * 1024 ** 3);
  // Charges are planned bounds, not proof that the observed filesystem has consumed them.
  first.account("staging", 512 * 1024 ** 2);
  second.account("transfer", 512 * 1024 ** 2);
  current = { ...current, availableBytes: 3 * 1024 ** 3 };
  await expect(first.revalidate()).rejects.toThrow("Preparation storage exhausted");
  first.settle("CONFIRMED");
  second.settle("CONFIRMED");
});

it("rejects an image store outside the admitted whole-builder mechanism", async () => {
  const reader = new storage.PreparationStorage(() =>
    Promise.resolve({
      ...observation,
      imageStorage: "external-containerd",
    }),
  );
  await expect(reader.admit("workspace", 1024)).rejects.toThrow("Whole-builder quota unavailable");
});

it("blocks changed engine/storage identity and exhausted capacity before new effects", async () => {
  let current = observation;
  const reader = new storage.PreparationStorage(() => Promise.resolve(current));
  const lease = await reader.admit("workspace", 1024);
  current = { ...observation, engineId: "replacement-engine" };
  await expect(lease.revalidate()).rejects.toThrow("Preparation storage changed");
  lease.settle("CONFIRMED");
  current = { ...observation, availableBytes: 0 };
  await expect(reader.admit("workspace", 1024)).rejects.toThrow("Preparation storage exhausted");
});

it("does not accept a declared number or container-only limit as whole-builder evidence", async () => {
  const reader = new storage.PreparationStorage(() =>
    Promise.resolve({
      ...observation,
      mechanism: "overlay2.size",
    }),
  );
  await expect(reader.admit("workspace", 1024)).rejects.toThrow("Whole-builder quota unavailable");
});

it("does not release accounting when trusted settlement ownership cannot be confirmed", async () => {
  const reader = new storage.PreparationStorage(() => Promise.resolve(observation));
  const lease = await reader.admit("workspace", 1024, () => {
    throw new Error("Ownership changed");
  });
  expect(() => lease.settle("CONFIRMED")).toThrow("Ownership changed");
  await expect(reader.admit("workspace", 1024)).rejects.toThrow("Preparation already active");
});
