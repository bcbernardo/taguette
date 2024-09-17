import random
import string
import unittest

from tornado.testing import AsyncTestCase, gen_test

from taguette import database


class TestPassword(AsyncTestCase):
    @staticmethod
    def random_password():
        alphabet = (
            string.ascii_letters + string.digits +
            string.punctuation + string.whitespace
        )
        password = [random.choice(alphabet) for _ in range(4, 16)]
        return ''.join(password)

    @gen_test(timeout=15)
    async def test_default(self):
        has_scrypt = True
        try:
            from hashlib import scrypt as _scrypt  # noqa: F401
        except ImportError:
            has_scrypt = False

        user = database.User(login='user')
        self.assertFalse(await user.check_password('hackme'))
        await user.set_password('test')
        if has_scrypt:
            self.assertTrue(user.hashed_password.startswith('scrypt:'))
        else:
            self.assertTrue(user.hashed_password.startswith('pbkdf2:'))

    @gen_test(timeout=15)
    async def test_scrypt(self):
        try:
            from hashlib import scrypt as _scrypt  # noqa: F401
        except ImportError:
            self.skipTest("Doesn't have scrypt")

        for _ in range(3):
            password = self.random_password()
            user = database.User(login='user')
            await user.set_password(password, 'scrypt')
            self.assertTrue(user.hashed_password.startswith('scrypt:'))
            self.assertTrue(await user.check_password(password))
            self.assertFalse(await user.check_password(password[:-1]))

    @gen_test(timeout=15)
    async def test_pbkdf2(self):
        for _ in range(3):
            password = self.random_password()
            user = database.User(login='user')
            await user.set_password(password, 'pbkdf2')
            self.assertTrue(user.hashed_password.startswith('pbkdf2:'))
            self.assertTrue(await user.check_password(password))
            self.assertFalse(await user.check_password(password[:-1]))

    @gen_test(timeout=15)
    async def test_bcrypt(self):
        for _ in range(3):
            password = self.random_password()
            user = database.User(login='user')
            await user.set_password(password, 'bcrypt')
            self.assertTrue(user.hashed_password.startswith('bcrypt:'))
            self.assertTrue(await user.check_password(password))
            self.assertFalse(await user.check_password(password[:-1]))


if __name__ == '__main__':
    unittest.main()
