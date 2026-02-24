# mcp-multi-model-router

MCP server that intelligently routes AI tasks to the optimal model (Gemini, DeepSeek, Codex, OpenRouter, Requesty) using code-based complexity scoring and automatic fallback chains.

## What is this?

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — or any MCP-compatible client — that acts as a unified gateway to multiple LLM providers. Instead of manually choosing which model to call, the router scores task complexity using code-based heuristics and routes to the optimal model automatically.

## Features

- **8 MCP tools** for model consultation, listing, requirements analysis, and plan execution
- **Code-based complexity scoring (0-10)** using lexical, semantic, scope, and uncertainty features — no LLM calls needed for scoring
- **Task type classification** into 9 categories: docs, code, test, refactor, script, debug, security, architecture, research
- **Deterministic routing table** mapping `(complexity score, task type)` to the optimal model
- **Automatic fallback chains** — every provider chain ends with `delegateTo: 'claude'` so calls never fail to the user
- **DAG-based task execution** with parallelism for multi-task plans via `analyze_requirements` + `execute_routing_plan`
- **MCP tool recommendations** — suggests prerequisite tools (Exa, Tavily, Ref, SpacetimeDB) based on task type

## Supported Providers

| Provider | Models | Best For |
|----------|--------|----------|
| **Google Gemini** | Gemini 3.1 Pro Preview, Gemini Flash 3 | Research (1M context), docs, transforms |
| **OpenRouter** | DeepSeek V3.2, Qwen 3.5, GLM-5, Minimax M2.5 | Scripts, boilerplate, CRUD |
| **Requesty.ai** | 300+ models (auto-failover) | Fallback router, direct model access |
| **OpenAI Codex CLI** | gpt-5.3-codex and variants | Feature impl, refactors, bulk codegen |

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
