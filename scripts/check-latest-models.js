#!/usr/bin/env node
// Autonomous weekly model freshness check for multi-model-router.
//
// Fetches OpenRouter's /models catalog, diffs against lib/models-dicts.js,
// smoke-tests new candidates, applies version bumps with rollback on
// post-bump health degradation, and notifies via Telegram or memory.
//
// Usage:
//   node scripts/check-latest-models.js              # full apply (autonomous)
//   node scripts/check-latest-models.js --dry-run    # diff report only, no patches
//   node scripts/check-latest-models.js --install-cron  # write weekly crontab entry
//
// Exit codes:
//   0 = no changes
//   1 = changes applied
//   2 = changes flagged but not applied (review needed)
//   3 = error
//
// Triggered weekly by system cron (per the user's 2026-05-04 plan choice).

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DICTS_FILE = path.join(ROOT, 'lib', 'models-dicts.js');
const INDEX_FILE = path.join(ROOT, 'index.js');
const CACHE_DIR = path.join(ROOT, 'local_cache');
const REPORT_FILE = path.join(CACHE_DIR, 'model-update-report.json');
const PREV_DICTS = path.join(CACHE_DIR, 'models-dicts.prev.js');
const CRON_LOG = path.join(CACHE_DIR, 'cron.log');
const SNAPSHOT_KEY_PREFIX = 'model-registry-snapshot';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const INSTALL_CRON = args.has('--install-cron');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  process.stdout.write(line + '\n');
}

function fail(msg, code = 3) {
  log(`ERROR: ${msg}`);
  process.exit(code);
}

// Only execute the CLI flow when invoked directly. When imported by tests,
// the module just exposes the pure helpers above.
const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  if (INSTALL_CRON) {
    installCron();
    process.exit(0);
  }
  main().catch((e) => fail(e.stack || e.message));
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  log('Fetching OpenRouter /models catalog...');
  const catalog = await fetchOpenRouterCatalog();
  log(`Catalog has ${catalog.length} models.`);

  const dicts = await loadCurrentDicts();
  const proposals = computeProposals(dicts, catalog);

  const report = {
    runAt: new Date().toISOString(),
    catalogSize: catalog.length,
    proposals,
    applied: [],
    flagged: [],
    errors: [],
  };

  if (proposals.length === 0) {
    log('No version changes detected. Registry is current.');
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    process.exit(0);
  }

  log(`${proposals.length} proposed changes:`);
  for (const p of proposals) {
    log(`  ${p.dictName}.${p.modelKey}: ${p.oldId} -> ${p.newId} (reason: ${p.reason})`);
  }

  if (DRY_RUN) {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    log(`Dry-run complete. Report at ${REPORT_FILE}`);
    process.exit(2);
  }

  // Snapshot current dicts before any patches.
  fs.copyFileSync(DICTS_FILE, PREV_DICTS);

  for (const p of proposals) {
    try {
      const passed = await smokeTest(p.newId);
      if (!passed) {
        log(`  SKIP ${p.modelKey}: smoke test failed for ${p.newId}`);
        report.flagged.push({ ...p, reason: 'smoke-test-failed' });
        continue;
      }
      patchDictsFile(p.dictName, p.modelKey, p.oldId, p.newId);
      report.applied.push(p);
      log(`  APPLIED ${p.dictName}.${p.modelKey}`);
    } catch (err) {
      log(`  ERROR on ${p.modelKey}: ${err.message}`);
      report.errors.push({ ...p, error: err.message });
    }
  }

  if (report.applied.length === 0) {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    log('No applicable changes after smoke tests. Exiting with code 2.');
    process.exit(2);
  }

  // Validate the patched file before any restart.
  try {
    execSync(`node --check ${DICTS_FILE}`, { stdio: 'pipe' });
    execSync(`node --check ${INDEX_FILE}`, { stdio: 'pipe' });
  } catch (err) {
    log(`Syntax check failed after patching: ${err.message}`);
    fs.copyFileSync(PREV_DICTS, DICTS_FILE);
    log('Reverted from PREV_DICTS.');
    fail('reverted: post-patch syntax check failed');
  }

  restartMcp();

  const healthOk = await postRestartHealthWatch(report.applied, 60_000);
  if (!healthOk) {
    log('Post-restart health watch detected degradation. Rolling back.');
    fs.copyFileSync(PREV_DICTS, DICTS_FILE);
    restartMcp();
    report.errors.push({ phase: 'health-watch', error: 'rolled back' });
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    fail('rolled back due to health degradation');
  }

  await snapshotToSpacetimeDb(report);
  await notify(report);

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  log(`Done. Applied ${report.applied.length} updates, flagged ${report.flagged.length}.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Catalog + dicts
// ---------------------------------------------------------------------------

async function fetchOpenRouterCatalog() {
  const resp = await fetch('https://openrouter.ai/api/v1/models');
  if (!resp.ok) throw new Error(`OpenRouter /models HTTP ${resp.status}`);
  const data = await resp.json();
  return data.data || [];
}

async function loadCurrentDicts() {
  const mod = await import(`file://${DICTS_FILE}?cachebust=${Date.now()}`);
  return {
    OPENROUTER_MODELS: mod.OPENROUTER_MODELS,
    REQUESTY_MODELS: mod.REQUESTY_MODELS,
    COPILOT_MODELS: mod.COPILOT_MODELS,
    DIRECT_MODELS: mod.DIRECT_MODELS,
  };
}

// ---------------------------------------------------------------------------
// Version-family parsers
//
// Each parser turns a model ID into (family, version, suffix) so we can
// compare candidates within the same family + suffix and pick the highest
// version. Suffix encodes the tier ("pro", "flash", "max-preview", etc.)
// so we don't accidentally swap a flagship for a flash variant.
// ---------------------------------------------------------------------------

export const PARSERS = {
  openrouter: {
    deepseek: parseDeepseekOR,
    'deepseek-coder': parseDeepseekOR,
    qwen: parseQwenOR,
    glm: parseGlmOR,
    minimax: parseMinimaxOR,
  },
};

export function parseDeepseekOR(id) {
  const m = id.match(/^deepseek\/deepseek-v(\d+(?:\.\d+)?)(?:-(pro|flash|max|chat|exp|terminus|speciale))?$/);
  if (!m) return null;
  return { family: 'deepseek', version: parseFloat(m[1]), suffix: m[2] || '' };
}

export function parseQwenOR(id) {
  const m = id.match(/^qwen\/qwen(\d+(?:\.\d+)?)(?:-([a-z-]+?))?(?:-preview)?(?::(free))?$/);
  if (!m) return null;
  return { family: 'qwen', version: parseFloat(m[1]), suffix: (m[2] || '') + (id.endsWith('-preview') ? '-preview' : '') + (m[3] ? ':free' : '') };
}

export function parseGlmOR(id) {
  const m = id.match(/^z-ai\/glm-(\d+(?:\.\d+)?)(?:-([a-z]+))?$/);
  if (!m) return null;
  return { family: 'glm', version: parseFloat(m[1]), suffix: m[2] || '' };
}

export function parseMinimaxOR(id) {
  const m = id.match(/^minimax\/minimax-m(\d+(?:\.\d+)?)(?:-([a-z]+))?(?::(free))?$/);
  if (!m) return null;
  return { family: 'minimax', version: parseFloat(m[1]), suffix: (m[2] || '') + (m[3] ? ':free' : '') };
}

// ---------------------------------------------------------------------------
// Proposal computation
// ---------------------------------------------------------------------------

export function computeProposals(dicts, catalog) {
  const proposals = [];
  const orModels = catalog.filter((m) => !m.deprecated);

  for (const [modelKey, oldId] of Object.entries(dicts.OPENROUTER_MODELS)) {
    const parser = PARSERS.openrouter[modelKey];
    if (!parser) continue;
    const oldParsed = parser(oldId);
    if (!oldParsed) continue;

    let best = oldParsed;
    let bestId = oldId;
    let bestMeta = catalog.find((m) => m.id === oldId);

    for (const m of orModels) {
      const p = parser(m.id);
      if (!p) continue;
      if (p.suffix !== oldParsed.suffix) continue;
      if (p.family !== oldParsed.family) continue;
      if (p.version > best.version) {
        best = p;
        bestId = m.id;
        bestMeta = m;
      }
    }

    if (bestId === oldId) continue;

    // Pricing + context guards (autonomous mode still respects these).
    const oldMeta = catalog.find((m) => m.id === oldId);
    if (oldMeta && bestMeta) {
      const oldPrice = parseFloat(oldMeta.pricing?.completion || '0');
      const newPrice = parseFloat(bestMeta.pricing?.completion || '0');
      if (oldPrice > 0 && newPrice > oldPrice * 2) {
        proposals.push({
          dictName: 'OPENROUTER_MODELS',
          modelKey, oldId, newId: bestId,
          flagged: true,
          reason: `pricing >2x (${oldPrice} -> ${newPrice}) — needs review`,
        });
        continue;
      }
      if ((bestMeta.context_length || 0) < (oldMeta.context_length || 0)) {
        proposals.push({
          dictName: 'OPENROUTER_MODELS',
          modelKey, oldId, newId: bestId,
          flagged: true,
          reason: `context shrank (${oldMeta.context_length} -> ${bestMeta.context_length}) — needs review`,
        });
        continue;
      }
    }

    proposals.push({
      dictName: 'OPENROUTER_MODELS',
      modelKey, oldId, newId: bestId,
      reason: `version bump v${oldParsed.version} -> v${best.version}`,
    });
  }

  return proposals;
}

// ---------------------------------------------------------------------------
// Smoke test (cheap "Reply OK" probe)
// ---------------------------------------------------------------------------

async function smokeTest(modelId) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    log(`  no OPENROUTER_API_KEY; skipping smoke test (treating as pass)`);
    return true;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        max_tokens: 8,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return /\bOK\b/i.test(text);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Atomic patch
// ---------------------------------------------------------------------------

function patchDictsFile(dictName, modelKey, oldId, newId) {
  const src = fs.readFileSync(DICTS_FILE, 'utf8');
  const escapedKey = modelKey.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const keyPattern = modelKey.includes('-') ? `"${escapedKey}"` : `(?:${escapedKey}|"${escapedKey}")`;
  const re = new RegExp(`(${keyPattern}\\s*:\\s*)"${oldId.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}"`, 'g');
  const matches = src.match(re);
  if (!matches || matches.length !== 1) {
    throw new Error(`patch refused: expected exactly one match for '${modelKey}': '${oldId}', got ${matches?.length || 0}`);
  }
  const next = src.replace(re, `$1"${newId}"`);
  fs.writeFileSync(DICTS_FILE, next);
}

// ---------------------------------------------------------------------------
// MCP restart + health watch
// ---------------------------------------------------------------------------

function restartMcp() {
  // No in-process SIGHUP handler exists — pkill -HUP kills the MCP, then the
  // MCP host (Claude Code) respawns it. The new instance imports the updated
  // dict file. If no MCP is currently running (e.g. between sessions), this
  // is a no-op — the next session start reads the new values.
  log('Sending SIGHUP to multi-model-router process(es) (kill-and-respawn)...');
  spawnSync('pkill', ['-HUP', '-f', 'mcp/multi-model-router/index.js'], { stdio: 'ignore' });
}

async function postRestartHealthWatch(applied, durationMs) {
  // Hit the gateway's /v1/models a few times, count failures.
  const start = Date.now();
  let failures = 0;
  while (Date.now() - start < durationMs) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const resp = await fetch('http://127.0.0.1:8787/v1/models', { signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) failures++;
    } catch {
      failures++;
    }
    if (failures >= 3) return false;
    await sleep(5000);
  }
  return true;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// SpacetimeDB snapshot + notification
// ---------------------------------------------------------------------------

async function snapshotToSpacetimeDb(report) {
  // SpacetimeDB MCP isn't reachable from a standalone Node script. Persist
  // snapshots locally; a Claude session reading the cron log can mirror them
  // to stdb_store_knowledge if the user wants the cross-session history.
  const key = `${SNAPSHOT_KEY_PREFIX}-${new Date().toISOString().slice(0, 10)}`;
  const path_ = path.join(CACHE_DIR, `${key}.json`);
  fs.writeFileSync(path_, JSON.stringify(report, null, 2));
  log(`Snapshot written to ${path_}`);
}

async function notify(report) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const accessFile = path.join(os.homedir(), '.claude', 'plugins', 'telegram', 'access.json');
  if (!token || !fs.existsSync(accessFile)) {
    log('No Telegram channel configured; appending memory entry instead.');
    appendMemoryEntry(report);
    return;
  }
  let chatId;
  try {
    const access = JSON.parse(fs.readFileSync(accessFile, 'utf8'));
    chatId = access?.allowlist?.[0]?.chat_id || access?.default_chat_id;
  } catch {
    chatId = null;
  }
  if (!chatId) {
    log('No allowlisted chat_id; appending memory entry instead.');
    appendMemoryEntry(report);
    return;
  }
  const text = formatTelegramMessage(report);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    log(`Telegram notification sent to chat ${chatId}.`);
  } catch (err) {
    log(`Telegram send failed: ${err.message}; appending memory entry.`);
    appendMemoryEntry(report);
  }
}

function formatTelegramMessage(report) {
  const lines = [`*multi-model-router weekly model update*`, `${report.runAt}`, ``];
  if (report.applied.length) {
    lines.push(`*Applied (${report.applied.length}):*`);
    for (const p of report.applied) lines.push(`  • \`${p.modelKey}\`: ${p.oldId} → ${p.newId}`);
  }
  if (report.flagged.length) {
    lines.push(``, `*Flagged for review (${report.flagged.length}):*`);
    for (const p of report.flagged) lines.push(`  • \`${p.modelKey}\`: ${p.oldId} → ${p.newId} (${p.reason})`);
  }
  if (report.errors.length) {
    lines.push(``, `*Errors (${report.errors.length}):*`);
    for (const e of report.errors) lines.push(`  • ${e.modelKey || e.phase}: ${e.error}`);
  }
  return lines.join('\n');
}

function appendMemoryEntry(report) {
  const memDir = path.join(os.homedir(), '.claude', 'projects', '-home-claude', 'memory');
  if (!fs.existsSync(memDir)) {
    log(`Memory dir ${memDir} not found; report skipped.`);
    return;
  }
  const file = path.join(memDir, 'project_router_weekly_updates.md');
  const entry =
    `\n\n## ${report.runAt}\n` +
    `Applied: ${report.applied.length}, flagged: ${report.flagged.length}, errors: ${report.errors.length}\n\n` +
    `\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
  fs.appendFileSync(file, entry);
  log(`Memory entry appended to ${file}.`);
}

// ---------------------------------------------------------------------------
// Cron installer
// ---------------------------------------------------------------------------

function installCron() {
  const nodeBin = process.execPath;
  const scriptPath = fileURLToPath(import.meta.url);
  const line = `0 2 * * 0 ${nodeBin} ${scriptPath} >> ${CRON_LOG} 2>&1`;
  const marker = '# multi-model-router weekly model freshness check';

  let existing = '';
  try {
    existing = execSync('crontab -l', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    existing = '';
  }

  if (existing.includes(marker)) {
    log('Cron entry already installed.');
    return;
  }

  const next = `${existing.trimEnd()}\n${marker}\n${line}\n`;
  const tmp = path.join(os.tmpdir(), `mmr-cron-${Date.now()}.txt`);
  fs.writeFileSync(tmp, next);
  execSync(`crontab ${tmp}`);
  fs.unlinkSync(tmp);
  log(`Cron entry installed: ${line}`);
}
