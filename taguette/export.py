import asyncio
import contextlib
import csv
import importlib_resources
import jinja2
import sqlalchemy
from markupsafe import Markup
import opentelemetry.trace
from sqlalchemy.orm import joinedload
import uuid
import xlsxwriter
from xml.sax.saxutils import XMLGenerator
from xml.sax.xmlreader import AttributesNSImpl

from . import exact_version
from . import convert
from . import database
from . import extract


tracer = opentelemetry.trace.get_tracer(__name__)


template_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(
        [importlib_resources.files('taguette').joinpath('templates')],
    ),
    autoescape=jinja2.select_autoescape(['html']),
    extensions=['jinja2.ext.i18n'],
)


def _render_string(template_name, locale, **kwargs):
    translator = _Translator(locale)

    template = template_env.get_template(template_name)
    return template.render(
        version=exact_version(),
        gettext=translator.gettext,
        ngettext=translator.ngettext,
        pgettext=translator.pgettext,
        **kwargs,
    )


class _Translator(object):
    def __init__(self, locale):
        self.locale = locale

    def gettext(self, message, **kwargs):
        trans = self.locale.translate(message)
        if kwargs:
            trans = trans % kwargs
        return trans

    def ngettext(self, singular, plural, n, **kwargs):
        trans = self.locale.translate(singular, plural, n)
        if kwargs:
            trans = trans % kwargs
        return trans

    def pgettext(
        self,
        context, message, plural_message=None,
        n=None,
        **kwargs,
    ):
        trans = self.locale.pgettext(context, message, plural_message, n)
        if kwargs:
            trans = trans % kwargs
        return trans


class TagExportInfo(str):
    """String subclass that carries hierarchy metadata for exports."""
    def __new__(cls, path, parent, full_path, description, tag_id=None):
        obj = str.__new__(cls, path)
        obj.path = path
        obj.parent = parent
        obj.full_path = full_path
        obj.description = description
        obj.tag_id = tag_id
        return obj

    def __getitem__(self, item):
        return getattr(self, item)


def _get_highlights_for_export(db, project_id, path):
    # Fetch all project tags to resolve parents and full paths efficiently
    tag_dict = {
        t.id: t
        for t in (
            db.query(database.Tag)
            .filter(database.Tag.project_id == project_id)
            .all()
        )
    }

    t_highlight = database.Highlight.__table__
    t_highlight_tag = database.highlight_tags
    t_tag = database.Tag.__table__
    t_document = database.Document.__table__

    if path:
        matching_tag_ids = set()
        for t in tag_dict.values():
            if (
                t.path == path
                or t.path.startswith(path)
                or t.full_path().startswith(path)
            ):
                def collect_descendant_ids(node):
                    matching_tag_ids.add(node.id)
                    for child in node.children:
                        collect_descendant_ids(child)
                collect_descendant_ids(t)

        t_highlight_tag_m = database.highlight_tags.alias()
        query = (
            sqlalchemy.select([
                t_highlight.c.id,
                t_highlight.c.snippet,
                t_document.c.name,
                t_tag.c.id,
            ])
            .select_from(
                t_highlight
                .join(
                    t_highlight_tag,
                    t_highlight.c.id == t_highlight_tag.c.highlight_id,
                )
                .join(
                    t_tag,
                    t_tag.c.id == t_highlight_tag.c.tag_id,
                )
                .join(
                    t_highlight_tag_m,
                    t_highlight.c.id == t_highlight_tag_m.c.highlight_id,
                )
                .join(
                    t_document,
                    t_document.c.id == t_highlight.c.document_id,
                )
            )
            .where(t_highlight_tag_m.c.tag_id.in_(matching_tag_ids))
            .where(t_document.c.project_id == project_id)
            .order_by(
                t_highlight.c.document_id,
                t_highlight.c.start_offset,
                t_highlight.c.id,
            )
        )
    else:
        # Special case: select all highlights even if untagged
        query = (
            sqlalchemy.select([
                t_highlight.c.id,
                t_highlight.c.snippet,
                t_document.c.name,
                t_tag.c.id,
            ])
            .select_from(
                t_highlight
                .outerjoin(
                    t_highlight_tag,
                    t_highlight.c.id == t_highlight_tag.c.highlight_id,
                )
                .outerjoin(
                    t_tag,
                    t_tag.c.id == t_highlight_tag.c.tag_id,
                )
                .join(
                    t_document,
                    t_document.c.id == t_highlight.c.document_id,
                )
            )
            .where(t_document.c.project_id == project_id)
            .order_by(
                t_highlight.c.document_id,
                t_highlight.c.start_offset,
                t_highlight.c.id,
            )
        )

    highlights = []
    for row in db.execute(query).fetchall():
        highlight_id, snippet, document, tag_id = row
        tag_obj = tag_dict.get(tag_id)
        if tag_obj:
            parent_name = tag_obj.parent.path if tag_obj.parent else ''
            tag_info = TagExportInfo(
                tag_obj.path,
                parent_name,
                tag_obj.full_path(),
                tag_obj.description,
                tag_obj.id,
            )
        else:
            tag_info = None

        if highlights and highlights[-1][0] == highlight_id:
            if tag_info is not None:
                highlights[-1][3].append(tag_info)
        else:
            highlights.append((
                highlight_id,
                snippet,
                document,
                [] if tag_info is None else [tag_info],
            ))

    return highlights


def get_filename_for_highlights_export(path):
    """Get a suitable filename for exported highlights.
    """
    if path:
        return None
    else:
        return 'all_tags'


@tracer.start_as_current_span('taguette/export/highlights_csv')
def highlights_csv(db, project_id, path, file):
    """Export highlights to a CSV file.
    """
    highlights = _get_highlights_for_export(db, project_id, path)
    writer = csv.writer(file)
    writer.writerow([
        'id', 'document', 'tag', 'tag_parent', 'tag_full_path',
        'tag_description', 'content',
    ])
    for id, snippet, document, tags in highlights:
        text = convert.html_to_plaintext(snippet)
        if not tags:
            writer.writerow([
                id, document, '', '', '', '', text,
            ])
        else:
            for tag in tags:
                writer.writerow([
                    id, document,
                    tag.path, tag.parent, tag.full_path, tag.description,
                    text,
                ])


@tracer.start_as_current_span('taguette/export/highlights_xlsx')
def highlights_xslx(db, project_id, path, filename):
    """Export highlights to an Excel file.
    """
    highlights = _get_highlights_for_export(db, project_id, path)

    workbook = xlsxwriter.Workbook(filename)
    sheet = workbook.add_worksheet('highlights')

    header = workbook.add_format({'bold': True})

    sheet.write(0, 0, 'id', header)
    sheet.write(0, 1, 'document', header)
    sheet.write(0, 2, 'tag', header)
    sheet.write(0, 3, 'tag_parent', header)
    sheet.write(0, 4, 'tag_full_path', header)
    sheet.write(0, 5, 'tag_description', header)
    sheet.write(0, 6, 'content', header)
    sheet.set_column(0, 0, 8.0)
    sheet.set_column(1, 1, 20.0)
    sheet.set_column(2, 2, 25.0)
    sheet.set_column(3, 3, 25.0)
    sheet.set_column(4, 4, 45.0)
    sheet.set_column(5, 5, 35.0)
    sheet.set_column(6, 6, 80.0)
    row = 1
    for id, snippet, document, tags in highlights:
        text = convert.html_to_plaintext(snippet)
        if not tags:
            sheet.write(row, 0, str(id))
            sheet.write(row, 1, document)
            sheet.write(row, 2, '')
            sheet.write(row, 3, '')
            sheet.write(row, 4, '')
            sheet.write(row, 5, '')
            sheet.write(row, 6, text)
            row += 1
        else:
            for tag in tags:
                sheet.write(row, 0, str(id))
                sheet.write(row, 1, document)
                sheet.write(row, 2, tag.path)
                sheet.write(row, 3, tag.parent)
                sheet.write(row, 4, tag.full_path)
                sheet.write(row, 5, tag.description)
                sheet.write(row, 6, text)
                row += 1
    workbook.close()


@tracer.start_as_current_span('taguette/export/highlights_doc')
def highlights_doc(db, project_id, path, ext, *, config, locale):
    """Export highlights to a text document.
    """
    highlights = _get_highlights_for_export(db, project_id, path)

    html = _render_string(
        'export_highlights.html',
        locale,
        path=path,
        highlights=highlights,
    )

    mimetype, contents = convert.html_to(html, ext, config)
    return mimetype, contents


@tracer.start_as_current_span('taguette/export/highlighted_document')
async def highlighted_document(db, document, ext, *, config, locale):
    """Export a document annotated with highlights.

    Each highlight is followed by its tags in brackets.
    """
    highlights = (
        db.query(database.Highlight)
        .filter(database.Highlight.document_id == document.id)
        .order_by(database.Highlight.start_offset)
        .options(joinedload(database.Highlight.tags))
    ).all()

    highlights = [
        (hl.start_offset, hl.end_offset, [t.path for t in hl.tags])
        for hl in highlights
    ]

    html = await asyncio.get_event_loop().run_in_executor(
        None,
        lambda: extract.highlight(
            document.contents, highlights,
            show_tags=True,
        ),
    )

    html = _render_string(
        'export_document.html',
        locale,
        name=document.name,
        contents=Markup(html),
    )

    mimetype, contents = convert.html_to(
        html, ext,
        config,
    )
    contents = await contents
    return mimetype, contents


TAGUETTE_NAMESPACE = uuid.UUID('51B2B2B7-27EB-4ECB-9D56-E75B0A0496C2')


@tracer.start_as_current_span('taguette/export/codebook_xml')
def codebook_xml(tags, file):
    """Export a codebook in REFI-QDA format for the given tags.
    """
    with contextlib.ExitStack() as stack:
        if not hasattr(file, 'write'):
            file = stack.enter_context(open(file, 'wb'))

        # http://schema.qdasoftware.org/versions/Codebook/v1.0/Codebook.xsd
        output = XMLGenerator(
            file,
            encoding='utf-8',
            short_empty_elements=True,
        )
        output.startDocument()
        output.startPrefixMapping(None, 'urn:QDA-XML:codebook:1.0')
        output.startElementNS(
            (None, 'CodeBook'), 'CodeBook',
            AttributesNSImpl(
                {(None, 'origin'): 'Taguette %s' % exact_version()},
                {(None, 'origin'): 'origin'},
            ),
        )
        output.startElementNS(
            (None, 'Codes'), 'Codes',
            AttributesNSImpl({}, {}),
        )
        for tag in tags:
            guid = uuid.uuid5(TAGUETTE_NAMESPACE, tag.path)
            guid = str(guid).upper()
            output.startElementNS(
                (None, 'Code'), 'Code',
                AttributesNSImpl({(None, 'guid'): guid,
                                  (None, 'name'): tag.path,
                                  (None, 'isCodable'): 'true'},
                                 {(None, 'guid'): 'guid',
                                  (None, 'name'): 'name',
                                  (None, 'isCodable'): 'isCodable'}),
            )
            output.endElementNS((None, 'Code'), 'Code')
        output.endElementNS((None, 'Codes'), 'Codes')
        output.startElementNS(
            (None, 'Sets'), 'Sets',
            AttributesNSImpl({}, {}),
        )
        output.endElementNS((None, 'Sets'), 'Sets')
        output.endElementNS((None, 'CodeBook'), 'CodeBook')
        output.endPrefixMapping(None)
        output.endDocument()


@tracer.start_as_current_span('taguette/export/codebook_csv')
def codebook_csv(tags, file):
    """Export a codebook in CSV format for the given tags.
    """
    with contextlib.ExitStack() as stack:
        if not hasattr(file, 'write'):
            file = stack.enter_context(open(file, 'w'))

        writer = csv.writer(file)
        writer.writerow([
            'tag',
            'tag_parent',
            'tag_full_path',
            'description',
            'number of highlights',
            'number of documents',
        ])
        for tag in tags:
            parent_name = tag.parent.path if tag.parent else ''
            writer.writerow([
                tag.path,
                parent_name,
                tag.full_path(),
                tag.description,
                tag.highlights_count,
                tag.documents_count,
            ])


@tracer.start_as_current_span('taguette/export/codebook_xlsx')
def codebook_xlsx(tags, filename):
    """Export a codebook in Excel format for the given tags.
    """
    workbook = xlsxwriter.Workbook(filename)
    sheet = workbook.add_worksheet('codebook')

    header = workbook.add_format({'bold': True})

    sheet.write(0, 0, 'tag', header)
    sheet.write(0, 1, 'tag_parent', header)
    sheet.write(0, 2, 'tag_full_path', header)
    sheet.write(0, 3, 'description', header)
    sheet.write(0, 4, 'number of highlights', header)
    sheet.write(0, 5, 'number of documents', header)
    sheet.set_column(0, 0, 25.0)
    sheet.set_column(1, 1, 25.0)
    sheet.set_column(2, 2, 45.0)
    sheet.set_column(3, 3, 60.0)
    sheet.set_column(4, 4, 20.0)
    sheet.set_column(5, 5, 20.0)
    for row, tag in enumerate(tags, start=1):
        parent_name = tag.parent.path if tag.parent else ''
        sheet.write(row, 0, tag.path)
        sheet.write(row, 1, parent_name)
        sheet.write(row, 2, tag.full_path())
        sheet.write(row, 3, tag.description)
        sheet.write(row, 4, tag.highlights_count)
        sheet.write(row, 5, tag.documents_count)
    workbook.close()


@tracer.start_as_current_span('taguette/export/codebook_document')
async def codebook_document(tags, ext, *, config, locale):
    """Export a codebook as a text document for the given tags.
    """
    html = _render_string(
        'export_codebook.html',
        locale,
        tags=tags,
    )

    mimetype, contents = convert.html_to(
        html, ext,
        config,
    )
    contents = await contents
    return mimetype, contents
