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

- `screenshot.png` — full-page screenshot
- `page.html` — raw HTML at capture time
- `metadata.json` — URL, final URL, title, timestamp, HTTP status, status/error

`captures/` is local-only for this MVP. To preserve captures in Google Drive, sync or
move this directory there (e.g. via Google Drive Desktop, or `rclone copy`).

### Cleanup

At the start of every capture run, `captures/` is automatically pruned:

- any job folder older than **30 days** is deleted
- if the total size of `captures/` is still over **1GB**, the oldest remaining
  job folders are deleted (oldest first) until it's back under the limit

See `src/cleanup.js` to adjust these limits.

## Notes

- Each URL is retried up to 2 times (with backoff) on navigation failure.
- A fresh browser context is used per URL for isolation.
- Job state is kept in memory only and is lost on server restart.
- The server unsets `DISPLAY`/`WAYLAND_DISPLAY` at startup — under WSLg these
  cause headless Chromium to hang on `page.screenshot()`. Harmless on servers
  where these aren't set.
