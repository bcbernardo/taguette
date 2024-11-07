import asyncio
import textwrap
import time

from tornado.testing import gen_test

from taguette import database
from taguette import exact_version
from .test_multi_user import TestMultiUser
from tests.utils import compare_xml
from tests.utils import build_tag_data
from tests.utils import build_tag_response
from tests.utils import build_tag_pool_response
from tests.utils import generate_initial_state_script


class TestMultiUserProject(TestMultiUser):
    @gen_test(timeout=30)
    async def test_projects(self):
        # project 1               project 2
        # ---------               ---------
        # create
        # (tag 1 'interesting')
        #                         create
        #                         (tag 2 'interesting')
        #                         tag 3 'people'
        #                         tag 4 'interesting.places'
        # doc 1
        #                         doc 2
        # hl 1 doc=1 tags=[]
        # hl 1 doc=1 tags=[1]
        #                         change project metadata
        #                         doc 3
        #                         hl 2 doc=2 tags=[4]
        #                         hl 3 doc=2 tags=[2, 3]
        #                         hl 4 doc=2 tags=[3]
        #                         delete hl 4 doc=2
        #                         hl 5 doc=3 tags=[3]
        #                         highlights 'people*': [3, 5]
        #                         highlights 'interesting.places*': [2]
        #                         highlights 'interesting*': [2, 3]
        #                         highlights: [2, 3, 5]
        #                         export doc 2
        #                         merge tag 3 -> 2
        #                         highlights: [2, 3, 5]
        # delete project
        # Accept cookies
        async with self.apost('/cookies', data=dict()) as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/')

        # Log in
        async with self.aget('/login') as response:
            self.assertEqual(response.status, 200)
        async with self.apost(
            '/login',
            data=dict(next='/', login='admin', password='hackme'),
        ) as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/')

        # Create project 1
        async with self.aget('/project/new') as response:
            self.assertEqual(response.status, 200)
        async with self.apost(
            '/project/new',
            data=dict(
                name='\uFF9F\uFF65\u273F\u30FE\u2572\x28\uFF61\u25D5\u203F'
                     '\u25D5\uFF61\x29\u2571\u273F\uFF65\uFF9F',
                description="R\xE9mi's project",
            ),
        ) as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/project/1')

            # default project values
            user_login = "admin"
            project_id = 1
            version = exact_version()
            documents = {}
            members = {"admin": {"privileges": "ADMIN"}}

        # Check project page
        async with self.aget('/project/1') as response:
            self.assertEqual(response.status, 200)
            body = await response.text()
        self.assertIn('<!-- Initial state -->', body)
        idx = body.index('<!-- Initial state -->')
        init_js = '\n'.join(body[idx:].splitlines()[1:12])

        tags = [
            build_tag_response(
                tag_id=1,
                path="interesting",
                description="Further review required")
        ]

        last_event = -1
        init_js_expected = generate_initial_state_script(
            user_login, project_id, version, documents, tags,
            members, last_event, 'false')

        self.assertEqual(init_js, init_js_expected)
        
        # Start polling
        poll_proj1 = await self.poll_event(1, last_event)

        # Create project 2
        async with self.aget('/project/new') as response:
            self.assertEqual(response.status, 200)
        async with self.apost(
            '/project/new',
            data=dict(name='other project', description=''),
        ) as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/project/2')

        # Start polling
        poll_proj2 = await self.poll_event(2, last_event)

        # Create a tag "people" in project 2
        async with self.apost(
            '/api/project/2/tag/new',
            json=build_tag_data(path='people',
                                description="People of interest"),
        ) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(
            await poll_proj2,
            build_tag_pool_response(
                pool_id=1,
                tag_id=3,
                path='people',
                description="People of interest"
            ))
        
        poll_proj2 = await self.poll_event(2, 1)

        # Create a tag "interesting.places" in project 2
        async with self.apost(
            '/api/project/2/tag/new',
            json=build_tag_data(path='interesting.places',
                                description=''),
        ) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(
            await poll_proj2,
            build_tag_pool_response(
                pool_id=2,
                tag_id=4,
                path='interesting.places',
                description=''
            ))
        
        poll_proj2 = await self.poll_event(2, 2)
        
        # Create document 1 in project 1
        name = '\u03A9\u2248\xE7\u221A\u222B\u02DC\xB5\u2264\u2265\xF7'
        async with self.apost(
            '/api/project/1/document/new',
            data=dict(name=name, description=''),
            files=dict(
                file=('/dir/r\xE9 mi.html', 'text/plain', b'content here'),
            ),
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"created": 1})
        db = self.get_db_session()
        doc = db.query(database.Document).get(1)
        self.assertEqual(doc.name, name)
        self.assertEqual(doc.description, '')
        self.assertEqual(doc.filename, 'ré mi.html')
        self.assertEqual(
            await poll_proj1,
            {'type': 'document_add', 'id': 3, 'document_id': 1,
             'text_direction': 'LEFT_TO_RIGHT',
             'document_name': name, 'favorite': False,
             'description': ''})
        
        poll_proj1 = await self.poll_event(1, 3)

        # Create document 2 in project 2
        async with self.apost(
            '/api/project/2/document/new',
            data=dict(name='otherdoc', description='Other one',
                      text_direction='LEFT_TO_RIGHT'),
            files=dict(
                file=('../otherdoc.html', 'text/plain', b'different content'),
            ),
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"created": 2})
        db = self.get_db_session()
        doc = db.query(database.Document).get(2)
        self.assertEqual(doc.name, 'otherdoc')
        self.assertEqual(doc.description, 'Other one')
        self.assertEqual(doc.filename, 'otherdoc.html')
        self.assertEqual(
            await poll_proj2,
            {'type': 'document_add', 'id': 4, 'document_id': 2,
             'text_direction': 'LEFT_TO_RIGHT',
             'document_name': 'otherdoc', 'favorite': False,
             'description': 'Other one'})
        
        poll_proj2 = await self.poll_event(2, 4)

        # Create highlight 1 in document 1
        async with self.apost(
            '/api/project/1/document/1/highlight/new',
            json=dict(start_offset=3, end_offset=5, tags=[]),
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"id": 1})
        self.assertEqual(
            await poll_proj1,
            {'type': 'highlight_add', 'id': 5, 'highlight_id': 1,
             'document_id': 1, 'start_offset': 3, 'end_offset': 5,
             'tags': [], 'tag_count_changes': {}})
        
        poll_proj1 = await self.poll_event(1, 5)

        # Update highlight 1 in document 1: change position
        async with self.apost(
            '/api/project/1/document/1/highlight/1',
            json=dict(start_offset=3, end_offset=7),
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"id": 1})
        self.assertEqual(
            await poll_proj1,
            {'type': 'highlight_add', 'id': 6, 'highlight_id': 1,
             'document_id': 1, 'start_offset': 3, 'end_offset': 7,
             'tags': [], 'tag_count_changes': {}})
        
        poll_proj1 = await self.poll_event(1, 6)

        # Update highlight 1 in document 1: change tags
        async with self.apost(
            '/api/project/1/document/1/highlight/1',
            json=dict(tags=[1]),
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"id": 1})
        self.assertEqual(
            await poll_proj1,
            {'type': 'highlight_add', 'id': 7, 'highlight_id': 1,
             'document_id': 1, 'start_offset': 3, 'end_offset': 7,
             'tags': [1], 'tag_count_changes': {'1': {'documents_count': 1, 'highlights_count': 1}}})
        
        poll_proj1 = await self.poll_event(1, 7)

        # Change project 2 metadata (invalid)
        async with self.apost(
            '/api/project/2',
            json={'name': '', 'description': "Meaningful"},
        ) as response:
            self.assertEqual(response.status, 400)
            self.assertEqual(await response.json(),
                             {'error': 'Project name cannot be empty'})
        time.sleep(0.3)
        self.assertFalse(poll_proj2.done())

        # Change project 2 metadata
        async with self.apost(
            '/api/project/2',
            json={'name': 'new project', 'description': "Meaningful"},
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {})
        self.assertEqual(
            await poll_proj2,
            {'type': 'project_meta', 'id': 8,
             'project_name': 'new project', 'description': 'Meaningful'})
        
        poll_proj2 = await self.poll_event(2, 8)

        # Create document 3 in project 2
        async with self.apost(
            '/api/project/2/document/new',
            data=dict(name='third', description='Last one',
                      text_direction='RIGHT_TO_LEFT'),
            files=dict(file=(
                'C:\\Users\\Vicky\\Documents\\study.html',
                'text/html',
                b'<strong>Opinions</strong> and <em>facts</em>!',
            )),
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"created": 3})
        self.assertEqual(
            await poll_proj2,
            {'type': 'document_add', 'id': 9, 'document_id': 3,
             'text_direction': 'RIGHT_TO_LEFT',
             'document_name': 'third', 'favorite': False,
             'description': 'Last one'})
        
        poll_proj2 = await self.poll_event(2, 9)

        # Create highlight in document 2, using wrong project id
        async with self.apost(
            '/api/project/1/document/2/highlight/new',
            json=dict(start_offset=0, end_offset=4, tags=[]),
        ) as response:
            self.assertEqual(response.status, 404)

        # Create highlight in document 2, using tags that don't exist
        async with self.apost(
            '/api/project/2/document/2/highlight/new',
            json=dict(start_offset=0, end_offset=4, tags=[150]),
        ) as response:
            self.assertEqual(response.status, 400)
            self.assertEqual(await response.json(),
                             {"error": "No such code"})

        # Create highlight in document 2, using tags from project 1
        async with self.apost(
            '/api/project/2/document/2/highlight/new',
            json=dict(start_offset=0, end_offset=4, tags=[1]),
        ) as response:
            self.assertEqual(response.status, 400)
            self.assertEqual(await response.json(),
                             {"error": "No such code"})

        # Create highlight 2 in document 2
        async with self.apost(
            '/api/project/2/document/2/highlight/new',
            json=dict(start_offset=0, end_offset=4, tags=[4]),
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"id": 2})
        self.assertEqual(
            await poll_proj2,
            {'type': 'highlight_add', 'id': 10, 'highlight_id': 2,
             'document_id': 2, 'start_offset': 0, 'end_offset': 4,
             'tags': [4], 'tag_count_changes': {'4': {'documents_count': 1, 'highlights_count': 1}}})
        
        poll_proj2 = await self.poll_event(2, 10)

        # Create highlight 3 in document 2
        async with self.apost(
            '/api/project/2/document/2/highlight/new',
            json=dict(start_offset=13, end_offset=17, tags=[3, 2]),
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"id": 3})
        self.assertEqual(
            await poll_proj2,
            {'type': 'highlight_add', 'id': 11, 'highlight_id': 3,
             'document_id': 2, 'start_offset': 13, 'end_offset': 17,
             'tags': [2, 3], 'tag_count_changes': {'2': {'documents_count': 1, 'highlights_count': 1},
             '3': {'documents_count': 1, 'highlights_count': 1}}})
        
        poll_proj2 = await self.poll_event(2, 11)

        # Create highlight 4 in document 2
        async with self.apost(
            '/api/project/2/document/2/highlight/new',
            json=dict(start_offset=0, end_offset=7, tags=[3]),
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"id": 4})
        self.assertEqual(
            await poll_proj2,
            {'type': 'highlight_add', 'id': 12, 'highlight_id': 4,
             'document_id': 2, 'start_offset': 0, 'end_offset': 7,
             'tags': [3], 'tag_count_changes': {'3': {'documents_count': 2, 'highlights_count': 2}}})
        
        poll_proj2 = await self.poll_event(2, 12)

        # Delete highlight 4 in document 2
        async with self.adelete(
            '/api/project/2/document/2/highlight/4',
        ) as response:
            self.assertEqual(response.status, 204)
        self.assertEqual(
            await poll_proj2,
            {'type': 'highlight_delete', 'id': 13, 'highlight_id': 4,
             'document_id': 2, 'tag_count_changes': {'3': {'documents_count': 1, 'highlights_count': 1}}})
        poll_proj2 = await self.poll_event(2, 13)

        # Create highlight 5 in document 3
        async with self.apost(
            '/api/project/2/document/3/highlight/new',
            json=dict(start_offset=0, end_offset=7, tags=[3]),
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"id": 5})
        self.assertEqual(
            await poll_proj2,
            {'type': 'highlight_add', 'id': 14, 'highlight_id': 5,
             'document_id': 3, 'start_offset': 0, 'end_offset': 7,
             'tags': [3], 'tag_count_changes': {'3': {'documents_count': 2, 'highlights_count': 2}}})
        
        poll_proj2 = await self.poll_event(2, 14)

        # List highlights in project 2 under 'people'
        async with self.aget('/api/project/2/highlights/people') as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {
                'highlights': [
                    {'id': 3, 'document_id': 2, 'tags': [2, 3],
                     'text_direction': 'LEFT_TO_RIGHT', 'content': "tent"},
                    {'id': 5, 'document_id': 3, 'tags': [3],
                     'text_direction': 'RIGHT_TO_LEFT',
                     'content': "<strong>Opinion</strong>"},
                ],
                'pages': 1,
            })

        # List highlights in project 2 under 'interesting.places'
        async with self.aget(
            '/api/project/2/highlights/interesting.places',
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {
                'highlights': [
                    {'id': 2, 'document_id': 2, 'tags': [4],
                     'text_direction': 'LEFT_TO_RIGHT', 'content': "diff"},
                ],
                'pages': 1,
            })

        # List highlights in project 2 under 'interesting'
        async with self.aget(
            '/api/project/2/highlights/interesting∪interesting.places',
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {
                'highlights': [
                    {'id': 2, 'document_id': 2, 'tags': [4],
                     'text_direction': 'LEFT_TO_RIGHT', 'content': "diff"},
                    {'id': 3, 'document_id': 2, 'tags': [2, 3],
                     'text_direction': 'LEFT_TO_RIGHT', 'content': "tent"},
                ],
                'pages': 1,
            })

        # List all highlights in project 2
        async with self.aget('/api/project/2/highlights/') as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {
                'highlights': [
                    {'id': 2, 'document_id': 2, 'tags': [4],
                     'text_direction': 'LEFT_TO_RIGHT', 'content': "diff"},
                    {'id': 3, 'document_id': 2, 'tags': [2, 3],
                     'text_direction': 'LEFT_TO_RIGHT', 'content': "tent"},
                    {'id': 5, 'document_id': 3, 'tags': [3],
                     'text_direction': 'RIGHT_TO_LEFT',
                     'content': "<strong>Opinion</strong>"},
                ],
                'pages': 1,
            })

        # Get contents of document 2
        async with self.aget('/api/project/2/document/2') as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {
                'highlights': [
                    {'id': 2, 'start_offset': 0, 'end_offset': 4,
                     'tags': [4]},
                    {'id': 3, 'start_offset': 13, 'end_offset': 17,
                     'tags': [2, 3]},
                ],
                'text_direction': 'LEFT_TO_RIGHT',
            })
        async with self.aget('/api/project/2/document/2/contents') as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {
                'contents': [{'contents': 'different content', 'offset': 0}],
            })
            self.assertEqual(response.headers['Etag'], '"doc-2-1"')
        async with self.aget(
            '/api/project/2/document/2/contents',
            headers={'If-None-Match': '"doc-2-1"'},
        ) as response:
            self.assertEqual(response.status, 304)

        # Export document 2 to HTML
        async with self.aget('/project/2/export/document/2.html') as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(
                response.headers['Content-Type'],
                'text/html; charset=utf-8',
            )
            self.assertEqual(
                await response.text(),
                textwrap.dedent('''\
                <!DOCTYPE html>
                <html>
                  <head>
                    <meta charset="UTF-8">
                    <style>
                      .highlight {
                        background-color: #ff0;
                      }
                      .taglist {
                        font-style: oblique;
                        background: #fbb !important;
                      }
                    </style>
                    <title>otherdoc</title>
                  </head>
                  <body>
                    <h1>otherdoc</h1>
                <span class="highlight">diff</span>\
<span class="taglist"> [interesting.places]</span>erent con\
<span class="highlight">tent</span><span class="taglist"> \
[interesting, people]</span>
                  </body>
                </html>'''),
            )

        # Export document 2 to unknown format
        async with self.aget('/project/2/export/document/2.dat') as response:
            self.assertEqual(response.status, 404)
            self.assertEqual(response.headers['Content-Type'], 'text/plain')
            self.assertEqual(
                await response.text(),
                'Unsupported format: dat',
            )

        # Export highlights in project 2 under 'interesting' to HTML
        async with self.aget(
            '/project/2/export/highlights/interesting.html',
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(
                await response.text(),
                textwrap.dedent('''\
                        <!DOCTYPE html>
                        <html>
                          <head>
                            <meta charset="UTF-8">
                            <title>LibreQDA highlights: interesting</title>
                            <style>
                              h1 {
                                margin-bottom: 1em;
                              }
                            </style>
                          </head>
                          <body>
                            <h1>LibreQDA highlights: interesting</h1>

                            tent
                            <p>
                              <strong>Document:</strong> otherdoc
                              <strong>Codes:</strong>
                                interesting,
                                people
                            </p>

                          </body>
                        </html>'''),
            )

        # Export all highlights in project 2 to HTML
        async with self.aget(
            '/project/2/export/highlights/.html',
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(
                await response.text(),
                textwrap.dedent('''\
                        <!DOCTYPE html>
                        <html>
                          <head>
                            <meta charset="UTF-8">
                            <title>LibreQDA highlights</title>
                            <style>
                              h1 {
                                margin-bottom: 1em;
                              }
                            </style>
                          </head>
                          <body>
                            <h1>LibreQDA highlights</h1>

                            diff
                            <p>
                              <strong>Document:</strong> otherdoc
                              <strong>Codes:</strong>
                                interesting.places
                            </p>
                            <hr>

                            tent
                            <p>
                              <strong>Document:</strong> otherdoc
                              <strong>Codes:</strong>
                                interesting,
                                people
                            </p>
                            <hr>

                            <strong>Opinion</strong>
                            <p>
                              <strong>Document:</strong> third
                              <strong>Codes:</strong>
                                people
                            </p>

                          </body>
                        </html>'''),
            )

        # Export highlights in project 2 under 'interesting' to CSV
        async with self.aget(
            '/project/2/export/highlights/interesting.csv',
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(
                await response.text(),
                textwrap.dedent('''\
                    id,document,tag,content
                    3,otherdoc,interesting,tent
                    3,otherdoc,people,tent
                    ''').replace('\n', '\r\n'),
            )

        # Export codebook of project 2 to CSV
        async with self.aget('/project/2/export/codebook.csv') as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(
                response.headers['Content-Type'],
                'text/csv; charset=utf-8',
            )
            self.assertEqual(
                await response.text(),
                textwrap.dedent('''\
                        tag,description,color,parent,number of highlights
                        interesting,Further review required,#000000,,1
                        people,People of interest,#000000,,2
                        interesting.places,,#000000,,1
                        ''').replace('\n', '\r\n'),
            )

        # Export codebook of project 2 to HTML
        async with self.aget('/project/2/export/codebook.html') as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(
                await response.text(),
                textwrap.dedent('''\
                        <!DOCTYPE html>
                        <html>
                          <head>
                            <meta charset="UTF-8">
                            <style>
                              .highlight {
                                background-color: #ff0;
                              }
                            </style>
                            <title>LibreQDA Codebook</title>
                          </head>
                          <body>
                            <h1>LibreQDA Codebook</h1>

                              <h2>interesting</h2>
                              <p class="number">1 highlight</p>
                              <p>Further review required</p>

                              <h2>people</h2>
                              <p class="number">2 highlights</p>
                              <p>People of interest</p>

                              <h2>interesting.places</h2>
                              <p class="number">1 highlight</p>
                              <p></p>

                          </body>
                        </html>'''),
            )

        # Export codebook of project 2 to REFI-QDA
        async with self.aget('/project/2/export/codebook.qdc') as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(
                response.headers['Content-Type'],
                'text/xml; charset=utf-8',
            )
            compare_xml(
                await response.text(),
                ('<?xml version="1.0" encoding="utf-8"?>\n'
                 '<CodeBook xmlns="urn:QDA-XML:codebook:1.0" origin="'
                 'Taguette {ver}"><Codes><Code guid="0D62985D-B147-5D01-A9B5-'
                 'CAE5DCD98342" name="interesting" isCodable="true"/><Code '
                 'guid="DFE5C38E-9449-5959-A1F7-E3D895CFA87F" name="people" '
                 'isCodable="true"/><Code guid="725F0645-9CD3-598A-8D2B-'
                 'EC3D39AB3C3F" name="interesting.places" isCodable="true"/>'
                 '</Codes><Sets/></CodeBook>'
                 ).format(ver=exact_version()),
            )

        # Merge tag 3 into 2
        async with self.apost(
            '/api/project/2/tag/merge',
            json=dict(src=3, dest=2),
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {'id': 2})
        self.assertEqual(
            await poll_proj2,
            {'type': 'tag_merge', 'id': 15, 'src_tag_id': 3, 'dest_tag_id': 2},
        )
        poll_proj2 = await self.poll_event(2, 15)

        # List all highlights in project 2
        async with self.aget('/api/project/2/highlights/') as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {
                'highlights': [
                    {'id': 2, 'document_id': 2, 'tags': [4],
                     'text_direction': 'LEFT_TO_RIGHT', 'content': "diff"},
                    {'id': 3, 'document_id': 2, 'tags': [2],
                     'text_direction': 'LEFT_TO_RIGHT', 'content': "tent"},
                    {'id': 5, 'document_id': 3, 'tags': [2],
                     'text_direction': 'RIGHT_TO_LEFT',
                     'content': "<strong>Opinion</strong>"},
                ],
                'pages': 1,
            })

        # Test search with no results
        async with self.aget('/api/project/1/search/nothing-found?page=1') as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {
                "documents": [],
                "nb_results": 0,
                "pages": 0,
                "search_text": "nothing-found"
            })

        # Test search with results
        async with self.aget('/api/project/1/search/content?page=1') as response:
            self.assertEqual(response.status, 200)
            response_json = await response.json()
            self.assertIn('nb_results', response_json)
            self.assertIn('pages', response_json)
            self.assertIn('documents', response_json)
            self.assertTrue(response_json['nb_results'] > 0)
            self.assertTrue(response_json['pages'] > 0)
            self.assertTrue(len(response_json['documents']) > 0)

        # TODO: Collaborators
        
        await asyncio.sleep(2)
        self.assertFalse(poll_proj1.done())
        poll_proj1.cancel()
        self.assertFalse(poll_proj2.done())
        poll_proj2.cancel()

        async with self.apost('/project/1/delete') as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/')
