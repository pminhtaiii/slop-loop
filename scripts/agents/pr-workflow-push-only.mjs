const requiredLocalGates = ['context', 'runtime', 'dependencies', 'tests'];

export function publicationMode(values) {
  const mode = values.mode ?? 'full';
  if (!['full', 'push-only'].includes(mode)) throw new Error('Publish --mode must be full or push-only.');
  if (mode === 'push-only' && (!values.reason?.trim() || values.reason.length > 2000)) throw new Error('Push-only publication requires a non-empty --reason of at most 2000 characters.');
  if (mode === 'full' && values.reason !== undefined) throw new Error('--reason is only valid with --mode push-only.');
  return { mode, reason: mode === 'push-only' ? values.reason.trim() : undefined };
}

export function localVerifiedHead(record) {
  return record.localVerifiedHead ?? record.localVerification?.head;
}

export function hasLocalVerification(record, head) {
  return localVerifiedHead(record) === head && requiredLocalGates.every(gate => typeof record.localVerification?.[gate] === 'string' && record.localVerification[gate].trim());
}

export function localGateStatus(record, head) {
  if (hasLocalVerification(record, head)) return 'passed';
  if (record.publicationMode === 'push-only' && typeof head === 'string' && record.publishedHead === head) return 'skipped';
  return 'not-verified';
}
