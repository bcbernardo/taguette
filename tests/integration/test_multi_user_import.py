import os
from datetime import datetime

import sqlalchemy
from tornado.testing import gen_test

from taguette import database
from tests.utils import with_tempdir
from .test_multi_user import TestMultiUser
from .make_basic_db import TestBasicDatabase


class TestMultiUserImport(TestMultiUser):
    @with_tempdir
    @gen_test(timeout=60)
    async def test_import(self, tmp):
        # Populate database
        db1 = self.get_db_session()
        await TestBasicDatabase.make_basic_db(db1, 1)
        db1.commit()

        # Log in
        async with self.apost('/cookies', data=dict()) as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/')
        async with self.aget('/login') as response:
            self.assertEqual(response.status, 200)
        async with self.apost(
            '/login',
            data=dict(next='/', login='db1user', password='hackme'),
        ) as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/')

        # Create second database
        db2_path = os.path.join(tmp, 'db.sqlite3')
        db2 = database.connect('sqlite:///' + db2_path)()
        db2.add(database.User(login='admin'))
        await TestBasicDatabase.make_basic_db(db2, 2)
        db2.commit()

        # List projects in database
        with open(db2_path, 'rb') as fp:
            async with self.apost(
                '/api/import',
                data={},
                files=dict(file=('db2.sqlite3', 'application/octet-stream',
                                 fp.read())),
            ) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(await response.json(), {
                    'projects': [{'id': 1, 'name': 'db2project1'},
                                 {'id': 2, 'name': 'db2project2'}],
                })

        # Import project
        with open(db2_path, 'rb') as fp:
            async with self.apost(
                '/api/import',
                data={'project_id': '1'},
                files=dict(file=('db2.sqlite3', 'application/octet-stream',
                                 fp.read())),
            ) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(await response.json(), {
                    'project_id': 3,
                })

        # Check imported project
        self.assertEqual(
            {row[0] for row in db1.execute(
                sqlalchemy.select([database.User.__table__.c.login])
            )},
            {'admin', 'db1user'},
        )
        self.assertRowsEqualsExceptDates(
            db1.execute(
                database.Project.__table__.select()
                .order_by(database.Project.__table__.c.id)
            ),
            [
                (1, 'db1project1', '', datetime.utcnow()),
                (2, 'db1project2', '', datetime.utcnow()),
                (3, 'db2project1', '', datetime.utcnow()),
            ],
        )
        self.assertRowsEqualsExceptDates(
            db1.execute(
                database.ProjectMember.__table__.select()
                .order_by(database.ProjectMember.__table__.c.project_id)
                .order_by(database.ProjectMember.__table__.c.user_login)
            ),
            [
                (1, 'admin', database.Privileges.ADMIN),
                (1, 'db1user', database.Privileges.ADMIN),
                (2, 'admin', database.Privileges.ADMIN),
                (2, 'db1user', database.Privileges.ADMIN),
                (3, 'db1user', database.Privileges.ADMIN),
            ],
        )
        self.assertEqual(
            [
                (row['id'], row['name'])
                for row in db1.execute(
                    database.Document.__table__.select()
                    .order_by(database.Document.__table__.c.id)
                )
            ],
            [
                (1, 'db1doc11.txt'),
                (2, 'db1doc12.txt'),
                (4, 'db1doc21.txt'),
                (5, 'db1doc22.txt'),
                (7, 'db2doc11.txt'),
                (8, 'db2doc12.txt'),
            ],
        )

        self.assertRowsEqualsExceptDates(
            db1.execute(
                database.Command.__table__.select()
                .where(database.Command.__table__.c.project_id == 3)
                .order_by(database.Command.__table__.c.id)
            ),
            [
                # id, user_login, project_id, document_id, {payload}
                # project 1 imported as 3
                # documents 1, 2, 3 imported as 7, 8, 9
                # tags 1, 2, 3 imported as 7, 8, -3
                # highlights 1, 2, 3 imported as 7, 8, -3
                # commands 1-13 exported as 27-39
                (27, 'db1user', 3, 7,
                 {'description': '',
                  'document_name': 'db2doc11.txt',
                  'favorite': False,
                  'text_direction': 'LEFT_TO_RIGHT',
                  'type': 'document_add'}),
                (28, 'db1user', 3, -3,
                 {'description': '',
                  'document_name': 'db2doc1100.txt',
                  'favorite': False,
                  'text_direction': 'LEFT_TO_RIGHT',
                  'type': 'document_add', }),
                (29, 'db1user', 3, 8,
                 {'description': '',
                  'document_name': 'db2doc12.txt',
                  'favorite': False,
                  'text_direction': 'RIGHT_TO_LEFT',
                  'type': 'document_add', }),
                (30, 'db1user', 3, -3, {'type': 'document_delete'}),
                (31, 'db1user', 3, None,
                 {'type': 'tag_add', 'description': '',
                  'tag_id': 7, 'tag_path': 'db2tag11',
                  'tag_color': '#000000', 'tag_parent': None}),
                (32, 'db1user', 3, None,
                 {'type': 'tag_add', 'description': '',
                  'tag_id': -3, 'tag_path': 'db2tagF',
                  'tag_color': '#000000', 'tag_parent': None}),
                (33, 'db1user', 3, None,
                 {'type': 'tag_add', 'description': '',
                  'tag_id': 8, 'tag_path': 'db2tag12',
                  'tag_color': '#000000', 'tag_parent': None}),
                (34, 'db1user', 3, None, {'type': 'tag_delete', 'tag_id': -3}),
                (35, 'db1user', 3, 7,
                 {'type': 'highlight_add', 'highlight_id': 7,
                  'start_offset': 3, 'end_offset': 6, 'tags': []}),
                (36, 'db1user', 3, 7,
                 {'type': 'highlight_add', 'highlight_id': 7,
                  'start_offset': 3, 'end_offset': 6, 'tags': [8]}),
                (37, 'db1user', 3, 7,
                 {'type': 'highlight_add', 'highlight_id': -3,
                  'start_offset': 3, 'end_offset': 6, 'tags': [7]}),
                (38, 'db1user', 3, 7,
                 {'type': 'highlight_add', 'highlight_id': 8,
                  'start_offset': 3, 'end_offset': 6, 'tags': [7]}),
                (39, 'db1user', 3, 7,
                 {'type': 'highlight_delete', 'highlight_id': -3}),
                (40, 'db1user', 3, None, {'type': 'project_import'}),
            ],
        )
        self.assertEqual(
            [
                (row['id'], row['document_id'])
                for row in db1.execute(
                    database.Highlight.__table__.select()
                    .order_by(database.Highlight.__table__.c.id)
                )
            ],
            [(1, 1), (2, 2), (4, 4), (5, 5), (7, 7), (8, 8)],
        )
        self.assertRowsEqualsExceptDates(
            db1.execute(database.Tag.__table__.select()),
            [
                (1, 1, 'db1tag11', '', '#000000', None),
                (2, 1, 'db1tag12', '', '#000000', None),
                (4, 2, 'db1tag21', '', '#000000', None),
                (5, 2, 'db1tag22', '', '#000000', None),
                (7, 3, 'db2tag11', '', '#000000', None),
                (8, 3, 'db2tag12', '', '#000000', None),
            ],
        )
        self.assertRowsEqualsExceptDates(
            db1.execute(
                database.highlight_tags.select()
                .order_by(database.highlight_tags.c.highlight_id)
            ),
            [(1, 2), (2, 1), (4, 5), (5, 4), (7, 8), (8, 7)],
        )
