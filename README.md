# mcp-multi-model-router

MCP server that intelligently routes AI tasks to the optimal model (Gemini, DeepSeek, Codex, OpenRouter, Requesty, Copilot, local) using code-based complexity scoring, intent classification, agent prompt templates, and automatic fallback chains with circuit breakers.

## What is this?

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — or any MCP-compatible client — that acts as a unified gateway to multiple LLM providers. Instead of manually choosing which model to call, the router detects intent, scores complexity, selects a specialized agent template, and routes to the optimal model automatically.

## Features

- **15 MCP tools** for model consultation, listing, requirements analysis, plan execution, agent templates, and quality stats
- **Intent classification** with 12+ keyword triggers for fast upfront routing (inspired by oh-my-codex)
- **13 agent prompt templates** — specialized system prompts with behavioral governance for code-reviewer, security-auditor, debugger, architect, test-engineer, researcher, verifier, etc.
- **Structured subagent status protocol** — agents report DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED instead of free-form responses (inspired by [obra/superpowers](https://github.com/obra/superpowers))
- **Red flag rationalization guards** — empirically-derived anti-pattern tables in key agent templates (debugger, test-engineer, security-auditor, architect, verifier) that prevent agents from cutting corners (inspired by [obra/superpowers](https://github.com/obra/superpowers))
- **Two-stage verification** — Ralph Loop verifies spec compliance first, then code quality. Quality issues are advisory, not blocking. (inspired by [obra/superpowers](https://github.com/obra/superpowers))
- **3-fix escalation** — after 2 consecutive verification failures, automatically escalates to a more capable model via the escalation ladder instead of retrying the same provider (inspired by [obra/superpowers](https://github.com/obra/superpowers))
- **Verification gate with evidence** — verifiers must cite specific output lines as evidence for verdicts. "Looks good" is not an acceptable verdict.
- **Code-based complexity scoring (0-10)** using lexical, semantic, scope, and uncertainty features — no LLM calls needed for scoring
- **Task type classification** into 10 categories: docs, code, test, refactor, script, debug, security, architecture, research, orchestration
- **Deterministic routing table** mapping `(complexity score, task type)` to the optimal model
- **Automatic fallback chains** — every provider chain ends with `delegateTo: 'claude'` so calls never fail to the user
- **Circuit breaker** (provider health monitoring) — tracks provider failures, skips known-down providers, auto-recovers via half-open probing
- **Rate limit retry** — on HTTP 429, parses `Retry-After` header and retries (up to 2x, capped at 30s) before falling through to fallback
- **Reasoning effort control** — `effort` parameter (low/medium/high/xhigh) on all `consult_*` tools adjusts max tokens, complexity score boost, and model tier
- **Response quality tracking** — tracks success rates and latency per model+taskType, exposed via `router_stats` tool and `/v1/stats` HTTP endpoint
- **DAG-based task execution** with parallelism for multi-task plans via `analyze_requirements` + `execute_routing_plan`
- **MCP tool recommendations** — suggests prerequisite tools (Exa, Tavily, Ref, SpacetimeDB) based on task type

## Superpowers-Inspired Behavioral Governance (v3.1.0)

These features are adapted from [obra/superpowers](https://github.com/obra/superpowers), a behavioral governance framework for AI coding agents.

### Subagent Status Protocol

Every agent template now instructs the model to end responses with a structured status:

```
STATUS: DONE | Task completed successfully
STATUS: DONE_WITH_CONCERNS | Implemented but found potential memory leak
STATUS: NEEDS_CONTEXT | Cannot determine correct auth flow without seeing middleware
STATUS: BLOCKED | Task requires database access not available in current sandbox
```

The Ralph Loop parses these statuses:
- **BLOCKED** → triggers automatic model escalation
- **NEEDS_CONTEXT** → returns early so the controller can provide missing information
- **DONE_WITH_CONCERNS** → passes verification with concerns forwarded

### Red Flag Rationalization Guards

Key agent templates include empirically-derived "Red Flag" tables that counter common rationalizations agents use to skip rigorous work:

| Agent | Guards Against |
|-------|---------------|
| debugger | "I think this fixes it", guessing without evidence, symptom-fixing without root cause |
| test-engineer | "Too simple to test", skipping edge cases, writing tests-after instead of tests-first |
| security-auditor | "This is internal-only", trusting framework defaults, dismissing low-severity findings |
| architect | "We can refactor later", cargo-culting patterns, hand-waving performance claims |
| verifier | "Looks mostly correct", charitable interpretation, passing incomplete work |

### Two-Stage Verification

The Ralph Loop now runs verification in two stages:

1. **Spec Compliance** — Does the output match what was requested? Must cite specific evidence from the output. This is the gate: if spec fails, retry immediately.
2. **Quality Check** — Is the output well-built? Only runs if spec passes. Quality issues are reported as advisory, not blocking. Task-specific criteria (e.g., code checks for TODO markers and O(n^2) patterns, tests check for independent assertions).

### Escalation Ladder

After 2 consecutive verification failures, the Ralph Loop automatically escalates to a more capable model:

```
local → openrouter → gemini-flash → gemini-pro → opus
openrouter → gemini-flash → gemini-pro → copilot → opus
gemini-flash → gemini-pro → copilot → opus
gemini-pro → copilot → opus
copilot → gemini-pro → opus
codex → gemini-pro → opus
```

This prevents wasting iterations retrying a provider that's not capable enough for the task.

## Supported Providers

| Provider | Models | Best For |
|----------|--------|----------|
| **Google Gemini** | Gemini 3.1 Pro Preview, Gemini Flash 3 | Research (1M context), docs, transforms |
| **OpenRouter** | DeepSeek V3.2, Qwen 3.6 Plus, GLM-5 Turbo, Minimax M2.7 | Scripts, boilerplate, CRUD |
| **Requesty.ai** | 300+ models (auto-failover) | Fallback router, direct model access |
| **OpenAI Codex CLI** | gpt-5.3-codex and variants | Feature impl, refactors, bulk codegen |
| **Local Inference** | Ollama, LM Studio, vLLM, MLX, LocalAI | Zero-cost, low-latency simple tasks |

## Prerequisites

- **Node.js 18+** (uses native `fetch`)
- **npm** for dependency installation

## Installation

```bash
git clone https://github.com/YOUR_USERNAME/mcp-multi-model-router.git
cd mcp-multi-model-router
npm install
```

## Configuration

### 1. Register the MCP server

Add to your Claude Code MCP settings (`~/.claude/settings.json` or project `.claude/settings.json`):

```json
{
  "mcpServers": {
    "multi-model-router": {
      "command": "node",
      "args": ["/path/to/mcp-multi-model-router/index.js"],
      "env": {
        "GEMINI_API_KEY": "your-gemini-api-key",
        "OPENROUTER_API_KEY": "your-openrouter-api-key",
        "REQUESTY_API_KEY": "your-requesty-api-key"
      }
    }
  }
}
```

### 2. Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | No* | Google AI Studio API key for Gemini models |
| `OPENROUTER_API_KEY` | No* | OpenRouter API key for DeepSeek/Qwen/GLM/Minimax |
| `REQUESTY_API_KEY` | No* | Requesty.ai API key (fallback router, 300+ models) |
| `LOCAL_MODEL_BASE_URL` | No | Override auto-detected local server URL (e.g., `http://192.168.1.100:11434/v1`) |
| `LOCAL_MODEL_PROVIDER` | No | Hint for auto-detection: `ollama`, `lmstudio`, `vllm`, `mlx`, or `localai` |

\* At least one key is needed. Each provider works independently — configure only the ones you want.

### 3. Optional: Gemini CLI (OAuth)

If you have the [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and authenticated via OAuth, it will be used as the **primary** path for Gemini calls (higher free-tier limits, no API key billing). The API key is used as a fallback.

```bash
npm install -g @google/gemini-cli
gemini  # authenticate via OAuth on first run
```

### 4. Optional: Codex CLI

If you have the [OpenAI Codex CLI](https://github.com/openai/codex) installed, the `consult_codex` tool becomes available for autonomous task execution.

```bash
npm install -g @openai/codex
codex login
```

### 5. Optional: Local Inference Server

The router auto-detects locally-running inference servers on startup. All 5 supported providers expose an OpenAI-compatible `/v1/chat/completions` endpoint. Install any one:

| Provider | Install | Default Port |
|----------|---------|-------------|
| **Ollama** | `curl -fsSL https://ollama.ai/install.sh \| sh && ollama pull llama3.2` | 11434 |
| **LM Studio** | Download from [lmstudio.ai](https://lmstudio.ai), start local server | 1234 |
| **vLLM** | `pip install vllm && vllm serve <model>` | 8000 |
| **MLX** | `pip install mlx-lm && mlx_lm.server` (macOS M-series only) | 8080 |
| **LocalAI** | See [localai.io](https://localai.io) | 8080 |

Auto-detection probes ports in order: Ollama (11434) → LM Studio (1234) → vLLM (8000) → MLX/LocalAI (8080). Set `LOCAL_MODEL_BASE_URL` to skip auto-detection or point to a remote server.

## Fallback Chains

Every provider has a multi-level fallback chain. Calls **never fail to the user** — the worst case is a `delegateTo: 'claude'` response telling the orchestrator to handle the task inline.

```
consult_gemini_pro / consult_gemini_flash:
  1. Gemini CLI (OAuth)         <- primary (if installed)
  2. Gemini API (API key)       <- fallback
  3. Requesty.ai                <- fallback
  4. { delegateTo: 'claude' }   <- last resort

consult_openrouter:
  1. OpenRouter API
  2. Requesty.ai (same model)
  3. { delegateTo: 'claude' }

consult_codex:
  1. Codex CLI (local)
  2. Requesty.ai (deepseek)
  3. { delegateTo: 'claude' }

consult_requesty:
  1. Requesty.ai (direct)
  2. { delegateTo: 'claude' }

consult_local:
  1. Local server (Ollama/LM Studio/vLLM/MLX/LocalAI)
  2. Requesty.ai (deepseek)
  3. { delegateTo: 'claude' }
```

## Smart Routing

### Complexity Scoring

The router scores task complexity (0-10) using four code-based features — no LLM calls required:

| Feature | Weight | What it measures |
|---------|--------|------------------|
| **Lexical** | 20% | Word count, average word length |
| **Semantic** | 35% | Keyword indicators (high/medium/low complexity terms) |
| **Scope** | 25% | Multi-file patterns, code generation indicators, description length |
| **Uncertainty** | 20% | Ambiguity markers ("not sure", "investigate", "debug", "error") |

### Task Type Classification

Tasks are classified into one of 9 types based on keyword matching:

`docs` | `code` | `test` | `refactor` | `script` | `debug` | `security` | `architecture` | `research`

### Routing Decision Table

| Score | Task Type | Routes To |
|-------|-----------|-----------|
| 0-2 | Any | `inline` (handle in Claude) |
| 3-4 | script, code, docs, refactor, test | `local`* (if server detected) |
| 3-4 | docs | `gemini-flash` |
| 3-4 | script | `openrouter` (DeepSeek) |
| 3-4 | code, refactor | `codex` |
| 5-6 | code, refactor, test | `codex` (workspace-write) |
| 5-6 | docs | `gemini-flash` |
| 5-6 | research | `gemini-pro` |
| 5-6 | script | `openrouter` (DeepSeek) |
| 7-8 | debug, security | `opus` (delegate to Claude) |
| 7-8 | architecture | `opus` |
| 7-8 | research | `gemini-pro` |
| 7-8 | code, refactor, test | `codex` (full_auto) |
| 9-10 | architecture, security | `opus` |
| 9-10 | research | `gemini-pro` |

\* Local routing rules are only active when a local server is detected at startup. If no server is found, these tasks fall through to the cloud provider rules.

## Tool Reference

### `consult_gemini_pro`

Consult Gemini 3.1 Pro Preview for complex research, cross-domain analysis, or tasks needing massive context (up to 1M tokens).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | The task or question |
| `context` | string | No | Additional context (code, data, documents) |
| `max_tokens` | number | No | Max output tokens (default: 8192) |

### `consult_gemini_flash`

Consult Gemini Flash 3 for documentation, READMEs, JSDoc, config files, and simple transformations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | The task or question |
| `context` | string | No | Additional context |
| `max_tokens` | number | No | Max output tokens (default: 4096) |

### `consult_openrouter`

Consult an OpenRouter model for bash scripts, boilerplate, simple CRUD, and repetitive tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | The task or question |
| `model` | string | No | `deepseek` (default), `qwen`, `glm`, or `minimax` |
| `context` | string | No | Additional context |
| `max_tokens` | number | No | Max output tokens (default: 4096) |

### `consult_requesty`

Consult a model via Requesty.ai router with 300+ models and auto-failover.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | The task or question |
| `model` | string | No | Shorthand (`deepseek`, `qwen`, `gemini-pro`, `gemini-flash`) or full `provider/model-name` |
| `context` | string | No | Additional context |
| `max_tokens` | number | No | Max output tokens (default: 4096) |

### `consult_codex`

Delegate a task to OpenAI Codex CLI for autonomous execution with its own agent loop.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | The task for Codex |
| `context` | string | No | Additional context |
| `model` | string | No | Codex model (default: `gpt-5.3-codex`) |
| `sandbox` | string | No | `read-only` (default) or `workspace-write` |
| `full_auto` | boolean | No | Enable full-auto mode (no approval prompts) |
| `timeout` | number | No | Timeout in ms (default: 120000, max: 600000) |

### `consult_local`

Consult a locally-running inference server (Ollama, LM Studio, vLLM, MLX, or LocalAI) for zero-cost, low-latency inference.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | The task or question |
| `model` | string | No | Model name (e.g., `llama3.2`, `codellama`). Use `list_local_models` to see available models. |
| `context` | string | No | Additional context |
| `max_tokens` | number | No | Max output tokens (default: 4096) |

### `list_local_models`

List models available on the detected local inference server. Returns model IDs and sizes. Takes no parameters.

### `list_available_models`

List all available models and their configuration status. Takes no parameters.

### `analyze_requirements`

Analyze a requirements document and generate a smart execution plan with model routing. Decomposes requirements into subtasks via Gemini Flash, scores complexity via code-based heuristics, and assigns each subtask to the optimal model.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `requirements` | string | Yes | Requirements text to analyze |
| `context` | string | No | Additional context (existing code, constraints) |

Returns a human-readable plan and a JSON plan object for use with `execute_routing_plan`.

### `execute_routing_plan`

Execute a routing plan generated by `analyze_requirements`. Runs tasks in dependency order, parallelizing independent tasks. Tasks routed to `opus` or `inline` are returned as delegation instructions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `plan` | object | Yes | The plan object from `analyze_requirements` |

## How It Works

1. **Score** — The router computes a complexity score (0-10) using lexical, semantic, scope, and uncertainty features
2. **Classify** — The task is classified into one of 9 types via keyword matching
3. **Route** — A deterministic decision table maps `(score, type)` to the optimal model
4. **Call** — The selected provider is called with automatic fallback chains
5. **Return** — Results are returned to the MCP client, or a `delegateTo: 'claude'` instruction is returned if all external providers fail

For multi-task plans (`analyze_requirements` + `execute_routing_plan`):
1. Requirements are decomposed into subtasks via Gemini Flash
2. Each subtask is scored, classified, and routed independently
3. A DAG execution order is computed from task dependencies
4. Tasks are executed in phases, with independent tasks running in parallel
5. Dependency results are passed as context to downstream tasks

## License

MIT
