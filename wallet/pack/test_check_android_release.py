#!/usr/bin/env python3
"""Decision tests for the release APK gate. The live APK run is separate."""
import unittest

from check_android_release import gate, normalize_sha256

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


if __name__ == "__main__":
    unittest.main()
