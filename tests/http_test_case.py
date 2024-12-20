import aiohttp
from urllib.parse import urlencode
from tornado.testing import AsyncHTTPTestCase
from taguette import validate, web


class MyHTTPTestCase(AsyncHTTPTestCase):
    xsrf = None

    def setUp(self):
        web.Application.check_messages = lambda s: s.messages_event.set()
        validate.filename.windows = True  # escape device names
        super(MyHTTPTestCase, self).setUp()

        # Tornado's http client doesn't support cookies, use aiohttp instead
        @self.io_loop.run_sync
        async def async_init():
            self.http_client = aiohttp.ClientSession(
                # Need to set 'unsafe' to work when host is an IP address
                cookie_jar=aiohttp.cookiejar.CookieJar(unsafe=True),
            )
            await self.http_client.__aenter__()

    def tearDown(self):
        self.io_loop.run_sync(
            lambda: self.http_client.close(),
            timeout=3,
        )

    def _fetch(self, url, method='GET', **kwargs):
        # Copied from tornado.testing.AsyncHTTPTestCase.fetch()
        if not url.lower().startswith(('http://', 'https://')):
            url = self.get_url(url)
        return getattr(self.http_client, method.lower())(url, **kwargs)

    def aget(self, url, headers=None):
        return self._fetch(url, headers=headers, allow_redirects=False)

    def apost(self, url, **kwargs):
        cookies = self.http_client.cookie_jar.filter_cookies(self.get_url('/'))
        if '_xsrf' in cookies:
            token = cookies['_xsrf'].value
            if 'data' in kwargs:
                if isinstance(kwargs['data'], dict):
                    kwargs['data'] = dict(kwargs['data'], _xsrf=token)
            else:
                url = '%s%s%s' % (url, '&' if '?' in url else '?',
                                  urlencode(dict(_xsrf=token)))
        if 'files' in kwargs:
            files = kwargs.pop('files')
            data = aiohttp.FormData()
            for key, value in kwargs.get('data', {}).items():
                data.add_field(key, value)
            for key, (filename, content_type, value) in files.items():
                data.add_field(
                    key, value,
                    content_type=content_type,
                    filename=filename,
                )
            kwargs['data'] = data
        return self._fetch(url, method='POST', allow_redirects=False, **kwargs)

    def adelete(self, url):
        cookies = self.http_client.cookie_jar.filter_cookies(self.get_url('/'))
        if '_xsrf' in cookies:
            token = cookies['_xsrf'].value
            url = '%s%s%s' % (url, '&' if '?' in url else '?',
                              urlencode(dict(_xsrf=token)))
        return self._fetch(url, method='DELETE')
