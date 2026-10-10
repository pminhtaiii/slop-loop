import { pathToFileURL } from "node:url";
import { ConnectBroker } from "./connectbroker.js";

export const TRUSTED_BROKER_BIND_ADDRESS = "172.31.253.2";

/** App-owned infrastructure entry; no repository or environment endpoint selection. */
async function main(): Promise<void> {
  if (process.platform !== "linux" || process.argv.length !== 2)
    throw new Error("Fixed Linux broker entry required");
  const broker = new ConnectBroker({ listenHost: TRUSTED_BROKER_BIND_ADDRESS, port: 3128 });
  await broker.start();
  const stop = (): void => {
    void broker.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("Preparation broker failed\n");
    process.exitCode = 1;
  });
}
