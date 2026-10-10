import { expect, it } from "vitest";
import { connect } from "node:net";
import { Duplex } from "node:stream";
import { ConnectBroker } from "../../src/sandbox/connectbroker.js";

it("pins the actual upstream connection to the freshly validated public address", async () => {
  const connected: string[] = [];
  const broker = new ConnectBroker({
    listenHost: "127.0.0.1",
    port: 0,
    resolve: () => Promise.resolve(["1.1.1.1"]),
    connect: (address) => {
      connected.push(address);
      const upstream = new Duplex({
        read() {},
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      queueMicrotask(() => upstream.emit("connect"));
      return upstream;
    },
  });
  const port = await broker.start();
  const client = connect({ host: "127.0.0.1", port });
  try {
    const response = new Promise<string>((resolve, reject) => {
      client.once("data", (bytes: Buffer) => resolve(bytes.toString("ascii")));
      client.once("error", reject);
    });
    client.write("CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n");
    expect(await response).toContain("200 Connection Established");
    expect(connected).toEqual(["1.1.1.1"]);
  } finally {
    client.destroy();
    await broker.close();
  }
});

it.each([
  "evil.example:443",
  "registry.npmjs.org:444",
  "127.0.0.1:443",
  "user@registry.npmjs.org:443",
])("rejects unapproved CONNECT authority %s before resolution", async (authority) => {
  let resolutions = 0;
  const broker = new ConnectBroker({
    listenHost: "127.0.0.1",
    port: 0,
    resolve: () => {
      resolutions++;
      return Promise.resolve(["1.1.1.1"]);
    },
  });
  const client = connect({ host: "127.0.0.1", port: await broker.start() });
  try {
    const response = new Promise<string>((resolve, reject) => {
      client.once("data", (bytes: Buffer) => resolve(bytes.toString("ascii")));
      client.once("error", reject);
    });
    client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    expect(await response).toContain("403 Forbidden");
    expect(resolutions).toBe(0);
  } finally {
    client.destroy();
    await broker.close();
  }
});

it("rejects a mixed public/private DNS answer without opening any upstream socket", async () => {
  let connections = 0;
  const broker = new ConnectBroker({
    listenHost: "127.0.0.1",
    port: 0,
    resolve: () => Promise.resolve(["1.1.1.1", "127.0.0.1"]),
    connect: () => {
      connections++;
      throw new Error("Forbidden upstream effect");
    },
  });
  const client = connect({ host: "127.0.0.1", port: await broker.start() });
  try {
    const response = new Promise<string>((resolve, reject) => {
      client.once("data", (bytes: Buffer) => resolve(bytes.toString("ascii")));
      client.once("error", reject);
    });
    client.write("CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n");
    expect(await response).toContain("403 Forbidden");
    expect(connections).toBe(0);
  } finally {
    client.destroy();
    await broker.close();
  }
});

it("closes an owned client that has not sent any HTTP headers without waiting for the header timeout", async () => {
  const broker = new ConnectBroker({ listenHost: "127.0.0.1", port: 0 });
  const client = connect({ host: "127.0.0.1", port: await broker.start() });
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closing = broker.close();
  try {
    await expect(
      Promise.race([
        closing,
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Cleanup deadline exceeded")), 100);
        }),
      ]),
    ).resolves.toBeUndefined();
  } finally {
    if (timer) clearTimeout(timer);
    client.destroy();
    await closing;
  }
});

it("settles startup when close races the listen acknowledgement", async () => {
  const broker = new ConnectBroker({ listenHost: "127.0.0.1", port: 0 });
  const starting = broker.start();
  const closing = broker.close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(
      Promise.race([
        Promise.allSettled([starting, closing]),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Unsettled broker startup")), 100);
        }),
      ]),
    ).resolves.toBeDefined();
  } finally {
    if (timer) clearTimeout(timer);
    await broker.close();
  }
});

it("keeps the owned socket bound when concurrent DNS resolutions settle together", async () => {
  const pending: Array<(addresses: readonly string[]) => void> = [];
  let ready: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let upstreams = 0;
  const broker = new ConnectBroker({
    listenHost: "127.0.0.1",
    port: 0,
    resolve: () =>
      new Promise((resolve) => {
        pending.push(resolve);
        if (pending.length === 31) ready?.();
      }),
    connect: () => {
      upstreams++;
      const upstream = new Duplex({
        read() {},
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      queueMicrotask(() => upstream.emit("connect"));
      return upstream;
    },
  });
  const port = await broker.start();
  const clients = Array.from({ length: 31 }, () => {
    const client = connect({ host: "127.0.0.1", port });
    client.on("error", () => client.destroy());
    client.write("CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n");
    return client;
  });
  try {
    await waiting;
    for (const resolve of pending) resolve(["1.1.1.1"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(upstreams).toBeLessThanOrEqual(16);
  } finally {
    for (const client of clients) client.destroy();
    await broker.close();
  }
});
