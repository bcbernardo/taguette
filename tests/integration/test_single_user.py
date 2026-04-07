from tornado.testing import gen_test
from taguette import database
from .test_user_base import TestUserBase


class TestSingleUser(TestUserBase):
    # Single-user specific configurations
    multiuser = False
    cookies_prompt = False
    secret_key = 'single_user_secret_short'
    xsrf_cookies = False

    @gen_test
    async def test_login(self):
        # Fetch index, should have welcome message and no register link
        async with self.aget('/') as response:
            self.assertEqual(response.status, 200)
            self.assertIn(
                b'did not supply a secret token',
                await response.read())
            self.assertNotIn(
                b'Register now</a> for free and get started',
                await response.read(),
            )

        # Only admin so far
        db = self.get_db_session()
        self.assertEqual([user.login
                          for user in db.query(database.User).all()],
                         ['admin'])

        # Fetch registration page: fails
        async with self.aget('/register') as response:
            self.assertEqual(response.status, 404)

        # Register: fails
        async with self.apost(
            '/register',
            data=dict(
                login='tester',
                password1='hacktoo', password2='hacktoo',
            ),
        ) as response:
            self.assertEqual(response.status, 404)

        # Authenticate with token
        async with self.aget(
            '/?token=' + self.application.single_user_token,
        ) as response:
            self.assertEqual(response.status, 302)
            self.assertEqual(response.headers['Location'], '/')

        # Fetch index, should have project list
        async with self.aget('/') as response:
            self.assertEqual(response.status, 200)
            self.assertIn(b'>Welcome!</h1>', await response.read())

        # Fetch project creation page
        async with self.aget('/project/new') as response:
            self.assertEqual(response.status, 200)

        # Create a project
        async with self.apost(
            '/project/new',
            data=dict(name='test project', description=''),
        ) as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/project/1')

        # Fetch logout page
        async with self.aget('/logout') as response:
            self.assertEqual(response.status, 404)

    @gen_test
    async def test_project(self):
        db = self.get_db_session()
        projects = [
            database.Project(name="first project", description=""),
            database.Project(name="a test", description="Test project"),
            database.Project(name="private P", description="admin can't see"),
            database.Project(name="last project", description="Other"),
        ]
        for project in projects:
            db.add(project)
        db.commit()
        for i in [1, 2, 4]:
            db.add(database.ProjectMember(
                project_id=i,
                user_login='admin',
                privileges=database.Privileges.ADMIN))
        db.commit()

        # Authenticate with token
        async with self.aget(
            '/?token=' + self.application.single_user_token,
        ) as response:
            self.assertEqual(response.status, 302)
            self.assertEqual(response.headers['Location'], '/')

        # Check project list
        async with self.aget('/') as response:
            self.assertEqual(response.status, 200)
            body = await response.read()
        self.assertIn(b"first project", body)
        self.assertIn(b"a test", body)
        self.assertNotIn(b"private P", body)
        self.assertIn(b"last project", body)
