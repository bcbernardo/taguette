# tests/unit/base_test.py
import itertools
import unittest
from taguette import extract


class TestMeasure(unittest.TestCase):
    def test_extract_highlight(self):
        """Tests extracting a highlight from an HTML document."""
        html = '<p><u>H\xE9llo</u> R\xE9mi <i>what is</i> up ?</p>'
        snippet = extract.extract(html, 7, 15)
        self.assertEqual(snippet,
                         '<p>R\xE9mi <i>wh</i></p>')
        snippet = extract.extract(html, 1, 5)
        self.assertEqual(snippet,
                         '<p><u>\xE9ll</u></p>')
        snippet = extract.extract(html, 7, 12)
        self.assertEqual(snippet,
                         '<p>R\xE9mi</p>')

    def test_highlight(self):
        """Tests highlighting an HTML document with only ASCII characters."""
        html = '<p><u>Hello</u> there <i>World</i></p>'
        highlights = [
            (0, 1, ['tag1']), (2, 3, []),
            (4, 8, ['tag1', 'tag2']), (10, 14, ['tag2']), (15, 17, ['tag1']),
        ]
        self.assertEqual(
            extract.highlight(html, highlights)
            .replace('<span class="highlight">', '{')
            .replace('</span>', '}'),
            '<p><u>{H}e{l}l{o}</u>{ th}er{e }<i>{Wo}r{ld}</i></p>',
        )

        self.assertEqual(
            extract.highlight(html, highlights, show_tags=True)
            .replace('<span class="taglist"> [', '[')
            .replace(']</span>', ']')
            .replace('<span class="highlight">', '{')
            .replace('</span>', '}'),
            '<p><u>{H}[tag1]e{l}[]l{o}</u>{ th}[tag1, tag2]er{e }' +
            '<i>{Wo}[tag2]r{ld}[tag1]</i></p>',
        )

    def test_highlight_unicode(self):
        """Tests highlighting an HTML document with unicode characters."""
        html = '<p><u>H\xE9ll\xF6</u> the\xAEe <i>\u1E84o\xAEld</i>!</p>'
        highlights = [
            (0, 1, ['tag1']), (3, 4, []),
            (6, 10, ['tag1', 'tag2']), (13, 19, ['tag2']), (21, 23, ['tag1']),
        ]
        self.assertEqual(
            extract.highlight(html, highlights)
            .replace('<span class="highlight">', '{')
            .replace('</span>', '}'),
            '<p><u>{H}\xE9{l}l{\xF6}</u>{ th}e\xAE'
            '{e }<i>{\u1E84o}\xAE{ld}</i>!</p>',
        )

        self.assertEqual(
            extract.highlight(html, highlights, show_tags=True)
            .replace('<span class="taglist"> [', '[')
            .replace(']</span>', ']')
            .replace('<span class="highlight">', '{')
            .replace('</span>', '}'),
            '<p><u>{H}[tag1]\xE9{l}[]l{\xF6}</u>{ th}[tag1, tag2]e\xAE'
            '{e }<i>{\u1E84o}[tag2]\xAE{ld}[tag1]</i>!</p>',
        )

    def test_highlight_nested(self):
        """Test highlighting an HTML document when highlights are nested."""
        html = '<p><u>Hello</u> there <i>World</i></p>'

        # Do all the combinations of nesting orders
        starts = [0, 3, 10]
        for ends in itertools.permutations([14, 15, 17]):
            highlights = [
                (starts[0], ends[0], ['tag1']), (starts[1], ends[1], []),
                (starts[2], ends[2], ['tag1', 'tag2']),
            ]

            self.assertEqual(
                extract.highlight(html, highlights)
                .replace('<span class="highlight">', '{')
                .replace('</span>', '}'),
                '<p><u>{Hello}</u>{ there }<i>{World}</i></p>',
            )

            expected = {
                (14, 15, 17): '<p><u>{Hello}</u>{ ther'
                              'e }<i>{Wo}[tag1]{r}[]{ld}[tag1, tag2]</i></p>',
                (14, 17, 15): '<p><u>{Hello}</u>{ ther'
                              'e }<i>{Wo}[tag1]{r}[tag1, tag2]{ld}[]</i></p>',
                (15, 14, 17): '<p><u>{Hello}</u>{ ther'
                              'e }<i>{Wo}[]{r}[tag1]{ld}[tag1, tag2]</i></p>',
                (15, 17, 14): '<p><u>{Hello}</u>{ ther'
                              'e }<i>{Wo}[tag1, tag2]{r}[tag1]{ld}[]</i></p>',
                (17, 14, 15): '<p><u>{Hello}</u>{ ther'
                              'e }<i>{Wo}[]{r}[tag1, tag2]{ld}[tag1]</i></p>',
                (17, 15, 14): '<p><u>{Hello}</u>{ ther'
                              'e }<i>{Wo}[tag1, tag2]{r}[]{ld}[tag1]</i></p>',
            }[ends]
            self.assertEqual(
                extract.highlight(html, highlights, show_tags=True)
                .replace('<span class="taglist"> [', '[')
                .replace(']</span>', ']')
                .replace('<span class="highlight">', '{')
                .replace('</span>', '}'),
                expected,
                "ends=%r" % (ends,),
            )


if __name__ == '__main__':
    unittest.main()
