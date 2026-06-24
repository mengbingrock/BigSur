# Architecture

Labee is a Bun + Turbo monorepo with three apps and two shared packages.

## Runtime shape

```
                    ┌─────────────────────────────┐
   Browser / BrowserWindow  ──HTTP/SSE──►  @labee/server (Effect HTTP)
                    │                       │  - /api/* (auth, skills, deck, chat…)
   @labee/web (Vite SPA)                    │  - serves the built web client
                    └─────────────────────────────┘
                                            │ spawns
                                            ▼
                                       claude CLI
```

- **apps/web** — Vite + React 19 SPA. TanStack Router (hash history under
  Electron, browser history on the web), react-query for data, a
  `useSyncExternalStore` chat store, and the React-Flow canvas (lazy chunk).
  Talks to the server over `/api/*` (JSON) and an SSE stream for chat.
- **apps/server** — Effect `platform-http` server. Route layers under
  `src/routes`, framework-agnostic logic under `src/services`. Picks the Bun
  or Node HTTP backend at runtime. Serves `apps/web/dist` (or dev-proxies to
  Vite). The chat / extraction / artifact-rewrite endpoints spawn the `claude`
  CLI and stream its events.
- **apps/desktop** — Electron. Forks the bundled server on a free loopback
  port (redirecting all writable state into the OS per-user data dir) and
  points a `BrowserWindow` at it. In dev it loads the Vite server instead.

## Shared packages

- **@labee/contracts** — Effect Schema definitions (Skill, DeckFile, User,
  chat + extraction shapes) shared by web and server. Built with tsdown.
- **@labee/shared** — small framework-agnostic helpers (slugs, formatting).

## Persistence

- **Users** — SQLite (`bun:sqlite` under Bun, `node:sqlite` under Node), schema
  in `db/`. A legacy `data/users.json` is imported on first boot. Passwords are
  bcrypt-hashed; sessions are sealed cookies (iron-session).
- **Skills / protocols** — markdown directories under `SKILLS_ROOTS`
  (filesystem, not the DB).
- **Deck** — per-user files under `DECK_ROOT`.

## Auth

`middleware`-style gating is enforced in the route handlers via the session
cookie. The first registered user is auto-promoted to admin; admin-only routes
re-check the on-disk record.

## Build / packaging

`turbo run build` builds contracts → web + server → desktop. The server bundles
all its npm deps into a single self-contained `dist/bin.mjs` (SQLite drivers
stay external as runtime builtins), so the desktop artifact ships just that file
plus the web client — no `node_modules` staging.
