/** Controlled Docker volume substrate; never starts a process. */
import type { StructuredSpawn, StructuredSpawnOptions } from '../../../src/foundation/docker-controller.ts';
import { computeFileDigest } from '../../../src/foundation/docker-workspace-policy.ts';

export function createVolumeSpawn(): {
  readonly spawn: StructuredSpawn;
  readonly volumes: Map<string, Map<string, Buffer>>;
  readonly calls: { readonly args: readonly string[]; readonly options: StructuredSpawnOptions }[];
} {
  const volumes = new Map<string, Map<string, Buffer>>();
  const calls: { readonly args: readonly string[]; readonly options: StructuredSpawnOptions }[] = [];
  const spawn: StructuredSpawn = async (_command, args, options) => {
    calls.push({ args, options });
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
    const volumeId = args[2] ?? '';
    if (args[0] === 'volume') {
      if (args[1] === 'create') volumes.set(volumeId, new Map());
      if (args[1] === 'rm') volumes.delete(volumeId);
      if (args[1] === 'inspect' && !volumes.has(volumeId)) return { ...ok(), exitCode: 1 };
      return ok();
    }
    if (args[0] !== 'run') return ok();
    const mount = args.find(arg => arg.startsWith('--mount=') && arg.includes('target=/workspace/repo'));
    const source = mount?.match(/source=([^,]+)/u)?.[1];
    const volume = source === undefined ? undefined : volumes.get(source);
    if (!volume) throw new Error('controlled volume missing');
    const script = args.at(-1) ?? '';
    if (options.stdin !== undefined) {
      const payload = JSON.parse(options.stdin) as { files: { path: string; b64: string }[] };
      if (script.includes('wanted=')) volume.clear();
      for (const item of payload.files) volume.set(item.path, Buffer.from(item.b64, 'base64'));
      if (script.includes('wanted=')) return ok(JSON.stringify({ entries: [...volume].map(([path, content]) => ({ path, digest: computeFileDigest(content) })) }));
      return ok(JSON.stringify({ written: payload.files.length }));
    }
    return ok(JSON.stringify({ entries: [...volume].map(([path, content]) => ({ path, content: content.toString('base64') })) }));
  };
  return { spawn, volumes, calls };
}
