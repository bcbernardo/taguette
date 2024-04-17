import textwrap

from tornado.testing import gen_test

from taguette import exact_version
from .test_multi_user import TestMultiUser
from tests.utils import build_tag_data
from tests.utils import build_tag_response
from tests.utils import build_tag_pool_response
from tests.utils import generate_initial_state_script


class TestMultiUserProjectTagHierarchy(TestMultiUser):
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
        init_js = '\n'.join(body[idx:].splitlines()[1:11])

        tags = [
            build_tag_response(
                tag_id=1,
                path="interesting",
                description="Further review required")
        ]

        last_event = -1
        init_js_expected = generate_initial_state_script(
            user_login, project_id, version, documents, tags,
            members, last_event)
        self.assertEqual(init_js, init_js_expected)

        # Start polling
        poll_project1 = await self.poll_event(1, -1)

        # Create a tag "people" in project 1
        async with self.apost(
            '/api/project/1/tag/new',
            json=build_tag_data(path='people',
                                parent_id=1,
                                description="People of interest"),
        ) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(
            await poll_project1,
            build_tag_pool_response(
                pool_id=1,
                tag_id=2,
                path='people',
                parent_id=1,
                description="People of interest"
            ))

        poll_project1 = await self.poll_event(1, 1)

        # Create a tag "new tag" in project 1
        async with self.apost(
            '/api/project/1/tag/new',
            json=build_tag_data(path='new tag',
                                description="my new tag"),
        ) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(
            await poll_project1,
            build_tag_pool_response(
                pool_id=2,
                tag_id=3,
                path='new tag',
                description="my new tag"
            ))

        # Check project page
        async with self.aget('/project/1') as response:
            self.assertEqual(response.status, 200)
            body = await response.text()
        self.assertIn('<!-- Initial state -->', body)
        idx = body.index('<!-- Initial state -->')
        init_js = '\n'.join(body[idx:].splitlines()[1:11])

        tags = [
            build_tag_response(
                tag_id=1,
                path="interesting",
                description="Further review required",
                children=[
                    build_tag_response(
                        tag_id=2,
                        path="people",
                        description="People of interest",
                        parent=1
                    )
                ]
            ),
            build_tag_response(
                tag_id=3,
                path="new tag",
                description="my new tag"
            )
        ]

        last_event = 2
        init_js_expected = generate_initial_state_script(
            user_login, project_id, version, documents, tags,
            members, last_event)

        self.assertEqual(init_js, init_js_expected)

        # Export codebook of project 2 to CSV
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
                        people,People of interest,#000000,interesting,0
                        new tag,my new tag,#000000,,0
                        ''').replace('\n', '\r\n'),
            )

        async with self.apost('/project/1/delete') as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/')
