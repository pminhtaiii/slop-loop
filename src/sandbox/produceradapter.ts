import { spawn } from "node:child_process";
import { z } from "zod";
import { allowlistedDockerEnv } from "./dockerprocess.js";
import {
  isFetchAdmission,
  localPreparationDockerCommand,
  type FetchAdmission,
  type PreparationDockerCommand,
} from "./preparationnetwork.js";
import type { PreparationProducer, ProducerTransferPort } from "./frozentransfer.js";
import { PassThrough, type Readable } from "node:stream";
import { createPreparationDockerCli } from "./preparationcli.js";

const quiescence = `const fs=require('node:fs');
const deadline=Date.now()+5000;
function foreign(){return fs.readdirSync('/proc').filter(s=>/^\\d+$/.test(s)).map(Number).filter(n=>n!==1&&n!==process.pid).filter(n=>{try{return !/^State:\\s+Z/m.test(fs.readFileSync('/proc/'+n+'/status','utf8'));}catch{return false;}});}
(async()=>{for(;;){const pids=foreign();if(!pids.length)break;for(const pid of pids){try{process.kill(pid,'SIGKILL');}catch{}}if(Date.now()>=deadline)throw Error('producer children remain');await new Promise(r=>setTimeout(r,10));}process.stdout.write('producer-quiescent');})().catch(()=>process.exit(1));`;

const containerSchema = z
  .array(
    z.object({
      Id: z.string().min(1),
      State: z.object({ Running: z.boolean(), Paused: z.boolean() }),
      Config: z.object({ Labels: z.record(z.string(), z.string()) }),
    }),
  )
  .length(1);

/** Concrete owned producer operations. Registration requires a locally issued namespace admission. */
export class DockerProducerTransfer implements ProducerTransferPort {
  constructor(
    private readonly command: PreparationDockerCommand = localPreparationDockerCommand,
    private readonly exported?: (
      producer: PreparationProducer,
      signal: AbortSignal,
    ) => Promise<Readable>,
  ) {}
  private readonly owned = new Map<string, { identity: PreparationProducer; quiescent: boolean }>();

  register(admission: FetchAdmission): PreparationProducer {
    if (!isFetchAdmission(admission)) throw new Error("Unowned preparation producer");
    if (this.owned.has(admission.containerId))
      throw new Error("Preparation producer already registered");
    const identity = Object.freeze({
      actionId: admission.actionId,
      resourceId: admission.containerId,
      generation: admission.generation,
      engineId: admission.engineId,
    });
    this.owned.set(identity.resourceId, { identity, quiescent: false });
    return identity;
  }

  private requireOwned(producer: PreparationProducer) {
    const owned = this.owned.get(producer.resourceId);
    if (
      !owned ||
      owned.identity.actionId !== producer.actionId ||
      owned.identity.generation !== producer.generation ||
      owned.identity.engineId !== producer.engineId
    )
      throw new Error("Unowned preparation producer");
    return owned;
  }

  private async observe(producer: PreparationProducer, signal: AbortSignal) {
    this.requireOwned(producer);
    const engine = z
      .object({ ID: z.string() })
      .parse(JSON.parse(await this.command(["info", "--format", "{{json .}}"], signal)));
    if (engine.ID !== producer.engineId) throw new Error("Preparation engine changed");
    const container = containerSchema.parse(
      JSON.parse(await this.command(["inspect", producer.resourceId], signal)),
    )[0]!;
    if (
      container.Id !== producer.resourceId ||
      !container.State.Running ||
      container.Config.Labels["slop-loop.actionId"] !== producer.actionId ||
      container.Config.Labels["slop-loop.generation"] !== String(producer.generation)
    )
      throw new Error("Preparation producer changed");
    return container;
  }

  async quiesce(producer: PreparationProducer, signal: AbortSignal): Promise<void> {
    const owned = this.requireOwned(producer);
    const observed = await this.observe(producer, signal);
    if (observed.State.Paused) throw new Error("Producer already frozen");
    const result = await this.command(
      ["exec", producer.resourceId, "node", "-e", quiescence],
      signal,
    );
    if (result !== "producer-quiescent") throw new Error("Producer quiescence unavailable");
    owned.quiescent = true;
  }

  async pause(producer: PreparationProducer, signal: AbortSignal): Promise<void> {
    const owned = this.requireOwned(producer);
    if (!owned.quiescent) throw new Error("Producer quiescence unavailable");
    await this.observe(producer, signal);
    await this.command(["pause", producer.resourceId], signal);
    if (!(await this.observe(producer, signal)).State.Paused)
      throw new Error("Producer freeze unavailable");
  }

  async inspect(producer: PreparationProducer, signal: AbortSignal): Promise<unknown> {
    const owned = this.requireOwned(producer);
    const observed = await this.observe(producer, signal);
    return { ...owned.identity, paused: observed.State.Paused, quiescent: owned.quiescent };
  }

  async export(producer: PreparationProducer, signal: AbortSignal): Promise<Readable> {
    const owned = this.requireOwned(producer);
    const observed = await this.observe(producer, signal);
    if (!owned.quiescent || !observed.State.Paused) throw new Error("Producer freeze unavailable");
    signal.throwIfAborted();
    if (this.exported) return await this.exported(producer, signal);
    const cli = createPreparationDockerCli();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        "docker",
        [...cli.prefix, "cp", `${producer.resourceId}:/preparation/node_modules`, "-"],
        {
          shell: false,
          env: allowlistedDockerEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          signal,
        },
      );
    } catch (error) {
      cli.dispose();
      throw error;
    }
    const accepted = new PassThrough();
    child.stdout!.pipe(accepted, { end: false });
    let bytes = 0,
      output = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 ** 3) {
        accepted.destroy(new Error("Preparation export limit exceeded"));
        child.kill("SIGKILL");
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      output += chunk.length;
      if (output > 1024 * 1024) {
        accepted.destroy(new Error("Preparation output limit exceeded"));
        child.kill("SIGKILL");
      }
    });
    child.once("error", (error) => accepted.destroy(error));
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        cli.dispose();
      } catch {
        accepted.destroy(new Error("Preparation CLI cleanup unconfirmed"));
        return;
      }
      if (code !== 0 || signal.aborted) accepted.destroy(new Error("Preparation export failed"));
      else accepted.end();
    });
    accepted.once("close", () => child.kill("SIGKILL"));
    return accepted;
  }
}
