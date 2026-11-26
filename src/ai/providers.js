// AI providers the person added in Settings: any OpenAI-compatible API. Stored in the local database.
import { PRESETS } from './llm.js';
import { getSettings, setSetting } from '../db.js';

const KINDS = new Set(PRESETS.map((p) => p.kind));

export class ProviderError extends Error {}

function clean(input, existing = null) {
  const name = String(input.name ?? existing?.name ?? '').trim();
  const kind = String(input.kind ?? existing?.kind ?? 'custom');
  const base_url = String(input.base_url ?? existing?.base_url ?? '').trim().replace(/\/+$/, '');
  const model = String(input.model ?? existing?.model ?? '').trim();
  if (!name || name.length > 60) throw new ProviderError('Give the provider a name (up to 60 characters)');
  if (!KINDS.has(kind)) throw new ProviderError('Unknown provider type');
  let url;
  try { url = new URL(base_url); } catch { throw new ProviderError('The API URL must start with http:// or https://'); }
  if (!/^https?:$/.test(url.protocol)) throw new ProviderError('The API URL must start with http:// or https://');
  if (!model || model.length > 120) throw new ProviderError('Enter the model name');
  // undefined keeps the saved key; an empty string clears it.
  const api_key = input.api_key === undefined ? (existing?.api_key ?? '') : String(input.api_key).trim();
  return { name, kind, base_url, model, api_key, vision: input.vision === undefined ? (existing?.vision ? 1 : 0) : (input.vision ? 1 : 0) };
}

export function listProviders(db) {
  const active = Number(getSettings(db).ai_provider_id) || null;
  return db.prepare('SELECT * FROM ai_providers ORDER BY id').all().map((p) => ({
    id: p.id, name: p.name, kind: p.kind, base_url: p.base_url, model: p.model, vision: Boolean(p.vision),
    api_key_set: Boolean(p.api_key), api_key_hint: p.api_key ? `…${p.api_key.slice(-4)}` : '', active: p.id === active,
  }));
}

export function getProvider(db, id) {
  const p = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id);
  return p ? { ...p, vision: Boolean(p.vision) } : null;
}

/** The provider chosen in Settings, with its key (for the worker and the writer), or null. */
export function getActiveProvider(db) {
  const id = Number(getSettings(db).ai_provider_id);
  return id ? getProvider(db, id) : null;
}

export function addProvider(db, input) {
  const v = clean(input);
  const row = db.prepare('INSERT INTO ai_providers(name, kind, base_url, api_key, model, vision) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .get(v.name, v.kind, v.base_url, v.api_key, v.model, v.vision);
  // The first provider becomes the active one.
  if (!getActiveProvider(db)) setSetting(db, 'ai_provider_id', String(row.id));
  return row.id;
}

export function updateProvider(db, id, input) {
  const existing = getProvider(db, id);
  if (!existing) return false;
  const v = clean(input, existing);
  db.prepare('UPDATE ai_providers SET name = ?, kind = ?, base_url = ?, api_key = ?, model = ?, vision = ? WHERE id = ?')
    .run(v.name, v.kind, v.base_url, v.api_key, v.model, v.vision, id);
  return true;
}

export function deleteProvider(db, id) {
  db.prepare('DELETE FROM ai_providers WHERE id = ?').run(id);
  if (Number(getSettings(db).ai_provider_id) === Number(id)) {
    const next = db.prepare('SELECT id FROM ai_providers ORDER BY id LIMIT 1').get();
    setSetting(db, 'ai_provider_id', next ? String(next.id) : '');
  }
}
