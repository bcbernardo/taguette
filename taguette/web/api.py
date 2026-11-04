import asyncio
import functools
import json
import logging
import math
import prometheus_client
from bs4 import BeautifulSoup
from difflib import SequenceMatcher
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import aliased, defer, joinedload
import tempfile
from tornado.concurrent import Future
import tornado.log
from tornado.web import MissingArgumentError, HTTPError

from .. import convert
from .. import database
from .. import extract
from .. import validate
from .base import BaseHandler, PromMeasureRequest


logger = logging.getLogger(__name__)


PROM_POLLING_CLIENTS = prometheus_client.Gauge(
    'polling_clients',
    "Number of current polling clients",
)

PROM_REQUESTS = PromMeasureRequest(
    count=prometheus_client.Counter(
        'api_total',
        "API requests",
        ['name'],
    ),
    time=prometheus_client.Histogram(
        'api_seconds',
        "API request time",
        ['name'],
    ),
)


def api_auth(method):
    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        if not self.current_user:
            return self.send_error_json(403, "Not logged in")
        return method(self, *args, **kwargs)

    return wrapper


"""
Tag tree helpers

Tags can be nested through `tags.parent_id`. Parents inherit the
highlights of their descendants: this is materialized as regular rows in
the `highlight_tags` table, so that queries (counts, tag views, exports)
keep working unchanged. The invariant is:

    a highlight is linked to a tag iff it is linked to the tag itself or
    to one of its descendants

The helpers below maintain that invariant when highlights or tags change.
"""


def _ancestor_chain(db, tag_id):
    """Return the ids of a tag's ancestors, closest first (empty at root).
    """
    chain = []
    seen = {tag_id}
    current = tag_id
    while current is not None:
        current = db.query(database.Tag.parent_id).filter(
            database.Tag.id == current,
        ).scalar()
        if current is None or current in seen:
            break  # Root reached (or corrupt cycle, don't loop forever)
        chain.append(current)
        seen.add(current)
    return chain


def _is_descendant(db, candidate_id, tag_id):
    """Whether `candidate_id` is a strict descendant of `tag_id`."""
    return candidate_id != tag_id \
        and candidate_id in _subtree_tag_ids(db, tag_id)


def _subtree_tag_ids(db, tag_id):
    """Return the ids of `tag_id` and all of its descendants."""
    ids = []
    frontier = [tag_id]
    seen = set()
    while frontier:
        current = frontier.pop()
        if current in seen:
            continue
        seen.add(current)
        ids.append(current)
        frontier.extend(
            row[0] for row in
            db.query(database.Tag.id)
            .filter(database.Tag.parent_id == current)
        )
    return ids


def _tag_highlight_ids(db, tag_id):
    """Return the set of highlight ids linked to a tag."""
    return set(
        row[0] for row in
        db.query(database.HighlightTag.highlight_id)
        .filter(database.HighlightTag.tag_id == tag_id)
    )


def _expand_tags_with_ancestors(db, tags):
    """Return the given tags plus all of their ancestors.

    Highlights added to a tag must also be linked to the tag's parents,
    so that parents inherit their children's highlights.
    """
    ids = set(tag.id for tag in tags)
    frontier = list(tags)
    while frontier:
        tag = frontier.pop()
        if tag.parent_id is None:
            continue
        parent = db.query(database.Tag).get(tag.parent_id)
        if parent is not None and parent.id not in ids:
            ids.add(parent.id)
            frontier.append(parent)
    return ids


def _merge_count_changes(changes, new_changes):
    """Add tag count changes together (a tag can gain and lose links)."""
    for tag_id, delta in new_changes.items():
        changes[tag_id] = changes.get(tag_id, 0) + delta
    return changes


def _inherit_highlights_upwards(db, tag_id, highlight_ids):
    """Link `highlight_ids` to `tag_id` and its ancestors where missing.

    Returns the number of links added per tag (tag count changes).
    """
    changes = {}
    frontier = [tag_id]
    seen = set()
    while frontier:
        current = frontier.pop()
        if current in seen:
            continue
        seen.add(current)
        to_add = set(highlight_ids) - _tag_highlight_ids(db, current)
        if to_add:
            db.bulk_insert_mappings(database.HighlightTag, [
                dict(highlight_id=hl_id, tag_id=current)
                for hl_id in sorted(to_add)
            ])
            changes[current] = changes.get(current, 0) + len(to_add)
        # Ancestors further up might still lack the highlight even though
        # a deeper tag just got it, so the whole chain is walked
        frontier.extend(_ancestor_chain(db, current))
    return changes


def _prune_implied_links(db, ancestor_ids, involved_highlights):
    """Drop highlight-tag links that a moving/deleting subtree justified.

    A link on an ancestor is "implied" while one of the ancestor's
    children also has that highlight. When a subtree moves away (or a tag
    is deleted), implied links whose highlight came from that subtree and
    that no child justifies anymore must go.

    `ancestor_ids` must be ordered closest to the moved tag first, so that
    pruning a deep ancestor is taken into account for the ones above it.
    Returns the number of links removed per tag.
    """
    changes = {}
    for ancestor_id in ancestor_ids:
        child_ids = [
            row[0] for row in
            db.query(database.Tag.id)
            .filter(database.Tag.parent_id == ancestor_id)
        ]
        justified = set()
        if child_ids:
            justified = set(
                row[0] for row in
                db.query(database.HighlightTag.highlight_id)
                .filter(database.HighlightTag.tag_id.in_(child_ids))
            )
        lost = (
            (involved_highlights & _tag_highlight_ids(db, ancestor_id))
            - justified
        )
        if lost:
            (
                db.query(database.HighlightTag)
                .filter(database.HighlightTag.tag_id == ancestor_id)
                .filter(
                    database.HighlightTag.highlight_id.in_(lost),
                )
                .delete(synchronize_session=False)
            )
            changes[ancestor_id] = changes.get(ancestor_id, 0) - len(lost)
    return changes


def _update_inheritance_on_move(db, tag, old_parent_id, new_parent_id):
    """Keep highlight inheritance consistent after `tag` is re-parented.

    Ancestors of the new location gain the moved subtree's highlights;
    ancestors of the old location lose the links that only the moved
    subtree justified. Returns tag count changes to broadcast.
    """
    subtree_ids = _subtree_tag_ids(db, tag.id)
    subtree_highlights = set(
        row[0] for row in
        db.query(database.HighlightTag.highlight_id)
        .filter(database.HighlightTag.tag_id.in_(subtree_ids))
    )

    changes = {}
    if new_parent_id is not None:
        _merge_count_changes(changes, _inherit_highlights_upwards(
            db, new_parent_id, subtree_highlights,
        ))
    if old_parent_id is not None:
        # The old parent itself and its ancestors, closest first
        old_chain = [old_parent_id] + _ancestor_chain(db, old_parent_id)
        _merge_count_changes(changes, _prune_implied_links(
            db, old_chain, subtree_highlights,
        ))
    return changes


class CheckUser(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('check_user')
    def post(self):
        if not self.application.config['MULTIUSER']:
            raise HTTPError(404)
        login = self.get_json()['login']
        try:
            login = validate.user_login(login)
        except validate.InvalidFormat:
            pass
        else:
            user = self.db.query(database.User).get(login)
            if user is not None:
                return self.send_json({'exists': True})
        return self.send_json({'exists': False})


class ProjectMeta(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('project_meta')
    def post(self, project_id):
        project, privileges = self.get_project(project_id)
        if not privileges.can_edit_project_meta():
            return self.send_error_json(403, "Unauthorized")
        try:
            obj = self.get_json()
            validate.project_name(obj['name'])
            project.name = obj['name']
            validate.description(obj['description'])
            project.description = obj['description']
            logger.info("Updated project: %r %r",
                        project.name, project.description)
            cmd = database.Command.project_meta(
                self.current_user,
                project.id,
                obj['name'],
                obj['description'],
            )
            self.db.add(cmd)
            self.db.commit()
            self.db.refresh(cmd)
            self.application.notify_project(project.id, cmd)
            return self.send_json({})
        except validate.InvalidFormat as e:
            logger.info("Error validating ProjectMeta: %r", e)
            return self.send_error_json(e.status_code, self.gettext(e.message),
                                        e.reason)


class DocumentAdd(BaseHandler):
    @api_auth
    @PROM_REQUESTS.async_('document_add')
    async def post(self, project_id):
        project, privileges = self.get_project(project_id)
        if not privileges.can_add_document():
            return await self.send_error_json(403, "Unauthorized")
        try:
            name = self.get_body_argument('name')
            validate.document_name(name)
            description = self.get_body_argument('description')
            validate.description(description)
            try:
                file = self.request.files['file'][0]
            except (KeyError, IndexError):
                raise MissingArgumentError('file')
            content_type = file.content_type
            filename = validate.filename(file.filename)

            try:
                body = await convert.to_html_chunks(
                    file.body, content_type, filename,
                    self.application.config,
                )
            except convert.ConversionError as err:
                return await self.send_error_json(400, str(err))
            else:
                doc = database.Document(
                    name=name,
                    description=description,
                    filename=filename,
                    project=project,
                    contents=body,
                )
                self.db.add(doc)
                self.db.flush()  # Need to flush to get doc.id
                cmd = database.Command.document_add(
                    self.current_user,
                    doc,
                )
                self.db.add(cmd)
                logger.info("Document added to project %r: %r %r (%d bytes)",
                            project.id, doc.id, doc.name, len(doc.contents))
                self.db.commit()
                self.db.refresh(cmd)
                self.application.notify_project(project.id, cmd)
                return await self.send_json({'created': doc.id})
        except validate.InvalidFormat as e:
            logger.info("Error validating DocumentAdd: %r", e)
            return await self.send_error_json(
                e.status_code, self.gettext(e.message),
                e.reason,
            )


class DocumentUpdate(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('document_update')
    def post(self, project_id, document_id):
        document, privileges = self.get_document(project_id, document_id)
        if not privileges.can_edit_document():
            return self.send_error_json(403, "Unauthorized")
        try:
            obj = self.get_json()
            if obj:
                if 'name' in obj:
                    validate.document_name(obj['name'])
                    document.name = obj['name']
                if 'description' in obj:
                    validate.description(obj['description'])
                    document.description = obj['description']
                cmd = database.Command.document_add(
                    self.current_user,
                    document,
                )
                self.db.add(cmd)
                self.db.commit()
                self.db.refresh(cmd)
                self.application.notify_project(document.project_id, cmd)

            return self.send_json({'id': document.id})
        except validate.InvalidFormat as e:
            logger.info("Error validating DocumentUpdate: %r", e)
            return self.send_error_json(e.status_code, self.gettext(e.message),
                                        e.reason)

    @api_auth
    @PROM_REQUESTS.sync('document_delete')
    def delete(self, project_id, document_id):
        document, privileges = self.get_document(project_id, document_id)
        if not privileges.can_delete_document():
            return self.send_error_json(403, "Unauthorized")
        self.db.delete(document)
        cmd = database.Command.document_delete(
            self.current_user,
            document,
        )
        self.db.add(cmd)
        self.db.commit()
        self.db.refresh(cmd)
        self.application.notify_project(document.project_id, cmd)

        self.set_status(204)
        return self.finish()


class DocumentContents(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('document_contents')
    def get(self, project_id, document_id):
        document, _ = self.get_document(project_id, document_id, True)

        highlights = (
            self.db.query(database.Highlight)
            .options(defer('snippet'))
            .filter(database.Highlight.document_id == document.id)
            .order_by(database.Highlight.start_offset)
            .options(joinedload(database.Highlight.tags))
            .options(defer('tags.highlights_count'))
        ).all()

        return self.send_json({
            'contents': [
                {'offset': 0, 'contents': document.contents},
            ],
            'highlights': [
                {'id': hl.id,
                 'start_offset': hl.start_offset,
                 'end_offset': hl.end_offset,
                 'tags': [t.id for t in hl.tags]}
                for hl in highlights
            ],
        })


def _migrate_highlights(db, document, start, end, delta,
                        old_text, new_text, new_contents):
    """Move a document's highlights across an edit of [start, end).

    Positions before the edit are untouched, positions after it shift by
    the delta. A position inside the edited range is mapped through a
    diff of the old and new text, so a highlight over text that did not
    change keeps its exact bounds; one over changed text shrinks to the
    nearest unchanged boundary. Highlights that collapse to nothing
    (all their text was removed) are deleted.
    """
    a = old_text.encode('utf-8')
    b = new_text.encode('utf-8')
    matches = SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks()

    def map_rel(rel):
        # Position relative to the start of the edited range, in bytes
        if rel >= len(a):
            return len(b)
        last = 0
        for i, j, size in matches:
            if i <= rel < i + size:
                return j + (rel - i)  # unchanged text: exact position
            if i + size <= rel:
                last = j + size  # left-sticky through changed text
        return last

    def map_pos(pos):
        if pos <= start:
            return pos
        if pos >= end:
            return pos + delta
        return start + map_rel(pos - start)

    highlights = (
        db.query(database.Highlight)
        .filter(database.Highlight.document_id == document.id)
    ).all()
    deleted_highlights = []
    for hl in highlights:
        if hl.end_offset <= start:
            continue
        new_start = map_pos(hl.start_offset)
        new_end = map_pos(hl.end_offset)
        if new_end <= new_start:
            deleted_highlights.append(hl.id)
            db.delete(hl)
            continue
        hl.start_offset = new_start
        hl.end_offset = new_end
        hl.snippet = extract.extract(new_contents, new_start, new_end)
    return deleted_highlights


class DocumentEdit(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('document_edit')
    def post(self, project_id, document_id):
        if self.application.config['MULTIUSER']:
            return self.send_error_json(
                403, "Editing documents is disabled in multi-user mode")
        document, privileges = self.get_document(project_id, document_id,
                                                 contents=True)
        if not privileges.can_edit_document():
            return self.send_error_json(403, "Unauthorized")
        obj = self.get_json()
        start = obj.get('start_offset')
        end = obj.get('end_offset')
        text = obj.get('text', '')
        paragraphs = obj.get('paragraphs', False)
        if (not isinstance(start, int) or not isinstance(end, int)
                or not isinstance(text, str)
                or not isinstance(paragraphs, bool)
                or not 0 <= start < end
                or len(text.encode('utf-8')) > 100 * 1024):
            return self.send_error_json(400, "Invalid edit")

        new_contents = extract.edit(document.contents, start, end, text,
                                    paragraphs=paragraphs)
        if new_contents is None:
            return self.send_error_json(400, "Invalid edit range")
        if extract.text_length(new_contents) == 0:
            return self.send_error_json(400, "A document cannot be emptied")
        # Newlines turned into paragraph breaks carry no bytes, so the
        # effective replacement text is `text` without them
        plain_text = text.replace('\n', '') if paragraphs else text
        delta = len(plain_text.encode('utf-8')) - (end - start)

        old_text = BeautifulSoup(
            extract.extract(document.contents, start, end),
            'html5lib').get_text()
        deleted_highlights = _migrate_highlights(
            self.db, document, start, end, delta,
            old_text, plain_text, new_contents)

        document.contents = new_contents
        cmd = database.Command.document_edit(
            self.current_user, document, len(deleted_highlights))
        self.db.add(cmd)
        self.db.commit()
        self.db.refresh(cmd)
        self.application.notify_project(document.project_id, cmd)
        logger.info("Document %r edited: bytes [%d, %d) -> %d bytes, "
                    "%d highlight(s) deleted",
                    document.id, start, end, len(text.encode('utf-8')),
                    len(deleted_highlights))
        return self.send_json({'delta': delta,
                               'deleted_highlights': deleted_highlights})


class TagAdd(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('tag_add')
    def post(self, project_id):
        project, privileges = self.get_project(project_id)
        if not privileges.can_add_tag():
            return self.send_error_json(403, "Unauthorized")
        try:
            obj = self.get_json()
            validate.tag_path(obj['path'])
            validate.description(obj['description'])

            # Optional parent: makes the new tag a child of another tag
            parent_id = obj.get('parent_id')
            if parent_id is not None:
                if not isinstance(parent_id, int):
                    raise validate.InvalidFormat("Invalid parent tag")
                parent = self.db.query(database.Tag).get(parent_id)
                if parent is None or parent.project_id != project.id:
                    return self.send_error_json(404, "No such tag")

            tag = database.Tag(project=project,
                               path=obj['path'],
                               description=obj['description'],
                               parent_id=parent_id)
            try:
                self.db.add(tag)
                self.db.flush()  # Need to flush to get tag.id
            except IntegrityError:
                self.db.rollback()
                return self.send_error_json(409, "Conflict")
            cmd = database.Command.tag_add(
                self.current_user,
                tag,
            )
            self.db.add(cmd)
            self.db.commit()
            self.db.refresh(cmd)
            self.application.notify_project(project.id, cmd)

            return self.send_json({'id': tag.id})
        except validate.InvalidFormat as e:
            logger.info("Error validating TagAdd: %r", e)
            return self.send_error_json(e.status_code, self.gettext(e.message),
                                        e.reason)


class TagUpdate(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('tag_update')
    def post(self, project_id, tag_id):
        project, privileges = self.get_project(project_id)
        if not privileges.can_update_tag():
            return self.send_error_json(403, "Unauthorized")
        try:
            obj = self.get_json()
            tag = self.db.query(database.Tag).get(int(tag_id))
            if tag is None or tag.project_id != project.id:
                return self.send_error_json(404, "No such tag")
            if obj:
                commands = []

                # Move within the tag tree (new parent, None for root)
                if 'parent_id' in obj:
                    new_parent_id = obj['parent_id']
                    if new_parent_id is not None \
                            and not isinstance(new_parent_id, int):
                        raise validate.InvalidFormat("Invalid parent tag")
                    if new_parent_id is not None:
                        if new_parent_id == tag.id or _is_descendant(
                                self.db, new_parent_id, tag.id):
                            return self.send_error_json(
                                400,
                                "Cannot make a tag a child of one of its "
                                "own descendants",
                            )
                        parent = self.db.query(database.Tag).get(
                            new_parent_id,
                        )
                        if parent is None or parent.project_id != project.id:
                            return self.send_error_json(404, "No such tag")
                    if new_parent_id != tag.parent_id:
                        old_parent_id = tag.parent_id
                        tag.parent_id = new_parent_id
                        changes = _update_inheritance_on_move(
                            self.db, tag, old_parent_id, new_parent_id,
                        )
                        cmd = database.Command.tag_move(
                            self.current_user,
                            project.id,
                            tag.id,
                            new_parent_id,
                        )
                        cmd.tag_count_changes = changes or None
                        commands.append(cmd)

                if 'path' in obj or 'description' in obj:
                    if 'path' in obj:
                        validate.tag_path(obj['path'])
                        tag.path = obj['path']
                    if 'description' in obj:
                        validate.description(obj['description'])
                        tag.description = obj['description']
                    commands.append(database.Command.tag_add(
                        self.current_user,
                        tag,
                    ))

                if commands:
                    for cmd in commands:
                        self.db.add(cmd)
                    try:
                        self.db.commit()
                    except IntegrityError:
                        self.db.rollback()
                        return self.send_error_json(409, "Conflict")
                    for cmd in commands:
                        self.db.refresh(cmd)
                        self.application.notify_project(project.id, cmd)

            return self.send_json({'id': tag.id})
        except validate.InvalidFormat as e:
            logger.info("Error validating TagUpdate: %r", e)
            return self.send_error_json(e.status_code, self.gettext(e.message),
                                        e.reason)

    @api_auth
    @PROM_REQUESTS.sync('tag_delete')
    def delete(self, project_id, tag_id):
        project, privileges = self.get_project(project_id)
        if not privileges.can_delete_tag():
            return self.send_error_json(403, "Unauthorized")
        tag = self.db.query(database.Tag).get(int(tag_id))
        if tag is None or tag.project_id != project.id:
            return self.send_error_json(404, "No such tag")

        # Children move up to the deleted tag's parent (rather than being
        # silently deleted by the foreign key cascade), and the deleted
        # tag's ancestors lose the links its own highlights justified
        old_parent_id = tag.parent_id
        tag_highlights = _tag_highlight_ids(self.db, tag.id)
        self.db.query(database.Tag).filter(
            database.Tag.parent_id == tag.id,
        ).update(
            {database.Tag.parent_id: old_parent_id},
            synchronize_session=False,
        )
        if old_parent_id is not None:
            old_chain = [old_parent_id] + _ancestor_chain(
                self.db, old_parent_id,
            )
            changes = _prune_implied_links(
                self.db, old_chain, tag_highlights,
            )
        else:
            changes = {}

        self.db.delete(tag)
        cmd = database.Command.tag_delete(
            self.current_user,
            project.id,
            tag.id,
        )
        cmd.tag_count_changes = changes or None
        self.db.add(cmd)
        self.db.commit()
        self.db.refresh(cmd)
        self.application.notify_project(project.id, cmd)

        self.set_status(204)
        return self.finish()


class TagMerge(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('tag_merge')
    def post(self, project_id):
        project, privileges = self.get_project(project_id)
        if not privileges.can_merge_tags():
            return self.send_error_json(403, "Unauthorized")
        obj = self.get_json()
        tag_src = self.db.query(database.Tag).get(obj['src'])
        tag_dest = self.db.query(database.Tag).get(obj['dest'])
        if (
            tag_src is None
            or tag_src.project_id != project.id
            or tag_dest is None
            or tag_dest.project_id != project.id
        ):
            return self.send_error_json(404, "No such tag")
        if tag_src.id == tag_dest.id or _is_descendant(
                self.db, tag_dest.id, tag_src.id):
            return self.send_error_json(
                400, "Cannot merge a tag into one of its own descendants")

        # Handle the hierarchy first: treat the merge as moving the source
        # (with its subtree) under the destination, so the destination and
        # its ancestors inherit the subtree's highlights, and the source's
        # old ancestors lose the links the subtree justified
        changes = _update_inheritance_on_move(
            self.db, tag_src, tag_src.parent_id, tag_dest.id,
        )

        # Every highlight of the source is now linked to the destination
        # (inherited above); drop the source's own links
        self.db.query(database.HighlightTag).filter(
            database.HighlightTag.tag_id == tag_src.id,
        ).delete(synchronize_session=False)

        # Children of the source are re-parented onto the destination
        self.db.query(database.Tag).filter(
            database.Tag.parent_id == tag_src.id,
        ).update(
            {database.Tag.parent_id: tag_dest.id},
            synchronize_session=False,
        )

        # Delete tag_src
        self.db.delete(tag_src)

        cmd = database.Command.tag_merge(
            self.current_user,
            project.id,
            tag_src.id,
            tag_dest.id,
        )
        cmd.tag_count_changes = changes or None
        self.db.add(cmd)
        self.db.commit()
        self.db.refresh(cmd)
        self.application.notify_project(project.id, cmd)

        return self.send_json({'id': tag_dest.id})


class HighlightAdd(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('highlight_add')
    def post(self, project_id, document_id):
        document, privileges = self.get_document(project_id, document_id, True)
        if not privileges.can_add_highlight():
            return self.send_error_json(403, "Unauthorized")
        obj = self.get_json()
        start, end = obj['start_offset'], obj['end_offset']
        new_tags = set(obj.get('tags', []))

        # Check the tags exist and are in this project
        tags = (
            self.db.query(database.Tag)
            .filter(database.Tag.id.in_(new_tags))
            .filter(database.Tag.project_id == document.project_id)
            .all()
        )
        if set(tag.id for tag in tags) != new_tags:
            return self.send_error_json(400, "Tag not in project")

        # Parents inherit highlights tagged on their children: expand the
        # tag set with the tags' ancestors
        new_tags = _expand_tags_with_ancestors(self.db, tags)

        snippet = extract.extract(document.contents, start, end)
        hl = database.Highlight(document=document,
                                start_offset=start,
                                end_offset=end,
                                snippet=snippet)
        self.db.add(hl)
        self.db.flush()  # Need to flush to get hl.id

        # Insert tags in database
        self.db.bulk_insert_mappings(database.HighlightTag, [
            dict(
                highlight_id=hl.id,
                tag_id=tag,
            )
            for tag in sorted(new_tags)
        ])
        cmd = database.Command.highlight_add(
            self.current_user,
            document,
            hl,
            sorted(new_tags),
        )
        cmd.tag_count_changes = {tag: 1 for tag in sorted(new_tags)}
        self.db.add(cmd)
        self.db.commit()
        self.db.refresh(cmd)
        self.application.notify_project(document.project_id, cmd)

        return self.send_json({'id': hl.id})


class HighlightUpdate(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('highlight_update')
    def post(self, project_id, document_id, highlight_id):
        document, privileges = self.get_document(project_id, document_id)
        if not privileges.can_add_highlight():
            return self.send_error_json(403, "Unauthorized")
        obj = self.get_json()
        hl = self.db.query(database.Highlight).get(int(highlight_id))
        if hl is None or hl.document_id != document.id:
            return self.send_error_json(404, "No such highlight")
        if obj:
            if 'start_offset' in obj:
                hl.start_offset = obj['start_offset']
            if 'end_offset' in obj:
                hl.end_offset = obj['end_offset']
            # Keep the snippet (shown in tag views and exports) in sync
            # with the new extent
            if 'start_offset' in obj or 'end_offset' in obj:
                hl.snippet = extract.extract(
                    document.contents, hl.start_offset, hl.end_offset)
            if 'tags' in obj:
                # Obtain old tags from database
                old_tags = (
                    self.db.query(database.HighlightTag)
                    .filter(database.HighlightTag.highlight == hl)
                    .all()
                )
                old_tags = set(hl_tag.tag_id for hl_tag in old_tags)
                new_tags = set(obj['tags'])

                # Check the tags exist and are in this project
                tags = (
                    self.db.query(database.Tag)
                        .filter(database.Tag.id.in_(new_tags))
                        .filter(database.Tag.project_id == document.project_id)
                        .all()
                )
                if set(tag.id for tag in tags) != new_tags:
                    return self.send_error_json(400, "Tag not in project")

                # Parents inherit highlights tagged on their children:
                # expand the tag set with the tags' ancestors
                new_tags = _expand_tags_with_ancestors(self.db, tags)

                # Update tags in database
                (
                    self.db.query(database.HighlightTag)
                    .filter(database.HighlightTag.highlight == hl)
                ).delete()
                self.db.bulk_insert_mappings(database.HighlightTag, [
                    dict(
                        highlight_id=hl.id,
                        tag_id=tag,
                    )
                    for tag in sorted(new_tags)
                ])

                # Compute the change in tag counts
                tag_count_changes = {}
                for tag in old_tags - new_tags:
                    tag_count_changes[tag] = -1
                for tag in new_tags - old_tags:
                    tag_count_changes[tag] = 1
            else:
                # Resizing only (dragging the boundary brackets in the
                # document view): the tags are kept, but the event still
                # carries them so that every browser can re-render the
                # highlight
                new_tags = set(
                    tag_id for (tag_id,) in
                    self.db.query(database.HighlightTag.tag_id)
                    .filter(database.HighlightTag.highlight == hl)
                )
                tag_count_changes = None

            cmd = database.Command.highlight_add(
                self.current_user,
                document,
                hl,
                sorted(new_tags),
            )
            cmd.tag_count_changes = tag_count_changes
            self.db.add(cmd)
            self.db.commit()
            self.db.refresh(cmd)
            self.application.notify_project(document.project_id, cmd)

        return self.send_json({'id': hl.id})

    @api_auth
    @PROM_REQUESTS.sync('highlight_delete')
    def delete(self, project_id, document_id, highlight_id):
        document, privileges = self.get_document(project_id, document_id)
        if not privileges.can_delete_highlight():
            return self.send_error_json(403, "Unauthorized")
        hl = self.db.query(database.Highlight).get(int(highlight_id))
        if hl is None or hl.document_id != document.id:
            return self.send_error_json(404, "No such highlight")
        old_tags = list(
            self.db.query(database.HighlightTag)
            .filter(database.HighlightTag.highlight == hl)
            .all()
        )
        old_tags = [hl_tag.tag_id for hl_tag in old_tags]
        self.db.delete(hl)
        cmd = database.Command.highlight_delete(
            self.current_user,
            document,
            hl.id,
        )
        cmd.tag_count_changes = {tag: -1 for tag in old_tags}
        self.db.add(cmd)
        self.db.commit()
        self.db.refresh(cmd)
        self.application.notify_project(document.project_id, cmd)

        self.set_status(204)
        return self.finish()


class Highlights(BaseHandler):
    PAGE_SIZE = 50

    @api_auth
    @PROM_REQUESTS.sync('highlights')
    def get(self, project_id, path):
        project, _ = self.get_project(project_id)
        page = self.get_query_argument('page', '1')
        try:
            page = int(page, 10) - 1
        except (ValueError, OverflowError):
            page = -1
        if page < 0:
            self.send_error_json(404, "Bad page number")

        if path:
            tag = aliased(database.Tag)
            hltag = aliased(database.HighlightTag)
            query = (
                self.db.query(database.Highlight)
                .options(joinedload(database.Highlight.tags))
                .join(hltag, hltag.highlight_id == database.Highlight.id)
                .join(tag, hltag.tag_id == tag.id)
                .filter(tag.path.startswith(path))
                .filter(tag.project == project)
                .order_by(database.Highlight.document_id,
                          database.Highlight.start_offset)
            )
        else:
            # Special case to select all highlights: we also need to select
            # highlights that have no tag at all
            document = aliased(database.Document)
            query = (
                self.db.query(database.Highlight)
                .options(joinedload(database.Highlight.tags))
                .join(document, document.id == database.Highlight.document_id)
                .filter(document.project == project)
                .order_by(database.Highlight.document_id,
                          database.Highlight.start_offset)
            )

        total = query.count()
        highlights = (
            query
            .offset(page * self.PAGE_SIZE)
            .limit(self.PAGE_SIZE)
            .all()
        )

        return self.send_json({
            'highlights': [
                {
                    'id': hl.id,
                    'document_id': hl.document_id,
                    'content': hl.snippet,
                    'tags': [t.id for t in hl.tags],
                }
                for hl in highlights
            ],
            'pages': math.ceil(total / self.PAGE_SIZE),
        })


class MembersUpdate(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('members_update')
    def patch(self, project_id):
        if not self.application.config['MULTIUSER']:
            raise HTTPError(404)
        obj = self.get_json()
        project, privileges = self.get_project(project_id)

        if (obj.keys() == {self.current_user} and
                not obj[self.current_user]):
            # Special case: you are always allowed to remove yourself
            pass
        elif not privileges.can_edit_members():
            return self.send_error_json(403, "Unauthorized")

        # Get all members
        members = (
            self.db.query(database.ProjectMember)
            .filter(database.ProjectMember.project_id == project.id)
        ).all()
        members = {member.user_login: member for member in members}

        # Go over the JSON patch and update
        commands = []
        for login, user_info in obj.items():
            login = validate.user_login(login)
            if not user_info:
                if login in members:
                    logger.info("Removing member %r from project %d (%s)",
                                login, project.id, members[login].privileges)
                    self.db.delete(members.pop(login))
                    cmd = database.Command.member_remove(
                        self.current_user, project.id,
                        login,
                    )
                    self.db.add(cmd)
                    commands.append(cmd)
            else:
                try:
                    privileges = database.Privileges[user_info['privileges']]
                except KeyError:
                    return self.send_error_json(
                        400,
                        "Invalid privileges %r" % user_info.get('privileges'),
                    )
                if login in members:
                    logger.info("Changing member %r in project %d: %s -> %s",
                                login, project.id, members[login].privileges,
                                privileges)
                    members[login].privileges = privileges
                else:
                    logger.info("Adding member %r to project %d (%s)",
                                login, project.id, privileges)
                    member = database.ProjectMember(project=project,
                                                    user_login=login,
                                                    privileges=privileges)
                    members[login] = member
                    self.db.add(member)
                cmd = database.Command.member_add(
                    self.current_user, project.id,
                    login, privileges,
                )
                self.db.add(cmd)
                commands.append(cmd)

        # Check that there are still admins
        for member in members.values():
            if member.privileges == database.Privileges.ADMIN:
                break
        else:
            self.db.rollback()
            return self.send_error_json(400, "There must be one admin")

        self.db.commit()
        for cmd in commands:
            self.db.refresh(cmd)
            self.application.notify_project(project.id, cmd)

        self.set_status(204)
        return self.finish()


class ImportProject(BaseHandler):
    def prepare(self):
        if not self.application.config['SQLITE3_IMPORT_ENABLED']:
            raise HTTPError(403)

    @api_auth
    @PROM_REQUESTS.sync('project_import')
    async def post(self):
        try:
            file = self.request.files['file'][0]
        except (KeyError, IndexError):
            raise MissingArgumentError('file')

        with tempfile.NamedTemporaryFile(
            'wb',
            prefix='taguette_import_',
            suffix='.sqlite3',
        ) as tmp:
            # Write the database to temporary file
            tmp.write(file.body)
            tmp.flush()

            project_id = self.get_body_argument('project_id', None)
            if project_id is None:
                return await self._list_projects(tmp.name)
            else:
                try:
                    project_id = int(project_id)
                except ValueError:
                    self.set_status(400)
                    return await self.send_json({
                        'error': "Invalid project ID",
                    })
                return await self._import_project(tmp.name, project_id)

    async def _list_projects(self, filename):
        # Connect to the database
        src_db = database.connect('sqlite:///%s' % filename, external=True)()

        # List projects
        projects = src_db.execute(database.Project.__table__.select())
        for i, row in enumerate(projects):
            if i == 0:
                self.set_header(
                    'Content-Type', 'application/json; charset=utf-8',
                )
                self.write('{"projects": [')
            else:
                self.write(',')
            self.write(json.dumps({
                'id': row['id'],
                'name': row['name'],
            }))
            if i == 100:
                await self.flush()
        return await self.finish(']}')

    async def _import_project(self, filename, project_id):
        # Connect to the database
        src_db = database.connect('sqlite:///%s' % filename, external=True)()

        # Copy data
        new_project_id = database.copy_project(
            src_db, self.db,
            project_id, self.current_user,
        )
        src_db.close()

        # Insert a command for the import
        self.db.add(
            database.Command.project_import(self.current_user, new_project_id)
        )

        self.db.commit()

        return await self.send_json({'project_id': new_project_id})


class ProjectEvents(BaseHandler):
    response_cancelled = False
    polling_clients = set()
    PROM_POLLING_CLIENTS.set_function(
        lambda: len(ProjectEvents.polling_clients)
    )

    @api_auth
    @PROM_REQUESTS.async_('events')
    async def get(self, project_id):
        ProjectEvents.polling_clients.add(self.request.remote_ip)
        tornado.log.access_log.info(
            "started %s %s (%s) (%s)",
            self.request.method,
            self.request.uri,
            self.request.remote_ip,
            self.current_user,
        )

        from_id = int(self.get_query_argument('from'))
        project, _ = self.get_project(project_id)
        self.project_id = int(project_id)

        # Limit over which we won't send update but rather reload the frontend
        LIMIT = 20

        # Check for immediate update
        cmds = (
            self.db.query(database.Command)
            .filter(database.Command.id > from_id)
            .filter(database.Command.project_id == project.id)
            .limit(LIMIT)
        ).all()

        if len(cmds) == LIMIT:
            return await self.send_json({'reload': True})

        if cmds:
            # Convert to JSON
            cmds_json = [cmd.to_json() for cmd in cmds]
        else:
            # Wait for an event (which comes in JSON)
            self.wait_future = Future()
            self.application.observe_project(project.id, self.wait_future)
            self.db.expire_all()

            # Close DB connection to not overflow the connection pool
            self.close_db_connection()

            try:
                cmds_json = [await self.wait_future]
            except asyncio.CancelledError:
                return

        # Remove 'project_id' from each event
        def _change_cmd_json(old):
            new = dict(old)
            new.pop('project_id')
            return new

        cmds_json = [_change_cmd_json(cmd) for cmd in cmds_json]

        return await self.send_json({'events': cmds_json})

    def on_connection_close(self):
        self.response_cancelled = True
        self.wait_future.cancel()
        self.application.unobserve_project(self.project_id, self.wait_future)

    def on_finish(self):
        super(ProjectEvents, self).on_finish()
        ProjectEvents.polling_clients.discard(self.request.remote_ip)

    def _log(self):
        if not self.response_cancelled:
            self.application.log_request(self)
        else:
            tornado.log.access_log.info(
                "aborted %s %s (%s) %.2fms",
                self.request.method,
                self.request.uri,
                self.request.remote_ip,
                1000.0 * self.request.request_time(),
            )
