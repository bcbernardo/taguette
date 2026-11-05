# D — Read-only database inquiry report (tag multiselect feature)

Source DB: `2026-11-01_AIM 2026 Charity Interviews.sqlite3` → analyzed on a byte-identical copy
`/tmp/taguette_inquiry.db` (md5 `4be203de2bdf719454026ed491fa61f7` both), opened with
`sqlite3.connect('file:/tmp/taguette_inquiry.db?mode=ro', uri=True)` — read-only URI mode, SELECTs only.
The original file was never touched.

**Schema check:** `SELECT * FROM alembic_version` → `63d7ca28fc0c` (skill's head revision); `PRAGMA application_id` →
`1416066164` (`0x54677474` "Tgtt"); `tags` columns `id, project_id, path, description, parent_id` — schema matches
`SKILLS/taguette-database/reference.md` exactly, including `parent_id`. No discrepancies; all sections proceed.

---

## 1. Project / tag stats

SQL skeleton (all per-project numbers below):

```sql
SELECT (SELECT COUNT(*) FROM documents d WHERE d.project_id=p.id)             AS n_docs,
       (SELECT COUNT(*) FROM highlights h JOIN documents d ON d.id=h.document_id
         WHERE d.project_id=p.id)                                             AS n_hl,
       (SELECT COUNT(*) FROM tags t WHERE t.project_id=p.id)                  AS n_tags,
       (SELECT COUNT(*) FROM tags t WHERE t.project_id=p.id
         AND t.parent_id IS NULL)                                             AS n_roots,
       (SELECT COUNT(*) FROM tags t WHERE t.project_id=p.id
         AND TRIM(t.description) <> '')                                       AS n_desc
FROM projects p;
```

**1 project** total (`SELECT COUNT(*) FROM projects` → 1):

| metric | project 1 "AIM 2026 Charity Interviews" |
|---|---|
| documents | 1 |
| highlights | 119 (2 with zero tags) |
| tags | 100 |
| root tags (`parent_id IS NULL`) | **100** |
| tags with non-empty description | 13 |
| `highlight_tags` links | 146 (mean 1.23 links/highlight) |
| commands (audit log rows) | 829 |

### Tag depth distribution

Depth computed by walking each tag up via `parent_id` to its root (SQL variant: downward recursive CTE from every
tag, `MAX(depth)` per root — same query as check 2 below).

| depth | tags |
|---|---|
| 0 (root) | 100 |
| ≥1 | 0 |

**The whole tag set is completely flat.** The `tags.parent_id` column exists (post-`63d7ca28fc0c` schema) but this
workspace has never used nesting: max children per tag = **0**, mean children per tag = **0.00**.

### Highlight-count distribution over tags (`GROUP BY t.id HAVING …` / LEFT JOIN count)

| direct highlights | # tags |
|---|---|
| 0 | 6 |
| 1 | 57 |
| 2 | 29 |
| 3 | 6 |
| 6 | 1 |
| 7 | 1 |

### Top-10 tags by highlight count

```sql
SELECT t.path, COUNT(ht.highlight_id) n FROM tags t
LEFT JOIN highlight_tags ht ON ht.tag_id=t.id
WHERE t.project_id=1 GROUP BY t.id ORDER BY n DESC LIMIT 10;
```

| n | tag path | desc? |
|---|---|---|
| 7 | Senior leadership stress and mental health issues | y |
| 6 | Action points, suggested next steps and recommendations for further exploration by interviewers | y |
| 3 | Challenges hiring and managing technical people | n |
| 3 | Tech talent rarity and competition | n |
| 3 | Crux scale considerations: investing in getting a "top-charity" stamp | n |
| 3 | Limits to the rate of organizational growth | n |
| 3 | Pros and cons of affluent Western socialization over founder behaviors | n |
| 3 | AIM should incubate more replications of existing ideas | n |
| 2 | Gaps in AIM's cause area report | y |
| 2 | Problems of putting too much effort on program refinement | y |

### Tag name (`path`) lengths — relevant to §4 UX

`SELECT LENGTH(path) FROM tags` → min **17**, max **95**, mean **50.0**, median 49, p90 69; **89 of 100 tags exceed
30 chars**. Tags are sentence-like paraphrase codes, not short keywords.

---

## 2. Hierarchy invariants check

All queries are pure SELECTs against the copy. One row per check:

**2a. Parent-chain loops / depth > 20 — PASS (0 rows)**

```sql
WITH RECURSIVE walk(tag_id, root_id, depth) AS (
  SELECT id, id, 0 FROM tags
  UNION ALL
  SELECT c.id, w.root_id, w.depth+1 FROM tags c JOIN walk w ON c.parent_id = w.tag_id
  WHERE w.depth < 100)                       -- hard bound: a cycle can't run away
SELECT root_id, COUNT(*), MAX(depth) FROM walk GROUP BY root_id HAVING MAX(depth) > 20;
-- returns 0 rows; cycle detection variant (COUNT(*) > 100 under the bound) also returns 0 rows.
```

**2b. `(project_id, path)` duplicates — PASS (0 rows)**

```sql
SELECT project_id, path, COUNT(*) c FROM tags GROUP BY project_id, path HAVING c > 1;  -- 0 rows
```

**2c. Orphan `parent_id` (nonexistent or cross-project parent) — PASS (0 rows)**

```sql
SELECT t.id, t.project_id, t.parent_id FROM tags t
LEFT JOIN tags p ON p.id = t.parent_id
WHERE t.parent_id IS NOT NULL AND (p.id IS NULL OR p.project_id <> t.project_id);     -- 0 rows
```

**2d (bonus). Cross-project highlight↔tag links — PASS (0 rows)** (invariant 4 in the skill)

```sql
SELECT ht.highlight_id FROM highlight_tags ht
JOIN highlights h ON h.id=ht.highlight_id JOIN documents d ON d.id=h.document_id
JOIN tags t ON t.id=ht.tag_id WHERE t.project_id <> d.project_id;                     -- 0 rows
```

Trivially expected given every tag is a root, but the checks are written to run unchanged on nested data and can be
re-used as a post-feature regression check.

---

## 3. Inheritance closure spot-check — **0 violations (expect 0 ✓)**

Verified for **ALL** highlights (all 146 `highlight_tags` links) with a recursive-CTE ancestor expansion + anti-join:

```sql
WITH RECURSIVE anc(tag_id, ancestor_id) AS (
  SELECT id, id FROM tags
  UNION ALL
  SELECT a.tag_id, t.parent_id FROM anc a JOIN tags t ON t.id = a.ancestor_id
  WHERE t.parent_id IS NOT NULL)
SELECT COUNT(*) FROM anc
JOIN highlight_tags ht ON ht.tag_id = anc.tag_id
LEFT JOIN highlight_tags need ON need.highlight_id = ht.highlight_id
                             AND need.tag_id = anc.ancestor_id
WHERE need.highlight_id IS NULL;
-- → 0
```

Cross-checked by an independent Python computation of the same required-pair set against
`SELECT highlight_id, tag_id FROM highlight_tags`: required pairs = 146 = stored links = 146, missing = 0.
Consistency holds trivially here because `anc(t) = {t}` for every tag (all roots) — the data never exercises the
ancestor-inheritance machinery, which is exactly what the new bulk Group/Merge operations will start doing.

---

## 4. UX implications (notes only, no code changes)

- **`limit 5` for "Other suggested tags" is sensible.** With 100 tags and a members list that can itself hold many
  long chips, a hard cap of ~5–8 keeps the compose modal from becoming a second tag tree; the spec's cap (~8 total,
  suggestions limited to 5) fits this dataset well. Note the suggestion engine will operate on a sparse corpus —
  57/100 tags have exactly 1 highlight — so lexical fallback quality matters as much as the cap.
- **The bulk bar itself won't wrap from names** — it renders only "N tags selected" + 3 small buttons (`d-flex
  flex-wrap` is a safe fallback). Tag *names* appear where overflow is real: the merge modal's `paths.join(', ')` and
  the move modal's message. Mean name length is 50 chars (p90 69, max 95), so even 3 joined names overflow a Bootstrap
  modal body — the spec's "truncate to ~5 names + …" rule is not just sensible but necessary; consider title/tooltip
  for the truncated list.
- **Typical number of roots to scan = all 100** — there are no parents today, so `tagRoots()` returns everything and
  the tree renders as a flat 100-item list. The multiselect + Group flow is precisely the remedy; realistic selection
  batches will be first-word families of size 3–7 (`pros…` ×7, `aim…` ×5, `crux…` ×5, `challenges…` ×4), so
  sequential per-tag PATCH chains (§5.3) stay cheap and the "Group" gate at ≥2 is well calibrated.
- **Filter-first pickers are the right interaction for these names.** Sentence-length tags (17–95 chars) make a
  scroll-and-click candidate list painful; the merge/move/compose comboboxes with substring filtering (and the always
  pinned "(root level)" option) match the data. Everything is currently at root level, so the pinned option will be
  the *typical* destination for Move-to in this workspace, not an edge case.
- **Untagged/unused residue invites bulk ops.** 6 tags have zero highlights and 2 highlights have no tags; bulk-merge
  of the unused six (or tagging the stragglers via suggestions) is a plausible first real use of the feature. After
  the first Group/Move lands, the closure check in §3 stops being trivial — re-run these exact queries against a
  scratch-project DB as the post-merge regression check (as §9 of the plan already suggests).

---

## Summary (5 lines)

1. Schema matches the skill reference (Alembic head `63d7ca28fc0c`); analyzed a read-only copy, original untouched.
2. 1 project, 1 document, 119 highlights, **100 tags — all roots (depth 0), 0 nesting ever used**; max/mean children 0.
3. 13/100 tags have descriptions; tags are sentence-length (mean 50, max 95 chars); top tag has only 7 highlights.
4. All hierarchy invariants PASS (0 loops, 0 depth>20, 0 `(project_id,path)` dupes, 0 orphan parents) and the
   inheritance closure check finds **0 violations** over all 146 links (trivially, since no ancestors exist yet).
5. UX defaults hold up: `limit 5` suggestions is right; bulk bar is safe, but name truncation in merge/move modals is
   mandatory at these name lengths; users currently scan 100 flat roots — the Group/Merge flow targets real 3–7-tag
   lexical families.
