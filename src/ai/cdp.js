// A small Chrome DevTools Protocol client. PostVane starts the person's own Chrome (or Edge) with a separate profile
// folder per account, so each account logs in once and stays logged in. No browser download and no extra packages.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* already gone */ }
}

/** The Chrome, Edge or Chromium program to use, or null. POSTVANE_CHROME overrides the search. */
export function findChrome({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  if (env.POSTVANE_CHROME && exists(env.POSTVANE_CHROME)) return env.POSTVANE_CHROME;
  let list = [];
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      list.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      list.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      list.push(path.join(r, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (platform === 'darwin') {
    list = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  } else {
    const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
    for (const d of (env.PATH || '').split(':').filter(Boolean)) for (const n of names) list.push(path.join(d, n));
  }
  return list.find((f) => { try { return exists(f); } catch { return false; } }) || null;
}

/** A DevTools connection over one WebSocket. */
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    this.closed = false;
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}`)); else resolve(msg.result || {});
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
    const done = () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('The browser was closed'));
      this.pending.clear();
      for (const l of this.listeners) l({ method: 'cdp.closed', params: {} });
    };
    ws.addEventListener('close', done);
    ws.addEventListener('error', () => {});
  }

  static async connect(url, timeoutMs = 10_000) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Could not connect to the browser')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('Could not connect to the browser')); });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('The browser was closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((l) => l !== fn); }; }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' }, Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 }, Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 }, Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }, ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 }, PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  Home: { key: 'Home', code: 'Home', vk: 36 }, End: { key: 'End', code: 'End', vk: 35 },
};
const MODS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Shift: 8 };

/** One browser window of a launched Chrome, driven over DevTools. */
export class ChromeSession {
  constructor({ child, cdp, profileDir }) {
    this.child = child;
    this.cdp = cdp;
    this.profileDir = profileDir;
    this.sessionId = null;
    this.targetId = null;
    this.exited = false;
    this.dialogs = [];
    child.on('exit', () => { this.exited = true; });
    cdp.on((m) => this.#onEvent(m));
  }

  #onEvent(m) {
    if (m.method === 'Target.targetCreated' && m.params.targetInfo?.type === 'page' && m.params.targetInfo.openerId
      && m.params.targetInfo.openerId === this.targetId) {
      // A link or button opened a new tab: carry on there.
      this.attach(m.params.targetInfo.targetId).catch(() => {});
    }
    if (m.method === 'Page.javascriptDialogOpening' && m.sessionId === this.sessionId) {
      this.dialogs.push(m.params.message);
      this.cdp.send('Page.handleJavaScriptDialog', { accept: true }, this.sessionId).catch(() => {});
    }
  }

  get alive() { return !this.exited && !this.cdp.closed; }

  async attach(targetId) {
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = sessionId;
    this.targetId = targetId;
    await Promise.all([
      this.cdp.send('Page.enable', {}, sessionId), this.cdp.send('Runtime.enable', {}, sessionId),
      this.cdp.send('DOM.enable', {}, sessionId),
    ]);
    await this.cdp.send('Target.activateTarget', { targetId }).catch(() => {});
  }

  /** Attach to the first tab (or open one). */
  async init() {
    await this.cdp.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    const targetId = page ? page.targetId : (await this.cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
    await this.attach(targetId);
  }

  call(method, params = {}) { return this.cdp.send(method, params, this.sessionId); }

  async eval(expression, { timeoutMs = 20_000 } = {}) {
    const run = this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('The page did not answer in time')), timeoutMs));
    const r = await Promise.race([run, timeout]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'Script error');
    return r.result?.value;
  }

  async goto(url, { timeoutMs = 25_000 } = {}) {
    const loaded = new Promise((resolve) => {
      const off = this.cdp.on((m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === this.sessionId) { off(); resolve(); } });
      setTimeout(() => { off(); resolve(); }, timeoutMs);
    });
    const r = await this.call('Page.navigate', { url });
    if (r.errorText) throw new Error(`Could not open the page: ${r.errorText}`);
    await loaded;
    await sleep(1200);
  }

  async click(x, y) {
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  async insertText(text) { if (text) await this.call('Input.insertText', { text }); }

  /** "Enter", "Control+a", "Shift+Enter" or a single character. */
  async press(combo) {
    const parts = String(combo).split('+');
    const name = parts.pop();
    let modifiers = 0;
    for (const m of parts) modifiers |= MODS[m] || 0;
    const def = KEYS[name] || (name.length === 1
      ? { key: name, code: /[a-z]/i.test(name) ? `Key${name.toUpperCase()}` : name, vk: name.toUpperCase().charCodeAt(0), text: modifiers & 6 ? undefined : name }
      : null);
    if (!def) throw new Error(`Unknown key "${combo}"`);
    const ev = { key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk, modifiers };
    await this.call('Input.dispatchKeyEvent', { type: def.text ? 'keyDown' : 'rawKeyDown', ...ev, ...(def.text ? { text: def.text } : {}) });
    await this.call('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
  }

  /** Types text into the focused element; new lines become Shift+Enter so they never send the post. */
  async typeText(text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await this.press('Shift+Enter');
      await this.insertText(lines[i]);
    }
  }

  async screenshot() {
    const r = await this.call('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
    return r.data;
  }

  /** Puts files into an <input type=file> that the page script knows as `expression` (an element). */
  async setFiles(expression, files) {
    const { result } = await this.call('Runtime.evaluate', { expression });
    if (!result?.objectId) throw new Error('That element is gone. Call snapshot again.');
    await this.call('DOM.setFileInputFiles', { objectId: result.objectId, files });
  }

  async cookies() {
    const r = await this.cdp.send('Storage.getCookies');
    return r.cookies || [];
  }

  /** Closes Chrome and waits until it is really gone, so its profile folder is free again. */
  async close() {
    try { await Promise.race([this.cdp.send('Browser.close'), sleep(3000)]); } catch { /* it may already be gone */ }
    this.cdp.close();
    for (let i = 0; i < 60 && !this.exited; i++) await sleep(100);
    if (!this.exited) {
      killTree(this.child);
      for (let i = 0; i < 30 && !this.exited; i++) await sleep(100);
    }
  }
}

/**
 * Starts Chrome with its own profile folder and connects to it.
 * Throws a readable Error when Chrome is missing or this profile is already open in another window.
 */
export async function launchChrome({ profileDir, url = 'about:blank', visible = true, headless = false, exe = findChrome(), timeoutMs = 25_000 }) {
  if (!exe) throw new Error('Chrome or Edge was not found on this computer. Install Google Chrome and try again.');
  fs.mkdirSync(profileDir, { recursive: true });
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  const args = [
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate', '--window-size=1280,900',
    ...(headless ? ['--headless=new', '--disable-gpu'] : visible ? [] : ['--window-position=-2400,-2400']),
    url,
  ];
  const child = spawn(exe, args, { stdio: 'ignore', windowsHide: false });
  child.unref(); // a window the person keeps open must not keep PostVane's own process alive
  let early = null;
  child.on('exit', (code) => { early = code; });
  child.on('error', (e) => { early = e.message; });

  const end = Date.now() + timeoutMs;
  let info = null;
  while (Date.now() < end) {
    if (fs.existsSync(portFile)) {
      const [port, wsPath] = fs.readFileSync(portFile, 'utf8').split('\n');
      if (port && wsPath) { info = { port: Number(port), wsPath: wsPath.trim() }; break; }
    }
    if (early !== null && early !== undefined) break;
    await sleep(150);
  }
  if (!info) {
    killTree(child);
    throw new Error(early !== null ? 'This account\'s browser window is already open. Close it and try again.' : 'The browser did not start in time');
  }
  const cdp = await Cdp.connect(`ws://127.0.0.1:${info.port}${info.wsPath}`);
  const session = new ChromeSession({ child, cdp, profileDir });
  await session.init();
  return session;
}
