// Single source of truth for every model ID the router pins.
// The autonomous updater (scripts/check-latest-models.js) reads + rewrites this
// file weekly; index.js imports from it. Keep entries flat and one-per-line so
// the script can patch with a regex on `'<key>': '<old-id>'`.

export const OPENROUTER_MODELS = {
  deepseek: "deepseek/deepseek-v4-flash",
  "deepseek-coder": "deepseek/deepseek-v4-pro",
  qwen: "qwen/qwen3.6-max-preview",
  glm: "z-ai/glm-5.1",
  minimax: "minimax/minimax-m2.7",
};

export const REQUESTY_MODELS = {
  deepseek: "fireworks/deepseek-v4-flash",
  "deepseek-coder": "fireworks/deepseek-v4-pro",
  qwen: "alibaba/qwen3.6-max-preview",
  glm: "zai/GLM-5.1",
  minimax: "minimaxi/MiniMax-M2.7",
  "gemini-pro": "google/gemini-3.1-pro-preview",
  "gemini-flash": "google/gemini-3.1-flash-lite-preview",
};

export const COPILOT_MODELS = {
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

export const DIRECT_MODELS = {
  "glm-direct": "glm-5.1",
  "minimax-direct": "MiniMax-M2.7",
  "gemini-pro-cli": "gemini-3.1-pro-preview",
  "gemini-flash-cli": "gemini-3.1-flash-lite-preview",
  "codex-default": "gpt-5.3-codex",
};
