# profile-screenshots

MVP web service that captures full-page screenshots, raw HTML, and metadata for a list
of URLs — intended for preserving evidence of social-media posts and other web content
(e.g. for defamation/misinformation disputes) before it can be edited or deleted.

## Setup

```bash
nvm use        # Node 22 (see .nvmrc)
npm install    # also runs `playwright install chromium` and `scripts/install-fonts.sh` via postinstall
```

### Fonts (required on every host, including deploy targets)

Chromium needs Noto Sans Hebrew/Arabic and Noto Color Emoji to render non-Latin
scripts and emoji — without them, that text renders as blank boxes ("tofu") in
screenshots even though the underlying HTML is captured correctly. `npm install`
installs these automatically via `scripts/install-fonts.sh` (no root required —
installs to `~/.local/share/fonts`). If you deploy via a prebuilt image or a
process that skips `npm install`'s postinstall step, run this script explicitly
on the target host/image, or install the equivalent `fonts-noto-*` packages via
the OS package manager.

## Authentication

The app can require Google sign-in. Copy `.env.example` to `.env` and fill in:

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from a Google OAuth client
  (Web application type) in [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
  Add `<EXTERNAL_URL>/login/google/callback` to the client's "Authorized redirect URIs"
  (e.g. `https://screenshot.updatenowapp.com/login/google/callback`).
- `ALLOWED_EMAILS` — comma-separated allowlist of Google account emails. Leave empty
  to allow any verified Google account.
- `EXTERNAL_URL` — the public URL of this deployment (used to build the redirect URI
  and to decide whether session cookies should be marked `secure`).
- `REQUIRE_AUTH` — set to `false` to disable login entirely (open access).
- `SESSION_SECRET_KEY` — random secret for signing session cookies, e.g.
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

If `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are not set, the login page shows
"Google auth not configured" — set `REQUIRE_AUTH=false` in that case to keep the
site usable.

## Twitter/X authentication

Logged-out X/Twitter pages sometimes render a non-scrollable "teaser" with only
a handful of posts. If `TWITTER_AUTH_TOKEN` and `TWITTER_CT0` are set in `.env`,
captures of `x.com`/`twitter.com` URLs are made while logged in as that account,
which gives the full scrollable timeline. Get these values from browser dev tools
(F12 > Application > Cookies > x.com) — see `.env.example`. The `../x-scrape`
project's `.env` has a working set of values for the same account.

## Run

```bash
npm start
# Server listening on port 3000 (set PORT env var to change)
```

## Usage

Submit a capture job (fire and forget — returns immediately, processing happens
sequentially in the background):

```bash
curl -X POST http://localhost:3000/capture \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://example.com", "https://example.org"]}'
```

For infinite-scroll pages, pass `scrollCount` (0-100, default 0) to capture
additional viewport screenshots while scrolling down, stitched into one or more
`screenshot-N.png` files (see "Output" below). Pages without a scrollbar ignore
this option. A scroll phase is capped at 10 minutes total.

```bash
curl -X POST http://localhost:3000/capture \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://x.com/someuser"], "scrollCount": 10}'
```

Response:

```json
{ "jobId": "<uuid>", "status": "pending", "total": 2 }
```

Check job status / results:

```bash
curl http://localhost:3000/jobs/<uuid>
```

Each entry in `results` contains the requested URL, final URL after redirects, page
title, HTTP status, capture timestamp (UTC), and status (`success` or `error`).

Download all captures for a job as a ZIP (also available as a button in the web UI):

```bash
curl -o captures.zip http://localhost:3000/jobs/<uuid>/zip
```

## Output

Each job writes to `captures/<jobId>/<index>-<hostname>/`:

- `screenshot.png` (and `screenshot-2.png`, ... if `scrollCount` produced enough
  steps to exceed the per-image render limit) — full-page or stitched screenshot(s)
- `page.html` — raw HTML at capture time
- `metadata.json` — URL, final URL, title, timestamp, HTTP status, status/error,
  and (for scroll captures) `scrolls` and `screenshots` (list of image filenames)

`captures/` is local-only for this MVP. To preserve captures in Google Drive, sync or
move this directory there (e.g. via Google Drive Desktop, or `rclone copy`).

### Cleanup

At the start of every capture run, `captures/` is automatically pruned:

- any job folder older than **30 days** is deleted
- if the total size of `captures/` is still over **1GB**, the oldest remaining
  job folders are deleted (oldest first) until it's back under the limit

See `src/cleanup.js` to adjust these limits.

## Known issues / deferred work

- **Facebook post permalinks**: a `position: fixed` modal overlays the page and
  doesn't scroll with the background, so scroll-and-stitch captures show
  duplicated content. No fix applied; a proposed general "duplicate-frame
  detection" pass over stitched screenshots was deferred.
- **X/Twitter "blue bar" over text in scroll captures**: in earlier testing
  (logged out), repeated scroll steps sometimes left a UI element overlapping
  post text in the stitched image. An attempted fix (80% overlap + crop) did not
  help and was reverted. Logging in via `TWITTER_AUTH_TOKEN`/`TWITTER_CT0` (see
  "Twitter/X authentication" above) avoided this in the most recent test, but it
  hasn't been confirmed across multiple profiles/scroll depths.

## Notes

- Each URL is retried up to 2 times (with backoff) on navigation failure.
- A fresh browser context is used per URL for isolation.
- Job state is kept in memory only and is lost on server restart.
- The server unsets `DISPLAY`/`WAYLAND_DISPLAY` at startup — under WSLg these
  cause headless Chromium to hang on `page.screenshot()`. Harmless on servers
  where these aren't set.
