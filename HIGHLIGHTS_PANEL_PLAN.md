# Plan: Highlights panel enhancements

Goal: six UX improvements to the Highlights (tags) panel of the project view,
plus a tag header in the right panel. All changes are **frontend-only**
(`taguette.js`, `project.html`, `custom.css`) — no server, API, DB, or
export changes. The existing tag update endpoint
(`POST /api/project/<id>/tag/<tag_id>`) already accepts partial updates
(`{path}` and/or `{description}`) and broadcasts a `tag_add` event that
refreshes every open client, so all edits reuse it.

## Feature map

| # | Requirement | Where |
|---|---|---|
| 1 | Left panel scrolls when contents overflow window | `custom.css` + `project.html` |
| 2 | Tag names wrap only at whitespace | `custom.css` |
| 3 | Collapsible description under each tag in the list | `taguette.js` (`updateTagsList`), CSS |
| 4 | Search bar over tags list; searches name+description; optional semantic search (embeddings, cached) | `project.html`, `taguette.js`, CSS |
| 5 | ✎ pencil icons beside tag names and definitions | `taguette.js`, CSS |
| 6 | Right panel shows tag title + definition above highlights, both editable | `taguette.js` (`loadTag`), CSS |

## Design decisions

1. **Left-panel scrolling (CSS only).** The left column's `div.sticky-top`
   gets `max-height: calc(100vh - 1rem); overflow-y: auto;`. Inside the new
   scroll container, the tab bar (`nav-tabs`) is made sticky (`top: 0`) and
   the search input sticky just below it, so tabs+search stay visible while
   the list scrolls. Works for all three tabs.

2. **Wrapping.** `.tag-name` currently uses `word-break: break-all`
   (breaks mid-word constantly). Change to
   `overflow-wrap: break-word` — wraps at whitespace whenever there is
   whitespace; only a single word longer than the whole column would break
   (better than forcing horizontal scroll).

3. **Collapsible descriptions.** Each tag row gains a small ▸/▾ toggle
   (no new dependency: plain class toggle). Expanded state is kept in a
   module-level `tag_desc_open` map (tag id → bool) so it survives the
   frequent `updateTagsList()` re-renders. Empty descriptions render as
   muted "(no description)" so the ✎ affordance is always reachable.
   The count badge becomes a link that loads the tag (same as the name —
   requirement 6 mentions clicking the count).

4. **Search.** Input box above `#tags-list`, debounced 300 ms.
   - *Lexical*: case-insensitive substring match over `path` and
     `description`; applies instantly.
   - *Semantic*: if an embedding endpoint is configured
     (`sugLoadConfig()` from `suggest.js`, saved via the existing
     "Embeddings" config modal), embed `[query, tag1.text, ...]` with
     `sugEmbed()` (which batches requests at 32 texts and persists vectors
     in IndexedDB keyed by `endpoint|model|hash(text)` — so **tag
     embeddings are computed once and cached across sessions**; only the
     short query is embedded per search) and rank tags by
     `sugCosine(query, tag)`. Matches must clear an **adaptive cutoff** —
     the stricter of a hard floor (0.55) and median score + 0.15 — so only
     clear standouts are returned whatever the model's score scale (a
     fixed 0.30 threshold had matched 60 of 64 tags for "funding").
     Matches merge with lexical ones.
   - A sequence counter guards against out-of-order async results; failures
     degrade silently to lexical search. A small status line shows
     "N tags match · semantic on/off".
   - Guarded with `typeof sugEmbed === 'function'` in case `suggest.js`
     didn't load. `taguette.js` runs before `suggest.js`, but search only
     fires on user input, long after both scripts have executed.

5. **✎ pencils.** Replace the wide "Edit" button in each tag row with a
   compact ✎ (`&#9998;`) button beside the tag name (same `editTag()`
   modal), and a second ✎ inside the collapsible description box.
   Plain Unicode, consistent with the existing `&#9881;` gear in
   `project.html`. The definition toggle (▸/▾) sits **before** the tag
   name, grayed out when the tag has no definition.

6. **Right-panel tag header.** `loadTag()` now inserts a header block at
   the top of `#document-contents`:
   - `''` (all highlights): no header.
   - Exact tag match in the local `tags` map: `<h2>` title + description
     paragraph, each with a ✎; clicking ✎ (or the text) swaps in an
     input/textarea with Save/Cancel (Esc cancels).
   - Prefix-only match (possible via URL): title shown, not editable.
   - Saving the title POSTs `{path}` and then `history.replaceState` +
     `loadTag(new_path)` (rename changes the `startswith` result set).
   - Saving the description POSTs `{description}`, updates local state and
     re-renders the header in place (no reload needed).
   - The title row and the definition row are edited **independently**:
     opening one editor leaves the other visible (and even editable) —
     only the row being edited is swapped.
   - Server-side validation/permissions are reused as-is; client alerts on
     error like the existing forms.

## Implementation phases (independent, smallest-first)

- **Phase 1** (CSS, no JS): features 1+2 — scroll + wrapping.
- **Phase 2** (JS render): features 3+5 — collapsible box, pencils,
  badge-as-link, per-tag DOM restructure in `updateTagsList()`.
- **Phase 3** (JS async): feature 4 — search input, debounce, lexical
  filter, semantic merge with cache; immediate-run (🔍 / Enter) and
  clear (✕) buttons.
- **Phase 4** (JS view): feature 6 — header in right panel, per-row inline
  editing, rename flow.
- **Phase 5**: `node --check` both JS files, run the Python test suite,
  update `CHANGELOG.md`, stage + propose commit/PR.
- **Phase 6** (review feedback): toggle moved before the name (gray when
  no definition); independent title/description editors; 🔍/✕ search
  buttons; stricter semantic matching — adaptive cutoff (hard floor 0.55
  or median + 0.15, whichever cuts higher); wider, content-fitting
  tag name input in the "Change tag" modal.

## Files touched

| File | Change |
|---|---|
| `HIGHLIGHTS_PANEL_PLAN.md` | this plan |
| `taguette/static/css/custom.css` | scroll, wrapping, toggle/pencil/search/header styles |
| `taguette/templates/project.html` | `left-panel-scroll` class, search input + status line |
| `taguette/static/js/taguette.js` | `updateTagsList()` restructure, search module, `loadTag()` header, inline editors |
| `CHANGELOG.md` | user-visible entries |

New UI strings go through `gettext()` and fall back to English until the
translation catalogs are refreshed (same policy as the previous feature).

## Status

All phases implemented and verified:

- `node --check` passes on both JS files.
- Full Python suite: **same 5 pre-existing environment failures on HEAD and
  with these changes** (missing bcrypt module, unpinned jinja2/bleach/aiohttp
  drift — CI pins different versions); all other tests pass, including the
  HTTP tests that render `project.html`.
- Live smoke test (single-user server + real project render): page serves
  with the new `left-panel-scroll`, `tag-search`, `tag-search-status`
  elements.
- Functional DOM test of the real `taguette.js` under jsdom (35 checks, all
  passing): description box toggle + state persistence across re-renders,
  pencils, toggle placement/color, empty-definition placeholder,
  right-panel header (title, description, no header on "all highlights"),
  parallel title/description editors (cancel/save of one keeps the other),
  inline rename and description edit (POST body, local state update,
  header reload), lexical search on name and on description, immediate
  run (button + Enter), clear button, semantic search merging results via
  a stubbed embedding endpoint incl. the adaptive cutoff (a 0.50 crowd
  score is excluded even though the earlier fixed 0.45 threshold would
  have kept it; a low-scale model's 0.62 related tag is still kept),
  status line, and search clearing.
