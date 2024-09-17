from tornado.testing import gen_test
from taguette import database
from .test_multi_user import TestMultiUser
from urllib.parse import urlencode


class TestMultiUserLogin(TestMultiUser):
    @gen_test(timeout=30)
    async def test_login(self):
        # Fetch index, should have welcome message and register link
        async with self.aget('/') as response:
            self.assertEqual(response.status, 200)
            self.assertIn(b'>Welcome</h1>', await response.read())
            self.assertIn(b'Register now</a> for free and get started',
                          await response.read())

        # Only admin so far
        db = self.get_db_session()
        self.assertEqual([user.login
                          for user in db.query(database.User).all()],
                         ['admin'])

        # Fetch registration page, should hit cookies prompt
        async with self.aget('/register') as response:
            self.assertEqual(response.status, 302)
            self.assertEqual(response.headers['Location'],
                             '/cookies?next=%2Fregister')

        # Accept cookies
        async with self.apost(
            '/cookies',
            data=dict(next='/register'),
        ) as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/register')

        # Fetch registration page
        async with self.aget('/register') as response:
            self.assertEqual(response.status, 200)

        # Register
        async with self.apost(
            '/register',
            data=dict(login='Tester',
                      password1='hacktoo', password2='hacktoo'),
        ) as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/')

        # User exists in database
        db = self.get_db_session()
        self.assertEqual([user.login
                          for user in db.query(database.User).all()],
                         ['admin', 'tester'])

        # Fetch index, should have project list
        async with self.aget('/') as response:
            self.assertEqual(response.status, 200)
            self.assertIn(b'>Welcome tester</h1>', await response.read())
            self.assertIn(b'Here are your projects', await response.read())

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

        # Log out
        async with self.aget('/logout') as response:
            self.assertEqual(response.status, 302)
            self.assertEqual(response.headers['Location'], '/')

        # Hit error page
        async with self.aget('/api/project/1/highlights/') as response:
            self.assertEqual(response.status, 403)
            self.assertEqual(await response.json(), {"error": "Not logged in"})

        # Fetch login page
        async with self.aget(
            '/login?' + urlencode(dict(next='/project/1')),
        ) as response:
            self.assertEqual(response.status, 200)

        # Log in
        async with self.apost(
            '/login',
            data=dict(next='/project/1', login='admin', password='hackme'),
        ) as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/project/1')

        # Check redirect to account
        async with self.aget('/.well-known/change-password') as response:
            self.assertEqual(response.status, 301)
            self.assertEqual(response.headers['Location'], '/account')

        # Check /api/check_user endpoint
        async with self.apost(
            '/api/check_user',
            json=dict(login='admin'),
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"exists": True})
        async with self.apost(
            '/api/check_user',
            json=dict(login='\xE9'),
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"exists": False})
        async with self.apost(
            '/api/check_user',
            json=dict(login='clay'),
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"exists": False})
