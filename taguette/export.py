import asyncio
import contextlib
import csv
import jinja2
import pkg_resources
from markupsafe import Markup
import opentelemetry.trace
from sqlalchemy import not_, func, distinct, or_
from sqlalchemy import and_, select, exists
from sqlalchemy.orm import joinedload
import uuid
import xlsxwriter
from xml.sax.saxutils import XMLGenerator
from xml.sax.xmlreader import AttributesNSImpl

from . import exact_version
from . import convert
from . import database
from . import extract
from .utils import get_path_informations

tracer = opentelemetry.trace.get_tracer(__name__)

template_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(
        [pkg_resources.resource_filename('taguette', 'templates')]
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


def _get_highlights_for_export(db, project_id, paths):
    list_of_paths, operator_type, exclude_paths = get_path_informations(paths)

    t_highlight = database.Highlight.__table__
    t_highlight_tag = database.highlight_tags
    t_tag = database.Tag.__table__
    t_document = database.Document.__table__
    t_highlight_tag_m = t_highlight_tag.alias()
    t_tag_m = t_tag.alias()

    # Base query setup
    query = select([
        t_highlight.c.id,
        t_highlight.c.snippet,
        t_document.c.name,
        t_tag.c.path,
    ]).select_from(
        t_highlight
        .join(t_highlight_tag,
              t_highlight.c.id == t_highlight_tag.c.highlight_id)
        .join(t_tag, t_tag.c.id == t_highlight_tag.c.tag_id)
        .join(t_document, t_document.c.id == t_highlight.c.document_id)
    ).where(t_document.c.project_id == project_id)

    if operator_type == 'or' and any(list_of_paths):
        query = query.join(
            t_highlight_tag_m,
            t_highlight.c.id == t_highlight_tag_m.c.highlight_id
        ).join(
            t_tag_m, t_tag_m.c.id == t_highlight_tag_m.c.tag_id
        ).filter(
            t_tag_m.c.path.in_(list_of_paths)
        )

    elif operator_type == 'and' and any(list_of_paths):
        highlight_ids_with_all_tags = select(
            [t_highlight_tag.c.highlight_id]
        ).join(
            t_tag,
            t_tag.c.id == t_highlight_tag.c.tag_id
        ).where(
            and_(
                t_tag.c.path.in_(
                    list_of_paths), t_tag.c.project_id == project_id
            )
        ).group_by(
            t_highlight_tag.c.highlight_id
        ).having(
            func.count(distinct(t_tag.c.id)) == len(list_of_paths)
        ).alias()

        query = query.join(highlight_ids_with_all_tags,
                           t_highlight.c.id ==
                           highlight_ids_with_all_tags.c.highlight_id)
    elif operator_type == 'mixed' and any(list_of_paths):
        or_conditions = []

        for group in list_of_paths:
            if len(group) == 1:
                or_conditions.append(t_tag.c.path == group[0])
            else:
                highlight_ids_with_all_tags = select(
                    [t_highlight_tag.c.highlight_id]) \
                    .join(t_tag, t_tag.c.id == t_highlight_tag.c.tag_id) \
                    .filter(
                        t_tag.c.path.in_(group),
                        t_tag.c.project_id == project_id) \
                    .group_by(t_highlight_tag.c.highlight_id) \
                    .having(func.count(distinct(t_tag.c.id)) == len(group)) \
                    .alias("and_subquery_for_group")

                or_conditions.append(
                    t_highlight.c.id.in_(
                        select([highlight_ids_with_all_tags.c.highlight_id])))

        if or_conditions:
            query = query.filter(or_(*or_conditions))
    else:
        # Special case to select all highlights: we also need to select
        # highlights that have no tag at all, so the startswith() condition
        # would not work
        pass

    # Handle exclusion of paths
    if any(exclude_paths):
        exclude_subquery = select([t_highlight_tag.c.highlight_id]) \
            .join(t_tag, t_tag.c.id == t_highlight_tag.c.tag_id) \
            .where(and_(t_tag.c.path.in_(exclude_paths),
                        t_tag.c.project_id == project_id)).alias()

        query = query.where(
            not_(
                exists().where(
                    t_highlight.c.id == exclude_subquery.c.highlight_id
                )
            )
        )

    query = query.order_by(
        t_highlight.c.document_id,
        t_highlight.c.start_offset,
        t_highlight.c.id,
    )

    # Collect highlights
    highlights = []
    for row in db.execute(query).fetchall():
        highlight_id, snippet, document, tag_path = row
        if highlights and highlights[-1][0] == highlight_id:
            if tag_path not in highlights[-1][3]:
                highlights[-1][3].append(tag_path)
        else:
            highlights.append((highlight_id, snippet, document, [
                tag_path] if tag_path else []))

    return highlights


def get_filename_for_highlights_export(path):
    """Génère un nom de fichier approprié pour
        l'exportation des surlignages basé sur les tags.
    """
    if path:
        filename = (path.replace('∪', '_or_')
                    .replace('∩', '_and_')
                    .replace('¬', '_not_'))
        filename = filename.replace(' ', '').lower()
        max_length = 255
        if len(filename) > max_length:
            filename = filename[:max_length]
        return filename
    else:
        return 'all_tags'


@tracer.start_as_current_span('taguette/export/highlights_csv')
def highlights_csv(db, project_id, path, file):
    """Export highlights to a CSV file.
    """
    highlights = _get_highlights_for_export(db, project_id, path)
    writer = csv.writer(file)
    writer.writerow(['id', 'document', 'tag', 'content'])
    for id, snippet, document, tags in highlights:
        if not tags:
            tags = ['']
        for tag_path in tags:
            writer.writerow([
                id, document, tag_path,
                convert.html_to_plaintext(snippet),
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
    sheet.write(0, 3, 'content', header)
    sheet.set_column(0, 0, 5.0)
    sheet.set_column(1, 1, 15.0)
    sheet.set_column(2, 2, 15.0)
    sheet.set_column(3, 3, 80.0)
    row = 1
    for id, snippet, document, tags in highlights:
        if not tags:
            tags = ['']
        for tag_path in tags:
            sheet.write(row, 0, str(id))
            sheet.write(row, 1, document)
            sheet.write(row, 2, tag_path)
            sheet.write(row, 3, convert.html_to_plaintext(snippet))
            row += 1
    workbook.close()


def format_title(path):
    formatted_path = (path.replace('∩', ' ∩ ')
                      .replace('∪', ' ∪ ')
                      .replace('¬', ' ! '))
    return formatted_path


@tracer.start_as_current_span('taguette/export/highlights_doc')
def highlights_doc(db, project_id, path, ext, *, config, locale):
    """Export highlights to a text document.
    """
    highlights = _get_highlights_for_export(db, project_id, path)

    formatted_path = format_title(path)

    html = _render_string(
        'export_highlights.html',
        locale,
        path=formatted_path,
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
        writer.writerow(['tag', 'description', 'color',
                         'parent', 'number of highlights']
                        )
        for tag in tags:
            writer.writerow([tag.path, tag.description, tag.color,
                             tag.parent.path if tag.parent else '',
                             tag.highlights_count])


@tracer.start_as_current_span('taguette/export/codebook_xlsx')
def codebook_xlsx(tags, filename):
    """Export a codebook in Excel format for the given tags.
    """
    workbook = xlsxwriter.Workbook(filename)
    sheet = workbook.add_worksheet('codebook')

    header = workbook.add_format({'bold': True})

    sheet.write(0, 0, 'tag', header)
    sheet.write(0, 1, 'description', header)
    sheet.write(0, 2, 'number of highlights', header)
    sheet.set_column(0, 0, 30.0)
    sheet.set_column(1, 1, 80.0)
    for row, tag in enumerate(tags, start=1):
        sheet.write(row, 0, tag.path)
        sheet.write(row, 1, tag.description)
        sheet.write(row, 2, tag.highlights_count)
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
