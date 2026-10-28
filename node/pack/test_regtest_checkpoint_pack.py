"""The release pack carries no regtest checkpoint (Russell, 28 Oct, R01b).

The checkpoint is node/tests/regtest_checkpoint.json. This builds the linux
release sidecar the way zip_node.py does (write_release_sidecar into a zip)
and checks the built archive itself: no node/tests member, no member named
for the regtest checkpoint, and no member whose bytes carry the pinned hash.
Run from the repo with node and node_modules present:

  python3 node/pack/test_regtest_checkpoint_pack.py
"""
import json
import os
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bundle_modules import required_module_paths, write_release_sidecar  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
CHECKPOINT = os.path.join(REPO, "node", "tests", "regtest_checkpoint.json")


class RegtestCheckpointNotPackedTest(unittest.TestCase):
    def setUp(self):
        with open(CHECKPOINT, encoding="utf-8") as f:
            self.pin = json.load(f)
        self.assertEqual(self.pin["network"], "shear-regtest")

    def test_release_graph_never_reaches_it(self):
        for flavor in ("linux", "windows", "macos"):
            paths = required_module_paths(REPO, flavor)
            self.assertFalse([p for p in paths if p.startswith("node/tests/")], flavor)

    def test_built_pack_carries_no_regtest_checkpoint(self):
        needle = self.pin["hashHex"].encode()
        raw = bytes.fromhex(self.pin["hashHex"])
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "pack.zip")
            with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
                write_release_sidecar(z, REPO, "linux")
            with zipfile.ZipFile(out) as z:
                names = z.namelist()
                self.assertGreater(len(names), 100, "a real sidecar was built")
                self.assertFalse([n for n in names if n.startswith("node/tests/")])
                self.assertFalse([n for n in names if "regtest_checkpoint" in n])
                for n in names:
                    data = z.read(n)
                    self.assertNotIn(needle, data, n)
                    self.assertNotIn(raw, data, n)


if __name__ == "__main__":
    unittest.main()
