import re
import alembic.util.exc
import asyncio
import functools
import json
import logging
import math
import os
import prometheus_client
from sqlalchemy import and_, func, distinct, not_, or_
from sqlalchemy.exc import IntegrityError, DatabaseError, NoSuchTableError
from sqlalchemy.orm import aliased, defer, joinedload
import tempfile
from tornado.concurrent import Future
import tornado.log
from tornado.web import MissingArgumentError, HTTPError
from urllib.parse import unquote

from .. import exact_version
from .. import convert
from .. import database
from .. import extract
from .. import validate
from .base import BaseHandler, PromMeasureRequest
from ..utils import get_path_informations
from ..demodata import DEMO_DATA

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
            return self.send_error_json(403, self.gettext("Not logged in"))
        return method(self, *args, **kwargs)

    return wrapper


class CheckUser(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('check_user')
    def post(self):
        if not self.application.config['MULTIUSER']:
            raise HTTPError(404)
        data = self.get_json()
        login = data['login']
        permission = data['permission'] if 'permission' in data else False
        try:
            login = validate.fix_user_login(login)
        except validate.InvalidFormat:
            pass
        else:
            user = self.db.query(database.User).get(login)
            return_user = True
            if permission and (not user.role.role_can_be_changed() or
                               user.approved_by_user_login is not None):
                return_user = False
            if return_user and user is not None and not user.disabled:
                return self.send_json({'exists': True})
        return self.send_json({'exists': False})


class CreateDemoProject(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('create_demo_project')
    def post(self):
        user = self.db.query(database.User).get(self.current_user)
        documents = []
        tags = []
        # Create project
        project = database.Project(
            name=self.gettext("Tutorial - board games"),
            description=self.gettext(
                'A demo project to showcase LibreQDA'
            ))
        self.db.add(project)
        priv = database.Privileges.TAG
        if user.role.can_create_project():
            priv = database.Privileges.ADMIN
        # Add user as admin
        membership = database.ProjectMember(
            project=project,
            user_login=self.current_user,
            privileges=priv
        )
        self.db.add(membership)
        self.db.flush()

        # Select language for demo
        lang = user.language
        if lang not in DEMO_DATA.keys():
            lang = self.application.config['DEFAULT_LANGUAGE']
        for document in DEMO_DATA[lang]['documents']:
            d = database.Document(
                project_id=project.id,
                name=document['name'],
                description="",
                filename=document['filename'],
                text_direction=document['text_direction'],
                contents=document['contents'],
                favorite=document['favorite']
            )
            self.db.add(d)
            self.db.flush()
            documents.append(d)

        for tag in DEMO_DATA[lang]['tags']:
            t = database.Tag(project=project,
                             color=tag['color'],
                             path=tag['path'],
                             description=tag['description'])
            self.db.add(t)
            self.db.flush()
            tags.append(t)
            if tag['childrens']:
                for tag2 in tag['childrens']:
                    t2 = database.Tag(project=project,
                                      color=tag2['color'],
                                      path=tag2['path'],
                                      description=tag2['description'],
                                      parent=t)
                    self.db.add(t2)
                    self.db.flush()
                    tags.append(t2)

        self.db.commit()

        for highlight in DEMO_DATA[lang]['highlights']:
            h = database.Highlight(
                document=documents[highlight['document']],
                start_offset=highlight['start_offset'],
                end_offset=highlight['end_offset'],
                snippet=highlight['snippet'])
            self.db.add(h)
            self.db.flush()
            for t in highlight['tags']:
                h.tags.append(tags[t])
            self.db.flush()
            logger.info(h)
        self.db.commit()

        return self.send_json({
            'html': self.render_string(
                'partials/project_card.html',
                project=project,
                demo=True)
        })


class ProjectMeta(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('project_meta')
    def post(self, project_id):
        project, privileges = self.get_project(project_id)
        if not privileges.can_edit_project_meta():
            return self.send_error_json(403, self.gettext("Unauthorized"))
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
            return self.send_error_json(400, self.gettext(e.message))


class DocumentAdd(BaseHandler):
    @api_auth
    @PROM_REQUESTS.async_('document_add')
    async def post(self, project_id):
        project, privileges = self.get_project(project_id)
        if not privileges.can_add_document():
            return await self.send_error_json(403, self.gettext(
                "Unauthorized",
            ))
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
            filename = validate.fix_filename(unquote(file.filename))
            favorite = False
            direction = self.get_body_argument('text_direction',
                                               'LEFT_TO_RIGHT')
            try:
                direction = database.TextDirection[direction]
            except KeyError:
                return await self.send_error_json(
                    400,
                    "Invalid text direction",
                )

            # Close DB connection to not overflow the connection pool
            self.close_db_connection()

            try:
                body = await convert.to_html_chunks(
                    file.body, content_type, filename,
                    self.application.config,
                )
            except convert.ConversionError as err:
                logger.warning(
                    "Error converting document %r %s: %s",
                    filename, content_type, err,
                )
                return await self.send_error_json(400, str(err))
            else:
                doc = database.Document(
                    name=name,
                    description=description,
                    filename=filename,
                    favorite=favorite,
                    project=project,
                    text_direction=direction,
                    contents=body,
                )
                self.db.add(doc)
                self.db.flush()  # Need to flush to get doc.id

                # Handle existing collections
                collection_ids = self.get_arguments('collection_ids')
                for col_id in collection_ids:
                    collection = self.db.query(database.Collection).filter_by(
                        id=col_id, project_id=project.id).first()
                    if collection:
                        doc.collections.append(collection)

                # Handle new collection creation
                create_collection_name = self.get_body_argument(
                    'create_collection_name', None)
                if create_collection_name:
                    create_collection_name = create_collection_name.strip()
                    if create_collection_name:
                        # Check if collection with this name already exists
                        existing_collection = self.db.query(
                            database.Collection
                        ).filter_by(
                            name=create_collection_name,
                            project_id=project.id,
                            owner_login=self.current_user
                        ).first()

                        if existing_collection:
                            # Use existing collection
                            doc.collections.append(existing_collection)
                            logger.info(
                                "Added document %r to existing collection %r",
                                doc.name, create_collection_name
                            )
                        else:
                            # Create new collection
                            new_collection = database.Collection(
                                name=create_collection_name,
                                description="",
                                project_id=project.id,
                                owner_login=self.current_user,
                                parent_id=None
                            )
                            self.db.add(new_collection)
                            self.db.flush()  # Get collection.id
                            doc.collections.append(new_collection)
                            logger.info(
                                "Created new collection %r for document %r",
                                create_collection_name, doc.name
                            )

                            # Add command for collection creation
                            collection_cmd = database.Command.collection_add(
                                self.current_user,
                                new_collection,
                            )
                            self.db.add(collection_cmd)

                cmd = database.Command.document_add(
                    self.current_user,
                    doc,
                )
                self.db.add(cmd)
                logger.info(
                    "Document added to project %r: %r %r (%d bytes)",
                    project.id, doc.id, doc.name, len(doc.contents)
                )
                self.db.commit()
                self.db.refresh(cmd)

                if (create_collection_name and
                        create_collection_name.strip() and
                        'collection_cmd' in locals()):
                    self.db.refresh(collection_cmd)
                    self.application.notify_project(
                        project.id, collection_cmd
                    )

                self.application.notify_project(project.id, cmd)
                return await self.send_json({'created': doc.id})
        except validate.InvalidFormat as e:
            logger.info("Error validating DocumentAdd: %r", e)
            return await self.send_error_json(400, self.gettext(e.message))


class Document(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('document_info')
    def get(self, project_id, document_id):
        document, _ = self.get_document(project_id, document_id)

        highlights = (
            self.db.query(database.Highlight)
            .filter(database.Highlight.document_id == document.id)
            .order_by(database.Highlight.start_offset)
            .options(joinedload(database.Highlight.tags))
            .options(defer('tags.highlights_count'))
        ).all()
        return self.send_json({
            'text_direction': document.text_direction.name,
            'highlights': [
                {'id': hl.id,
                 'start_offset': hl.start_offset,
                 'end_offset': hl.end_offset,
                 'snippet': hl.snippet,
                 'tags': [t.id for t in hl.tags]}
                for hl in highlights
            ],
        })

    @api_auth
    @PROM_REQUESTS.sync('document_update')
    def post(self, project_id, document_id):
        document, privileges = self.get_document(project_id, document_id)
        if not privileges.can_edit_document():
            return self.send_error_json(403, self.gettext("Unauthorized"))
        try:
            obj = self.get_json()
            if obj:
                if 'name' in obj:
                    validate.document_name(obj['name'])
                    document.name = obj['name']
                if 'description' in obj:
                    validate.description(obj['description'])
                    document.description = obj['description']
                if 'favorite' in obj:
                    document.favorite = obj['favorite']
                if 'text_direction' in obj:
                    direction = obj['text_direction']
                    try:
                        direction = database.TextDirection[direction]
                    except KeyError:
                        return self.send_error_json(
                            400,
                            "Invalid text direction",
                        )
                    document.text_direction = direction
                if 'collections' in obj:
                    document.collections = []
                    for col_id in obj['collections']:
                        collection = (self.db.query(database.Collection)
                                      .filter_by(
                                          id=col_id,
                                          project_id=document.project_id)
                                      .first())
                        if collection:
                            document.collections.append(collection)
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
            return self.send_error_json(400, self.gettext(e.message))

    @api_auth
    @PROM_REQUESTS.sync('document_delete')
    def delete(self, project_id, document_id):
        document, privileges = self.get_document(project_id, document_id)
        if not privileges.can_delete_document():
            return self.send_error_json(403, self.gettext("Unauthorized"))
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
        # Document contents are immutable. If we ever make a change to the
        # format of this response, change this constant
        version = 1

        # Still, don't do it in desktop mode, because people might re-create
        # their Taguette database sooner than their browser profile
        if self.application.config['MULTIUSER']:
            # Cache for a long time
            self.set_header(
                'Cache-Control',
                'private,max-age=31536000,immutable',
            )

            # Use a fixed etag
            try:
                document_id = int(document_id)
            except ValueError:
                raise HTTPError(404)
            self.set_header('Etag', '"doc-%d-%d"' % (document_id, version))

            # Always return 304 if the client has a copy cached
            # This means that access control is not enforced, however:
            #   * no content is sent
            #   * 304 is sent whether or not the document actually exists
            if self.check_etag_header():
                self.set_status(304)
                self.set_header(
                    'Content-Type',
                    'application/json; charset=utf-8',
                )
                return self.finish()

        document, _ = self.get_document(project_id, document_id, True)
        return self.send_json({
            'contents': [
                {'offset': 0, 'contents': document.contents},
            ],
        })


class TagAdd(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('tag_add')
    def post(self, project_id):
        project, privileges = self.get_project(project_id)
        if not privileges.can_add_tag():
            return self.send_error_json(403, self.gettext("Unauthorized"))
        try:
            obj = self.get_json()

            validate.tag_path(obj['path'])
            validate.description(obj['description'])
            validate.color(obj['color'])

            tag = database.Tag(project=project,
                               parent_id=obj['parent_id'],
                               color=obj['color'],
                               path=obj['path'],
                               description=obj['description'])
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
            return self.send_error_json(400, self.gettext(e.message))


class TagUpdate(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('tag_update')
    def post(self, project_id, tag_id):
        project, privileges = self.get_project(project_id)
        if not privileges.can_update_tag():
            return self.send_error_json(403, self.gettext("Unauthorized"))
        try:
            obj = self.get_json()
            tag = self.db.query(database.Tag).get(int(tag_id))
            if tag is None or tag.project_id != project.id:
                return self.send_error_json(404, self.gettext("No such tag"))
            if obj:
                if 'path' in obj:
                    validate.tag_path(obj['path'])
                    tag.path = obj['path']
                if 'description' in obj:
                    validate.description(obj['description'])
                    tag.description = obj['description']
                if 'parent_id' in obj:
                    tag.parent_id = obj['parent_id']
                if 'color' in obj:
                    validate.color(obj['color'])
                    tag.color = obj['color']
                cmd = database.Command.tag_add(
                    self.current_user,
                    tag,
                )
                try:
                    self.db.add(cmd)
                    self.db.commit()
                except IntegrityError:
                    self.db.rollback()
                    return self.send_error_json(409, "Conflict")
                self.db.refresh(cmd)
                self.application.notify_project(project.id, cmd)

            return self.send_json({'id': tag.id})
        except validate.InvalidFormat as e:
            logger.info("Error validating TagUpdate: %r", e)
            return self.send_error_json(400, self.gettext(e.message))

    @api_auth
    @PROM_REQUESTS.sync('tag_delete')
    def delete(self, project_id, tag_id):
        project, privileges = self.get_project(project_id)
        if not privileges.can_delete_tag():
            return self.send_error_json(403, self.gettext("Unauthorized"))
        tag = self.db.query(database.Tag).get(int(tag_id))
        if tag is None or tag.project_id != project.id:
            return self.send_error_json(404, self.gettext("No such tag"))
        self.db.delete(tag)
        cmd = database.Command.tag_delete(
            self.current_user,
            project.id,
            tag.id,
        )
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
            return self.send_error_json(403, self.gettext("Unauthorized"))
        obj = self.get_json()
        tag_src = self.db.query(database.Tag).get(obj['src'])
        tag_dest = self.db.query(database.Tag).get(obj['dest'])
        if (
            tag_src is None
            or tag_src.project_id != project.id
            or tag_dest is None
            or tag_dest.project_id != project.id
        ):
            return self.send_error_json(404, self.gettext("No such tag"))

        # Remove tag from tag_src if it's already in tag_dest
        highlights_in_dest = (
            self.db.query(database.highlight_tags.c.highlight_id)
            .filter(database.highlight_tags.c.tag_id == tag_dest.id)
        )
        self.db.execute(
            database.highlight_tags.delete(
                and_(
                    database.highlight_tags.c.tag_id == tag_src.id,
                    database.highlight_tags.c.highlight_id.in_(
                        highlights_in_dest
                    ),
                )
            )
        )
        # Update tags that are in tag_src to be in tag_dest
        self.db.execute(
            database.highlight_tags.update()
            .where(database.highlight_tags.c.tag_id == tag_src.id)
            .values(tag_id=tag_dest.id)
        )
        self.db.query(database.Tag).filter(
            database.Tag.parent_id == tag_src.id
        ).update({database.Tag.parent_id: tag_dest.id})
        self.db.delete(tag_src)

        cmd = database.Command.tag_merge(
            self.current_user,
            project.id,
            tag_src.id,
            tag_dest.id,
        )
        self.db.add(cmd)
        self.db.commit()
        self.db.refresh(cmd)
        self.application.notify_project(project.id, cmd)

        return self.send_json({'id': tag_dest.id})


def calculate_tag_counts(db_session, tag_in_db, document, is_deletion=False):

    # Increment or decrement the number of highlights associated with the tag
    highlights_count = tag_in_db.highlights_count

    # Get the list of associated document IDs, or an empty list if None
    document_ids = tag_in_db.document_ids \
        if tag_in_db.document_ids is not None else []
    documents_count = len(document_ids)

    if is_deletion:
        highlights_count -= 1
    else:
        highlights_count += 1

    if is_deletion:
        # Check if there are still any highlights associated with the document
        remaining_highlights = (
            db_session.query(database.Highlight).join(
                database.highlight_tags).filter(
                database.highlight_tags.c.tag_id == tag_in_db.id,
                database.Highlight.document_id == document.id
            ).count())
        if remaining_highlights == 0:
            documents_count -= 1
    else:
        if document.id not in document_ids:
            documents_count += 1

    return {
        'highlights_count': highlights_count,
        'documents_count': documents_count
    }


class HighlightAdd(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('highlight_add')
    def post(self, project_id, document_id):
        document, privileges = self.get_document(project_id, document_id, True)
        if not privileges.can_add_highlight():
            return self.send_error_json(403, self.gettext("Unauthorized"))
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
        snippet = extract.extract(document.contents, start, end)
        if set(tag.id for tag in tags) != new_tags:
            return self.send_error_json(400, self.gettext("No such tag"))

        if all(c in '\r\n\t' for c in snippet):
            return self.send_error_json(400, self.gettext("Empty highlight"))

        hl = database.Highlight(document=document,
                                start_offset=start,
                                end_offset=end,
                                snippet=snippet)
        self.db.add(hl)
        self.db.flush()  # Need to flush to get hl.id

        # Insert tags in database
        if new_tags:
            self.db.execute(
                database.highlight_tags.insert(),
                [
                    dict(
                        highlight_id=hl.id,
                        tag_id=tag,
                    )
                    for tag in sorted(new_tags)
                ],
            )

        tag_count_changes = {}
        for tag in tags:
            tag_in_db = self.db.query(database.Tag).get(tag.id)
            tag_count_changes[tag.id] = calculate_tag_counts(self.db,
                                                             tag_in_db,
                                                             document)

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


class HighlightUpdate(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('highlight_update')
    def post(self, project_id, document_id, highlight_id):
        document, privileges = self.get_document(project_id, document_id)
        if not privileges.can_add_highlight():
            return self.send_error_json(403, self.gettext("Unauthorized"))
        obj = self.get_json()
        hl = self.db.query(database.Highlight).get(int(highlight_id))
        if hl is None or hl.document_id != document.id:
            return self.send_error_json(404, self.gettext("No such highlight"))
        if obj:
            if 'start_offset' in obj:
                hl.start_offset = obj['start_offset']
            if 'end_offset' in obj:
                hl.end_offset = obj['end_offset']
            if 'tags' in obj:
                # Obtain old tags from database
                old_tags = set(
                    row[0]
                    for row in self.db.query(database.highlight_tags.c.tag_id)
                    .filter(database.highlight_tags.c.highlight_id == hl.id)
                    .all()
                )
                new_tags = set(obj['tags'])

                # Check the tags exist and are in this project
                tags = (
                    self.db.query(database.Tag)
                    .filter(database.Tag.id.in_(new_tags))
                    .filter(database.Tag.project_id == document.project_id)
                    .all()
                )
                if set(tag.id for tag in tags) != new_tags:
                    return self.send_error_json(
                        400,
                        self.gettext("No such tag"),
                    )

                # Update tags in database
                self.db.execute(
                    database.highlight_tags.delete(
                        database.highlight_tags.c.highlight_id == hl.id
                    )
                )
                if new_tags:
                    self.db.execute(
                        database.highlight_tags.insert(),
                        [
                            dict(
                                highlight_id=hl.id,
                                tag_id=tag,
                            )
                            for tag in sorted(new_tags)
                        ],
                    )

                # Compute the change in tag counts
                tag_count_changes = {}
                for tag in old_tags - new_tags:
                    tag_in_db = self.db.query(database.Tag).get(tag)
                    tag_count_changes[tag] = {
                        'highlights_count': tag_in_db.highlights_count,
                        'documents_count': tag_in_db.documents_count
                    }

                for tag in new_tags - old_tags:
                    tag_in_db = self.db.query(database.Tag).get(tag)
                    tag_count_changes[tag] = calculate_tag_counts(self.db,
                                                                  tag_in_db,
                                                                  document)
            else:
                # Obtain old tags from database
                new_tags = set(
                    row[0]
                    for row in self.db.query(database.highlight_tags.c.tag_id)
                    .filter(database.highlight_tags.c.highlight_id == hl.id)
                    .all()
                )
                tag_count_changes = {}

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
            return self.send_error_json(403, self.gettext("Unauthorized"))
        hl = self.db.query(database.Highlight).get(int(highlight_id))
        if hl is None or hl.document_id != document.id:
            return self.send_error_json(404, self.gettext("No such highlight"))
        old_tags = [
            row[0]
            for row in self.db.query(database.highlight_tags.c.tag_id)
            .filter(database.highlight_tags.c.highlight_id == hl.id)
            .all()
        ]
        self.db.delete(hl)
        # Compute the change in tag counts for each old tag
        tag_count_changes = {}
        for tag in old_tags:
            tag_in_db = self.db.query(database.Tag).get(tag)
            tag_count_changes[tag] = calculate_tag_counts(self.db,
                                                          tag_in_db,
                                                          document,
                                                          is_deletion=True)

        cmd = database.Command.highlight_delete(
            self.current_user,
            document,
            hl.id,
        )
        cmd.tag_count_changes = tag_count_changes
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
    def get(self, project_id, paths):
        project, _ = self.get_project(project_id)
        page = self.get_query_argument('page', '1')
        try:
            page = int(page, 10) - 1
        except (ValueError, OverflowError):
            page = -1
        if page < 0:
            self.send_error_json(404, "Bad page number")

        list_of_paths, operator_type, exclude_paths = get_path_informations(
            paths)

        tag = aliased(database.Tag)
        hl_tag = aliased(database.highlight_tags)
        document = aliased(database.Document)

        # main query
        query = (
            self.db.query(database.Highlight, document.text_direction)
            .options(joinedload(database.Highlight.tags))
            .join(hl_tag, hl_tag.c.highlight_id == database.Highlight.id)
            .join(tag, hl_tag.c.tag_id == tag.id)
            .join(document, document.id == database.Highlight.document_id)
            .filter(tag.project == project)
        )

        if any(list_of_paths) and operator_type == 'or':
            query = query.filter(tag.path.in_(list_of_paths))
        elif any(list_of_paths) and operator_type == 'and':
            subquery = (self.db.query(hl_tag.c.highlight_id)
                        .join(tag, hl_tag.c.tag_id == tag.id)
                        .filter(
                tag.path.in_(list_of_paths),
                tag.project == project
            )
                .group_by(hl_tag.c.highlight_id)
                .having(
                func.count(distinct(tag.id)) == len(list_of_paths)
            )
                .subquery())
            query = query.join(
                subquery, subquery.c.highlight_id == database.Highlight.id)
        elif any(list_of_paths) and operator_type == 'mixed':
            or_conditions = []
            # check to remove  ! if necessary
            for group in list_of_paths:
                if len(group) == 1:
                    or_conditions.append(tag.path == group[0])
                else:
                    and_subquery = (self.db.query(hl_tag.c.highlight_id)
                                    .join(tag, hl_tag.c.tag_id == tag.id)
                                    .filter(tag.project == project)
                                    .filter(tag.path.in_(group))
                                    .group_by(hl_tag.c.highlight_id)
                                    .having(
                                        func.count(
                                            distinct(tag.id)) == len(group))
                                    .subquery())
                    or_conditions.append(database.Highlight.id.in_(
                        self.db.query(and_subquery.c.highlight_id)))
            if or_conditions:
                query = query.filter(or_(*or_conditions))
        else:
            # Special case to select all highlights: we also need to select
            # highlights that have no tag at all
            query = (
                self.db.query(database.Highlight, document.text_direction)
                .options(joinedload(database.Highlight.tags))
                .join(document, document.id == database.Highlight.document_id)
                .filter(document.project == project)
            )

        # Handle exclusions
        if any(exclude_paths):
            exclude_subquery = (self.db.query(hl_tag.c.highlight_id)
                                .join(tag, hl_tag.c.tag_id == tag.id)
                                .filter(tag.path.in_(exclude_paths),
                                        tag.project == project)
                                .subquery())
            query = query.filter(
                not_(database.Highlight.id.in_(exclude_subquery)))

        query = query.order_by(
            database.Highlight.document_id,
            database.Highlight.start_offset
        )

        total = query.count()
        highlights = (
            query
            .offset(page * self.PAGE_SIZE)
            .limit(self.PAGE_SIZE)
            .all()
        )

        # Group tags from identical, contained, or containing highlights
        result_highlights = []
        for hl, direction in highlights:
            all_tag_ids = set(t.id for t in hl.tags)
            
            # Find related highlights: identical, contained within, or containing this highlight
            related_highlights = (
                self.db.query(database.Highlight)
                .options(joinedload(database.Highlight.tags))
                .filter(
                    database.Highlight.document_id == hl.document_id,
                    database.Highlight.id != hl.id,
                    or_(
                        and_(
                            database.Highlight.start_offset == hl.start_offset,
                            database.Highlight.end_offset == hl.end_offset
                        ),
                        and_(
                            database.Highlight.start_offset >= hl.start_offset,
                            database.Highlight.end_offset <= hl.end_offset
                        ),
                        and_(
                            database.Highlight.start_offset <= hl.start_offset,
                            database.Highlight.end_offset >= hl.end_offset
                        )
                    )
                )
                .all()
            )
            
            for related_hl in related_highlights:
                all_tag_ids.update(t.id for t in related_hl.tags)
            
            result_highlights.append({
                'id': hl.id,
                'document_id': hl.document_id,
                'content': hl.snippet,
                'tags': sorted(all_tag_ids),
                'text_direction': direction.name,
            })

        return self.send_json({
            'highlights': result_highlights,
            'pages': math.ceil(total / self.PAGE_SIZE),
        })


class Search(BaseHandler):
    PAGE_SIZE = 5

    @api_auth
    @PROM_REQUESTS.sync('search')
    def get(self, project_id, search_text):
        project, _ = self.get_project(project_id)
        page = self.get_query_argument('page', '1')
        try:
            page = int(page, 10) - 1
        except (ValueError, OverflowError):
            page = -1
        if page < 0:
            self.send_error_json(404, self.gettext("Bad page number"))

        search_text_escaped = f"%{search_text}%"
        count_total = self.db.execute(
            'SELECT count(d.id) as count '
            'FROM documents as d '
            'WHERE d.project_id = :project_id AND '
            'LOWER(d.contents) like :search_text_escaped',
            {
                'project_id': project_id,
                'search_text_escaped': search_text_escaped,
            })
        total = (count_total.first())['count']
        # TODO: find a way to do this within SQLALchemy..
        char_length = 'CHAR_LENGTH'
        if self.application.config['DATABASE'].startswith('sqlite:'):
            char_length = 'LENGTH'
        result = self.db.execute(
            'SELECT d.id, d.name, d.contents, '
            f'(({char_length}(d.contents) - '
            f'{char_length}(REPLACE(LOWER(d.contents), :search_text, \'\'))) '
            f'/ {char_length}(:search_text)) as occurences '
            'FROM documents as d '
            'WHERE d.project_id = :project_id AND '
            'LOWER(d.contents) like :search_text_escaped '
            'ORDER BY occurences DESC '
            'LIMIT :per_page OFFSET :start', {
                'project_id': project_id,
                'search_text': search_text,
                'search_text_escaped': search_text_escaped,
                'start': page * self.PAGE_SIZE,
                'per_page': self.PAGE_SIZE
            })
        return self.send_json({
            'documents': [
                {
                    'id': d['id'],
                    'name': d['name'],
                    'occurences': d['occurences'],
                    'contents': re.sub('<[^<]+?>', '', d['contents']),
                }
                for d in result
            ],
            'nb_results': total,
            'pages': math.ceil(total / self.PAGE_SIZE),
            'search_text': search_text
        })


class PermissionsUpdate(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('permissions_update')
    def patch(self):
        user = self.db.query(database.User).get(self.current_user)
        if not user.role.can_change_role():
            return self.send_error_json(403, self.gettext(
                "Unauthorized",
            ))
        if not self.application.config['MULTIUSER']:
            raise HTTPError(404)
        obj = self.get_json()

        for login, user_info in obj.items():
            try:
                login = validate.fix_user_login(login)
            except validate.InvalidFormat as e:
                return self.send_error_json(400, self.gettext(e.message))

            try:
                role = database.Roles[user_info['privileges']]
                if role not in (database.Roles['TEAM_MEMBER'],
                                database.Roles['PROJECT_OWNER']):
                    return self.send_error_json(400, self.gettext(
                        "Bad request",
                    ))
            except KeyError:
                return self.send_error_json(
                    400,
                    "Invalid role %r" % user_info.get('privileges'),
                )
            user_to_update = self.db.query(database.User).get(login)
            user_to_update.role = role
            if role == database.Roles.TEAM_MEMBER:
                user_to_update.approved_by_user_login = None
            else:
                user_to_update.approved_by_user_login = self.current_user

        self.db.commit()
        self.set_status(204)
        return self.finish()


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
            return self.send_error_json(403, self.gettext("Unauthorized"))

        # Get all members
        members = (
            self.db.query(database.ProjectMember)
            .filter(database.ProjectMember.project_id == project.id)
        ).all()
        members = {member.user_login: member for member in members}

        # Go over the JSON patch and update
        commands = []
        for login, user_info in obj.items():
            try:
                login = validate.fix_user_login(login)
            except validate.InvalidFormat as e:
                return self.send_error_json(400, self.gettext(e.message))
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
            return self.send_error_json(
                400,
                self.gettext("There must be one admin"),
            )

        self.db.commit()
        for cmd in commands:
            self.db.refresh(cmd)
            self.application.notify_project(project.id, cmd)

        self.set_status(204)
        return self.finish()


class ProjectImport(BaseHandler):
    def prepare(self):
        user = self.db.query(database.User).get(self.current_user)
        if (not self.application.config['SQLITE3_IMPORT_ENABLED'] or
                not user.role.can_create_project()):
            raise HTTPError(403)

    @api_auth
    @PROM_REQUESTS.sync('project_import')
    async def post(self):
        try:
            file = self.request.files['file'][0]
        except (KeyError, IndexError):
            raise MissingArgumentError('file')

        with tempfile.TemporaryDirectory(
            prefix='taguette_export_',
        ) as tmp_dir:
            filename = os.path.join(tmp_dir, 'db.sqlite3')

            # Write the database to temporary file
            with open(filename, 'wb') as fp:
                fp.write(file.body)

            project_id = self.get_body_argument('project_id', None)
            if project_id is None:
                return await self._list_projects(filename)
            else:
                try:
                    project_id = int(project_id)
                except ValueError:
                    self.set_status(400)
                    return await self.send_json({
                        'error': "Invalid project ID",
                    })
                return await self._import_project(filename, project_id)

    async def _list_projects(self, filename):
        # Connect to the database
        try:
            src_db = database.connect(
                'sqlite:///%s' % filename,
                external=True,
            )()
        except database.UnknownVersion:
            return self.send_error_json(400, self.gettext(
                "This database is an unknown version. It might have been "
                + "written by a more recent version of Taguette, please check "
                + "for updates",
            ))
        except alembic.util.exc.CommandError:
            return self.send_error_json(500, self.gettext(
                "This database could not be updated to the current version",
            ))
        except (DatabaseError, NoSuchTableError):
            return self.send_error_json(400, self.gettext(
                "This is not a Taguette project file",
            ))

        # List projects
        projects = src_db.execute(database.Project.__table__.select())
        output = False
        for i, row in enumerate(projects):
            if not output:
                self.set_header(
                    'Content-Type', 'application/json; charset=utf-8',
                )
                self.write('{"projects": [')
                output = True
            else:
                self.write(',')
            self.write(json.dumps({
                'id': row['id'],
                'name': row['name'],
            }))
            if i == 100:
                await self.flush()
        if not output:
            self.write('{"projects": [')
        return await self.finish(']}')

    async def _import_project(self, filename, project_id):
        # Connect to the database
        try:
            src_db = database.connect(
                'sqlite:///%s' % filename,
                external=True,
            )()
        except (DatabaseError, NoSuchTableError):
            return self.send_error_json(400, self.gettext(
                "This is not a Taguette project file",
            ))

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


class TooManyCommands(Exception):
    """There are too many commands, have the client reload instead.
    """


class ProjectEvents(BaseHandler):
    response_cancelled = False
    polling_clients = set()
    PROM_POLLING_CLIENTS.set_function(
        lambda: len(ProjectEvents.polling_clients)
    )

    wait_future = None

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

        client_version = self.get_query_argument('version', None)
        if client_version != exact_version():
            return await self.send_json({'reload': True})

        from_id = int(self.get_query_argument('from'))
        project, _ = self.get_project(project_id)
        self.project_id = int(project_id)

        try:
            cmds_json = await self._get_commands(project.id, from_id)
        except TooManyCommands:
            return await self.send_json({'reload': True})
        except asyncio.CancelledError:
            return

        # Remove 'project_id' from each event
        def _change_cmd_json(old):
            new = dict(old)
            new.pop('project_id')
            return new

        cmds_json = [_change_cmd_json(cmd) for cmd in cmds_json]

        tornado.log.access_log.info(cmds_json)

        return await self.send_json({'events': cmds_json})

    async def _get_commands(self, project_id, from_id):
        # Limit over which we won't send update but rather reload the frontend
        LIMIT = 20

        # Check for immediate update
        cmds = (
            self.db.query(database.Command)
            .filter(database.Command.id > from_id)
            .filter(database.Command.project_id == project_id)
            .limit(LIMIT)
        ).all()

        if len(cmds) >= LIMIT:
            raise TooManyCommands

        if cmds:
            # Convert to JSON, return
            return [cmd.to_json() for cmd in cmds]

        # Subscribe for events (which come as JSON)
        self.wait_future = Future()
        recheck = await self.application.observe_project(
            project_id,
            self.wait_future,
        )

        # Check again, if necessary
        if recheck:
            cmds = (
                self.db.query(database.Command)
                .filter(database.Command.id > from_id)
                .filter(database.Command.project_id == project_id)
                .limit(LIMIT)
            ).all()
            if cmds:
                # Events happened while we were subscribing:
                # Cancel subscription, return them
                self.wait_future.cancel()
                self.application.unobserve_project(
                    self.project_id,
                    self.wait_future,
                )
                self.wait_future = None
                return [cmd.to_json() for cmd in cmds]

        self.db.expire_all()

        # Close DB connection to not overflow the connection pool
        self.close_db_connection()

        return [await self.wait_future]

    def on_connection_close(self):
        self.response_cancelled = True
        if self.wait_future:
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


class CreateCollection(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('create_collection')
    def post(self, project_id):
        project, privileges = self.get_project(project_id)
        if not privileges.can_add_document():
            return self.send_error_json(403, self.gettext("Unauthorized"))
        try:
            obj = self.get_json()
            name = obj.get('name', '').strip()
            description = obj.get('description', '').strip(
            ) if 'description' in obj else ''
            parent_id = obj.get('parent_id', None)

            if not name:
                return self.send_error_json(
                    400,
                    self.gettext("Collection name is required"))

            if parent_id is not None:
                parent_collection = (self.db.query(database.Collection)
                                     .filter_by(
                                         id=parent_id,
                                         project_id=project.id)
                                     .first())
                if not parent_collection:
                    return self.send_error_json(
                        400,
                        self.gettext("Parent collection not found"))

            collection = database.Collection(
                name=name,
                description=description,
                project_id=project.id,
                owner_login=self.current_user,
                parent_id=parent_id
            )
            self.db.add(collection)
            self.db.flush()
            document_ids = obj.get('document_ids', [])
            for doc_id in document_ids:
                document = self.db.query(database.Document).filter_by(
                    id=doc_id, project_id=project.id).first()
                if document:
                    document.collections.clear()
                    collection.documents.append(document)

            cmd = database.Command.collection_add(
                self.current_user,
                collection,
            )
            self.db.add(cmd)
            self.db.commit()
            self.db.refresh(cmd)
            self.application.notify_project(project.id, cmd)
            self.db.refresh(collection)
            return self.send_json({
                'id': collection.id,
                'name': collection.name,
                'description': collection.description,
                'created': collection.created.isoformat(),
            })
        except Exception as e:
            logger.exception("Error creating collection")
            return self.send_error_json(
                500, self.gettext("Internal error: ") + str(e))


class CollectionUpdate(BaseHandler):
    @api_auth
    @PROM_REQUESTS.sync('collection_update')
    def post(self, project_id, collection_id):
        project, privileges = self.get_project(project_id)
        if not privileges.can_edit_document():
            return self.send_error_json(403, self.gettext("Unauthorized"))
        try:
            obj = self.get_json()
            collection = (self.db.query(database.Collection)
                          .get(int(collection_id)))
            if collection is None or collection.project_id != project.id:
                return self.send_error_json(
                    404,
                    self.gettext("No such collection"))
            if obj:
                if 'name' in obj:
                    if not obj['name'].strip():
                        return self.send_error_json(
                            400,
                            self.gettext("Collection name is required"))
                    collection.name = obj['name'].strip()
                if 'description' in obj:
                    validate.description(obj['description'])
                    collection.description = obj['description']
                if 'parent_id' in obj:
                    parent_id = obj['parent_id']
                    if parent_id is not None:
                        parent_collection = (self.db.query(database.Collection)
                                             .filter_by(
                                                 id=parent_id,
                                                 project_id=project.id)
                                             .first())
                        if not parent_collection:
                            return self.send_error_json(
                                400,
                                self.gettext("Parent collection not found"))
                        if parent_id == collection.id:
                            return self.send_error_json(
                                400,
                                self.gettext("Collection cannot be its own "
                                             "parent"))
                        if self._would_create_circular_reference(
                                collection, parent_id):
                            return self.send_error_json(
                                400,
                                self.gettext("Would create circular "
                                             "reference"))
                    collection.parent_id = parent_id
                if 'document_ids' in obj:
                    collection.documents = []
                    for doc_id in obj['document_ids']:
                        document = (self.db.query(database.Document)
                                    .filter_by(
                            id=doc_id,
                            project_id=project.id)
                            .first())
                        if document:
                            collection.documents.append(document)

                cmd = database.Command.collection_update(
                    self.current_user,
                    collection,
                )
                self.db.add(cmd)
                self.db.commit()
                self.db.refresh(cmd)
                self.application.notify_project(project.id, cmd)
                self.db.refresh(collection)

                return self.send_json({
                    'id': collection.id,
                    'name': collection.name,
                    'description': collection.description,
                    'parent_id': collection.parent_id,
                    'document_ids': [d.id for d in collection.documents]
                })
        except validate.InvalidFormat as e:
            logger.info("Error validating CollectionUpdate: %r", e)
            return self.send_error_json(400, self.gettext(e.message))
        except Exception as e:
            logger.exception("Error updating collection")
            return self.send_error_json(
                500, self.gettext("Internal error: ") + str(e))

    def _would_create_circular_reference(self, collection, new_parent_id):
        # Prevent loops: A → B → C → A
        current_id = new_parent_id
        while current_id is not None:
            if current_id == collection.id:  # Loop detected!
                return True
            parent_collection = (self.db.query(database.Collection)
                                 .filter_by(
                                     id=current_id,
                                     project_id=collection.project_id)
                                 .first())
            if not parent_collection:
                break
            current_id = parent_collection.parent_id  # Go up hierarchy
        return False

    @api_auth
    @PROM_REQUESTS.sync('collection_delete')
    def delete(self, project_id, collection_id):
        project, privileges = self.get_project(project_id)
        if not privileges.can_edit_document():
            return self.send_error_json(403, self.gettext("Unauthorized"))
        collection = (self.db.query(database.Collection)
                      .get(int(collection_id)))
        if collection is None or collection.project_id != project.id:
            return self.send_error_json(404,
                                        self.gettext("No such collection"))

        delete_mode = self.get_argument('delete_mode', default=None)

        children = (self.db.query(database.Collection)
                    .options(joinedload(database.Collection.documents))
                    .filter_by(parent_id=collection.id)
                    .all())

        if children and delete_mode is None:
            return self.send_error_json(
                400, self.gettext("Cannot delete collection with "
                                  "subcollections. "
                                  "Please specify delete_mode."))

        commands_to_notify = []

        if delete_mode == 'cascade':
            commands_to_notify = self._delete_collection_cascade(collection)
        elif delete_mode == 'orphan':
            for child in children:
                child.parent_id = None
                self.db.add(child)

            self.db.flush()

            for child in children:
                self.db.refresh(child)
                update_cmd = database.Command.collection_update(
                    self.current_user,
                    child,
                )
                self.db.add(update_cmd)
                commands_to_notify.append(update_cmd)

            cmd = database.Command.collection_delete(
                self.current_user,
                collection,
            )
            self.db.add(cmd)
            self.db.delete(collection)
            commands_to_notify.append(cmd)
        else:
            cmd = database.Command.collection_delete(
                self.current_user,
                collection,
            )
            self.db.add(cmd)
            self.db.delete(collection)
            commands_to_notify = [cmd]

        self.db.commit()

        for cmd in commands_to_notify:
            self.db.refresh(cmd)
            self.application.notify_project(project.id, cmd)

        self.set_status(204)
        return self.finish()

    def _delete_collection_cascade(self, collection):

        commands = []

        children = (self.db.query(database.Collection)
                    .filter_by(parent_id=collection.id)
                    .all())

        for child in children:
            child_commands = self._delete_collection_cascade(child)
            commands.extend(child_commands)

        cmd = database.Command.collection_delete(
            self.current_user,
            collection,
        )
        self.db.add(cmd)
        commands.append(cmd)

        self.db.delete(collection)

        return commands
