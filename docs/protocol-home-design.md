# Protocol home — design

Follow-up to [issue #3](https://github.com/mengbingrock/BigSur/issues/3) ("扩展为 Protocol 管理平台"). The first round shipped protocols as a *kind* of artifact inside the Skills page with an `All / Skills / Protocols` filter. Two MVP items were left open there and this design picks them up as one page: **a home for protocols** that shows every protocol a person can use, grouped by category, searchable by body text, with the actions a lab member reaches for daily.

## 1. Who it is for and what they do

A lab member opens Labee to find a protocol and run it with an agent, or to keep their own protocols in order. Across a week they:

1. look up a protocol they know exists ("the miniprep one from Wei");
2. skim what is available in an area before starting a new experiment;
3. add a protocol from a PDF or a paper they just read;
4. tidy, rename, categorise, and occasionally version what they own;
5. start a chat with a protocol loaded as the authoritative reference.

The page is organised around those five, in that order of frequency. Search first, browsing second, creation third, housekeeping fourth, and "use with an agent" available everywhere.

## 2. What exists today

- Protocols are `SKILL.md` files with `kind: protocol` frontmatter, stored flat under the person's folder (`<root>/<emailSlug>/<slug>/`) or in the shared read-only `_public/` folder. Plugin skills also show up, but are never protocols.
- `/api/skills` returns every artifact with `name`, `description`, `body`, `allowedTools`, `sourceLabel` (yours / public / plugin), `origin`, `artifactKind`.
- The Skills page (`/skills`) lists cards, filters by kind and source, and fuzzy-searches name and description with Fuse. It has creation, file import (`.md .txt .pdf .docx .doc .odt .rtf`), and inline editing.
- Chat can attach protocols; the session header shows "N skills + M protocols loaded".

Missing, and needed by the home: **categories**, **last-updated times**, **body search**, **counts per group**, and a layout that treats protocols as the primary object rather than a filter on skills.

## 3. Page placement

Route: `/protocols`. Nav: it becomes the entry under **Skills** in the sidebar, or replaces it if you want a single "Library" concept later. The signed-in home currently opens the latest chat (PR #42); this page is one click away and is also what the "Browse skills" landing button should point to. Making it the signed-in home instead is a product call, not a technical one, and is listed under open questions.

## 4. Layout

Desktop, at a glance:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Protocols                                       [ + New protocol ▾ ]         │
│ 42 protocols · 6 categories · 3 shared                                       │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ 🔍  Search protocols, steps, reagents…                      ⌘K           │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│ [ All 42 ] [ Mine 31 ] [ Shared 3 ] [ Imported 8 ]   sort: Recently updated ▾│
├───────────────┬──────────────────────────────────────────────────────────────┤
│ CATEGORIES    │  Recently updated                                            │
│ All        42 │  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐       │
│ PCR         9 │  │ Miniprep v3    │ │ Gibson assy.  │ │ HEK293 passage│       │
│ Cloning    11 │  │ Cloning · 2d   │ │ Cloning · 5d  │ │ Cell Cult. 1w │       │
│ Cell Cult.  7 │  │ Wei · mine     │ │ mine          │ │ shared        │       │
│ Imaging     5 │  │ [Open][Chat ▸] │ │ [Open][Chat ▸]│ │ [Open][Chat ▸]│       │
│ Sequencing  6 │  └───────────────┘ └───────────────┘ └───────────────┘       │
│ Uncategor.  4 │                                                              │
│               │  PCR (9)                                          [see all]  │
│ + New category│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐       │
│               │  │ …             │ │ …             │ │ …             │       │
│ SHARED        │  └───────────────┘ └───────────────┘ └───────────────┘       │
│ _public     3 │                                                              │
│               │  Cloning (11)                                     [see all]  │
│               │  …                                                           │
└───────────────┴──────────────────────────────────────────────────────────────┘
```

Three regions:

- **Header** — title, live counts, one primary action. The "New protocol" button is a menu: *Write from scratch*, *Import from file*, *Save from chat workspace*. These are the three creation paths that already exist; the menu just makes them findable from one place.
- **Search and filters** — a single search box that covers names, descriptions, *and body text*, with `⌘K` focusing it from anywhere on the page. Chips filter by ownership (Mine / Shared / Imported) because that is the second thing people narrow by after category. Sort defaults to recently updated.
- **Category rail + sections** — the rail is the folder list with counts; the main area shows one section per category in rail order, each capped at one row with "see all" expanding it in place. When a rail category is selected the main area shows only that category, uncapped. "Uncategorised" is always last so untidy protocols stay visible instead of being hidden.

Search replaces the sections with a flat result list ranked by match, each result showing a snippet of the matching body text with the term highlighted, and the category as a chip. Clearing the box restores the sections.

Mobile and iPad: the rail collapses into a horizontally scrolling chip row under the search box; cards go to one column; the New button stays in the header.

## 5. The protocol card

```
┌────────────────────────────────────────┐
│ Plasmid miniprep (alkaline lysis) v3   │  ← name; version suffix if the doc has one
│ Cloning · updated 2 days ago           │  ← category · relative time
│ Silica column, 5 ml overnight culture, │  ← first 2 lines of description
│ elute in 30 µl…                        │
│ 🧪 Wei (shared)   📎 3 files           │  ← owner/source, attached files
│ [ Open ]  [ Use in chat ▸ ]      ⋯     │  ← ⋯: rename · move to category · duplicate · delete
└────────────────────────────────────────┘
```

"Use in chat" starts a new session with the protocol attached, the same path the chat's skill picker takes. Shared protocols are read-only; the ⋯ menu offers *Copy to mine* instead of edit actions.

## 6. Category model

Keep it on disk and readable without the app, in line with how everything else in the artifact store works.

- A category is a **subfolder** of the person's folder: `<root>/<emailSlug>/<category>/<slug>/SKILL.md`. Existing flat protocols stay valid and appear under *Uncategorised*.
- The category name is the folder name, shown with the first letter capitalised. A `category` frontmatter field, when present, overrides the folder name for display only; it does not move files.
- `_public` gets the same treatment: `_public/<category>/<slug>/`.
- Moving a protocol between categories is a directory move; renaming a category renames the folder. Both stay inside the person's own folder, reusing the existing "refuse to write outside your own folder" guard.
- No nesting beyond one level. Issue #3's examples (PCR / Cloning / Cell Culture) are one level, and two levels would make the rail unusable.

## 7. Data and API changes

`Skill` gains three optional fields so the web app does not have to infer them:

| Field | Source |
|---|---|
| `category` | parent folder name, or `category` frontmatter |
| `updatedAt` | `mtime` of `SKILL.md` |
| `fileCount` | number of sibling files (already listed by the files endpoint) |

Endpoints:

- `GET /api/skills` — include the fields above. No new endpoint for the list.
- `GET /api/skills/search?q=` — server-side body search over the caller's visible protocols. Plain substring match, case-insensitive, returning `slug`, `score`, and one `snippet` of ±80 characters around the first hit. Fuse stays for name/description on the client; body search is server-side because bodies can be long and the client should not download all of them just to search.
- `POST /api/skills/categories` — create folder. `PATCH /api/skills/categories/:name` — rename. `DELETE` refuses unless empty.
- `POST /api/skills/:slug/move` — `{ category }`. Moves the directory; returns the updated `Skill`.

Nothing changes for chat attachment, import, or editing.

## 8. States

- **Empty (no protocols at all)** — a short panel with the three creation paths and a one-line explanation of what a protocol is versus a skill. No illustration.
- **Empty category** — "Nothing in Imaging yet" plus *New protocol here*, which pre-selects the category in the create form.
- **No search results** — "No protocol mentions 'phenol'", with a link to clear the search and a *Create one* button that seeds the name from the query.
- **Loading** — skeleton cards in the recently-updated row; the rail renders immediately from the cached list if there is one.
- **Errors** — same toast pattern as the rest of the app.

## 9. Phasing

1. **Home page on existing data** — the page, rail, sections, cards, chips, sort, and client-side search, with every protocol under *Uncategorised*. Ships the new layout without touching the server. Reuses the current card actions and create flow.
2. **Categories** — subfolder model, the three category endpoints, move, and the rail becomes real. Migration is nothing: flat files stay flat.
3. **Body search** — the search endpoint and the snippet result list.
4. **Later, out of scope here** — versions / snapshots (`history/`), which issue #3 lists and issue #7 owns.

Each phase is independently useful and mergeable.

## 10. Open questions

- **Is this the signed-in home?** Today home opens the latest chat. For a lab that lives in protocols, this page is the better front door and the latest chat becomes a card at the top of it. For a solo developer the chat is. Suggest a per-user "start on" preference in Settings with chat as the default, rather than deciding for everyone.
- **Skills on the same page?** The rail could carry a second group, *Skills*, so this becomes the single library. Cleaner nav, but it reintroduces the "is this a skill or a protocol" confusion that the kind filter already causes. Recommendation: keep `/skills` as is for now and revisit once categories exist.
- **Shared categories** — should a person be able to publish a whole category to `_public`, or only single protocols? Single protocols only in phase 2; a folder publish is easy to add later if asked for.
