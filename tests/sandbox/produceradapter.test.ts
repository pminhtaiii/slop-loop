import { expect, it } from "vitest";
import * as producer from "../../src/sandbox/produceradapter.js";

it("refuses unregistered producers before any pause/export command", async () => {
  let effects = 0;
  const adapter = new producer.DockerProducerTransfer(() => {
    effects++;
    return Promise.resolve("");
  });
  const identity = { actionId: "action", resourceId: "foreign", generation: 1, engineId: "engine" };
  await expect(adapter.pause(identity, new AbortController().signal)).rejects.toThrow(
    "Unowned preparation producer",
  );
  expect(effects).toBe(0);
});
