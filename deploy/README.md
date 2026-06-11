# Deployment

## Fresh server

Requirements: Ubuntu 22.04+, SSH access as `ubuntu`, passwordless `sudo`, Caddy already
running (shared with other apps on the host).

```bash
ssh ubuntu@stream-capture.updatenowapp.com
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/shellef/screenshots/main/deploy/bootstrap.sh)"
```

Or, after cloning manually:

```bash
ssh ubuntu@stream-capture.updatenowapp.com
git clone https://github.com/shellef/screenshots.git ~/screenshots
sudo bash ~/screenshots/deploy/bootstrap.sh
```

This installs Node.js, clones the repo to `~/screenshots`, runs `npm install`
(which installs Chromium plus Hebrew/Arabic/emoji fonts), installs Chromium's
system dependencies, adds a Caddy site block for `screenshot.updatenowapp.com`,
and creates/starts the `screenshots` systemd service on port 8002.

## Push updates

From your local machine:

```bash
bash deploy/deploy.sh
# or for a different host:
bash deploy/deploy.sh ubuntu@other-host.example.com
```

## Service

| Service | Description |
|---|---|
| `screenshots` | Node/Express capture service on `127.0.0.1:8002` |
| `caddy` | HTTPS reverse proxy (shared with other apps on this host) |

```bash
# Check logs
sudo journalctl -u screenshots -f
```

## Notes

- `captures/` is stored locally on the server under `~/screenshots/captures/`
  and is **not** included in git. It will grow over time — monitor disk usage
  or move to external/Drive storage as a follow-up.
- Job state (`/jobs/:id`) is in-memory and is lost on service restart.
