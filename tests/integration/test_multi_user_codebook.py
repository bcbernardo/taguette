import re
import textwrap

from tornado.testing import gen_test

from taguette import database
from .test_multi_user import TestMultiUser


class TestMultiUserCodeBook(TestMultiUser):

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
    async def test_read_codebook_invalid(self):
        await self._setup_import_codebook_project()

        # Import invalid codebooks
        codebooks = [
            (
                'a,b,c\nd,e,f\n',
                "No &#39;tag&#39;, &#39;name&#39;, or &#39;path&#39; column",
            ),
            (
                'tag,name\na,b\nc,d\n',
                "Not sure which column to use for tag name",
            ),
            (
                'tag,description\ninteresting\n',
                "Row 2: Not enough columns",
            ),
            (
                'unk,tag\n1,interesting\n2\n',
                "Row 3: Not enough columns",
            ),
        ]
        for codebook, error in codebooks:
            async with self.apost(
                '/project/1/import_codebook',
                data={},
                files=dict(file=('codebook.csv', 'application/octet-stream',
                                 codebook)),
            ) as response:
                self.assertEqual(response.status, 400)
                text = await response.text()
                self.assertNotEqual(text.find(error), -1)

    @gen_test
    async def test_read_codebook_empty(self):
        await self._setup_import_codebook_project()

        async with self.apost(
            '/project/1/import_codebook',
            data={},
        ) as response:
            self.assertEqual(response.status, 400)
            text = await response.text()
            self.assertNotEqual(text.find("No file provided"), -1)

    @gen_test
    async def test_read_codebook(self):
        await self._setup_import_codebook_project()

        # Import codebook
        codebook = textwrap.dedent(
            '''\
            path,description
            interesting,maybe replace
            people,new
            other,disabled
            interesting,repeated
            people,repeated
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
            find('name="tag0-description" value="maybe replace"')
            find_checkbox('name="tag0-import"', None)
            find_checkbox('tag0-replace', True)
            find('name="tag1-path" value="interesting"')
            find('name="tag1-description" value="repeated"')
            find_checkbox('name="tag1-import"', None)
            find_checkbox('tag1-replace', False)
            find('name="tag2-path" value="other"')
            find('name="tag2-description" value="disabled"')
            find_checkbox('tag2-import', True)
            find_checkbox('tag2-replace', None)
            find('name="tag3-path" value="people"')
            find('name="tag3-description" value="new"')
            find_checkbox('tag3-import', True)
            find_checkbox('tag3-replace', None)
            find('name="tag4-path" value="people"')
            find('name="tag4-description" value="repeated"')
            find_checkbox('tag4-import', False)
            find_checkbox('tag4-replace', None)
            find('name="tag5-path"', False)

    @gen_test
    async def test_import_codebook_conflict(self):
        await self._setup_import_codebook_project()

        # Try to import a tag that already exists
        async with self.apost(
            '/project/1/import_codebook',
            data={
                'tag0-import': 'on',  # This will conflict
                'tag0-path': 'interesting',
                'tag0-description': 'no replace',
                'tag1-import': 'on',
                'tag1-path': 'people',
                'tag1-description': 'new',
                # tag2 not enabled
                'tag2-path': 'other',
                'tag2-description': 'disabled',
            },
        ) as response:
            self.assertEqual(response.status, 409)

    @gen_test
    async def test_import_codebook_missing(self):
        await self._setup_import_codebook_project()

        # Try to replace a tag that doesn't exist
        async with self.apost(
            '/project/1/import_codebook',
            data={
                'tag0-replace': 'on',
                'tag0-path': 'interesting',
                'tag0-description': 'yes replace',
                'tag1-replace': 'on',  # This will not match
                'tag1-path': 'people',
                'tag1-description': 'new',
                # tag2-enabled not set
                'tag2-path': 'other',
                'tag2-description': 'disabled',
            },
        ) as response:
            self.assertEqual(response.status, 409)

    @gen_test
    async def test_import_codebook(self):
        await self._setup_import_codebook_project()

        # Import with existing tag disabled
        async with self.apost(
            '/project/1/import_codebook',
            data={
                # tag0 not enabled
                'tag0-path': 'interesting',
                'tag0-description': 'no replace',
                'tag1-import': 'on',
                'tag1-path': 'people',
                'tag1-description': 'new',
                # tag2 not enabled
                'tag2-path': 'other',
                'tag2-description': 'disabled',
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
                    people,new,,,0
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
                    'tag_path': 'people', 'tag_parent': None,
                    'tag_color': '', 'description': 'new',
                }),
            ],
        )

    @gen_test
    async def test_import_codebook_replace(self):
        await self._setup_import_codebook_project()

        # Import with replacement
        async with self.apost(
            '/project/1/import_codebook',
            data={
                'tag0-replace': 'on',
                'tag0-path': 'interesting',
                'tag0-description': 'yes replace',
                'tag0-color': '#000000',
                'tag1-import': 'on',
                'tag1-path': 'people',
                'tag1-description': 'new',
                'tag1-color': '#000000',
                # tag2-enabled not set
                'tag2-path': 'other',
                'tag2-description': 'disabled',
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
                    interesting,yes replace,#000000,,0
                    people,new,#000000,,0
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
                    'type': 'tag_add', 'tag_id': 1,
                    'tag_path': 'interesting', 'tag_parent': None,
                    'tag_color': '#000000', 'description': 'yes replace',
                }),
                ('admin', 1, None, {
                    'type': 'tag_add', 'tag_id': 2,
                    'tag_path': 'people', 'tag_parent': None,
                    'tag_color': '#000000', 'description': 'new',
                }),
            ],
        )
