import textwrap

from tornado.testing import gen_test

from taguette import database
from taguette import exact_version
from taguette.demodata import DEMO_DATA
from .test_multi_user import TestMultiUser
from tests.utils import build_collection_data
from tests.utils import build_collection_response
from tests.utils import build_collection_pool_response
from tests.utils import generate_initial_state_script


class TestMultiUserProjectCollections(TestMultiUser):
    @gen_test(timeout=30)
    async def test_projects(self):
        # project 1               project 2
        # ---------               ---------
        # create
        # (collection 1 'Research Papers')
        #                         create
        #                         (collection 2 'Academic Papers')
        #                         collection 3 'Published Papers'
        #                         collection 4 'Research Papers.Articles'
        # doc 1
        #                         doc 2
        # add doc 1 to collection 1
        #                         add doc 2 to collection 2
        #                         change project metadata
        #                         doc 3
        #                         add doc 3 to collection 3
        #                         add doc 2 to collection 4
        #                         remove doc 2 from collection 2
        #                         add doc 3 to collection 4
        #                         export project
        #                         delete collection 3
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

        # Check project page (initial state - no collections yet)
        async with self.aget('/project/1') as response:
            self.assertEqual(response.status, 200)
            body = await response.text()
        self.assertIn('<!-- Initial state -->', body)
        idx = body.index('<!-- Initial state -->')
        init_js = '\n'.join(body[idx:].splitlines()[1:14])

        # Le projet a un tag par défaut "interesting"
        from tests.utils import build_tag_response
        tags = [
            build_tag_response(
                tag_id=1,
                path="interesting",
                description="Further review required")
        ]

        collections = []

        last_event = -1
        db = self.get_db_session()
        user = db.query(database.User).get(user_login)
        lang = user.language
        if lang not in DEMO_DATA.keys():
            config = self.generate_config()
            lang = config['DEFAULT_LANGUAGE']

        init_js_expected = generate_initial_state_script(
            user_login, project_id, version, documents, tags,
            members, last_event, 'false', '[]', collections)
        self.assertEqual(init_js, init_js_expected)

        # Start polling
        poll_project1 = await self.poll_event(1, -1)

        # Create a collection "Research Papers" in project 1
        async with self.apost(
            '/api/project/1/collection/new',
            json=build_collection_data(name='Research Papers',
                                       description="Academic documents"),
        ) as response:
            self.assertEqual(response.status, 200)
            response_json = await response.json()
            self.assertEqual(response_json, {
                'id': 1,
                'name': 'Research Papers',
                'description': 'Academic documents',
                'created': response_json['created']
            })
        self.assertEqual(
            await poll_project1,
            build_collection_pool_response(
                pool_id=1,
                collection_id=1,
                collection_name='Research Papers',
                description="Academic documents"
            ))

        poll_project1 = await self.poll_event(1, 1)

        # Create a collection "Published Papers" in project 1 (child of Research Papers)
        async with self.apost(
            '/api/project/1/collection/new',
            json=build_collection_data(name='Published Papers',
                                       description="Peer-reviewed articles",
                                       parent_id=1),
        ) as response:
            self.assertEqual(response.status, 200)
            response_json = await response.json()
            self.assertEqual(response_json, {
                'id': 2,
                'name': 'Published Papers',
                'description': 'Peer-reviewed articles',
                'created': response_json['created']
            })
        self.assertEqual(
            await poll_project1,
            build_collection_pool_response(
                pool_id=2,
                collection_id=2,
                collection_name='Published Papers',
                description="Peer-reviewed articles",
                parent_id=1
            ))

        # Check project page after collections are created
        async with self.aget('/project/1') as response:
            self.assertEqual(response.status, 200)
            body = await response.text()
        self.assertIn('<!-- Initial state -->', body)
        idx = body.index('<!-- Initial state -->')
        init_js = '\n'.join(body[idx:].splitlines()[1:14])

        collections = [
            build_collection_response(
                collection_id=1,
                name="Research Papers",
                description="Academic documents",
                children=[
                    build_collection_response(
                        collection_id=2,
                        name="Published Papers",
                        description="Peer-reviewed articles",
                        parent_id=1
                    )
                ]
            )
        ]

        last_event = 2
        init_js_expected = generate_initial_state_script(
            user_login, project_id, version, documents, tags,
            members, last_event, 'false', '[]', collections)

        self.assertEqual(init_js, init_js_expected)

        # Export project 1
        async with self.aget('/project/1/export/project.sqlite3') as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(
                response.headers['Content-Type'],
                'application/vnd.sqlite3',
            )

        async with self.apost('/project/1/delete') as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/')
