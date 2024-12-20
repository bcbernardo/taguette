import unittest
from unittest import mock

from tornado.testing import AsyncTestCase, gen_test

from taguette import convert
from taguette.utils import sanitize_filename


class TestConvert(AsyncTestCase):
    config = dict(
        CONVERT_TO_HTML_TIMEOUT=60,
    )

    @gen_test
    async def test_convert_html(self):
        """Tests converting HTML, using BeautifulSoup and Bleach"""
        body = (
            b'<!DOCTYPE html>\n'
            b'<html>\n  <head>\n  <title>Test</title>\n</head>\n<body>'
            b'<h1>Example</h1><p>This is an <a>example</a> text document.\n'
            b'It should be <blink>converted</blink>.</p>\n\n'
            b'<p>It has another paragraph <strong>here</strong>, '
            b'images: <img width=\"50\" src=\"here.png\"> '
            b'<img title=\"important\" src=\"/over/there.png\" width=\"30\"> '
            b'<img src=\"http://and/the/last/one.png\" class=\"a\">, and '
            b'links: <a href=\"here\">1</a> '
            b'<a title=\"important\" href=\"/over/there\">2</a> '
            b'<a title=\"t\"href=\"http://last/one\" class=\"a\">3</a></p>\n'
            b'<table><thead><tr><th>Header1</th><th>Another</th></tr></thead>'
            b'<tbody><tr><td>1</td><td>34.9</td><td>2</td><td>98.1</td></tr>'
            b'</tbody></table>'
            b'</body></html>\n'
        )
        with mock.patch('tornado.process.Subprocess', object()):
            body = await convert.to_html(body, 'text/html', 'test.html',
                                         self.config)
        self.assertEqual(
            body,
            '<h1>Example</h1><p>This is an example text document.\n'
            'It should be converted.</p>\n\n'
            '<p>It has another paragraph <strong>here</strong>, '
            'images: <img src="/static/missing.png"> '
            '<img src="/static/missing.png"> '
            '<img src="/static/missing.png">, and '
            'links: <a title="here">1</a> '
            '<a title="/over/there">2</a> '
            '<a href="http://last/one">3</a></p>\n'
            '<table><thead><tr><th>Header1</th><th>Another</th></tr></thead>'
            '<tbody><tr><td>1</td><td>34.9</td><td>2</td><td>98.1</td></tr>'
            '</tbody></table>'
        )

        self.assertTrue(convert.is_html_safe(body))

    def test_filename(self):
        old_windows_flag = sanitize_filename.windows
        sanitize_filename.windows = True  # escape device names
        try:
            self.assertEqual(sanitize_filename('/etc/passwd'), 'passwd')
            self.assertEqual(sanitize_filename('/etc/pass.txt'), 'pass.txt')
            self.assertEqual(sanitize_filename('ééé'), '_')
            self.assertEqual(sanitize_filename('ééé.pdf'), '_.pdf')
            self.assertEqual(sanitize_filename('/tmp/NUL.pdf'), '_NUL.pdf')
            self.assertEqual(sanitize_filename('/tmp/nul.pdf'), '_nul.pdf')
            self.assertEqual(
                sanitize_filename('a_very_long_file_name.pdf'),
                'a_very_long_file_nam.pdf',
            )
            self.assertEqual(
                sanitize_filename('a_very_long_file_name'),
                'a_very_long_file_nam',
            )
            self.assertEqual(
                sanitize_filename('a_long.file_extension'),
                'a_long.file_ex',
            )
        finally:
            sanitize_filename.windows = old_windows_flag

    @gen_test
    async def test_webvtt(self):
        body = (
            b'WEBVTT\n\nSTYLE\n::cue {\n  background-image: linear-gradient('
            b'to bottom, dimgray, lightgray);\n  color: papayawhip;\n}\n'
            b'/* Style blocks cannot use blank lines nor arrows */\n\n'
            b'NOTE comment blocks can be used between style blocks.\n\n'
            b'STYLE\n::cue(b) {\n  color: peachpuff;\n}\n\n'
            b'1\n00:00:00,123 --> 00:00:03,456\nHi there\n\n'
            b'00:01:04,843 --> 00:01:05,428\n'
            b'This is an example of a\nsubtitle file in SRT format\n\n'
            b'NOTE style blocks cannot appear after the first cue.\n'
        )
        with mock.patch('tornado.process.Subprocess', object()):
            body = await convert.to_html(body, 'text/vtt', 'test.vtt',
                                         self.config)
        self.assertEqual(
            body,
            (
                '<p>00:00:00.123 Hi there</p>\n'
                '<p>00:01:04.843 This is an example of a<br>'
                'subtitle file in SRT format</p>\n'
            ),
        )


if __name__ == '__main__':
    unittest.main()
