import os
import re
from datetime import datetime

import sqlalchemy
from tornado.testing import gen_test

from taguette import database
from tests.utils import with_tempdir
from .test_multi_user import TestMultiUser
from .make_basic_db import TestBasicDatabase


class TestMultiUserExport(TestMultiUser):
    @with_tempdir
    @gen_test(timeout=60)
    async def test_export(self, tmp):
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

        # Export project
        db2_path = os.path.join(tmp, 'db.sqlite3')
        async with self.aget('/project/2/export/project.sqlite3') as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers['Content-Type'],
                             'application/vnd.sqlite3')
            self.assertTrue(re.match(
                '^attachment; filename='
                + '"[0-9]{4}-[0-9]{2}-[0-9]{2}_db1project2.sqlite3"$',
                response.headers['Content-Disposition'],
            ))
            with open(db2_path, 'wb') as fp:
                fp.write(await response.read())
        db2 = database.connect('sqlite:///' + db2_path)()

        # Check exported project
        self.assertEqual(
            {row[0] for row in db2.execute(
                sqlalchemy.select([database.User.__table__.c.login])
            )},
            {'admin'},
        )
        self.assertRowsEqualsExceptDates(
            db2.execute(
                database.Project.__table__.select()
                .order_by(database.Project.__table__.c.id)
            ),
            [
                (1, 'db1project2', '', datetime.utcnow()),
            ],
        )
        self.assertRowsEqualsExceptDates(
            db2.execute(
                database.ProjectMember.__table__.select()
                .order_by(database.ProjectMember.__table__.c.user_login)
            ),
            [
                (1, 'admin', database.Privileges.ADMIN),
            ],
        )
        self.assertEqual(
            [
                (row['id'], row['name'])
                for row in db2.execute(
                    database.Document.__table__.select()
                    .order_by(database.Document.__table__.c.id)
                )
            ],
            [
                (1, 'db1doc21.txt'),
                (2, 'db1doc22.txt'),
            ],
        )

        self.assertRowsEqualsExceptDates(
            db2.execute(
                database.Command.__table__.select()
                .order_by(database.Command.__table__.c.id)
            ),
            [
                # id, user_login, project_id, document_id, {payload}
                # project 2 exported as 1
                # documents 4, 5, 6 exported as 1, 2, -6
                # tags 4, 5, 6 exported as 1, 2, -6
                # highlights 4, 5, 6 exported as 1, 2, -6
                # commands 14-26 exported as 1-13 #db1doc2100.txt
                (1, 'admin', 1, 1,
                 {'description': '',
                  'document_name': 'db1doc21.txt',
                  'favorite': False,
                  'text_direction': 'LEFT_TO_RIGHT',
                  'collections': [],
                  'type': 'document_add'}),
                (2, 'admin', 1, -6,
                 {'description': '',
                  'document_name': 'db1doc2100.txt',
                  'favorite': False,
                  'text_direction': 'LEFT_TO_RIGHT',
                  'collections': [],
                  'type': 'document_add'}),
                (3, 'admin', 1, 2,
                 {'description': '',
                  'document_name': 'db1doc22.txt',
                  'favorite': False,
                  'text_direction': 'RIGHT_TO_LEFT',
                  'collections': [],
                  'type': 'document_add', }),
                (4, 'admin', 1, -6, {'type': 'document_delete'}),
                (5, 'admin', 1, None,
                 {'type': 'tag_add', 'description': '', 'tag_color': '#000000',
                  'tag_id': 1, 'tag_path': 'db1tag21',
                  'tag_parent': None}),
                (6, 'admin', 1, None,
                 {'type': 'tag_add', 'description': '', 'tag_color': '#000000',
                  'tag_id': -6, 'tag_path': 'db1tagF',
                  'tag_parent': None}),
                (7, 'admin', 1, None,
                 {'type': 'tag_add', 'description': '', 'tag_color': '#000000',
                  'tag_id': 2, 'tag_path': 'db1tag22', 'tag_parent': None}),
                (8, 'admin', 1, None,
                 {'type': 'tag_delete', 'tag_id': -6}),
                (9, 'admin', 1, 1,
                 {'type': 'highlight_add', 'highlight_id': 1,
                  'start_offset': 3, 'end_offset': 6, 'tags': []}),
                (10, 'admin', 1, 1,
                 {'type': 'highlight_add', 'highlight_id': 1,
                  'start_offset': 3, 'end_offset': 6, 'tags': [2]}),
                (11, 'admin', 1, 1,
                 {'type': 'highlight_add', 'highlight_id': -6,
                  'start_offset': 3, 'end_offset': 6, 'tags': [1]}),
                (12, 'admin', 1, 1,
                 {'type': 'highlight_add', 'highlight_id': 2,
                  'start_offset': 3, 'end_offset': 6, 'tags': [1]}),
                (13, 'admin', 1, 1,
                 {'type': 'highlight_delete', 'highlight_id': -6}),
                (14, 'admin', 1, None,
                 {'type': 'collection_add', 'collection_id': 1,
                  'collection_name': 'db1collection21',
                  'description': 'Test collection 1',
                  'parent_id': None, 'document_ids': []}),
                (15, 'admin', 1, None,
                 {'type': 'collection_add', 'collection_id': 2,
                  'collection_name': 'db1collection22',
                  'description': 'Test collection 2',
                  'parent_id': None, 'document_ids': []}),
            ],
        )
        self.assertEqual(
            [
                (row['id'], row['document_id'])
                for row in db2.execute(
                    database.Highlight.__table__.select()
                    .order_by(database.Highlight.__table__.c.id)
                )
            ],
            [(1, 1), (2, 2)],
        )
        self.assertRowsEqualsExceptDates(
            db2.execute(
                database.Tag.__table__.select()
                .order_by(database.Tag.__table__.c.id)
            ),
            [
                (1, 1, 'db1tag21', '', '#000000', None),
                (2, 1, 'db1tag22', '', '#000000', None),
            ],
        )
        self.assertRowsEqualsExceptDates(
            db2.execute(
                database.highlight_tags.select()
                .order_by(database.highlight_tags.c.highlight_id)
            ),
            [(1, 2), (2, 1)],
        )
