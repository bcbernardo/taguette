from collections import defaultdict
import logging
import opentelemetry.trace

from .models import (Project, Privileges, ProjectMember, TextDirection,
                     Document, Command, Highlight, Tag, highlight_tags, 
                     Collection, collection_documents)
from .. import convert
from ..utils import DefaultMap
from .. import validate

logger = logging.getLogger(__name__)
tracer = opentelemetry.trace.get_tracer(__name__)


@tracer.start_as_current_span('taguette/copy_project')
def copy_project(
        src_db, dest_db,
        project_id, user_login,
):
    def copy(
            table, pkey, fkeys, size,
            *, condition=None, transform=None, validators=None
    ):
        return copy_table(
            src_db, dest_db,
            table, pkey, fkeys,
            batch_size=size,
            condition=condition, transform=transform, validators=validators,
        )

    def insert(table, values):
        ins = dest_db.execute(
            table.insert(),
            values,
        )
        return ins

    # Copy project
    project = src_db.execute(
        Project.__table__.select().where(Project.id == project_id)
    ).fetchone()
    if project is None:
        raise KeyError("project ID not found")
    validate.project_name(project['name'])
    validate.description(project['description'])
    project = dict(project)
    project.pop('id')
    new_project_id, = insert(Project.__table__, project).inserted_primary_key
    mapping_project = {project_id: new_project_id}

    # Add member
    insert(
        ProjectMember.__table__,
        dict(
            project_id=new_project_id,
            user_login=user_login,
            privileges=Privileges.ADMIN,
        ),
    )

    # Copy documents
    mapping_document = copy(
        Document.__table__, 'id',
        dict(project_id=mapping_project),
        2,
        condition=Document.project_id == project_id,
        validators=dict(
            name=validate.document_name,
            description=validate.description,
            filename=validate.filename,
            contents=convert.is_html_safe,
        ),
    )

    # Update parent_id with new pk
    def transform_tag(row, mapping):
        if 'parent_id' in row and row['parent_id'] in mapping:
            row['parent_id'] = mapping[row['parent_id']]
        return row

    def transform_collection(row, mapping):
        if 'parent_id' in row and row['parent_id'] in mapping:
            row['parent_id'] = mapping[row['parent_id']]
        return {**row, 'owner_login': None}

    # Copy tags
    mapping_tags = copy(
        Tag.__table__, 'id',
        dict(project_id=mapping_project),
        50,
        condition=Tag.project_id == project_id,
        validators=dict(
            path=validate.tag_path,
            description=validate.description,
            color=validate.color
        ),
        transform=transform_tag
    )

    # Copy highlights
    mapping_highlights = copy(
        Highlight.__table__, 'id',
        dict(document_id=mapping_document),
        50,
        condition=Highlight.document_id.in_(mapping_document.keys()),
        validators=dict(
            start_offset=lambda v: isinstance(v, int) and v >= 0,
            end_offset=lambda v: isinstance(v, int) and v > 0,
            snippet=convert.is_html_safe,
        ),
    )

    # Copy highlight tags
    copy(
        highlight_tags, None,
        dict(highlight_id=mapping_highlights, tag_id=mapping_tags),
        200,
        condition=highlight_tags.c.tag_id.in_(mapping_tags.keys()),
    )

    # Copy collections
    mapping_collections = copy(
        Collection.__table__, 'id',
        dict(project_id=mapping_project),
        50,
        condition=Collection.project_id == project_id,
        validators=dict(
            name=lambda v: isinstance(v, str) and len(v.strip()) > 0,
            description=lambda v: v is None or isinstance(v, str),
        ),
        transform=transform_collection
    )

    # Copy collection documents association
    copy(
        collection_documents, None,
        dict(collection_id=mapping_collections, document_id=mapping_document),
        200,
        condition=collection_documents.c.collection_id.in_(
            mapping_collections.keys()),
    )

    def validate_text_direction(direction):
        try:
            TextDirection[direction]
        except KeyError:
            raise ValueError("Invalid text direction")
        return True

    # Copy commands
    def transform_command(cmd, mapping):
        payload = cmd['payload']
        if payload['type'] not in Command.TYPES:
            raise ValueError("Unknown command %r" % payload['type'])

        method = getattr(Command, payload['type'])
        expected_columns = (
            set(method.columns)
            | {'date', 'user_login', 'payload'}
        )

        # Keep expected_payload_fields = set(method.payload_fields) | {'type'}

        # Check that the right columns are set
        if {k for k, v in cmd.items() if v is not None} != expected_columns:
            raise ValueError("Command doesn't have expected columns")

        # Remove check that the right JSON fields are set to allow importation
        # if payload.keys() != expected_payload_fields:
        #     raise ValueError("Command doesn't have expected fields")

        # Map an ID, using negative ID if it's unknown
        def mv(mapping, value):
            return mapping.get(value, -abs(value))

        field_validators = dict(
            type=lambda v: True,  # Already checked above
            description=validate.description,
            project_name=validate.project_name,
            document_name=validate.document_name,
            text_direction=validate_text_direction,
            highlight_id=lambda v: isinstance(v, int),
            start_offset=lambda v: isinstance(v, int) and v >= 0,
            end_offset=lambda v: isinstance(v, int) and v > 0,
            tags=lambda v: (
                isinstance(v, list)
                and all(isinstance(e, int) for e in v)
            ),
            tag_parent=lambda v: (
                v is None or isinstance(v, int)
            ),
            favorite=lambda v: (
                v is None or isinstance(v, bool)
            ),
            tag_id=lambda v: isinstance(v, int),
            tag_path=validate.tag_path,
            tag_color=validate.color,
            src_tag_id=lambda v: isinstance(v, int),
            dest_tag_id=lambda v: isinstance(v, int),
            member=validate.user_login,
            privileges=lambda v: v in Privileges.__members__,
            # Collections fields
            collections=lambda v: (
                isinstance(v, list)
                and all(isinstance(e, int) for e in v)
            ),
            collection_id=lambda v: isinstance(v, int),
            collection_name=lambda v: isinstance(
                v, str) and len(v.strip()) > 0,
            parent_id=lambda v: (
                v is None or isinstance(v, int) or (
                    isinstance(v, str) and v.isdigit())
            ),
            document_ids=lambda v: (
                isinstance(v, list)
                and all(isinstance(e, int) for e in v)
            ),
        )

        field_transformers = dict(
            highlight_id=lambda v: mv(mapping_highlights, v),
            tag_id=lambda v: mv(mapping_tags, v),
            src_tag_id=lambda v: mv(mapping_tags, v),
            tags=lambda tags: [mv(mapping_tags, t) for t in tags],
            # Collections transformers
            collections=lambda collections: [
                mv(mapping_collections, c) for c in collections],
            collection_id=lambda v: mv(mapping_collections, v),
            parent_id=lambda v: mv(mapping_collections, int(
                v)) if v is not None else None,
            document_ids=lambda document_ids: [
                mv(mapping_document, d) for d in document_ids],
        )

        # Map JSON fields
        for field, value in list(payload.items()):
            try:
                if (field in field_validators and 
                not field_validators[field](value)):
                    print(field, value)
                    if field == 'parent_id':
                        print("mapping_collections:", mapping_collections)
                        print("validation result:",
                              field_validators[field](value))
                        print("value type:", type(value))
                    raise ValueError("Invalid field %r in command" % field)
            except validate.InvalidFormat:
                raise ValueError("Invalid field %r in command" % field)
            if field in field_transformers:
                payload[field] = field_transformers[field](value)

        return dict(cmd.items(), payload=payload)

    copy(
        Command.__table__, 'id',
        dict(
            # Map all users to the importing user
            user_login=DefaultMap(lambda key: user_login, {}),
            project_id=mapping_project,
            # Map None to None and unknown keys (deleted documents) to negative
            document_id=DefaultMap(
                lambda key: None if key is None else -abs(key),
                mapping_document,
            ),
        ),
        100,
        condition=Command.project_id == project_id,
        transform=transform_command,
    )

    dest_db.commit()

    return new_project_id


def copy_table(
    src_db, dest_db, table,
    pkey, fkeys,
    *, batch_size=1000, condition=None, transform=None, validators=None
):
    """Copy all data in a table across database connections.

    :param src_db: The SQLAlchemy ``Connection`` or ``Session`` to copy from.
    :param dest_db: The SQLAlchemy ``Connection`` or ``Session`` to copy into.
    :param table: The SQLAlchemy ``Table`` we are copying. It should exist on
        both the source and destination databases.
    :param pkey: The field in the table that is the primary key and should be
        reset during the copy (so new values get generated when inserting in
        the destination and no conflict occurs).
    :param fkeys: A dictionary associating the name of the fields that are
        foreign keys to a dictionary mapping the keys.
    :param transform: Function to apply on each row.
    """

    from .models import Tag
    from sqlalchemy import func

    query = table.select()
    if pkey is not None:
        query = query.order_by(pkey)
    if condition is not None:
        query = query.where(condition)

    if table == Tag.__table__ or table == Collection.__table__:
        count_query = src_db.execute(
            func.count().select().select_from(query.alias()))
        total_rows = count_query.scalar()
        batch_size = total_rows + 1
    query = src_db.execute(query)
    assert pkey is None or pkey in query.keys()
    assert all(field in query.keys() for field in fkeys)
    mapping = {}
    while True:
        batch = query.fetchmany(batch_size)
        if not batch:
            break

        rows = [dict(row) for row in batch]

        if table == Tag.__table__ or table == Collection.__table__:
            roots, hierarchies = build_hierarchies(rows)
            insert_hierarchically(
                dest_db,
                roots,
                hierarchies,
                mapping,
                table,
                pkey,
                fkeys,
                transform,
                validators
            )
        else:
            insert_rows(dest_db, rows, table, pkey, fkeys,
                        transform, validators, mapping)

    return mapping


def build_hierarchies(items):
    """Build a hierarchy for items with parent_id relationships."""
    hierarchies = defaultdict(list)
    roots = []
    for item in items:
        if item['parent_id'] is None:
            roots.append(item)
        else:
            hierarchies[item['parent_id']].append(item)
    return roots, hierarchies


def validate_item(item, validators):
    """Validate an item against the provided validators."""
    if validators:
        for key, value in item.items():
            if key in validators:
                if not validators[key](value):
                    raise ValueError(
                        f"Data failed validation (column {key})")


def prepare_item_for_insertion(item, pkey, fkeys, transform, mapping):
    """Prepare an item for insertion by removing pkey, mapping foreign keys,
    and applying transform."""
    item_id = item[pkey]
    # Get primary key, remove it
    if pkey is not None:
        item.pop(pkey)
    # Map foreign keys
    for field, fkey_map in fkeys.items():
        item[field] = fkey_map[item[field]]
    # Generic transform
    if transform is not None:
        item = transform(item, mapping)
    return item_id, item


def insert_hierarchically(dest_db, roots, hierarchies, mapping,
                          table, pkey, fkeys, transform, validators):
    """Insert items recursively to respect parent-child relationships."""
    for item in roots:
        item_id, prepared_item = prepare_item_for_insertion(
            item, pkey, fkeys, transform, mapping)
        # Validate
        validate_item(prepared_item, validators)
        # Have to insert one-by-one for inserted_primary_key
        ins = dest_db.execute(table.insert(), prepared_item)
        # Store new primary key
        if pkey is not None:
            mapping[item_id], = ins.inserted_primary_key
        if item_id in hierarchies:
            insert_hierarchically(
                dest_db,
                hierarchies[item_id],
                hierarchies,
                mapping,
                table,
                pkey,
                fkeys,
                transform,
                validators)


def insert_rows(dest_db,
                rows,
                table,
                pkey,
                fkeys,
                transform,
                validators,
                mapping):
    """Insert rows into the destination database."""
    for row in rows:
        orig_pkey = 0
        # Get primary key, remove it
        if pkey is not None:
            orig_pkey = row[pkey]
            row.pop(pkey)
        # Map foreign keys
        for field, fkey_map in fkeys.items():
            row[field] = fkey_map[row[field]]
        # Generic transform
        if transform is not None:
            row = transform(row, mapping)
        # Validate
        validate_item(row, validators)
        # Have to insert one-by-one for inserted_primary_key
        ins = dest_db.execute(table.insert(), row)
        # Store new primary key
        if pkey is not None:
            mapping[orig_pkey], = ins.inserted_primary_key
