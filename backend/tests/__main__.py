"""Run the backend tests. Used by ``start.sh`` (analogous to the
``backend.expense`` self-test) and by developers running tests directly.
"""
import unittest


def main() -> int:
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    for name in ("backend.tests.test_auth", "backend.tests.test_plans"):
        suite.addTests(loader.loadTestsFromName(name))
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
