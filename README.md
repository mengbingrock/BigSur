# Agent Monterey — Research Skills Catalog

A minimalist, Orchestra-inspired catalog of Claude Code skills installed on your machine.

Reads `SKILL.md` files from:
- `~/WorkSync/Git/protocol-agent/.claude/skills/` (protocol-agent project skills)

...and presents them as a browsable catalog with search, source filtering, and full SKILL.md rendering.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Configure source paths

By default, the app reads from `~/WorkSync/Git/protocol-agent/.claude/skills`. Override with a colon-separated env var at build/dev time:

```bash
SKILLS_ROOTS="/path/to/skills:/other/path" npm run dev
```

## Stack

Next.js 14 (App Router) + TypeScript + Tailwind + gray-matter + react-markdown + Fuse.js.
