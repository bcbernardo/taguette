import io
import unittest
from taguette import import_codebook


class TestReadCodebook(unittest.TestCase):
    def test_valid_csv(self):
        self.assertEqual(
            import_codebook.list_tags(io.BytesIO(
                (
                    'name,other,description\n'
                    + 'interesting,1,\n'
                    + 'people,2,Named persons\n'
                ).encode('utf-8'),
            )),
            [
                {'path': 'interesting', 'color': '',
                 'parent': '', 'description': ''},
                {'path': 'people', 'color': '',
                 'parent': '', 'description': 'Named persons'},
            ]
        )

        self.assertEqual(
            import_codebook.list_tags(io.BytesIO(
                (
                    'name,color,parent,description\n'
                    + 'interesting,,,,\n'
                    + 'people,#a55ccc,interesting,Named persons\n'
                ).encode('utf-8'),
            )),
            [
                {'path': 'interesting', 'color': '',
                 'parent': '', 'description': ''},
                {'path': 'people', 'color': '#a55ccc',
                 'parent': 'interesting', 'description': 'Named persons'},
            ]
        )

        self.assertEqual(
            import_codebook.list_tags(io.BytesIO(
                (
                    'other,path\n'
                    + '1,interesting\n'
                    + '2,people\n'
                ).encode('utf-8'),
            )),
            [
                {'path': 'interesting', 'color': '',
                 'parent': '', 'description': ''},
                {'path': 'people', 'color': '',
                 'parent': '', 'description': ''},
            ]
        )

        self.assertEqual(
            import_codebook.list_tags(io.BytesIO(
                (
                    'other,path\n'
                    + '1,interesting\n'
                    + ',\n'
                    + '2,people\n'
                    + ',\n'
                    + ',\n'
                ).encode('utf-8'),
            )),
            [
                {'path': 'interesting', 'color': '',
                 'parent': '', 'description': ''},
                {'path': 'people', 'color': '',
                 'parent': '', 'description': ''},
            ]
        )

    def test_invalid_csv(self):
        with self.assertRaises(import_codebook.InvalidCodebook) as err:
            import_codebook.list_tags(io.BytesIO(
                (
                    'name,other,path\n'
                    + 'a,b,c\n'
                    + 'd,e,f\n'
                ).encode('utf-8'),
            ))
        self.assertEqual(
            err.exception.message,
            "Not sure which column to use for tag name",
        )
        self.assertIsNone(err.exception.row)

        with self.assertRaises(import_codebook.InvalidCodebook) as err:
            import_codebook.list_tags(io.BytesIO(
                (
                    'col1,col2,col3\n'
                    + 'a,b,c\n'
                    + 'd,e,f\n'
                ).encode('utf-8'),
            ))
        self.assertEqual(
            err.exception.message,
            "No 'tag', 'name', or 'path' column",
        )
        self.assertIsNone(err.exception.row)

        with self.assertRaises(import_codebook.InvalidCodebook) as err:
            import_codebook.list_tags(io.BytesIO(
                (
                    'name,other,description\n'
                    + 'interesting,1,\n'
                    + ',2,Named persons\n'
                ).encode('utf-8'),
            ))
        self.assertEqual(
            err.exception.message,
            "Empty tag name",
        )
        self.assertEqual(err.exception.row, 3)


if __name__ == '__main__':
    unittest.main()
