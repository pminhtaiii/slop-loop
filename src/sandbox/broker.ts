import { isIP } from "node:net";

export interface BrokerResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: Buffer | AsyncIterable<Buffer>;
}

interface BrokerOptions {
  readonly approvedHosts: readonly string[];
  readonly resolve: (hostname: string) => Promise<readonly string[]>;
  readonly request: (url: URL, address: string) => Promise<BrokerResponse>;
  readonly maxBytes?: number;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [first, second] = octets;
  if (first === undefined || second === undefined || octets.length !== 4) return true;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second !== undefined && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && second !== undefined && (second === 18 || second === 19)) ||
    first >= 224
  );
}

export function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized.startsWith("::ffff:")) return isPublicAddress(normalized.slice(7));
  const version = isIP(normalized);
  if (version === 4) return !isPrivateIpv4(normalized);
  if (version !== 6) return false;
  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff")
  );
}

async function boundedBody(
  body: Buffer | AsyncIterable<Buffer>,
  maxBytes: number,
): Promise<Buffer> {
  if (Buffer.isBuffer(body)) {
    if (body.byteLength > maxBytes) throw new Error("Broker response exceeds byte limit");
    return Buffer.from(body);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error("Broker response exceeds byte limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class ApprovedFetchBroker {
  private readonly approvedHosts: ReadonlySet<string>;
  private readonly maxBytes: number;

  constructor(private readonly options: BrokerOptions) {
    this.approvedHosts = new Set(options.approvedHosts.map((host) => host.toLowerCase()));
    this.maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new TypeError("Broker byte limit is invalid");
    }
  }

  async fetch(url: URL): Promise<BrokerResponse & { readonly body: Buffer }> {
    if (url.protocol !== "https:" || !this.approvedHosts.has(url.hostname.toLowerCase())) {
      throw new Error("Broker destination is not approved");
    }
    if (url.port !== "" && url.port !== "443") {
      throw new Error("Broker destination port is not approved");
    }
    const addresses = await this.options.resolve(url.hostname);
    if (addresses.length === 0 || addresses.some((addr) => !isPublicAddress(addr))) {
      throw new Error("Broker destination resolves to a private address");
    }
    const address = addresses[0]!;
    const response = await this.options.request(url, address);
    if (response.statusCode >= 300 && response.statusCode < 400) {
      throw new Error("Broker redirects are not allowed");
    }
    return { ...response, body: await boundedBody(response.body, this.maxBytes) };
  }
}
