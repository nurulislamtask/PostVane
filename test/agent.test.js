// End to end for the AI browser agent: a real Chrome, a local web page and a fake OpenAI-compatible server that plays the model.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findChrome, launchChrome } from '../src/ai/cdp.js';
import { runAgent, finishToBlock } from '../src/ai/agent.js';
import { chat, extractJson, listModels, LlmError } from '../src/ai/llm.js';
import { parseResultBlock } from '../src/runner.js';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

const PAGE = `<!doctype html><title>Composer</title><body>
<h1>Create post</h1>
<div id="box" role="textbox" contenteditable="true" aria-label="What's on your mind?" style="border:1px solid #999;min-height:60px"></div>
<input type="file" id="f" style="display:none">
<button id="post" onclick="document.getElementById('out').textContent='POSTED:'+document.getElementById('box').innerText">Post</button>
<div id="out"></div></body>`;

const refOf = (snapshot, re) => Number(new RegExp(`\\[(\\d+)\\] [^\\n]*${re}`).exec(snapshot)?.[1]);

test('extractJson finds an object inside words and code fences', () => {
  assert.deepEqual(extractJson('Sure! ```json\n{"a": {"b": "}"}}\n``` done'), { a: { b: '}' } });
  assert.equal(extractJson('no json here'), null);
});

test('chat sends the key and model, and classifies a rate limit', async () => {
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'models/b' }, { id: 'a' }] }));
      if (JSON.parse(body).model === 'limited') { res.statusCode = 429; return res.end(JSON.stringify({ error: { message: 'Quota exceeded' } })); }
      n++;
      res.end(JSON.stringify({ choices: [{ message: { content: `ok ${req.headers.authorization}` } }] }));
    });
  });
  const port = await listen(server);
  const p = { base_url: `http://127.0.0.1:${port}/v1/`, api_key: 'k123', model: 'm' };
  assert.equal((await chat(p, [{ role: 'user', content: 'hi' }])).text, 'ok Bearer k123');
  await assert.rejects(chat({ ...p, model: 'limited' }, [{ role: 'user', content: 'hi' }], { retries: 0 }), (e) => e instanceof LlmError && e.kind === 'rate_limit');
  assert.deepEqual(await listModels(p), ['a', 'b']);
  server.close();
});

test('the agent types and posts in a real Chrome, and reports the result block', { skip: !findChrome() && 'Chrome not installed', timeout: 90_000 }, async () => {
  const web = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); });
  const webPort = await listen(web);
  const url = `http://127.0.0.1:${webPort}/`;
  const script = (turn, last) => [
    () => ({ tool: 'navigate', args: { url } }),
    () => ({ tool: 'snapshot', args: {} }),
    () => ({ tool: 'type', args: { ref: refOf(last, 'textbox'), text: 'Hello\nworld' } }),
    () => ({ tool: 'snapshot', args: {} }),
    () => ({ tool: 'click', args: { ref: refOf(last, 'button "Post"') } }),
    () => ({ tool: 'page_text', args: {} }),
    () => ({ tool: 'finish', args: { status: 'submitted', clicked_post: false, note: last.includes('POSTED:Hello') ? 'saw it' : 'did not see it' } }),
  ][turn]();
  const llm = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const { messages } = JSON.parse(body);
      const turn = messages.filter((m) => m.role === 'assistant').length;
      const last = messages.at(-1).content;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: `Okay.\n${JSON.stringify(script(turn, last))}` } }] }));
    });
  });
  const llmPort = await listen(llm);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-agent-'));
  const session = await launchChrome({ profileDir: profile, headless: true });
  try {
    const res = await runAgent({
      provider: { base_url: `http://127.0.0.1:${llmPort}/v1`, model: 'fake', api_key: '' }, session, prompt: 'Post Hello world',
      hosts: ['127.0.0.1'], allowHttp: true, maxSteps: 12,
    });
    assert.equal(res.finished, true);
    assert.equal(res.finish.note, 'saw it');
    // The model said clicked_post:false but it clicked "Post": PostVane knows better.
    assert.equal(res.clickedSubmit, true);
    const block = parseResultBlock(finishToBlock(res));
    assert.equal(block.status, 'submitted');
    assert.equal(block.clicked_post, true);
  } finally {
    await session.close();
    web.close(); llm.close();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch { /* Windows may still hold a file */ }
  }
});

test('navigate refuses sites that are not social networks', { skip: !findChrome() && 'Chrome not installed', timeout: 60_000 }, async () => {
  const llm = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const { messages } = JSON.parse(body);
      const turn = messages.filter((m) => m.role === 'assistant').length;
      const a = turn === 0 ? { tool: 'navigate', args: { url: 'https://evil.example.com/' } }
        : { tool: 'finish', args: { status: 'failed', clicked_post: false, note: messages.at(-1).content } };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(a) } }] }));
    });
  });
  const port = await listen(llm);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-agent-'));
  const session = await launchChrome({ profileDir: profile, headless: true });
  try {
    const res = await runAgent({ provider: { base_url: `http://127.0.0.1:${port}/v1`, model: 'fake' }, session, prompt: 'x', maxSteps: 4 });
    assert.match(res.finish.note, /^Error: Only /);
  } finally {
    await session.close(); llm.close();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch { /* Windows may still hold a file */ }
  }
});
