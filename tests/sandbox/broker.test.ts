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
    ).rejects.toThrow();
  });
});
