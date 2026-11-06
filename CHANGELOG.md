Changelog
=========

Unreleased
----------

Usability (Highlights panel):
* Tag definitions longer than 200 characters are now capped in the
  left panel, with a "(show more)" note at the end of the capped text
  to reveal the full definition ("(show less)" collapses it back);
  while capped, the definition's edit pencil is hidden
* The *Create a tag* button moved from the top of the Highlights panel
  to a small square "+" button floating at the bottom right corner of
  the panel: it stays in place while the tag list scrolls and hides
  while the bulk action bar is shown (it also disappears with the
  panel's other tabs, as it lives inside the Highlights tab)
* The search bar is now hidden by default; a matching square
  magnifying-glass button floats to the left of the "+" one and opens
  it (the bar already sticks to the top of the tag list while the list
  scrolls). The cross button closes the search again when the field is
  already empty, bringing the floating button back; both floating
  buttons hide while the bulk action bar is shown

New feature (tag multiselect and bulk organization):
* Tags in the Highlights panel can be checked for bulk actions; a bar
  pinned to the bottom of the left panel — always visible without
  scrolling — appears with the selection count and three buttons:
  *Merge*,
  *Move to* and *Group*. Merge opens the existing merge dialog for
  several tags at once (the API accepts a list of sources and applies
  the merges in one transaction, deepest tags first); Move to re-parents
  every selected tag under a chosen tag or the root; Group opens a new
  *Create new umbrella tag* dialog
* The merge dialog's destination list gains a pinned *Create new
  unified tag* action (kept visible while filtering, reachable with the
  keyboard): it opens a variant of the tag form that creates the tag
  and merges the sources into it. The Group dialog is the same variant
  in umbrella mode: it creates the tag and re-parents the selected tags
  under it
* The umbrella/unified dialog shows the tags to be grouped (or
  unified) as highlighted chips with a cross mark to de-select them,
  and *Other suggested tags* below — ranked by semantic similarity to
  the typed name/description like the tag form's similar tags, and
  clickable to promote them into the selection
* Its AI helpers generate the new tag's title (automatically, on open)
  and description (button) from the member tags and their definitions,
  plus sample highlights from all members for a unified tag; the two
  new prompt templates are configurable in ⚙ Settings → AI tags like
  the others

New feature (highlight editing):
* Clicking a highlight in the document view now shows blinking
  brackets at its boundaries, which can be dragged to change the
  highlight's start or end without touching its tags; a menu shown with
  the brackets (or a double-click on the highlight) still opens the tag
  form, and the highlight's snippet shown in tag views and exports now
  follows resizes too

New feature (tag AI helpers):
* The highlight form now suggests the most appropriate tags: the top 10,
  ranked for the highlighted text (semantic ranking when an embedding
  service is configured, lexical otherwise), with a *Show all tags*
  toggle and a search bar that mimics the Highlights panel's (lexical +
  semantic). Tag selections live outside the DOM, so they survive the
  ranked/search re-renders (searching or clearing the search no longer
  drops them), and checked tags stay visible — appended after the
  suggestions — so they can still be unchecked; hidden checkboxes keep
  a highlight's existing tags on save
* Creating a tag from the highlight form asks the configured LLM for
  three tag names (grounded in the highlighted text and the existing
  tags); the suggestions sit one per line, blue like tag links, and
  fill the name field with one click, ready for manual edits — at which
  point they are replaced by a *Re-generate title with AI* link. The
  answer parser tolerates preambles, numbering, markdown and per-name
  explanations; when the model returns nothing there is a *try again*
  link, and the raw model answer is logged to the browser console for
  troubleshooting. Reasoning models that spend their whole token
  budget thinking (empty answer) are handled: the answer is retried
  with 4× the budget, and answers that arrive in the reasoning field
  instead of the content field are read too
* *Generate description with AI* writes a tag definition from the tag
  name and the highlighted text (new tags) or from all the tag's
  highlights (existing tags); the suggestion is previewed with
  *Accept / Try again / Discard*. With an existing description the button
  becomes *Re-generate description with AI*, joined by *Augment
  description with AI*: *Add examples*, *Add "includes"* and *Add "Do not
  confound with"* (the latter fed with cosine-similar non-ancestor tags so
  the model can contrast the themes)
* The tag form lists the most cosine-similar tags below the description;
  clicking one opens a menu: *Set as parent*, *Set as descendant*
  (applied when the new tag is saved), and — while creating a tag —
  *Use this tag instead*, which drops the new tag and checks the
  existing one in the highlight form (no near-duplicates); while
  editing, the third option is *Merge with this tag*
* New *AI tags* tab in the configuration screen: pick the chat model
  (one of your API keys, a local Ollama/llama.cpp server, or a custom
  endpoint), set the temperature, and edit the five prompt templates
  (with placeholders and reset-to-default). Everything stays in your
  browser; model calls go straight from the browser to the service
* The number of suggested tags in the highlight form is configurable
  (*Embeddings* tab of the configuration screen)
* The tag's Highlights view offers the same actions below the
  definition: *Generate/Re-generate description with AI* and the
  *Augment* menu; accepting a suggestion saves it immediately
* The tag form now places the *Parent tag* picker below the description
  field, next to the similar-tags list

New feature (speaker segmentation):
* The suggested-highlights tool now labels WHO speaks in each turn of a
  transcript, for any number of speakers, replacing the binary
  interviewer/interviewee ("Q / A") classification: a chat model (the new
  *Segmentation* tab of the configuration screen — any OpenAI-compatible
  endpoint, or a local Ollama/llama.cpp server) receives a few random
  excerpts of the document and proposes, in a single call, the speakers it
  recognizes as label patterns; the patterns are validated (regex safety
  checks, grounding in real turns) and reviewed by the user before
  anything is applied
* The *Speakers* review dialog lists the proposed speakers with name,
  color, editable patterns, live match counts and real examples; speakers
  can be renamed, recolored, merged, removed and added, turns with no
  speaker stay visible, and *Confirm* applies the rules deterministically
  to every turn (the first matching speaker wins)
* Every turn is outlined in the speaker's color with a clickable name
  badge; clicking it re-assigns that turn by hand, and manual assignments
  survive re-proposals and transcript edits. The confirmed speaker profile
  is stored in the browser per document and re-applies for free (no model
  call) when the document is reopened
* A speaker turn spans every paragraph from its label to the next
  speaker/timestamp prefix (or the next inline label like "John: …"), so
  continuation paragraphs are labelled with their speaker instead of
  becoming separate unlabelled turns; text before the first label stays
  standalone
* The suggestion filter now chooses which speakers are included (one
  checkbox per speaker) instead of the old answers-only switch; turns with
  no speaker stay included

New feature (configuration screen):
* New dedicated configuration screen (⚙ *Configure* in the document toolbar)
  with a tabbed, extensible layout: any feature can register a tab, and the
  per-feature settings modals were folded into it
* *API keys* tab: store one key per provider — Anthropic, DeepSeek, Gemini,
  MiniMax, OpenAI, OpenRouter, Qwen, Z.ai, or custom providers with their own
  base URL and header format (Authorization: Bearer by default, x-api-key
  and x-goog-api-key supported)
* *Embeddings*, *Segmentation* and the other feature tabs (ported from the
  suggested-highlights feature): pick a service per task — one of the saved
  keys, a supported local service (Ollama and llama.cpp for chat or
  embeddings, text-embeddings-inference), or a custom endpoint — plus model
  and endpoint override; selecting a local service checks whether it is
  running and shows install instructions when it is not. A *Test
  connection* button validates the setup
* The suggest toolbar's *Embeddings* button opens the configuration screen
  on its tab; the *Speakers* button opens the speaker review dialog during
  a suggestion session, or the *Segmentation* model settings otherwise

New feature (tag hierarchy):
* Tags can be nested: drag a tag onto another in the Highlights panel (top
  or bottom of the row) to make it a child, after a confirmation; dropping
  it in the middle of the row offers a merge instead (cancellable by
  closing the popup). Holding a dragged tag near the top or bottom of the
  panel auto-scrolls the tag list, so far-apart tags can be nested
* The tag form has a "parent tag" search bar: pick a parent to create a
  nested tag, leave it empty for a root-level tag
* Nested tags are shown as a tree in the Highlights panel and in the
  highlight form; the collapse arrow hides both a tag's definition and its
  child tags
* Parents inherit the highlights of their child tags: highlighting a nested
  tag adds the highlight to its parents, and re-parenting a tag gives the
  new parent all the highlights of the moved subtree
* Tag moves (drag & drop, or parent change in the tag form) can be undone
  with Ctrl+Z

Bugfixes (highlight form):
* Fix tags being dropped from a highlight when a new tag was created while
  editing it (the tag checkboxes were re-rendered, losing the checked ones)
* A tag created from within the highlight form is now automatically selected
  for the current highlight

Enhancements (Highlights panel):
* The left panel now scrolls when its contents are taller than the window
* Tag names in the list wrap at whitespace instead of mid-word
* Each tag in the list has a collapsible box showing its definition
* New search bar above the tags list: searches tag names and definitions, and
  performs a semantic search too when an embedding endpoint is configured
  (tag embeddings are cached locally in the browser; immediate-run and
  clear buttons next to the field; only clearly similar tags are returned,
  via an adaptive similarity cutoff)
* ✎ buttons next to tag names and definitions for quick edits
* Clicking a tag name or its highlight count shows the tag name as a title and
  its definition above the highlights on the right, both editable in place

0.11 (2021-07-06)
-----------------

Bugfixes:
* Fix timezone issues on some SQL backends (PostgreSQL, not SQLite). Could cause recorded times to be wrong, and in some cases password reset links could be used multiple times
* Fix the activity detection used to pause/resume polling
* Fix default-config command outputing logs about umask, which could be piped into the new config file (for example when using Docker with `-t`)
* Fix migrations on SQLite failing because of foreign key constraints when recreating tables
* Fix RTF export
* Fix retrying Calibre conversion with --enable-heuristics again
* Fix Calibre leaving behind temporary files if it times out

Enhancements:
* Show more details when document export or import fails
* Show the number of highlights per tag in exported codebooks
* Performance improvement of getting a document or tag with many highlights
* Add terms of service, which you can optionally set in your own instance
* Made document/highlights/codebook exporting functions available under `taguette.export`, for use in scripts and notebooks
* Improve button placement in the left panel (put "add a document" and "create a tag" at the top)
* Add an HTML page for 404 errors
* Improve error message when Calibre is not found
* Add support for MariaDB (MySQL doesn't work because of error 1093, see https://stackoverflow.com/q/4429319)
* Add option to import or export a project as a SQLite3 database
* Allow a user to remove themselves from a project, without having to ask an admin

0.10.1 (2021-02-22)
-------------------

Bugfixes:
* Limit the number of page buttons
* SQL query performance improvements
* Force long document names to wrap (like long tag names)

0.10 (2021-02-17)
-----------------

Bugfixes:
* Check that tags exist in the project before adding them to highlights

Enhancements:
* SEO: Add page titles, robots.txt
* Remind user of their login in the password reset email
* Pause polling for changes when the window has been inactive for 10 minutes
* Improve the error message shown when document import fails
* Add pagination to the highlights view, which greatly improve performances for heavily used tags
* Update to Tornado 6.1, remove workaround for older versions

0.9.2 (2020-08-26)
------------------

Bugfixes:
* Fix document conversion on Windows

Enhancements:
* Show spinner while loading document or tag view
* Show the tag names next to each highlight in document export

0.9.1 (2020-08-24)
------------------

Bugfixes:
* Fix printed link not being flushed, causing it to be inaccessible e.g. running on Docker
* Fix incompatibility with Python 3.8
* Close DB connection during long polls, avoiding overflow of connection pool when using PostgreSQL
* Don't allow a password reset link to be used more than once
* Fix 'new highlight' button on Microsoft Edge
* If Calibre fails, run it again without heuristics
* Fix highlights being off in document export in non-ASCII paragraphs

Enhancements:
* Set umask to 077 by default (and add corresponding command-line options)
* Restore Python 3.5 compatibility
* Add a timeout to document conversion
* Add Calibre output limits to the config
* Fix some important messages being routed through log instead of direct to terminal

0.9 (2019-11-23)
----------------

Bugfixes:
* Fix showing highlights for a tag with a slash in it
* Fix new tags showing NaN highlight count
* Fix export button being on top of text, if the first line is long
* Fix tag names containing '#' not working properly
* Fix "new highlight" button showing at the top of the page when scrolling on Safari
* Sort highlights in the exported highlights view as well
* Fix merging tags that have common highlights (previous 500 error)

Features:
* Export codebook to Excel (.xlsx)
* Show error details in alert messages (in English)
* Highlight the currently selected tag(s) in the left panel
* Don't show 403 if user can't change collaborators: show explanation, hide button
* Add export of highlights to CSV and Excel (.xlsx) formats
* Support PBKDF2 passwords (Taguette no longer requires 'bcrypt')

0.8 (2019-06-15)
----------------

Bugfixes:
* Don't show 500 error on invalid email reset token
* Explicitly close DB connections, which might help with some warnings
* Don't show 'merge' button in modal when creating a new tag
* Fix getting logged out in single-user mode with `--debug`
* Don't scroll to the top of the document when clicking on a disabled link
* Fix taguette --database=filename not working when filename does not contain directories

Features:
* Add limits on converted file size
* Don't have Calibre export image files from PDF, since we don't read them
* Add a scrollbar to modals, since they can grow big in projects with many tags
* Use the file name as document name if left blank
* Show cookie warning before setting any (optional in configuration)
* Add the REFI-QDA Codebook (.qdc) export format
* Improve the collaborator management modal
* Show the number of highlights which each tag in the "highlights" panel

0.7 (2019-05-15)
----------------

Taguette can now be translated! You can help bring Taguette to your language on [Transifex](http://transifex.com/remram44/taguette/).

Bugfixes:
* Fix exporting highlights for non-ASCII tags
* Fix account page not accepting empty optional fields
* Fix document description being validated as its name
* Fix importing documents with completely non-ASCII filenames

Features:
* Merge tags
* Added internationalization
* French translation
* German translation
* Spanish translation
* Show tag names when hovering a highlight

0.6 (2019-04-13)
----------------

Bugfixes:
* Make 'display' headings responsive
* Fix exported highlights being called "path"
* Fix possible weird characters in exported documents on Windows (depending on locale)

Features:
* Convert logins to lower-case (login and collaborator forms will convert too, so it should only affect display). Users with non-lowercase logins will be logged out on update
* Moved the `SECRET_KEY` to the config, no longer writing to `~/.cache`
* Let you know when you have been logged out or removed from a project while working

0.5 (2019-03-23)
----------------

Bugfixes:
* Improve reading of OPF output from Calibre, which might fix compatibility with some combinations of Calibre versions and input formats
* Long tag names no longer stick out of the left pane
* Sort tags in highlight modal, documents in left pane, highlights and their tags in the highlights view

Features:
* Use a configuration file in server mode, rather than a growing list of command-line options
* Expose metrics to Prometheus
* Send errors to Sentry
* Add 'delete project' button
* Add account management page, to update email/password
* Add password recovery feature (if you have an email set)
* "New highlight" button shows up next to selected text rather than mouse, making it work with touch screens (mobile) and screen readers (hopefully)
* Convert old .DOC files (Word 97) using WV if available
* Add collaborator management modal, to add more members to a project
* Changed default port number from `8000` to `7465`
* Add spinning icon while requests are in progress, to prevent multiple submission of forms (document add takes ~10s for example)

0.4.4 (2018-11-29)
------------------

Bugfixes:
* Fix error creating a highlight when a paragraph is selected to the end
* Correctly handle Calibre sometimes writing a `.xhtml` file instead of `.html`
* Also show highlights with no tags when selecting "See all highlights"

0.4.3 (2018-11-17)
------------------

Bugfixes:
* Fix JavaScript error on a brand new project (no recorded Command)
* Fix Commands being sent to the wrong project

Features:
* Add `--xheaders` option for the hosted setup, showing correct IPs in the log
* Show which document in the list is the current one

0.4.2 (2018-11-15)
------------------

Bugfixes:
* Don't show highlights from a different document
* Handle non-ascii text better
* Fix real-time updates pausing if two changes happen in the same second
* Add messages boxes to signal when something goes wrong
* Sanitize name of uploaded files

0.4.1 (2018-11-12)
------------------

Bugfixes:
* Log errors from async handlers to the console instead of hiding them
* Work around a problem computing highlight positions in documents when unicode is present (won't crash anymore, but positions might still be off, fix to come)
* Fix not being able to create tags with names that collide with tags in other projects, and error creating a project if another project still uses default tags
* Fix exporting a document that has 0 highlights
* Fix document export missing highlights
* Fix navbar expand button (shown on smaller screen sizes) not working

0.4 (2018-11-11)
----------------

Bugfixes:
* Make sure to hide auth token from URL bar
* Fix tag description not showing up
* Don't allow two tags to have the same name

Features:
* Add confirmation dialogs before deleting tags or documents
* Create tag from the highlight window
* New theme matching website (thanks to Vicky Steeves)
* Add button to create a tag from the highlight modal
* Show messages from taguette.fr, such as new version available
* Add export options, allowing you to get your highlights or highlighted documents as HTML, DOCX, or PDF
* Add HTML and PDF options for codebook export as well
* Add an option to show (or export) all highlights, rather than only a specific tag

0.3 (2018-10-29)
----------------

Bugfixes:
* Fix having to reload for changes to appear when working on project other than 1.
* Fix tags not being sorted by name

Features:
* Add 'backlight' mode, fading non-tagged text
* Add modal dialog to edit and delete documents
* Add migration system, to automatically upgrade the database to new schema version when required

0.2 (2018-10-21)
----------------

Bugfixes:
* Accept list and numbered lists, as generated from Markdown documents
* Fix tag modal not able to add tags after a tag has been edited

Features:
* Add single-user mode, the default. Multi-user mode now needs `--multiuser`
* Add login and registration pages
* Add codebook export to CSV and DOCX files (contains list of tags with their descriptions)

0.1 (2018-10-21)
----------------

First version, proof of concept. Not very useful, but showcases the app, and can be installed by alpha testers.

* Can create projects
* Can import documents into the database as HTML
* Uses Calibre to convert supported documents into HTML
* Can highlight parts of documents, and assign tags
* Real-time notifications and collaboration
* "Acceptable" UI with bootstrap
