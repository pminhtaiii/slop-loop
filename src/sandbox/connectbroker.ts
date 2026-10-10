import type { Duplex } from "node:stream";
import { createServer, type Server } from "node:http";
import { lookup } from "node:dns/promises";
import { connect, Socket } from "node:net";
import { isPublicAddress } from "./broker.js";

interface ConnectOptions {
  readonly listenHost?: "127.0.0.1" | "0.0.0.0" | "172.31.253.2";
  readonly port?: number;
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  readonly connect?: (address: string) => Duplex;
}

export class ConnectBroker {
  constructor(private readonly options: ConnectOptions = {}) {}
  private server?: Server;
  private readonly streams = new Set<Duplex>();
  private consumed = 0;
  private connections = 0;
  private stopped = false;
  private rejectStartup?: (error: Error) => void;
  private readonly deadline = Date.now() + 15 * 60_000;

  /** Runs only in application-owned broker infrastructure, never in the target process. */
  async start(): Promise<number> {
    if (this.server || this.stopped) throw new Error("Broker already started or closed");
    const port = this.options.port ?? 3128;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid broker port");
    const server = createServer({ maxHeaderSize: 4096 }, (_req, response) => {
      response.writeHead(403, { Connection: "close" });
      response.end();
    });
    this.server = server;
    server.maxHeadersCount = 16;
    server.headersTimeout = 5000;
    server.requestTimeout = 10_000;
    server.on("connection", (client) => {
      if (this.stopped || Date.now() >= this.deadline || this.streams.size >= 32) {
        client.destroy();
        return;
      }
      this.streams.add(client);
      client.once("close", () => this.streams.delete(client));
      client.setTimeout(5000, () => client.destroy());
    });
    server.on("connect", (request, client, head) => {
      void this.tunnel(request.url ?? "", client, head).catch(() => client.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      this.rejectStartup = reject;
      server.once("error", reject);
      server.listen(port, this.options.listenHost ?? "0.0.0.0", () => {
        this.rejectStartup = undefined;
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Broker listener unavailable");
    return address.port;
  }

  private async tunnel(authority: string, client: Duplex, head: Buffer): Promise<void> {
    if (
      this.stopped ||
      Date.now() >= this.deadline ||
      this.streams.size >= 32 ||
      ++this.connections > 10_000 ||
      authority !== "registry.npmjs.org:443" ||
      head.length > 4096
    ) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    this.streams.add(client);
    const state: { upstream?: Duplex } = {};
    const timer = setTimeout(
      () => {
        client.destroy();
        state.upstream?.destroy();
      },
      Math.min(60_000, this.deadline - Date.now()),
    );
    const dispose = () => {
      clearTimeout(timer);
      this.streams.delete(client);
      if (state.upstream) {
        this.streams.delete(state.upstream);
        state.upstream.destroy();
      }
    };
    client.once("close", dispose);
    if (client instanceof Socket) client.setTimeout(0);
    client.once("error", () => client.destroy());
    const resolve =
      this.options.resolve ??
      (async (host: string) =>
        (await lookup(host, { all: true, verbatim: true })).map((item) => item.address));
    const addresses = await resolve("registry.npmjs.org");
    if (client.destroyed || this.stopped) return;
    // Admission must be reassessed after DNS; concurrent resolvers share the same budget.
    if (this.streams.size >= 32) {
      client.destroy();
      return;
    }
    if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    // Only this literal validated address reaches the socket; there is no second DNS lookup.
    state.upstream = (
      this.options.connect ?? ((address: string) => connect({ host: address, port: 443 }))
    )(addresses[0]!);
    const remote = state.upstream;
    this.streams.add(remote);
    remote.once("error", () => {
      remote.destroy();
      client.destroy();
    });
    remote.once("close", () => client.destroy());
    let bytes = head.length;
    this.consumed += head.length;
    const account = (chunk: Buffer) => {
      bytes += chunk.length;
      this.consumed += chunk.length;
      if (bytes > 128 * 1024 ** 2 || this.consumed > 4 * 1024 ** 3) {
        client.destroy();
        remote.destroy();
        if (this.consumed > 4 * 1024 ** 3) void this.close();
      }
    };
    client.on("data", account);
    remote.on("data", account);
    remote.once("connect", () => {
      if (client.destroyed || this.stopped) {
        remote.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) remote.write(head);
      client.pipe(remote);
      remote.pipe(client);
    });
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.rejectStartup?.(new Error("Broker closed during startup"));
    this.rejectStartup = undefined;
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
    const server = this.server;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
