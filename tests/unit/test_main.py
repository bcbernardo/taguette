import unittest
from taguette import main


class TestMain(unittest.TestCase):
    def test_join_url(self):
        class FakeApp(object):
            def __init__(self, token, config):
                self.single_user_token = token
                self.config = config

        self.assertEqual(
            main.get_join_url(FakeApp(
                'secret',
                {'PORT': 80, 'BASE_PATH': '/'},
            )),
            'http://localhost/?token=secret',
        )
        self.assertEqual(
            main.get_join_url(FakeApp(
                None,
                {'PORT': 80, 'BASE_PATH': '/'},
            )),
            'http://localhost/',
        )
        self.assertEqual(
            main.get_join_url(FakeApp(
                None,
                {'PORT': 8080, 'BASE_PATH': '/'},
            )),
            'http://localhost:8080/',
        )
        self.assertEqual(
            main.get_join_url(FakeApp(
                'secret',
                {'PORT': 8080, 'BASE_PATH': '/some/dir/'},
            )),
            'http://localhost:8080/some/dir/?token=secret',
        )


if __name__ == '__main__':
    unittest.main()
