#!/usr/bin/env node
// Sync the upstream openai/codex-plugin-cc plugin subtree into vendor/.
//
// Usage: npm run sync-codex-prompts            # latest main
//        npm run sync-codex-prompts -- <sha>   # pin a specific commit
//
// What we vendor: the entire `plugins/codex/` directory. Upstream is a self-
// contained Node subsystem (zero npm deps, only the `codex` CLI binary at
// runtime). The MMR bridge invokes `scripts/codex-companion.mjs` and lets the
// companion handle review prompts, job tracking, and codex orchestration.
//
// What we skip: tests/, top-level package.json/tsconfig (build-only), .git.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.resolve(HERE, '..', 'vendor', 'codex-plugin-cc');
const REPO_URL = 'https://github.com/openai/codex-plugin-cc.git';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }).trim();
}

const requestedSha = process.argv[2] || null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plugin-cc-'));

try {
  console.log(`Cloning ${REPO_URL} → ${tmp}`);
  run(`git clone --depth=1 --no-tags ${REPO_URL} ${tmp}`);
  if (requestedSha) {
    run(`git -C ${tmp} fetch --depth=1 origin ${requestedSha}`);
    run(`git -C ${tmp} checkout ${requestedSha}`);
  }
  const sha = run(`git -C ${tmp} rev-parse HEAD`);

  const srcPlugin = path.join(tmp, 'plugins', 'codex');
  if (!fs.existsSync(srcPlugin)) {
    console.error(`Expected ${srcPlugin} to exist in upstream — layout changed?`);
    process.exit(2);
  }

  // Wipe and replace vendor dir to keep it byte-identical to upstream.
  if (fs.existsSync(VENDOR_DIR)) fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  fs.cpSync(srcPlugin, VENDOR_DIR, { recursive: true });

  fs.writeFileSync(path.join(VENDOR_DIR, 'UPSTREAM_SHA'), sha + '\n');

  const fileCount = run(`find ${VENDOR_DIR} -type f | wc -l`);
  console.log(`Synced upstream plugins/codex/ (${fileCount} files) → ${VENDOR_DIR}`);
  console.log(`UPSTREAM_SHA: ${sha}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
