// Minimal regression tests for the embedding-kNN classifier.
// Run with: node tests/classifier.test.js
// Exits non-zero if accuracy or latency targets regress.

import { classifyByEmbedding, primeExemplars, knnComplexity } from '../src/classifier/knn.js';

const PARAPHRASE_CASES = [
  { prompt: 'add unit tests for the parser', expect: 'write-tests' },
  { prompt: 'cover the auth flow with tests', expect: 'write-tests' },
  { prompt: 'write a regression test for this bug', expect: 'write-tests' },
  { prompt: 'fix the bug in checkout', expect: 'fix-bug' },
  { prompt: 'look for a regression in this commit', expect: 'fix-bug' },
  { prompt: 'why is the api returning 500', expect: 'fix-bug' },
  { prompt: 'investigate the flaky integration test', expect: 'fix-bug' },
  { prompt: 'security audit of the auth middleware', expect: 'security-review' },
  { prompt: 'check this query for sql injection', expect: 'security-review' },
  { prompt: 'review my changes to the payment processor', expect: 'code-review' },
  { prompt: 'second opinion on this refactor', expect: 'code-review' },
  { prompt: 'design the schema for the new events table', expect: 'architecture' },
  { prompt: 'lay out service boundaries for this domain', expect: 'architecture' },
  { prompt: 'profile the slow request handler', expect: 'performance' },
  { prompt: 'reduce p99 latency on search', expect: 'performance' },
  { prompt: 'investigate the memory leak in workers', expect: 'performance' },
  { prompt: 'evaluate which message queue suits our workload', expect: 'research' },
  { prompt: 'compare postgres and clickhouse for analytics', expect: 'research' },
  { prompt: 'restructure this module to separate concerns', expect: 'refactor' },
  { prompt: 'simplify the nested conditionals', expect: 'refactor' },
  { prompt: 'add jsdoc comments to the public api', expect: 'write-docs' },
  { prompt: 'write a readme for this package', expect: 'write-docs' },
  { prompt: 'bash script to rotate logs nightly', expect: 'bash-script' },
  { prompt: 'cron job to clean tmp files', expect: 'bash-script' },
  { prompt: 'design the rest api for billing', expect: 'api-design' },
  { prompt: 'graphql schema for the activity feed', expect: 'api-design' },
  { prompt: 'implement the password reset flow', expect: 'implement-feature' },
  { prompt: 'add a dark mode toggle', expect: 'implement-feature' },
];

const LOW_CONFIDENCE_CASES = [
  'help me with this thing',
  'do the thing',
  'asdfasdf',
];

// Phase 1 target. The minimal hand-bootstrap (~70 exemplars) is
// intentionally lean — Phase 3 traces will lift this. Literature (LLMRouterBench,
// ClawRouter) suggests 70-80% is the realistic intent-accuracy band before
// distillation/online-learning kicks in.
const ACCURACY_TARGET = 0.7;
const WARM_P95_BUDGET_MS = 500; // generous for sandbox; tighten on real hardware

function fail(msg) { console.error('FAIL:', msg); process.exit(1); }

async function main() {
  console.log('Priming exemplars...');
  const t0 = performance.now();
  await primeExemplars();
  console.log(`Primed in ${(performance.now() - t0).toFixed(0)}ms`);

  // Accuracy: did the kNN pick the correct intent? (Confidence-gating is a
  // separate concern — Phase 2 will tune the floor with real disagreement data.)
  let correct = 0;
  let aboveFloor = 0;
  const misses = [];
  for (const c of PARAPHRASE_CASES) {
    const r = await classifyByEmbedding(c.prompt);
    const intentOk = r.intent === c.expect;
    if (intentOk) correct++;
    if (intentOk && r.confidence >= r.floor) aboveFloor++;
    if (!intentOk) misses.push({ prompt: c.prompt, expected: c.expect, got: r.intent, conf: Number(r.confidence.toFixed(3)), topSim: Number(r.topSim.toFixed(3)) });
  }
  const acc = correct / PARAPHRASE_CASES.length;
  const gatedAcc = aboveFloor / PARAPHRASE_CASES.length;
  console.log(`Intent accuracy: ${correct}/${PARAPHRASE_CASES.length} = ${(acc * 100).toFixed(0)}%`);
  console.log(`  ...above floor (≥${PARAPHRASE_CASES.length ? 'floor' : ''}): ${aboveFloor}/${PARAPHRASE_CASES.length} = ${(gatedAcc * 100).toFixed(0)}%`);
  if (misses.length) {
    console.log('Wrong intent:');
    for (const m of misses) console.log(`  - "${m.prompt}" → ${m.got} (expected ${m.expected}, conf=${m.conf}, topSim=${m.topSim})`);
  }
  if (acc < ACCURACY_TARGET) fail(`intent accuracy ${acc.toFixed(2)} < target ${ACCURACY_TARGET}`);

  // Low-confidence behaviour: ambiguous prompts should land below the floor
  // OR at least be unambiguous about *not* matching a confident specialist.
  for (const p of LOW_CONFIDENCE_CASES) {
    const r = await classifyByEmbedding(p);
    console.log(`  ambiguous "${p}" → ${r.intent} (conf=${r.confidence.toFixed(3)})`);
    if (r.confidence >= r.confident) {
      console.warn(`  WARN: ambiguous prompt got high-confidence routing`);
    }
  }

  // Warm latency (p95)
  const samples = [];
  for (let i = 0; i < 30; i++) {
    const s = performance.now();
    await classifyByEmbedding(`refactor the auth middleware in module ${i}`);
    samples.push(performance.now() - s);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  console.log(`Warm p95: ${p95.toFixed(1)}ms (budget ${WARM_P95_BUDGET_MS}ms)`);
  if (p95 > WARM_P95_BUDGET_MS) fail(`p95 ${p95.toFixed(0)}ms > budget ${WARM_P95_BUDGET_MS}ms`);

  // Complexity sanity
  const cTrivial = await knnComplexity('add jsdoc comments to the public api');
  const cBig = await knnComplexity('architect a system to handle 10x the current traffic');
  console.log(`Complexity: trivial=${cTrivial.toFixed(1)}, big=${cBig.toFixed(1)}`);
  if (cTrivial >= cBig) fail(`complexity ordering wrong: ${cTrivial} >= ${cBig}`);

  console.log('\nAll checks passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
