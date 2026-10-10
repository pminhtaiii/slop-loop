import { expect, it } from "vitest";
import { Readable } from "node:stream";
import tar from "tar-stream";
import * as transfer from "../../src/sandbox/frozentransfer.js";

it("binds stable exported bytes to a paused, quiescent owned producer generation", async () => {
  const pack = tar.pack();
  pack.entry({ name: "package.json", mode: 0o644 }, "{}");
  pack.finalize();
  const bytes: Buffer[] = [];
  for await (const chunk of pack) bytes.push(Buffer.from(chunk));
  const producer = {
    actionId: "action",
    resourceId: "producer",
    generation: 1,
    engineId: "engine",
  };
  const frozen = await transfer.freezeAndSeal(
    producer,
    {
      quiesce: () => Promise.resolve(),
      pause: () => Promise.resolve(),
      inspect: () => Promise.resolve({ ...producer, paused: true, quiescent: true }),
      export: () => Promise.resolve(Readable.from(bytes)),
    },
    new AbortController().signal,
  );
  expect(transfer.isFrozenArchive(frozen)).toBe(true);
  expect(transfer.isFrozenArchive({ ...frozen })).toBe(false);
  expect(frozen.entries).toHaveLength(1);
  expect(frozen.contentId).toMatch(/^[a-f0-9]{64}$/u);
  frozen.dispose();
});

it("rejects wrong generation before obtaining any untrusted export", async () => {
  let exported = false;
  const producer = {
    actionId: "action",
    resourceId: "producer",
    generation: 1,
    engineId: "engine",
  };
  await expect(
    transfer.freezeAndSeal(
      producer,
      {
        quiesce: () => Promise.resolve(),
        pause: () => Promise.resolve(),
        inspect: () =>
          Promise.resolve({ ...producer, generation: 2, paused: true, quiescent: true }),
        export: () => {
          exported = true;
          return Promise.resolve(Readable.from([]));
        },
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Frozen producer identity unavailable");
  expect(exported).toBe(false);
});

it("settles cancellation that occurs before export returns a stalled stream", async () => {
  const abort = new AbortController();
  const source = new Readable({ read() {} });
  const producer = {
    actionId: "action",
    resourceId: "producer",
    generation: 1,
    engineId: "engine",
  };
  await expect(
    transfer.freezeAndSeal(
      producer,
      {
        quiesce: () => Promise.resolve(),
        pause: () => Promise.resolve(),
        inspect: () => Promise.resolve({ ...producer, paused: true, quiescent: true }),
        export: () => {
          abort.abort();
          return Promise.resolve(source);
        },
      },
      abort.signal,
    ),
  ).rejects.toThrow();
  expect(source.destroyed).toBe(true);
}, 500);

it("resolves executable links through validated package aliases", async () => {
  const pack = tar.pack();
  pack.entry(
    { name: ".pnpm/fixture/node_modules/fixture/run.js", mode: 0o755 },
    "signed executable",
  );
  pack.entry({ name: "fixture", type: "symlink", linkname: ".pnpm/fixture/node_modules/fixture" });
  pack.entry({ name: ".bin/fixture", type: "symlink", linkname: "../fixture/run.js" });
  pack.finalize();
  const producer = {
    actionId: "action",
    resourceId: "producer",
    generation: 1,
    engineId: "engine",
  };
  const sealed = await transfer.freezeAndSeal(
    producer,
    {
      quiesce: () => Promise.resolve(),
      pause: () => Promise.resolve(),
      inspect: () => Promise.resolve({ ...producer, paused: true, quiescent: true }),
      export: () => Promise.resolve(Readable.from(pack)),
    },
    new AbortController().signal,
  );
  sealed.dispose();
});
