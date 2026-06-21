# Labee — landing page

A self-contained static landing page for **Labee** (the desktop research
workspace). Everything is inline in `index.html` (no build step, no external
assets), so it works at any base path.

## Publish on GitHub Pages

1. Push this `docs/` folder to the default branch.
2. On GitHub: **Settings → Pages**.
3. **Source:** "Deploy from a branch" → Branch: `main`, Folder: `/docs` → **Save**.
4. The site goes live at `https://mengbingrock.github.io/BigSur/`.

(`.nojekyll` disables Jekyll processing — not strictly needed here, but avoids
surprises if asset folders are added later.)

## Local preview

```bash
# from the repo root
python3 -m http.server -d docs 8080   # then open http://localhost:8080
```

## Editing

It's one file — `index.html` — with the design tokens (paper/ink editorial
palette) defined as CSS variables at the top. Update copy or swap the inline
SVG logo there.
