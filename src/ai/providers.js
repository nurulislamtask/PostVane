// AI providers the person added in Settings: any OpenAI-compatible API. Each row is one model with one key; together the
// enabled rows form a pool (see pool.js). Stored in the local database.
import { PRESETS } from './llm.js';

const KINDS = new Set(PRESETS.map((p) => p.kind));
export const MAX_BULK = 60;

export class ProviderError extends Error {}

function clean(input, existing = null) {
  const name = String(input.name ?? existing?.name ?? '').trim();
  const kind = String(input.kind ?? existing?.kind ?? 'custom');
  const base_url = String(input.base_url ?? existing?.base_url ?? '').trim().replace(/\/+$/, '');
  const model = String(input.model ?? existing?.model ?? '').trim();
  if (!name || name.length > 80) throw new ProviderError('Give the provider a name (up to 80 characters)');
  if (!KINDS.has(kind)) throw new ProviderError('Unknown provider type');
  let url;
  try { url = new URL(base_url); } catch { throw new ProviderError('The API URL must start with http:// or https://'); }
  if (!/^https?:$/.test(url.protocol)) throw new ProviderError('The API URL must start with http:// or https://');
  if (!model || model.length > 160) throw new ProviderError('Enter the model name');
  // undefined keeps the saved key; an empty string clears it.
  const api_key = input.api_key === undefined ? (existing?.api_key ?? '') : String(input.api_key).trim();
  const vision = input.vision === undefined ? (existing?.vision ? 1 : 0) : (input.vision ? 1 : 0);
  const enabled = input.enabled === undefined ? (existing ? (existing.enabled ? 1 : 0) : 1) : (input.enabled ? 1 : 0);
  return { name, kind, base_url, model, api_key, vision, enabled };
}

const view = (p) => ({
  id: p.id, name: p.name, kind: p.kind, base_url: p.base_url, model: p.model, vision: Boolean(p.vision), enabled: Boolean(p.enabled),
  api_key_set: Boolean(p.api_key), api_key_hint: p.api_key ? `…${p.api_key.slice(-4)}` : '',
  cooldown_until: p.cooldown_until > Date.now() ? p.cooldown_until : 0, last_error: p.last_error || '',
});

export function listProviders(db) { return db.prepare('SELECT * FROM ai_providers ORDER BY id').all().map(view); }

export function getProvider(db, id) {
  const p = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id);
  return p ? { ...p, vision: Boolean(p.vision), enabled: Boolean(p.enabled) } : null;
}

/** Every switched-on model with its key, in the order they were added. */
export function getEnabledProviders(db) {
  return db.prepare('SELECT * FROM ai_providers WHERE enabled = 1 ORDER BY id').all().map((p) => ({ ...p, vision: Boolean(p.vision), enabled: true }));
}

export function addProvider(db, input) {
  const v = clean(input);
  return db.prepare('INSERT INTO ai_providers(name, kind, base_url, api_key, model, vision, enabled) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .get(v.name, v.kind, v.base_url, v.api_key, v.model, v.vision, v.enabled).id;
}

/** Adds one row per model and key. `models` and `api_keys` are lists; names get the model so the rows are easy to tell apart. */
export function addProviders(db, input) {
  const models = [...new Set((input.models?.length ? input.models : [input.model]).map((m) => String(m ?? '').trim()).filter(Boolean))];
  const keys = [...new Set((input.api_keys?.length ? input.api_keys : [input.api_key ?? '']).map((k) => String(k ?? '').trim()))];
  if (!models.length) throw new ProviderError('Pick at least one model');
  if (models.length * keys.length > MAX_BULK) throw new ProviderError(`That would add ${models.length * keys.length} entries; the limit is ${MAX_BULK} at a time`);
  const base = String(input.name || '').trim() || 'AI';
  const ids = [];
  db.exec('BEGIN');
  try {
    keys.forEach((key, ki) => {
      for (const model of models) {
        const label = models.length > 1 || !input.name ? `${base} · ${model}` : base;
        ids.push(addProvider(db, { ...input, name: keys.length > 1 ? `${label} (key ${ki + 1})` : label, model, api_key: key }));
      }
    });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return ids;
}

export function updateProvider(db, id, input) {
  const existing = getProvider(db, id);
  if (!existing) return false;
  const v = clean(input, existing);
  db.prepare('UPDATE ai_providers SET name = ?, kind = ?, base_url = ?, api_key = ?, model = ?, vision = ?, enabled = ? WHERE id = ?')
    .run(v.name, v.kind, v.base_url, v.api_key, v.model, v.vision, v.enabled, id);
  if (v.enabled && !existing.enabled) db.prepare('UPDATE ai_providers SET cooldown_until = 0, last_error = \'\' WHERE id = ?').run(id);
  return true;
}

export function deleteProvider(db, id) { db.prepare('DELETE FROM ai_providers WHERE id = ?').run(id); }
export function deleteAllProviders(db) { db.prepare('DELETE FROM ai_providers').run(); }

export function setCooldown(db, id, untilMs, why) {
  db.prepare('UPDATE ai_providers SET cooldown_until = ?, last_error = ? WHERE id = ?').run(Math.round(untilMs), String(why || '').slice(0, 200), id);
}
export function markUsed(db, id, now = Date.now()) {
  db.prepare('UPDATE ai_providers SET last_used_at = ?, cooldown_until = 0, last_error = \'\' WHERE id = ?').run(now, id);
}
