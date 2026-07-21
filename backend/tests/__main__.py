"""Run the auth tests. Used by ``start.sh`` (analogous to the
``backend.expense`` self-test) and by developers running tests directly.
"""
import unittest


def main() -> int:
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromName("backend.tests.test_auth")
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
