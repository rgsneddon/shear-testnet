#!/usr/bin/env python3
"""Decision tests for the release APK gate. The live APK run is separate."""
import hashlib
import json
import os
import tempfile
import unittest
import zipfile

from check_android_release import gate, libsodium_errors, normalize_sha256

PIN = "BE:4A:F2:81:B6:D5:F6:12:02:55:E9:19:F3:AD:43:B6:90:36:B3:8C:4A:F0:12:15:4B:A7:D2:01:5F:E3:C6:65"
BADGING = """package: name='com.shear.shear_wallet' versionCode='93' versionName='0.68.0'
native-code: 'armeabi-v7a' 'arm64-v8a' 'x86_64'
"""
CERTS = "Signer #1 certificate SHA-256 digest: " + PIN.replace(":", "").lower() + "\n"


class GateTest(unittest.TestCase):
    def test_pin_normalizes_colons(self):
        self.assertEqual(normalize_sha256(PIN), normalize_sha256(PIN.replace(":", "")))
        self.assertEqual(len(normalize_sha256(PIN)), 64)

    def test_matching_fat_release_passes(self):
        errors, info = gate("ignored.apk", PIN, BADGING, CERTS)
        self.assertEqual(errors, [])
        self.assertEqual(info["versionCode"], 93)
        self.assertEqual(info["package"], "com.shear.shear_wallet")

    def test_wrong_cert_is_refused(self):
        errors, _info = gate("ignored.apk", "aa" * 32, BADGING, CERTS)
        self.assertTrue(any("SHA-256" in err for err in errors))

    def test_debug_signer_is_refused(self):
        errors, _info = gate("ignored.apk", PIN, BADGING, CERTS + "CN=Android Debug\n")
        self.assertTrue(any("debug" in err for err in errors))

    def test_old_version_code_is_refused(self):
        old = BADGING.replace("versionCode='93'", "versionCode='92'")
        errors, _info = gate("ignored.apk", PIN, old, CERTS)
        self.assertTrue(any("versionCode" in err for err in errors))

    def test_default_build_number_49_is_refused(self):
        old = BADGING.replace("versionCode='93'", "versionCode='49'")
        errors, _info = gate("ignored.apk", PIN, old, CERTS)
        self.assertTrue(any("not above 92" in err for err in errors))

    def test_split_abi_is_refused(self):
        split = BADGING.replace(
            "native-code: 'armeabi-v7a' 'arm64-v8a' 'x86_64'",
            "native-code: 'arm64-v8a'",
        )
        errors, _info = gate("ignored.apk", PIN, split, CERTS)
        self.assertTrue(any("fat" in err for err in errors))

    def test_wrong_application_id_is_refused(self):
        other = BADGING.replace("com.shear.shear_wallet", "com.example.other")
        errors, _info = gate("ignored.apk", PIN, other, CERTS)
        self.assertTrue(any("applicationId" in err for err in errors))



class LibsodiumTest(unittest.TestCase):
    def apk_and_lock(self, d, so):
        lock = os.path.join(d, "libsodium.lock.json")
        good = b"\x7fELF..1.0.22\x00.."
        json.dump({"version": "1.0.22", "ndk": "r27d", "abis": {"arm64-v8a": {
            "so_sha256_with_pinned_ndk": hashlib.sha256(good).hexdigest()}}}, open(lock, "w"))
        apk = os.path.join(d, "app.apk")
        with zipfile.ZipFile(apk, "w") as z:
            if so is not None:
                z.writestr("lib/arm64-v8a/libsodium.so", so)
        return apk, lock, good

    def test_pinned_build_passes(self):
        with tempfile.TemporaryDirectory() as d:
            apk, lock, _ = self.apk_and_lock(d, b"\x7fELF..1.0.22\x00..")
            self.assertEqual(libsodium_errors(apk, lock), [])

    def test_missing_or_other_libsodium_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            apk, lock, _ = self.apk_and_lock(d, None)
            self.assertTrue(any("missing" in e for e in libsodium_errors(apk, lock)))
        with tempfile.TemporaryDirectory() as d:
            apk, lock, _ = self.apk_and_lock(d, b"\x7fELF..1.0.18\x00..")
            errors = libsodium_errors(apk, lock)
            self.assertTrue(any("does not report libsodium 1.0.22" in e for e in errors))
            self.assertTrue(any("sha256" in e for e in errors))

    def test_committed_lock_matches_its_build_script(self):
        lock = json.load(open(os.path.join(os.path.dirname(__file__), "..", "android", "libsodium.lock.json")))
        self.assertRegex(lock["sha256"], r"^[0-9a-f]{64}$")
        self.assertIn("arm64-v8a", lock["abis"])
        self.assertRegex(lock["abis"]["arm64-v8a"]["so_sha256_with_pinned_ndk"], r"^[0-9a-f]{64}$")
        self.assertTrue(all(u.endswith("libsodium-%s.tar.gz" % lock["version"]) for u in lock["urls"]))


if __name__ == "__main__":
    unittest.main()
