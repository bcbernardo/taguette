# Graph Report - taguette  (2026-10-31)

## Corpus Check
- 75 files · ~208,415 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 45 file(s) not represented in the graph (top: .po 12, .ttf 5, (none) 4)

## Summary
- 785 nodes · 1685 edges · 42 communities (26 shown, 16 thin omitted)
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 100 edges (avg confidence: 0.88)
- Token cost: 40,000 input · 20,400 output

## Community Hubs (Navigation)
- Tests & Utility Modules
- Document Conversion
- Frontend JavaScript App
- Input Validation
- CI Pipeline
- jQuery Library
- Bootstrap Library
- JSON API Handlers
- Export Handlers
- DB Migrations (Integrity)
- Highlight Extraction
- API Endpoints & Auth
- Scripts & Migration Tooling
- Server Entry Point
- DB Migrations (Users)
- Command Sync Log
- Minified JS Helpers
- Web Handlers & Templates
- Live Sync & Metrics
- Paper & Figures
- Project Copy/Import
- Templates & Webfonts
- Docs & Project Meta
- More Minified JS
- Changelog & Features
- Project Page Handlers
- Prometheus Instrumentation
- Alembic Migration Env
- Long-Polling Events
- Permission Model
- Architecture Overview
- Localization
- Hosting & Terms
- JSON Column Type
- Project Import API
- Pseudo-Locale Testing
- DB Revision Script
- POT Update Script
- Translation Build Script
- Taguette Package Root
- Missing Image Placeholder

## God Nodes (most connected - your core abstractions)
1. `BaseHandler` - 69 edges
2. `no_sqlite_pragma_check()` - 25 edges
3. `api_auth()` - 20 edges
4. `Command` - 18 edges
5. `InvalidFormat` - 15 edges
6. `Application` - 15 edges
7. `_f()` - 15 edges
8. `TestMultiuser` - 15 edges
9. `Base Layout (base.html)` - 15 edges
10. `longPollForEvents()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `Screenshot: Document View` --semantically_similar_to--> `Project View (main workspace)`  [INFERRED] [semantically similar]
  01-document.png → taguette/templates/project.html
- `Screenshot: Highlights List for a Tag` --semantically_similar_to--> `Project View (main workspace)`  [INFERRED] [semantically similar]
  02-view-tag.png → taguette/templates/project.html
- `Screenshot: Collaborator Management` --semantically_similar_to--> `Manage Collaborators Modal (privileges)`  [INFERRED] [semantically similar]
  03-collabs.png → taguette/templates/project.html
- `Screenshot: Exported Document in LibreOffice` --semantically_similar_to--> `Document Export Template`  [INFERRED] [semantically similar]
  04-export.png → taguette/templates/export_document.html
- `Entity-Relationship Diagram (erd.svg)` --references--> `Command`  [INFERRED]
  erd.svg → taguette/database.py

## Import Cycles
- 3-file cycle: `taguette/database.py -> taguette/validate.py -> taguette/web/base.py -> taguette/database.py`

## Hyperedges (group relationships)
- **Live Collaboration Flow** — architecture_frontend, architecture_server, architecture_live_editing, taguette_database_command, paper_collaboration [INFERRED 0.85]
- **Document Ingestion Flow** — readme_supported_formats, architecture_conversion, taguette_convert, taguette_database_document [INFERRED 0.85]
- **Template Inheritance Hierarchy** — taguette_templates_base, taguette_templates_index_page, taguette_templates_welcome_page, taguette_templates_login_page, taguette_templates_project_view, taguette_templates_project_new_page, taguette_templates_project_delete_page, taguette_templates_project_import_page, taguette_templates_account_page, taguette_templates_cookies_prompt_page, taguette_templates_error_page, taguette_templates_tos_page [EXTRACTED 0.95]
- **Core Architecture Topology** — architecture_architecture_diagram, architecture_server, architecture_frontend, architecture_database, architecture_conversion [EXTRACTED 0.95]

## Communities (42 total, 16 thin omitted)

### Community 0 - "Tests & Utility Modules"
Cohesion: 0.05
Nodes (19): Entity-Relationship Diagram (erd.svg), Document, Highlight, HighlightTag, Project, ProjectMember, Tag, User (+11 more)

### Community 1 - "Document Conversion"
Cohesion: 0.05
Nodes (28): taguette.export scripting API, calibre_from_html(), calibre_to_html(), check_call(), ConversionError, get_html_body(), html_to(), html_to_html() (+20 more)

### Community 2 - "Frontend JavaScript App"
Cohesion: 0.08
Nodes (46): addDocument(), addMember(), addTag(), ApiError(), deleteURL(), describePos(), describeSelection(), editHighlight() (+38 more)

### Community 3 - "Input Validation"
Cohesion: 0.07
Nodes (19): document_name(), InvalidFormat, project_name(), tag_path(), user_email(), user_login(), user_password(), _f() (+11 more)

### Community 4 - "CI Pipeline"
Cohesion: 0.04
Nodes (48): paths, mariadb, image, script, services, stage, variables, postgres (+40 more)

### Community 5 - "jQuery Library"
Cohesion: 0.08
Nodes (21): a(), ae(), C(), ct(), et(), fe(), ft(), G() (+13 more)

### Community 6 - "Bootstrap Library"
Cohesion: 0.13
Nodes (30): Be(), bt(), ct(), dt(), e(), Fe(), ft(), Ge() (+22 more)

### Community 7 - "JSON API Handlers"
Cohesion: 0.09
Nodes (13): CheckUser, DocumentAdd, DocumentContents, DocumentUpdate, HighlightAdd, Highlights, HighlightUpdate, MembersUpdate (+5 more)

### Community 8 - "Export Handlers"
Cohesion: 0.10
Nodes (13): get_filename_for_highlights_export(), ExportCodebookCsv, ExportCodebookDoc, ExportCodebookXlsx, ExportCodebookXml, ExportDocument, ExportHighlightsCsv, ExportHighlightsDoc (+5 more)

### Community 9 - "DB Migrations (Integrity)"
Cohesion: 0.12
Nodes (15): no_sqlite_pragma_check(), downgrade(), upgrade(), downgrade(), upgrade(), downgrade(), upgrade(), downgrade() (+7 more)

### Community 10 - "Highlight Extraction"
Cohesion: 0.11
Nodes (9): Highlight Byte Offsets, byte_to_str_index(), delete_left(), delete_right(), extract(), find_pos(), highlight(), split_utf8() (+1 more)

### Community 12 - "Scripts & Migration Tooling"
Cohesion: 0.12
Nodes (3): main(), connect(), set_sqlite_pragma()

### Community 13 - "Server Entry Point"
Cohesion: 0.14
Nodes (6): migrate(), default_config(), main(), prepare_db(), make_app(), set_dumb_password()

### Community 14 - "DB Migrations (Users)"
Cohesion: 0.16
Nodes (8): downgrade(), downgrade(), upgrade(), downgrade(), upgrade(), _do_map(), downgrade(), upgrade()

### Community 16 - "Minified JS Helpers"
Cohesion: 0.15
Nodes (17): a(), c(), i(), l(), n(), r(), be(), Ee() (+9 more)

### Community 17 - "Web Handlers & Templates"
Cohesion: 0.15
Nodes (4): Error404, MessagesJs, RedirectAccount, TranslationJs

### Community 19 - "Paper & Figures"
Cohesion: 0.20
Nodes (12): Screenshot: Document View, Screenshot: Highlights List for a Tag, Screenshot: Collaborator Management, Screenshot: Exported Document in LibreOffice, Zenodo Citation (10.5281/zenodo.5075766), Real-Time Collaboration (unique among FOSS CAQDAS), Taguette JOSS Paper, Related Open-Source CAQDAS Tools (QualCoder, qcoder, qdap) (+4 more)

### Community 20 - "Project Copy/Import"
Cohesion: 0.18
Nodes (5): copy_project(), copy(), transform_command(), copy_table(), DefaultMap

### Community 21 - "Templates & Webfonts"
Cohesion: 0.20
Nodes (11): Bad Script OFL License, Font Awesome 5 Brands (SVG glyphs), Font Awesome 5 Free Regular (SVG glyphs), Font Awesome 5 Free Solid (SVG glyphs), Montserrat OFL License, Base Layout (base.html), Index Page (project list), Login/Register Page (+3 more)

### Community 22 - "Docs & Project Meta"
Cohesion: 0.18
Nodes (9): Document Conversion Pipeline, Contributor Covenant v1.4, GitLab Fork & MR Workflow, BSD 3-Clause License, CAQDAS (Qualitative Data Analysis Software), Getting Started Workflow, Installation (installers/pip/Docker/Poetry), Supported Import Formats (+1 more)

### Community 23 - "More Minified JS"
Cohesion: 0.25
Nodes (11): s(), ce(), Ie(), le(), m(), me(), N(), Re() (+3 more)

### Community 24 - "Changelog & Features"
Cohesion: 0.20
Nodes (10): CHANGELOG.md (0.1–0.11), Codebook & Highlights Export Formats, MariaDB Support, Password Recovery, Project Import/Export as SQLite3, Tag Merging, Export Options (codebook/highlights/project), robots.txt (SEO) (+2 more)

### Community 28 - "Alembic Migration Env"
Cohesion: 0.29
Nodes (3): Alembic Migrations, run_migrations_offline(), run_migrations_online()

### Community 31 - "Architecture Overview"
Cohesion: 0.73
Nodes (6): ARCHITECTURE.md — System Overview, Architecture Diagram (graphviz SVG), Database Layer (SQLite/PostgreSQL/MariaDB), Frontend (Jinja templates + taguette.js), Live Editing (Long-Polling Sync), Server Layer (Tornado + SQLAlchemy + Jinja)

### Community 32 - "Localization"
Cohesion: 0.40
Nodes (4): Localization (main + javascript catalogs), Translation Guide (po/README.md), FR Terminology Standard Mapping, Account Settings Page

### Community 33 - "Hosting & Terms"
Cohesion: 0.40
Nodes (5): app.taguette.org Hosted Service, Cookie Consent Page, Terms of Service Page, Example Terms of Service (tos.html), Third-Party Service Dependencies (OVH, SendGrid, Sentry, AWS)

## Knowledge Gaps
- **18 isolated node(s):** `taguette`, `Highlight Byte Offsets`, `MariaDB Support`, `Password Recovery`, `taguette.export scripting API` (+13 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 238 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Project View (main workspace)` connect `Paper & Figures` to `Localization`, `Frontend JavaScript App`, `Scripts & Migration Tooling`, `Templates & Webfonts`, `Docs & Project Meta`, `Changelog & Features`?**
  _High betweenness centrality (0.146) - this node is a cross-community bridge._
- **What connects `taguette`, `Highlight Byte Offsets`, `MariaDB Support` to the rest of the system?**
  _18 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Tests & Utility Modules` be split into smaller, more focused modules?**
  _Cohesion score 0.05352112676056338 - nodes in this community are weakly interconnected._
- **Why does `BaseHandler` connect `JSON API Handlers` to `Project Import API`, `Input Validation`, `Export Handlers`, `API Endpoints & Auth`, `Web Handlers & Templates`, `Server Base & Auth`, `Project Page Handlers`, `Long-Polling Events`?**
  _High betweenness centrality (0.077) - this node is a cross-community bridge._
- **Should `Document Conversion` be split into smaller, more focused modules?**
  _Cohesion score 0.05432692307692308 - nodes in this community are weakly interconnected._
- **Why does `Base Layout (base.html)` connect `Templates & Webfonts` to `Localization`, `Hosting & Terms`, `Paper & Figures`, `Docs & Project Meta`, `Changelog & Features`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Should `Frontend JavaScript App` be split into smaller, more focused modules?**
  _Cohesion score 0.08020050125313283 - nodes in this community are weakly interconnected._