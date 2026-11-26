import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// POSTVANE_HOME lets tests run against a throwaway folder.
export function paths(home = process.env.POSTVANE_HOME || projectRoot) {
  const p = {
    root: projectRoot,
    home,
    data: path.join(home, 'data'),
    db: path.join(home, 'data', 'postvane.db'),
    lock: path.join(home, 'data', 'worker.lock'),
    media: path.join(home, 'media'),
    jobs: path.join(home, 'jobs'),
    logs: path.join(home, 'logs'),
    webDist: path.join(projectRoot, 'web', 'dist'),
  };
  for (const dir of [p.data, p.media, p.jobs, p.logs]) fs.mkdirSync(dir, { recursive: true });
  return p;
}

export const PORT = Number(process.env.POSTVANE_PORT || 4317);
// Local only by default. The dashboard has no login, so only set POSTVANE_HOST to an address on a private network you
// trust (for example a Tailscale address), never 0.0.0.0 on a public network.
export const HOST = process.env.POSTVANE_HOST || '127.0.0.1';

// Claude in Chrome's file upload caps one call at 10 MB. The desktop app attaches files itself, in its own posting
// window, so big videos (TikTok, Reels) fit: up to 4 GB.
export const CHROME_MAX_BYTES = 10 * 1024 * 1024;
export const APP_MAX_BYTES = 4 * 1024 * 1024 * 1024;
// With the 'api' engine files go straight into your Chrome, so large videos are fine. The Claude engine's Chrome extension
// stops at 10 MB: runner.js refuses bigger files for that engine when the post runs.
const DESKTOP = true;
export const LIMITS = {
  maxFileBytes: DESKTOP ? APP_MAX_BYTES : CHROME_MAX_BYTES,
  maxTotalBytes: DESKTOP ? APP_MAX_BYTES : CHROME_MAX_BYTES,
  maxFiles: 10,
};
export const sizeLabel = (bytes) => (bytes >= 1024 ** 3 ? `${Math.round(bytes / 1024 ** 3)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);
