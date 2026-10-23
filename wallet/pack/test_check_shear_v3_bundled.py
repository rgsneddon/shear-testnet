#!/usr/bin/env python3
"""Cheap checks for the libshear_v3 artifact gate. No APK build."""
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from check_shear_v3_bundled import missing


def _zip(names):
    handle = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    handle.close()
    path = Path(handle.name)
    with zipfile.ZipFile(path, "w") as z:
        for name in names:
            z.writestr(name, b"x")
    return path


def _apk(names):
    handle = tempfile.NamedTemporaryFile(suffix=".apk", delete=False)
    handle.close()
    path = Path(handle.name)
    with zipfile.ZipFile(path, "w") as z:
        for name in names:
            z.writestr(name, b"x")
    return path


class BundleTest(unittest.TestCase):
    def test_apk_requires_v3_next_to_each_shipped_abi(self):
        path = _apk(
            [
                "lib/arm64-v8a/libshear_admit.so",
                "lib/arm64-v8a/libshear_v3.so",
            ]
        )
        self.addCleanup(path.unlink)
        self.assertEqual(missing(path), [])

    def test_apk_refuses_an_abi_that_skipped_v3(self):
        path = _apk(["lib/arm64-v8a/libshear_admit.so"])
        self.addCleanup(path.unlink)
        self.assertEqual(missing(path), ["lib/arm64-v8a/libshear_v3.so"])

    def test_zip_accepts_any_of_the_three_library_names(self):
        for name in (
            "lib/libshear_v3.so",
            "shear_v3.dll",
            "Shear.app/Contents/Frameworks/libshear_v3.dylib",
        ):
            path = _zip([name, "lib/libshear_admit.so"])
            self.addCleanup(path.unlink)
            self.assertEqual(missing(path), [], name)

    def test_zip_refuses_admit_only(self):
        path = _zip(["lib/libshear_admit.so"])
        self.addCleanup(path.unlink)
        self.assertTrue(missing(path))


if __name__ == "__main__":
    unittest.main()
