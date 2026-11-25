# PostVane

[![Test and build](https://github.com/nurulislamtask/PostVane/actions/workflows/build.yml/badge.svg)](https://github.com/nurulislamtask/PostVane/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Android-lightgrey)
![Node](https://img.shields.io/badge/node-24%2B-339933?logo=node.js&logoColor=white)

![PostVane](docs/cover.png)

A local social media post scheduler for Facebook, LinkedIn, X, Threads, Reddit, Instagram and TikTok. You write and schedule posts in a React dashboard. At post time, a local
worker runs **Claude Code on your Claude subscription** with the **Claude in Chrome** extension, and Claude
publishes the post on the website in your signed-in Chrome, the way you would by hand.

- No Anthropic API, API keys or token billing. The worker removes `ANTHROPIC_API_KEY` and similar variables
  from Claude's environment and never uses `--bare`, which would bypass the subscription login.
- No Graph API, Meta, X, LinkedIn, Reddit or TikTok API, and no MCP publishing server. Chrome is the only tool Claude gets.

```
Dashboard (React) → Express API → SQLite → worker (every 60s) → claude -p --chrome → Chrome → the social network
```

## Download

Get the latest builds from the [Releases page](https://github.com/nurulislamtask/PostVane/releases/latest):

| File | What it is |
|---|---|
| `PostVane-<version>-win-x64.exe` | Windows installer. Runs PostVane in a window and the system tray, so scheduled posts keep going out. |
| `PostVane-<version>-android.apk` | Android **companion app**. It opens the dashboard of the PostVane running on your computer (see below). |

Windows may show "Windows protected your PC" because the installer isn't code-signed: click **More info → Run anyway**.

### Android companion

Posts are published by Claude Code and Chrome on a computer, so the phone can't publish by itself. The app is a window
onto the dashboard running on your computer, so you can schedule and check posts from your phone.

1. Run PostVane on your computer and keep it on.
2. Start it reachable from your phone **on a private network you trust**, for example Tailscale:
   `POSTVANE_HOST=<your private address> npm start` (on Windows: set the variable first).
   The dashboard has **no login**, so never expose it to the public internet or an untrusted Wi-Fi.
3. Install the APK, open it and enter `http://<that address>:4317`.

The first-run **Setup** page walks you through Claude Code, login, Chrome and a test post, about 5 minutes, once.

## Use it

1. **Settings:** if more than one Chrome is connected to Claude, set **Facebook account** to the address
   `facebook.com/me` lands on, so only that account posts. Edit how Claude describes you when a group asks
   membership questions.
2. **Destinations:** add your profile (`https://www.facebook.com/me` works), Pages you can post as, and groups you can post in.
3. **Compose:** write text, attach photos or one video, tick destinations, pick a time.
4. **Queue:** watch each post's status and read Claude's report for any run.

## Platforms

| Platform | Destinations | Notes |
|---|---|---|
| Facebook | Profile, Pages, groups | Joins groups first if needed and answers membership questions. Each group can post as you or as one of your Pages (**Post as** in Destinations). |
| LinkedIn | Profile, company Pages, groups | Page posts go out as the Page. |
| X | Profile | Long text fails unless your account allows it; Claude never shortens it. Up to 4 photos. |
| Threads | Profile | |
| Reddit | Your profile, subreddits | The first line of the post is the title. Claude picks a flair when one is required. |
| Instagram | Profile | Needs a photo or a video. |
| TikTok | Profile | Needs a video. |

Chrome must be signed in to each account you post to. The group gap applies between group posts on the same platform.

## Statuses

| Status | Meaning |
|---|---|
| Queued | Waiting for its time, the group gap or the daily cap |
| Posting… | Claude is working in Chrome |
| Posted | Claude clicked Post and then saw the post live on the profile, Page or group. If it can't see it live, the post goes to "Needs check" instead. |
| Pending approval | Posted to a group that needs admin approval |
| Failed | Claude stopped **before** clicking Post (login wall, checkpoint, no permission). Retried once automatically. |
| Needs check | Claude may have clicked Post but the result is unclear (crash, timeout, unreadable report). **Never retried automatically.** Check Facebook, then choose "It posted" or "It didn't post — retry now". |

## Limits and risks

- **Facebook's terms restrict automated access.** Posting the same content to many groups looks like spam.
  The daily cap (default 10) and group gap (default 20 min) reduce the risk but don't remove it.
- **Subscription usage.** Each post is a full Claude Code browser session. The first test used about
  25 steps and roughly 730k tokens (mostly cached) on Sonnet, in about 2.5 minutes. That counts against your
  plan's usage limits. When a limit is hit, the worker pauses for 1 hour and requeues the post.
- **Check the terms yourself.** Make sure that running Claude Code unattended on a schedule is allowed by
  your current Claude subscription terms.
- **Media size per post: 10 MB.** Uploads go through the Claude in Chrome extension,
  whose file upload stops at 10 MB, so most phone videos won't fit.
- If the computer sleeps, Chrome is closed or Facebook logs you out, posts run late or fail and the dashboard shows it.
  CAPTCHAs and security checks are never bypassed; the post fails and you handle it.
- One Facebook login (the one in Chrome). Pages are posted to by switching into the Page.

## Development

```bash
npm test        # node:test, uses a fake claude binary — no Facebook, no usage
npm run dev     # Vite dev server on :5173, proxying to npm start on :4317
```

Data lives in `data/` (SQLite), `media/` (uploads), `jobs/` (per-run copies) and `logs/` (raw Claude output per run).

## Development

```bash
npm test        # node:test, uses a fake claude binary — no Facebook, no usage
npm run dev     # Vite dev server on :5173, proxying to npm start on :4317
npm run app     # build and open the desktop app (Electron)
```

Data lives in `data/` (SQLite), `media/` (uploads), `jobs/` (per-run copies) and `logs/` (raw Claude output per run).
The desktop app keeps the same folders in your user app-data folder. Releases are described in [docs/RELEASING.md](docs/RELEASING.md).

## Credits and license

[MIT](LICENSE). PostVane is based on [Autoposter](https://github.com/raketbizdev/autoposter) by Ruel Nopal, also MIT.
Not affiliated with, endorsed by or sponsored by Meta or Anthropic. You are responsible for
following the terms of each social network and your Claude plan when you use it.
