#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { spawn as spawnProcess } from 'child_process';
import { execSync } from 'child_process';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const REQUESTY_API_KEY = process.env.REQUESTY_API_KEY;
const LOCAL_MODEL_BASE_URL = process.env.LOCAL_MODEL_BASE_URL || null;
const LOCAL_MODEL_PROVIDER = process.env.LOCAL_MODEL_PROVIDER || null;

const CODEX_AVAILABLE = (() => {
  try {
    execSync('codex --version', { stdio: 'pipe' });
    return true;
  } catch { return false; }
})();

const GEMINI_CLI_PATH = (() => {
  try {
    return execSync('which gemini', { stdio: 'pipe', timeout: 5000 }).toString().trim();
  } catch { /* not in PATH */ }
  for (const p of ['/usr/bin/gemini', '/usr/local/bin/gemini', `${process.env.HOME}/.local/bin/gemini`]) {
    try { execSync(`${p} --version`, { stdio: 'pipe', timeout: 5000 }); return p; } catch {}
  }
  return null;
})();
const GEMINI_CLI_AVAILABLE = !!GEMINI_CLI_PATH;

const LOCAL_PROVIDER_DEFAULTS = {
  ollama:   { port: 11434, baseUrl: 'http://127.0.0.1:11434/v1', listUrl: 'http://127.0.0.1:11434/api/tags', name: 'Ollama' },
  lmstudio: { port: 1234,  baseUrl: 'http://127.0.0.1:1234/v1',  listUrl: 'http://127.0.0.1:1234/v1/models',  name: 'LM Studio' },
  vllm:     { port: 8000,  baseUrl: 'http://127.0.0.1:8000/v1',  listUrl: 'http://127.0.0.1:8000/v1/models',  name: 'vLLM' },
  mlx:      { port: 8080,  baseUrl: 'http://127.0.0.1:8080/v1',  listUrl: 'http://127.0.0.1:8080/v1/models',  name: 'MLX' },
  localai:  { port: 8080,  baseUrl: 'http://127.0.0.1:8080/v1',  listUrl: 'http://127.0.0.1:8080/v1/models',  name: 'LocalAI' },
};

const LOCAL_SERVER_INFO = await (async () => {
  const unavailable = { available: false, provider: null, name: null, baseUrl: null, listUrl: null };

  // If user explicitly set a base URL, trust it
  if (LOCAL_MODEL_BASE_URL) {
    const provider = LOCAL_MODEL_PROVIDER || 'custom';
    const defaults = LOCAL_PROVIDER_DEFAULTS[provider];
    const name = defaults?.name || provider;
    const listUrl = defaults?.listUrl || `${LOCAL_MODEL_BASE_URL}/models`;
    return { available: true, provider, name, baseUrl: LOCAL_MODEL_BASE_URL, listUrl };
  }

  // If user specified a provider hint, only probe that one
  if (LOCAL_MODEL_PROVIDER && LOCAL_PROVIDER_DEFAULTS[LOCAL_MODEL_PROVIDER]) {
    const cfg = LOCAL_PROVIDER_DEFAULTS[LOCAL_MODEL_PROVIDER];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      await fetch(cfg.listUrl, { signal: ctrl.signal });
      clearTimeout(timer);
      return { available: true, provider: LOCAL_MODEL_PROVIDER, name: cfg.name, baseUrl: cfg.baseUrl, listUrl: cfg.listUrl };
    } catch {
      return unavailable;
    }
  }

  // Auto-probe default ports in order
  const probeOrder = ['ollama', 'lmstudio', 'vllm', 'mlx', 'localai'];
  for (const provider of probeOrder) {
    const cfg = LOCAL_PROVIDER_DEFAULTS[provider];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      await fetch(cfg.listUrl, { signal: ctrl.signal });
      clearTimeout(timer);
      return { available: true, provider, name: cfg.name, baseUrl: cfg.baseUrl, listUrl: cfg.listUrl };
    } catch {
      // not running, try next
    }
  }
  return unavailable;
})();

const OPENROUTER_MODELS = {
  deepseek: "deepseek/deepseek-v3.2",
  qwen: "qwen/qwen3.5-397b-a17b",
  glm: "z-ai/glm-5",
  minimax: "minimax/minimax-m2.5",
};

const REQUESTY_MODELS = {
  deepseek: "deepinfra/deepseek-ai/DeepSeek-V3.1",
  qwen: "deepinfra/Qwen/Qwen3-235B-A22B",
  glm: "novita/zai-org/glm-4.6",
  minimax: "novita/zai-org/glm-4.6", // minimax not on Requesty, fallback to GLM
  "gemini-pro": "google/gemini-3.1-pro-preview",
  "gemini-flash": "google/gemini-3-flash-preview",
};

async function callGemini(modelName, prompt, context, maxTokens) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not set");
  }

  const fullPrompt = context ? `${context}\n\n---\n\n${prompt}` : prompt;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    contents: [{ parts: [{ text: fullPrompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens || 8192,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(`Unexpected Gemini response: ${JSON.stringify(data)}`);
  }
  return text;
}

async function callGeminiCLI(cliModel, prompt, context, maxTokens) {
  const fullPrompt = context ? `${context}\n\n---\n\n${prompt}` : prompt;
  const args = ['-p', fullPrompt, '-m', cliModel || 'auto', '-o', 'json', '-y'];

  // Strip GEMINI_API_KEY so CLI uses OAuth instead of API key
  const childEnv = { ...process.env };
  delete childEnv.GEMINI_API_KEY;
  delete childEnv.GOOGLE_API_KEY;

  return new Promise((resolve, reject) => {
    const proc = spawnProcess(GEMINI_CLI_PATH, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
      timeout: 120000,
    });
    setImmediate(() => { try { proc.stdin.end(); } catch {} }); // Prevent headless stdin hang

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code === 0 || stdout.length > 0) {
        try {
          const jsonStart = stdout.indexOf('{');
          const jsonStr = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
          const parsed = JSON.parse(jsonStr);
          resolve(parsed.response || parsed.text || stdout.trim());
        } catch {
          resolve(stdout.trim());
        }
      } else {
        reject(new Error(`Gemini CLI exit ${code}: ${stderr.trim()}`));
      }
    });
    proc.on('error', err => reject(new Error(`Gemini CLI spawn error: ${err.message}`)));
  });
}

async function callOpenRouter(modelKey, prompt, context, maxTokens) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY not set");
  }

  const modelId = OPENROUTER_MODELS[modelKey] || OPENROUTER_MODELS.deepseek;
  const fullPrompt = context ? `${context}\n\n---\n\n${prompt}` : prompt;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://claude.ai",
      "X-Title": "Claude Code Multi-Model Router",
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: fullPrompt }],
      max_tokens: maxTokens || 4096,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error(`Unexpected OpenRouter response: ${JSON.stringify(data)}`);
  }
  return text;
}

async function callRequesty(modelKey, prompt, context, maxTokens) {
  if (!REQUESTY_API_KEY) throw new Error("REQUESTY_API_KEY not set");
  const modelId = REQUESTY_MODELS[modelKey] || modelKey;
  const fullPrompt = context ? `${context}\n\n---\n\n${prompt}` : prompt;
  const response = await fetch("https://router.requesty.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${REQUESTY_API_KEY}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: fullPrompt }],
      max_tokens: maxTokens || 4096,
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Requesty API error ${response.status}: ${err}`);
  }
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`Unexpected Requesty response: ${JSON.stringify(data)}`);
  return text;
}

async function callLocal(model, prompt, context, maxTokens) {
  if (!LOCAL_SERVER_INFO.available) {
    throw new Error("No local inference server detected");
  }
  const fullPrompt = context ? `${context}\n\n---\n\n${prompt}` : prompt;
  const apiKey = LOCAL_SERVER_INFO.provider === 'ollama' ? 'ollama' : 'local';
  const response = await fetch(`${LOCAL_SERVER_INFO.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'default',
      messages: [{ role: "user", content: fullPrompt }],
      max_tokens: maxTokens || 4096,
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Local server (${LOCAL_SERVER_INFO.name}) error ${response.status}: ${err}`);
  }
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`Unexpected local server response: ${JSON.stringify(data)}`);
  return text;
}

async function listLocalModels() {
  if (!LOCAL_SERVER_INFO.available) return [];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const response = await fetch(LOCAL_SERVER_INFO.listUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!response.ok) return [];
    const data = await response.json();
    // Normalize: OpenAI format (data.data[].id) vs Ollama format (data.models[].name)
    if (Array.isArray(data.data)) {
      return data.data.map(m => ({ id: m.id, name: m.id, owned_by: m.owned_by || LOCAL_SERVER_INFO.name }));
    }
    if (Array.isArray(data.models)) {
      return data.models.map(m => ({
        id: m.name || m.model,
        name: m.name || m.model,
        owned_by: LOCAL_SERVER_INFO.name,
        size: m.size ? `${(m.size / 1e9).toFixed(1)}GB` : undefined,
      }));
    }
    return [];
  } catch {
    return [];
  }
}

function makeDelegateResponse(prompt, context, failureReason) {
  const fullPrompt = context ? `${context}\n\n---\n\n${prompt}` : prompt;
  return JSON.stringify({
    delegateTo: 'claude',
    prompt: fullPrompt,
    failureReason,
    instruction: 'All external models failed. Handle this task inline using Claude.',
  });
}

async function callOpenRouterWithFallback(modelKey, prompt, context, maxTokens) {
  const errors = [];
  if (OPENROUTER_API_KEY) {
    try {
      return await callOpenRouter(modelKey, prompt, context, maxTokens);
    } catch (err) { errors.push(`OpenRouter: ${err.message}`); }
  }
  if (REQUESTY_API_KEY) {
    try {
      const reqModelKey = modelKey || "deepseek";
      return await callRequesty(reqModelKey, prompt, context, maxTokens);
    } catch (err) { errors.push(`Requesty: ${err.message}`); }
  }
  return makeDelegateResponse(prompt, context, errors.join(' | '));
}

async function callGeminiWithFallback(modelName, prompt, context, maxTokens) {
  const errors = [];
  if (GEMINI_CLI_AVAILABLE) {
    try {
      const cliModel = modelName.includes('flash') ? 'flash' : 'pro';
      return await callGeminiCLI(cliModel, prompt, context, maxTokens);
    } catch (err) { errors.push(`GeminiCLI: ${err.message}`); }
  }
  if (GEMINI_API_KEY) {
    try {
      return await callGemini(modelName, prompt, context, maxTokens);
    } catch (err) { errors.push(`GeminiAPI: ${err.message}`); }
  }
  if (REQUESTY_API_KEY) {
    try {
      const reqKey = modelName.includes('flash') ? 'gemini-flash' : 'gemini-pro';
      return await callRequesty(reqKey, prompt, context, maxTokens);
    } catch (err) { errors.push(`Requesty: ${err.message}`); }
  }
  return makeDelegateResponse(prompt, context, errors.join(' | '));
}

async function callRequestyWithFallback(modelKey, prompt, context, maxTokens) {
  const errors = [];
  if (REQUESTY_API_KEY) {
    try {
      return await callRequesty(modelKey, prompt, context, maxTokens);
    } catch (err) { errors.push(`Requesty: ${err.message}`); }
  }
  return makeDelegateResponse(prompt, context, errors.join(' | '));
}

async function callLocalWithFallback(model, prompt, context, maxTokens) {
  const errors = [];
  if (LOCAL_SERVER_INFO.available) {
    try {
      return await callLocal(model, prompt, context, maxTokens);
    } catch (err) { errors.push(`Local(${LOCAL_SERVER_INFO.name}): ${err.message}`); }
  }
  if (REQUESTY_API_KEY) {
    try {
      return await callRequesty('deepseek', prompt, context, maxTokens);
    } catch (err) { errors.push(`Requesty: ${err.message}`); }
  }
  return makeDelegateResponse(prompt, context, errors.join(' | '));
}

async function callCodex(prompt, context, options = {}) {
  const fullPrompt = context ? `${context}\n\n---\n\n${prompt}` : prompt;
  const args = ['exec', fullPrompt];

  if (options.model) args.push('-m', options.model);
  args.push('-s', options.sandbox || 'read-only');
  if (options.fullAuto) args.push('--full-auto');

  return new Promise((resolve, reject) => {
    const proc = spawnProcess('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options.timeout || 120000,
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code === 0 || stdout.length > 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Codex exited ${code}: ${stderr}`));
      }
    });
    proc.on('error', reject);
  });
}

async function callCodexWithFallback(prompt, context, options = {}) {
  const errors = [];
  if (CODEX_AVAILABLE) {
    try {
      return await callCodex(prompt, context, options);
    } catch (err) { errors.push(`Codex: ${err.message}`); }
  }
  if (REQUESTY_API_KEY) {
    try {
      return await callRequesty('deepseek', prompt, context, options.max_tokens || 4096);
    } catch (err) { errors.push(`Requesty: ${err.message}`); }
  }
  return makeDelegateResponse(prompt, context, errors.join(' | '));
}

// --- Code-Based Smart Routing ---

const COMPLEXITY_INDICATORS = {
  high: [
    'architect', 'design', 'refactor', 'optimize', 'security', 'audit',
    'complex', 'analyze', 'investigate', 'debug', 'performance', 'scale',
    'distributed', 'concurrent', 'algorithm', 'system', 'integration',
    'migration', 'authentication', 'authorization', 'encryption',
  ],
  medium: [
    'implement', 'feature', 'add', 'update', 'modify', 'fix', 'test',
    'review', 'validate', 'check', 'improve', 'enhance', 'extend',
    'endpoint', 'component', 'service', 'module', 'database', 'api',
  ],
  low: [
    'simple', 'typo', 'comment', 'format', 'rename', 'move', 'copy',
    'delete', 'documentation', 'readme', 'config', 'version', 'bump',
    'log', 'basic', 'crud', 'boilerplate', 'script', 'template',
  ],
};

function scoreComplexity(description) {
  const desc = description.toLowerCase();
  const words = desc.split(/\s+/);

  const indicators = {
    high: COMPLEXITY_INDICATORS.high.filter(i => desc.includes(i)),
    medium: COMPLEXITY_INDICATORS.medium.filter(i => desc.includes(i)),
    low: COMPLEXITY_INDICATORS.low.filter(i => desc.includes(i)),
  };

  // Feature 1: Lexical complexity (word/sentence length)
  const avgWordLen = words.reduce((s, w) => s + w.length, 0) / Math.max(1, words.length);
  const lexical = Math.min(1, words.length / 50) * 0.4 + Math.min(1, (avgWordLen - 3) / 7) * 0.6;

  // Feature 2: Semantic depth (indicator weights)
  const semantic = Math.min(1, Math.max(0,
    0.3 + indicators.high.length * 0.3 + indicators.medium.length * 0.15 - indicators.low.length * 0.1
  ));

  // Feature 3: Task scope (multi-file, cross-cutting)
  const scopePatterns = [/multiple files?/i, /across.*modules?/i, /refactor.*codebase/i,
    /all.*files/i, /entire.*project/i, /system.*wide/i];
  const codeGenPatterns = [/implement/i, /create.*feature/i, /build.*system/i,
    /design.*api/i, /write.*tests/i, /add.*functionality/i];
  const scope = (scopePatterns.some(p => p.test(desc)) ? 0.4 : 0) +
    (codeGenPatterns.some(p => p.test(desc)) ? 0.3 : 0) +
    Math.min(0.3, words.length / 100);

  // Feature 4: Uncertainty level
  const uncertainPatterns = [/not sure/i, /might/i, /maybe/i, /investigate/i,
    /figure out/i, /unclear/i, /debug/i, /strange/i, /error/i, /bug/i, /problem/i];
  const uncertainty = Math.min(1, uncertainPatterns.filter(p => p.test(desc)).length * 0.2);

  // Weighted combination (mirrors claude-flow model-router.ts:272-277)
  const normalized = Math.min(1, Math.max(0,
    lexical * 0.2 + semantic * 0.35 + scope * 0.25 + uncertainty * 0.2
  ));

  const score = Math.round(normalized * 10);

  return { score, indicators, features: { lexical, semantic, scope, uncertainty } };
}

function classifyTaskType(description) {
  const desc = description.toLowerCase();
  const types = {
    docs:         ['document', 'readme', 'jsdoc', 'docstring', 'comment', 'explain', 'description'],
    code:         ['implement', 'feature', 'function', 'class', 'module', 'component', 'endpoint', 'api', 'build'],
    test:         ['test', 'spec', 'coverage', 'assert', 'mock', 'fixture', 'e2e', 'unit test'],
    refactor:     ['refactor', 'restructure', 'reorganize', 'rename', 'extract', 'move', 'cleanup'],
    script:       ['script', 'bash', 'shell', 'cli', 'command', 'automation', 'pipeline'],
    debug:        ['debug', 'fix', 'bug', 'error', 'issue', 'broken', 'crash', 'failing'],
    security:     ['security', 'auth', 'encrypt', 'vulnerability', 'injection', 'xss', 'csrf'],
    architecture: ['architect', 'design', 'system', 'pattern', 'migration', 'infrastructure', 'schema'],
    research:     ['research', 'investigate', 'compare', 'evaluate', 'analyze', 'explore', 'survey'],
  };

  let bestType = 'code', bestScore = 0;
  for (const [type, keywords] of Object.entries(types)) {
    const matches = keywords.filter(k => desc.includes(k)).length;
    if (matches > bestScore) { bestScore = matches; bestType = type; }
  }
  return bestType;
}

function routeTask(score, taskType) {
  const localRules = LOCAL_SERVER_INFO.available ? [
    { maxScore: 4, types: ['script', 'code', 'docs', 'refactor', 'test'], model: 'local', reason: `Low complexity — local (${LOCAL_SERVER_INFO.name})` },
  ] : [];

  const rules = [
    { maxScore: 2, types: '*',                model: 'inline',       reason: 'Trivial — handle inline' },
    ...localRules,
    { maxScore: 4, types: ['docs'],           model: 'gemini-flash', reason: 'Documentation — Gemini Flash (fast/cheap)' },
    { maxScore: 4, types: ['script'],         model: 'openrouter',   modelKey: 'deepseek', reason: 'Script — DeepSeek' },
    { maxScore: 4, types: ['code', 'refactor'], model: 'codex',      reason: 'Bulk code generation — Codex' },
    { maxScore: 6, types: ['code', 'refactor', 'test'], model: 'codex', sandbox: 'workspace-write',
      reason: 'Feature/refactor/test — Codex (workspace-write)' },
    { maxScore: 6, types: ['docs'],           model: 'gemini-flash', reason: 'Documentation — Gemini Flash' },
    { maxScore: 6, types: ['research'],       model: 'gemini-pro',   reason: 'Research — Gemini Pro (1M context)' },
    { maxScore: 6, types: ['script'],         model: 'openrouter',   modelKey: 'deepseek', reason: 'Script — DeepSeek' },
    { maxScore: 8, types: ['debug', 'security'], model: 'opus',      reason: 'Complex debug/security — Opus' },
    { maxScore: 8, types: ['architecture'],   model: 'opus',         reason: 'Architecture — Opus' },
    { maxScore: 8, types: ['research'],       model: 'gemini-pro',   reason: 'Deep research — Gemini Pro' },
    { maxScore: 8, types: ['code', 'refactor', 'test'], model: 'codex', sandbox: 'workspace-write', fullAuto: true,
      reason: 'Complex multi-file — Codex (full_auto)' },
    { maxScore: 10, types: ['architecture', 'security'], model: 'opus', reason: 'Expert architecture/security — Opus' },
    { maxScore: 10, types: ['research'],      model: 'gemini-pro',   reason: 'Expert research — Gemini Pro' },
  ];

  for (const rule of rules) {
    if (score <= rule.maxScore) {
      if (rule.types === '*' || rule.types.includes(taskType)) {
        return rule;
      }
    }
  }
  return { model: 'inline', reason: 'Default — handle inline' };
}

const MCP_TOOL_RECOMMENDATIONS = {
  research: [
    { server: 'exa', tool: 'web_search_exa', when: 'Task needs current web info, recent APIs, library versions' },
    { server: 'tavily', tool: 'tavily-search', when: 'Broad web search for general info, news, comparisons' },
    { server: 'tavily', tool: 'tavily-extract', when: 'Extract structured content from reference URLs' },
    { server: 'Ref', tool: 'ref_search_documentation', when: 'Task references specific library/framework docs' },
  ],
  debug: [
    { server: 'spacetimedb', tool: 'stdb_query_knowledge', when: 'Check if this error was solved in a previous session' },
    { server: 'exa', tool: 'web_search_exa', when: 'Error not found locally — search web for solution' },
    { server: 'tavily', tool: 'tavily-search', when: 'Search error messages, Stack Overflow, GitHub issues' },
  ],
  architecture: [
    { server: 'Ref', tool: 'ref_search_documentation', when: 'Need framework/API reference for design decisions' },
    { server: 'tavily', tool: 'tavily-search', when: 'Search architectural patterns, best practices' },
    { server: 'claude-flow', tool: 'agent_spawn', when: 'Task benefits from multi-agent parallel execution' },
  ],
  code: [
    { server: 'spacetimedb', tool: 'stdb_query_knowledge', when: 'Check for project-specific patterns/configs' },
    { server: 'Ref', tool: 'ref_search_documentation', when: 'Task uses external library APIs' },
  ],
  security: [
    { server: 'exa', tool: 'web_search_exa', when: 'Check for CVEs, latest security advisories' },
    { server: 'tavily', tool: 'tavily-search', when: 'Search NIST/NVD advisories, security bulletins' },
    { server: 'Ref', tool: 'ref_search_documentation', when: 'Security API/framework docs lookup' },
  ],
  test: [
    { server: 'spacetimedb', tool: 'stdb_query_knowledge', when: 'Check for known test patterns/fixtures' },
  ],
  docs: [
    { server: 'Ref', tool: 'ref_search_documentation', when: 'Reference existing API docs to ensure accuracy' },
    { server: 'tavily', tool: 'tavily-extract', when: 'Extract content from reference URLs for documentation' },
  ],
};

function recommendMCPTools(taskType, description) {
  const recommendations = MCP_TOOL_RECOMMENDATIONS[taskType] || [];
  const desc = description.toLowerCase();

  const extras = [];
  if (/\b(latest|current|recent|2025|2026|version|deprecat)\b/.test(desc)) {
    extras.push({ server: 'exa', tool: 'web_search_exa', when: 'Task references current/recent info' });
    extras.push({ server: 'tavily', tool: 'tavily-search', when: 'Broad web search for current/recent info' });
  }
  if (/\b(extract\s+(from|data|content|info)|scrape|crawl|page\s+content|web\s+page|url\s+content|fetch\s+(page|url|content))\b/.test(desc)) {
    extras.push({ server: 'tavily', tool: 'tavily-extract', when: 'Extract structured content from web pages/URLs' });
  }
  if (/\b(deep\s+research|thorough\s+search|comprehensive\s+search|search\s+everywhere|find\s+all)\b/.test(desc)) {
    extras.push({ server: 'exa', tool: 'web_search_exa', when: 'Semantic/technical search for deep research' });
    extras.push({ server: 'tavily', tool: 'tavily-search', when: 'Broad web search for deep research' });
  }
  if (/\b(previous session|cross.?session|handoff|earlier)\b/.test(desc)) {
    extras.push({ server: 'spacetimedb', tool: 'stdb_claim_handoff', when: 'Check for session handoffs' });
  }
  if (/\b(swarm|parallel agents?|multi.?agent|orchestrat)\b/.test(desc)) {
    extras.push({ server: 'claude-flow', tool: 'swarm_init', when: 'Task benefits from swarm orchestration' });
  }

  const seen = new Set();
  return [...recommendations, ...extras].filter(r => {
    const key = `${r.server}:${r.tool}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildExecutionOrder(tasks) {
  const completed = new Set();
  const order = [];
  const remaining = new Set(tasks.map(t => t.id));

  while (remaining.size > 0) {
    const group = [];
    for (const id of remaining) {
      const task = tasks.find(t => t.id === id);
      const deps = (task.dependencies || []).filter(d => !completed.has(d));
      if (deps.length === 0) group.push(id);
    }
    if (group.length === 0) {
      // Circular dependency — force remaining into one group
      order.push([...remaining]);
      break;
    }
    order.push(group);
    for (const id of group) {
      completed.add(id);
      remaining.delete(id);
    }
  }
  return order;
}

const server = new Server(
  { name: "multi-model-router", version: "2.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "consult_gemini_pro",
      description:
        "Consult Gemini 3.1 Pro Preview for complex research, cross-domain analysis, or tasks needing massive context (up to 1M tokens). Best for architecture analysis, deep research, and large codebase reasoning.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The task or question for Gemini Pro",
          },
          context: {
            type: "string",
            description: "Optional additional context (code, data, documents)",
          },
          max_tokens: {
            type: "number",
            description: "Maximum output tokens (default: 8192)",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "consult_gemini_flash",
      description:
        "Consult Gemini Flash 3 for documentation, READMEs, JSDoc/docstrings, config files, and simple transformations. Fast and cost-effective for straightforward generative tasks.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The task or question for Gemini Flash",
          },
          context: {
            type: "string",
            description: "Optional additional context",
          },
          max_tokens: {
            type: "number",
            description: "Maximum output tokens (default: 4096)",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "consult_openrouter",
      description:
        "Consult an OpenRouter model (DeepSeek, Qwen, GLM, or Minimax) for bash scripts, boilerplate code, simple CRUD, and repetitive low-effort tasks. Use model='deepseek' (default), 'qwen', 'glm', or 'minimax'.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The task or question",
          },
          model: {
            type: "string",
            enum: ["deepseek", "qwen", "glm", "minimax"],
            description: "Which OpenRouter model to use (default: deepseek)",
          },
          context: {
            type: "string",
            description: "Optional additional context",
          },
          max_tokens: {
            type: "number",
            description: "Maximum output tokens (default: 4096)",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "consult_requesty",
      description:
        "Consult a model via Requesty.ai router. Fallback router with 300+ models. Use provider/model-name format or a shorthand (deepseek, qwen, gemini-pro, gemini-flash).",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The task or question",
          },
          model: {
            type: "string",
            description:
              "Model identifier: shorthand (deepseek, qwen, glm, minimax, gemini-pro, gemini-flash) or full provider/model-name (default: deepseek)",
          },
          context: {
            type: "string",
            description: "Optional additional context",
          },
          max_tokens: {
            type: "number",
            description: "Maximum output tokens (default: 4096)",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "consult_codex",
      description:
        "Delegate a task to OpenAI Codex CLI for autonomous execution. Codex runs locally with its own agent, skills, and sandbox. Best for: large refactors, feature implementation, bulk code generation, tasks benefiting from Codex's proprietary agent loop. Requires Codex CLI authenticated on this machine.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The task for Codex to execute autonomously",
          },
          context: {
            type: "string",
            description: "Additional context (code, file contents, requirements)",
          },
          model: {
            type: "string",
            description: "Codex model to use (default: gpt-5.3-codex). See https://developers.openai.com/codex/models/",
            enum: [
              "gpt-5.3-codex",
              "gpt-5.3-codex-spark",
              "gpt-5.2-codex",
              "gpt-5.2",
              "gpt-5.1-codex-max",
              "gpt-5.1-codex",
              "gpt-5.1",
              "gpt-5-codex",
              "gpt-5-codex-mini",
              "gpt-5"
            ],
          },
          sandbox: {
            type: "string",
            description: "Sandbox mode for file access",
            enum: ["read-only", "workspace-write"],
          },
          full_auto: {
            type: "boolean",
            description: "Enable full-auto mode (no approval prompts). Use for trusted tasks.",
          },
          timeout: {
            type: "number",
            description: "Execution timeout in ms (default 120000 = 2 min, max 600000 = 10 min)",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "consult_local",
      description:
        "Consult a locally-running inference server (Ollama, LM Studio, vLLM, MLX, or LocalAI). Zero-cost, low-latency inference for simple tasks. Model names are passed through verbatim — use list_local_models to see available models.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The task or question for the local model",
          },
          model: {
            type: "string",
            description: "Model name (e.g. 'llama3.2', 'codellama'). Use list_local_models to see available models.",
          },
          context: {
            type: "string",
            description: "Optional additional context",
          },
          max_tokens: {
            type: "number",
            description: "Maximum output tokens (default: 4096)",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "list_local_models",
      description:
        "List models available on the detected local inference server (Ollama, LM Studio, vLLM, MLX, or LocalAI). Returns model IDs and sizes.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "list_available_models",
      description:
        "List all available models and whether their API keys are configured.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "analyze_requirements",
      description:
        "Analyze a requirements document and generate a smart execution plan with model routing. Decomposes requirements into subtasks via Gemini Flash, scores complexity via code-based heuristics, and assigns each subtask to the optimal model using a deterministic decision table.",
      inputSchema: {
        type: "object",
        properties: {
          requirements: {
            type: "string",
            description: "The requirements text to analyze and decompose into routed subtasks",
          },
          context: {
            type: "string",
            description: "Optional additional context (existing code, constraints, architecture notes)",
          },
        },
        required: ["requirements"],
      },
    },
    {
      name: "execute_routing_plan",
      description:
        "Execute a routing plan generated by analyze_requirements. Runs tasks in dependency order, parallelizing where possible. Tasks routed to 'opus' or 'inline' are returned as delegation instructions for Claude to handle directly.",
      inputSchema: {
        type: "object",
        properties: {
          plan: {
            type: "object",
            description: "The plan object returned by analyze_requirements",
          },
        },
        required: ["plan"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "list_available_models") {
      const geminiStatus = GEMINI_CLI_AVAILABLE
        ? "AVAILABLE (CLI primary via OAuth → API fallback)"
        : GEMINI_API_KEY
          ? "AVAILABLE (API only — install gemini-cli for OAuth primary)"
          : "UNAVAILABLE (no CLI or API key)";
      const models = [
        {
          name: "Gemini CLI (OAuth - Primary)",
          id: "gemini-cli",
          tool: "consult_gemini_pro / consult_gemini_flash (used as primary)",
          status: GEMINI_CLI_AVAILABLE ? "AVAILABLE (OAuth)" : "NOT INSTALLED (npm i -g @google/gemini-cli)",
          bestFor: "Same as Gemini Pro/Flash but via OAuth (higher free-tier limits, no API key billing)",
        },
        {
          name: "Gemini 3.1 Pro Preview",
          id: "gemini-3.1-pro-preview",
          tool: "consult_gemini_pro",
          status: geminiStatus,
          bestFor: "Complex research, massive context (1M tokens), cross-domain analysis",
        },
        {
          name: "Gemini Flash 3",
          id: "gemini-3-flash-preview",
          tool: "consult_gemini_flash",
          status: geminiStatus,
          bestFor: "Documentation, READMEs, JSDoc, config files, simple transforms",
        },
        {
          name: "DeepSeek V3.2",
          id: OPENROUTER_MODELS.deepseek,
          tool: "consult_openrouter (model='deepseek')",
          status: OPENROUTER_API_KEY ? "AVAILABLE" : "UNAVAILABLE (no OPENROUTER_API_KEY)",
          bestFor: "Bash scripts, boilerplate, simple CRUD, repetitive code",
        },
        {
          name: "Qwen 3.5 Plus",
          id: OPENROUTER_MODELS.qwen,
          tool: "consult_openrouter (model='qwen')",
          status: OPENROUTER_API_KEY ? "AVAILABLE" : "UNAVAILABLE (no OPENROUTER_API_KEY)",
          bestFor: "Code generation, multilingual tasks",
        },
        {
          name: "GLM-5",
          id: OPENROUTER_MODELS.glm,
          tool: "consult_openrouter (model='glm')",
          status: OPENROUTER_API_KEY ? "AVAILABLE" : "UNAVAILABLE (no OPENROUTER_API_KEY)",
          bestFor: "General code tasks",
        },
        {
          name: "Minimax M2.5",
          id: OPENROUTER_MODELS.minimax,
          tool: "consult_openrouter (model='minimax')",
          status: OPENROUTER_API_KEY ? "AVAILABLE" : "UNAVAILABLE (no OPENROUTER_API_KEY)",
          bestFor: "Long-form generation",
        },
      ];

      const reqModels = [
        {
          name: "Requesty.ai (Fallback Router)",
          id: "requesty/300+ models",
          tool: "consult_requesty",
          status: REQUESTY_API_KEY ? "AVAILABLE" : "UNAVAILABLE (no REQUESTY_API_KEY)",
          bestFor: "Fallback when OpenRouter/Gemini fail, or direct access to 300+ models with smart routing",
        },
      ];

      const codexModels = [
        {
          name: "OpenAI Codex CLI (Local Agent)",
          id: "codex-local",
          tool: "consult_codex",
          status: CODEX_AVAILABLE ? "AVAILABLE" : "UNAVAILABLE (run: npm i -g @openai/codex && codex login)",
          bestFor: "Feature implementation, large refactors, bulk code generation, autonomous multi-step tasks",
        },
      ];

      const localModels = LOCAL_SERVER_INFO.available
        ? [{
            name: `Local Inference (${LOCAL_SERVER_INFO.name})`,
            id: `${LOCAL_SERVER_INFO.provider}@${LOCAL_SERVER_INFO.baseUrl}`,
            tool: "consult_local / list_local_models",
            status: `DETECTED (${LOCAL_SERVER_INFO.name} at ${LOCAL_SERVER_INFO.baseUrl})`,
            bestFor: "Zero-cost, low-latency inference for simple tasks (score 3-4)",
          }]
        : [{
            name: "Local Inference (Ollama / LM Studio / vLLM / MLX / LocalAI)",
            id: "local-not-detected",
            tool: "consult_local / list_local_models",
            status: "NOT DETECTED — install Ollama (ollama.ai), LM Studio, vLLM, MLX, or LocalAI",
            bestFor: "Zero-cost, low-latency inference for simple tasks (score 3-4)",
          }];

      const allModels = [...models, ...reqModels, ...codexModels, ...localModels];
      const output = allModels
        .map(
          (m) =>
            `**${m.name}** (${m.id})\n  Tool: ${m.tool}\n  Status: ${m.status}\n  Best for: ${m.bestFor}`
        )
        .join("\n\n");

      return { content: [{ type: "text", text: output }] };
    }

    if (name === "consult_gemini_pro") {
      const text = await callGeminiWithFallback(
        "gemini-3.1-pro-preview",
        args.prompt,
        args.context,
        args.max_tokens
      );
      return { content: [{ type: "text", text }] };
    }

    if (name === "consult_gemini_flash") {
      const text = await callGeminiWithFallback(
        "gemini-3-flash-preview",
        args.prompt,
        args.context,
        args.max_tokens || 4096
      );
      return { content: [{ type: "text", text }] };
    }

    if (name === "consult_openrouter") {
      const text = await callOpenRouterWithFallback(
        args.model || "deepseek",
        args.prompt,
        args.context,
        args.max_tokens
      );
      return { content: [{ type: "text", text }] };
    }

    if (name === "consult_requesty") {
      const text = await callRequestyWithFallback(
        args.model || "deepseek",
        args.prompt,
        args.context,
        args.max_tokens
      );
      return { content: [{ type: "text", text }] };
    }

    if (name === "consult_codex") {
      if (!CODEX_AVAILABLE) {
        return {
          content: [{ type: "text", text: "Error: Codex CLI not found or not authenticated. Run: codex login" }],
          isError: true,
        };
      }
      const text = await callCodexWithFallback(
        args.prompt,
        args.context,
        {
          model: args.model,
          sandbox: args.sandbox,
          fullAuto: args.full_auto,
          timeout: args.timeout,
          max_tokens: args.max_tokens,
        }
      );
      return { content: [{ type: "text", text }] };
    }

    if (name === "consult_local") {
      if (!LOCAL_SERVER_INFO.available) {
        return {
          content: [{ type: "text", text: `Error: No local inference server detected.\n\nInstall one of:\n- Ollama: curl -fsSL https://ollama.ai/install.sh | sh && ollama pull llama3.2\n- LM Studio: https://lmstudio.ai\n- vLLM: pip install vllm && vllm serve <model>\n- MLX: pip install mlx-lm && mlx_lm.server\n- LocalAI: https://localai.io\n\nOr set LOCAL_MODEL_BASE_URL to your server's OpenAI-compatible endpoint.` }],
          isError: true,
        };
      }
      const text = await callLocalWithFallback(
        args.model,
        args.prompt,
        args.context,
        args.max_tokens
      );
      return { content: [{ type: "text", text }] };
    }

    if (name === "list_local_models") {
      if (!LOCAL_SERVER_INFO.available) {
        return {
          content: [{ type: "text", text: "No local inference server detected. Install Ollama, LM Studio, vLLM, MLX, or LocalAI to use local models." }],
        };
      }
      const models = await listLocalModels();
      if (models.length === 0) {
        return {
          content: [{ type: "text", text: `${LOCAL_SERVER_INFO.name} detected at ${LOCAL_SERVER_INFO.baseUrl} but no models found. Pull a model first (e.g., for Ollama: ollama pull llama3.2).` }],
        };
      }
      const output = `**${LOCAL_SERVER_INFO.name}** (${LOCAL_SERVER_INFO.baseUrl})\n\n` +
        models.map(m => `- **${m.id}**${m.size ? ` (${m.size})` : ''}${m.owned_by ? ` — ${m.owned_by}` : ''}`).join('\n');
      return { content: [{ type: "text", text: output }] };
    }

    if (name === "analyze_requirements") {
      const { requirements, context } = args;

      // Step 1: Decompose requirements into subtasks via Gemini Flash
      const decompositionPrompt = `You are a task decomposition engine. Break the following requirements into discrete, actionable subtasks.

For each subtask return a JSON object with:
- id: short identifier (e.g. "task-1")
- title: brief title (5-10 words)
- description: what needs to be done (1-2 sentences)
- dependencies: array of task IDs this depends on (empty array if none)

Return ONLY a JSON array. No markdown, no explanation, no code fences. Order tasks logically (dependencies first).

Requirements:
---
${requirements}
---`;

      let subtasks;
      try {
        const rawResponse = await callGeminiWithFallback(
          'gemini-3-flash-preview',
          decompositionPrompt,
          context,
          4096
        );
        // Strip markdown code fences if present
        const cleaned = rawResponse.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
        subtasks = JSON.parse(cleaned);
        if (!Array.isArray(subtasks)) {
          throw new Error('Expected JSON array of subtasks');
        }
      } catch (parseErr) {
        return {
          content: [{ type: "text", text: `Failed to decompose requirements: ${parseErr.message}` }],
          isError: true,
        };
      }

      // Step 2: Score, classify, and route each subtask (code-based)
      const tasks = subtasks.map(st => {
        const complexity = scoreComplexity(st.description);
        const taskType = classifyTaskType(st.description);
        const route = routeTask(complexity.score, taskType);
        const mcpTools = recommendMCPTools(taskType, st.description);

        return {
          id: st.id,
          title: st.title,
          description: st.description,
          dependencies: st.dependencies || [],
          complexity: { score: complexity.score, features: complexity.features, indicators: complexity.indicators },
          taskType,
          route: {
            model: route.model,
            reason: route.reason,
            ...(route.modelKey && { modelKey: route.modelKey }),
            ...(route.sandbox && { sandbox: route.sandbox }),
            ...(route.fullAuto && { fullAuto: route.fullAuto }),
          },
          mcpTools,
        };
      });

      // Step 3: Build DAG execution order
      const executionOrder = buildExecutionOrder(tasks);

      // Step 4: Compute summary
      const modelCounts = {};
      for (const t of tasks) {
        modelCounts[t.route.model] = (modelCounts[t.route.model] || 0) + 1;
      }
      const mcpServersUsed = new Set();
      for (const t of tasks) t.mcpTools.forEach(m => mcpServersUsed.add(m.server));

      const summary = {
        totalTasks: tasks.length,
        modelDistribution: modelCounts,
        parallelGroups: executionOrder.length,
        maxParallelism: Math.max(...executionOrder.map(g => g.length)),
        mcpServersRecommended: [...mcpServersUsed],
      };

      const plan = { tasks, executionOrder, summary };

      // Format human-readable output
      let output = `## Execution Plan\n\n`;
      output += `**${summary.totalTasks} tasks** in **${summary.parallelGroups} phases** (max parallelism: ${summary.maxParallelism})\n\n`;
      output += `### Model Distribution\n`;
      for (const [model, count] of Object.entries(modelCounts)) {
        output += `- ${model}: ${count} task(s)\n`;
      }
      output += `\n### Tasks\n\n`;
      for (const task of tasks) {
        output += `**${task.id}**: ${task.title}\n`;
        output += `  - ${task.description}\n`;
        output += `  - Complexity: ${task.complexity.score}/10 | Type: ${task.taskType} | Route: ${task.route.model} (${task.route.reason})\n`;
        if (task.mcpTools.length > 0) {
          output += `  - MCP tools: ${task.mcpTools.map(t => `${t.server}/${t.tool}`).join(', ')}\n`;
        }
        if (task.dependencies.length > 0) output += `  - Depends on: ${task.dependencies.join(', ')}\n`;
        output += `\n`;
      }
      output += `### Execution Order\n\n`;
      executionOrder.forEach((group, i) => {
        output += `Phase ${i + 1} (parallel): ${group.join(', ')}\n`;
      });

      output += `\n---\n_Plan JSON available in tool result for execute_routing_plan._`;

      return {
        content: [
          { type: "text", text: output },
          { type: "text", text: JSON.stringify(plan) },
        ],
      };
    }

    if (name === "execute_routing_plan") {
      const { plan } = args;
      if (!plan || !plan.tasks || !plan.executionOrder) {
        return {
          content: [{ type: "text", text: "Invalid plan object. Expected output from analyze_requirements." }],
          isError: true,
        };
      }

      const results = {};

      for (const group of plan.executionOrder) {
        const groupResults = await Promise.all(
          group.map(async (taskId) => {
            const task = plan.tasks.find(t => t.id === taskId);
            if (!task) return { id: taskId, result: { error: `Task ${taskId} not found in plan` } };

            // Build prompt with context from completed dependencies
            let taskPrompt = `Task: ${task.title}\n\n${task.description}`;
            if (task.dependencies.length > 0) {
              const depContext = task.dependencies
                .filter(d => results[d] && results[d].output)
                .map(d => `[${d} result]: ${typeof results[d].output === 'string' ? results[d].output.slice(0, 2000) : JSON.stringify(results[d].output).slice(0, 2000)}`)
                .join('\n\n');
              if (depContext) taskPrompt += `\n\nContext from dependencies:\n${depContext}`;
            }

            try {
              let result;
              switch (task.route.model) {
                case 'gemini-flash':
                  result = { model: 'gemini-flash', output: await callGeminiWithFallback('gemini-3-flash-preview', taskPrompt, null, 4096) };
                  break;
                case 'gemini-pro':
                  result = { model: 'gemini-pro', output: await callGeminiWithFallback('gemini-3.1-pro-preview', taskPrompt, null, 8192) };
                  break;
                case 'openrouter':
                  result = { model: task.route.modelKey || 'deepseek', output: await callOpenRouterWithFallback(task.route.modelKey || 'deepseek', taskPrompt, null, 4096) };
                  break;
                case 'local':
                  if (LOCAL_SERVER_INFO.available) {
                    result = { model: `local(${LOCAL_SERVER_INFO.name})`, output: await callLocalWithFallback(null, taskPrompt, null, 4096) };
                  } else {
                    result = { model: 'local', delegateTo: 'claude', prompt: taskPrompt, note: 'Local server unavailable — delegate to Claude' };
                  }
                  break;
                case 'codex':
                  if (CODEX_AVAILABLE) {
                    result = { model: 'codex', output: await callCodexWithFallback(taskPrompt, null, {
                      model: 'gpt-5.3-codex',
                      sandbox: task.route.sandbox || 'read-only',
                      fullAuto: task.route.fullAuto || false,
                    })};
                  } else {
                    result = { model: 'codex', delegateTo: 'claude', prompt: taskPrompt, note: 'Codex unavailable — delegate to Claude' };
                  }
                  break;
                case 'opus':
                case 'inline':
                default:
                  result = { model: task.route.model, delegateTo: 'claude', prompt: taskPrompt };
                  break;
              }
              return { id: taskId, result };
            } catch (err) {
              return { id: taskId, result: { model: task.route.model, error: err.message } };
            }
          })
        );

        for (const { id, result } of groupResults) {
          results[id] = result;
        }
      }

      // Format output
      let output = `## Execution Results\n\n`;
      const executed = [], delegated = [], errored = [];
      for (const [id, result] of Object.entries(results)) {
        if (result.error) errored.push(id);
        else if (result.delegateTo) delegated.push(id);
        else executed.push(id);
      }

      output += `**Executed**: ${executed.length} | **Delegate to Claude**: ${delegated.length} | **Errors**: ${errored.length}\n\n`;

      for (const [id, result] of Object.entries(results)) {
        const task = plan.tasks.find(t => t.id === id);
        output += `### ${id}: ${task?.title || id}\n`;
        if (result.error) {
          output += `**ERROR**: ${result.error}\n\n`;
        } else if (result.delegateTo) {
          output += `**Delegate to Claude** (${result.model})\n`;
          output += `Prompt: ${result.prompt?.slice(0, 500)}...\n\n`;
        } else {
          output += `**${result.model}** — completed\n`;
          const text = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
          output += `${text.slice(0, 3000)}${text.length > 3000 ? '\n...(truncated)' : ''}\n\n`;
        }
      }

      return {
        content: [
          { type: "text", text: output },
          { type: "text", text: JSON.stringify(results) },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error calling ${name}: ${error.message}\n\nFalling back to inline handling is recommended.`,
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
