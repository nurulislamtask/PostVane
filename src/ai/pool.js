// A pool of AI models. When one hits its free limit (or its key stops working) PostVane rests it for a while and carries on
// with the next one, even in the middle of a post, so a free quota running out never stops the schedule.
import { chat, LlmError } from './llm.js';
import { getEnabledProviders, setCooldown, markUsed } from './providers.js';
import { getSettings } from '../db.js';

const MIN = 60_000;

/** How long to rest a model after an error, in ms. */
export function restFor(e) {
  if (e.kind === 'rate_limit') {
    if (e.retryAfterMs) return Math.max(e.retryAfterMs, MIN);
    return /per.?day|daily|quota|exhausted/i.test(e.message) ? 3 * 60 * MIN : 15 * MIN; // a per-minute limit clears sooner than a daily quota
  }
  if (e.kind === 'auth') return 24 * 60 * MIN;
  if (e.kind === 'bad_request') return 60 * MIN; // e.g. a model name that no longer exists
  return 2 * MIN; // network or server trouble
}

// Screenshots only go to models marked as able to see them.
function adapt(messages, provider) {
  if (provider.vision) return messages;
  return messages.map((m) => (Array.isArray(m.content)
    ? { ...m, content: m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') }
    : m));
}

/** A single provider object used directly (tests, the "Test" button) behaves like a pool of one. */
export function asPool(provider) {
  if (!provider || typeof provider.chat === 'function') return provider;
  return { name: provider.name || 'AI', model: provider.model, vision: Boolean(provider.vision), used: new Set(),
    chat: (messages, opts) => chat(provider, adapt(messages, provider), opts) };
}

/**
 * The pool for one job or one writing request, or null when no model is switched on.
 * Rotation: each new pool starts with the model that was used longest ago, so posts use every model in turn.
 * Once it has a model it keeps that one until it fails, so one post isn't written by five different models.
 */
export function createPool(db, { now = () => Date.now() } = {}) {
  if (!getEnabledProviders(db).length) return null;
  const strategy = getSettings(db).ai_strategy === 'failover' ? 'failover' : 'rotate';
  let current = null;
  const failedHere = new Set();

  // Read from the database each time: another process may have just rested a model.
  function pick() {
    const rows = getEnabledProviders(db).filter((p) => p.cooldown_until <= now() && !failedHere.has(p.id));
    if (current && rows.some((p) => p.id === current.id)) return rows.find((p) => p.id === current.id);
    if (!rows.length) return null;
    if (strategy === 'rotate') rows.sort((a, b) => a.last_used_at - b.last_used_at || a.id - b.id);
    return rows[0];
  }

  const pool = {
    get name() { return current?.name || 'AI pool'; },
    get model() { return current?.model || ''; },
    vision: getEnabledProviders(db).some((p) => p.vision),
    used: new Set(),
    async chat(messages, opts = {}) {
      let lastError = null;
      let onlyLimits = true;
      for (;;) {
        const p = pick();
        if (!p) break;
        if (current?.id !== p.id) { current = p; markUsed(db, p.id, now()); }
        pool.used.add(`${p.name}`);
        const total = getEnabledProviders(db).length;
        try {
          return await chat(p, adapt(messages, p), { ...opts, retries: total > 1 ? 0 : (opts.retries ?? 2) });
        } catch (e) {
          if (!(e instanceof LlmError) || opts.signal?.aborted) throw e;
          lastError = e;
          if (e.kind !== 'rate_limit') onlyLimits = false;
          setCooldown(db, p.id, now() + restFor(e), `${e.kind}: ${e.message}`);
          failedHere.add(p.id);
          current = null;
        }
      }
      // Nothing left to try.
      const resting = getEnabledProviders(db).filter((p) => p.cooldown_until > now());
      const soonest = resting.length ? Math.min(...resting.map((p) => p.cooldown_until)) : 0;
      if (lastError && !onlyLimits) throw lastError;
      const mins = soonest ? Math.max(1, Math.ceil((soonest - now()) / MIN)) : 0;
      throw new LlmError('rate_limit', `Every AI model in the pool has hit its limit${mins ? `; the first one is free again in about ${mins} min` : ''}.`,
        429, soonest ? soonest - now() : 0);
    },
  };
  return pool;
}
