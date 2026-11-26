// PostVane's own use of Chrome: each account has its own profile folder, so it logs in once and stays logged in.
// The dashboard uses this to open the login window; the worker uses the same folders to post.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchChrome, findChrome } from './cdp.js';
import { setAccountLogin } from '../db.js';

const LOGIN_URL = {
  facebook: 'https://www.facebook.com/login', linkedin: 'https://www.linkedin.com/login', x: 'https://x.com/i/flow/login',
  threads: 'https://www.threads.com/login', reddit: 'https://www.reddit.com/login', instagram: 'https://www.instagram.com/accounts/login/',
  tiktok: 'https://www.tiktok.com/login',
};
// A cookie that only exists once someone is signed in.
const LOGIN_COOKIES = {
  facebook: ['c_user'], linkedin: ['li_at'], x: ['auth_token'], instagram: ['sessionid'], threads: ['sessionid'],
  reddit: ['reddit_session', 'token_v2'], tiktok: ['sessionid', 'sid_tt'],
};

export const profileDir = (paths, accountId) => path.join(paths.home, 'browser', `acct-${accountId}`);
export { findChrome };

export function createLocalBrowser({ paths, db }) {
  const open = new Map(); // account id -> running session

  async function start(a, url, { watchLogin }) {
    if (open.get(a.id)?.alive) throw new Error('This account\'s browser window is already open.');
    const session = await launchChrome({ profileDir: profileDir(paths, a.id), url, visible: true });
    open.set(a.id, session);
    const names = LOGIN_COOKIES[a.platform] || [];
    const timer = setInterval(async () => {
      if (!session.alive) { clearInterval(timer); open.delete(a.id); return; }
      if (!watchLogin) return;
      try {
        const cookies = await session.cookies();
        if (cookies.some((c) => names.includes(c.name) && c.value)) {
          setAccountLogin(db, a.id, 'connected');
          watchLogin = false;
        }
      } catch { /* the window is closing */ }
    }, 2000);
    timer.unref?.();
    return session;
  }

  return {
    available: true,
    /** Opens the platform's login page. The account turns Connected as soon as the sign-in shows up in that window. */
    async login(a) { await start(a, LOGIN_URL[a.platform] || a.profile_url, { watchLogin: true }); },
    /** Opens the account's own page, e.g. to look at a post. */
    async open(a) { await start(a, a.profile_url, { watchLogin: false }); },
    /** Closes the account's window and forgets its saved login. */
    async logout(a) {
      const s = open.get(a.id);
      if (s?.alive) await s.close();
      open.delete(a.id);
      fs.rmSync(profileDir(paths, a.id), { recursive: true, force: true });
    },
    /** Turns a self-contained HTML design into a PNG (AI images). */
    async renderHtml(html, w, h) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postvane-render-'));
      const session = await launchChrome({ profileDir: dir, headless: true });
      try {
        await session.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
        await session.goto(`data:text/html;base64,${Buffer.from(html).toString('base64')}`, { timeoutMs: 15_000 });
        const r = await session.call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
        return Buffer.from(r.data, 'base64');
      } finally {
        await session.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    async fetchPages() { return null; },
    async closePane() {},
  };
}
