# Deploy (server)

Labee can run as a plain web server (the same Effect server the desktop app
embeds) on an Ubuntu box. Skills are read from `SKILLS_ROOTS`; users + sessions
live in SQLite under `LABEE_DATA_DIR`; the deck lives under `DECK_ROOT`.

## One-time provisioning

```sh
ssh ubuntu@HOST 'bash -s' < scripts/provision-server.sh
```

Installs Node 24, Bun, the `claude` CLI, a swap file, and the `labee` systemd
unit, and scaffolds `.env.production`.

## `.env.production`

```sh
SESSION_PASSWORD=<32+ random chars>     # required; sessions break if it rotates
LABEE_DATA_DIR=/home/ubuntu/labee/data
DECK_ROOT=/home/ubuntu/labee-decks
SKILLS_ROOTS=/home/ubuntu/labee/skills
COOKIE_SECURE=true                       # behind HTTPS; false on plain http
SIGNUP_ENABLED=false                     # invite-only; create users via the CLI

# Optional — "Sign in with Google" (OAuth 2.0). Omit both to disable the button.
GOOGLE_CLIENT_ID=<oauth client id>
GOOGLE_CLIENT_SECRET=<oauth client secret>
GOOGLE_REDIRECT_URI=https://your.host/api/auth/google/callback  # optional; derived from the request origin when unset
```

### Google sign-in setup

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
   create an **OAuth 2.0 Client ID** (type *Web application*).
2. Add an **Authorized redirect URI** of `<origin>/api/auth/google/callback`:
   - Production: `https://your.host/api/auth/google/callback`
   - Local dev: the Vite origin (which proxies `/api/*` to the server). This repo's
     web dev server defaults to `http://localhost:5733`; register
     `http://localhost:5733/api/auth/google/callback`, or run dev with `PORT=5173`
     to match a `:5173` registration. Set `GOOGLE_REDIRECT_URI` to the exact value
     you registered.
3. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. The login/signup pages show a
   Google button automatically once both are present.

Accounts are linked by email: signing in with Google for an existing email
attaches the Google identity to that account; otherwise a new, password-less
account is created (the first account on a fresh instance becomes admin).

## Deploy

```sh
SSH_HOST=1.2.3.4 bun run deploy
```

`scripts/deploy.sh` rsyncs the repo and runs `scripts/build-and-restart.sh` on
the server: `bun install` → build server + web → restart the `labee` service.

## Users

```sh
bun run user create you@example.com --admin
```

(The first user created is auto-promoted to admin either way.)
