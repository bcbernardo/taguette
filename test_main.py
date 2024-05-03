import unittest
import logging

if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.discover(start_dir='./tests', pattern='test_*.py')
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

if __name__ == '__main__':
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s: %(message)s",
    )
    unittest.main()
