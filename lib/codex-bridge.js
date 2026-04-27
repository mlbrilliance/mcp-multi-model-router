// Bridge for openai/codex-plugin-cc — exposes its 6 slash-commands as MCP
// tools so they can be invoked from any MCP client (Codex CLI, GLM, scripts,
// other Claude sessions), not just inside the Claude Code TUI.
//
// Strategy: the upstream "plugin" is a self-contained Node subsystem at
// vendor/codex-plugin-cc/scripts/codex-companion.mjs (synced via
// `npm run sync-codex-prompts`). We shell out to it, with cwd set to the
// caller's repo. Background mode spawns detached so jobs survive MMR restarts.
//
// State, job tracking, prompts, and codex CLI orchestration all live upstream;
// we add only the MCP wrapping, repo_path resolution, and detach semantics.

import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.resolve(HERE, '..', 'vendor', 'codex-plugin-cc');
const COMPANION = path.join(VENDOR_DIR, 'scripts', 'codex-companion.mjs');

const DEFAULT_TIMEOUT_MS = 180_000;     // 3 min for sync review
const MAX_TIMEOUT_MS = 600_000;         // 10 min cap

let initialized = false;

export function init() {
  if (initialized) return;
  if (!fs.existsSync(COMPANION)) {
    throw new Error(
      `codex-bridge: vendor missing at ${VENDOR_DIR}. Run \`npm run sync-codex-prompts\` from ` +
      path.resolve(HERE, '..')
    );
  }
  initialized = true;
}

export function upstreamSha() {
  try {
    return fs.readFileSync(path.join(VENDOR_DIR, 'UPSTREAM_SHA'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

// repo_path resolution per locked decision: explicit arg > process.cwd() iff
// it is itself a git repo > hard error. Never silent fallback to a non-repo
// directory like /home/claude (where MMR typically runs).
function resolveRepoPath(argRepoPath) {
  const candidate = argRepoPath || process.cwd();
  const abs = path.resolve(candidate);
  if (!isGitRepo(abs)) {
    throw new Error(
      `repo_path "${candidate}" is not a git repository. ` +
      `Pass an explicit repo_path argument (the MMR server's cwd is rarely your repo).`
    );
  }
  return abs;
}

function isGitRepo(dir) {
  if (!fs.existsSync(dir)) return false;
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r.status === 0;
}

// --- foreground (sync) invocation ---

function runCompanionSync(subcommand, extraArgs, repoPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [COMPANION, subcommand, ...extraArgs], {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '', stderr = '';
    const killer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
    }, Math.min(timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));

    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      clearTimeout(killer);
      if (code === 0) {
        resolve(stdout);
      } else {
        const msg = (stderr || '').trim() || `codex-companion exited ${code} with no stderr`;
        reject(new Error(`codex-companion ${subcommand} failed (exit ${code}): ${msg}`));
      }
    });
    proc.on('error', err => { clearTimeout(killer); reject(err); });
  });
}

// --- background (detached) invocation ---

function runCompanionBackground(subcommand, extraArgs, repoPath) {
  // We append --background only for subcommands that accept it (review,
  // adversarial-review, task) so the companion writes a tracked-job entry to
  // its own state dir. We also detach so the process survives MMR restarts.
  const args = [COMPANION, subcommand, ...extraArgs];
  if (['review', 'adversarial-review', 'task'].includes(subcommand) && !extraArgs.includes('--background')) {
    args.splice(2, 0, '--background');
  }

  // We don't pipe stdout to a file ourselves — the companion's tracked-jobs
  // already records all output under its state dir (resolveJobsDir). We just
  // need the process to be reparented. /dev/null is fine for stdio.
  const proc = spawn('node', args, {
    cwd: repoPath,
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
    env: process.env,
  });
  proc.unref();
  return { pid: proc.pid };
}

// --- public API: one method per MCP tool ---

export async function codexReview(args) {
  init();
  const repoPath = resolveRepoPath(args.repo_path);
  const passthrough = buildPassthroughArgs(args, ['base', 'scope', 'focus']);

  if (args.background) {
    const { pid } = runCompanionBackground('review', passthrough, repoPath);
    return formatBackgroundLaunch('review', pid, repoPath);
  }
  return await runCompanionSync('review', ['--wait', ...passthrough], repoPath, args.timeout_ms);
}

export async function codexAdversarialReview(args) {
  init();
  const repoPath = resolveRepoPath(args.repo_path);
  const passthrough = buildPassthroughArgs(args, ['base', 'scope', 'focus']);

  if (args.background) {
    const { pid } = runCompanionBackground('adversarial-review', passthrough, repoPath);
    return formatBackgroundLaunch('adversarial-review', pid, repoPath);
  }
  return await runCompanionSync('adversarial-review', ['--wait', ...passthrough], repoPath, args.timeout_ms);
}

export async function codexRescue(args) {
  init();
  if (!args.prompt || !args.prompt.trim()) {
    throw new Error('codex_rescue requires a non-empty `prompt` argument');
  }
  const repoPath = resolveRepoPath(args.repo_path);

  // task subcommand args: [--background] [--write] [--resume|--fresh] [--model <m>] [--effort <e>] [prompt]
  const passthrough = [];
  if (args.write) passthrough.push('--write');
  if (args.resume) passthrough.push('--resume');
  if (args.fresh) passthrough.push('--fresh');
  if (args.model) passthrough.push('--model', String(args.model));
  if (args.effort) passthrough.push('--effort', String(args.effort));
  passthrough.push(args.prompt);

  // Default to background for rescue (it's typically long-running).
  const wantBackground = args.background !== false;
  if (wantBackground) {
    const { pid } = runCompanionBackground('task', passthrough, repoPath);
    return formatBackgroundLaunch('rescue', pid, repoPath);
  }
  return await runCompanionSync('task', passthrough, repoPath, args.timeout_ms);
}

export async function codexStatus(args) {
  init();
  const repoPath = resolveRepoPath(args.repo_path);
  const passthrough = [];
  if (args.task_id) passthrough.push(args.task_id);
  if (args.all) passthrough.push('--all');
  if (args.json) passthrough.push('--json');
  return await runCompanionSync('status', passthrough, repoPath, 30_000);
}

export async function codexResult(args) {
  init();
  if (!args.task_id) throw new Error('codex_result requires a `task_id` argument');
  const repoPath = resolveRepoPath(args.repo_path);
  const passthrough = [args.task_id];
  if (args.json) passthrough.push('--json');
  return await runCompanionSync('result', passthrough, repoPath, 30_000);
}

export async function codexCancel(args) {
  init();
  if (!args.task_id) throw new Error('codex_cancel requires a `task_id` argument');
  const repoPath = resolveRepoPath(args.repo_path);
  const passthrough = [args.task_id];
  if (args.json) passthrough.push('--json');
  return await runCompanionSync('cancel', passthrough, repoPath, 30_000);
}

// --- helpers ---

function buildPassthroughArgs(args, allowedKeys) {
  const out = [];
  if (allowedKeys.includes('base') && args.base) out.push('--base', String(args.base));
  if (allowedKeys.includes('scope') && args.scope) out.push('--scope', String(args.scope));
  // Free-text "focus" only applies to adversarial-review; review.md explicitly
  // rejects extra prose. Caller should know which tool they're invoking.
  if (allowedKeys.includes('focus') && args.focus) out.push(String(args.focus));
  return out;
}

function formatBackgroundLaunch(kind, pid, repoPath) {
  return [
    `Codex ${kind} launched in background.`,
    `  pid: ${pid}`,
    `  repo: ${repoPath}`,
    ``,
    `Check progress:  codex_status (repo_path="${repoPath}")`,
    `Read result:     codex_result (task_id=<id from status>)`,
    `Cancel:          codex_cancel (task_id=<id from status>)`,
  ].join('\n');
}
