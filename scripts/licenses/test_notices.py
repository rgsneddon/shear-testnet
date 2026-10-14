import io
import os
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import notices  # noqa: E402
import release_notices  # noqa: E402

REPO = notices.REPO


class ElectTest(unittest.TestCase):
    def test_prefers_mit_from_a_choice(self):
        self.assertEqual(notices.elect("Apache-2.0 OR MIT", notices.ALLOWED), ["MIT"])
        self.assertEqual(notices.elect("MIT/Apache-2.0", notices.ALLOWED), ["MIT"])

    def test_and_needs_every_part(self):
        self.assertEqual(
            notices.elect("(MIT OR Apache-2.0) AND Unicode-3.0", notices.ALLOWED), ["MIT", "Unicode-3.0"]
        )

    def test_copyleft_is_refused_unless_allowed(self):
        self.assertIsNone(notices.elect("MPL-2.0", notices.ALLOWED))
        self.assertIsNone(notices.elect("GPL-3.0-or-later", notices.ALLOWED))
        self.assertIsNone(notices.elect("MIT AND GPL-3.0-or-later", notices.ALLOWED))
        self.assertEqual(notices.elect("MPL-2.0", notices.ALLOWED | {"MPL-2.0"}), ["MPL-2.0"])

    def test_with_exception(self):
        self.assertEqual(
            notices.elect("Apache-2.0 WITH LLVM-exception", notices.ALLOWED), ["Apache-2.0 WITH LLVM-exception"]
        )


class PolicyTest(unittest.TestCase):
    manifest = {"policy": {"mpl_allowed": ["@ethereumjs/*"], "license_refs_allowed": [], "missing_license_file_allowed": []}}

    def comp(self, kind, name, lic, dev=False, text=True):
        c = notices.Component(kind, name, "1.0.0", lic, dev=dev)
        if text:
            c.texts.append(notices.Text("LICENSE", "text"))
        return c

    def test_shipped_gpl_fails_and_dev_gpl_passes(self):
        errs = notices.policy([self.comp("npm", "x", "GPL-3.0-or-later")], self.manifest)
        self.assertTrue(errs)
        errs = notices.policy([self.comp("npm", "x", "GPL-3.0-or-later", dev=True)], self.manifest)
        self.assertEqual(errs, [])

    def test_mpl_only_for_listed_scope(self):
        self.assertEqual(notices.policy([self.comp("npm", "@ethereumjs/evm", "MPL-2.0")], self.manifest), [])
        self.assertTrue(notices.policy([self.comp("npm", "other", "MPL-2.0")], self.manifest))

    def test_unknown_and_missing_text_fail(self):
        self.assertTrue(notices.policy([self.comp("cargo", "x", "UNDECLARED")], self.manifest))
        self.assertTrue(notices.policy([self.comp("cargo", "x", "MIT", text=False)], self.manifest))


class TextTest(unittest.TestCase):
    def test_classify_spdx_texts(self):
        for spdx in ("MIT", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause", "ISC", "Zlib", "MPL-2.0", "Unlicense", "CC0-1.0"):
            body = open(os.path.join(REPO, "LICENSES", notices.SPDX_TEXT[spdx]), encoding="utf-8").read()
            self.assertIn(spdx, notices.classify(body), spdx)

    def test_holders_skip_boilerplate(self):
        text = "MIT License\n\nCopyright (c) 2018 Jack O'Connor\n\nCOPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM\n(c) under Patent Claims"
        self.assertEqual(notices.holders_in(text), ["Copyright (c) 2018 Jack O'Connor"])


class ReleaseNoticesTest(unittest.TestCase):
    def test_zip_gets_every_notice(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            release_notices.write_notices(z, REPO, prefix="x/")
        names = zipfile.ZipFile(buf).namelist()
        release_notices.assert_has_notices(names, REPO, prefix="x/")
        self.assertIn("x/THIRD_PARTY_NOTICES.txt", names)
        self.assertIn("x/LICENSES/MIT.txt", names)
        with self.assertRaises(SystemExit):
            release_notices.assert_has_notices([n for n in names if n != "x/LICENSE"], REPO, prefix="x/")

    def test_copy_notices(self):
        with tempfile.TemporaryDirectory() as d:
            release_notices.copy_notices(d, REPO)
            self.assertTrue(os.path.isfile(os.path.join(d, "LICENSES", "third-party", "nodejs", "LICENSE")))

    def test_dev_npm_packages_are_filtered(self):
        keep = release_notices.npm_dir_filter(REPO)
        self.assertFalse(keep("node_modules/solc"))
        self.assertTrue(keep("node_modules/@noble/hashes"))

    def test_binary_in_checkout_uses_bundled_licence(self):
        files = release_notices.license_files_for(os.path.join(REPO, "runtime", "node.exe"), REPO)
        self.assertEqual(files, [os.path.join(REPO, "LICENSES", "third-party", "nodejs", "LICENSE")])

    def test_unknown_windows_dll_stops_the_pack(self):
        release_notices.assert_windows_dlls_covered([r"C:\msys64\mingw64\bin\libssl-3-x64.dll", "LIBWINPTHREAD-1.dll"])
        with self.assertRaises(SystemExit):
            release_notices.assert_windows_dlls_covered(["zlib1.dll"])

    def test_attribution_wording(self):
        self.assertEqual(
            release_notices.ATTRIBUTION,
            "The Shear concept was inspired by Roy D Herbert, and the Chronoflux Principia.",
        )


if __name__ == "__main__":
    unittest.main()
