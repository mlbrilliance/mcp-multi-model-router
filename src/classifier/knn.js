// kNN intent + complexity classifier over pre-computed exemplar embeddings.
// Cosine similarity against the EXEMPLARS table; top-k weighted vote.

import { EXEMPLARS, exemplarStats } from './exemplars.js';
import { embed, embedAll, loadEmbedder } from './embedder.js';

const TOP_K = 5;
const CONFIDENCE_FLOOR = 0.45;
const CONFIDENCE_CONFIDENT = 0.65;

let exemplarVecs = null;
let primePromise = null;

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export async function primeExemplars() {
  if (exemplarVecs) return exemplarVecs;
  if (primePromise) return primePromise;
  primePromise = (async () => {
    await loadEmbedder();
    exemplarVecs = await embedAll(EXEMPLARS.map(e => e.prompt));
    return exemplarVecs;
  })();
  return primePromise;
}

function topK(prompt_vec, k) {
  const sims = new Array(EXEMPLARS.length);
  for (let i = 0; i < EXEMPLARS.length; i++) {
    sims[i] = { i, sim: cosine(prompt_vec, exemplarVecs[i]) };
  }
  sims.sort((a, b) => b.sim - a.sim);
  return sims.slice(0, k);
}

// Weighted vote across top-k matches. Returns the dominant intent and a
// confidence score = (sum of similarities for the winning intent) / (sum of all top-k similarities).
export async function classifyByEmbedding(description) {
  if (!exemplarVecs) await primeExemplars();
  const vec = await embed(description);
  const top = topK(vec, TOP_K);

  const totals = {};
  for (const { i, sim } of top) {
    const e = EXEMPLARS[i];
    if (!totals[e.intent]) totals[e.intent] = { weight: 0, taskType: e.taskType, agent: e.agent, members: [] };
    totals[e.intent].weight += sim;
    totals[e.intent].members.push({ i, sim, complexity: e.complexity });
  }

  let winner = null, winnerWeight = -1;
  let totalWeight = 0;
  for (const [intent, t] of Object.entries(totals)) {
    totalWeight += t.weight;
    if (t.weight > winnerWeight) { winner = intent; winnerWeight = t.weight; }
  }

  const confidence = totalWeight > 0 ? winnerWeight / totalWeight : 0;
  const w = totals[winner];

  return {
    intent: winner,
    taskType: w.taskType,
    agent: w.agent,
    confidence,
    topSim: top[0].sim,
    members: w.members,
    floor: CONFIDENCE_FLOOR,
    confident: CONFIDENCE_CONFIDENT,
  };
}

// kNN-derived complexity: weighted mean of nearest exemplars' labeled scores.
// Uses all top-k regardless of intent — complexity is orthogonal to intent.
export async function knnComplexity(description) {
  if (!exemplarVecs) await primeExemplars();
  const vec = await embed(description);
  const top = topK(vec, TOP_K);
  let num = 0, den = 0;
  for (const { i, sim } of top) {
    const w = Math.max(0, sim);
    num += w * EXEMPLARS[i].complexity;
    den += w;
  }
  return den > 0 ? num / den : 5;
}

export function classifierStats() {
  return {
    primed: !!exemplarVecs,
    exemplars: exemplarStats(),
    topK: TOP_K,
    floor: CONFIDENCE_FLOOR,
    confident: CONFIDENCE_CONFIDENT,
  };
}
