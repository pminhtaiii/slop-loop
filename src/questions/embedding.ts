import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export interface QuestionEmbeddingProfile {
  readonly id: string;
  readonly dimension: number;
  readonly maxTokens: number;
}

export interface QuestionEmbeddingInput {
  readonly kind: 'passage' | 'query';
  readonly text: string;
}

type Failure = { readonly status: 'cancelled' | 'invalid' | 'unavailable' } | { readonly status: 'overflow'; readonly tokens: number };
type Count = Failure | { readonly status: 'ok'; readonly tokens: number };
type Embedding = Failure | { readonly status: 'ok'; readonly tokens: number; readonly vector: readonly number[] };

export interface QuestionEmbeddingPort {
  readonly profile: QuestionEmbeddingProfile;
  count(input: QuestionEmbeddingInput, signal?: AbortSignal): Count;
  embed(input: QuestionEmbeddingInput, signal?: AbortSignal): Promise<Embedding>;
}

function createAdapter<T>(
  profile: QuestionEmbeddingProfile,
  tokenize: (text: string) => { readonly tokens: number; readonly encoded: T },
  infer: (encoded: T) => readonly number[] | Promise<readonly number[]>,
): QuestionEmbeddingPort {
  if (!profile.id || !Number.isSafeInteger(profile.dimension) || profile.dimension < 1 || !Number.isSafeInteger(profile.maxTokens) || profile.maxTokens < 1) {
    throw new TypeError('Invalid embedding profile');
  }
  const pinned = Object.freeze({ ...profile });
  type Prepared = Failure | { readonly status: 'ok'; readonly tokens: number; readonly encoded: T };
  function prepare(input: QuestionEmbeddingInput, signal?: AbortSignal): Prepared {
    if (signal?.aborted) return { status: 'cancelled' };
    if (!input || (input.kind !== 'query' && input.kind !== 'passage') || typeof input.text !== 'string' || !input.text.isWellFormed() || !input.text.trim()) return { status: 'invalid' };
    try {
      const { tokens, encoded } = tokenize(`${input.kind}: ${input.text}`);
      if (signal?.aborted) return { status: 'cancelled' };
      if (!Number.isSafeInteger(tokens) || tokens < 1) return { status: 'invalid' };
      if (tokens > pinned.maxTokens) return { status: 'overflow', tokens };
      return { status: 'ok', tokens, encoded };
    } catch {
      return { status: signal?.aborted ? 'cancelled' : 'unavailable' };
    }
  }
  return Object.freeze({
    profile: pinned,
    count(input: QuestionEmbeddingInput, signal?: AbortSignal): Count {
      const result = prepare(input, signal);
      return result.status === 'ok' ? { status: 'ok', tokens: result.tokens } : result;
    },
    async embed(input: QuestionEmbeddingInput, signal?: AbortSignal): Promise<Embedding> {
      const result = prepare(input, signal);
      if (result.status !== 'ok') return result;
      try {
        const raw = await infer(result.encoded);
        if (signal?.aborted) return { status: 'cancelled' };
        if (raw.length !== pinned.dimension || Array.from(raw).some(value => !Number.isFinite(value))) {
          return { status: 'invalid' };
        }
        const scale = raw.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
        if (scale === 0) return { status: 'invalid' };
        const scaled = raw.map(value => value / scale);
        const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0));
        return { status: 'ok', tokens: result.tokens, vector: Object.freeze(scaled.map(value => value / norm)) };
      } catch {
        return { status: signal?.aborted ? 'cancelled' : 'unavailable' };
      }
    },
  });
}

export function createControlledQuestionEmbedding(
  profile: QuestionEmbeddingProfile,
  tokenize: (input: string) => readonly number[],
  infer: (tokens: readonly number[]) => readonly number[] | Promise<readonly number[]>,
): QuestionEmbeddingPort {
  return createAdapter(
    profile,
    input => {
      const encoded = tokenize(input);
      if (Array.from(encoded).some(id => !Number.isSafeInteger(id) || id < 0)) {
        return { tokens: 0, encoded };
      }
      return { tokens: encoded.length, encoded };
    },
    infer,
  );
}

async function readArtifact(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 1 || size > maxBytes) throw new RangeError('Invalid embedding artifact size');
    const bytes = Buffer.alloc(size);
    const result = await handle.read({ buffer: bytes, position: 0 });
    if (result.bytesRead !== size) throw new Error('Incomplete embedding artifact');
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * The host provisions the XLM-R tokenizer and self-contained E5 q8 model outside target roots.
 * The pin is SHA-256 over the concatenated binary SHA-256 digests of tokenizer.json,
 * tokenizer_config.json and onnx/model_quantized.onnx, in that order.
 */
export async function loadLocalQuestionEmbedding(directory: string, artifactDigest: string): Promise<QuestionEmbeddingPort> {
  if (!isAbsolute(directory) || !/^[0-9a-f]{64}$/.test(artifactDigest)) {
    throw new TypeError('Local embedding requires a host artifact directory and digest');
  }
  const tokenizerJson = await readArtifact(join(directory, 'tokenizer.json'), 32 * 1024 * 1024);
  const tokenizerConfig = await readArtifact(join(directory, 'tokenizer_config.json'), 1024 * 1024);
  const weights = await readArtifact(join(directory, 'onnx', 'model_quantized.onnx'), 256 * 1024 * 1024);
  const digest = createHash('sha256');
  for (const bytes of [tokenizerJson, tokenizerConfig, weights]) {
    digest.update(createHash('sha256').update(bytes).digest());
  }
  if (digest.digest('hex') !== artifactDigest) throw new Error('Embedding artifact pin mismatch');
  const { XLMRobertaTokenizer, Tensor, mean_pooling } = await import('@huggingface/transformers');
  const { InferenceSession } = await import('onnxruntime-node');
  const tokenizer = new XLMRobertaTokenizer(JSON.parse(tokenizerJson.toString('utf8')), JSON.parse(tokenizerConfig.toString('utf8')));
  const model = await InferenceSession.create(weights, { executionProviders: ['cpu'] });
  return createAdapter(
    { id: `multilingual-e5-small/q8/mean-pooling/1:${artifactDigest}`, maxTokens: 512, dimension: 384 },
    text => {
      const encoded = tokenizer(text, { add_special_tokens: true, truncation: false, padding: false });
      return { tokens: encoded.input_ids.size, encoded };
    },
    async encoded => {
      const output = await model.run({ input_ids: encoded.input_ids.ort_tensor, attention_mask: encoded.attention_mask.ort_tensor });
      const hidden = output['last_hidden_state'];
      if (hidden?.type !== 'float32' || hidden.dims.length !== 3 || hidden.dims[0] !== 1 || hidden.dims[1] !== encoded.input_ids.size || hidden.dims[2] !== 384) return [];
      const pooled = mean_pooling(new Tensor(hidden), encoded.attention_mask);
      return Array.from(pooled.data as Float32Array);
    },
  );
}
