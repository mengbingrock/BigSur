# Labee

Labee is a desktop + web app for running research work with coding agents: a
chat workspace backed by the Claude CLI, an interactive canvas, a catalog of
reusable skills/protocols, and a per-user file deck.

It is a Bun + Turbo monorepo. The web UI is a Vite + React SPA, the backend is
an Effect HTTP server, and the desktop app is an Electron shell that embeds the
server.

## Layout

```
apps/
  web/        Vite + React 19 SPA (TanStack Router, Tailwind v4)
  server/     Effect HTTP server (auth, skills, deck, chat SSE) — serves the web client
  desktop/    Electron shell that forks the bundled server
packages/
  contracts/  Effect Schema types shared across web + server
  shared/     framework-agnostic helpers
db/           drizzle users schema (SQLite local/desktop, Postgres server)
scripts/      dev-runner, desktop artifact builder, deploy, user CLI
```

## Requirements

- Bun (`packageManager` pins the version)
- Node 24+ (the server runs under Node when packaged; `node:sqlite` is used)
- The `claude` CLI installed and authenticated (the chat/extraction features
  spawn it; override the binary with `CLAUDE_BIN`)

## Development

```sh
bun install
bun run dev          # server (:3000) + web (:5733, proxies /api → server)
```

Other entry points:

```sh
bun run dev:server   # server only
bun run dev:web      # web only
bun run dev:desktop  # server + web + electron
```

## Build

```sh
bun run build              # all workspaces (contracts, web, server, desktop)
bun run dist:desktop:dmg   # packaged macOS .dmg (electron-builder)
```

## Users

User accounts live in a SQLite store (`data/labee.sqlite`, or `LABEE_DATA_DIR`).
The first account created is auto-promoted to admin. Manage from the CLI:

```sh
bun run user list
bun run user create you@example.com --admin
```

See [docs/architecture.md](./docs/architecture.md) for how the pieces fit
together and [docs/deploy.md](./docs/deploy.md) for server deployment.
