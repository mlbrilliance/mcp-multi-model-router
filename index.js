#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { spawn as spawnProcess } from 'child_process';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { createHash } from 'crypto';
const require = createRequire(import.meta.url);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const REQUESTY_API_KEY = process.env.REQUESTY_API_KEY;
const GITHUB_COPILOT_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
const LOCAL_MODEL_BASE_URL = process.env.LOCAL_MODEL_BASE_URL || null;
const LOCAL_MODEL_PROVIDER = process.env.LOCAL_MODEL_PROVIDER || null;

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;

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

  // Auto-probe default ports in parallel (priority preserved via probeOrder index)
  const probeOrder = ['ollama', 'lmstudio', 'vllm', 'mlx', 'localai'];
  const probeResults = await Promise.allSettled(
    probeOrder.map(async (provider) => {
      const cfg = LOCAL_PROVIDER_DEFAULTS[provider];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      await fetch(cfg.listUrl, { signal: ctrl.signal });
      clearTimeout(timer);
      return { provider, name: cfg.name, baseUrl: cfg.baseUrl, listUrl: cfg.listUrl };
    })
  );
  for (let i = 0; i < probeOrder.length; i++) {
    if (probeResults[i].status === 'fulfilled') {
      const { provider, name, baseUrl, listUrl } = probeResults[i].value;
      return { available: true, provider, name, baseUrl, listUrl };
    }
  }
  return unavailable;
})();

const OPENROUTER_MODELS = {
  deepseek: "deepseek/deepseek-v3.2",
  qwen: "qwen/qwen3.6-plus:free",
  glm: "z-ai/glm-5-turbo",
  minimax: "minimax/minimax-m2.7",
};

const REQUESTY_MODELS = {
  deepseek: "deepinfra/deepseek-ai/DeepSeek-V3.2",
  qwen: "deepinfra/Qwen/Qwen3.6-Plus",
  glm: "novita/zai-org/glm-5-turbo",
  minimax: "novita/zai-org/glm-5-turbo", // minimax not on Requesty, fallback to GLM
  "gemini-pro": "google/gemini-3.1-pro-preview",
  "gemini-flash": "google/gemini-3-flash-preview",
};

const COPILOT_MODELS = {
  "gpt-4.1": "gpt-4.1",
  "gpt-4.1-mini": "gpt-4.1-mini",
  "gpt-5.4": "gpt-5.4",
  "gpt-5.4-mini": "gpt-5.4-mini",
  "claude-sonnet": "claude-sonnet-4.6",
  "claude-opus": "claude-opus-4.6",
  "o4-mini": "o4-mini",
  "gemini": "gemini-3-flash",
  "gemini-pro": "gemini-3.1-pro",
};

const COPILOT_AVAILABLE = !!GITHUB_COPILOT_TOKEN;

const DEFAULT_API_TIMEOUT = parseInt(process.env.MMR_API_TIMEOUT_MS, 10) || 30000;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_API_TIMEOUT) {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);
      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
        const waitMs = Math.min(retryAfter * 1000, 30000);
        process.stderr.write(`[mmr] 429 from ${new URL(url).hostname}, retrying in ${waitMs}ms\n`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      return response;
    } catch (err) {
      clearTimeout(timer);
      if (attempt < maxRetries && err.name !== 'AbortError') {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
}

class LRUCache {
  constructor(maxSize = 50, ttlMs = 300000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }
  _key(model, prompt, context) {
    return createHash('sha256').update(`${model}|${prompt}|${context || ''}`).digest('hex');
  }
  get(model, prompt, context) {
    const key = this._key(model, prompt, context);
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) { this.cache.delete(key); return undefined; }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }
  set(model, prompt, context, value) {
    const key = this._key(model, prompt, context);
    if (this.cache.size >= this.maxSize) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, { value, ts: Date.now() });
  }
}
const responseCache = new LRUCache();

// --- Provider Health (Circuit Breaker) ---

class ProviderHealth {
  constructor(failThreshold = 3, resetMs = 300000) {
    this.failThreshold = failThreshold;
    this.resetMs = resetMs;
    this.providers = {};
  }
  _ensure(name) {
    if (!this.providers[name]) this.providers[name] = { failures: [], state: 'closed', lastCheck: 0 };
    return this.providers[name];
  }
  recordSuccess(name) {
    const p = this._ensure(name);
    p.failures = [];
    p.state = 'closed';
  }
  recordFailure(name) {
    const p = this._ensure(name);
    p.failures.push(Date.now());
    p.failures = p.failures.filter(t => Date.now() - t < this.resetMs);
    if (p.failures.length >= this.failThreshold) p.state = 'open';
  }
  isAvailable(name) {
    const p = this._ensure(name);
    if (p.state === 'closed') return true;
    if (p.state === 'open' && Date.now() - p.lastCheck > this.resetMs) {
      p.state = 'half-open';
      p.lastCheck = Date.now();
      return true;
    }
    return p.state === 'half-open';
  }
  getStatus() {
    const status = {};
    for (const [name, p] of Object.entries(this.providers)) {
      status[name] = { state: p.state, recentFailures: p.failures.length };
    }
    return status;
  }
}
const providerHealth = new ProviderHealth();

// --- Response Quality Tracking ---

class QualityTracker {
  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
    this.records = [];
  }
  record(model, taskType, success, latencyMs) {
    this.records.push({ model, taskType, timestamp: Date.now(), success, latencyMs });
    if (this.records.length > this.maxEntries) this.records.shift();
  }
  getStats(model, taskType) {
    const relevant = this.records.filter(r =>
      (!model || r.model === model) && (!taskType || r.taskType === taskType)
    );
    if (relevant.length === 0) return null;
    const successes = relevant.filter(r => r.success).length;
    const avgLatency = relevant.reduce((s, r) => s + r.latencyMs, 0) / relevant.length;
    return { total: relevant.length, successRate: successes / relevant.length, avgLatencyMs: Math.round(avgLatency) };
  }
  getAllStats() {
    const models = [...new Set(this.records.map(r => r.model))];
    const taskTypes = [...new Set(this.records.map(r => r.taskType))];
    const overall = {};
    for (const m of models) {
      overall[m] = { overall: this.getStats(m, null) };
      for (const t of taskTypes) {
        const s = this.getStats(m, t);
        if (s) overall[m][t] = s;
      }
    }
    return overall;
  }
}
const qualityTracker = new QualityTracker();

// --- Reasoning Effort Levels ---

const EFFORT_LEVELS = {
  low:    { maxTokens: 1024,  temperature: 0.3, scoreBoost: -2, modelTier: 'cheap' },
  medium: { maxTokens: 4096,  temperature: 0.5, scoreBoost: 0,  modelTier: 'default' },
  high:   { maxTokens: 8192,  temperature: 0.7, scoreBoost: 1,  modelTier: 'default' },
  xhigh:  { maxTokens: 16384, temperature: 0.8, scoreBoost: 2,  modelTier: 'frontier' },
};

function applyEffort(effort, maxTokens) {
  const level = EFFORT_LEVELS[effort] || EFFORT_LEVELS.medium;
  return { maxTokens: maxTokens || level.maxTokens, scoreBoost: level.scoreBoost, modelTier: level.modelTier };
}

function formatErrors(errors, maxLen = 500) {
  const joined = errors.join(' | ');
  if (joined.length <= maxLen) return joined;
  return `${errors[0]} | ... (${errors.length - 2} more) | ${errors[errors.length - 1]}`;
}

async function callCopilot(modelKey, prompt, context, maxTokens, systemPrompt) {
  if (!GITHUB_COPILOT_TOKEN) {
    throw new Error("GITHUB_TOKEN / GH_TOKEN not set — needed for GitHub Copilot API");
  }

  const modelId = COPILOT_MODELS[modelKey] || modelKey || COPILOT_MODELS["gpt-4.1"];
  const fullPrompt = context ? `${context}\n\n---\n\n${prompt}` : prompt;
  const messages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    { role: "user", content: fullPrompt },
  ];

  const response = await fetchWithTimeout("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GITHUB_COPILOT_TOKEN}`,
      "Editor-Version": "claude-code/1.0",
      "Copilot-Integration-Id": "claude-code-multi-model-router",
    },
    body: JSON.stringify({
      model: modelId,
      messages,
      max_tokens: maxTokens || 4096,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Copilot API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error(`Unexpected Copilot response: ${JSON.stringify(data)}`);
  }
  return text;
}

async function callCopilotWithFallback(modelKey, prompt, context, maxTokens, systemPrompt) {
  const cached = responseCache.get(`copilot:${modelKey}`, prompt, context);
  if (cached) return cached;
  const errors = [];
  const t0 = Date.now();
  if (COPILOT_AVAILABLE && providerHealth.isAvailable('copilot')) {
    try {
      const result = await callCopilot(modelKey, prompt, context, maxTokens, systemPrompt);
      responseCache.set(`copilot:${modelKey}`, prompt, context, result);
      providerHealth.recordSuccess('copilot');
      qualityTracker.record(`copilot:${modelKey}`, null, true, Date.now() - t0);
      return result;
    } catch (err) { errors.push(`Copilot: ${err.message}`); providerHealth.recordFailure('copilot'); }
  }
  if (OPENROUTER_API_KEY && providerHealth.isAvailable('openrouter')) {
    try {
      const result = await callOpenRouter('deepseek', prompt, context, maxTokens, systemPrompt);
      responseCache.set(`copilot:${modelKey}`, prompt, context, result);
      providerHealth.recordSuccess('openrouter');
      return result;
    } catch (err) { errors.push(`OpenRouter: ${err.message}`); providerHealth.recordFailure('openrouter'); }
  }
  if (REQUESTY_API_KEY && providerHealth.isAvailable('requesty')) {
    try {
      const result = await callRequesty('deepseek', prompt, context, maxTokens, systemPrompt);
      responseCache.set(`copilot:${modelKey}`, prompt, context, result);
      providerHealth.recordSuccess('requesty');
      return result;
    } catch (err) { errors.push(`Requesty: ${err.message}`); providerHealth.recordFailure('requesty'); }
  }
  qualityTracker.record(`copilot:${modelKey}`, null, false, Date.now() - t0);
  return makeDelegateResponse(prompt, context, formatErrors(errors));
}

async function callGemini(modelName, prompt, context, maxTokens, systemPrompt) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not set");
  }

  const parts = [systemPrompt, context, prompt].filter(Boolean);
  const fullPrompt = parts.join('\n\n---\n\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    contents: [{ parts: [{ text: fullPrompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens || 8192,
    },
  };

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 60000);

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

async function callGeminiCLI(cliModel, prompt, context, maxTokens, systemPrompt) {
  const parts = [systemPrompt, context, prompt].filter(Boolean);
  const fullPrompt = parts.join('\n\n---\n\n');
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

async function callOpenRouter(modelKey, prompt, context, maxTokens, systemPrompt) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY not set");
  }

  const modelId = OPENROUTER_MODELS[modelKey] || OPENROUTER_MODELS.deepseek;
  const fullPrompt = context ? `${context}\n\n---\n\n${prompt}` : prompt;
  const messages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    { role: "user", content: fullPrompt },
  ];

  const response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://claude.ai",
      "X-Title": "Claude Code Multi-Model Router",
    },
    body: JSON.stringify({
      model: modelId,
      messages,
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

async function callRequesty(modelKey, prompt, context, maxTokens, systemPrompt) {
  if (!REQUESTY_API_KEY) throw new Error("REQUESTY_API_KEY not set");
  const modelId = REQUESTY_MODELS[modelKey] || modelKey;
  const fullPrompt = context ? `${context}\n\n---\n\n${prompt}` : prompt;
  const messages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    { role: "user", content: fullPrompt },
  ];
  const response = await fetchWithTimeout("https://router.requesty.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${REQUESTY_API_KEY}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages,
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

async function callLocal(model, prompt, context, maxTokens, systemPrompt) {
  if (!LOCAL_SERVER_INFO.available) {
    throw new Error("No local inference server detected");
  }
  const fullPrompt = context ? `${context}\n\n---\n\n${prompt}` : prompt;
  const messages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    { role: "user", content: fullPrompt },
  ];
  const apiKey = LOCAL_SERVER_INFO.provider === 'ollama' ? 'ollama' : 'local';
  const response = await fetchWithTimeout(`${LOCAL_SERVER_INFO.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'default',
      messages,
      max_tokens: maxTokens || 4096,
    }),
  }, 15000);
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

async function callOpenRouterWithFallback(modelKey, prompt, context, maxTokens, systemPrompt) {
  const cached = responseCache.get(`openrouter:${modelKey}`, prompt, context);
  if (cached) return cached;
  const errors = [];
  const t0 = Date.now();
  if (OPENROUTER_API_KEY && providerHealth.isAvailable('openrouter')) {
    try {
      const result = await callOpenRouter(modelKey, prompt, context, maxTokens, systemPrompt);
      responseCache.set(`openrouter:${modelKey}`, prompt, context, result);
      providerHealth.recordSuccess('openrouter');
      qualityTracker.record(`openrouter:${modelKey}`, null, true, Date.now() - t0);
      return result;
    } catch (err) {
      errors.push(`OpenRouter(${modelKey}): ${err.message}`);
      providerHealth.recordFailure('openrouter');
      if (modelKey === "glm") {
        try {
          const result = await callOpenRouter("minimax", prompt, context, maxTokens, systemPrompt);
          responseCache.set(`openrouter:${modelKey}`, prompt, context, result);
          return result;
        } catch (err2) { errors.push(`OpenRouter(minimax backup): ${err2.message}`); }
      }
    }
  }
  if (REQUESTY_API_KEY && providerHealth.isAvailable('requesty')) {
    try {
      const reqModelKey = modelKey || "deepseek";
      const result = await callRequesty(reqModelKey, prompt, context, maxTokens, systemPrompt);
      responseCache.set(`openrouter:${modelKey}`, prompt, context, result);
      providerHealth.recordSuccess('requesty');
      return result;
    } catch (err) { errors.push(`Requesty: ${err.message}`); providerHealth.recordFailure('requesty'); }
  }
  qualityTracker.record(`openrouter:${modelKey}`, null, false, Date.now() - t0);
  return makeDelegateResponse(prompt, context, formatErrors(errors));
}

async function callGeminiWithFallback(modelName, prompt, context, maxTokens, systemPrompt) {
  const cached = responseCache.get(`gemini:${modelName}`, prompt, context);
  if (cached) return cached;
  const errors = [];
  const t0 = Date.now();
  if (GEMINI_CLI_AVAILABLE && providerHealth.isAvailable('gemini-cli')) {
    try {
      const cliModel = modelName.includes('flash') ? 'flash' : 'pro';
      const result = await callGeminiCLI(cliModel, prompt, context, maxTokens, systemPrompt);
      responseCache.set(`gemini:${modelName}`, prompt, context, result);
      providerHealth.recordSuccess('gemini-cli');
      qualityTracker.record(`gemini:${modelName}`, null, true, Date.now() - t0);
      return result;
    } catch (err) { errors.push(`GeminiCLI: ${err.message}`); providerHealth.recordFailure('gemini-cli'); }
  }
  if (GEMINI_API_KEY && providerHealth.isAvailable('gemini-api')) {
    try {
      const result = await callGemini(modelName, prompt, context, maxTokens, systemPrompt);
      responseCache.set(`gemini:${modelName}`, prompt, context, result);
      providerHealth.recordSuccess('gemini-api');
      qualityTracker.record(`gemini:${modelName}`, null, true, Date.now() - t0);
      return result;
    } catch (err) { errors.push(`GeminiAPI: ${err.message}`); providerHealth.recordFailure('gemini-api'); }
  }
  if (REQUESTY_API_KEY && providerHealth.isAvailable('requesty')) {
    try {
      const reqKey = modelName.includes('flash') ? 'gemini-flash' : 'gemini-pro';
      const result = await callRequesty(reqKey, prompt, context, maxTokens, systemPrompt);
      responseCache.set(`gemini:${modelName}`, prompt, context, result);
      providerHealth.recordSuccess('requesty');
      return result;
    } catch (err) { errors.push(`Requesty: ${err.message}`); providerHealth.recordFailure('requesty'); }
  }
  qualityTracker.record(`gemini:${modelName}`, null, false, Date.now() - t0);
  return makeDelegateResponse(prompt, context, formatErrors(errors));
}

async function callRequestyWithFallback(modelKey, prompt, context, maxTokens, systemPrompt) {
  const cached = responseCache.get(`requesty:${modelKey}`, prompt, context);
  if (cached) return cached;
  const errors = [];
  const t0 = Date.now();
  if (REQUESTY_API_KEY && providerHealth.isAvailable('requesty')) {
    try {
      const result = await callRequesty(modelKey, prompt, context, maxTokens, systemPrompt);
      responseCache.set(`requesty:${modelKey}`, prompt, context, result);
      providerHealth.recordSuccess('requesty');
      qualityTracker.record(`requesty:${modelKey}`, null, true, Date.now() - t0);
      return result;
    } catch (err) { errors.push(`Requesty: ${err.message}`); providerHealth.recordFailure('requesty'); }
  }
  qualityTracker.record(`requesty:${modelKey}`, null, false, Date.now() - t0);
  return makeDelegateResponse(prompt, context, formatErrors(errors));
}

async function callLocalWithFallback(model, prompt, context, maxTokens, systemPrompt) {
  const cached = responseCache.get(`local:${model}`, prompt, context);
  if (cached) return cached;
  const errors = [];
  const t0 = Date.now();
  if (LOCAL_SERVER_INFO.available && providerHealth.isAvailable('local')) {
    try {
      const result = await callLocal(model, prompt, context, maxTokens, systemPrompt);
      responseCache.set(`local:${model}`, prompt, context, result);
      providerHealth.recordSuccess('local');
      qualityTracker.record(`local:${model}`, null, true, Date.now() - t0);
      return result;
    } catch (err) { errors.push(`Local(${LOCAL_SERVER_INFO.name}): ${err.message}`); providerHealth.recordFailure('local'); }
  }
  if (REQUESTY_API_KEY && providerHealth.isAvailable('requesty')) {
    try {
      const result = await callRequesty('deepseek', prompt, context, maxTokens, systemPrompt);
      responseCache.set(`local:${model}`, prompt, context, result);
      providerHealth.recordSuccess('requesty');
      return result;
    } catch (err) { errors.push(`Requesty: ${err.message}`); providerHealth.recordFailure('requesty'); }
  }
  qualityTracker.record(`local:${model}`, null, false, Date.now() - t0);
  return makeDelegateResponse(prompt, context, formatErrors(errors));
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
  const t0 = Date.now();
  if (CODEX_AVAILABLE && providerHealth.isAvailable('codex')) {
    try {
      const result = await callCodex(prompt, context, options);
      providerHealth.recordSuccess('codex');
      qualityTracker.record('codex', null, true, Date.now() - t0);
      return result;
    } catch (err) { errors.push(`Codex: ${err.message}`); providerHealth.recordFailure('codex'); }
  }
  if (REQUESTY_API_KEY && providerHealth.isAvailable('requesty')) {
    try {
      const result = await callRequesty('deepseek', prompt, context, options.max_tokens || 4096);
      providerHealth.recordSuccess('requesty');
      return result;
    } catch (err) { errors.push(`Requesty: ${err.message}`); providerHealth.recordFailure('requesty'); }
  }
  qualityTracker.record('codex', null, false, Date.now() - t0);
  return makeDelegateResponse(prompt, context, formatErrors(errors));
}

// --- Ralph Loop (Persistent Consult with Model-Based Verification) ---

const RALPH_DEFAULTS = { maxIterations: 3, maxMaxIterations: 5, confidenceThreshold: 0.85, defaultEffort: 'high' };

const DEFAULT_VERIFICATION_CRITERIA = {
  code: 'Output contains syntactically valid, complete code. All functions/classes are fully implemented (no TODOs, placeholders, or ellipsis). Edge cases and error handling are present.',
  docs: 'Documentation is complete, accurate, and covers all mentioned topics. Examples are correct. No placeholders or TODO markers.',
  test: 'Tests cover happy path, edge cases, and error conditions. Assertions are specific. Test structure follows arrange-act-assert.',
  debug: 'Root cause is identified with evidence. Fix addresses root cause, not symptoms. No regressions introduced.',
  security: 'All identified vulnerabilities have specific remediation steps. Severity ratings provided. No critical issues unaddressed.',
  architecture: 'Design addresses all stated requirements. Trade-offs explicitly discussed. No obvious scalability or maintainability gaps.',
  refactor: 'Refactored code preserves existing behavior. No functionality lost. Code is measurably simpler or more maintainable.',
  script: 'Script handles errors gracefully. Input validation present. Script runs to completion on stated inputs.',
  research: 'Analysis covers all requested topics. Claims supported by evidence. Competing perspectives acknowledged.',
};

function pickVerifier(executionProvider) {
  if (executionProvider && executionProvider.startsWith('gemini')) {
    if (COPILOT_AVAILABLE) return { provider: 'copilot', model: 'gpt-4.1' };
    if (OPENROUTER_API_KEY) return { provider: 'openrouter', model: 'deepseek' };
  }
  if (GEMINI_CLI_AVAILABLE || GEMINI_API_KEY) return { provider: 'gemini-flash', model: null };
  if (COPILOT_AVAILABLE) return { provider: 'copilot', model: 'gpt-4.1' };
  if (OPENROUTER_API_KEY) return { provider: 'openrouter', model: 'deepseek' };
  if (REQUESTY_API_KEY) return { provider: 'requesty', model: 'deepseek' };
  return { provider: 'gemini-flash', model: null };
}

// --- Model Escalation Ladder (inspired by obra/superpowers 3-fix escalation) ---
// After repeated failures, escalate to more capable models instead of retrying the same one.

const ESCALATION_LADDER = {
  'local':        ['openrouter', 'gemini-flash', 'gemini-pro', 'opus'],
  'openrouter':   ['gemini-flash', 'gemini-pro', 'copilot', 'opus'],
  'gemini-flash': ['gemini-pro', 'copilot', 'opus'],
  'gemini-pro':   ['copilot', 'opus'],
  'copilot':      ['gemini-pro', 'opus'],
  'codex':        ['gemini-pro', 'opus'],
  'requesty':     ['gemini-pro', 'opus'],
};

function getEscalationTarget(currentProvider, failCount) {
  const ladder = ESCALATION_LADDER[currentProvider] || ['gemini-pro', 'opus'];
  // Pick escalation based on how many failures: index into the ladder
  const idx = Math.min(failCount - 1, ladder.length - 1);
  return ladder[idx] || 'opus';
}

// --- Two-Stage Verification (inspired by obra/superpowers) ---
// Stage 1: Spec compliance — does the output match what was asked?
// Stage 2: Quality check — is the output well-built? (only if spec passes)

function buildSpecVerificationPrompt(originalPrompt, context, output, criteria) {
  return `You are a spec compliance verifier. Your ONLY job is to check whether the output matches what was requested. Do NOT evaluate code quality, style, or best practices — only spec compliance.

The output was produced by another agent. Their self-reported status may be incomplete, inaccurate, or optimistic. You MUST verify everything independently.

## Verification Gate Rules
- You must cite SPECIFIC lines/sections from the output as evidence for each verdict.
- "Looks good" or "seems correct" are NOT acceptable verdicts. Name what you checked.
- If you cannot point to specific evidence that a requirement is met, it is NOT met.
- Absent evidence of completion = incomplete. Do not give benefit of the doubt.

## Original Task
${originalPrompt}
${context ? `\n## Context\n${context}` : ''}

## Spec Compliance Criteria
${criteria}

## Output to Verify
---
${output.slice(0, 12000)}
---

Return ONLY a JSON object (no markdown fences):
{"passed":true/false,"confidence":0.0-1.0,"issues":["specific issue with evidence"],"suggestions":["specific fix"],"summary":"one-line verdict with evidence","evidence":["line/section cited for each check"]}

Be strict. Every requirement must have evidence of completion. Missing evidence = failed.`;
}

function buildQualityVerificationPrompt(originalPrompt, context, output, taskType) {
  const qualityCriteria = {
    code: 'No TODO/placeholder/ellipsis markers. Error handling present. No obvious O(n^2) in hot paths. No hardcoded secrets. No unused imports/variables.',
    test: 'Tests are independent (no shared mutable state). Assertions are specific (not just "truthy"). Edge cases covered. Cleanup/teardown present.',
    security: 'All findings have specific file:line references. Severity ratings justified. Remediation steps are actionable, not generic.',
    architecture: 'Trade-offs have quantified costs. Diagrams match text. No hand-waving ("should scale well" without numbers).',
    debug: 'Root cause has evidence trail. Fix is minimal (doesn\'t refactor unrelated code). Regression test included or noted.',
    docs: 'Examples are runnable. Parameter types match code. No stale references.',
    refactor: 'Behavior preserved (no functional changes). Measurably simpler (fewer lines, fewer branches, or fewer dependencies).',
    script: 'Exit codes meaningful. Errors go to stderr. Idempotent where possible.',
    research: 'Claims cite sources. Uncertainty flagged. Competing views acknowledged.',
  };
  const criteria = qualityCriteria[taskType] || qualityCriteria.code;

  return `You are a quality reviewer. The output already PASSED spec compliance — it does what was asked. Now evaluate whether it is WELL-BUILT.

## Quality Criteria
${criteria}

## Original Task
${originalPrompt}
${context ? `\n## Context\n${context}` : ''}

## Output to Review
---
${output.slice(0, 12000)}
---

Return ONLY a JSON object (no markdown fences):
{"passed":true/false,"confidence":0.0-1.0,"issues":["quality issue"],"suggestions":["improvement"],"summary":"quality verdict"}

Quality issues should not block a DONE verdict unless they indicate the output will cause real problems. Flag concerns, don't fail on style preferences.`;
}

function buildRetryPrompt(originalPrompt, previousOutput, verification, iteration) {
  const issues = verification.issues || [];
  const suggestions = verification.suggestions || [];
  return `${originalPrompt}

---
## Previous Attempt (iteration ${iteration})
${previousOutput.slice(0, 8000)}

## Verification Feedback
The previous output did NOT pass verification.${issues.length > 0 ? `\nIssues:\n${issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}` : ''}${suggestions.length > 0 ? `\nSuggestions:\n${suggestions.map((s, idx) => `${idx + 1}. ${s}`).join('\n')}` : ''}

Produce a corrected, COMPLETE output that addresses ALL issues. Do not describe fixes — produce the full corrected output.`;
}

function parseVerification(text) {
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {}
  // Fallback: regex extraction
  const passed = /passed["']?\s*:\s*true/i.test(text);
  const confMatch = text.match(/confidence["']?\s*:\s*([\d.]+)/);
  return { passed, confidence: confMatch ? parseFloat(confMatch[1]) : 0.5, issues: [], suggestions: [], summary: 'Parsed from unstructured response' };
}

async function callProvider(provider, model, prompt, context, maxTokens, sysPrompt) {
  switch (provider) {
    case 'gemini-pro': return await callGeminiWithFallback('gemini-3.1-pro-preview', prompt, context, maxTokens, sysPrompt);
    case 'gemini-flash': return await callGeminiWithFallback('gemini-3-flash-preview', prompt, context, maxTokens, sysPrompt);
    case 'openrouter': return await callOpenRouterWithFallback(model || 'deepseek', prompt, context, maxTokens, sysPrompt);
    case 'copilot': return await callCopilotWithFallback(model || 'gpt-4.1', prompt, context, maxTokens, sysPrompt);
    case 'codex': return await callCodexWithFallback(prompt, context, { max_tokens: maxTokens });
    case 'requesty': return await callRequestyWithFallback(model || 'deepseek', prompt, context, maxTokens, sysPrompt);
    case 'local': return await callLocalWithFallback(model, prompt, context, maxTokens, sysPrompt);
    default: return await callGeminiWithFallback('gemini-3.1-pro-preview', prompt, context, maxTokens, sysPrompt);
  }
}

async function ralphLoop(prompt, context, options = {}) {
  const maxIter = Math.min(options.maxIterations || RALPH_DEFAULTS.maxIterations, RALPH_DEFAULTS.maxMaxIterations);
  const effort = options.effort || RALPH_DEFAULTS.defaultEffort;
  const { maxTokens } = applyEffort(effort);

  // Resolve execution provider
  let execProvider = options.executeWith || 'auto';
  let execModel = options.executeModel;
  if (execProvider === 'auto') {
    const { score } = scoreComplexity(prompt);
    const intent = classifyIntent(prompt);
    const taskType = intent ? intent.taskType : classifyTaskType(prompt);
    const route = routeTask(score, taskType);
    execProvider = route.model === 'inline' || route.model === 'opus' ? 'gemini-pro' : route.model;
    execModel = route.modelKey || execModel;
  }

  // Resolve verification provider
  const verifyDefault = pickVerifier(execProvider);
  const verifyProvider = options.verifyWith || verifyDefault.provider;
  const verifyModel = options.verifyModel || verifyDefault.model;

  // Resolve criteria
  const intent = classifyIntent(prompt);
  const taskType = intent ? intent.taskType : classifyTaskType(prompt);
  const criteria = options.criteria || DEFAULT_VERIFICATION_CRITERIA[taskType] || DEFAULT_VERIFICATION_CRITERIA.code;

  // Resolve agent template for execution
  const agentName = options.agentTemplate || (intent ? intent.agent : null);
  const agent = agentName ? AGENT_TEMPLATES[agentName] : resolveAgentTemplate(taskType, 7);
  const sysPrompt = agent?.systemPrompt;

  const history = [];
  let currentPrompt = prompt;
  let bestOutput = null;
  let bestConfidence = 0;
  let consecutiveFailures = 0;
  let currentExecProvider = execProvider;
  let escalated = false;
  const t0 = Date.now();

  for (let i = 1; i <= maxIter; i++) {
    // --- 3-Fix Escalation (inspired by obra/superpowers) ---
    // After 2 consecutive failures on the same provider, escalate to a more capable model.
    // This prevents wasting iterations retrying a provider that's clearly not up to the task.
    if (consecutiveFailures >= 2 && !escalated) {
      const escalationTarget = getEscalationTarget(currentExecProvider, consecutiveFailures);
      history.push({
        iteration: i,
        phase: 'escalation',
        from: currentExecProvider,
        to: escalationTarget,
        reason: `${consecutiveFailures} consecutive verification failures — escalating model capability`,
      });
      currentExecProvider = escalationTarget;
      escalated = true;
    }

    // Execute
    let output;
    try {
      output = await callProvider(currentExecProvider, execModel, currentPrompt, context, maxTokens, sysPrompt);
    } catch (err) {
      history.push({ iteration: i, phase: 'execution', error: err.message });
      consecutiveFailures++;
      break;
    }

    // Check for delegate response
    try {
      const parsed = JSON.parse(output);
      if (parsed.delegateTo === 'claude') {
        history.push({ iteration: i, phase: 'execution', delegated: true });
        return { output: JSON.stringify(parsed), iterations: i, verified: false, history, totalMs: Date.now() - t0 };
      }
    } catch {}

    // Parse subagent status if present (DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED)
    const statusMatch = output.match(/STATUS:\s*(DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED)\s*\|/);
    if (statusMatch) {
      const agentStatus = statusMatch[1];
      if (agentStatus === 'BLOCKED') {
        history.push({ iteration: i, phase: 'execution', agentStatus: 'BLOCKED', note: 'Agent reported BLOCKED — escalating' });
        const escalationTarget = getEscalationTarget(currentExecProvider, 3);
        currentExecProvider = escalationTarget;
        escalated = true;
        consecutiveFailures++;
        if (i < maxIter) {
          currentPrompt = buildRetryPrompt(prompt, output, { issues: ['Agent reported BLOCKED'], suggestions: ['Provide more context or use a different approach'] }, i);
        }
        continue;
      }
      if (agentStatus === 'NEEDS_CONTEXT') {
        history.push({ iteration: i, phase: 'execution', agentStatus: 'NEEDS_CONTEXT', output: output.slice(-500) });
        // Return early — the controller needs to provide more context
        return { output, iterations: i, verified: false, agentStatus: 'NEEDS_CONTEXT', history, totalMs: Date.now() - t0 };
      }
    }

    bestOutput = output;

    // --- Two-Stage Verification (inspired by obra/superpowers) ---
    // Stage 1: Spec compliance — does output match what was asked?
    const specVerifyPrompt = buildSpecVerificationPrompt(prompt, context, output, criteria);
    let specVerification;
    try {
      const verifyText = await callProvider(verifyProvider, verifyModel, specVerifyPrompt, null, 2048);
      specVerification = parseVerification(verifyText);
    } catch (err) {
      history.push({ iteration: i, phase: 'spec-verification', error: err.message, note: 'Spec verification failed — returning unverified output' });
      return { output: bestOutput, iterations: i, verified: false, history, totalMs: Date.now() - t0 };
    }

    history.push({
      iteration: i,
      stage: 'spec',
      passed: specVerification.passed,
      confidence: specVerification.confidence,
      issues: specVerification.issues,
      evidence: specVerification.evidence,
      summary: specVerification.summary,
    });

    // If spec fails, skip quality check — retry with spec feedback
    if (!specVerification.passed && specVerification.confidence < RALPH_DEFAULTS.confidenceThreshold) {
      consecutiveFailures++;
      qualityTracker.record(`ralph:${currentExecProvider}`, taskType, false, Date.now() - t0);
      if (i < maxIter) {
        currentPrompt = buildRetryPrompt(prompt, output, specVerification, i);
      }
      continue;
    }

    // Stage 2: Quality check — is the output well-built? (only if spec passed)
    const qualVerifyPrompt = buildQualityVerificationPrompt(prompt, context, output, taskType);
    let qualVerification;
    try {
      const verifyText = await callProvider(verifyProvider, verifyModel, qualVerifyPrompt, null, 2048);
      qualVerification = parseVerification(verifyText);
    } catch (err) {
      // Quality check failed but spec passed — return as verified with note
      history.push({ iteration: i, stage: 'quality', error: err.message, note: 'Quality check failed but spec passed' });
      return { output: bestOutput, iterations: i, verified: true, confidence: specVerification.confidence, history, totalMs: Date.now() - t0 };
    }

    // Combine confidences: spec is gate, quality adjusts confidence
    const combinedConfidence = specVerification.confidence * 0.7 + qualVerification.confidence * 0.3;

    if (combinedConfidence > bestConfidence) {
      bestConfidence = combinedConfidence;
      bestOutput = output;
    }

    history.push({
      iteration: i,
      stage: 'quality',
      passed: qualVerification.passed,
      confidence: qualVerification.confidence,
      issues: qualVerification.issues,
      summary: qualVerification.summary,
    });

    qualityTracker.record(`ralph:${currentExecProvider}`, taskType, specVerification.passed, Date.now() - t0);

    // Spec passed = verified. Quality issues are advisory.
    if (specVerification.passed) {
      consecutiveFailures = 0;
      return {
        output: bestOutput,
        iterations: i,
        verified: true,
        confidence: combinedConfidence,
        specPassed: true,
        qualityPassed: qualVerification.passed,
        qualityIssues: qualVerification.issues,
        ...(escalated && { escalatedFrom: execProvider, escalatedTo: currentExecProvider }),
        history,
        totalMs: Date.now() - t0,
      };
    }

    // Both stages ran but overall not passing — retry
    consecutiveFailures++;
    if (i < maxIter) {
      const mergedIssues = [...(specVerification.issues || []), ...(qualVerification.issues || [])];
      const mergedSuggestions = [...(specVerification.suggestions || []), ...(qualVerification.suggestions || [])];
      currentPrompt = buildRetryPrompt(prompt, output, { issues: mergedIssues, suggestions: mergedSuggestions }, i);
    }
  }

  return {
    output: bestOutput,
    iterations: maxIter,
    verified: false,
    confidence: bestConfidence,
    ...(escalated && { escalatedFrom: execProvider, escalatedTo: currentExecProvider }),
    history,
    totalMs: Date.now() - t0,
  };
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

// --- Structured Subagent Status Protocol (inspired by obra/superpowers) ---
// Every agent must end responses with one of these statuses.
// This replaces free-form "done" messages with actionable, parseable signals.

const SUBAGENT_STATUS_PROTOCOL = `

## Response Status Protocol
End EVERY response with exactly one status line in this format:
STATUS: <status> | <one-line summary>

Valid statuses:
- DONE — Task fully completed, all requirements met, output verified.
- DONE_WITH_CONCERNS — Task completed but with caveats the controller should review.
  Follow with: CONCERNS: <bullet list of specific concerns>
- NEEDS_CONTEXT — Cannot complete without additional information.
  Follow with: NEEDED: <bullet list of what's missing and why>
- BLOCKED — Task cannot be completed at current capability level.
  Follow with: BLOCKED_BY: <specific reason> and SUGGESTION: <what would unblock>

It is always OK to report NEEDS_CONTEXT or BLOCKED. Bad output is worse than no output.
Reporting DONE when the work is incomplete is the worst possible outcome.`;

// --- Red Flag Rationalization Guards (inspired by obra/superpowers) ---
// Empirically-derived anti-patterns that prevent agents from cutting corners.
// Each table targets specific rationalizations that model pressure-tests revealed.

const RED_FLAGS = {
  debugger: `

## Red Flags — Do NOT Rationalize These
| Excuse | Reality |
|--------|---------|
| "I think this fixes it" | You must verify with evidence, not intuition. Run the failing case. |
| "It's probably a race condition" | Name the specific threads/events. "Probably" means you haven't found it yet. |
| "Let me try a quick fix" | Fixes without root cause understanding create new bugs. Diagnose first. |
| "The error message says X, so the fix is Y" | Error messages describe symptoms, not causes. Trace the actual code path. |
| After 3 failed fix attempts | STOP. Question the architecture. Each fix revealing new coupling = systemic issue. |`,

  'test-engineer': `

## Red Flags — Do NOT Rationalize These
| Excuse | Reality |
|--------|---------|
| "Too simple to need tests" | Simple code breaks. The test takes 30 seconds to write. |
| "I tested it manually" | Manual testing proves it works now. Automated tests prove it keeps working. |
| "The implementation is the spec" | Tests-after ask "what does this do?" Tests-first ask "what should this do?" |
| "Mocking that would be too complex" | If it's hard to test, the design needs work. Testing difficulty = design smell. |
| "100% coverage is overkill" | Cover behavior, not lines. Missing an edge case test is how prod breaks. |`,

  'security-auditor': `

## Red Flags — Do NOT Rationalize These
| Excuse | Reality |
|--------|---------|
| "This is internal-only, security doesn't matter" | Internal services get compromised. Zero trust applies everywhere. |
| "The framework handles that" | Verify it. Framework defaults are often insecure. Check the actual config. |
| "Nobody would think to do that" | Attackers think of things developers don't. That's their job. |
| "We'll add auth later" | "Later" means "after the breach". Security is not a feature to be scheduled. |
| "It's just a low-severity finding" | Report ALL findings with evidence. The caller decides severity in context. |`,

  verifier: `

## Red Flags — Do NOT Rationalize These
| Excuse | Reality |
|--------|---------|
| "It looks mostly correct" | "Mostly" means it has bugs. Identify them specifically or verify it passes. |
| "Minor issues, but overall good" | List every issue. The caller decides what's minor. Your job is completeness. |
| "The approach is sound even if incomplete" | Incomplete work that passes verification wastes everyone's downstream time. |
| "They probably meant to..." | Verify what exists, not what was intended. Charitable interpretation hides bugs. |`,

  architect: `

## Red Flags — Do NOT Rationalize These
| Excuse | Reality |
|--------|---------|
| "We can refactor later" | Technical debt accrues interest. Design it right or document the cost explicitly. |
| "This is how everyone does it" | Cargo-culting is not architecture. Justify each decision for THIS system's constraints. |
| "It's flexible enough" | Flexibility without constraints is complexity. Name the specific change scenarios. |
| "Performance won't be an issue" | Do the math. Back-of-envelope calculation or it's a guess, not a decision. |`,
};

// --- Agent Prompt Templates (inspired by OMC/OMX + obra/superpowers behavioral governance) ---

const AGENT_TEMPLATES = {
  'code-reviewer': {
    systemPrompt: `You are an expert code reviewer. Focus on correctness, edge cases, performance, and maintainability. Be specific about line-level issues. Flag potential bugs, suggest improvements.

Violating the letter of the rules is violating the spirit of the rules.${SUBAGENT_STATUS_PROTOCOL}`,
    preferredModel: 'inline',
    taskTypes: ['code', 'refactor'],
    complexityRange: [5, 8],
  },
  'security-auditor': {
    systemPrompt: `You are a security auditor. Systematically check for injection, auth bypass, SSRF, data exposure, and supply chain risks. Reference OWASP categories. Provide severity ratings.

Violating the letter of the rules is violating the spirit of the rules.${RED_FLAGS['security-auditor']}${SUBAGENT_STATUS_PROTOCOL}`,
    preferredModel: 'opus',
    taskTypes: ['security'],
    complexityRange: [5, 10],
  },
  'doc-writer': {
    systemPrompt: `You are a technical writer. Write clear, concise documentation with examples. Follow the existing doc style. Include parameter descriptions and return values.${SUBAGENT_STATUS_PROTOCOL}`,
    preferredModel: 'gemini-flash',
    taskTypes: ['docs'],
    complexityRange: [0, 6],
  },
  'architect': {
    systemPrompt: `You are a software architect. Consider scalability, maintainability, separation of concerns, and operational complexity. Justify tradeoffs explicitly. Produce diagrams when helpful.

Violating the letter of the rules is violating the spirit of the rules.${RED_FLAGS.architect}${SUBAGENT_STATUS_PROTOCOL}`,
    preferredModel: 'opus',
    taskTypes: ['architecture'],
    complexityRange: [7, 10],
  },
  'test-engineer': {
    systemPrompt: `You are a test engineer. Write thorough tests covering happy paths, edge cases, error conditions, and boundary values. Structure tests clearly with arrange-act-assert pattern.

Violating the letter of the rules is violating the spirit of the rules.${RED_FLAGS['test-engineer']}${SUBAGENT_STATUS_PROTOCOL}`,
    preferredModel: 'codex',
    taskTypes: ['test'],
    complexityRange: [3, 8],
  },
  'debugger': {
    systemPrompt: `You are a debugging specialist. Systematically isolate the root cause through hypothesis testing. Check recent changes, dependency versions, and environment differences. Provide fix with explanation.

Phase 1: OBSERVE — Read errors, logs, and recent changes. Form hypotheses.
Phase 2: ISOLATE — Narrow to smallest reproducing case.
Phase 3: FIX — Address root cause, not symptoms. Verify fix doesn't regress.

If < 3 fix attempts: return to Phase 1, re-analyze with new information.
If >= 3 fix attempts: STOP. Question the architecture. Pattern indicators of systemic issues:
  - Each fix reveals new coupling in a different place
  - Fixes require "massive refactoring" to work
  - Each fix creates new symptoms elsewhere

Violating the letter of the rules is violating the spirit of the rules.${RED_FLAGS.debugger}${SUBAGENT_STATUS_PROTOCOL}`,
    preferredModel: 'opus',
    taskTypes: ['debug'],
    complexityRange: [5, 10],
  },
  'script-writer': {
    systemPrompt: `You are a shell/scripting expert. Write robust scripts with error handling, input validation, and clear comments. Prefer POSIX compatibility unless bash-specific features are needed.${SUBAGENT_STATUS_PROTOCOL}`,
    preferredModel: 'openrouter',
    modelKey: 'deepseek',
    taskTypes: ['script'],
    complexityRange: [0, 6],
  },
  'researcher': {
    systemPrompt: `You are a technical researcher. Synthesize information from multiple sources, compare approaches objectively, and cite specific evidence. Flag uncertainty explicitly.

Never claim confidence you don't have. "I don't know" is always acceptable. Distinguish between:
- What the evidence shows (cite it)
- What you infer from the evidence (flag it)
- What you're uncertain about (say so)${SUBAGENT_STATUS_PROTOCOL}`,
    preferredModel: 'gemini-pro',
    taskTypes: ['research'],
    complexityRange: [5, 10],
  },
  'performance-reviewer': {
    systemPrompt: `You are a performance engineer. Profile bottlenecks, identify O(n^2) patterns, check memory allocations, evaluate caching strategies, and suggest concrete optimizations with expected impact.

Always quantify: "slow" means nothing. "O(n^2) with n=10k entries = ~100M ops" means something.${SUBAGENT_STATUS_PROTOCOL}`,
    preferredModel: 'opus',
    taskTypes: ['code', 'refactor'],
    complexityRange: [7, 10],
  },
  'api-reviewer': {
    systemPrompt: `You are an API design reviewer. Evaluate REST/GraphQL design for consistency, versioning, error responses, pagination, idempotency, and backward compatibility.${SUBAGENT_STATUS_PROTOCOL}`,
    preferredModel: 'inline',
    taskTypes: ['code', 'architecture'],
    complexityRange: [5, 8],
  },
  'explorer': {
    systemPrompt: `You are a codebase explorer. Quickly identify relevant files, symbols, and patterns. Provide concise summaries of code structure and data flow.${SUBAGENT_STATUS_PROTOCOL}`,
    preferredModel: 'local',
    taskTypes: ['research', 'code'],
    complexityRange: [0, 4],
  },
  'product-analyst': {
    systemPrompt: `You are a product analyst. Evaluate features from user impact, technical feasibility, and business value perspectives. Provide structured recommendations with pros/cons.${SUBAGENT_STATUS_PROTOCOL}`,
    preferredModel: 'gemini-pro',
    taskTypes: ['research', 'architecture'],
    complexityRange: [5, 8],
  },
  'verifier': {
    systemPrompt: `You are a strict verification agent. Evaluate outputs against specific criteria. Be thorough but fair. Return structured JSON verdicts. Flag incomplete work, placeholder content, and logical errors.

The output you are verifying was produced by another agent. Their self-reported status may be incomplete, inaccurate, or optimistic. You MUST verify everything independently.

Violating the letter of the rules is violating the spirit of the rules.${RED_FLAGS.verifier}${SUBAGENT_STATUS_PROTOCOL}`,
    preferredModel: 'gemini-flash',
    taskTypes: ['code', 'docs', 'test', 'debug', 'security', 'architecture', 'refactor', 'script', 'research'],
    complexityRange: [0, 10],
  },
};

function resolveAgentTemplate(taskType, score) {
  let best = null, bestScore = -1;
  for (const [name, tmpl] of Object.entries(AGENT_TEMPLATES)) {
    if (!tmpl.taskTypes.includes(taskType)) continue;
    if (score < tmpl.complexityRange[0] || score > tmpl.complexityRange[1]) continue;
    // Prefer narrower range (more specialized)
    const rangeWidth = tmpl.complexityRange[1] - tmpl.complexityRange[0];
    const specificity = 10 - rangeWidth;
    if (specificity > bestScore) { bestScore = specificity; best = { name, ...tmpl }; }
  }
  return best;
}

// --- Intent Classification (inspired by OMX intent-first routing) ---

const INTENT_TRIGGERS = {
  'write-tests':       { keywords: ['write test', 'unit test', 'add test', 'test coverage', 'write spec', 'integration test'], taskType: 'test', agent: 'test-engineer' },
  'fix-bug':           { keywords: ['fix bug', 'fix error', 'fix crash', 'fix failing', 'broken', 'not working'], taskType: 'debug', agent: 'debugger' },
  'security-review':   { keywords: ['security review', 'vulnerability', 'audit security', 'check for injection', 'owasp', 'penetration'], taskType: 'security', agent: 'security-auditor' },
  'write-docs':        { keywords: ['write docs', 'add documentation', 'write readme', 'jsdoc', 'docstring', 'api docs'], taskType: 'docs', agent: 'doc-writer' },
  'code-review':       { keywords: ['code review', 'review this', 'review code', 'check this code', 'review my'], taskType: 'code', agent: 'code-reviewer' },
  'refactor':          { keywords: ['refactor', 'restructure', 'reorganize', 'clean up code', 'simplify code'], taskType: 'refactor', agent: 'code-reviewer' },
  'architecture':      { keywords: ['design system', 'architect', 'system design', 'data model', 'schema design', 'design pattern'], taskType: 'architecture', agent: 'architect' },
  'research':          { keywords: ['research', 'investigate', 'compare option', 'evaluate', 'survey', 'benchmark'], taskType: 'research', agent: 'researcher' },
  'performance':       { keywords: ['optimize', 'performance', 'slow query', 'latency', 'profil', 'bottleneck', 'memory leak'], taskType: 'code', agent: 'performance-reviewer' },
  'bash-script':       { keywords: ['bash script', 'shell script', 'write script', 'automation script', 'cron job'], taskType: 'script', agent: 'script-writer' },
  'api-design':        { keywords: ['api design', 'rest api', 'graphql schema', 'endpoint design', 'api contract'], taskType: 'architecture', agent: 'api-reviewer' },
  'implement-feature': { keywords: ['implement', 'build feature', 'create feature', 'add feature', 'new feature'], taskType: 'code', agent: 'code-reviewer' },
};

function classifyIntent(description) {
  const desc = description.toLowerCase();
  let bestIntent = null, bestMatches = 0;
  for (const [intent, config] of Object.entries(INTENT_TRIGGERS)) {
    const matches = config.keywords.filter(k => desc.includes(k)).length;
    if (matches > bestMatches) {
      bestMatches = matches;
      bestIntent = { intent, taskType: config.taskType, agent: config.agent, confidence: Math.min(1, matches * 0.3) };
    }
  }
  return bestIntent && bestIntent.confidence >= 0.3 ? bestIntent : null;
}

async function callFirecrawl(action, params) {
  if (!FIRECRAWL_API_KEY) {
    throw new Error("FIRECRAWL_API_KEY not set");
  }

  const baseUrl = 'https://api.firecrawl.dev/v1';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
  };

  let url, body;
  switch (action) {
    case 'scrape':
      url = `${baseUrl}/scrape`;
      body = {
        url: params.url,
        formats: params.formats || ['markdown'],
        ...(params.onlyMainContent !== undefined && { onlyMainContent: params.onlyMainContent }),
        ...(params.waitFor && { waitFor: params.waitFor }),
      };
      break;
    case 'crawl':
      url = `${baseUrl}/crawl`;
      body = {
        url: params.url,
        ...(params.limit && { limit: params.limit }),
        ...(params.maxDepth && { maxDepth: params.maxDepth }),
        ...(params.includePaths && { includePaths: params.includePaths }),
        ...(params.excludePaths && { excludePaths: params.excludePaths }),
      };
      break;
    case 'map':
      url = `${baseUrl}/map`;
      body = {
        url: params.url,
        ...(params.search && { search: params.search }),
        ...(params.limit && { limit: params.limit }),
      };
      break;
    case 'search':
      url = `${baseUrl}/search`;
      body = {
        query: params.query,
        ...(params.limit && { limit: params.limit }),
        ...(params.lang && { lang: params.lang }),
        ...(params.country && { country: params.country }),
        ...(params.scrapeOptions && { scrapeOptions: params.scrapeOptions }),
      };
      break;
    default:
      throw new Error(`Unknown firecrawl action: ${action}. Use scrape, crawl, map, or search.`);
  }

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Firecrawl API error ${response.status}: ${err}`);
  }

  const data = await response.json();

  // For crawl, it returns a job ID — poll for completion
  if (action === 'crawl' && data.id) {
    const pollUrl = `${baseUrl}/crawl/${data.id}`;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const pollResp = await fetch(pollUrl, { headers: { 'Authorization': `Bearer ${FIRECRAWL_API_KEY}` } });
      if (!pollResp.ok) continue;
      const pollData = await pollResp.json();
      if (pollData.status === 'completed') return pollData;
      if (pollData.status === 'failed') throw new Error(`Crawl failed: ${JSON.stringify(pollData)}`);
    }
    throw new Error('Crawl timed out after 60 seconds');
  }

  return data;
}

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

  // Weighted combination
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
    orchestration: ['multi-agent', 'governance', 'budget', 'company', 'approval gate', 'org chart', 'hire agent', 'paperclip', 'orchestrate', 'fleet', 'heartbeat'],
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
    { maxScore: 8,  types: ['orchestration'], model: 'opus',         reason: 'Multi-agent orchestration — Opus' },
    { maxScore: 10, types: ['architecture', 'security'], model: 'opus', reason: 'Expert architecture/security — Opus' },
    { maxScore: 10, types: ['research'],      model: 'gemini-pro',   reason: 'Expert research — Gemini Pro' },
    { maxScore: 10, types: ['orchestration'], model: 'opus',         reason: 'Expert orchestration — Opus' },
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
    { server: 'firecrawl', tool: 'consult_firecrawl', when: 'Need to scrape full page content or crawl documentation sites' },
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
  orchestration: [
    { server: 'paperclip', tool: 'pc_company_status', when: 'Check current agent company status before planning' },
    { server: 'paperclip', tool: 'pc_task_create', when: 'Create governed task for agent assignment' },
    { server: 'paperclip', tool: 'pc_agent_list', when: 'Check available agents before task assignment' },
    { server: 'ntm', tool: 'ntm_spawn', when: 'Need to spawn new agent processes for the task' },
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
    extras.push({ server: 'firecrawl', tool: 'consult_firecrawl', when: 'Scrape/crawl web pages for full markdown content' });
  }
  if (/\b(site\s+map|discover\s+urls|crawl\s+site|full\s+site|all\s+pages|documentation\s+site|docs\s+site)\b/.test(desc)) {
    extras.push({ server: 'firecrawl', tool: 'consult_firecrawl', when: 'Map or crawl entire site for URLs/content' });
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
  { name: "multi-model-router", version: "3.1.0" },
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
          effort: {
            type: "string",
            enum: ["low", "medium", "high", "xhigh"],
            description: "Reasoning effort level — adjusts max tokens and routing (default: medium)",
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
          effort: {
            type: "string",
            enum: ["low", "medium", "high", "xhigh"],
            description: "Reasoning effort level — adjusts max tokens and routing (default: medium)",
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
          effort: {
            type: "string",
            enum: ["low", "medium", "high", "xhigh"],
            description: "Reasoning effort level — adjusts max tokens and routing (default: medium)",
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
          effort: {
            type: "string",
            enum: ["low", "medium", "high", "xhigh"],
            description: "Reasoning effort level — adjusts max tokens and routing (default: medium)",
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
            description: "Codex model to use (default: gpt-5.3-codex). Any valid Codex model name accepted.",
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
      name: "consult_copilot",
      description:
        "Consult GitHub Copilot API. Access GPT-5.4, GPT-4.1, Claude Sonnet 4.6, Claude Opus 4.6, o4-mini, and Gemini 3 Flash/Pro through GitHub's Copilot infrastructure. Requires GITHUB_TOKEN or GH_TOKEN. Best for: code completion, code review, quick code tasks using GitHub-hosted models.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The task or question",
          },
          model: {
            type: "string",
            description: "Copilot model to use (default: gpt-4.1)",
            enum: [
              "gpt-4.1",
              "gpt-4.1-mini",
              "gpt-5.4",
              "gpt-5.4-mini",
              "claude-sonnet",
              "claude-opus",
              "o4-mini",
              "gemini",
              "gemini-pro",
            ],
          },
          context: {
            type: "string",
            description: "Optional additional context (code, file contents)",
          },
          max_tokens: {
            type: "number",
            description: "Maximum output tokens (default: 4096)",
          },
          effort: {
            type: "string",
            enum: ["low", "medium", "high", "xhigh"],
            description: "Reasoning effort level — adjusts max tokens and routing (default: medium)",
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
          effort: {
            type: "string",
            enum: ["low", "medium", "high", "xhigh"],
            description: "Reasoning effort level — adjusts max tokens and routing (default: medium)",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "consult_firecrawl",
      description:
        "Use Firecrawl to scrape, crawl, map, or search web content. Actions: 'scrape' (single URL to markdown), 'crawl' (multi-page site crawl), 'map' (discover URLs on a site), 'search' (web search with full page content). Returns clean markdown content from web pages.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["scrape", "crawl", "map", "search"],
            description: "The Firecrawl action: scrape (single page), crawl (multi-page), map (discover URLs), search (web search)",
          },
          url: {
            type: "string",
            description: "URL to scrape, crawl, or map (required for scrape/crawl/map)",
          },
          query: {
            type: "string",
            description: "Search query (required for search action)",
          },
          limit: {
            type: "number",
            description: "Max pages to crawl/return (default: 10 for crawl, 5 for search/map)",
          },
          max_depth: {
            type: "number",
            description: "Max crawl depth (default: 2, for crawl action only)",
          },
          formats: {
            type: "array",
            items: { type: "string" },
            description: "Output formats for scrape: ['markdown'], ['html'], ['markdown', 'html'] (default: ['markdown'])",
          },
          include_paths: {
            type: "array",
            items: { type: "string" },
            description: "URL path patterns to include during crawl (e.g., ['/docs/*'])",
          },
          exclude_paths: {
            type: "array",
            items: { type: "string" },
            description: "URL path patterns to exclude during crawl (e.g., ['/blog/*'])",
          },
          search_query: {
            type: "string",
            description: "Filter URLs containing this search term (for map action)",
          },
        },
        required: ["action"],
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
    {
      name: "bead_orchestrate",
      description:
        "Agent Flywheel bead orchestration: decomposes requirements into beads (self-contained work units), scores complexity, routes to optimal models, and optionally creates Paperclip governance tasks for each bead. Returns a bead execution plan with task IDs.",
      inputSchema: {
        type: "object",
        properties: {
          requirements: {
            type: "string",
            description: "Requirements to decompose into beads",
          },
          context: {
            type: "string",
            description: "Additional context (existing code, architecture notes)",
          },
          governance: {
            type: "boolean",
            description: "Create Paperclip governance tasks for each bead (default: true)",
          },
          budget_limit_cents: {
            type: "number",
            description: "Maximum budget in cents for this bead set",
          },
          project_name: {
            type: "string",
            description: "Project name for Paperclip company (default: 'flywheel')",
          },
        },
        required: ["requirements"],
      },
    },
    {
      name: "list_agent_templates",
      description:
        "List all available agent prompt templates with their roles, system prompts, preferred models, and task type mappings. Useful for understanding how the router specializes prompts for different task types.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "router_stats",
      description:
        "Get response quality statistics and provider health status. Shows success rates, latency, and circuit breaker states for all providers. Use to monitor router performance and diagnose provider issues.",
      inputSchema: {
        type: "object",
        properties: {
          model: {
            type: "string",
            description: "Filter stats to a specific model/provider (optional)",
          },
          task_type: {
            type: "string",
            description: "Filter stats to a specific task type (optional)",
          },
        },
        required: [],
      },
    },
    {
      name: "persistent_consult",
      description:
        "Ralph loop: persistent task execution with model-based verification. Executes task with one model, verifies output with a different model, retries with critique feedback until verification passes or max iterations reached. Use for tasks where correctness matters more than speed. 'The boulder never stops.'",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The task to execute persistently",
          },
          context: {
            type: "string",
            description: "Optional additional context (code, requirements, existing output to improve)",
          },
          execute_with: {
            type: "string",
            enum: ["gemini-pro", "gemini-flash", "openrouter", "copilot", "codex", "requesty", "local", "auto"],
            description: "Model/provider for execution (default: auto-routed based on complexity)",
          },
          execute_model: {
            type: "string",
            description: "Specific model key for execution provider (e.g., 'deepseek', 'qwen', 'gpt-4.1')",
          },
          verify_with: {
            type: "string",
            enum: ["gemini-pro", "gemini-flash", "openrouter", "copilot", "requesty", "local"],
            description: "Model/provider for verification (default: auto-selected, different from executor)",
          },
          verify_model: {
            type: "string",
            description: "Specific model key for verification provider",
          },
          verification_criteria: {
            type: "string",
            description: "Custom criteria for what 'done' looks like. If omitted, inferred from task type.",
          },
          max_iterations: {
            type: "number",
            description: "Maximum execute-verify cycles (default: 3, max: 5)",
          },
          effort: {
            type: "string",
            enum: ["low", "medium", "high", "xhigh"],
            description: "Reasoning effort level (default: high — Ralph tasks are inherently high-effort)",
          },
          agent_template: {
            type: "string",
            description: "Force a specific agent template (e.g., 'code-reviewer', 'architect'). If omitted, auto-detected.",
          },
        },
        required: ["prompt"],
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
          name: "Qwen 3.6 Plus",
          id: OPENROUTER_MODELS.qwen,
          tool: "consult_openrouter (model='qwen')",
          status: OPENROUTER_API_KEY ? "AVAILABLE" : "UNAVAILABLE (no OPENROUTER_API_KEY)",
          bestFor: "Code generation, multilingual tasks",
        },
        {
          name: "GLM-5 Turbo",
          id: OPENROUTER_MODELS.glm,
          tool: "consult_openrouter (model='glm')",
          status: OPENROUTER_API_KEY ? "AVAILABLE" : "UNAVAILABLE (no OPENROUTER_API_KEY)",
          bestFor: "General code tasks",
        },
        {
          name: "Minimax M2.7",
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

      const copilotModels = [
        {
          name: "GitHub Copilot (GPT-5.4)",
          id: "copilot/gpt-5.4",
          tool: "consult_copilot (model='gpt-5.4')",
          status: COPILOT_AVAILABLE ? "AVAILABLE" : "UNAVAILABLE (set GITHUB_TOKEN or GH_TOKEN)",
          bestFor: "Latest GPT model — code generation, complex reasoning via GitHub Copilot",
        },
        {
          name: "GitHub Copilot (GPT-4.1)",
          id: "copilot/gpt-4.1",
          tool: "consult_copilot (model='gpt-4.1')",
          status: COPILOT_AVAILABLE ? "AVAILABLE" : "UNAVAILABLE (set GITHUB_TOKEN or GH_TOKEN)",
          bestFor: "Advanced code generation, complex reasoning via GitHub Copilot",
        },
        {
          name: "GitHub Copilot (Claude Sonnet 4.6)",
          id: "copilot/claude-sonnet",
          tool: "consult_copilot (model='claude-sonnet')",
          status: COPILOT_AVAILABLE ? "AVAILABLE" : "UNAVAILABLE (set GITHUB_TOKEN or GH_TOKEN)",
          bestFor: "Claude Sonnet via GitHub's infrastructure — alternative routing path",
        },
        {
          name: "GitHub Copilot (Claude Opus 4.6)",
          id: "copilot/claude-opus",
          tool: "consult_copilot (model='claude-opus')",
          status: COPILOT_AVAILABLE ? "AVAILABLE" : "UNAVAILABLE (set GITHUB_TOKEN or GH_TOKEN)",
          bestFor: "Claude Opus via GitHub's infrastructure — highest capability",
        },
        {
          name: "GitHub Copilot (o4-mini)",
          id: "copilot/o4-mini",
          tool: "consult_copilot (model='o4-mini')",
          status: COPILOT_AVAILABLE ? "AVAILABLE" : "UNAVAILABLE (set GITHUB_TOKEN or GH_TOKEN)",
          bestFor: "Reasoning-heavy tasks via GitHub Copilot",
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

      const firecrawlModels = [{
            name: "Firecrawl (Web Scraping & Crawling)",
            id: "firecrawl-api",
            tool: "consult_firecrawl",
            status: FIRECRAWL_API_KEY ? "AVAILABLE" : "UNAVAILABLE (no FIRECRAWL_API_KEY)",
            bestFor: "Web scraping, site crawling, URL mapping, web search with full page content as markdown",
          }];

      const allModels = [...models, ...reqModels, ...codexModels, ...copilotModels, ...localModels, ...firecrawlModels];
      const health = providerHealth.getStatus();
      const output = allModels
        .map(
          (m) =>
            `**${m.name}** (${m.id})\n  Tool: ${m.tool}\n  Status: ${m.status}\n  Best for: ${m.bestFor}`
        )
        .join("\n\n");

      const healthOutput = Object.keys(health).length > 0
        ? '\n\n---\n**Provider Health (Circuit Breaker)**\n' + Object.entries(health).map(([name, h]) =>
            `- ${name}: ${h.state} (${h.recentFailures} recent failures)`).join('\n')
        : '';

      return { content: [{ type: "text", text: output + healthOutput }] };
    }

    if (name === "list_agent_templates") {
      const output = Object.entries(AGENT_TEMPLATES).map(([name, tmpl]) =>
        `**${name}**\n  System prompt: ${tmpl.systemPrompt.slice(0, 100)}...\n  Preferred model: ${tmpl.preferredModel}\n  Task types: ${tmpl.taskTypes.join(', ')}\n  Complexity range: ${tmpl.complexityRange[0]}-${tmpl.complexityRange[1]}`
      ).join('\n\n');
      return { content: [{ type: "text", text: `## Agent Templates (${Object.keys(AGENT_TEMPLATES).length})\n\n${output}` }] };
    }

    if (name === "router_stats") {
      const health = providerHealth.getStatus();
      const stats = args.model || args.task_type
        ? { [args.model || 'all']: qualityTracker.getStats(args.model, args.task_type) }
        : qualityTracker.getAllStats();

      let output = '## Router Stats\n\n### Provider Health\n';
      if (Object.keys(health).length === 0) {
        output += 'No provider data yet (no calls made).\n';
      } else {
        for (const [name, h] of Object.entries(health)) {
          output += `- **${name}**: ${h.state} (${h.recentFailures} recent failures)\n`;
        }
      }

      output += '\n### Quality Tracking\n';
      if (Object.keys(stats).length === 0) {
        output += 'No quality data yet.\n';
      } else {
        for (const [model, data] of Object.entries(stats)) {
          if (!data) continue;
          if (data.total !== undefined) {
            output += `- **${model}**: ${(data.successRate * 100).toFixed(0)}% success (${data.total} calls, avg ${data.avgLatencyMs}ms)\n`;
          } else {
            output += `\n**${model}**:\n`;
            for (const [key, s] of Object.entries(data)) {
              if (s) output += `  - ${key}: ${(s.successRate * 100).toFixed(0)}% success (${s.total} calls, avg ${s.avgLatencyMs}ms)\n`;
            }
          }
        }
      }

      output += `\n### Effort Levels\n`;
      for (const [level, cfg] of Object.entries(EFFORT_LEVELS)) {
        output += `- **${level}**: maxTokens=${cfg.maxTokens}, scoreBoost=${cfg.scoreBoost > 0 ? '+' : ''}${cfg.scoreBoost}, tier=${cfg.modelTier}\n`;
      }

      return { content: [{ type: "text", text: output }] };
    }

    if (name === "consult_gemini_pro") {
      const { maxTokens } = applyEffort(args.effort, args.max_tokens);
      const template = resolveAgentTemplate('research', 7);
      const text = await callGeminiWithFallback(
        "gemini-3.1-pro-preview", args.prompt, args.context, maxTokens,
        template?.systemPrompt
      );
      return { content: [{ type: "text", text }] };
    }

    if (name === "consult_gemini_flash") {
      const { maxTokens } = applyEffort(args.effort, args.max_tokens || 4096);
      const template = resolveAgentTemplate('docs', 3);
      const text = await callGeminiWithFallback(
        "gemini-3-flash-preview", args.prompt, args.context, maxTokens,
        template?.systemPrompt
      );
      return { content: [{ type: "text", text }] };
    }

    if (name === "consult_openrouter") {
      const { maxTokens } = applyEffort(args.effort, args.max_tokens);
      const intent = classifyIntent(args.prompt);
      const template = intent ? AGENT_TEMPLATES[intent.agent] : resolveAgentTemplate('script', 3);
      const text = await callOpenRouterWithFallback(
        args.model || "deepseek", args.prompt, args.context, maxTokens,
        template?.systemPrompt
      );
      return { content: [{ type: "text", text }] };
    }

    if (name === "consult_requesty") {
      const { maxTokens } = applyEffort(args.effort, args.max_tokens);
      const intent = classifyIntent(args.prompt);
      const template = intent ? AGENT_TEMPLATES[intent.agent] : null;
      const text = await callRequestyWithFallback(
        args.model || "deepseek", args.prompt, args.context, maxTokens,
        template?.systemPrompt
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
      const { maxTokens } = applyEffort(args.effort, args.max_tokens);
      const text = await callCodexWithFallback(
        args.prompt, args.context,
        { model: args.model, sandbox: args.sandbox, fullAuto: args.full_auto, timeout: args.timeout, max_tokens: maxTokens }
      );
      return { content: [{ type: "text", text }] };
    }

    if (name === "consult_copilot") {
      if (!COPILOT_AVAILABLE) {
        return {
          content: [{ type: "text", text: "Error: GITHUB_TOKEN or GH_TOKEN not set. Run: gh auth login, then export GH_TOKEN=$(gh auth token)" }],
          isError: true,
        };
      }
      const { maxTokens } = applyEffort(args.effort, args.max_tokens);
      const intent = classifyIntent(args.prompt);
      const template = intent ? AGENT_TEMPLATES[intent.agent] : null;
      const text = await callCopilotWithFallback(
        args.model || "gpt-4.1", args.prompt, args.context, maxTokens,
        template?.systemPrompt
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
      const { maxTokens } = applyEffort(args.effort, args.max_tokens);
      const intent = classifyIntent(args.prompt);
      const template = intent ? AGENT_TEMPLATES[intent.agent] : null;
      const text = await callLocalWithFallback(
        args.model, args.prompt, args.context, maxTokens,
        template?.systemPrompt
      );
      return { content: [{ type: "text", text }] };
    }

    if (name === "consult_firecrawl") {
      if (!FIRECRAWL_API_KEY) {
        return {
          content: [{ type: "text", text: "Error: FIRECRAWL_API_KEY not set. Get one at https://firecrawl.dev" }],
          isError: true,
        };
      }
      const params = {};
      if (args.url) params.url = args.url;
      if (args.query) params.query = args.query;
      if (args.limit) params.limit = args.limit;
      if (args.max_depth) params.maxDepth = args.max_depth;
      if (args.formats) params.formats = args.formats;
      if (args.include_paths) params.includePaths = args.include_paths;
      if (args.exclude_paths) params.excludePaths = args.exclude_paths;
      if (args.search_query) params.search = args.search_query;

      const result = await callFirecrawl(args.action, params);

      // Format output based on action
      let output;
      if (args.action === 'scrape') {
        output = result.data?.markdown || result.data?.html || JSON.stringify(result.data);
      } else if (args.action === 'search') {
        const items = result.data || [];
        output = items.map((item, i) => `### ${i + 1}. ${item.title || item.url}\n${item.url}\n\n${(item.markdown || item.description || '').slice(0, 2000)}`).join('\n\n---\n\n');
      } else if (args.action === 'map') {
        const links = result.links || result.data || [];
        output = `Found ${links.length} URLs:\n\n${(Array.isArray(links) ? links : []).map(l => typeof l === 'string' ? `- ${l}` : `- ${l.url || JSON.stringify(l)}`).join('\n')}`;
      } else if (args.action === 'crawl') {
        const pages = result.data || [];
        output = `Crawled ${pages.length} pages:\n\n${pages.map((p, i) => `### Page ${i + 1}: ${p.metadata?.title || p.url || 'Unknown'}\n${(p.markdown || '').slice(0, 1500)}`).join('\n\n---\n\n')}`;
      } else {
        output = JSON.stringify(result, null, 2);
      }

      return { content: [{ type: "text", text: output }] };
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

    if (name === "persistent_consult") {
      const result = await ralphLoop(args.prompt, args.context, {
        executeWith: args.execute_with,
        executeModel: args.execute_model,
        verifyWith: args.verify_with,
        verifyModel: args.verify_model,
        criteria: args.verification_criteria,
        maxIterations: args.max_iterations,
        effort: args.effort,
        agentTemplate: args.agent_template,
      });

      let output = `## Persistent Consult (Ralph Loop v2)\n\n`;
      output += `**Status**: ${result.verified ? 'VERIFIED' : 'UNVERIFIED'} (${result.iterations} iteration${result.iterations > 1 ? 's' : ''})`;
      if (result.confidence !== undefined) output += ` | **Confidence**: ${(result.confidence * 100).toFixed(0)}%`;
      if (result.specPassed !== undefined) output += ` | **Spec**: ${result.specPassed ? 'PASS' : 'FAIL'}`;
      if (result.qualityPassed !== undefined) output += ` | **Quality**: ${result.qualityPassed ? 'PASS' : 'ADVISORY'}`;
      if (result.escalatedFrom) output += `\n**Escalated**: ${result.escalatedFrom} → ${result.escalatedTo}`;
      if (result.agentStatus) output += `\n**Agent Status**: ${result.agentStatus}`;
      output += `\n**Time**: ${(result.totalMs / 1000).toFixed(1)}s\n\n`;

      // Show quality issues as advisory even when verified
      if (result.qualityIssues?.length > 0) {
        output += `### Quality Advisory\n`;
        result.qualityIssues.forEach(issue => { output += `- ${issue}\n`; });
        output += `\n`;
      }

      output += `### Output\n\n${result.output}\n\n`;

      if (result.history.length > 0) {
        output += `### Verification History\n`;
        for (const h of result.history) {
          if (h.error) {
            output += `- Iteration ${h.iteration}: ERROR (${h.phase || h.stage}) — ${h.error}\n`;
          } else if (h.delegated) {
            output += `- Iteration ${h.iteration}: Delegated to Claude\n`;
          } else if (h.phase === 'escalation') {
            output += `- Iteration ${h.iteration}: ESCALATED ${h.from} → ${h.to} (${h.reason})\n`;
          } else if (h.agentStatus) {
            output += `- Iteration ${h.iteration}: Agent reported ${h.agentStatus}\n`;
          } else {
            const stageLabel = h.stage ? ` [${h.stage}]` : '';
            output += `- Iteration ${h.iteration}${stageLabel}: ${h.passed ? 'PASSED' : 'FAILED'} (confidence: ${((h.confidence || 0) * 100).toFixed(0)}%)`;
            if (h.issues?.length > 0) output += ` — ${h.issues.join('; ')}`;
            if (h.evidence?.length > 0) output += ` | evidence: ${h.evidence.length} items`;
            output += `\n`;
          }
        }
      }

      return {
        content: [
          { type: "text", text: output },
          { type: "text", text: JSON.stringify(result) },
        ],
      };
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

      // Step 2: Score, classify, and route each subtask (with intent + agent templates)
      const tasks = subtasks.map(st => {
        const complexity = scoreComplexity(st.description);
        const intent = classifyIntent(st.description);
        const taskType = intent ? intent.taskType : classifyTaskType(st.description);
        const route = routeTask(complexity.score, taskType);
        const mcpTools = recommendMCPTools(taskType, st.description);
        const agent = intent ? AGENT_TEMPLATES[intent.agent] : resolveAgentTemplate(taskType, complexity.score);

        return {
          id: st.id,
          title: st.title,
          description: st.description,
          dependencies: st.dependencies || [],
          complexity: { score: complexity.score, features: complexity.features, indicators: complexity.indicators },
          taskType,
          ...(intent && { intent: intent.intent }),
          ...(agent && { agent: agent.name || intent?.agent }),
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
        if (task.intent) output += `  - Intent: ${task.intent}${task.agent ? ` → agent: ${task.agent}` : ''}\n`;
        else if (task.agent) output += `  - Agent: ${task.agent}\n`;
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
              // Resolve agent system prompt for this task
              const taskAgent = task.agent ? AGENT_TEMPLATES[task.agent] : resolveAgentTemplate(task.taskType, task.complexity?.score || 5);
              const sysPrompt = taskAgent?.systemPrompt;

              switch (task.route.model) {
                case 'gemini-flash':
                  result = { model: 'gemini-flash', output: await callGeminiWithFallback('gemini-3-flash-preview', taskPrompt, null, 4096, sysPrompt) };
                  break;
                case 'gemini-pro':
                  result = { model: 'gemini-pro', output: await callGeminiWithFallback('gemini-3.1-pro-preview', taskPrompt, null, 8192, sysPrompt) };
                  break;
                case 'openrouter':
                  result = { model: task.route.modelKey || 'deepseek', output: await callOpenRouterWithFallback(task.route.modelKey || 'deepseek', taskPrompt, null, 4096, sysPrompt) };
                  break;
                case 'local':
                  if (LOCAL_SERVER_INFO.available) {
                    result = { model: `local(${LOCAL_SERVER_INFO.name})`, output: await callLocalWithFallback(null, taskPrompt, null, 4096, sysPrompt) };
                  } else {
                    result = { model: 'local', delegateTo: 'claude', prompt: taskPrompt, note: 'Local server unavailable — delegate to Claude' };
                  }
                  break;
                case 'copilot':
                  if (COPILOT_AVAILABLE) {
                    result = { model: 'copilot', output: await callCopilotWithFallback(task.route.modelKey || 'gpt-4.1', taskPrompt, null, 4096, sysPrompt) };
                  } else {
                    result = { model: 'copilot', delegateTo: 'claude', prompt: taskPrompt, note: 'Copilot unavailable — delegate to Claude' };
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

    if (name === "bead_orchestrate") {
      const { requirements, context, governance = true, budget_limit_cents, project_name = 'flywheel' } = args;
      const PAPERCLIP_URL = process.env.PAPERCLIP_API_URL || 'http://127.0.0.1:3100';

      // Step 1: Decompose requirements into beads using analyze_requirements logic
      let tasks;
      try {
        const decompositionPrompt = `Decompose these requirements into self-contained "beads" (work units). Each bead must include:
- id (br-NNN format)
- title (short imperative)
- description (self-contained, full context needed to implement)
- dependencies (array of bead IDs that must complete first)
- tests (acceptance criteria and test specs)

Requirements:
${requirements}${context ? `\n\nContext:\n${context}` : ''}

Return a JSON array of beads. ONLY output valid JSON, no markdown.`;

        let decomposedText;
        try {
          decomposedText = await callGeminiWithFallback('gemini-3-flash-preview', decompositionPrompt, null, 8192);
        } catch {
          decomposedText = await callOpenRouterWithFallback('deepseek', decompositionPrompt, null, 8192);
        }

        const jsonMatch = decomposedText.match(/\[[\s\S]*\]/);
        tasks = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(decomposedText);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to decompose requirements into beads: ${err.message}` }],
          isError: true,
        };
      }

      // Step 2: Score and route each bead
      const beads = tasks.map(task => {
        const desc = `${task.title} ${task.description}`;
        const { score, features } = scoreComplexity(desc);
        const taskType = classifyTaskType(desc);
        const route = routeTask(score, taskType);
        const mcpTools = recommendMCPTools(taskType, desc);
        return { ...task, complexity: score, taskType, route, mcpTools, features };
      });

      // Step 3: Build execution order
      const executionOrder = buildExecutionOrder(beads);

      // Step 4: Optionally create Paperclip governance tasks
      let paperclipTasks = [];
      if (governance) {
        let paperclipAvailable = false;
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 2000);
          const healthResp = await fetch(`${PAPERCLIP_URL}/api/health`, { signal: ctrl.signal });
          clearTimeout(timer);
          paperclipAvailable = healthResp.ok;
        } catch { /* Paperclip not running */ }

        if (paperclipAvailable) {
          for (const bead of beads) {
            try {
              const taskResp = await fetch(`${PAPERCLIP_URL}/api/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  title: `[${bead.id}] ${bead.title}`,
                  description: bead.description,
                  project: project_name,
                  metadata: {
                    bead_id: bead.id,
                    complexity: bead.complexity,
                    task_type: bead.taskType,
                    routed_to: bead.route.model,
                    dependencies: bead.dependencies,
                  },
                }),
              });
              if (taskResp.ok) {
                const taskData = await taskResp.json();
                paperclipTasks.push({ bead_id: bead.id, task_id: taskData.id || taskData.task_id, status: 'created' });
              }
            } catch { /* Skip individual task creation failures */ }
          }

          // Set budget if specified
          if (budget_limit_cents) {
            try {
              await fetch(`${PAPERCLIP_URL}/api/budget`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ project: project_name, monthly_limit_cents: budget_limit_cents }),
              });
            } catch { /* Budget setting optional */ }
          }
        }
      }

      // Step 5: Format output
      const modelDistribution = {};
      for (const bead of beads) {
        const model = bead.route.model;
        modelDistribution[model] = (modelDistribution[model] || 0) + 1;
      }

      let output = `## Bead Orchestration Plan\n\n`;
      output += `**${beads.length} beads** decomposed from requirements\n`;
      output += `**Model distribution**: ${Object.entries(modelDistribution).map(([m, c]) => `${m}(${c})`).join(', ')}\n`;
      if (paperclipTasks.length > 0) {
        output += `**Paperclip tasks**: ${paperclipTasks.length} created (project: ${project_name})\n`;
      }
      if (budget_limit_cents) {
        output += `**Budget limit**: $${(budget_limit_cents / 100).toFixed(2)}\n`;
      }
      output += `\n### Beads\n\n`;

      for (const bead of beads) {
        const pcTask = paperclipTasks.find(t => t.bead_id === bead.id);
        output += `**${bead.id}**: ${bead.title}\n`;
        output += `  Complexity: ${bead.complexity}/10 | Type: ${bead.taskType} | Route: ${bead.route.model} (${bead.route.reason})\n`;
        if (bead.dependencies?.length > 0) output += `  Dependencies: ${bead.dependencies.join(', ')}\n`;
        if (bead.mcpTools?.length > 0) output += `  MCP tools: ${bead.mcpTools.map(t => `${t.server}/${t.tool}`).join(', ')}\n`;
        if (pcTask) output += `  Paperclip task: ${pcTask.task_id}\n`;
        output += `\n`;
      }

      output += `### Execution Order\n\n`;
      executionOrder.forEach((group, i) => {
        output += `Phase ${i + 1} (parallel): ${group.map(id => {
          const b = beads.find(bb => bb.id === id);
          return b ? `${id}→${b.route.model}` : id;
        }).join(', ')}\n`;
      });

      output += `\n---\n_Use execute_routing_plan with the plan JSON to execute, or dispatch individual beads via NTM._`;

      // Build plan object compatible with execute_routing_plan
      const plan = {
        tasks: beads,
        executionOrder,
        paperclipTasks,
        project: project_name,
        budget_limit_cents,
      };

      return {
        content: [
          { type: "text", text: output },
          { type: "text", text: JSON.stringify(plan) },
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

// ─── HTTP API Gateway (OpenAI-compatible) ──────────────────────────────────────
// Exposes multi-model-router as an HTTP server so external tools (Agent Flywheel
// CLI wrappers, custom scripts) can route through the same intelligent model
// routing, fallback chains, and complexity scoring.

const MMR_HTTP_PORT = parseInt(process.env.MMR_HTTP_PORT || '8787', 10);

if (MMR_HTTP_PORT > 0) {
  try {
    const express = require('express');
    const app = express();
    app.use(express.json({ limit: '10mb' }));

    // Health check
    app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        version: '3.1.0',
        providers: {
          gemini_cli: GEMINI_CLI_AVAILABLE,
          gemini_api: !!GEMINI_API_KEY,
          openrouter: !!OPENROUTER_API_KEY,
          requesty: !!REQUESTY_API_KEY,
          codex: CODEX_AVAILABLE,
          copilot: COPILOT_AVAILABLE,
          local: LOCAL_SERVER_INFO.available ? LOCAL_SERVER_INFO.name : false,
          firecrawl: !!FIRECRAWL_API_KEY,
        },
        circuitBreaker: providerHealth.getStatus(),
      });
    });

    // Quality stats
    app.get('/v1/stats', (_req, res) => {
      res.json({
        health: providerHealth.getStatus(),
        quality: qualityTracker.getAllStats(),
        effortLevels: EFFORT_LEVELS,
        agentTemplates: Object.keys(AGENT_TEMPLATES),
      });
    });

    // List available models
    app.get('/v1/models', async (_req, res) => {
      const models = [
        { id: 'auto', name: 'Auto-route (complexity scoring)', owned_by: 'multi-model-router' },
        { id: 'gemini-pro', name: 'Gemini 3.1 Pro Preview', owned_by: 'google', available: GEMINI_CLI_AVAILABLE || !!GEMINI_API_KEY },
        { id: 'gemini-flash', name: 'Gemini Flash 3', owned_by: 'google', available: GEMINI_CLI_AVAILABLE || !!GEMINI_API_KEY },
        { id: 'deepseek', name: 'DeepSeek V3.2', owned_by: 'openrouter', available: !!OPENROUTER_API_KEY },
        { id: 'qwen', name: 'Qwen 3.5', owned_by: 'openrouter', available: !!OPENROUTER_API_KEY },
        { id: 'glm', name: 'GLM-5', owned_by: 'openrouter', available: !!OPENROUTER_API_KEY },
        { id: 'minimax', name: 'Minimax M2.5', owned_by: 'openrouter', available: !!OPENROUTER_API_KEY },
        { id: 'codex', name: 'Codex CLI (gpt-5.3-codex)', owned_by: 'openai', available: CODEX_AVAILABLE },
        { id: 'copilot', name: 'GitHub Copilot', owned_by: 'github', available: COPILOT_AVAILABLE },
        { id: 'local', name: LOCAL_SERVER_INFO.available ? `Local (${LOCAL_SERVER_INFO.name})` : 'Local (not detected)', owned_by: 'local', available: LOCAL_SERVER_INFO.available },
      ];

      if (LOCAL_SERVER_INFO.available) {
        const localModels = await listLocalModels();
        for (const lm of localModels) {
          models.push({ id: `local:${lm.id}`, name: lm.name, owned_by: LOCAL_SERVER_INFO.name, available: true });
        }
      }

      res.json({ object: 'list', data: models });
    });

    // OpenAI-compatible chat completions
    app.post('/v1/chat/completions', async (req, res) => {
      const { model = 'auto', messages = [], max_tokens, context, effort } = req.body;

      // Extract prompt from messages
      const prompt = messages
        .filter(m => m.role === 'user')
        .map(m => m.content)
        .join('\n\n');

      if (!prompt) {
        return res.status(400).json({ error: { message: 'No user messages provided', type: 'invalid_request_error' } });
      }

      const systemContext = context || messages
        .filter(m => m.role === 'system')
        .map(m => m.content)
        .join('\n\n') || null;

      const { maxTokens: effectiveMaxTokens, scoreBoost } = applyEffort(effort, max_tokens || 4096);
      const id = `mmr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const created = Math.floor(Date.now() / 1000);

      try {
        let result, routingInfo;

        if (model === 'auto') {
          // Smart routing: intent detection → score complexity → classify type → route
          const intent = classifyIntent(prompt);
          const { score: rawScore, features } = scoreComplexity(prompt);
          const score = Math.max(0, Math.min(10, rawScore + (scoreBoost || 0)));
          const taskType = intent ? intent.taskType : classifyTaskType(prompt);
          const route = routeTask(score, taskType);
          const agent = intent ? AGENT_TEMPLATES[intent.agent] : resolveAgentTemplate(taskType, score);
          routingInfo = {
            complexity: score, taskType, provider: route.model, reason: route.reason, features,
            ...(intent && { intent: intent.intent, agent: intent.agent }),
            ...(effort && { effort }),
          };

          if (route.model === 'inline' || route.model === 'opus') {
            // Cannot handle inline/opus via HTTP — delegate back to caller
            return res.json({
              id, object: 'chat.completion', created,
              model: 'delegate-to-claude',
              choices: [{ index: 0, message: { role: 'assistant', content: prompt }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              _routing: { ...routingInfo, delegated: true },
            });
          }

          // Route to the appropriate provider with agent system prompt
          result = await routeToProvider(route.model, route.modelKey, prompt, systemContext, effectiveMaxTokens, route, agent?.systemPrompt);
        } else {
          // Direct model routing
          const directIntent = classifyIntent(prompt);
          const directAgent = directIntent ? AGENT_TEMPLATES[directIntent.agent] : null;
          routingInfo = { provider: model, direct: true, ...(directIntent && { intent: directIntent.intent }) };
          result = await routeToProvider(model, null, prompt, systemContext, effectiveMaxTokens, {}, directAgent?.systemPrompt);
        }

        // Check if result is a delegate response
        if (typeof result === 'string') {
          try {
            const parsed = JSON.parse(result);
            if (parsed.delegateTo === 'claude') {
              return res.json({
                id, object: 'chat.completion', created,
                model: 'delegate-to-claude',
                choices: [{ index: 0, message: { role: 'assistant', content: prompt }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                _routing: { ...routingInfo, delegated: true, failureReason: parsed.failureReason },
              });
            }
          } catch { /* not JSON, it's actual content */ }
        }

        const content = typeof result === 'string' ? result : JSON.stringify(result);
        res.json({
          id, object: 'chat.completion', created,
          model: routingInfo.provider || model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          _routing: routingInfo,
        });

      } catch (error) {
        res.status(500).json({
          error: { message: error.message, type: 'server_error' },
          _routing: { provider: model, error: true },
        });
      }
    });

    // Memory bridge endpoints (for cm/cass shims)
    app.post('/memory/store', async (req, res) => {
      const { key, value, type, namespace } = req.body;
      res.json({ status: 'stored', key, note: 'Route to claude-flow memory_store MCP tool' });
    });

    app.post('/memory/search', async (req, res) => {
      const { query, namespace } = req.body;
      res.json({ status: 'search', query, note: 'Route to claude-flow memory_search MCP tool' });
    });

    // Central routing function used by the HTTP gateway
    async function routeToProvider(model, modelKey, prompt, context, maxTokens, route, systemPrompt) {
      switch (model) {
        case 'gemini-pro':
          return callGeminiWithFallback('gemini-3.1-pro-preview', prompt, context, maxTokens, systemPrompt);
        case 'gemini-flash':
          return callGeminiWithFallback('gemini-3-flash-preview', prompt, context, maxTokens, systemPrompt);
        case 'openrouter':
          return callOpenRouterWithFallback(modelKey || 'deepseek', prompt, context, maxTokens, systemPrompt);
        case 'deepseek':
          return callOpenRouterWithFallback('deepseek', prompt, context, maxTokens, systemPrompt);
        case 'qwen':
          return callOpenRouterWithFallback('qwen', prompt, context, maxTokens, systemPrompt);
        case 'glm':
          return callOpenRouterWithFallback('glm', prompt, context, maxTokens, systemPrompt);
        case 'minimax':
          return callOpenRouterWithFallback('minimax', prompt, context, maxTokens, systemPrompt);
        case 'codex':
          return callCodexWithFallback(prompt, context, {
            sandbox: route.sandbox || 'read-only',
            fullAuto: route.fullAuto || false,
            max_tokens: maxTokens,
          });
        case 'copilot':
          return callCopilotWithFallback(modelKey || 'gpt-4.1', prompt, context, maxTokens, systemPrompt);
        case 'local': {
          const localModel = modelKey || undefined;
          return callLocalWithFallback(localModel, prompt, context, maxTokens, systemPrompt);
        }
        default: {
          if (model.startsWith('local:')) {
            return callLocalWithFallback(model.slice(6), prompt, context, maxTokens, systemPrompt);
          }
          if (model.startsWith('requesty:')) {
            return callRequestyWithFallback(model.slice(9), prompt, context, maxTokens, systemPrompt);
          }
          if (model.includes('/')) {
            return callRequestyWithFallback(model, prompt, context, maxTokens, systemPrompt);
          }
          return callOpenRouterWithFallback(model, prompt, context, maxTokens, systemPrompt);
        }
      }
    }

    app.listen(MMR_HTTP_PORT, '127.0.0.1', () => {
      // Log to stderr so it doesn't interfere with MCP stdio
      process.stderr.write(`[multi-model-router] HTTP gateway listening on http://127.0.0.1:${MMR_HTTP_PORT}\n`);
    });
  } catch (err) {
    process.stderr.write(`[multi-model-router] HTTP gateway failed to start: ${err.message}\n`);
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
