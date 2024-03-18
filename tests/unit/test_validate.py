import unittest
from taguette import web


class TestValidate(unittest.TestCase):
    def test_export_filename(self):
        self.assertEqual(
            web.export.safe_filename('**My sweet project / 2**'),
            'My sweet project  2',
        )
        self.assertEqual(
            web.export.safe_filename("Rémi's project"),
            "Rmis project",
        )


if __name__ == '__main__':
    unittest.main()
