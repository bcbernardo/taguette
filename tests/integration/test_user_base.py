import asyncio
import os
from datetime import datetime

import sqlalchemy
from sqlalchemy.orm import close_all_sessions

from taguette import database, main, web
from taguette import exact_version
from tests.http_test_case import MyHTTPTestCase

if 'TAGUETTE_TEST_DB' in os.environ:
    DATABASE_URI = os.environ['TAGUETTE_TEST_DB']
else:
    DATABASE_URI = 'sqlite://'
if 'TAGUETTE_TEST_REDIS' in os.environ:
    REDIS = os.environ['TAGUETTE_TEST_REDIS']
else:
    REDIS = None


async def set_dumb_password(bd_session):
    db = bd_session()
    admin = database.User(login='admin')
    await admin.set_password('hackme')
    db.add(admin)
    db.commit()
    db.close()


class TestUserBase(MyHTTPTestCase):
    multiuser = True
    cookies_prompt = True
    secret_key = 'default_secret_key'
    xsrf_cookies = True

    def generate_config(self):
        return dict(
            main.DEFAULT_CONFIG,
            NAME="Test Taguette instance",
            PORT=7465,
            DATABASE=DATABASE_URI,
            REDIS_SERVER=REDIS,
            TOS_FILE=None,
            EMAIL='test@example.com',
            MAIL_SERVER={'host': 'localhost', 'port': 25},
            COOKIES_PROMPT=self.cookies_prompt,
            MULTIUSER=self.multiuser,
            SECRET_KEY=self.secret_key,
        )

    def get_app(self):
        config = self.generate_config()
        self.application = web.make_app(config, xsrf_cookies=self.xsrf_cookies)
        self.io_loop.run_sync(
            lambda: set_dumb_password(self.application.DBSession))
        return self.application

    def tearDown(self):
        super(TestUserBase, self).tearDown()
        close_all_sessions()
        engine = sqlalchemy.create_engine(DATABASE_URI)
        database.Base.metadata.drop_all(bind=engine)

    def assertRowsEqualsExceptDates(self, first, second):
        self.assertEqual(*[
            [
                [item for item in row if not isinstance(item, datetime)]
                for row in rows]
            for rows in (first, second)
        ])

    def get_db_session(self):
        return self.application.DBSession()

    async def _poll_event(self, proj, from_id):
        async with self.aget(
            '/api/project/%d/events?version=%s&from=%d' % (
                proj, exact_version(), from_id,
            ),
        ) as response:
            self.assertEqual(response.status, 200)
            result = await response.json()
            event = result['events'][0]
            event.pop('user_login')
            return event

    async def poll_event(self, proj, from_id):
        fut = asyncio.ensure_future(self._poll_event(proj, from_id))
        await asyncio.sleep(0.2)  # Give time for the request to be sent
        return fut
