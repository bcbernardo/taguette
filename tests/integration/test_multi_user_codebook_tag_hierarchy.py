import re
import textwrap

from tornado.testing import gen_test

from taguette import database
from .test_multi_user import TestMultiUser


class TestMultiUserCodeBookTagHierarchy(TestMultiUser):
    # The codebook import tests are split into the "read" tests (post CSV file,
    # get HTML form) and the "import" tests (submit form, database updates)
    async def _setup_import_codebook_project(self):
        # Log in
        async with self.apost('/cookies', data=dict()) as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/')
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
            data=dict(name='my project', description=''),
        ) as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/project/1')

        db = self.application.DBSession()
        self.assertEqual(
            {tag.path for tag in db.query(database.Tag).all()},
            {'interesting'},
        )

    @gen_test
    async def test_read_codebook(self):
        await self._setup_import_codebook_project()

        # Import codebook
        codebook = textwrap.dedent(
            '''\
            path,description,color,parent
            interesting,maybe replace,#000000,,
            people,new,,,
            new tag,new,#6d60d2,interesting
            '''
        )
        async with self.apost(
            '/project/1/import_codebook',
            data={},
            files=dict(file=('codebook.csv', 'application/octet-stream',
                             codebook)),
        ) as response:
            self.assertEqual(response.status, 200)
            text = await response.text()

            def find(s, expected=True):
                self.assertNotEqual(text.find(s) == -1, expected)

            def find_checkbox(name, expected):
                if expected is None:
                    regex = (
                        r'<input type="checkbox" [^>]*name="%s"'
                        % re.escape(name)
                    )
                    self.assertTrue(re.search(regex, text) is None)
                else:
                    regex = (
                        r'<input type="checkbox" [^>]*name="%s"[^>]*/>'
                        % re.escape(name)
                    )
                    tag = re.search(regex, text)
                    self.assertTrue(tag is not None)
                    self.assertEqual('checked' in tag.group(0), expected)

            find('name="tag0-path" value="interesting"')
            find('name="tag0-parent" value=""')
            find('name="tag0-color" value="#000000"')
            find('name="tag0-description" value="maybe replace"')
            find_checkbox('name="tag0-import"', None)
            find_checkbox('tag0-replace', True)
            find('name="tag1-path" value="new tag"')
            find('name="tag1-parent" value="interesting"')
            find('name="tag1-color" value="#6d60d2"')
            find('name="tag1-description" value="new"')
            find_checkbox('tag1-import', True)
            find_checkbox('tag1-replace', None)
            find('name="tag2-path" value="people"')
            find('name="tag2-parent" value=""')
            find('name="tag2-color" value=""')
            find('name="tag2-description" value="new"')
            find_checkbox('tag2-import', True)
            find_checkbox('tag2-replace', None)

    @gen_test
    async def test_import_codebook(self):
        await self._setup_import_codebook_project()

        # Import
        async with self.apost(
            '/project/1/import_codebook',
            data={
                # tag0 not enabled
                'tag0-path': 'interesting',
                'tag0-description': 'no replace',
                'tag1-import': 'on',
                'tag1-path': 'new tag',
                'tag1-description': 'new',
                'tag1-parent': 'interesting',
                'tag1-color': '#6d60d2',
            },
        ) as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'],
                             '/project/1')

        # Export codebook of project 1 to CSV
        async with self.aget('/project/1/export/codebook.csv') as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(
                response.headers['Content-Type'],
                'text/csv; charset=utf-8',
            )
            self.assertEqual(
                await response.text(),
                textwrap.dedent('''\
                    tag,description,color,parent,number of highlights
                    interesting,Further review required,#000000,,0
                    new tag,new,#6d60d2,interesting,0
                    ''').replace('\n', '\r\n'),
            )

        # Check commands
        db = self.application.DBSession()
        self.assertEqual(
            [
                (cmd.user_login, cmd.project_id, cmd.document_id, cmd.payload)
                for cmd in db.query(database.Command).all()
            ],
            [
                ('admin', 1, None, {
                    'type': 'tag_add', 'tag_id': 2,
                    'tag_path': 'new tag', 'tag_parent': 1,
                    'tag_color': '#6d60d2', 'description': 'new',
                }),
            ],
        )
