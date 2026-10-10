import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tar from "tar-stream";
import { NORMALIZATION_METADATA, NORMALIZATION_RECIPE } from "../../src/sandbox/dependencytree.js";
import { parseLockedGraph } from "../../src/sandbox/downloads.js";
import * as worker from "../../src/sandbox/preparationworker.js";
import { createHash } from "node:crypto";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slop-loop-worker-fixture-"));
  roots.push(root);
  const privateRoot = path.join(root, "preparation");
  fs.mkdirSync(privateRoot);
  return { privateRoot, storeRoot: path.join(root, "store") };
}
const bytes = Buffer.from("authenticated artifact");
const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
const graphInput = {
  manifest: JSON.stringify({
    dependencies: { fixture: "1.0.0" },
    scripts: { install: "never run root" },
  }),
  lockfile: `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      fixture: {specifier: 1.0.0, version: 1.0.0}\npackages:\n  fixture@1.0.0:\n    resolution: {integrity: ${integrity}}\nsnapshots:\n  fixture@1.0.0: {}\n`,
};

it("executes pinned fetch, retains authenticated supplemental bytes, and checks offline input identity", async () => {
  const options = fixture();
  const calls: { executable: string; args: readonly string[] }[] = [];
  const execute: worker.WorkerExecutor = (executable, args) => {
    calls.push({ executable, args });
    return Promise.resolve(Buffer.from(args[0] === "--version" ? "12.5.1\n" : ""));
  };
  const ports = { ...options, execute, request: () => Promise.resolve({ status: 200, bytes }) };
  expect((await worker.runPreparationWorkerPhase("fetch", graphInput, ports)).toString()).toBe(
    "fetch:PASS",
  );
  expect(await worker.runPreparationWorkerPhase("artifact", { index: 0 }, ports)).toEqual(bytes);
  expect(fs.readFileSync(path.join(options.privateRoot, "pnpm-lock.yaml"), "utf8")).toBe(
    graphInput.lockfile,
  );
  expect(fs.readFileSync(path.join(options.privateRoot, "package.json"), "utf8")).not.toContain(
    "never run root",
  );
  expect(
    (await worker.runPreparationWorkerPhase("materialize", graphInput, ports)).toString(),
  ).toBe("materialize:PASS");
  expect(calls.filter((call) => call.args[0] === "install")[0]?.args).toContain("--offline");
  await expect(
    worker.runPreparationWorkerPhase("artifact", { index: "../0" }, ports),
  ).rejects.toThrow();
  await expect(
    worker.runPreparationWorkerPhase(
      "materialize",
      { ...graphInput, lockfile: graphInput.lockfile + "\n" },
      ports,
    ),
  ).rejects.toThrow();
});

it("denies an incorrect manager version before fetch or any download", async () => {
  const options = fixture();
  let downloads = 0;
  await expect(
    worker.runPreparationWorkerPhase("fetch", graphInput, {
      ...options,
      execute: () => Promise.resolve(Buffer.from("12.4.0")),
      request: () => {
        downloads++;
        return Promise.resolve({ status: 200, bytes });
      },
    }),
  ).rejects.toThrow("Pinned package manager unavailable");
  expect(downloads).toBe(0);
});

it("refuses offline materialization after an incomplete supplemental fetch", async () => {
  const options = fixture();
  let installs = 0;
  const ports = {
    ...options,
    execute: ((_executable, args) => {
      if (args[0] === "install") installs++;
      return Promise.resolve(Buffer.from(args[0] === "--version" ? "12.5.1" : ""));
    }) satisfies worker.WorkerExecutor,
    request: () => Promise.resolve({ status: 200, bytes: Buffer.from("corrupt") }),
  };
  await expect(worker.runPreparationWorkerPhase("fetch", graphInput, ports)).rejects.toThrow();
  await expect(
    worker.runPreparationWorkerPhase("materialize", graphInput, ports),
  ).rejects.toThrow();
  expect(installs).toBe(0);
});

async function importInput(implicitNative = false) {
  const graph = parseLockedGraph(graphInput.lockfile, graphInput.manifest);
  const packagePath = graph.nodes[0]!.root + "/package.json";
  const packageBytes = JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    ...(implicitNative ? {} : { scripts: { install: "echo approved" } }),
  });
  const files: readonly (readonly [string, string])[] = [
    [".slop-loop-tree.json", NORMALIZATION_METADATA],
    [packagePath, packageBytes],
    ...(implicitNative ? [[graph.nodes[0]!.root + "/binding.gyp", "{}"] as const] : []),
  ];
  const manifest = files.map(([file, content]) => ({
    path: file,
    kind: "file" as const,
    size: Buffer.byteLength(content),
    mode: 0o644,
    hash: createHash("sha256").update(content).digest("hex"),
  }));
  const canonical = manifest
    .map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode,
      hash: entry.hash,
      bytes: entry.size,
    }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  const contentId = createHash("sha256")
    .update(JSON.stringify([NORMALIZATION_RECIPE, canonical]))
    .digest("hex");
  const pack = tar.pack();
  for (const [file, content] of files) pack.entry({ name: file, mode: 0o644 }, content);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  return {
    tar: Buffer.concat(chunks).toString("base64"),
    manifest,
    contentId,
    graph: graphInput,
    instruction: {
      nodeKey: graph.nodes[0]!.key,
      root: graph.nodes[0]!.root,
      integrity,
      phase: "install" as const,
      command: implicitNative ? "node-gyp rebuild" : "echo approved",
    },
  };
}

it("runs exact-approved implicit native install only from authenticated binding.gyp", async () => {
  const options = fixture();
  const input = await importInput(true);
  await worker.runPreparationWorkerPhase(
    "import",
    { tar: input.tar, manifest: input.manifest, contentId: input.contentId, graph: input.graph },
    options,
  );
  const observed: string[] = [];
  const output = await worker.runPreparationWorkerPhase(
    "scripts",
    { instructions: [input.instruction], treeId: input.contentId, graph: input.graph },
    {
      ...options,
      execute: (executable, argv) => {
        if (executable === "node") return Promise.resolve(Buffer.from("native-prerequisites:PASS"));
        observed.push(argv.join(" "));
        return Promise.resolve(Buffer.alloc(0));
      },
    },
  );
  expect(output.toString()).toBe("scripts:PASS");
  expect(observed).toEqual(["-c node-gyp rebuild"]);
});

it("imports canonical bytes into a fresh CAS-free recipient and runs only the matching dependency script", async () => {
  const options = fixture();
  const input = await importInput();
  const executed: string[] = [];
  const execute: worker.WorkerExecutor = (_executable, args, cwd, env) => {
    if (_executable === "node") return Promise.resolve(Buffer.from("native-prerequisites:PASS"));
    expect(env.npm_config_nodedir).toBe("/opt/slop-loop/node-headers");
    expect(env.npm_config_offline).toBe("true");
    expect(env.PATH).toBe("/opt/slop-loop/node_modules/.bin:/usr/local/bin:/usr/bin:/bin");
    executed.push(cwd + ":" + args.join(" "));
    return Promise.resolve(Buffer.alloc(0));
  };
  expect(
    (
      await worker.runPreparationWorkerPhase(
        "import",
        {
          tar: input.tar,
          manifest: input.manifest,
          contentId: input.contentId,
          graph: input.graph,
        },
        options,
      )
    ).toString(),
  ).toBe("import:PASS");
  if (process.platform !== "win32") {
    expect(
      fs.statSync(path.join(options.privateRoot, "node_modules", input.instruction.root)).mode &
        0o777,
    ).toBe(0o755);
  }
  const scriptInput = {
    instructions: [input.instruction],
    treeId: input.contentId,
    graph: input.graph,
  };
  expect(
    (
      await worker.runPreparationWorkerPhase("scripts", scriptInput, { ...options, execute })
    ).toString(),
  ).toBe("scripts:PASS");
  expect(executed).toEqual([
    path.join(options.privateRoot, "node_modules", input.instruction.root) + ":-c echo approved",
  ]);
  await expect(
    worker.runPreparationWorkerPhase("scripts", scriptInput, { ...options, execute }),
  ).rejects.toThrow();
});

it("rejects script execution without completed import and rejects mutated package content", async () => {
  const options = fixture();
  const input = await importInput();
  let executions = 0;
  const ports = {
    ...options,
    execute: () => {
      executions++;
      return Promise.resolve(Buffer.alloc(0));
    },
  };
  const scriptInput = {
    instructions: [input.instruction],
    treeId: input.contentId,
    graph: input.graph,
  };
  await expect(worker.runPreparationWorkerPhase("scripts", scriptInput, ports)).rejects.toThrow();
  await worker.runPreparationWorkerPhase(
    "import",
    { tar: input.tar, manifest: input.manifest, contentId: input.contentId, graph: input.graph },
    options,
  );
  fs.writeFileSync(
    path.join(options.privateRoot, "node_modules", input.instruction.root, "package.json"),
    "{}",
  );
  await expect(worker.runPreparationWorkerPhase("scripts", scriptInput, ports)).rejects.toThrow();
  expect(executions).toBe(0);
});

it("rejects tree identity mismatch and a recipient containing an old package store", async () => {
  const input = await importInput();
  const options = fixture();
  await expect(
    worker.runPreparationWorkerPhase(
      "import",
      { tar: input.tar, manifest: input.manifest, contentId: "a".repeat(64), graph: input.graph },
      options,
    ),
  ).rejects.toThrow();
  expect(fs.readdirSync(options.privateRoot)).toEqual([]);
  fs.mkdirSync(options.storeRoot);
  await expect(
    worker.runPreparationWorkerPhase(
      "import",
      { tar: input.tar, manifest: input.manifest, contentId: input.contentId, graph: input.graph },
      options,
    ),
  ).rejects.toThrow();
});

it("rejects a substituted script command or package root without running dependency code", async () => {
  const options = fixture();
  const input = await importInput();
  let executions = 0;
  const ports = {
    ...options,
    execute: () => {
      executions++;
      return Promise.resolve(Buffer.alloc(0));
    },
  };
  await worker.runPreparationWorkerPhase(
    "import",
    { tar: input.tar, manifest: input.manifest, contentId: input.contentId, graph: input.graph },
    options,
  );
  for (const instruction of [
    { ...input.instruction, command: "echo substituted" },
    { ...input.instruction, root: "../../" },
  ]) {
    await expect(
      worker.runPreparationWorkerPhase(
        "scripts",
        { instructions: [instruction], treeId: input.contentId, graph: input.graph },
        ports,
      ),
    ).rejects.toThrow();
  }
  expect(executions).toBe(0);
});

it("checks pinned native prerequisites before any approved dependency script starts", async () => {
  const options = fixture();
  const input = await importInput();
  let scripts = 0;
  await worker.runPreparationWorkerPhase(
    "import",
    { tar: input.tar, manifest: input.manifest, contentId: input.contentId, graph: input.graph },
    options,
  );
  await expect(
    worker.runPreparationWorkerPhase(
      "scripts",
      { instructions: [input.instruction], treeId: input.contentId, graph: input.graph },
      {
        ...options,
        execute: (executable) => {
          if (executable === "/bin/sh") scripts++;
          return Promise.resolve(Buffer.from("wrong version"));
        },
      },
    ),
  ).rejects.toThrow("Pinned native prerequisites unavailable");
  expect(scripts).toBe(0);
});

it("keeps fetch commands closed and hooks/scripts disabled for the pinned manager", () => {
  expect(worker.fixedManagerArguments("fetch")).toContain("--config.ignore-scripts=true");
  expect(worker.fixedManagerArguments("fetch")).toContain("--ignore-pnpmfile");
  expect(worker.fixedManagerArguments("materialize")).toContain("--offline");
  expect(worker.fixedManagerArguments("materialize")).toContain("--frozen-lockfile");
});

it("checks actual supplemental bytes and refuses redirects and corruption", async () => {
  const bytes = Buffer.from("actual tarball");
  const artifact = {
    name: "fixture",
    version: "1.0.0",
    tarball: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz",
    integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
  };
  const observed: string[] = [];
  const fetched = await worker.fetchExactArtifact(artifact, new AbortController().signal, (url) => {
    observed.push(url);
    return Promise.resolve({ status: 200, bytes });
  });
  expect(fetched).toEqual(bytes);
  expect(observed).toEqual([artifact.tarball]);
  await expect(
    worker.fetchExactArtifact(artifact, new AbortController().signal, () =>
      Promise.resolve({ status: 302, bytes }),
    ),
  ).rejects.toThrow("Restricted artifact response rejected");
  await expect(
    worker.fetchExactArtifact(artifact, new AbortController().signal, () =>
      Promise.resolve({ status: 200, bytes: Buffer.from("corrupt") }),
    ),
  ).rejects.toThrow("Artifact integrity failure");
});
