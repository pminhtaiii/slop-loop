import { expect, it } from "vitest";
import * as network from "../../src/sandbox/preparationnetwork.js";
import { TRUSTED_BROKER_BIND_ADDRESS } from "../../src/sandbox/connectbrokerentry.js";

it("binds the production broker only to its private preparation-network address", () => {
  expect(TRUSTED_BROKER_BIND_ADDRESS).toBe("172.31.253.2");
});

it("allows a bounded image build without extending control-operation deadlines", () => {
  expect(network.preparationCommandTimeout(["build"])).toBe(15 * 60_000);
  expect(network.preparationCommandTimeout(["info"])).toBe(30_000);
});

it("creates an internal fetch namespace with unprivileged fetch and trusted setup only", async () => {
  const observed: string[][] = [];
  const port = new network.DockerPreparationNetwork("sha256:" + "a".repeat(64), (argv) => {
    observed.push([...argv]);
    if (argv[0] === "info") return Promise.resolve('{"ID":"engine"}');
    if (argv[0] === "inspect")
      return Promise.resolve(
        JSON.stringify([
          {
            Id: "fetch-id",
            State: { Running: true },
            Config: { Labels: { "slop-loop.actionId": "action", "slop-loop.generation": "1" } },
            NetworkSettings: { SandboxKey: "/var/run/docker/netns/fixture" },
          },
        ]),
      );
    if (argv[0] === "network" && argv[1] === "inspect")
      return Promise.resolve(JSON.stringify([{ Internal: true }]));
    return Promise.resolve(
      argv[0] === "run" ? "egress-policy-installed" : argv[0] === "exec" ? "broker:READY" : "",
    );
  });
  const admission = await port.open("action", "engine", new AbortController().signal);
  expect(network.isFetchAdmission(admission)).toBe(true);
  expect(network.isFetchAdmission({ ...admission })).toBe(false);
  expect(observed.find((argv) => argv.includes("--internal"))).toBeDefined();
  const fetch = observed.find((argv) => argv.includes("slop-loop.role=fetch"))!;
  expect(fetch).toContain("--cap-drop=ALL");
  expect(fetch).toContain("--user=10001:10001");
  expect(fetch.some((part) => part.includes("NET_ADMIN"))).toBe(false);
  expect(observed.filter((argv) => argv.includes("--cap-add=NET_ADMIN"))).toHaveLength(1);
  expect(observed.find((argv) => argv.includes("slop-loop.role=broker"))).toContain(
    "/opt/slop-loop-preparation/connectbrokerentry.js",
  );
});

it("requires actual setup command acknowledgement before minting fetch authority", async () => {
  const port = new network.DockerPreparationNetwork("sha256:" + "a".repeat(64), (argv) => {
    if (argv[0] === "info") return Promise.resolve('{"ID":"engine"}');
    if (argv[0] === "inspect")
      return Promise.resolve(
        JSON.stringify([
          {
            Id: "fetch-id",
            State: { Running: true },
            Config: { Labels: { "slop-loop.actionId": "action", "slop-loop.generation": "1" } },
            NetworkSettings: { SandboxKey: "namespace" },
          },
        ]),
      );
    if (argv[0] === "network" && argv[1] === "inspect")
      return Promise.resolve('[{"Internal":true}]');
    return Promise.resolve("");
  });
  await expect(port.open("action", "engine", new AbortController().signal)).rejects.toThrow(
    "Egress enforcement acknowledgement unavailable",
  );
});

it("creates a fresh CAS-free recipient with no network and a new generation", async () => {
  const commands: readonly string[][] = [];
  const captured: string[][] = [...commands];
  const port = new network.DockerPreparationNetwork("sha256:" + "a".repeat(64), (argv) => {
    captured.push([...argv]);
    if (argv[0] === "info") return Promise.resolve('{"ID":"engine"}');
    if (argv[0] === "create") return Promise.resolve("f".repeat(64));
    if (argv[0] === "inspect")
      return Promise.resolve(
        JSON.stringify([
          {
            Id: "f".repeat(64),
            State: { Running: true },
            Config: { Labels: { "slop-loop.actionId": "action", "slop-loop.generation": "2" } },
            NetworkSettings: { SandboxKey: "none-private", Networks: {} },
            HostConfig: { NetworkMode: "none" },
          },
        ]),
      );
    return Promise.resolve("");
  });
  const recipient = await port.createOffline("action", "engine", new AbortController().signal);
  expect(network.isFetchAdmission(recipient)).toBe(true);
  expect(recipient.generation).toBe(2);
  const create = captured.find((argv) => argv[0] === "create")!;
  expect(create[create.indexOf("--network") + 1]).toBe("none");
  expect(create.some((flag) => flag.startsWith("--mount"))).toBe(false);
});

it("rejects a different local engine before creating network or container resources", async () => {
  let effects = 0;
  const port = new network.DockerPreparationNetwork("sha256:" + "a".repeat(64), (argv) => {
    if (argv[0] === "info") return Promise.resolve('{"ID":"replacement"}');
    effects++;
    return Promise.reject(new Error("Unapproved resource creation"));
  });
  await expect(port.open("action", "engine", new AbortController().signal)).rejects.toThrow(
    "Preparation engine changed",
  );
  expect(effects).toBe(0);
});

it("does not disconnect or remove a forged producer admission", async () => {
  let calls = 0;
  const port = new network.DockerPreparationNetwork("sha256:" + "a".repeat(64), () => {
    calls++;
    return Promise.resolve("");
  });
  const forged = {
    actionId: "action",
    engineId: "engine",
    containerId: "f".repeat(64),
    generation: 1,
    namespaceId: "namespace",
    brokerAddress: "172.31.253.2:3128" as const,
  };
  await expect(port.disconnect(forged, new AbortController().signal)).rejects.toThrow(
    "Unowned fetch admission",
  );
  await expect(port.removeProducer(forged, new AbortController().signal)).rejects.toThrow(
    "Unowned fetch admission",
  );
  expect(calls).toBe(0);
});

it("never removes an unowned resource while settling a failed preparation", async () => {
  const mutations: string[][] = [];
  const port = new network.DockerPreparationNetwork("sha256:" + "a".repeat(64), (argv) => {
    if (argv[0] === "info") return Promise.resolve('{"ID":"engine"}');
    if (argv[0] === "network" && argv[1] === "create") return Promise.resolve("");
    if (argv[0] === "create") return Promise.reject(new Error("Creation uncertain"));
    if (argv[0] === "container") return Promise.resolve("foreign-container");
    if (argv[0] === "inspect")
      return Promise.resolve(
        JSON.stringify([
          {
            Id: "foreign-container",
            Config: {
              Labels: { "slop-loop.actionId": "different-action", "slop-loop.generation": "1" },
            },
          },
        ]),
      );
    if (argv.includes("rm")) mutations.push([...argv]);
    return Promise.resolve("");
  });
  await expect(port.open("action", "engine", new AbortController().signal)).rejects.toThrow(
    "Creation uncertain",
  );
  expect(await port.cleanup("action")).toBe("UNCERTAIN");
  expect(mutations).toEqual([]);
});
