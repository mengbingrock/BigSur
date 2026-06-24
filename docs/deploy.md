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
```

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
