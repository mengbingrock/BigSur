# Deploying Monterey to Lightsail (Ubuntu)

The packed deploy targets a single Ubuntu box (we tested on Lightsail 24.04).
It does **not** configure HTTPS — that's a follow-up. Everything below assumes
you're deploying from your Mac.

## What gets installed on the server

- 1 GB swap file (Lightsail nano has 512 MB RAM; Next.js builds OOM otherwise)
- Node.js 20 (via NodeSource)
- `@anthropic-ai/claude-code` (global npm)
- python3 + pip + LibreOffice (for docx/xlsx/pptx skills)
- `/etc/systemd/system/monterey.service`
- App code at `/home/ubuntu/agent-monterey`
- Skills at `/home/ubuntu/protocol-skills` (symlink target for per-chat sessions)
- `.env.production` with a random `SESSION_PASSWORD`, `SIGNUP_ENABLED=false`,
  and `SKILLS_ROOTS=/home/ubuntu/protocol-skills`

## Defaults

| Var | Default |
|---|---|
| `SSH_HOST` | _(required)_ — e.g. `1.2.3.4` |
| `SSH_USER` | `ubuntu` |
| `SSH_KEY` | `~/Downloads/lightsail.pem` |
| `REMOTE_DIR` | `/home/ubuntu/agent-monterey` |
| `REMOTE_SKILLS_DIR` | `/home/ubuntu/protocol-skills` |
| `LOCAL_SKILLS_DIR` | `~/WorkSync/Git/protocol-agent/.claude/skills` |

Override any of them inline, e.g. `SSH_HOST=1.2.3.4 npm run deploy`.

## First-time deploy (from your Mac)

```bash
# permission fix once — Lightsail .pem downloads come in with 0644
chmod 400 ~/Downloads/lightsail.pem

npm run deploy
```

This will:

1. `ssh` check
2. rsync the app code + skills to the server
3. Run provisioning on the server (installs everything listed above; idempotent)
4. `npm ci && next build` on the server
5. `systemctl restart monterey`

**Expect the first deploy to take 2–5 minutes** — mostly from downloading
LibreOffice, Node, and npm dependencies. Later deploys skip most of that and
take ~30 s.

## One-time post-install steps

These aren't automated — they require human decisions.

### 1. Authenticate the Claude CLI on the server

The Next.js app spawns `claude -p …` as your `ubuntu` user. That subprocess
needs to be logged into claude.ai. Two options:

**Option A — Set up a long-lived token from your Mac, paste on server:**

```bash
# On your Mac:
claude setup-token
# copy the printed token

# SSH to the server:
ssh -i ~/Downloads/lightsail.pem ubuntu@<your-server-ip>

# Paste the token into a fresh login flow:
claude /login
# or run `claude` interactively and follow prompts
```

**Option B — Port-forward the OAuth callback:**

```bash
ssh -i ~/Downloads/lightsail.pem -L 8976:localhost:8976 ubuntu@<your-server-ip>
claude /login
# Open the printed URL in your Mac browser; the callback comes back through
# the SSH tunnel.
```

Verify: `claude auth status` should return `"loggedIn": true`.

### 2. Open the firewall

Lightsail doesn't auto-open custom ports. In the AWS console:

1. Go to your instance → **Networking** tab.
2. **IPv4 Firewall** → **Add rule**
3. **Custom TCP**, port `3000`, source `My IP` (or `0.0.0.0/0` if you
   must — remember this is HTTP without TLS).

### 3. Create the first admin account

Public signup is **disabled** by default (we set `SIGNUP_ENABLED=false`). Create
yourself via the CLI:

```bash
ssh -i ~/Downloads/lightsail.pem ubuntu@<your-server-ip>
cd /home/ubuntu/agent-monterey
npm run user create you@example.com --admin
# prompts for password
```

Then visit `http://<your-server-ip>:3000`, sign in.

## Updating (subsequent deploys)

Run `npm run deploy` again. Everything is idempotent:

- Only changed files are rsynced.
- Provisioning steps all `skip` after the first run.
- Deps are re-installed only if `package-lock.json` changed (`npm ci`).
- The service is restarted at the end.

Your `data/users.json`, `.env.production`, and `claude` auth are never touched.

## Managing the running service

```bash
ssh -i ~/Downloads/lightsail.pem ubuntu@<your-server-ip>

sudo systemctl status monterey          # state + last few log lines
sudo journalctl -u monterey -f           # tail logs
sudo systemctl restart monterey          # after manual config edit
sudo systemctl stop monterey             # take offline
```

## Uninstall

```bash
ssh -i ~/Downloads/lightsail.pem ubuntu@<your-server-ip>
sudo systemctl disable --now monterey
sudo rm /etc/systemd/system/monterey.service
sudo systemctl daemon-reload
rm -rf /home/ubuntu/agent-monterey /home/ubuntu/protocol-skills
```

Swap file and installed packages are left as-is.

## What's NOT done (intentional)

- **HTTPS**: the server only listens on `:3000` over HTTP. Passwords travel
  in cleartext. For anything beyond a private test:
  - Easiest: add a Cloudflare Tunnel — no domain needed, automatic TLS. Run
    `cloudflared` as another systemd service.
  - Classic: point a domain at the Lightsail IP, install nginx + certbot.
- **Persistent disk**: users and chat artifacts live on the instance root
  disk; snapshots are your backup.
- **Rate limiting**: none. Your Claude Max subscription is the only backstop.
- **Multi-replica**: `iron-session` cookies can survive multiple replicas,
  but the file-based user store and in-memory workspace map can't. One box
  only.
