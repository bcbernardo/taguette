# Plan: Tag multiselect with bulk Merge / Move to / Group

Goal: let researchers select **multiple tags** in the Highlights panel's tag
tree and reorganize them in bulk through three operations:

* **Merge** — merge all selected tags into an existing tag, *or* into a
  brand-new tag ("Create new unified tag" flow);
* **Move to** — re-parent all selected tags under one chosen parent (or root);
* **Group** — create a new "umbrella" tag and make all selected tags its
  children.

The **Group** and **Create new unified tag** flows share one new modal, the
**tag compose modal**, a variant of the "Create a tag" modal whose
similar-tags area is replaced by two interactive lists ("Tags to be grouped
under the new tag" / "Other suggested tags") plus AI title/description
suggestions grounded in the member tags.

Design doc: this file. Owner decisions are final unless a bug forces a
change; deviations must be recorded in the PR description.

---

## 0. Baseline facts (verified)

* Frontend: `taguette/static/js/taguette.js` (tree rendering, modals, API
  calls), `tags-ai.js` (LLM helpers: name suggestions, description
  generation, similar-tag ranking), `suggest.js` (embeddings), `config.js`
  (settings UI), `taguette/templates/project.html` (markup),
  `taguette/static/css/custom.css`. jQuery + Bootstrap 4 modals. **ES5
  style** throughout (`var`, function declarations, string concatenation —
  no arrows, no template literals, no `let`/`const`).
* Tag state lives in the `tags` object (`tags[id] = {id, path, description,
  parent_id, count}`). Tree helpers: `tagChildrenOf(id)`, `tagRoots()`,
  `tagAncestorsOf(tag)`, `tagIsDescendant(tag_id, maybe_ancestor_id)`.
* The tag tree is rendered by `updateTagsList()` → `renderTagItem(tag)` into
  `#tags-list`; selection state must therefore live **outside the DOM** and
  be restored on each re-render (same pattern as `tag_desc_open` and
  `highlight_add_tag_state`).
* Server: `POST /api/project/<id>/tag/merge` takes `{src, dest}` (ints) and
  emits one `tag_merge` command per call
  (`{'type':'tag_merge','id':N,'src_tag_id':S,'dest_tag_id':D,
  'tag_count_changes':{...}}`); the long-poll handler in `taguette.js`
  applies each event independently (re-parents the source's children to the
  destination, then `mergeTags(src, dest)`). Multi-merge therefore only
  needs **one POST that emits N events** — no frontend event-handling
  changes.
* `POST /api/project/<id>/tag/<tag_id>` accepts partial updates, including
  `{parent_id: int|null}` → emits `tag_move`. Moves are undoable
  (`pushTagUndo`); merges are not.
* `POST /api/project/<id>/tag/new` accepts `{path, description, parent_id}`
  → emits `tag_add`.
* Response of `/tag/merge` is exactly `{'id': dest_id}` and existing tests
  assert equality on it — **keep the response shape unchanged**.
* Privileges: merges need `privileges.can_merge_tags()`; there is no bulk
  privilege — reuse per-operation checks.
* AI plumbing: `tagAiLLMConfig()` (resolved LLM task config or `null`),
  `tagAiChat(resolved, prompt, max_tokens)`, `tagAiPrompt(cfg, key, vars)`
  (fills `{{placeholders}}`, falls back to `TAG_AI_PROMPTS[key]`),
  `tagAiParseNames(content)` (tolerant parser), prompt templates are
  user-overridable in the config tab (one textarea per key of
  `TAG_AI_PROMPTS`, labels in `TAG_AI_PROMPT_LABELS`, placeholder hint in
  `tagAiConfigExtra`).
* Similarity ranking: `tagAiSimilarTagsPromise(limit, editing_id, text)`
  ranks candidates by embedding cosine (falls back to lexical) against
  `text`; candidates come from `tagAiSimilarCandidates(entries, editing_id)`.
  Debounced refresh pattern: `tagAiSimilarRefresh` (600 ms) + sequence guard
  (`tag_ai_tag.similar_seq`).
* Highlights fetch: `tagAiFetchHighlights(tag)` → Promise of plain-text
  excerpts (paginated, capped at 20 pages). Excerpt sampling:
  `tagAiSampleExcerpts(texts, max_count, max_len)`.
* Frontend self-tests: append `?tags_ai_selftest=1` to the project URL;
  `tagAiSelfTest()` runs console asserts on pure functions (pattern to
  extend).
* Tests: `tests.py` (tornado `AsyncHTTPTestCase` + aiohttp client; polling
  helper `self.poll_event(project_id, from_id)` asserts exact event dicts).
  Working runner in this workspace:
  `.venv-py38/bin/python -m pytest tests.py -q` (Python 3.8 venv with the
  pinned old aiohttp; the py3.12 `.venv` breaks on aiohttp>=3.9).
  **Baseline: 17 passed, 1 pre-existing failure**
  (`TestMeasure::test_extract_highlight`, sanitizer version drift —
  unrelated; do not try to fix it in this PR).
* i18n: new user-visible strings use `{% trans %}` / `gettext()`; po files
  are NOT updated in feature PRs (runtime falls back to English) — matches
  all recent feature commits.
* JS syntax check: `node --check <file>` (no bundler, no JS test runner).

---

## 1. Multiselect in the tag tree

### State & helpers (`taguette.js`, near the tag tree code)

```js
// Tags checked in the left panel's tag tree; kept outside the DOM so
// re-renders (updateTagsList) don't lose the selection.
var tag_selected = {};   // {tag_id_string: true}

function tagSelectedIds()      // → array of numeric ids, ascending
function tagToggleSelected(id) // toggle + update row class + bulk bar
function tagClearSelection()   // empty map, re-render list, update bar
function tagUpdateBulkBar()    // show/hide #tag-bulk-bar, update count,
                               // disable Group when < 2 selected
```

* `renderTagItem(tag)` gains, before the ▸/▾ toggle, a checkbox:
  `<input type="checkbox" class="tag-select-box" id="tag-select-<id>"
   aria-label="Select tag for bulk actions" />` — inside the existing
  `.tag-drag-handle` row div. Restore `checked` from `tag_selected` on
  render; toggle the `tag-item-selected` class on the `li` accordingly.
  A `change` listener calls `tagToggleSelected(tag.id)` (the checkbox is
  re-created on every re-render, so no listener leaks).
* Selection is dropped for tags that disappear: inside `removeTag(tag_id)`
  and `mergeTags(tag_src, tag_dest)` (both already run for local *and*
  remote changes), `delete tag_selected['' + id]` + `tagUpdateBulkBar()`.
* Selecting a parent does **not** select its children (independent nodes).
  Ancestor/descendant mixes inside one selection are allowed and handled
  per-operation (rules in §3.1, §4, §5.1 are all cycle-safe).

### Bulk action bar (`project.html`, between `#tag-search-status` and `#tags-list`)

```html
<div class="d-flex align-items-center flex-wrap mb-1" id="tag-bulk-bar" style="display: none;">
  <span class="small mr-2" id="tag-bulk-count"></span>
  <div class="btn-group btn-group-sm" role="group" aria-label="{% trans %}Bulk tag actions{% endtrans %}">
    <button type="button" class="btn btn-outline-secondary" id="tag-bulk-merge">{% trans %}Merge{% endtrans %}</button>
    <button type="button" class="btn btn-outline-secondary" id="tag-bulk-move">{% trans %}Move to{% endtrans %}</button>
    <button type="button" class="btn btn-outline-secondary" id="tag-bulk-group">{% trans %}Group{% endtrans %}</button>
  </div>
  <button type="button" class="btn btn-sm btn-link ml-1" id="tag-bulk-clear" title="{% trans %}Clear the selection{% endtrans %}"><i class="fas fa-times"></i></button>
</div>
```

* `#tag-bulk-count` text: `gettext("N selected", …)` style singular/plural:
  "1 tag selected" / "2 tags selected" (use two gettext messages).
* Group is disabled (title hint) when fewer than 2 tags are selected.
* Buttons: Merge → `showMergeModal(tagSelectedIds())`;
  Move to → `showBulkMoveModal(tagSelectedIds())`;
  Group → `showComposeModal('umbrella', tagSelectedIds())`.
* The bar is hidden whenever the selection is empty (including after a
  successful bulk operation — see the "clear on success" rule below).

**Clear-on-success rule:** every bulk operation (merge, move, group,
unified create) clears the selection when its request chain completes
successfully; on failure the selection is kept so the user can retry.

---

## 2. Shared candidate rule

All pickers need "which tags are valid targets given the member set M?".
One helper in `taguette.js`:

```js
// Set of ids excluded as targets: the members themselves plus all their
// descendants (prevents cycles for merge destinations, new parents, and
// the compose modal's parent picker).
function tagBulkExcludedIds(member_ids)  // → {id_string: true}
// Candidates: all tags not excluded, sorted by path
function tagBulkCandidates(member_ids)   // → [tag, ...]
```

Rationale (cycle analysis, verified against the API):
* merge dest D ∉ M and D not a descendant of any member (API rejects
  `_is_descendant(dest, src)`);
* new parent P ∉ M and not a descendant of any member (API rejects
  `parent_id` inside the moved tag's own subtree; for the compose modal a
  member's descendant becoming the new tag's parent would cycle once the
  members move under it).

---

## 3. Merge: multi-source + "Create new unified tag"

### 3.1 Server (`taguette/web/api.py`, `TagMerge.post`)

* Accept **either** legacy `{src: int, dest: int}` (unchanged behavior) or
  the new `{srcs: [int, ...], dest: int}`. Normalize to a `src_ids` list
  (dedupe, keep order). `srcs: []` or a non-int entry → `400`.
* Validate **all** sources up front (atomicity — no partial merge when a
  later source is invalid): each must exist in the project, differ from
  `dest`, and `dest` must not be its descendant (existing per-source
  checks).
* Process sources **deepest-first** (compute each source's depth on the
  *original* tree before any mutation): when an ancestor is merged, its
  subtree's highlights are inherited and its children re-parented to the
  destination; merging its (already-processed, deleted) descendants first
  keeps every step identical to the existing single-merge code path.
* The per-source body is exactly today's logic (factor it into a loop or a
  `_merge_one(db, tag_src, tag_dest)` helper returning its count changes):
  `_update_inheritance_on_move`, delete the source's `HighlightTag` links,
  re-parent its children to `dest`, `db.delete(tag_src)`, build
  `Command.tag_merge(...)` with its own `tag_count_changes`.
* One `db.commit()` for the whole batch; `notify_project` once per command
  (each wakes a poller; the events endpoint replays any missed commands
  from the DB by `id > from`, so multi-notify is safe).
* Response stays `{'id': tag_dest.id}`.

### 3.2 Merge modal (`#tag-merge-modal`, `taguette.js`)

* `showMergeModal(tag_ids, preselect_dest)` — accepts a single id (number)
  **or** an array (normalize to `merge_src_ids`, an array of id strings).
  The `#tag-add-merge` button passes `[tag_id]`; drag & drop keeps working
  (`showMergeModal(tag_id, drop_target)` → single-element array).
* Source display: `#tag-merge-src-name` gets `paths.join(', ')`; when more
  than one source, the "Merge tag" label switches to "Merge tags" (give the
  label an id, e.g. `#tag-merge-src-label`, and swap its text).
* Destination candidates: `tagBulkCandidates(merge_src_ids)` (replaces the
  current per-source filter — same rule, generalized).
* Submit handler: `tag_dest` value is a numeric id **or** `'new'`:

  ```js
  if(dest === 'new') { hide merge modal; showComposeModal('unified', merge_src_ids); return; }
  POST /tag/merge {srcs: merge_src_ids, dest: dest}   // single source too — one shape
  ```
  On success: hide modal + `tagClearSelection()`.

### 3.3 Pinned "Create new unified tag" option

In `showMergeList(filter)`:
* The first item is always a distinct button
  `<button type="button" class="list-group-item list-group-item-action py-1 tag-merge-new-item" data-id="new">✨ Create new unified tag</button>`
  — **always rendered regardless of the filter string** (it is an action,
  not a tag; sticking through string filtering is explicitly wanted).
* A visual divider (`div.tag-merge-divider`) separates it from the tag
  candidates; the candidates then follow, filtered as today.
* `chooseMergeDest('new')` sets `#tag-merge-dest` to `'new'` and the filter
  input to the option label; the blur-restore keeps that label
  (special-case: `tags['new']` doesn't exist).
* Keyboard: the pinned item participates in ArrowDown/Up highlighting
  (index 0). **Enter with no highlighted item picks the first tag
  candidate, not the pinned item** (preserves today's "Enter = first
  match" behavior; the pinned item stays reachable by click or by arrowing
  to it).

---

## 4. Move-to modal (`#tag-bulk-move-modal`, new)

A small modal modeled on `#tag-merge-modal` (medium width, centered):

* Title: "Move tags". Body:
  * `#tag-bulk-move-message`: "Move the N selected tags (a, b, c…) under
    which tag?" — truncate the list to ~5 names + "…".
  * A combobox (filter input `#tag-bulk-move-filter` + dropdown list
    `#tag-bulk-move-list` + hidden `#tag-bulk-move-dest`), cloned behavior
    from the merge modal (focus/click/input/blur/ArrowUp/Down/Enter/Escape;
    mousedown picks; case-insensitive substring filter).
  * **Pinned first option** `(root level)` with `data-id="root"` — always
    visible (move to root level), same pinning rule as §3.3.
  * Candidates: `tagBulkCandidates(selected_ids)`.
  * Hint text: reuse "The parent tag inherits all the highlights of its
    child tags." (`{% trans %}`, same string as the existing move modal).
* Footer: submit "Move tags" + Cancel.
* Submit (`dest` = numeric id or `'root'` → `parent_id = null`): PATCH each
  selected tag **sequentially** (`Promise` chain); per success
  `pushTagUndo({tag_id, parent_id: old_parent_id})`; on error stop and
  alert `gettext("Couldn't move the tags!")` + error + how many moved
  (e.g. "(2 of 5 moved)"). Full success → hide modal, `tagClearSelection()`.
* The existing single-tag `#tag-move-modal` (drag & drop confirm) is
  **unchanged**.

---

## 5. Tag compose modal: umbrella & unified (`#tag-compose-modal`, new)

One modal, two modes, opened as
`showComposeModal(mode, member_ids)`:

| | `mode == 'umbrella'` | `mode == 'unified'` |
|---|---|---|
| Title | "Create new umbrella tag" | "Create new unified tag" |
| Members label | "Tags to be grouped under the new tag:" | "Tags to be unified into the new tag:" |
| Submit label | "Create tag" | "Create and merge" |
| Effect | create U, then `PATCH {parent_id: U}` per member | create U, then `POST /tag/merge {srcs: members, dest: U}` |
| AI excerpt context | none (tags + descriptions only) | + sample highlights from all members |

### 5.1 Markup (`project.html`, after `#tag-merge-modal`)

Variant of `#tag-add-modal` (same classes; centered dialog):

* Header: `<h5 class="modal-title" id="tag-compose-title">` filled per mode.
* Body:
  * name input `#tag-compose-path` (`tag-path-input` class, same `size`
    fit behavior as `tagAddPathFit` — reuse/genericize the function);
  * `#tag-compose-name-suggestions` (hidden until AI fills it);
  * description textarea `#tag-compose-description`;
  * `#tag-compose-desc-generate` button ("Generate description with AI",
    magic icon) — no augment dropdown in v1;
  * `#tag-compose-desc-preview` (`tag-ai-preview-box`, hidden);
  * **members section** `#tag-compose-members`:
    * `#tag-compose-members-label` (per-mode text above),
    * `#tag-compose-members-list` — the selected tags,
    * a second label "Other suggested tags:" (`#tag-compose-suggested-label`),
    * `#tag-compose-suggested-list` — ranked, clickable suggestions;
  * parent picker identical in structure to `#tag-add-parent`:
    `#tag-compose-parent` input + `#tag-compose-parent-clear` +
    `#tag-compose-parent-list` + hidden `#tag-compose-parent-id`.
* Footer: `#tag-compose-submit` (per-mode label) + Cancel. No Delete/Merge
  buttons.

### 5.2 Member lists (`taguette.js`)

State (module-level, DOM-independent):

```js
var compose_mode = null;        // 'umbrella' | 'unified'
var compose_members = [];       // [id, ...] in selection order
var compose_dropped = [];       // ids removed via ×, most recent first (cap 10)
```

`composeRenderLists()` rebuilds both lists:

* **Members**: each a chip
  `<span class="badge badge-primary tag-compose-member">path<a href="javascript:void(0)" class="tag-compose-remove" title="Remove from the list">×</a></span>`
  — the badge styling is the "has been selected" highlight; the × is the
  cross mark. Clicking ×: remove from `compose_members`, unshift into
  `compose_dropped`, re-render, notify the AI hook (§6).
* **Other suggested tags**: chips styled like the existing similar-tag
  chips (`badge badge-light tag-ai-similar-chip` — no highlight, no
  cross), clickable to **promote** into `compose_members` (and remove from
  `compose_dropped` if present). Order: `compose_dropped` first (they were
  explicitly deselected, so they must reappear immediately — this is the
  "de-selecting moves it to the other list" rule), then the ranked
  suggestions from the AI hook (§6.3), deduped, capped at ~8 total. Each
  chip title: "Add to the tags to be <grouped/unified>".
  When empty: muted "(none)".
* Empty members (everything deselected): disable `#tag-compose-submit`
  and show a muted hint under the members label.

Parent picker candidates: `tagBulkCandidates(compose_members)` (members
and their subtrees excluded — see §2); default root (empty). Reuse the
tag-add parent combobox behavior (filter list, Enter picks first, clear
button). Genericize the existing `tagAddParent*` code or clone it — the
implementer may choose, but do not regress `#tag-add-parent`.

### 5.3 Save (`#tag-compose-form` submit)

Guards: name required (`alert gettext("Invalid tag name")`), ≥1 member.
`showSpinner()` for the whole chain:

1. `POST /tag/new {path, description, parent_id}` → `id` U
   (conflict/error → alert, keep modal open; nothing applied yet);
2. umbrella: sequential `PATCH /tag/<m> {parent_id: U}` per member, each
   pushing `pushTagUndo({tag_id: m, parent_id: old})`;
   unified: single `POST /tag/merge {srcs: members, dest: U}`;
3. success → hide modal, `tagClearSelection()`;
   failure mid-chain → alert with progress ("Created the tag, but couldn't
   <group/merge> all tags: (error)") and keep the modal open.

`showComposeModal` resets the form, sets labels per mode, seeds
`compose_members`/`compose_dropped`, defaults the parent to root, renders
the lists, calls the AI hook `tagAiComposeOpen(mode, member_ids)` if
defined (guard with `typeof` — same pattern as `tagAiModalView`), then
opens the modal. Modal wiring in `taguette.js`; the AI side lives in
`tags-ai.js` (§6).

---

## 6. AI helpers for the compose modal (`tags-ai.js`)

### 6.1 New prompt templates (keys of `TAG_AI_PROMPTS`, labels in
`TAG_AI_PROMPT_LABELS`, hint text in `tagAiConfigExtra` extended)

* `group_names` — like `names`, but grounded in the member tags:

  ```
  You are helping a qualitative researcher organize the tags (codes) of a Taguette project.

  Suggest 3 names for a new tag: {{task}}

  A tag name is a short key phrase (1-4 words, lowercase).

  Tags involved:
  {{tags}}

  Sample excerpts highlighted with these tags (may be empty):
  """
  {{highlights}}
  """

  Answer with EXACTLY 3 names, one per line: just the names, no numbering, no explanations, no markdown, no preamble.
  ```

  `{{task}}`: umbrella → "an umbrella tag — a broader category under which
  all these tags will be grouped as children."; unified → "a unified tag
  that will replace all these tags — they will be merged into it, so the
  name must cover all of them together."
  `{{tags}}`: `- path — description` per member (description or
  "(no definition)").
  `{{highlights}}`: unified → sample excerpts (§6.4); umbrella →
  gettext("(none)").

* `group_description` — like `description`, but with members as context:

  ```
  You are helping a qualitative researcher write definitions for the tags (codes) of a Taguette project.

  Write a concise definition (2-4 sentences, plain text) for the new {{kind}} tag "{{tag}}": what it covers and when to apply it, grounded in the tags below and the excerpts.

  Current definition (may be empty or partial): {{description}}

  Tags it brings together:
  {{tags}}

  Sample excerpts highlighted with these tags (may be empty):
  """
  {{highlights}}
  """
  ```

  `{{kind}}` = "umbrella"/"unified".

### 6.2 Title suggestions — `tagAiComposeOpen(mode, member_ids)`

Called by `showComposeModal` (guarded). Mirrors `tagAiSuggestNames`:

* Own sequence counter (`tag_compose.seq`), own debounce timer; on modal
  hidden (`hidden.bs.modal` on `#tag-compose-modal`, wired in tags-ai.js)
  bump the counter and clear timers (drop in-flight answers).
* If no LLM configured → hide the suggestions box silently.
* Box `#tag-compose-name-suggestions`: "Suggestions: thinking…" → chips
  (same `tag-ai-chip` pattern, one per line) → click fills
  `#tag-compose-path` (and fits its size) and collapses the box into a
  "Re-generate title with AI" link. "Suggestions: none — try again"
  fallback. Reuse `tagAiParseNames`.
* **Auto-runs on open** (the title is the primary need; the description
  stays button-triggered, matching the existing create-tag UX).

### 6.3 Other-suggested ranking — `tagAiComposeRefreshSuggestions()`

* Generalize `tagAiSimilarCandidates(entries, editing_id, exclude_ids)` and
  `tagAiSimilarTagsPromise(limit, editing_id, text, exclude_ids)` with an
  **optional** `exclude_ids` set (`{id_string: true}`); existing call
  sites unchanged. Compose passes `compose_members`.
* Context text = `#tag-compose-path` value + '\n' + description value
  (same recipe as `tagAiCurrentTagText`); limit 5; 600 ms debounce +
  sequence guard; results stored for `composeRenderLists()` via a getter
  the core code calls (`tagAiComposeSuggestions()` returning the ranked
  array, `[]` by default). Core re-renders the lists whenever members
  change; tags-ai re-calls `composeRenderLists()` itself when a debounced
  ranking lands (guard with `typeof composeRenderLists === 'function'`).

### 6.4 Description generation — `tagAiComposeDescRun(mode)`

Mirrors `tagAiDescRun` for the compose surface:

* Guard: LLM configured (preview-box error note, same wording); name
  required (`alert gettext('Enter a tag name first')`).
* Vars per §6.1; unified highlights: for each member `tagAiFetchHighlights`
  (parallel, `Promise.all`), take up to 2 excerpts per member, then
  `tagAiSampleExcerpts(all, 8, ~400)`; umbrella → "(none)".
* Preview box `#tag-compose-desc-preview` with Accept/Regenerate-style
  buttons as in the form surface; Accept writes the textarea (mode
  `generate`: replace).
* Button wired in tags-ai.js (same place the form's generate button is
  wired).

### 6.5 Self-tests (extend `tagAiSelfTest`)

* `tagAiSimilarCandidates` respects `exclude_ids`;
* `tagAiPrompt({}, 'group_names', {...})` fills `{{task}}`/`{{tags}}`/
  `{{highlights}}` and keeps unknown placeholders;
* (existing tests must keep passing).

---

## 7. CSS (`custom.css`, near the tag-tree and tag-ai rules)

```css
li.tag-item.tag-item-selected { background-color: #e7f3fb; }  /* light blue */
.tag-select-box { margin-right: .25rem; }
#tag-bulk-bar { /* keep default flex spacing */ }
.tag-compose-member { font-size: .85em; }
.tag-compose-member .tag-compose-remove { color: #fff; margin-left: .35em; }
.tag-merge-new-item { font-weight: 600; }
.tag-merge-divider { border-top: 1px solid rgba(0,0,0,.125); padding: 0; }
.tag-compose-members-label, .tag-compose-suggested-label { font-weight: 600; }
```

(Final values may be tuned for Bootstrap 4 look-and-feel; the *selected*
chip must clearly read as selected vs. the light suggestion chips.)

---

## 8. Edge cases & invariants

1. Selection survives `updateTagsList()` re-renders and tag searches.
2. Remote `tag_delete` / `tag_merge` of a selected tag drops it from the
   selection (handled in `removeTag`/`mergeTags`).
3. Ancestor+descendant in one selection:
   * merge into third tag: sources processed deepest-first server-side;
   * group: both simply become children of U (descendant detaches from the
     ancestor) — valid, no cycle;
   * move-to: same as group;
   * all pickers exclude members' subtrees as targets (§2).
4. Multi-merge emits one `tag_merge` event per source; the existing
   frontend handler applies them one by one (verified: re-parent children,
   `mergeTags`) — no event-handler changes needed.
5. `POST /tag/merge` keeps accepting `{src, dest}` (old clients) and
   returns `{'id': dest}`.
6. Merge to `'new'` from a **single** source (tag edit modal → Merge... →
   Create new unified tag) works: compose modal with one member.
7. All request chains use `showSpinner()`/`hideSpinner()` and alert on
   failure; no silent partial states except documented mid-chain failures
   (§4, §5.3).
8. Modal stacking: opening the compose modal from the merge modal hides
   the merge modal first (chain on `hidden.bs.modal` if needed so the
   backdrop doesn't fight).
9. ES5 only in JS; no new dependencies; no template/po changes.

---

## 9. Testing strategy

### Server (`tests.py`, new `test_tag_multi_merge` in `TestMultiuser`)

Reuse the `test_tag_tree` scaffolding (project, doc, nested tags, poll
asserts). Cover:

1. happy path `{srcs:[leaf, root_tag], dest: third}` — response
   `{'id': dest}`, one `tag_merge` event per source (deepest first), DB:
   sources gone, `highlight_tags` inherited by dest (+ its ancestors),
   children re-parented, counts via `tag_count_changes`;
2. ancestor+descendant co-merge `{srcs:[ancestor, descendant], dest}` —
   descendant's event precedes ancestor's; final DB state correct;
3. validation: src list containing `dest` → 400; descendant of dest → 400;
   `srcs: []` → 400; unknown tag id → 404; **no partial application** on
   400 (counts unchanged);
4. legacy `{src, dest}` still works (already covered by `test_tag_tree`,
   keep passing).

Runner: `.venv-py38/bin/python -m pytest tests.py -q`
(expected: 17+1 new passed, 1 pre-existing unrelated failure).

### Frontend

* `node --check` on every touched JS file.
* Extend `tagAiSelfTest` (§6.5); run manually with
  `?tags_ai_selftest=1` (documented in PR).
* Manual QA checklist (in the PR description; run against a scratch
  project): select/deselect, bar show/hide/disable Group at 1, merge
  multi → existing tag, merge multi → new unified tag (incl. from a
  single tag via edit modal), move multi incl. root option, group incl.
  promote/demote chips + parent picker, AI title/desc with and without an
  LLM configured, two-browser-tab event sync of a multi-merge.

### Database inquiry (informational, read-only)

Stats from the real workspace DB (`2026-11-01_AIM 2026 Charity
Interviews.sqlite3` — **always work on a copy**): tag count, depth
distribution, sibling counts — sanity-checks the UX defaults (bulk bar
wrapping, suggestion limits). Plus a scripted end-to-end API exercise
against a copy of that DB if feasible (multi-merge invariants before/
after), otherwise skip.

---

## 10. Work packages

* **A (server):** §3.1 + §9 server tests. Files: `taguette/web/api.py`,
  `tests.py`.
* **B (core frontend):** §1, §2, §3.2–3.3, §4, §5.1–5.3, §7, §8.
  Files: `taguette/static/js/taguette.js`,
  `taguette/templates/project.html`, `taguette/static/css/custom.css`.
* **C (AI frontend):** §6. Files: `taguette/static/js/tags-ai.js`
  (+ tiny `config.js` hint-text touch if needed).
* **D (DB inquiry):** §9 last section. Read-only, uses
  `SKILLS/taguette-database`.

Order: A and D in parallel, then B, then C (C depends on B's hooks).
Each package: implement → verify (`pytest` / `node --check` / selftest) →
commit on the feature branch. Integration review + CHANGELOG + draft PR
afterwards.
