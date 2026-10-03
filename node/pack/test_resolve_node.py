"""resolve_real_node must pack the real node binary, not the alts stub."""
import os
import tempfile
import unittest

from bundle_modules import resolve_real_node


class ResolveRealNodeTest(unittest.TestCase):
    def test_large_binary_stays(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = os.path.join(tmp, "node")
            with open(node, "wb") as fh:
                fh.write(b"N" * 1_000_000)
            other = os.path.join(tmp, "node22")
            with open(other, "wb") as fh:
                fh.write(b"O" * 2_000_000)
            conf = os.path.join(tmp, "conf")
            os.makedirs(conf)
            with open(os.path.join(conf, "99.conf"), "w", encoding="utf-8") as fh:
                fh.write(f"binary={other}\n")
            self.assertEqual(os.path.realpath(resolve_real_node(node, conf)), os.path.realpath(node))

    def test_alts_follows_highest_pref(self):
        with tempfile.TemporaryDirectory() as tmp:
            alts = os.path.join(tmp, "alts")
            with open(alts, "wb") as fh:
                fh.write(b"A" * 100)
            low = os.path.join(tmp, "node20")
            high = os.path.join(tmp, "node22")
            with open(low, "wb") as fh:
                fh.write(b"L" * 2_000_000)
            with open(high, "wb") as fh:
                fh.write(b"H" * 1_500_000)
            conf = os.path.join(tmp, "conf")
            os.makedirs(conf)
            with open(os.path.join(conf, "10.conf"), "w", encoding="utf-8") as fh:
                fh.write(f"binary={low}\n")
            with open(os.path.join(conf, "22.conf"), "w", encoding="utf-8") as fh:
                fh.write(f"binary={high}\nman=node.1\n")
            self.assertEqual(os.path.realpath(resolve_real_node(alts, conf)), os.path.realpath(high))

    def test_small_pie_without_conf_keeps_itself(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = os.path.join(tmp, "node")
            with open(node, "wb") as fh:
                fh.write(b"P" * 27_000)
            conf = os.path.join(tmp, "missing-conf")
            self.assertEqual(os.path.realpath(resolve_real_node(node, conf)), os.path.realpath(node))

    def test_small_binary_uses_versioned_neighbor(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = os.path.join(tmp, "node")
            with open(node, "wb") as fh:
                fh.write(b"S" * 100)
            node22 = os.path.join(tmp, "node22")
            with open(node22, "wb") as fh:
                fh.write(b"R" * 3_000_000)
            conf = os.path.join(tmp, "empty-conf")
            os.makedirs(conf)
            self.assertEqual(os.path.realpath(resolve_real_node(node, conf)), os.path.realpath(node22))


if __name__ == "__main__":
    unittest.main()
