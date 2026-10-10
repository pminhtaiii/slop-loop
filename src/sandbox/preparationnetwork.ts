import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { allowlistedDockerEnv } from "./dockerprocess.js";
import { createPreparationDockerCli } from "./preparationcli.js";

export type PreparationDockerCommand = (
  argv: readonly string[],
  signal: AbortSignal,
) => Promise<string>;
export function preparationCommandTimeout(argv: readonly string[]): number {
  return argv[0] === "build" ? 15 * 60_000 : argv[0] === "run" ? 60_000 : 30_000;
}
const observations = new WeakSet<object>();
export interface FetchAdmission {
  readonly actionId: string;
  readonly generation: number;
  readonly engineId: string;
  readonly containerId: string;
  readonly namespaceId: string;
  readonly brokerAddress: "172.31.253.2:3128";
}
export function isFetchAdmission(value: unknown): value is FetchAdmission {
  return typeof value === "object" && value !== null && observations.has(value);
}
const inspectSchema = z
  .array(
    z.object({
      Id: z.string().min(1),
      State: z.object({ Running: z.literal(true) }),
      Config: z.object({ Labels: z.record(z.string(), z.string()) }),
      NetworkSettings: z.object({ SandboxKey: z.string().min(1) }),
    }),
  )
  .length(1);

/** Fixed application command, never repository/model argv or Docker environment. */
export async function localPreparationDockerCommand(
  argv: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const cli = createPreparationDockerCli();
  try {
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        let outcome: Error | { stdout: string; stderr: string } | undefined;
        const child = execFile(
          "docker",
          [...cli.prefix, ...argv],
          {
            env: { ...allowlistedDockerEnv(), DOCKER_BUILDKIT: "0" },
            shell: false,
            signal,
            timeout: preparationCommandTimeout(argv),
            killSignal: "SIGKILL",
            maxBuffer: 1024 * 1024,
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            outcome = error ?? { stdout, stderr };
          },
        );
        child.once("close", () => {
          if (outcome instanceof Error) reject(outcome);
          else if (outcome) resolve(outcome);
          else reject(new Error("Preparation CLI settlement unavailable"));
        });
      },
    );
    if (stderr.length > 1024 * 1024) throw new Error("Preparation output limit exceeded");
    return stdout;
  } finally {
    cli.dispose();
  }
}

const namespaceSetup = `const {execFileSync}=require('node:child_process');
for(const executable of ['/usr/sbin/iptables','/usr/sbin/ip6tables']){
const invoke=(args)=>execFileSync(executable,['--wait','5',...args],{timeout:5000,stdio:'pipe',env:{PATH:'/usr/sbin:/usr/bin:/bin'}});
invoke(['-P','OUTPUT','DROP']);invoke(['-F','OUTPUT']);
if(executable.endsWith('/iptables'))invoke(['-A','OUTPUT','-d','172.31.253.2/32','-p','tcp','--dport','3128','-j','ACCEPT']);
const policy=invoke(['-S','OUTPUT']).toString();if(!policy.includes('-P OUTPUT DROP'))throw Error('egress enforcement absent');}
process.stdout.write('egress-policy-installed');`;
const hardening = [
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--user=10001:10001",
  "--cpus=2",
  "--memory=4g",
  "--memory-swap=4g",
  "--pids-limit=256",
  "--log-driver=none",
  "--tmpfs=/preparation:rw,nosuid,nodev,size=2g,uid=10001,gid=10001",
  "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=256m,uid=10001,gid=10001",
];

/** Concrete namespace setup only. Artifact fetch and offline stages are separate owned operations. */
export class DockerPreparationNetwork {
  constructor(
    private readonly baseImageId: string,
    private readonly command: PreparationDockerCommand = localPreparationDockerCommand,
  ) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(baseImageId))
      throw new Error("Immutable preparation base unavailable");
  }
  private readonly resources = new Map<
    string,
    { actionId: string; kind: "container" | "network"; generation?: number }
  >();
  private readonly engines = new Map<string, string>();

  private async inspectOwned(admission: FetchAdmission, signal: AbortSignal) {
    if (!isFetchAdmission(admission) || this.engines.get(admission.actionId) !== admission.engineId)
      throw new Error("Unowned fetch admission");
    const engine = z
      .object({ ID: z.string() })
      .parse(JSON.parse(await this.command(["info", "--format", "{{json .}}"], signal)));
    if (engine.ID !== admission.engineId) throw new Error("Preparation engine changed");
    const observed = inspectSchema.parse(
      JSON.parse(await this.command(["inspect", admission.containerId], signal)),
    )[0]!;
    if (
      observed.Id !== admission.containerId ||
      observed.Config.Labels["slop-loop.actionId"] !== admission.actionId ||
      observed.Config.Labels["slop-loop.generation"] !== String(admission.generation) ||
      observed.NetworkSettings.SandboxKey !== admission.namespaceId
    )
      throw new Error("Fetch namespace changed");
    return observed;
  }

  async disconnect(admission: FetchAdmission, signal: AbortSignal): Promise<void> {
    await this.inspectOwned(admission, signal);
    const network = [...this.resources].find(
      ([, resource]) => resource.actionId === admission.actionId && resource.kind === "network",
    );
    if (!network || admission.generation !== 1) throw new Error("Unowned fetch admission");
    await this.command(["network", "disconnect", network[0], admission.containerId], signal);
    const current = z
      .array(
        z.object({ Id: z.string(), NetworkSettings: z.object({ Networks: z.strictObject({}) }) }),
      )
      .length(1)
      .parse(JSON.parse(await this.command(["inspect", admission.containerId], signal)))[0]!;
    if (current.Id !== admission.containerId) throw new Error("Network termination unavailable");
  }

  async removeProducer(admission: FetchAdmission, signal: AbortSignal): Promise<void> {
    await this.inspectOwned(admission, signal);
    const owned = [...this.resources].filter(
      ([, resource]) => resource.actionId === admission.actionId && resource.kind === "container",
    );
    let matched: string | undefined;
    for (const [name] of owned) {
      const found = (
        await this.command(
          ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `name=^/${name}$`],
          signal,
        )
      ).trim();
      if (found === admission.containerId) {
        matched = name;
        break;
      }
    }
    if (!matched) throw new Error("Producer ownership unavailable");
    await this.command(["rm", "--force", "--", admission.containerId], signal);
    if (
      (
        await this.command(
          ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `name=^/${matched}$`],
          signal,
        )
      ).trim()
    )
      throw new Error("CAS producer cleanup unconfirmed");
    this.resources.delete(matched);
    observations.delete(admission);
  }

  async createOffline(
    actionId: string,
    engineId: string,
    signal: AbortSignal,
  ): Promise<FetchAdmission> {
    if (!/^[A-Za-z0-9-]{1,128}$/u.test(actionId))
      throw new Error("Preparation identity unavailable");
    const observedEngine = z
      .object({ ID: z.string() })
      .parse(JSON.parse(await this.command(["info", "--format", "{{json .}}"], signal)));
    if (
      observedEngine.ID !== engineId ||
      (this.engines.has(actionId) && this.engines.get(actionId) !== engineId)
    )
      throw new Error("Preparation engine changed");
    this.engines.set(actionId, engineId);
    const name = `slop-loop-preparation-${randomUUID()}-offline`;
    this.resources.set(name, { actionId, kind: "container", generation: 2 });
    const id = (
      await this.command(
        [
          "create",
          "--name",
          name,
          "--label",
          `slop-loop.actionId=${actionId}`,
          "--label",
          "slop-loop.generation=2",
          ...hardening,
          "--network",
          "none",
          "--entrypoint",
          "node",
          this.baseImageId,
          "-e",
          "setInterval(()=>{},1000)",
        ],
        signal,
      )
    ).trim();
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("Immutable preparation resource unavailable");
    await this.command(["start", id], signal);
    const observed = z
      .array(
        z.object({
          Id: z.string(),
          State: z.object({ Running: z.literal(true) }),
          Config: z.object({ Labels: z.record(z.string(), z.string()) }),
          HostConfig: z.object({ NetworkMode: z.literal("none") }),
          NetworkSettings: z.object({
            SandboxKey: z.string().min(1),
            Networks: z.strictObject({}),
          }),
        }),
      )
      .length(1)
      .parse(JSON.parse(await this.command(["inspect", id], signal)))[0]!;
    if (
      observed.Id !== id ||
      observed.Config.Labels["slop-loop.actionId"] !== actionId ||
      observed.Config.Labels["slop-loop.generation"] !== "2"
    )
      throw new Error("CAS-free recipient identity unavailable");
    const receipt = Object.freeze({
      actionId,
      generation: 2,
      engineId,
      containerId: id,
      namespaceId: observed.NetworkSettings.SandboxKey,
      brokerAddress: "172.31.253.2:3128" as const,
    });
    observations.add(receipt);
    return receipt;
  }

  async open(actionId: string, engineId: string, signal: AbortSignal): Promise<FetchAdmission> {
    if (!/^[A-Za-z0-9-]{1,128}$/u.test(actionId) || !engineId)
      throw new Error("Preparation identity unavailable");
    signal.throwIfAborted();
    const engine = z
      .object({ ID: z.string().min(1) })
      .parse(JSON.parse(await this.command(["info", "--format", "{{json .}}"], signal)));
    if (engine.ID !== engineId) throw new Error("Preparation engine changed");
    if (this.engines.has(actionId)) throw new Error("Preparation network already active");
    this.engines.set(actionId, engineId);
    const name = `slop-loop-preparation-${randomUUID()}`;
    const fetch = `${name}-fetch`,
      broker = `${name}-broker`,
      setup = `${name}-setup`;
    const labels = [
      "--label",
      `slop-loop.actionId=${actionId}`,
      "--label",
      "slop-loop.generation=1",
    ];
    this.resources.set(name, { actionId, kind: "network" });
    await this.command(
      [
        "network",
        "create",
        "--internal",
        "--driver",
        "bridge",
        "--subnet",
        "172.31.253.0/24",
        ...labels,
        name,
      ],
      signal,
    );
    this.resources.set(broker, { actionId, kind: "container" });
    await this.command(
      [
        "create",
        "--name",
        broker,
        ...labels,
        "--label",
        "slop-loop.role=broker",
        ...hardening,
        "--network",
        name,
        "--ip",
        "172.31.253.2",
        "--entrypoint",
        "node",
        this.baseImageId,
        "/opt/slop-loop-preparation/connectbrokerentry.js",
      ],
      signal,
    );
    await this.command(["network", "connect", "bridge", broker], signal);
    await this.command(["start", broker], signal);
    this.resources.set(fetch, { actionId, kind: "container" });
    await this.command(
      [
        "create",
        "--name",
        fetch,
        ...labels,
        "--label",
        "slop-loop.role=fetch",
        ...hardening,
        "--network",
        name,
        "--entrypoint",
        "node",
        this.baseImageId,
        "-e",
        "setInterval(()=>{},1000)",
      ],
      signal,
    );
    await this.command(["start", fetch], signal);
    const initial = inspectSchema.parse(
      JSON.parse(await this.command(["inspect", fetch], signal)),
    )[0]!;
    if (
      initial.Config.Labels["slop-loop.actionId"] !== actionId ||
      initial.Config.Labels["slop-loop.generation"] !== "1"
    )
      throw new Error("Fetch namespace ownership unavailable");
    this.resources.set(setup, { actionId, kind: "container" });
    const acknowledgement = await this.command(
      [
        "run",
        "--name",
        setup,
        ...labels,
        "--network",
        `container:${initial.Id}`,
        "--read-only",
        "--cap-drop=ALL",
        "--cap-add=NET_ADMIN",
        "--user=0:0",
        "--security-opt=no-new-privileges",
        "--cpus=1",
        "--memory=128m",
        "--memory-swap=128m",
        "--pids-limit=32",
        "--log-driver=none",
        "--entrypoint",
        "node",
        this.baseImageId,
        "-e",
        namespaceSetup,
      ],
      signal,
    );
    if (acknowledgement !== "egress-policy-installed")
      throw new Error("Egress enforcement acknowledgement unavailable");
    const brokerReady = await this.command(
      [
        "exec",
        initial.Id,
        "node",
        "-e",
        "const n=require('node:net');const s=n.connect({host:'172.31.253.2',port:3128},()=>{process.stdout.write('broker:READY');s.end();});s.setTimeout(5000,()=>{s.destroy();process.exit(1);});s.on('error',()=>process.exit(1));",
      ],
      signal,
    );
    if (brokerReady !== "broker:READY") throw new Error("Restricted broker unavailable");
    const final = inspectSchema.parse(
      JSON.parse(await this.command(["inspect", fetch], signal)),
    )[0]!;
    const network = z
      .array(z.object({ Internal: z.literal(true) }))
      .length(1)
      .parse(JSON.parse(await this.command(["network", "inspect", name], signal)));
    if (
      !network.length ||
      final.Id !== initial.Id ||
      final.NetworkSettings.SandboxKey !== initial.NetworkSettings.SandboxKey ||
      final.Config.Labels["slop-loop.actionId"] !== actionId ||
      final.Config.Labels["slop-loop.generation"] !== "1"
    )
      throw new Error("Fetch namespace changed");
    signal.throwIfAborted();
    const admission = Object.freeze({
      actionId,
      engineId,
      generation: 1,
      containerId: initial.Id,
      namespaceId: initial.NetworkSettings.SandboxKey,
      brokerAddress: "172.31.253.2:3128" as const,
    });
    observations.add(admission);
    return admission;
  }

  async cleanup(actionId: string): Promise<"CONFIRMED" | "UNCERTAIN"> {
    const engineId = this.engines.get(actionId);
    if (!engineId) return "UNCERTAIN";
    const signal = AbortSignal.timeout(10_000);
    try {
      const current = z
        .object({ ID: z.string() })
        .parse(JSON.parse(await this.command(["info", "--format", "{{json .}}"], signal)));
      if (current.ID !== engineId) return "UNCERTAIN";
      const owned = [...this.resources]
        .filter(([, resource]) => resource.actionId === actionId)
        .reverse();
      for (const [name, resource] of owned) {
        if (resource.kind === "container") {
          const found = (
            await this.command(
              ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `name=^/${name}$`],
              signal,
            )
          ).trim();
          if (!found) return "UNCERTAIN";
          const inspected = z
            .array(
              z.object({
                Id: z.string().min(1),
                Config: z.object({ Labels: z.record(z.string(), z.string()) }),
              }),
            )
            .length(1)
            .parse(JSON.parse(await this.command(["inspect", found], signal)))[0]!;
          if (
            inspected.Id !== found ||
            inspected.Config.Labels["slop-loop.actionId"] !== actionId ||
            inspected.Config.Labels["slop-loop.generation"] !== String(resource.generation ?? 1)
          )
            return "UNCERTAIN";
          await this.command(["rm", "--force", "--", found], signal);
          if (
            (
              await this.command(
                [
                  "container",
                  "ls",
                  "--all",
                  "--quiet",
                  "--no-trunc",
                  "--filter",
                  `name=^/${name}$`,
                ],
                signal,
              )
            ).trim()
          )
            return "UNCERTAIN";
        } else {
          const inspected = z
            .array(z.object({ Id: z.string().min(1), Labels: z.record(z.string(), z.string()) }))
            .length(1)
            .parse(JSON.parse(await this.command(["network", "inspect", name], signal)))[0]!;
          if (
            inspected.Labels["slop-loop.actionId"] !== actionId ||
            inspected.Labels["slop-loop.generation"] !== "1"
          )
            return "UNCERTAIN";
          await this.command(["network", "rm", "--", inspected.Id], signal);
          const remaining = await this.command(
            ["network", "ls", "--quiet", "--no-trunc", "--filter", `id=${inspected.Id}`],
            signal,
          );
          if (remaining.trim()) return "UNCERTAIN";
        }
        this.resources.delete(name);
      }
      this.engines.delete(actionId);
      return "CONFIRMED";
    } catch {
      return "UNCERTAIN";
    }
  }
}
