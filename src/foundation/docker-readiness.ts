/**
 * T060 operational preflight (real-tier contract §(i)). A trusted host-controller observation, not an
 * agent tool: two fixed argv commands through `structuredSpawn`, no shell, minimal environment, bounded
 * time and output. No value here comes from a model, a task or argv, and it reads no repository content.
 */
import type { StructuredSpawn } from './docker-controller.ts';

export type DockerReadiness = Readonly<{ ok: true; dockerServerVersion: string; imageId: string }> | Readonly<{ ok: false; reasonCode: 'docker-unavailable' | 'image-mismatch' }>;

/** 10 s and 4 KiB per command, as the contract fixes them. */
export const DOCKER_READINESS_OPTIONS = Object.freeze({ timeoutMs: 10_000, maxOutputBytes: 4 * 1024 });

const VERSION_ARGS = ['version', '--format', '{{.Server.Version}}'] as const;
const INSPECT_ARGS = ['image', 'inspect', '--format', '{{.Id}}'] as const;

const UNAVAILABLE: DockerReadiness = Object.freeze({ ok: false, reasonCode: 'docker-unavailable' });
const MISMATCH: DockerReadiness = Object.freeze({ ok: false, reasonCode: 'image-mismatch' });

/** A daemon that is down refuses the version query; a missing or drifted image refuses the inspect. */
export async function observeDockerReadiness(spawn: StructuredSpawn, imageId: string): Promise<DockerReadiness> {
  // A spawn rejection means the client could not start, which is the same "no daemon" refusal.
  const version = await spawn('docker', VERSION_ARGS, DOCKER_READINESS_OPTIONS).catch(() => undefined);
  if (version === undefined || version.exitCode !== 0 || version.timedOut) return UNAVAILABLE;
  const dockerServerVersion = version.stdout.trim();
  if (dockerServerVersion === '') return UNAVAILABLE;

  const image = await spawn('docker', [...INSPECT_ARGS, imageId], DOCKER_READINESS_OPTIONS).catch(() => undefined);
  if (image === undefined || image.exitCode !== 0 || image.timedOut) return MISMATCH;
  return image.stdout.trim() === imageId ? { ok: true, dockerServerVersion, imageId } : MISMATCH;
}
