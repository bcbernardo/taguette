# Plan: Suggested highlights (semi-supervised coding)

Goal: let Taguette *suggest* highlights in a document using automatic algorithms
(TextRank / LexRank / YAKE / RAKE, optionally re-scored with embeddings), let the
user review/adjust them in a dedicated session, and turn accepted suggestions
into real highlights.

## 0. Key architecture decision: everything client-side

The algorithms, scoring and suggestion bookkeeping run **in the browser**:

- The document text is already in the DOM (`#document-contents` chunks) and the
  frontend already knows how to convert DOM positions ↔ UTF-8 byte offsets
  (`describePos` / `locatePos` in `taguette.js`). Suggestions computed on the
  plain text map 1:1 onto the offset space used by the DB and the
  `extract.extract()` server-side snippet logic — **no new API endpoints and no
  DB migration are needed**.
- Suggestions are ephemeral (session-only, browser memory). Only highlights the
  user explicitly *accepts* are POSTed to the existing
  `/api/project/<id>/document/<id>/highlight/new` endpoint — and only when the
  session is stopped with "Save". Nothing half-decided ever reaches the shared
  database (important for multi-user projects).
- Pure-JS implementations of TextRank / LexRank / YAKE / RAKE are compact and
  avoid new Python dependencies and the repo's deliberate no-NPM philosophy
  (see CONTRIBUTING: single hand-written JS file, no build system).
- Embedding services are called **directly from the browser** with the user's
  own token; the token never reaches the Taguette server. Config lives in
  `localStorage`.

Embedding models:
- **Remote**: any OpenAI-compatible `/embeddings` endpoint with a token, e.g.
  OpenRouter (`https://openrouter.ai/api/v1/embeddings`).
- **Local**: the same config screen accepts a token-less local endpoint
  (Ollama `http://localhost:11434/v1/embeddings`, llama.cpp server, or
  text-embeddings-inference running e.g. MiniLM / `all-MiniLM-L6-v2`).
  Vendoring transformers.js + ONNX runtime (≈40 MB) into `static/` was
  rejected: no build system, huge payload. Running MiniLM behind a local
  OpenAI-compatible server gives the same result with zero shipped bytes.

## 1. Files touched

| File | Change |
|---|---|
| `SUGGESTED_HIGHLIGHTS_PLAN.md` | this plan |
| `taguette/static/js/suggest.js` | **new** — algorithms, embedding client, session UI, brackets, menus, split screen; registers the *Embeddings* and *Decisions* tabs of the configuration screen (~1000 lines, plain ES5-style JS like `taguette.js`) |
| `taguette/static/js/taguette.js` | small generalization: pane-prefix aware `describePos` / `locatePos` / `highlightSelection` so a second split-screen pane can be addressed; everything else untouched |
| `taguette/static/css/custom.css` | suggestion colors, blinking brackets, accepted style, split layout, context menu |
| `taguette/static/js/config.js` | **new** — shared configuration screen: tab registry, API keys tab, provider/local-service catalogs, task resolution, legacy-store migration |
| `taguette/templates/project.html` | session toolbar, configuration screen modal shell, stop modal, context-menu div, `<script include>` |

No server-side (Python) changes at all. No changes to exports, existing
highlight flow, or translations catalogs (new strings use `gettext()` and fall
back to English until uploaded to Transifex).

## 2. Offset math (must match existing conventions)

- `getPlainIndex()` builds, per loaded document: `plainText` (JS string =
  concatenation of chunk `textContent`) and per-char **cumulative UTF-8 byte
  offsets** anchored at each chunk's `doc-offset-N` value. This is exactly the
  space `describePos()` produces, so candidate spans map directly to
  `start_offset` / `end_offset`.
- Algorithm code works in JS string indices; helpers `charToByte(i)` /
  `byteToChar(b)` convert via the cumulative array.
- Guard: suggestions shorter than 3 bytes are dropped; spans are clamped to
  sentence/word boundaries where the algorithm provides them.

## 3. Algorithms (`suggest.js`, all pure JS)

Common interface: `algo.run(plainText) -> [{start, end, raw}]` (JS char
indices), then `normalize()` converts `raw` scores to percentile ranks
`[0,1]`.

1. **TextRank** — sentence segmentation (regex over `.!?` boundaries, offsets
   kept); sentence vectors = stopword-filtered lowercase word bags; edge weight
   = word-overlap similarity (Mihalcea & Tarau 2004:
   |S1∩S2| / (log|S1| + log|S2|)); PageRank power iteration (d = 0.85) to
   convergence (ε = 1e-4, ≤100 iters). Suggestion span = the sentence's char
   span.
2. **LexRank** — idf-modified cosine TF-IDF sentence vectors; continuous
   degree-centrality variant (Erkan & Radev 2004): L = row-normalized
   similarity matrix, power-iterated like PageRank. Sentence spans.
3. **YAKE** — (Campos et al. 2020, simplified but faithful: casing folded into
   position/frequency features): per-term weight
   `W = max(0, position × frequency) / (relatedness × (1 + sentenceSpread))`
   with a ±2-word relatedness window; candidate n-grams (1–3) split on
   stopwords/punctuation; phrase score `= (ΣW) / (maxW + 1)`; every occurrence
   of a top candidate becomes a suggestion span (dedup'd).
4. **RAKE** — (Rose et al. 2010): candidate phrases = maximal non-stopword
   runs; word degree = Σ co-occurrence frequency within phrases; phrase score =
   Σ word degrees; occurrences of top phrases become suggestion spans.

Per pane, one algorithm runs at a time. Candidates from one algorithm that
overlap are merged (union span, max score) before display — merely *adjacent*
spans stay separate (they are distinct sentences/phrases). The UI keeps the
"no two suggestion brackets overlap" invariant except when the *user* drags
one over another, which triggers the merge described in §5.

**Transcription profile** (real-transcript fixes, after field testing showed
TextRank collapsing onto one giant span, LexRank elevating backchannels, YAKE
extracting hedges):

- **Segmentation** (always on): newlines are hard sentence boundaries
  (speaker turns), and any run without punctuation is capped at 60 words
  (comma-preferred cut points) — no more single giant highlight, and enough
  candidates for the percentile cut-off to mean something.
- **Transcription mode** (checkbox, auto-enabled when
  `sugDetectTranscription()` finds sparse punctuation, frequent fillers, or
  many ≤3-word "sentences"): extends stopwords with spoken fillers
  (yeah, I think, you know, kinda…) and drops backchannel/too-thin sentences
  from TextRank/LexRank ranking (min 2 content words).
- **Expand keyphrases** (checkbox, defaults on with transcription mode):
  YAKE/RAKE candidates are expanded to the full sentence/turn containing them,
  so keyphrases become argument-sized passages.
- Both toggles are part of the algorithm cache key (`|t`, `|x`), so switching
  them recomputes (and re-expands) without polluting the other mode's cache.

**Ranking modes** (select, replaces the old on/off embedding checkbox):

1. **Lexical** — the four algorithms' own percentile scores (no embeddings).
2. **Semantic centrality** — candidates + sentences embedded in batches of 32
   via `POST {url} {model, input:[...]}` (Bearer token if set); centrality =
   cosine to the document centroid; blended score = 0.5 × lexical percentile
   + 0.5 × embedding percentile. Network/CORS failure → alert + graceful
   fallback to lexical-only.
3. **Themes (clusters)** — cosine k-means (deterministic: mulberry32-seeded
   k-means++, ≤25 iterations) over the candidate embeddings, per pane. Each
   cluster contributes its top-m passages by similarity to the cluster
   centroid (representativeness), so suggestions cover the document's
   distinct themes instead of bunching on the dominant one. Within a theme,
   candidates whose embedding is near-duplicate (cosine ≥ 0.85) of an
   already-picked passage are skipped, so a theme contributes distinct
   arguments rather than rephrasings. The slider maps
   to `k` (2…12 themes, conservative = fewer/bigger) and `m` (1…3 kept per
   theme); the shade of yellow is the within-theme percentile. Suggestions
   carry a `T1…Tn` badge (CSS-generated content, so text offsets stay
   intact), and the context menu offers *Accept all of Tn* / *Discard theme
   Tn* bulk operations. Slider changes re-cluster locally (no network).

**Caching** (four layers, so nothing is ever computed or embedded twice):

1. `SUG_ALGO_CACHE[document_id][algo|mode-flags]` — algorithm results
   (candidates with byte offsets + percentiles + embedding scores), keyed by
   algorithm and transcription/expand flags. Switching back to a
   previously-run algorithm/mode is instant: no re-run, and the cached
   candidates keep their embedding scores.
2. `SUG_EMB_CACHE[endpoint|model][text]` — embedding vectors keyed by the
   exact text. Switching algorithms or restarting the session only embeds
texts never seen before (TextRank/LexRank candidates *are* the sentences, so
   their embeddings also serve the centroid; YAKE/RAKE phrases often overlap
   them).
3. `SUG_CENTROID_CACHE[document_id|endpoint|model]` — the document centroid
   vector, recomputed locally from cached sentence vectors, never re-fetched.
4. `IndexedDB` (`taguette_suggest` DB, `vectors` store) — the persistent L2
   for embedding vectors, keyed by `endpoint|model` + text hash (two 32-bit
   FNV-1a + length). Vectors survive page reloads and browser restarts, so
   closing and reopening the tool never re-embeds a document; vectors are
   stored as `Float32Array` (~1.5 KB each at 384 dims). The wrapper degrades
   to a no-op when storage is unavailable (private mode, blocked, ...), so
   the feature works everywhere. The config test button bypasses the cache —
   it must actually hit the endpoint to prove the URL/token work.

Additionally, the suggestions the user adjusted are stashed per algorithm
(`pane.savedSuggestions`), so switching algorithms and back doesn't lose
bracket drags and merges. Changing the endpoint or model in the config screen
invalidates the stale scores (keyed by `endpoint|model`) and re-embeds only
what's missing under the new key.

## 4. Scoring UI: slider + shades of yellow

- Slider 0–100 ("Conservative → Aggressive"). In the percentile modes the
  cut-off is on the rank: `keep if pct ≥ 1.00 − 0.99·(v/100)` (v=0 keeps only
  the single best candidate, v=100 keeps everything); in cluster mode the
  slider sets the number of themes (k = 2…16, at most half the candidates)
  and passages per theme (m = 1…4). A live label next to the slider shows
  what the current value controls ("50%" / "3 themes × 2 each"). Slider
  changes are debounced (250 ms, flushed on release): the cheap label
  updates on every move, while re-clustering and the pane re-render happen
  only after the user stops dragging — dragging never blocks the UI.
  No recomputation, no network.
- Shade of yellow encodes centrality (percentile mode) or within-theme
  representativeness (cluster mode): background `hsl(52, 100%, 92% → 60%)`
  darkening as the suggestion becomes more central.
- In split mode one shared slider feeds both panes; each pane keeps its own
  algorithm selector (and clusters its own candidates).

## 5. Session interaction

Session state (client memory): per pane `{algorithm, suggestions[]}` where each
suggestion is `{sid, start, end, origStart, origEnd, pct, modified, merged}`,
plus `staged[]` = `{aid, start, end, tags[], algo, pct}` (accepted, not yet
saved to the server).

- **Brackets**: `[` / `]` inline elements (class `sug-bracket`) at the span
  boundaries, light gray, **blinking** (CSS opacity animation). They only stop
  blinking when the suggestion is accepted.
- **Dragging a bracket** (delegated `mousedown`, so re-renders don't break the
  drag): `document.caretRangeFromPoint` / `caretPositionFromPoint` under the
  cursor → byte offset via `describePos` → update the span (clamped: start <
  end − 2, cannot overlap an already-accepted staged highlight). Dropping the
  end bracket onto/over another suggestion **merges** the two (union range,
  max score) — spec'd merging behavior. Any drag marks the suggestion
  `modified` (its brackets turn solid gray, no longer identical to the
  algorithm's original, enabling "Revert to algorithm suggestion").
- **Suggestion menu** (hover 250 ms or click; floating `#sug-menu` like the
  existing `#hlinfo` popup): *Save as highlight*, *Discard suggestion*,
  *Revert to algorithm suggestion* (disabled unless `modified`). Save = stage
  it; Discard = remove it from the pane.
- **Accepted staged highlights**: rendered as normal `.highlight` wrappers but
  class `hl-staged` → **desaturated yellow** (`hsl(50,45%,78%)`), brackets
  solid (no blink). Click → menu: *Revert to suggestion* (un-stage, restore
  the suggestion with its original algorithm span/score), *Add tag* → inline
  tag-picker popover (checkboxes over the project `tags` map; writes back to
  the staged entry client-side).
- **Stop** button in the session toolbar → modal showing counts:
  *Save N highlight(s)* (POSTs each staged entry to the existing highlight API
  sequentially; server long-poll events render them as regular highlights),
  *Discard everything* (after a `confirm()` — spec requires confirmation),
  *Continue* (back to the session). Loading a different document mid-session
  also triggers this dialog.

The ordinary manual highlight flow (select text → "new highlight") keeps
working untouched during a session, including in split mode.

## 6. Split-screen comparison

- Toggle in the session toolbar. `#document-view` gains class `split` → flex
  row of two panes (`#document-contents` + cloned `#document-contents-b` with
  `doc-offset-R<N>` chunk ids) inside the same page flow, so **scrolling is
  naturally common** (one scroll container = the window).
- Pane registry in `taguette.js` (`pane_prefixes = ['', 'R']`):
  `locatePos(pos, prefix)` resolves chunk ids per pane; `describePos` parses
  the digits after `doc-offset-` regardless of prefix; `highlightSelection`
  wraps the span **in every registered pane** so accepted/real highlights are
  shown equally on both sides (removal already works document-wide via
  class lookup).
- Suggestions are per-pane state: left pane algorithm A, right pane algorithm
  B (default TextRank + LexRank; falls back to YAKE when A = LexRank).
  Brackets, dragging, merging and menus operate on the pane's own suggestion
  list; both panes re-render on shared events (accept, slider, stop).

## 7. Config screen (embedding service)

Modal opened from the session toolbar ("Embedding settings"):
- Endpoint URL (default `https://openrouter.ai/api/v1/embeddings`)
- API token (password field; optional — leave empty for local servers)
- Model id (placeholder `openai/text-embedding-3-small` for OpenRouter,
  `sentence-transformers/all-MiniLM-L6-v2` for a local MiniLM server)
- *Test connection* button (embeds `"test"`, reports latency or the HTTP/CORS
  error inline), plus a hint that local Ollama needs `OLLAMA_ORIGINS=*` for
  browser CORS.
Persisted in `localStorage["taguette_suggest_config"]`; a "Use embeddings"
toggle in the toolbar is only enabled when the last test succeeded.

## 8. Speaker segmentation (who speaks in each turn)

Interview/focus-group transcripts: instead of a binary interviewer vs
interviewee classification, each speaker turn is labeled with the person
speaking in it, for any number of speakers. Suggestions can then be
restricted to any subset of speakers (one include checkbox per speaker;
turns with no speaker count as included).

- **Turns**: `sugBlocks()` walks the same `doc-offset-` chunks as
  `sugBuildPlainIndex`, breaking at block-level elements (`<p>`, `<br>`,
  `<li>`, ...) and newlines inside text nodes. Blocks are `{start, end, text}`
  spans *into the existing plainText* — nothing is inserted, so highlight
  byte offsets stay valid. `sugBlocksOfText()` is the pure line-based
  variant used in self-tests.
- **Prefix lines**: a short line that is just a speaker label and/or a
  timestamp ("Interviewer:", "Dr. Silva [00:12]:", "RESPONDENT [00:20]",
  "Maria Silva (12:34)", "[00:12:33]", "00:00 --> 00:05") is folded into
  the block that follows it during preprocessing. The merged block records
  `contentStart` at the spoken text: the transcript rectangle wraps the
  speech, not the label line, and `sugSpeakerPrefix()` exposes the label
  part. Inline labels ("John: hello") stay part of the first line.
- **Local pre-scan** (no LLM): `sugPreScanPrefixes()` counts the most
  frequent candidate labels on the turns' first lines and the share of
  turns that carry one — a hint for the model and the basis for building
  speakers by hand.
- **Proposal (one LLM call)**: the `segmentation` task of the
  configuration screen (any OpenAI-compatible chat endpoint, or a local
  Ollama/llama.cpp server) receives ~30 random excerpts (~300 characters
  each) plus the pre-scanned labels and answers once with strict JSON:
  `{speakers: [{name, role?, rules: [{type: 'literal'|'regex', pattern,
  example}]}], notes}`. Patterns are matched against the FIRST LINE of a
  turn (at most 80 characters), never the whole text. A privacy notice in
  the tab reminds that excerpts are sent straight from the browser to the
  chosen service.
- **Validation (the model is untrusted)**: regexes are syntax-checked
  inside try/catch, capped at 200 characters and rejected when a
  quantifier is applied to a group that already ends in one (ReDoS risk);
  every rule must match the example the model cited or at least one real
  turn, and patterns without a match are dropped (rule-less speakers too).
- **Review before anything is applied**: the *Speakers* dialog lists the
  proposed speakers with name, color, editable patterns, live match
  counts and real examples; speakers can be renamed, recolored, merged,
  removed and added, and unmatched turns (with example first lines) stay
  visible. *Confirm* commits the profile and applies it.
- **Deterministic assignment**: each turn gets the FIRST speaker whose
  rule matches (`turn.speaker`, `turn.source: 'auto'`); unlabelled turns
  get `speaker: null` (grey "?" badge). Clicking a badge opens a menu of
  speakers and marks the turn `source: 'manual'`, so re-applying rules,
  re-proposing or editing the transcript never overwrites it (manual
  assignments are inherited by identical turn text after an edit).
- **Rendering**: every turn is outlined in the speaker's color (border
  only — no fill, so it never reads as a highlight) with a badge carrying
  the speaker's name; the badge is textless (CSS paints
  `attr(data-speaker)`), so `plainText` offsets are never polluted.
  Colors travel as an inline `--sug-speaker-color` custom property from
  an 8-color palette.
- **Filtering**: in `sugRefilterPane`, candidates with more than half
  their span inside turns of speakers whose *include* checkbox is off are
  dropped (`sugIsExcludedSpan`; cluster and percentile modes both;
  compared on `cStart/cEnd` char offsets, which is what blocks are indexed
  in). The panel status shows `· N speaker(s) hidden` while any speaker is
  excluded.
- **Persistence**: the confirmed profile (names, colors, rules, include
  flags) lives in the browser only — `localStorage` under
  `taguette_speaker_profile_<document id>`; no table, no migration, no
  endpoint. Reopening the document re-applies the rules for free, with no
  LLM call; `sugRebuildAfterReload()` recomputes the turns after a
  transcript edit and re-applies them.
- **Phase 2 hook (out of scope)**: transcripts with few or no labels keep
  their unmatched turns visible with a "Propose with AI" retry (re-running
  the single call costs nothing); an optional later phase may classify
  windows of neighbouring turns among the unmatched ones with the same
  speaker profile.

## 9. Transcript edit mode (server-side)

Automated transcripts routinely misattribute turns (speakers talking over
each other, label glitches). **Double-click any paragraph** in the main
pane to edit its text in place — no formatting tools, just text. `Enter`
applies, `Esc` cancels, clicking away applies. This is a *document*
feature, not a suggest feature: it works with or without a session.

The **whole chunk** becomes editable (not just the double-clicked
paragraph), so `Backspace` at a paragraph start merges it into the
previous one, selecting + `Delete` removes a paragraph, and
**`Shift+Enter` splits** the paragraph at the caret into two —
transcription tools merge and split turns wrongly all the time. `Enter`
applies everything, `Esc` cancels, clicking away applies. The page keeps
its scroll position across the reload, so long documents stay workable.

Edits are committed to the **server** (`POST
/api/project/{p}/document/{d}/edit` with `{start_offset, end_offset,
text, paragraphs}` in the same byte-offset space highlights use), so the
corrected transcript is the shared source of truth: exports, other
views, and later sessions all see the corrected text. Single-user
deployments only (`--multi-user` disables both the endpoint and the
client, since concurrent editors need conflict handling we have not
built).

On commit the client diffs by **block element identity** (the browser
keeps a paragraph's node when editing or merging into it, drops the node
of a merged-away or deleted paragraph): a surviving element with new text
becomes a replacement, a dropped element a deletion, and brand-new
elements (from `Shift+Enter`) fold into the op of the old block they sit
next to, joined with `\n` — the paragraph-break marker. One editing
session can produce several ops, applied to the server one after
another, each shifting the offsets of the next.

Server behavior on edit (`web/api.py` `DocumentEdit`, splice via
`extract.edit()` which reuses the `extract()` offset machinery):

- Highlights before the edit are untouched, those past it shift with
  the text, and those overlapping it are mapped through a diff of the
  old and new text (`_migrate_highlights`, difflib): a highlight over
  text that did not change keeps its exact bounds (a typo fix no
  longer kills highlights elsewhere in the paragraph), one over
  changed text shrinks to the nearest unchanged boundary, and a
  highlight is deleted only when it collapses to nothing (all its
  text was replaced or removed); snippets are recomputed. The client
  tells the user how many were removed. The edit is logged as a
  `document_edit` command. (Staged, session-only suggestions follow
  the simpler shift/resize rule client-side.)
- For the same reason, the client sends a paragraph **merge as one
  op** spanning both paragraphs (a pure deletion right after a
  replacement, with only filler between, is folded into it): the
  merged-away paragraph's text is then a matching block in the diff,
  so its highlights survive the merge with exact bounds — instead of
  being deleted by a separate delete-of-the-emptied-range op. A
  multi-paragraph merge chains into one op the same way.
- Blocks emptied by the edit are removed: deleting a paragraph leaves no
  empty line, and merging two paragraphs actually leaves one. With the
  `paragraphs` flag, `\n` in the replacement text is a paragraph break:
  the receiving block is split into one block per line (empty lines
  become empty paragraphs and are kept); this is only valid when the op
  covers the block's whole text (otherwise the edit is rejected), and
  the break bytes carry no offset. A document cannot be emptied
  entirely (rejected with an error).
- The client then reloads the document from the server; with a session
  running, staged highlights and adjusted suggestions are remapped with
  the same endpoint rule, and blocks/roles/panes are recomputed on the
  corrected text (roles inherited for turns whose text did not change).

## 10. Edge cases handled

- Very short documents (< 3 sentences / no candidates) → "Not enough text"
  notice in the toolbar, no crash.
- Unicode: byte-offset arrays built with the same `lengthUTF8` logic as the
  rest of the frontend; multibyte boundaries can't split (offsets derive from
  whole characters).
- Real highlights arriving via long-poll during a session render in both
  panes automatically (existing `setHighlight` path, now pane-looping).
- Duplicate suggestions across the two panes are fine (independent lists).
- Suggestions overlapping *real* highlights render as nested spans — no data
  risk; staged (accepted) spans are protected from bracket-drag overlap.

## 11. Self-check

`suggest.js` ends with an assert-based smoke test (runs only with
`?suggest_selftest=1` in the URL, harmless in production): byte mapping,
sentence splitting, each algorithm returning sane spans, merge-on-overlap,
percentile cut-off. The full file is also syntax-checked with `node --check`.
During development the DOM interactions (rendering, brackets, accept/discard,
split screen, cleanup) were additionally exercised under jsdom; three real
bugs were found and fixed that way (cleanup re-rendering stale staged
entries, adjacent spans being merged, and a non-terminating chained merge).
The caching layer has its own jsdom test: algorithm run counters prove no
recomputation on switch-back or session restart, and fetch-call counters
prove embeddings are only requested for never-seen texts (a two-algorithm
session with several switches and a model change needs ~3 requests total).

## 12. Explicitly out of scope (lazy senior-dev notes)

- Persisting suggestions across reloads (session is ephemeral by design).
- transformer.js in-browser model downloads (§0 explains the local-endpoint
  alternative).
- Updating `.po` translation catalogs (Transifex flow, server-side script).
- Cross-document suggestion sessions.
