// Talks to any OpenAI-compatible chat API: OpenRouter, Google Gemini, Ollama, OpenAI, Groq, Together, LM Studio or your own URL.
// Providers are saved in the database; see providers.js.

export const PRESETS = [
  { kind: 'openrouter', name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', needs_key: true, model_hint: 'e.g. a model ending in :free',
    key_url: 'https://openrouter.ai/keys' },
  { kind: 'gemini', name: 'Google Gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', needs_key: true,
    model_hint: 'e.g. gemini-2.5-flash', key_url: 'https://aistudio.google.com/apikey' },
  { kind: 'ollama', name: 'Ollama (on this computer)', base_url: 'http://127.0.0.1:11434/v1', needs_key: false,
    model_hint: 'a model you pulled, e.g. qwen2.5:14b', key_url: 'https://ollama.com/download' },
  { kind: 'openai', name: 'OpenAI', base_url: 'https://api.openai.com/v1', needs_key: true, model_hint: 'e.g. gpt-4o-mini',
    key_url: 'https://platform.openai.com/api-keys' },
  { kind: 'groq', name: 'Groq', base_url: 'https://api.groq.com/openai/v1', needs_key: true, model_hint: 'e.g. llama-3.3-70b-versatile',
    key_url: 'https://console.groq.com/keys' },
  { kind: 'custom', name: 'Custom (any OpenAI-compatible URL)', base_url: '', needs_key: false, model_hint: 'the model name your server uses', key_url: '' },
];

export class LlmError extends Error {
  /** kind: 'rate_limit' | 'auth' | 'network' | 'bad_request' | 'server' */
  constructor(kind, message, status, retryAfterMs = 0) { super(message); this.kind = kind; this.status = status; this.retryAfterMs = retryAfterMs; }
}

const trimBase = (u) => String(u || '').trim().replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers(provider) {
  return {
    'content-type': 'application/json',
    ...(provider.api_key ? { authorization: `Bearer ${provider.api_key}` } : {}),
    'x-title': 'PostVane', 'http-referer': 'https://github.com/nurulislamtask/PostVane',
  };
}

function classify(status, body, retryAfterMs = 0) {
  const msg = String(body?.error?.message || body?.message || (typeof body === 'string' ? body : '') || `HTTP ${status}`).slice(0, 300);
  if (status === 401 || status === 403) return new LlmError('auth', `The API key was refused (${msg})`, status);
  if (status === 429 || /quota|rate.?limit|too many requests|resource.?exhausted/i.test(msg)) return new LlmError('rate_limit', msg, status, retryAfterMs);
  if (status >= 500) return new LlmError('server', msg, status);
  return new LlmError('bad_request', msg, status);
}

/**
 * One chat completion. messages: [{ role, content }] where content is a string, or an array with image parts.
 * Returns { text }. Retries short rate limits and server errors twice.
 */
export async function chat(provider, messages, { signal, temperature = 0.2, maxTokens = 2000, retries = 2, timeoutMs = 120_000 } = {}) {
  if (!trimBase(provider.base_url)) throw new LlmError('bad_request', 'The provider has no URL');
  if (!provider.model) throw new LlmError('bad_request', 'The provider has no model name');
  const body = JSON.stringify({ model: provider.model, messages, temperature, max_tokens: maxTokens, stream: false });
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(`${trimBase(provider.base_url)}/chat/completions`, {
        method: 'POST', headers: headers(provider), body,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      last = new LlmError('network', `Could not reach ${trimBase(provider.base_url)} (${e.cause?.code || e.message})`);
      if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
      throw last;
    }
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* not JSON */ }
    if (res.ok) {
      const text = json?.choices?.[0]?.message?.content;
      const out = Array.isArray(text) ? text.map((p) => p.text || '').join('') : text;
      if (typeof out === 'string' && out.trim()) return { text: out };
      last = new LlmError('bad_request', json?.error?.message || 'The model returned an empty answer');
      if (attempt < retries) { await sleep(1500); continue; }
      throw last;
    }
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    last = classify(res.status, json || raw, retryAfter * 1000);
    const wait = Math.min(30, retryAfter || 4 * (attempt + 1)) * 1000;
    if ((last.kind === 'rate_limit' || last.kind === 'server') && attempt < retries && wait <= 30_000) { await sleep(wait); continue; }
    throw last;
  }
  throw last;
}

/** True for models that cost nothing: OpenRouter's ":free" models, or any model listed with a zero price. */
export function isFreeModel(m) {
  const id = String(m.id || m.name || '');
  if (id.endsWith(':free')) return true;
  const price = m.pricing;
  return Boolean(price) && Number(price.prompt) === 0 && Number(price.completion) === 0;
}

/** The models the provider offers (GET /models): [{ id, free }]. */
export async function listModels(provider) {
  let res;
  try {
    res = await fetch(`${trimBase(provider.base_url)}/models`, { headers: headers(provider), signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new LlmError('network', `Could not reach ${trimBase(provider.base_url)} (${e.cause?.code || e.message})`);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw classify(res.status, json);
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  return rows
    .map((m) => ({ id: String(m.id || m.name || '').replace(/^models\//, ''), free: isFreeModel(m) }))
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The first complete {...} object in a model reply (it may sit inside a code fence or after some words). */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const s = text.replace(/```(?:json)?/gi, ' ');
  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    let depth = 0; let inStr = false; let esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}
