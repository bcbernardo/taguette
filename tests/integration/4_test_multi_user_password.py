import re
import time
from unittest import mock
from urllib.parse import urlparse

from tornado.testing import gen_test

from taguette import database
from .test_multi_user import TestMultiUser


class TestMultiUserPassword(TestMultiUser):

    @gen_test(timeout=60)
    async def test_reset_password(self):
        # Accept cookies
        async with self.apost('/cookies', data=dict()) as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/')

        # Fetch registration page
        async with self.aget('/register') as response:
            self.assertEqual(response.status, 200)

        # Register
        async with self.apost(
            '/register',
            data=dict(
                login='User',
                password1='pass1', password2='pass1',
                email='test@example.com',
            ),
        ) as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/')

        # User exists in database
        db = self.get_db_session()
        self.assertEqual(
            [
                (
                    user.login,
                    bool(user.hashed_password), bool(user.password_set_date),
                    await user.check_password('pass1'),
                    await user.check_password('pass2'),
                )
                for user in db.query(database.User).all()
            ],
            [
                ('admin', True, True, False, False),
                ('user', True, True, True, False),
            ],
        )

        # Log out
        async with self.aget('/logout') as response:
            self.assertEqual(response.status, 302)
            self.assertEqual(response.headers['Location'], '/')

        # Wait so that reset link is more recent than password
        time.sleep(1)

        # Send reset link
        async with self.aget('/reset_password') as response:
            self.assertEqual(response.status, 200)
        with mock.patch.object(self.application, 'send_mail') as mo:
            async with self.apost(
                '/reset_password',
                data=dict(email='test@example.com'),
            ) as response:
                self.assertEqual(response.status, 200)
        msg = mo.call_args[0][0]
        content = msg.get_payload()[0].get_content()
        self.assertTrue(content.startswith("Someone has requested "))
        link = re.search(r'https:\S*', content).group(0)
        token = urlparse(link).query[12:]

        # Check wrong tokens don't work
        async with self.aget(
            '/new_password?reset_token=wrongtoken',
        ) as response:
            self.assertEqual(response.status, 403)
        async with self.apost(
            '/new_password',
            data=dict(
                reset_token='wrongtoken',
                password1='pass3', password2='pass3',
            ),
        ) as response:
            self.assertEqual(response.status, 403)

        # Check right token works
        async with self.aget('/new_password?reset_token=' + token) as response:
            self.assertEqual(response.status, 200)
        async with self.apost(
            '/new_password',
            data=dict(
                reset_token=token,
                password1='pass2', password2='pass2',
            ),
        ) as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers['Location'], '/')

        # User exists in database
        db = self.get_db_session()
        self.assertEqual(
            [
                (
                    user.login,
                    bool(user.hashed_password), bool(user.password_set_date),
                    await user.check_password('pass1'),
                    await user.check_password('pass2'),
                )
                for user in db.query(database.User).all()
            ],
            [
                ('admin', True, True, False, False),
                ('user', True, True, False, True),
            ],
        )

        # Check token doesn't work anymore
        async with self.apost(
            '/new_password',
            data=dict(
                reset_token=token,
                password1='pass4', password2='pass4',
            ),
        ) as response:
            self.assertEqual(response.status, 403)
        async with self.aget('/new_password?reset_token=' + token) as response:
            self.assertEqual(response.status, 403)
