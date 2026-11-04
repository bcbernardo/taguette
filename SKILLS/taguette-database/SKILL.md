---
name: taguette-database
description: Understand and programmatically read or modify Taguette's database (projects, documents, highlights, tags, commands, users) as defined on the `dev` branch. Use when asked to query a Taguette `.sqlite3` workspace, export or analyse highlights/tags, write scripts or SQL against it, add or change models/migrations, or reason about its invariants (tag inheritance, byte offsets, the command log).
---

# Taguette database

Source of truth: `taguette/database.py` (SQLAlchemy 1.x declarative models) on the `dev` branch.
Migrations: `taguette/migrations/versions/` (Alembic). Alembic head on `dev`: **`63d7ca28fc0c`**
(add `parent_id` to `tags`). No LLM/embedding feature adds tables: those helpers live in
`static/js/suggest.js` and `static/js/tags-ai.js`, not in the DB.

Full column-level reference: [reference.md](reference.md). Read-only inspector: `scripts/inspect_db.py`.

## Mental model

```
users ──< project_members >── projects ──< documents ──< highlights >──< highlight_tags >──< tags
                                  │                                                         │
                                  ├──< tags (project_id; tags.parent_id → tags.id, tree) ───┘
                                  └──< commands (event log; document_id is NOT a FK)
```

| Table | Key | Purpose |
|---|---|---|
| `users` | `login` (str, lowercase) | accounts; `hashed_password` is `pbkdf2:`/`bcrypt:` prefixed |
| `projects` | `id` | a workspace/study |
| `project_members` | (`project_id`, `user_login`) | `privileges` enum: READ=0, TAG=2, MANAGE_DOCS=3, ADMIN=1 |
| `documents` | `id` | `contents` is **HTML** (deferred column); `text_direction` LEFT_TO_RIGHT/RIGHT_TO_LEFT |
| `highlights` | `id` | `start_offset`/`end_offset` into the document text; `snippet` cached HTML |
| `tags` | `id` | `path` (label, ≤200, unique per project), `description`, `parent_id` (tree) |
| `highlight_tags` | (`highlight_id`, `tag_id`) | many-to-many link |
| `commands` | `id` | append-only event log of every change, JSON `payload` |
| `alembic_version` | — | single row, schema revision |

SQLite files carry `PRAGMA application_id = 0x54677474` ("Tgtt"; decimal 1416066164).

## Invariants you must not break

1. **Tag inheritance (materialized).** A highlight is linked in `highlight_tags` to a tag
   *iff* it is linked to that tag or any of its descendants. When tagging a highlight with tag T,
   also insert links for every ancestor of T. When removing/moving/deleting/merging tags, re-derive
   (see `_ancestor_chain`, `_expand_tags_with_ancestors`, `_update_inheritance_on_move` in `taguette/web/api.py`).
2. **Offsets are UTF-8 *byte* offsets over the document text, not counting HTML tags**
   (`taguette/extract.py`). They are not Python string indices and not offsets into `contents`.
   Never compute them with `str.find` on the HTML.
3. **`snippet` must match the offsets.** Regenerate with `taguette.extract.extract(document.contents, start, end)`
   whenever either offset changes. Never hand-write snippet HTML (it is later rendered; sanitize via `taguette.convert`/`validate`).
4. **Tags belong to one project.** A highlight's tags must have `tags.project_id == documents.project_id`.
   `(project_id, path)` is unique. Moving a tag under itself/its descendant is forbidden (no cycles).
5. **Foreign keys are OFF by default in raw SQLite.** Run `PRAGMA foreign_keys=ON` on every connection
   or `ON DELETE CASCADE` (documents→highlights→highlight_tags, tags→highlight_tags, projects→everything,
   tags.parent_id) will silently not fire. Deleting a tag with children: the app first re-parents the
   children to the deleted tag's parent (otherwise cascade deletes the subtree).
6. **`commands` is the audit/sync log.** The web app writes one `Command` per change and pushes it to
   connected browsers. `commands.document_id` is intentionally not a FK. Direct SQL writes bypass the log:
   fine for offline analysis/bulk import, but a running Taguette server won't see them live and
   exports/history will lack them. Prefer ORM `database.Command.<type>(...)` factories when mirroring app behaviour.
   Types: `project_meta, document_add, document_delete, document_edit, highlight_add, highlight_delete,
   tag_add, tag_delete, tag_merge, tag_move, member_add, member_remove, project_import`.
   (`highlight_edit` / boundary resizing and tag renames are **not** logged as separate types on `dev`;
   check `Command.TYPES` before assuming.)

## Interacting

### A. Quick, safe, read-only (any agent, no dependencies)

```bash
python SKILLS/taguette-database/scripts/inspect_db.py DB.sqlite3 summary        # revision, row counts, projects
python SKILLS/taguette-database/scripts/inspect_db.py DB.sqlite3 tags [PROJECT_ID]   # tag tree + highlight counts
python SKILLS/taguette-database/scripts/inspect_db.py DB.sqlite3 highlights --tag "Some tag" [--limit 20]
python SKILLS/taguette-database/scripts/inspect_db.py DB.sqlite3 sql "SELECT ..."    # SELECT-only
```
It opens the file with `mode=ro` and refuses non-SELECT SQL. Plain `sqlite3` works too; useful SQL:

```sql
-- tag tree with counts (highlights_count includes descendants by invariant 1)
WITH RECURSIVE t(id,path,parent_id,depth) AS (
  SELECT id,path,parent_id,0 FROM tags WHERE project_id=1 AND parent_id IS NULL
  UNION ALL SELECT c.id,c.path,c.parent_id,t.depth+1 FROM tags c JOIN t ON c.parent_id=t.id)
SELECT printf('%*s%s',depth*2,'',path) AS tag,
       (SELECT count(*) FROM highlight_tags WHERE tag_id=t.id) AS n FROM t;

-- highlights for a tag with document name (snippet is HTML)
SELECT d.name, h.id, h.start_offset, h.end_offset, h.snippet
FROM highlights h JOIN documents d ON d.id=h.document_id
JOIN highlight_tags ht ON ht.highlight_id=h.id JOIN tags t ON t.id=ht.tag_id
WHERE t.project_id=1 AND t.path='Some tag' ORDER BY d.id, h.start_offset;

-- change history
SELECT id,date,user_login,json_extract(payload,'$.type') FROM commands WHERE project_id=1 ORDER BY id DESC LIMIT 20;
```

### B. Through the ORM (when you need to write, or compute snippets)

Needs the project env (`uv sync` / `poetry install`; SQLAlchemy `~1`, **not 2.x**).

```python
from taguette import database, extract
Session = database.connect('sqlite:////abs/path/to/db.sqlite3')  # auto-migrates (backs up to .bak) if schema is old!
db = Session()
doc = db.query(database.Document).get(1)          # .contents is deferred; touching it loads the HTML
tag = db.query(database.Tag).filter_by(project_id=1, path='Some tag').one()
hl = database.Highlight(document=doc, start_offset=100, end_offset=180,
                        snippet=extract.extract(doc.contents, 100, 180))
db.add(hl); db.flush()
# link tag + ancestors (invariant 1)
ids = {tag.id}; p = tag.parent
while p: ids.add(p.id); p = p.parent
db.bulk_insert_mappings(database.HighlightTag, [dict(highlight_id=hl.id, tag_id=i) for i in sorted(ids)])
db.add(database.Command.highlight_add('<user_login>', doc, hl, sorted(ids)))
db.commit()
```
`database.connect()` **migrates in place** when the revision differs from head and enables FK pragmas. Use
`database.connect(url, external=True)` for untrusted files. Pass `Tag.highlights_count` / `Project.last_event`
as read-only computed `column_property` values.

### C. Via the HTTP API
Handlers in `taguette/web/api.py` (`HighlightAdd`, `HighlightUpdate`, tag add/update/delete/merge...) already
enforce invariants, privileges (`Privileges.can_*`) and log commands; use these when a server is running.

## Safety checklist before any write
- Copy the file first (`cp db.sqlite3 db.sqlite3.bak`); stop any running Taguette server on it.
- Confirm revision: `SELECT * FROM alembic_version;` equals the head above, else migrate via
  `taguette --database=PATH migrate` first (or let `database.connect` do it).
- Enable `PRAGMA foreign_keys=ON`; run in one transaction; verify invariants 1–4 afterwards
  (`inspect_db.py check` does this read-only).

## Changing the schema
1. Edit models in `taguette/database.py` (names follow the `meta` naming convention for ix/uq/ck/fk/pk).
2. `alembic revision -m "..."` into `taguette/migrations/versions/`, `down_revision = '63d7ca28fc0c'` (or the new head).
3. Update `copy_project` / `copy_table` in `database.py` (project import/export between DBs) and
   `OPTIONAL_COMMAND_FIELDS` if adding command payload fields.
4. Fresh DBs are built by `Base.metadata.create_all` then stamped to head, so models and migration must agree.
