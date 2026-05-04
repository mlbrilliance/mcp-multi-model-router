// Verifies the DeepSeek v4-pro coding fallback rung is wired into:
//   1. lib/models-dicts.js — both OPENROUTER_MODELS and REQUESTY_MODELS expose
//      'deepseek-coder' pointing at v4-pro variants.
//   2. index.js — ESCALATION_LADDER inserts 'deepseek-coder' between codex/glm
//      and the further escalation rungs, and callProvider routes the key.
//
// Run with: node tests/escalation.test.js
// Exits non-zero on any assertion failure.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  OPENROUTER_MODELS, REQUESTY_MODELS,
} from '../lib/models-dicts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_FILE = path.join(HERE, '..', 'index.js');

let failures = 0;
function check(label, ok, detail) {
  const tag = ok ? '✓' : '✗';
  console.log(`${tag} ${label}${ok ? '' : ` -- ${detail}`}`);
  if (!ok) failures++;
}

// 1. Dict registrations
check(
  "OPENROUTER_MODELS['deepseek-coder'] points to deepseek/deepseek-v4-pro",
  OPENROUTER_MODELS['deepseek-coder'] === 'deepseek/deepseek-v4-pro',
  `got ${OPENROUTER_MODELS['deepseek-coder']}`,
);

check(
  "REQUESTY_MODELS['deepseek-coder'] points to fireworks/deepseek-v4-pro",
  REQUESTY_MODELS['deepseek-coder'] === 'fireworks/deepseek-v4-pro',
  `got ${REQUESTY_MODELS['deepseek-coder']}`,
);

check(
  "OPENROUTER_MODELS.deepseek (script tier) is the v4-flash variant",
  OPENROUTER_MODELS.deepseek === 'deepseek/deepseek-v4-flash',
  `got ${OPENROUTER_MODELS.deepseek}`,
);

// 2. Escalation ladder structure (read source, extract literal, evaluate)
const indexSrc = fs.readFileSync(INDEX_FILE, 'utf8');
const ladderMatch = indexSrc.match(/const ESCALATION_LADDER = (\{[\s\S]*?\});/);
check('ESCALATION_LADDER literal found in index.js', !!ladderMatch, 'regex did not match');

let ladder = null;
if (ladderMatch) {
  // Safe eval: ladder is a JSON-shaped object literal with string-array values.
  ladder = (new Function(`return (${ladderMatch[1]});`))();
}

if (ladder) {
  check(
    "ladder['codex'] places 'deepseek-coder' as second rung (after glm-direct)",
    Array.isArray(ladder.codex) && ladder.codex[0] === 'glm-direct' && ladder.codex[1] === 'deepseek-coder',
    `got ${JSON.stringify(ladder.codex)}`,
  );

  check(
    "ladder['glm-direct'] places 'deepseek-coder' as the first escalation rung",
    Array.isArray(ladder['glm-direct']) && ladder['glm-direct'][0] === 'deepseek-coder',
    `got ${JSON.stringify(ladder['glm-direct'])}`,
  );

  check(
    "ladder['deepseek-coder'] exists and starts with glm-direct",
    Array.isArray(ladder['deepseek-coder']) && ladder['deepseek-coder'][0] === 'glm-direct',
    `got ${JSON.stringify(ladder['deepseek-coder'])}`,
  );
}

// 3. callProvider switch handles 'deepseek-coder'
check(
  "callProvider switch has a 'deepseek-coder' case calling callOpenRouterWithFallback('deepseek-coder', ...)",
  /case 'deepseek-coder':\s*return await callOpenRouterWithFallback\('deepseek-coder'/.test(indexSrc),
  'pattern not found in index.js',
);

// 4. consult_openrouter tool exposes 'deepseek-coder' in its enum
check(
  "consult_openrouter enum includes 'deepseek-coder'",
  /enum:\s*\[\s*"deepseek",\s*"deepseek-coder"/.test(indexSrc),
  'enum pattern not found in index.js',
);

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll escalation tests passed.');
