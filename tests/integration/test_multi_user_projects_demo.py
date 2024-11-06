from tornado.testing import gen_test
from .test_multi_user import TestMultiUser


class TestMultiUserProjectDemo(TestMultiUser):
    @gen_test(timeout=30)
    async def test_projects(self):
        # project
        # ---------
        # create
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

        # Create demo project project
        async with self.apost(
                '/api/create_demo_project'
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertIn('html', response.json())

