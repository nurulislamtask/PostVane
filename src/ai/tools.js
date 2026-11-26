// The browser tools the AI can use. They match the tool names the post prompts already use (snapshot, click, type, press,
// scroll, wait, upload, navigate, page_text, screenshot), so the same prompts work with any model.
import path from 'node:path';
import { ALL_HOSTS } from '../platforms.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_ELEMENTS = 140;

// Runs in the page: lists what a person could click or type into, numbers it and remembers each element.
const SNAPSHOT_JS = `(() => {
  const SEL = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=textbox],[role=menuitem],[role=menuitemradio],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[contenteditable=""],[contenteditable=true],[contenteditable=plaintext-only],[tabindex]:not([tabindex="-1"])';
  const vw = innerWidth, vh = innerHeight;
  const seen = new Set(); const items = [];
  const visible = (el) => {
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return false;
    const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const label = (el) => {
    let t = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '';
    if (!t) t = (el.innerText || el.textContent || '').trim();
    if (!t && el.labels && el.labels[0]) t = el.labels[0].innerText.trim();
    if (!t && el.getAttribute('aria-labelledby')) { const l = document.getElementById(el.getAttribute('aria-labelledby').split(' ')[0]); if (l) t = l.innerText.trim(); }
    if (!t) t = el.value || '';
    return t.replace(/\\s+/g, ' ').slice(0, 90);
  };
  const dialogs = [...document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]')].filter(visible);
  const top = dialogs.length ? dialogs[dialogs.length - 1] : null;
  const root = top || document;
  window.__pv = [];
  for (const el of root.querySelectorAll(SEL)) {
    if (seen.has(el)) continue; seen.add(el);
    const isFile = el.tagName === 'INPUT' && el.type === 'file';
    if (!isFile && !visible(el)) continue;
    const id = window.__pv.length; window.__pv.push(el);
    const tag = el.tagName.toLowerCase(); const role = el.getAttribute('role');
    const editable = el.isContentEditable && tag !== 'input' && tag !== 'textarea';
    const kind = isFile ? 'file-input' : editable ? 'textbox' : tag === 'input' ? 'input:' + (el.type || 'text') : tag === 'a' ? 'link' : (role || tag);
    let line = '[' + id + '] ' + kind + ' "' + label(el).replace(/"/g, "'") + '"';
    if (editable) line += ' (editable)';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' (disabled)';
    if (el.checked) line += ' (checked)';
    if (el.getAttribute('aria-expanded') === 'true') line += ' (expanded)';
    if ((tag === 'input' || tag === 'textarea') && el.value && el.type !== 'password' && el.type !== 'file') line += ' value="' + el.value.slice(0, 60).replace(/"/g, "'") + '"';
    if (tag === 'a' && el.href) { try { const u = new URL(el.href); line += ' -> ' + (u.origin === location.origin ? u.pathname.slice(0, 60) : u.hostname); } catch (e) {} }
    items.push(line);
    if (items.length >= ${MAX_ELEMENTS}) break;
  }
  const scrolled = Math.round(scrollY), total = Math.round(document.documentElement.scrollHeight);
  return { url: location.href, title: document.title, dialog: Boolean(top), items, scrolled, total, vh };
})()`;

function elementExpr(ref) {
  const n = Number(ref);
  if (!Number.isInteger(n) || n < 0) throw new Error('ref must be a number from the latest snapshot');
  return `(window.__pv && window.__pv[${n}]) || null`;
}

// Buttons whose click sends something out; used to know a post may have gone out even if the AI forgets to say so.
export const SUBMIT_LABEL = /^(post|share|publish|tweet|send|submit|schedule|reply|comment|add comment|post all|post now|next post)\b/i;

/**
 * A set of tools bound to one browser session.
 * `opts.allowedFiles` limits upload; `opts.vision` makes screenshot return an image to the model.
 */
export function createTools(session, opts = {}) {
  const hosts = opts.hosts || ALL_HOSTS;
  const state = { clickedSubmit: false, lastClickLabel: '', images: [] };

  const allowedUrl = (raw) => {
    let u;
    try { u = new URL(raw); } catch { throw new Error('That is not a valid link'); }
    if (u.protocol !== 'https:' && u.protocol !== 'about:' && !(opts.allowHttp && u.protocol === 'http:')) throw new Error('Only https links can be opened');
    if (u.protocol !== 'about:' && !hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) {
      throw new Error(`Only ${hosts.slice(0, 6).join(', ')} and the other supported social sites can be opened`);
    }
    return u.toString();
  };

  const tools = {
    async snapshot() {
      const s = await session.eval(SNAPSHOT_JS);
      const head = [`url: ${s.url}`, `title: ${s.title}`,
        `scroll: ${s.scrolled}/${Math.max(0, s.total - s.vh)}px${s.dialog ? ' | a dialog is open: only its elements are listed' : ''}`];
      return `${head.join('\n')}\n${s.items.join('\n') || '(nothing to click or type into is visible; try scroll or wait)'}`;
    },

    async click({ ref }) {
      const info = await session.eval(`(() => { const el = ${elementExpr(ref)}; if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y);
        const ok = hit && (hit === el || el.contains(hit) || hit.contains(el));
        const label = (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().slice(0, 60);
        return { x, y, ok, label, disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true') }; })()`);
      if (!info) throw new Error('That element is gone. Call snapshot again.');
      if (info.disabled) throw new Error('That button is disabled. Finish the form first.');
      if (SUBMIT_LABEL.test(info.label)) state.clickedSubmit = true;
      state.lastClickLabel = info.label;
      if (info.ok) await session.click(info.x, info.y);
      else await session.eval(`(${elementExpr(ref)}).click()`); // something sits on top of it: click the element itself
      await sleep(900);
      return `clicked [${ref}] "${info.label}"`;
    },

    async type({ ref, text, clear = false }) {
      if (typeof text !== 'string') throw new Error('text must be a string');
      const info = await session.eval(`(() => { const el = ${elementExpr(ref)}; if (!el) return null;
        el.scrollIntoView({ block: 'center' }); el.focus(); const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName }; })()`);
      if (!info) throw new Error('That element is gone. Call snapshot again.');
      await session.click(info.x, info.y);
      if (clear) { await session.press('Control+a'); await session.press('Backspace'); }
      await session.typeText(text);
      await sleep(400);
      return `typed ${text.length} characters into [${ref}]`;
    },

    async press({ key }) { await session.press(key); await sleep(500); return `pressed ${key}`; },

    async scroll({ direction = 'down', amount = 600 }) {
      const dy = (direction === 'up' ? -1 : 1) * Math.min(3000, Math.max(100, Number(amount) || 600));
      await session.eval(`window.scrollBy(0, ${dy})`);
      await sleep(500);
      return `scrolled ${direction}`;
    },

    async wait({ seconds = 2 }) { const s = Math.min(30, Math.max(0.5, Number(seconds) || 2)); await sleep(s * 1000); return `waited ${s}s`; },

    async navigate({ url }) { await session.goto(allowedUrl(url)); return `opened ${await session.eval('location.href')}`; },

    async page_text() {
      const t = await session.eval(`(document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000)`);
      return t || '(the page has no text yet)';
    },

    async upload({ ref, paths }) {
      const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean).map(String);
      if (!list.length) throw new Error('paths is empty');
      const allowed = new Set((opts.allowedFiles || []).map((f) => path.resolve(f)));
      for (const f of list) if (!allowed.has(path.resolve(f))) throw new Error(`Only the files listed in the task can be uploaded: ${f}`);
      await session.setFiles(elementExpr(ref), list.map((f) => path.resolve(f)));
      await sleep(1500);
      return `attached ${list.length} file${list.length === 1 ? '' : 's'}`;
    },

    async screenshot() {
      if (!opts.vision) return 'Screenshots are not available with this model. Use snapshot and page_text instead.';
      state.images.push(await session.screenshot());
      return 'screenshot taken (attached below)';
    },
  };

  return { tools, state };
}

export const TOOL_HELP = `Tools (args are JSON):
- navigate {"url": "https://..."}  open a page (only the social site you were told to use)
- snapshot {}  list what is on screen as numbered refs, like [12] button "Post". Call it before click/type and after the page changes
- click {"ref": 12}
- type {"ref": 5, "text": "...", "clear": false}  click the field and type; new lines are fine
- press {"key": "Enter"}  also "Tab", "Escape", "Control+a", "ArrowDown", "Shift+Enter"
- scroll {"direction": "down", "amount": 600}
- wait {"seconds": 3}
- upload {"ref": 7, "paths": ["/full/path/file.jpg"]}  set files on a "file-input" ref; never click a file picker
- page_text {}  the text of the page
- screenshot {}  a picture of the page (only if your model can see images)
- finish {"status": "submitted|pending_approval|awaiting_join|failed|needs_login", "clicked_post": true, "post_url": null, "commented": false, "note": "short"}  call this last`;
