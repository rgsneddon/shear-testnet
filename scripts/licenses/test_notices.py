import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

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


class PodfileLockTest(unittest.TestCase):
    LOCK = (
        "PODS:\n  - DKImagePickerController/Core (4.3.9):\n    - DKImagePickerController/Resource\n"
        "  - Flutter (1.0.0)\n  - SDWebImage (5.21.7):\n    - SDWebImage/Core (= 5.21.7)\n"
        "  - SDWebImage/Core (5.21.7)\n\nDEPENDENCIES:\n  - Flutter (from `Flutter`)\n\n"
        "SPEC REPOS:\n  trunk:\n    - DKImagePickerController\n    - SDWebImage\n\nEXTERNAL SOURCES:\n"
    )

    def test_trunk_pods_with_versions(self):
        self.assertEqual(
            notices.podfile_lock_trunk_pods(self.LOCK), {"DKImagePickerController": "4.3.9", "SDWebImage": "5.21.7"}
        )

    def test_committed_lock_matches_the_reviewed_pods(self):
        manifest = __import__("json").load(open(notices.MANIFEST))
        self.assertEqual(notices.ios_pod_checks(manifest), [])


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
        release_notices.assert_windows_dlls_covered([r"C:\msys64\mingw64\bin\libssl-3-x64.dll", "LIBCRYPTO-3-x64.dll"])
        with self.assertRaises(SystemExit):
            release_notices.assert_windows_dlls_covered(["zlib1.dll"])

    def test_mingw_runtime_dlls_are_never_shipped(self):
        for dll in ("libgcc_s_seh-1.dll", "libstdc++-6.dll", r"runtime\LIBWINPTHREAD-1.dll"):
            with self.assertRaises(SystemExit):
                release_notices.assert_windows_dlls_covered([dll])

    @staticmethod
    def minimal_elf_needed(sonames):
        """ELF64 whose DT_NEEDED entries are exactly sonames. One PT_LOAD covers the file."""
        import struct

        blobs = b"".join(name + b"\0" for name in sonames)
        dyn_off = 64 + 56 * 2
        dyn_size = (len(sonames) + 2) * 16
        str_off = dyn_off + dyn_size
        filesz = str_off + len(blobs)
        vbase = 0x400000
        ehdr = struct.pack(
            "<16sHHIQQQIHHHHHH",
            b"\x7fELF\x02\x01\x01" + b"\0" * 9,
            3, 0x3E, 1,
            0, 64, 0, 0,
            64, 56, 2, 0, 0, 0,
        )
        load = struct.pack("<IIQQQQQQ", 1, 5, 0, vbase, vbase, filesz, filesz, 0x1000)
        dynamic = struct.pack(
            "<IIQQQQQQ", 2, 6, dyn_off, vbase + dyn_off, vbase + dyn_off, dyn_size, dyn_size, 8,
        )
        dyn = b""
        off = 0
        for name in sonames:
            dyn += struct.pack("<qQ", 1, off)
            off += len(name) + 1
        dyn += struct.pack("<qQ", 5, vbase + str_off)
        dyn += struct.pack("<qQ", 0, 0)
        return ehdr + load + dynamic + dyn + blobs

    @staticmethod
    def minimal_pe(dlls):
        """A PE32+ image with one section holding an import directory for dlls."""
        import struct

        sect_rva, sect_raw = 0x1000, 0x200
        desc = 20 * (len(dlls) + 1)
        names, blob = [], b""
        for d in dlls:
            names.append(sect_rva + desc + len(blob))
            blob += d.encode() + b"\0"
        body = b"".join(struct.pack("<IIIII", 0, 0, 0, n, 0) for n in names) + b"\0" * 20 + blob
        opt = bytearray(240)
        struct.pack_into("<H", opt, 0, 0x20B)
        struct.pack_into("<II", opt, 112 + 8, sect_rva, desc)
        section = b".idata\0\0" + struct.pack("<IIII", len(body), sect_rva, len(body), sect_raw) + b"\0" * 16
        pe = 0x40
        head = bytearray(sect_raw)
        head[:2] = b"MZ"
        struct.pack_into("<I", head, 0x3C, pe)
        head[pe:pe + 4] = b"PE\0\0"
        struct.pack_into("<HHIIIHH", head, pe + 4, 0x8664, 1, 0, 0, 0, len(opt), 0x2022)
        head[pe + 24:pe + 24 + len(opt)] = opt
        head[pe + 24 + len(opt):pe + 24 + len(opt) + 40] = section
        return bytes(head) + body

    def test_linux_packs_refuse_the_gcc_runtime(self):
        self.assertTrue(release_notices.is_gcc_runtime("lib/libstdc++.so.6"))
        self.assertTrue(release_notices.is_gcc_runtime("libgcc_s.so.1"))
        self.assertFalse(release_notices.is_gcc_runtime("libgcc_s_seh-1.dll"))
        release_notices.assert_ships_no_gcc_runtime(["runtime/node", "runtime/libnode.so.127"])
        with self.assertRaises(SystemExit) as caught:
            release_notices.assert_ships_no_gcc_runtime(["runtime/libstdc++.so.6", "libgcc_s.so.1"])
        self.assertIn("libgcc_s.so.1", str(caught.exception))
        # A real distro binary still has to name libc. Ubuntu 26's ls also
        # needs libgcc_s.so.1, so it is not the clean addon sample.
        if os.path.isfile("/usr/bin/ls"):
            needed = release_notices.elf_needed("/usr/bin/ls")
            self.assertIn("libc.so.6", needed)
        with tempfile.TemporaryDirectory() as d:
            kept = os.path.join(d, "shearhash.node")
            open(kept, "wb").write(self.minimal_elf_needed([b"libc.so.6"]))
            self.assertEqual(release_notices.elf_needed(kept), ["libc.so.6"])
            release_notices.assert_no_gcc_runtime([kept])
            gcc = os.path.join(d, "gcc.node")
            open(gcc, "wb").write(self.minimal_elf_needed([b"libc.so.6", b"libgcc_s.so.1"]))
            with self.assertRaises(SystemExit) as gcc_hit:
                release_notices.assert_no_gcc_runtime([gcc])
            self.assertIn("libgcc_s.so.1", str(gcc_hit.exception))
            shipped = os.path.join(d, "libstdc++.so.6")
            open(shipped, "wb").write(b"")
            with self.assertRaises(SystemExit):
                release_notices.assert_linux_tree_clean(d)

    def test_pe_imports_and_static_runtime_check(self):
        with tempfile.TemporaryDirectory() as d:
            static = os.path.join(d, "shearhash.node")
            shared = os.path.join(d, "ShearK-Miner.exe")
            open(static, "wb").write(self.minimal_pe(["KERNEL32.dll", "msvcrt.dll", "node.exe"]))
            open(shared, "wb").write(self.minimal_pe(["KERNEL32.dll", "libstdc++-6.dll", "libgcc_s_seh-1.dll"]))
            self.assertEqual(release_notices.pe_imports(static), ["KERNEL32.dll", "msvcrt.dll", "node.exe"])
            release_notices.assert_no_mingw_runtime([static])
            with self.assertRaises(SystemExit) as caught:
                release_notices.assert_no_mingw_runtime([static, shared])
            self.assertIn("libstdc++-6.dll, libgcc_s_seh-1.dll", str(caught.exception))

    def test_runtime_versions_are_read_from_the_binaries(self):
        with tempfile.TemporaryDirectory() as d:
            files = {
                "node": b"\0https://nodejs.org/download/release/v22.12.0/node-v22.12.0-headers.tar.gz\0OpenSSL 3.0.15+quic 3 Sep 2024\0",
                "libsodium.so.23": b"\0\0\x001.0.18\x00stable\0",
                "libcrypto.so.3": b"\0OpenSSL 3.0.13 30 Jan 2024\0",
                "libssl.so.3": b"\0no version text here\0",
            }
            for name, data in files.items():
                open(os.path.join(d, name), "wb").write(data)
            rows = release_notices.runtime_versions([os.path.join(d, n) for n in files])
            got = {(c, v) for c, v, _s in rows}
            self.assertEqual(
                got,
                {("Node.js", "22.12.0"), ("OpenSSL (built into Node.js)", "3.0.15"), ("libsodium", "1.0.18"), ("OpenSSL", "3.0.13")},
            )
            text = release_notices.runtime_versions_text([os.path.join(d, "node")])
            self.assertIn("Node.js: 22.12.0 [node]", text)

    def test_runtime_version_must_be_known(self):
        with tempfile.TemporaryDirectory() as d:
            lib = os.path.join(d, "libsodium.so.26")
            open(lib, "wb").write(b"no version")
            with self.assertRaises(SystemExit):
                release_notices.runtime_versions([lib])
            os.environ["SHEAR_RUNTIME_VERSION_LIBSODIUM_SO_26"] = "1.0.20"
            try:
                self.assertEqual(release_notices.runtime_versions([lib])[0][1], "1.0.20")
            finally:
                del os.environ["SHEAR_RUNTIME_VERSION_LIBSODIUM_SO_26"]

    def test_release_notes_need_recorded_versions(self):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import release_notes_versions

        with tempfile.TemporaryDirectory() as d:
            good, bad, plain = (os.path.join(d, n) for n in ("good.zip", "bad.zip", "plain.zip"))
            with zipfile.ZipFile(good, "w") as z:
                z.writestr("runtime/node", b"")
                z.writestr("RUNTIME-VERSIONS.txt", "header\n\nNode.js: 22.12.0 [node]\n")
            with zipfile.ZipFile(bad, "w") as z:
                z.writestr("lib/libsodium.so.23", b"")
            with zipfile.ZipFile(plain, "w") as z:
                z.writestr("shear_wallet", b"")
            self.assertIn("Node.js: 22.12.0 [node]", release_notes_versions.section(good))
            self.assertIn("No bundled", release_notes_versions.section(plain))
            with self.assertRaises(SystemExit):
                release_notes_versions.section(bad)

    def test_attribution_wording(self):
        self.assertEqual(
            release_notices.ATTRIBUTION,
            "The Shear concept was inspired by Roy D Herbert, and the Chronoflux Principia.",
        )


class FontInstallTests(unittest.TestCase):
    def test_css_does_not_reference_deleted_commercial_fonts(self):
        root = Path(__file__).resolve().parents[2]
        hits = []
        for path in root.rglob("*.css"):
            if "node_modules" in path.parts or ".git" in path.parts:
                continue
            text = path.read_text(encoding="utf-8")
            rel = str(path.relative_to(root))
            if re.search(r"url\(\s*[\"']?[^)\"']*(?:nevia|urema)", text, re.I):
                hits.append(rel)
            for match in re.finditer(r"url\(\s*[\"']?([^)\"']+\.woff2)", text, re.I):
                if not re.fullmatch(r"/fonts/greatvibes/greatvibes-[A-Za-z0-9_-]+\.woff2", match.group(1)):
                    hits.append(rel + " " + match.group(1))
        self.assertEqual(hits, [])

    def test_great_vibes_stays_tracked_and_install_copies_it(self):
        root = Path(__file__).resolve().parents[2]
        gv = root / "fonts" / "greatvibes"
        woff2 = [
            "greatvibes-RWmMoKWR9v4ksMfaWd_JN9XIiaQ6DQ.woff2",
            "greatvibes-RWmMoKWR9v4ksMfaWd_JN9XBiaQ6DQ.woff2",
            "greatvibes-RWmMoKWR9v4ksMfaWd_JN9XJiaQ6DQ.woff2",
            "greatvibes-RWmMoKWR9v4ksMfaWd_JN9XKiaQ6DQ.woff2",
            "greatvibes-RWmMoKWR9v4ksMfaWd_JN9XLiaQ6DQ.woff2",
            "greatvibes-RWmMoKWR9v4ksMfaWd_JN9XFiaQ.woff2",
        ]
        css = (gv / "great-vibes.css").read_text(encoding="utf-8")
        self.assertNotIn(".ttf", css)
        for name in woff2:
            font = gv / name
            self.assertTrue(font.is_file(), name)
            self.assertEqual(font.read_bytes()[:4], b"wOF2")
            self.assertIn(f"/fonts/greatvibes/{name}", css)
            ignored = subprocess.run(
                ["git", "check-ignore", "-q", "--no-index", f"fonts/greatvibes/{name}"],
                cwd=root, capture_output=True, text=True,
            )
            self.assertEqual(ignored.returncode, 1, name)
            tracked = subprocess.run(
                ["git", "ls-files", "--error-unmatch", f"fonts/greatvibes/{name}"],
                cwd=root, capture_output=True, text=True,
            )
            self.assertEqual(tracked.returncode, 0, tracked.stderr)
            self.assertIn(f"fonts/greatvibes/{name}", tracked.stdout)
        self.assertFalse((gv / "GreatVibes-Regular.ttf").exists())
        ofl = gv / "OFL.txt"
        self.assertIn("SIL OPEN FONT LICENSE Version 1.1", ofl.read_text(encoding="utf-8"))
        script = (root / "deploy" / "install_fonts.sh").read_text(encoding="utf-8")
        for name in (
            "nevia/woff2/Nevia-Light.woff2",
            "nevia/woff2/Nevia-LightCondensed.woff2",
            "nevia/woff2/Nevia-Regular.woff2",
            "nevia/woff2/Nevia-ExtraBold.woff2",
            "nevia/woff2/Nevia-ExtraBoldCondensed.woff2",
            "nevia/woff2/Nevia-Black.woff2",
            "urema/woff2/Urema-Variable.woff2",
        ):
            self.assertIn(name, script)
        self.assertIn("fonts/greatvibes", script)
        src = Path(tempfile.mkdtemp())
        for name in (
            "nevia/woff2/Nevia-Light.woff2",
            "nevia/woff2/Nevia-LightCondensed.woff2",
            "nevia/woff2/Nevia-Regular.woff2",
            "nevia/woff2/Nevia-ExtraBold.woff2",
            "nevia/woff2/Nevia-ExtraBoldCondensed.woff2",
            "nevia/woff2/Nevia-Black.woff2",
            "urema/woff2/Urema-Variable.woff2",
        ):
            dest = src / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"woff2")
        env = os.environ.copy()
        env["SHEAR_FONTS_DIR"] = str(src)
        planted = (
            root / "brand" / "fonts",
            root / "site" / "brand" / "fonts",
            root / "site" / "boot" / "brand" / "fonts",
            root / "explorer" / "brand" / "fonts",
            root / "mempool" / "brand" / "fonts",
            root / "pool" / "public" / "brand" / "fonts",
            root / "team" / "brand" / "fonts",
            root / "site" / "fonts" / "greatvibes",
            root / "site" / "boot" / "fonts" / "greatvibes",
            root / "explorer" / "fonts" / "greatvibes",
            root / "mempool" / "fonts" / "greatvibes",
            root / "pool" / "public" / "fonts" / "greatvibes",
            root / "team" / "fonts" / "greatvibes",
        )
        try:
            run = subprocess.run(["bash", "deploy/install_fonts.sh"], cwd=root, env=env, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertTrue((root / "brand" / "fonts" / "nevia" / "woff2" / "Nevia-Regular.woff2").is_file())
            for name in woff2:
                self.assertTrue((root / "pool" / "public" / "fonts" / "greatvibes" / name).is_file(), name)
                self.assertFalse((root / "site" / "fonts" / "greatvibes" / "GreatVibes-Regular.ttf").exists())
            self.assertTrue((root / "site" / "fonts" / "greatvibes" / "OFL.txt").is_file())
            self.assertIn("/fonts/greatvibes/greatvibes-RWmMoKWR9v4ksMfaWd_JN9XFiaQ.woff2",
                           (root / "site" / "fonts" / "greatvibes" / "great-vibes.css").read_text(encoding="utf-8"))
            commercial = subprocess.run(
                ["git", "check-ignore", "-q", "brand/fonts/nevia/woff2/Nevia-Regular.woff2"],
                cwd=root,
            )
            self.assertEqual(commercial.returncode, 0)
            copied = subprocess.run(
                ["git", "check-ignore", "-q", "site/fonts/greatvibes/greatvibes-RWmMoKWR9v4ksMfaWd_JN9XFiaQ.woff2"],
                cwd=root,
            )
            self.assertEqual(copied.returncode, 0)
        finally:
            for path in planted:
                if path.exists():
                    shutil.rmtree(path)
            shutil.rmtree(src, ignore_errors=True)

    def test_purge_font_history_keeps_great_vibes(self):
        root = Path(__file__).resolve().parents[2]
        script = (root / "scripts" / "licenses" / "purge_font_history.sh").read_text(encoding="utf-8")
        for blanket in ("'*.otf'", "'*.ttf'", "'*.woff'", "'*.woff2'", "'*.eot'"):
            self.assertNotIn(blanket, script)
        self.assertIn("*[Nn]evia*.ttf", script)
        self.assertIn("*[Uu]rema*.woff2", script)
        self.assertIn("fonts/greatvibes/", script)
        survivor = script.split("left=", 1)[1].split("if [[", 1)[0]
        self.assertIn("fonts/greatvibes/", survivor)
        self.assertNotIn("git push", script.split("echo", 1)[0])
        checked = subprocess.run(["bash", "-n", "scripts/licenses/purge_font_history.sh"], cwd=root, capture_output=True, text=True)
        self.assertEqual(checked.returncode, 0, checked.stderr)


if __name__ == "__main__":
    unittest.main()
