// Singleton fastembed wrapper. Lazy-init on first use; safe to call from
// concurrent paths (init promise is shared). Embeddings cached by SHA256(text)
// so repeated prompts skip the model entirely.

import { createHash } from 'node:crypto';
import { EmbeddingModel, FlagEmbedding } from 'fastembed';

const EMBED_CACHE_MAX = 256;
const cache = new Map();
let modelPromise = null;

function sha(text) {
  return createHash('sha256').update(text).digest('hex');
}

export async function loadEmbedder({ timeoutMs = 5000 } = {}) {
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    const init = FlagEmbedding.init({
      model: EmbeddingModel.BGESmallEN,
      maxLength: 512,
    });
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('embedder load timeout')), timeoutMs);
    });
    try {
      return await Promise.race([init, timeout]);
    } finally {
      clearTimeout(timer);
    }
  })();
  return modelPromise;
}

export async function embed(text) {
  const key = sha(text);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const model = await loadEmbedder();
  let vec;
  for await (const batch of model.embed([text], 1)) {
    vec = Float32Array.from(batch[0]);
    break;
  }
  if (cache.size >= EMBED_CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, vec);
  return vec;
}

export async function embedAll(texts) {
  const out = new Array(texts.length);
  const todo = [];
  for (let i = 0; i < texts.length; i++) {
    const key = sha(texts[i]);
    const hit = cache.get(key);
    if (hit) out[i] = hit;
    else todo.push({ i, text: texts[i], key });
  }
  if (todo.length) {
    const model = await loadEmbedder();
    let pos = 0;
    for await (const batch of model.embed(todo.map(t => t.text), 32)) {
      for (const raw of batch) {
        const vec = Float32Array.from(raw);
        const { i, key } = todo[pos++];
        out[i] = vec;
        if (cache.size >= EMBED_CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(key, vec);
      }
    }
  }
  return out;
}

export function embedderCacheStats() {
  return { size: cache.size, max: EMBED_CACHE_MAX };
}

export function _resetEmbedderForTests() {
  modelPromise = null;
  cache.clear();
}
