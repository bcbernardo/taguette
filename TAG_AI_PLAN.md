# Plan: Tag AI helpers (LLM + NLP for tagging)

Goal: use LLMs and NLP to streamline the repetitive parts of tagging —
picking the right tag for a highlight, naming new tags, writing tag
definitions, and organizing similar tags into the hierarchy.

## 0. Architecture: client-side, like the other AI features

Everything runs in the browser (see SUGGESTED_HIGHLIGHTS_PLAN.md §0 for the
rationale): the LLM and embedding services are called directly from the
frontend with the user's own key (or a local server), the token never
reaches the Taguette server, and configuration lives in
`localStorage["taguette_config"]` through the shared configuration screen
(config.js). No new API endpoints, no DB migration, no new dependencies —
one new JS file (`static/js/tags-ai.js`), loaded after `suggest.js` so it
can reuse its embedding client (`sugEmbed`, `sugCosine`), and three small
hooks in `taguette.js`.

## 1. Files touched

| File | Change |
|---|---|
| `TAG_AI_PLAN.md` | this plan |
| `taguette/static/js/tags-ai.js` | **new** — LLM chat client, ranking, search, tag-form features, config tab, self-test |
| `taguette/static/js/taguette.js` | three hooks: modal list view (`tagAiModalView`), null-safe submit, `tagAiAfterTagSaved` |
| `taguette/static/js/config.js` | `readTask()` preserves fields the task panel doesn't manage (temperature, prompts) |
| `taguette/templates/project.html` | highlight form: search bar + status + "Show all tags"; tag form: suggestion chips, AI buttons, preview, similar tags; `#tag-ai-menu`; script include |
| `taguette/static/css/custom.css` | chips, preview box, menu (mirrors `#sug-menu`), prompt textareas |

## 2. The 'llm' task and the "AI tags" configuration tab

A new task id `'llm'` in the shared store, resolved like the others
(`taguResolveTask`) against `/chat/completions` (every provider catalogued
in `TAGU_PROVIDERS` exposes an OpenAI-compatible chat API). Local services:
`ollama_chat` and `llamacpp_chat` entries added to `TAGU_LOCALS` (same
servers as the embedding locals, chat path).

The tab (registered by tags-ai.js, order 250) offers:

- service picker (key / local / custom endpoint) + model + *Test
  connection* (a one-token chat round-trip), via the shared `taguTaskPanel`;
- **temperature** (0–2, default 0.4): all OpenAI-compatible chat APIs
  accept it, so it is always shown;
- **prompt templates** for the five tasks below, with placeholders and a
  *Reset to default* button. Templates live in
  `tasks.llm.prompts`; an empty template means "use the built-in default"
  (`TAG_AI_PROMPTS`).

`config.js`'s task panel now round-trips unknown task fields on save, so
panel edits (service, URL, model) never clobber temperature/prompts.

## 3. Highlight form: ranked suggestions + search

`taguette.js`'s `updateTagsList()` asks `tagAiModalView()` how to render
the modal's tag list — `{visible: {id: true}}` filters the tree,
`{order: [...]}` renders a flat ranked list. While the modal is closed the
answer is null (unchanged behavior).

On `show.bs.modal` (new and existing highlights):

- The highlight's text is taken from the selection at open time (a wrapper
  around `createHighlight` captures it) or, when editing, from the
  `highlight-<id>` spans in the document view.
- **Lexical ranking** (always available, instant): stopword-filtered
  bag-of-words cosine between the highlight and `tagSearchText(tag)`
  (name + description), reusing suggest.js's tokenizer/stopwords.
- **Semantic ranking** replaces it when an embedding endpoint is
  configured: `sugEmbed` the highlight + every tag (IndexedDB-cached), rank
  by cosine. Failures degrade gracefully to the lexical ranking.
- The list then shows only the **top 10, best first**; a "Show all tags"
  link reveals the full tree (and toggles back). A status line says how the
  ranking was computed. A tag created from this form stays visible even if
  unranked (`tag_to_select_in_highlight`).
- A **search bar** above the list mimics the Highlights panel's: lexical
  substring match immediately, semantic matches added through the same
  adaptive cutoff (median + margin over a hard floor). Search overrides
  the ranking; clearing it restores the top-10 view. The existing
  "Create a tag" button is untouched.

Safety: `updateTagsList` re-renders preserve checked checkboxes; a
checkbox hidden by the filter keeps the highlight's previous state on
submit (a tag already on the highlight is never silently dropped), and the
submit handler treats missing checkboxes as "keep".

## 4. Tag form

Opened from the highlight form (context available) or the panel:

- **Name suggestions** (new tags, from the highlight form, LLM configured):
  three names asked in one call, shown as light-gray chips under the name
  field; one click copies the name into the field for manual editing. The
  prompt includes the existing tag paths so the model avoids duplicates.
- **"Generate description with AI"** (no description yet) / **"Re-generate
  description with AI"** (existing description): context is the tag name +
  the highlighted text (new tags) or **all the tag's highlights** (existing
  tags — fetched from the existing paginated
  `/api/project/<id>/highlights/<path>` endpoint, HTML-stripped, evenly
  sampled to ≤40 excerpts so long tags still cover their whole range). The
  suggestion is previewed below the field with **Accept / Try again /
  Discard**; Accept replaces the description.
- **"Augment description with AI"** (existing description only), a menu
  with three prompts: *Add examples* (quotes from the highlights), *Add
  "includes"* (subtopics), *Add "Do not confound with"* — the last one is
  fed the cosine-similar non-ancestor tags (see below) so the model can
  contrast the themes. Accept appends the section to the description.
- **Similar tags** below the description: the top 5 most cosine-similar
  tags (embeddings, or lexical fallback), excluding the edited tag, its
  ancestors and descendants. Clicking one opens a context menu:
  - *Set as parent* — fills the parent search bar;
  - *Set as descendant* — re-parents the clicked tag under the edited one
    (POST to the existing tag-update endpoint); while the tag form is
    creating a *new* tag, the action is stored and applied by
    `tagAiAfterTagSaved()` once it exists;
  - *Merge…* — the existing merge modal with the tag preselected (also
    deferred for not-yet-saved tags).

## 5. Testing

- `?tags_ai_selftest=1` (pattern of suggest.js): truncation, lexical
  ranking order, LLM answer parsing, prompt substitution + overrides,
  excerpt sampling, similar-tag candidate filtering, top-10 view slicing.
- jsdom integration (not shipped; run against a dev server): loads the
  real page with all scripts, exercises every feature end-to-end with
  stubbed embedding/LLM services — 43 checks, including the
  hidden-checkbox submit safety and the config-tab round-trip. This
  caught two real bugs during development (jQuery not yet loaded at
  parse time, and `insertBefore(null)` crashes in filtered tree renders).
- `node --check` on all touched JS files.

## 6. Out of scope

- Server-side LLM integration or prompt logging (the server never sees the
  model traffic, by design).
- Translation catalogs (new strings are gettext'd; Transifex flow applies).
- Bulk operations (e.g. re-ranking a whole document's highlights).
