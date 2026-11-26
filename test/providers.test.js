import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { getSettings, setSetting, DEFAULT_SETTINGS } from '../src/db.js';
import { addProvider, updateProvider, deleteProvider, listProviders, getActiveProvider, ProviderError } from '../src/ai/providers.js';
import { runJob } from '../src/runner.js';

test('the first provider becomes active, keys are masked and kept on edit', () => {
  const { db } = setup();
  assert.equal(getActiveProvider(db), null);
  const a = addProvider(db, { kind: 'openrouter', name: 'OR', base_url: 'https://openrouter.ai/api/v1/', model: 'x/y:free', api_key: 'sk-secret-1234' });
  const b = addProvider(db, { kind: 'ollama', name: 'Local', base_url: 'http://127.0.0.1:11434/v1', model: 'qwen2.5' });
  assert.equal(getActiveProvider(db).id, a);
  const list = listProviders(db);
  assert.equal(list[0].api_key_set, true);
  assert.equal(list[0].api_key_hint, '…1234');
  assert.equal(JSON.stringify(list).includes('sk-secret'), false);
  assert.equal(list[0].base_url, 'https://openrouter.ai/api/v1');
  // editing without a key keeps the saved one
  updateProvider(db, a, { model: 'other/model' });
  assert.equal(getActiveProvider(db).api_key, 'sk-secret-1234');
  assert.equal(getActiveProvider(db).model, 'other/model');
  // deleting the active one falls back to the next
  deleteProvider(db, a);
  assert.equal(getActiveProvider(db).id, b);
  deleteProvider(db, b);
  assert.equal(getActiveProvider(db), null);
});

test('bad provider input is refused', () => {
  const { db } = setup();
  assert.throws(() => addProvider(db, { kind: 'custom', name: 'x', base_url: 'ftp://x', model: 'm' }), ProviderError);
  assert.throws(() => addProvider(db, { kind: 'custom', name: 'x', base_url: 'https://x.test', model: '' }), ProviderError);
  assert.throws(() => addProvider(db, { kind: 'nope', name: 'x', base_url: 'https://x.test', model: 'm' }), ProviderError);
});

test('the api engine is the default; without a provider or a login nothing is posted', async () => {
  assert.equal(DEFAULT_SETTINGS.engine, 'api');
  const { p, db } = setup();
  setSetting(db, 'engine', 'api');
  const settings = getSettings(db);
  const job = { id: 1, attempts: 1, account_ref: 5, account_name: 'Shop', account_login_state: 'none', post_body: 'Hi', destination_platform: 'facebook' };
  const none = await runJob(job, [], { paths: p, settings, provider: null });
  assert.equal(none.result.status, 'failed');
  assert.match(none.result.note, /AI provider/);
  assert.equal(none.result.clicked_post, false);
  const provider = { name: 'P', model: 'm', base_url: 'http://127.0.0.1:1', api_key: '' };
  const login = await runJob(job, [], { paths: p, settings, provider });
  assert.equal(login.result.status, 'needs_login');
  assert.match(login.result.note, /Log in to "Shop"/);
});
