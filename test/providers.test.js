import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setup } from './helpers.js';
import { getSettings, setSetting, DEFAULT_SETTINGS } from '../src/db.js';
import { addProvider, addProviders, updateProvider, deleteProvider, listProviders, getEnabledProviders, ProviderError } from '../src/ai/providers.js';
import { createPool, restFor } from '../src/ai/pool.js';
import { LlmError } from '../src/ai/llm.js';
import { runJob } from '../src/runner.js';

// A fake OpenAI-compatible server: `behave(model, key)` returns { status, body } or a text reply.
function fakeApi(behave) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const { model } = JSON.parse(raw);
      const key = (req.headers.authorization || '').replace('Bearer ', '');
      calls.push({ model, key });
      const r = behave(model, key);
      res.statusCode = r.status || 200;
      res.setHeader('content-type', 'application/json');
      if (r.retryAfter) res.setHeader('retry-after', String(r.retryAfter));
      res.end(JSON.stringify(r.status && r.status !== 200 ? { error: { message: r.message || 'error' } }
        : { choices: [{ message: { content: r.text ?? `from ${model}/${key}` } }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/v1` })));
}
const MSG = [{ role: 'user', content: 'hi' }];

test('keys are masked, kept on edit, and bulk add makes one entry per model and key', () => {
  const { db } = setup();
  const a = addProvider(db, { kind: 'openrouter', name: 'OR', base_url: 'https://openrouter.ai/api/v1/', model: 'x/y:free', api_key: 'sk-secret-1234' });
  let list = listProviders(db);
  assert.equal(list[0].api_key_hint, '…1234');
  assert.equal(JSON.stringify(list).includes('sk-secret'), false);
  assert.equal(list[0].base_url, 'https://openrouter.ai/api/v1');
  updateProvider(db, a, { model: 'other/model' });
  assert.equal(getEnabledProviders(db)[0].api_key, 'sk-secret-1234');
  const ids = addProviders(db, { kind: 'gemini', name: 'Gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['m1', 'm2', 'm1'], api_keys: ['k1', 'k2'] });
  assert.equal(ids.length, 4); // 2 models x 2 keys; duplicate model ignored
  list = listProviders(db);
  assert.equal(list.length, 5);
  assert.ok(list.some((p) => p.name === 'Gemini · m2 (key 2)'));
  assert.throws(() => addProviders(db, { kind: 'custom', name: 'x', base_url: 'https://x.test', models: Array.from({ length: 61 }, (_, i) => `m${i}`) }), ProviderError);
  // switching one off removes it from the pool
  updateProvider(db, a, { enabled: false });
  assert.equal(getEnabledProviders(db).length, 4);
  deleteProvider(db, a);
  assert.equal(listProviders(db).length, 4);
});

test('bad provider input is refused', () => {
  const { db } = setup();
  assert.throws(() => addProvider(db, { kind: 'custom', name: 'x', base_url: 'ftp://x', model: 'm' }), ProviderError);
  assert.throws(() => addProvider(db, { kind: 'custom', name: 'x', base_url: 'https://x.test', model: '' }), ProviderError);
  assert.throws(() => addProvider(db, { kind: 'nope', name: 'x', base_url: 'https://x.test', model: 'm' }), ProviderError);
});

test('no pool without a model; rest times depend on the error', () => {
  const { db } = setup();
  assert.equal(createPool(db), null);
  assert.equal(restFor(new LlmError('rate_limit', 'Too many requests', 429)), 15 * 60_000);
  assert.equal(restFor(new LlmError('rate_limit', 'You exceeded your daily quota', 429)), 180 * 60_000);
  assert.equal(restFor(new LlmError('rate_limit', 'slow down', 429, 90_000)), 90_000);
  assert.equal(restFor(new LlmError('auth', 'bad key', 401)), 24 * 60 * 60_000);
});

test('when a free model hits its limit the next one takes over, and it stays resting', async () => {
  const { db } = setup();
  const api = await fakeApi((model) => (model === 'first' ? { status: 429, message: 'Rate limit exceeded' } : { text: `answer from ${model}` }));
  setSetting(db, 'ai_strategy', 'failover');
  addProviders(db, { kind: 'custom', name: 'X', base_url: api.url, models: ['first', 'second', 'third'] });
  const pool = createPool(db);
  assert.equal((await pool.chat(MSG)).text, 'answer from second');
  assert.deepEqual(api.calls.map((c) => c.model), ['first', 'second']);
  const first = listProviders(db).find((p) => p.model === 'first');
  assert.ok(first.cooldown_until > Date.now());
  assert.match(first.last_error, /rate_limit/);
  // a new job skips the resting model without even trying it
  api.calls.length = 0;
  assert.equal((await createPool(db).chat(MSG)).text, 'answer from second');
  assert.deepEqual(api.calls.map((c) => c.model), ['second']);
  api.server.close();
});

test('rotation: each new job starts with the model used longest ago', async () => {
  const { db } = setup();
  const api = await fakeApi(() => ({}));
  addProviders(db, { kind: 'custom', name: 'X', base_url: api.url, models: ['a', 'b'], api_keys: ['k1', 'k2'] });
  const now = (() => { let t = 1_000_000; return () => (t += 1000); })();
  const order = [];
  for (let i = 0; i < 5; i++) { const r = await createPool(db, { now }).chat(MSG); order.push(r.text); }
  assert.deepEqual(order, ['from a/k1', 'from b/k1', 'from a/k2', 'from b/k2', 'from a/k1']);
  api.server.close();
});

test('one job keeps its model for every step until it fails', async () => {
  const { db } = setup();
  const api = await fakeApi(() => ({}));
  addProviders(db, { kind: 'custom', name: 'X', base_url: api.url, models: ['a', 'b'] });
  const pool = createPool(db);
  const texts = [];
  for (let i = 0; i < 3; i++) texts.push((await pool.chat(MSG)).text);
  assert.deepEqual(texts, ['from a/', 'from a/', 'from a/']);
  api.server.close();
});

test('a refused key moves on and rests for a day; all limited gives a rate-limit error that says when', async () => {
  const { db } = setup();
  const api = await fakeApi((model, key) => (key === 'bad' ? { status: 401, message: 'Invalid API key' } : model === 'm2' ? { status: 429, message: 'Rate limit' } : {}));
  addProviders(db, { kind: 'custom', name: 'X', base_url: api.url, models: ['m1'], api_keys: ['bad', 'good'] });
  assert.equal((await createPool(db).chat(MSG)).text, 'from m1/good');
  const bad = listProviders(db).find((p) => p.name.includes('key 1'));
  assert.ok(bad.cooldown_until > Date.now() + 23 * 3600_000);
  // now only rate limits are left
  const { db: db2 } = setup();
  addProviders(db2, { kind: 'custom', name: 'X', base_url: api.url, models: ['m2', 'm2b'] });
  const api2 = await fakeApi(() => ({ status: 429, message: 'Rate limit' }));
  db2.prepare('UPDATE ai_providers SET base_url = ?').run(api2.url);
  await assert.rejects(createPool(db2).chat(MSG), (e) => e.kind === 'rate_limit' && /Every AI model in the pool/.test(e.message));
  // and the next job learns that immediately, without calling anything
  api2.calls.length = 0;
  await assert.rejects(createPool(db2).chat(MSG), (e) => e.kind === 'rate_limit');
  assert.equal(api2.calls.length, 0);
  api.server.close(); api2.server.close();
});

test('the api engine is the default; without a model or a login nothing is posted', async () => {
  assert.equal(DEFAULT_SETTINGS.engine, 'api');
  const { p, db } = setup();
  setSetting(db, 'engine', 'api');
  const settings = getSettings(db);
  const job = { id: 1, attempts: 1, account_ref: 5, account_name: 'Shop', account_login_state: 'none', post_body: 'Hi', destination_platform: 'facebook' };
  const none = await runJob(job, [], { paths: p, settings, provider: null });
  assert.equal(none.result.status, 'failed');
  assert.match(none.result.note, /AI model/);
  assert.equal(none.result.clicked_post, false);
  const login = await runJob(job, [], { paths: p, settings, provider: { name: 'P', model: 'm', chat: async () => ({ text: '' }) } });
  assert.equal(login.result.status, 'needs_login');
  assert.match(login.result.note, /Log in to "Shop"/);
});
