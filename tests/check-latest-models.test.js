// Unit tests for the version-family parsers and computeProposals() in
// scripts/check-latest-models.js. Verifies:
//   - Each parser correctly extracts (family, version, suffix) from real
//     OpenRouter model IDs including the v4-flash/v4-pro tier separation.
//   - Parsers reject unrelated IDs (returning null) so cross-family bumps
//     can't sneak through.
//   - computeProposals selects the highest in-family version when the
//     registry is stale, and emits no proposal when already current.
//
// Run with: node tests/check-latest-models.test.js
// Exits non-zero on any assertion failure.

import {
  parseDeepseekOR, parseQwenOR, parseGlmOR, parseMinimaxOR,
  computeProposals,
} from '../scripts/check-latest-models.js';

let failures = 0;
function check(label, ok, detail) {
  const tag = ok ? '✓' : '✗';
  console.log(`${tag} ${label}${ok ? '' : ` -- ${detail}`}`);
  if (!ok) failures++;
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// --- DeepSeek parser ---
check(
  "parseDeepseekOR('deepseek/deepseek-v4-pro')",
  eq(parseDeepseekOR('deepseek/deepseek-v4-pro'), { family: 'deepseek', version: 4, suffix: 'pro' }),
  JSON.stringify(parseDeepseekOR('deepseek/deepseek-v4-pro')),
);
check(
  "parseDeepseekOR('deepseek/deepseek-v4-flash')",
  eq(parseDeepseekOR('deepseek/deepseek-v4-flash'), { family: 'deepseek', version: 4, suffix: 'flash' }),
  JSON.stringify(parseDeepseekOR('deepseek/deepseek-v4-flash')),
);
check(
  "parseDeepseekOR('deepseek/deepseek-v3.2')",
  eq(parseDeepseekOR('deepseek/deepseek-v3.2'), { family: 'deepseek', version: 3.2, suffix: '' }),
  JSON.stringify(parseDeepseekOR('deepseek/deepseek-v3.2')),
);
check(
  "parseDeepseekOR rejects qwen IDs",
  parseDeepseekOR('qwen/qwen3.6-plus') === null,
);

// --- Qwen parser ---
check(
  "parseQwenOR('qwen/qwen3.6-max-preview')",
  parseQwenOR('qwen/qwen3.6-max-preview')?.version === 3.6,
);
check(
  "parseQwenOR rejects deepseek IDs",
  parseQwenOR('deepseek/deepseek-v4-pro') === null,
);

// --- GLM parser ---
check(
  "parseGlmOR('z-ai/glm-5.1')",
  eq(parseGlmOR('z-ai/glm-5.1'), { family: 'glm', version: 5.1, suffix: '' }),
  JSON.stringify(parseGlmOR('z-ai/glm-5.1')),
);
check(
  "parseGlmOR('z-ai/glm-5-turbo')",
  eq(parseGlmOR('z-ai/glm-5-turbo'), { family: 'glm', version: 5, suffix: 'turbo' }),
  JSON.stringify(parseGlmOR('z-ai/glm-5-turbo')),
);

// --- Minimax parser ---
check(
  "parseMinimaxOR('minimax/minimax-m2.7')",
  eq(parseMinimaxOR('minimax/minimax-m2.7'), { family: 'minimax', version: 2.7, suffix: '' }),
  JSON.stringify(parseMinimaxOR('minimax/minimax-m2.7')),
);

// --- computeProposals ---

// Synthetic catalog: stale dicts vs. a fresh catalog should propose bumps.
const staleDicts = {
  OPENROUTER_MODELS: {
    deepseek: 'deepseek/deepseek-v3.5-flash',            // stale flash tier
    'deepseek-coder': 'deepseek/deepseek-v3.5-pro',      // stale pro tier
    qwen: 'qwen/qwen3.6-plus',
    glm: 'z-ai/glm-5-turbo',
    minimax: 'minimax/minimax-m2.7',
  },
  REQUESTY_MODELS: {}, COPILOT_MODELS: {}, DIRECT_MODELS: {},
};
const catalog = [
  { id: 'deepseek/deepseek-v3.5-flash', pricing: { completion: '0.0000020' }, context_length: 128000 },
  { id: 'deepseek/deepseek-v4-flash',   pricing: { completion: '0.0000020' }, context_length: 128000 },
  { id: 'deepseek/deepseek-v3.5-pro',   pricing: { completion: '0.0000040' }, context_length: 128000 },
  { id: 'deepseek/deepseek-v4-pro',     pricing: { completion: '0.0000060' }, context_length: 128000 },
  { id: 'qwen/qwen3.6-plus',            pricing: { completion: '0.0000010' }, context_length: 32000 },
  { id: 'z-ai/glm-5-turbo',             pricing: { completion: '0.0000010' }, context_length: 128000 },
  { id: 'z-ai/glm-5.1-turbo',           pricing: { completion: '0.0000015' }, context_length: 200000 },
  { id: 'minimax/minimax-m2.7',         pricing: { completion: '0.0000010' }, context_length: 32000 },
];

const proposals = computeProposals(staleDicts, catalog);
const byKey = Object.fromEntries(proposals.map((p) => [p.modelKey, p]));

check(
  "computeProposals bumps deepseek flash tier within suffix",
  byKey.deepseek?.newId === 'deepseek/deepseek-v4-flash',
  `got ${byKey.deepseek?.newId}`,
);

check(
  "computeProposals bumps deepseek-coder within 'pro' suffix",
  byKey['deepseek-coder']?.newId === 'deepseek/deepseek-v4-pro',
  `got ${byKey['deepseek-coder']?.newId}`,
);

check(
  "computeProposals bumps glm within 'turbo' suffix to v5.1-turbo",
  byKey.glm?.newId === 'z-ai/glm-5.1-turbo',
  `got ${byKey.glm?.newId}`,
);

check(
  "computeProposals emits no proposal for already-current minimax",
  byKey.minimax === undefined,
  `got ${JSON.stringify(byKey.minimax)}`,
);

check(
  "computeProposals emits no proposal when catalog has no fresher version (qwen)",
  byKey.qwen === undefined,
  `got ${JSON.stringify(byKey.qwen)}`,
);

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll updater tests passed.');
