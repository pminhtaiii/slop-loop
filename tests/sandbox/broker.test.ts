import { describe, expect, it } from "vitest";

import { ApprovedFetchBroker, isPublicAddress } from "../../src/sandbox/broker.js";

describe("approved preparation broker", () => {
  it.each(["127.0.0.1", "::1", "10.0.0.1", "192.168.1.10", "169.254.1.1"])(
    "rejects private or local address %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(false);
    },
  );

  it("allows only approved public registry destinations", async () => {
    const broker = new ApprovedFetchBroker({
      approvedHosts: ["registry.npmjs.org"],
      resolve: () => Promise.resolve(["203.0.113.10"]),
      request: () =>
        Promise.resolve({
          statusCode: 200,
          headers: {},
          body: Buffer.from("artifact"),
        }),
    });

    await expect(
      broker.fetch(new URL("https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz")),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(broker.fetch(new URL("https://evil.example/pkg.tgz"))).rejects.toThrow();
  });

  it("re-resolves and rejects a private address immediately before connection", async () => {
    const broker = new ApprovedFetchBroker({
      approvedHosts: ["registry.npmjs.org"],
      resolve: () => Promise.resolve(["10.0.0.1"]),
      request: () => Promise.reject(new Error("direct request must not run")),
    });

    await expect(
      broker.fetch(new URL("https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz")),
    ).rejects.toThrow(/private address/i);
  });

  it("rejects when any resolved address is private (DNS rebinding defense)", async () => {
    const broker = new ApprovedFetchBroker({
      approvedHosts: ["registry.npmjs.org"],
      resolve: () => Promise.resolve(["203.0.113.10", "127.0.0.1"]),
      request: () =>
        Promise.resolve({
          statusCode: 200,
          headers: {},
          body: Buffer.from("artifact"),
        }),
    });

    await expect(
      broker.fetch(new URL("https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz")),
    ).rejects.toThrow("Broker destination resolves to a private address");
  });

  it("rejects non-standard ports", async () => {
    const broker = new ApprovedFetchBroker({
      approvedHosts: ["registry.npmjs.org"],
      resolve: () => Promise.resolve(["203.0.113.10"]),
      request: () =>
        Promise.resolve({
          statusCode: 200,
          headers: {},
          body: Buffer.from("artifact"),
        }),
    });

    await expect(
      broker.fetch(new URL("https://registry.npmjs.org:8443/pkg/-/pkg-1.0.0.tgz")),
    ).rejects.toThrow("Broker destination port is not approved");

    // Standard port 443 and default empty port should succeed
    await expect(
      broker.fetch(new URL("https://registry.npmjs.org:443/pkg/-/pkg-1.0.0.tgz")),
    ).resolves.toMatchObject({ statusCode: 200 });
  });

  it.each([301, 302, 307, 308])("rejects HTTP redirect status code %i", async (status) => {
    const broker = new ApprovedFetchBroker({
      approvedHosts: ["registry.npmjs.org"],
      resolve: () => Promise.resolve(["203.0.113.10"]),
      request: () =>
        Promise.resolve({
          statusCode: status,
          headers: { location: "https://evil.example" },
          body: Buffer.from(""),
        }),
    });

    await expect(
      broker.fetch(new URL("https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz")),
    ).rejects.toThrow("Broker redirects are not allowed");
  });

  it("rejects response body exceeding maxBytes", async () => {
    const broker = new ApprovedFetchBroker({
      approvedHosts: ["registry.npmjs.org"],
      maxBytes: 10,
      resolve: () => Promise.resolve(["203.0.113.10"]),
      request: () =>
        Promise.resolve({
          statusCode: 200,
          headers: {},
          body: Buffer.from("1234567890extra"),
        }),
    });

    await expect(
      broker.fetch(new URL("https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz")),
    ).rejects.toThrow("Broker response exceeds byte limit");
  });

  it("rejects streamed response body exceeding maxBytes", async () => {
    async function* makeStream() {
      await Promise.resolve();
      yield Buffer.from("12345");
      yield Buffer.from("67890extra");
    }
    const broker = new ApprovedFetchBroker({
      approvedHosts: ["registry.npmjs.org"],
      maxBytes: 10,
      resolve: () => Promise.resolve(["203.0.113.10"]),
      request: () =>
        Promise.resolve({
          statusCode: 200,
          headers: {},
          body: makeStream(),
        }),
    });

    await expect(
      broker.fetch(new URL("https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz")),
    ).rejects.toThrow("Broker response exceeds byte limit");
  });
});
