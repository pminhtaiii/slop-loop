import { DockerSandboxBackend } from "../../src/sandbox/docker.js";
import { DockerCliExecution } from "../../src/sandbox/dockerprocess.js";
import { DEFAULT_SANDBOX_LIMITS, ORDINARY_TEST_PATHS } from "../../src/sandbox/config.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { LocalDockerPort } from "../../src/sandbox/localdocker.js";
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));
const ports: LocalDockerPort[] = [];
function localPort() {
  const port = new LocalDockerPort();
  ports.push(port);
  return port;
}
afterEach(() => {
  for (const port of ports.splice(0)) expect(port.dispose()).toBe("CONFIRMED");
  vi.restoreAllMocks();
});
it("derives readiness from actual supported local Engine info rather than caller booleans", () => {
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "fixture",
    homedir: "fixture",
    uid: 1000,
    gid: 1000,
    shell: null,
  });
  vi.mocked(execFileSync).mockReturnValue(
    JSON.stringify({
      OSType: "linux",
      Architecture: "x86_64",
      ID: "owned-engine",
      MemoryLimit: true,
      SwapLimit: true,
      PidsLimit: true,
      SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"],
    }),
  );
  expect(localPort().readiness()).toEqual({
    networkDisabled: true,
    limitsEnforced: true,
    readOnlyMounts: true,
  });
});

it("fails closed for wrong Engine capabilities and changed daemon identity", () => {
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "fixture",
    homedir: "fixture",
    uid: 1000,
    gid: 1000,
    shell: null,
  });
  const info = {
    OSType: "linux",
    Architecture: "x86_64",
    ID: "engine-one",
    MemoryLimit: true,
    SwapLimit: true,
    PidsLimit: true,
    SecurityOptions: ["name=seccomp,profile=builtin"],
  };
  const mock = vi.mocked(execFileSync);
  const port = localPort();
  mock.mockReturnValue(JSON.stringify({ ...info, OSType: "windows" }));
  expect(port.readiness()).toMatchObject({ limitsEnforced: false });
  mock.mockReturnValue(JSON.stringify({ ...info, Architecture: "arm64" }));
  expect(port.readiness()).toMatchObject({ limitsEnforced: false });
  mock.mockReturnValue(JSON.stringify({ ...info, SwapLimit: false }));
  expect(port.readiness()).toMatchObject({ limitsEnforced: false });
  mock.mockReturnValue(
    JSON.stringify({ ...info, SecurityOptions: ["name=seccomp,profile=unconfined"] }),
  );
  expect(port.readiness()).toMatchObject({ limitsEnforced: false });
  mock.mockReturnValue(JSON.stringify(info));
  expect(port.readiness()).toMatchObject({ limitsEnforced: true });
  mock.mockReturnValue(JSON.stringify({ ...info, ID: "engine-two" }));
  expect(port.readiness()).toMatchObject({ limitsEnforced: false });
});
it("copies private regular bytes and refuses to delete an unowned staging entry", async () => {
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "fixture",
    homedir: "fixture",
    uid: 1000,
    gid: 1000,
    shell: null,
  });
  vi.mocked(execFileSync).mockReturnValue("");
  const port = localPort();
  const mount = await port.copySnapshot([
    { path: "src/a.ts", content: Buffer.from("actual source"), mode: 0o644 },
  ]);
  expect(fs.readFileSync(path.join(mount, "tree", "src", "a.ts"), "utf8")).toBe("actual source");
  expect(fs.lstatSync(path.join(mount, "tree", "src", "a.ts")).isSymbolicLink()).toBe(false);
  fs.chmodSync(mount, 0o755);
  const foreign = path.join(mount, "foreign-owned-by-test");
  fs.writeFileSync(foreign, "preserve");
  try {
    expect(await port.releaseSnapshot(mount)).toBe("UNCERTAIN");
    expect(fs.readFileSync(foreign, "utf8")).toBe("preserve");
  } finally {
    if (fs.existsSync(foreign)) fs.unlinkSync(foreign);
    await port.releaseSnapshot(mount);
  }
});

function runtimeFixture(native: boolean) {
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "fixture",
    homedir: "fixture",
    uid: 1000,
    gid: 1000,
    shell: null,
  });
  const imageId = "sha256:" + "a".repeat(64);
  let created: readonly string[] = [];
  vi.mocked(execFileSync).mockImplementation((_file, arguments_) => {
    const args = arguments_ as readonly string[];
    if (args.includes("info"))
      return JSON.stringify({
        OSType: "linux",
        Architecture: "amd64",
        ID: "fixture-engine",
        MemoryLimit: true,
        SwapLimit: true,
        PidsLimit: true,
        SecurityOptions: ["name=seccomp,profile=builtin"],
      });
    if (args.includes("image"))
      return JSON.stringify([
        {
          Id: imageId,
          Os: "linux",
          Architecture: "amd64",
          Config: { Labels: { "slop-loop.preparationFingerprint": "fingerprint" } },
        },
      ]);
    if (args.includes("create")) {
      created = args;
      return "container";
    }
    if (args.includes("inspect")) {
      const flag = created[created.indexOf("--mount") + 1]!;
      const source = flag.slice("type=bind,src=".length, flag.indexOf(",dst="));
      return JSON.stringify([
        {
          Image: imageId,
          Config: { User: "1000:1000" },
          HostConfig: {
            NetworkMode: "none",
            ReadonlyRootfs: true,
            Privileged: false,
            CapDrop: ["ALL"],
            CapAdd: null,
            SecurityOpt: ["no-new-privileges"],
            Memory: DEFAULT_SANDBOX_LIMITS.memoryBytes,
            MemorySwap: DEFAULT_SANDBOX_LIMITS.memoryBytes,
            PidsLimit: DEFAULT_SANDBOX_LIMITS.maxPids,
            NanoCpus: DEFAULT_SANDBOX_LIMITS.cpus * 1e9,
            LogConfig: { Type: "none" },
            Binds: null,
            Mounts: [{ Type: "bind", Source: source, Target: "/snapshot", ReadOnly: true }],
            Tmpfs: { "/workspace": "size=2147483648", "/tmp": "size=268435456" },
          },
        },
      ]);
    }
    return "";
  });
  vi.spyOn(DockerCliExecution.prototype, "stopAndRemove").mockResolvedValue("CONFIRMED");
  const run = vi
    .spyOn(DockerCliExecution.prototype, "run")
    .mockImplementation((args, _limits, runtime) =>
      Promise.resolve({
        id: runtime.resourceId!,
        output: "",
        exitCode: args.includes("rebuild") ? 7 : 0,
        truncated: false,
        terminationReason: "EXITED" as const,
      }),
    );
  const port = localPort();
  const backend = new DockerSandboxBackend(port);
  const bytes = Buffer.from("captured native source");
  const snapshot = {
    formatVersion: 1 as const,
    workspaceId: "workspace",
    exclusionPolicyId: "reference-v1",
    entries: native
      ? [
          {
            path: "native/workspace/binding.gyp",
            bytes: bytes.length,
            content: bytes,
            hash: "hash",
            mode: 0o644,
          },
        ]
      : [],
    totalBytes: native ? bytes.length : 0,
    snapshotId: "snapshot",
  };
  return {
    run,
    backend,
    input: {
      snapshot,
      image: {
        imageId,
        fingerprint: "fingerprint",
        architecture: "linux-x64",
        status: "READY" as const,
      },
      target: {
        check: native ? "build" : "tests",
        argv: native ? ["pnpm", "build"] : ["pnpm", "test"],
        taskId: "task",
        attemptId: "attempt",
        targetId: "target",
        profileSetId: "profile",
        nativeIdentity: "native",
      },
      limits: DEFAULT_SANDBOX_LIMITS,
      runtime: { signal: new AbortController().signal, deadlineAt: Date.now() + 30000 },
    },
  };
}
it("runs the native prelude in the clone and prevents consuming check after native failure", async () => {
  const f = runtimeFixture(true);
  const evidence = await f.backend.executeCheck(f.input);
  expect(evidence).toMatchObject({
    status: "FAIL",
    exitCode: 7,
    nativePrelude: "FAIL",
    cleanup: "CONFIRMED",
  });
  expect(f.run.mock.calls).toHaveLength(3);
  expect(f.run.mock.calls[2]?.[0]).toContain("--nodedir=/opt/slop-loop/node-headers");
  expect(f.run.mock.calls.some((call) => call[0].includes("pnpm"))).toBe(false);
});
it("selects the application-owned ordinary suite without a recursive Docker harness", async () => {
  const f = runtimeFixture(false);
  const evidence = await f.backend.executeCheck(f.input);
  expect(evidence).toMatchObject({
    status: "PASS",
    nativePrelude: "NOT_REQUIRED",
    cleanup: "CONFIRMED",
  });
  const args = f.run.mock.calls[1]![0];
  expect(args).toEqual(
    expect.arrayContaining(["--config", "/snapshot/vitest.config.cjs", ...ORDINARY_TEST_PATHS]),
  );
  expect(args).not.toContain("tests/sandbox");
  expect(
    args.some((arg) => arg.endsWith(".integration.test.ts") || arg.endsWith(".e2e.test.ts")),
  ).toBe(false);
});

it("refuses image-owned writable volumes even when immutable metadata matches", () => {
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "fixture",
    homedir: "fixture",
    uid: 1000,
    gid: 1000,
    shell: null,
  });
  const imageId = "sha256:" + "a".repeat(64);
  vi.mocked(execFileSync).mockReturnValue(
    JSON.stringify([
      {
        Id: imageId,
        Os: "linux",
        Architecture: "amd64",
        Config: {
          Labels: { "slop-loop.preparationFingerprint": "fingerprint" },
          Volumes: { "/unbounded": {} },
        },
      },
    ]),
  );
  expect(() => localPort().inspectImage(imageId)).toThrow("Image-owned volumes are forbidden");
});

it("makes validated parent directories writable before child deletion", async () => {
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "fixture",
    homedir: "fixture",
    uid: 1000,
    gid: 1000,
    shell: null,
  });
  vi.mocked(execFileSync).mockReturnValue("");
  const port = localPort();
  const mount = await port.copySnapshot([{ path: "a.ts", content: Buffer.from("x"), mode: 0o644 }]);
  const operations: string[] = [];
  const chmod = fs.promises.chmod.bind(fs.promises);
  const unlink = fs.promises.unlink.bind(fs.promises);
  vi.spyOn(fs.promises, "chmod").mockImplementation(async (name, mode) => {
    operations.push("chmod:" + String(name));
    await chmod(name, mode);
  });
  vi.spyOn(fs.promises, "unlink").mockImplementation(async (name) => {
    operations.push("unlink:" + String(name));
    await unlink(name);
  });
  expect(await port.releaseSnapshot(mount)).toBe("CONFIRMED");
  expect(operations.indexOf("chmod:" + mount)).toBeLessThan(
    operations.findIndex((op) => op.startsWith("unlink:")),
  );
});
it("cleans owned partial staging when payload setup fails", async () => {
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "fixture",
    homedir: "fixture",
    uid: 1000,
    gid: 1000,
    shell: null,
  });
  vi.mocked(execFileSync).mockReturnValue("");
  const mkdir = fs.mkdirSync.bind(fs);
  let stageRoot: string | undefined;
  vi.spyOn(fs, "mkdirSync").mockImplementation((name, options) => {
    if (String(name).endsWith(path.sep + "payload")) {
      stageRoot = path.dirname(String(name));
      throw new Error("fixture setup failure");
    }
    return mkdir(name, options);
  });
  const port = localPort();
  try {
    await expect(port.copySnapshot([])).rejects.toThrow("Snapshot materialization failed");
    expect(stageRoot).toBeDefined();
    expect(fs.existsSync(stageRoot!)).toBe(false);
  } finally {
    if (stageRoot && fs.existsSync(stageRoot)) fs.rmdirSync(stageRoot);
  }
});

it("loads the trusted ordinary config without writing beside read-only staging", async () => {
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "fixture",
    homedir: "fixture",
    uid: 1000,
    gid: 1000,
    shell: null,
  });
  vi.mocked(execFileSync).mockReturnValue("");
  const port = localPort();
  const mount = await port.copySnapshot([]);
  const child = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const script = `const fs=require('node:fs'),p=require('node:path'),{createRequire}=require('node:module');const r=createRequire(require.resolve('vitest/package.json'));const vite=require(r.resolve('vite'));const dir=process.argv[1];const config=fs.readdirSync(dir).find(n=>n.startsWith('vitest.config.'));const write=fs.promises.writeFile;fs.promises.writeFile=function(name,...args){if(String(name).startsWith(dir+p.sep))throw Error('EROFS fixture: staging is read-only');return write.call(this,name,...args);};vite.loadConfigFromFile({command:'serve',mode:'test'},p.join(dir,config),process.cwd()).then(value=>{if(!value)process.exit(2);if(value.config.cacheDir!=='/tmp/slop-loop-vite-cache'){console.error('trusted cache must be writable');process.exit(4);}}).catch(error=>{console.error(error.message);process.exit(3);});`;
  try {
    expect(() =>
      child.execFileSync(process.execPath, ["-e", script, mount], {
        timeout: 10000,
        stdio: "pipe",
      }),
    ).not.toThrow();
  } finally {
    await port.releaseSnapshot(mount);
  }
});

it("stops materialization at its cancellation boundary without returning a mount", async () => {
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "fixture",
    homedir: "fixture",
    uid: 1000,
    gid: 1000,
    shell: null,
  });
  vi.mocked(execFileSync).mockReturnValue("");
  const controller = new AbortController();
  controller.abort(new Error("cancelled snapshot staging"));
  const port = localPort();
  await expect(
    port.copySnapshot([{ path: "a.ts", mode: 0o644, content: Buffer.from("x") }], {
      signal: controller.signal,
      deadlineAt: Date.now() + 1000,
    }),
  ).rejects.toThrow("Snapshot materialization failed");
  expect(port.dispose()).toBe("CONFIRMED");
});

it("accepts matching prepared Node headers using the actual native prerequisite payload", async () => {
  const f = runtimeFixture(true);
  await f.backend.executeCheck(f.input);
  const args = f.run.mock.calls[1]![0];
  const payload = args[args.indexOf("-e") + 1]!;
  const child = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const [major, minor, patch] = process.versions.node.split(".");
  const headers = `#define NODE_MAJOR_VERSION ${major}\n#define NODE_MINOR_VERSION ${minor}\n#define NODE_PATCH_VERSION ${patch}\n`;
  const prefix = `const Module=require('node:module'),load=Module._load;Module._load=function(name,...args){return name==='/opt/slop-loop/node_modules/node-gyp/package.json'?{version:'12.4.0'}:load.call(this,name,...args);};const nativeFs=require('node:fs'),read=nativeFs.readFileSync;nativeFs.readFileSync=function(name,...args){return name==='/opt/slop-loop/node-headers/include/node/node_version.h'?${JSON.stringify(headers)}:read.call(this,name,...args);};`;
  expect(
    child.spawnSync(process.execPath, ["-e", prefix + payload], { timeout: 5000, stdio: "pipe" })
      .status,
  ).toBe(0);
  const mismatched = prefix.replace(
    JSON.stringify(headers),
    JSON.stringify(headers.replace(`NODE_PATCH_VERSION ${patch}`, "NODE_PATCH_VERSION 999")),
  );
  expect(
    child.spawnSync(process.execPath, ["-e", mismatched + payload], {
      timeout: 5000,
      stdio: "pipe",
    }).status,
  ).toBe(90);
});
