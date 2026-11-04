# Taguette schema reference (dev, Alembic head `63d7ca28fc0c`)

Constraint names follow: `ix_<col>`, `uq_<table>_<col>`, `fk_<table>_<col>_<ref>`, `pk_<table>`.
Tables marked AI use `sqlite_autoincrement` (ids never reused).

## users
| column | type | notes |
|---|---|---|
| login | VARCHAR(30) PK | lowercased (migration `bce44849c2f2`) |
| created | DATETIME NOT NULL | UTC |
| hashed_password | VARCHAR(192) NULL | `pbkdf2:<salt>$<iters>$<hash>` or `bcrypt:...` |
| disabled | BOOLEAN NOT NULL | |
| password_set_date | DATETIME NULL | |
| language | VARCHAR(10) NULL | |
| email | VARCHAR(256) NULL, unique, indexed | |
| email_sent | DATETIME NULL | |

## projects (AI)
`id` PK, `name` VARCHAR(200), `description` TEXT, `created` DATETIME.
Computed (not a column): `Project.last_event` = max `commands.id` for the project.
Relationships cascade `all,delete-orphan` to commands, documents, tags.

## project_members
PK (`project_id` → projects.id CASCADE, `user_login` → users.login CASCADE/UPDATE CASCADE),
`privileges` ENUM(Privileges) stored **by name**: `READ`, `TAG`, `MANAGE_DOCS`, `ADMIN`.

| privilege | edit project/members/delete project | add/edit/delete documents | tags & highlights |
|---|---|---|---|
| ADMIN | yes | yes | yes |
| MANAGE_DOCS | no | yes | yes |
| TAG | no | no | yes |
| READ | no | no | no |

## documents (AI)
`id` PK, `name` VARCHAR(200), `description` TEXT, `filename` VARCHAR(200) NOT NULL, `created`,
`project_id` FK CASCADE indexed, `text_direction` ENUM by name (`LEFT_TO_RIGHT`/`RIGHT_TO_LEFT`),
`contents` TEXT NOT NULL (HTML, deferred in ORM — select it explicitly in SQL when needed).
Document names are limited to 50 chars by `validate.py` even though the column is 200.

## highlights (AI)
`id` PK, `document_id` FK CASCADE indexed, `start_offset` INT, `end_offset` INT (UTF-8 byte offsets
over text, HTML tags not counted; end exclusive), `snippet` TEXT (HTML fragment of the highlighted span).
Editing a document (`extract.edit`) remaps/deletes highlights; the command `document_edit` records `deleted_highlights`.

## tags (AI)
`id` PK, `project_id` FK CASCADE indexed, `path` VARCHAR(200) NOT NULL indexed, `description` TEXT NOT NULL,
`parent_id` FK → tags.id CASCADE, NULL = root, indexed. `UNIQUE(project_id, path)`.
Hierarchy comes from `parent_id`; `path` is just the unique label (older data used dotted paths like `a.b`
and the UI may still display them as-is). Computed: `Tag.highlights_count`.

## highlight_tags
PK (`highlight_id` → highlights.id CASCADE, `tag_id` → tags.id CASCADE). Includes ancestor tags (inheritance invariant).

## commands (AI)
`id` PK, `date` DATETIME indexed, `user_login` FK → users.login (UPDATE CASCADE, **no** delete cascade),
`project_id` FK CASCADE, `document_id` INT NULL **(not a FK)**, `payload` JSON stored as TEXT
(`json.dumps(sort_keys=True)`; use `json_extract(payload,'$.field')` in SQLite). Indexes: (`project_id`,`document_id`), (`project_id`,`id`).

Payloads (`type` plus):
| type | fields |
|---|---|
| project_meta | project_name, description |
| document_add | document_name, description |
| document_edit | document_name, deleted_highlights |
| document_delete | — |
| highlight_add | highlight_id, start_offset, end_offset, tags (list of tag ids) |
| highlight_delete | highlight_id |
| tag_add | tag_id, tag_path, description, parent_id (optional in old rows) |
| tag_delete | tag_id |
| tag_move | tag_id, parent_id |
| tag_merge | src_tag_id, dest_tag_id |
| member_add | member, privileges (name) |
| member_remove | member |
| project_import | — |

## alembic_version
One row, `version_num`. History (oldest → head):
`e4e090a5b511` → `dd37d9027a24` unique tags → `679f625e6e6a` fix unique tags → `80b1cc9d4c22` user email →
`447d636f72c5` cascades → `bce44849c2f2` lowercase logins → `91ade71ccf4d` user language →
`b23f3b7a638e` password date → `807c0cc0ecf6` remove invalid hltags → `ecb4065de575` no server_default now →
`bc8e0e0677e9` rename command fields → `43d6c240309d` remove document groups → `d86c45d7aa8a` document direction →
`491de2dc7cd7` indexes → `e4cf92942271` index → `09c662cd9483` filename not null → `6489b5f9cfb5` password hash size →
`382db36f20f4` user disabled → `db5e31a0233d` remove blank highlights → **`63d7ca28fc0c` tags.parent_id (head)**.

## Where logic lives
| Concern | File |
|---|---|
| models, `connect()`, migration, project copy | `taguette/database.py` |
| offsets ↔ HTML, snippets, doc edits | `taguette/extract.py` |
| input validation | `taguette/validate.py` |
| REST handlers, tag-tree helpers | `taguette/web/api.py` |
| exports (CSV/XLSX/DOCX/QDPX) reading highlights | `taguette/export.py`, `taguette/web/export.py` |
| DB path/URL handling, CLI (`--database`, `migrate`) | `taguette/main.py` |
