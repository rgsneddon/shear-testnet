"""Speculos tests for the Shear device app (ragger). Run with run_speculos.sh.

Host parity: SLIP-10 Ed25519 from Speculos' default mnemonic must give the
same spendPub and view key as createIdentity(s) in the wallet.
"""
import hashlib
import hmac
import struct

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from ragger.navigator import NavInsID

SPECULOS_MNEMONIC = (
    "glory promote mansion idle axis finger extra february uncover one trip resource "
    "lawn turtle enact monster seven myth punch hobby comfort wild raise skin"
)
import pathlib
import re

# The one SLIP-44 placeholder lives in the Makefile (D2).
COIN = int(re.search(r"^SHEAR_COIN_TYPE \?= (\d+)", (pathlib.Path(__file__).parents[1] / "Makefile").read_text(), re.M).group(1))
PATH = [44 | 0x80000000, COIN | 0x80000000, 0x80000000]
PKCS8 = bytes.fromhex("302e020100300506032b657004220420")


def slip10_ed25519(path):
    seed = hashlib.pbkdf2_hmac("sha512", SPECULOS_MNEMONIC.encode(), b"mnemonic", 2048)
    i = hmac.new(b"ed25519 seed", seed, hashlib.sha512).digest()
    k, c = i[:32], i[32:]
    for p in path:
        i = hmac.new(c, b"\x00" + k + struct.pack(">I", p), hashlib.sha512).digest()
        k, c = i[:32], i[32:]
    return k


def expected():
    s = slip10_ed25519(PATH)
    pub = Ed25519PrivateKey.from_private_bytes(s).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    view = hashlib.sha256(b"shear-view-v1" + PKCS8 + s).digest()
    return pub, view


def path_bytes(path):
    return bytes([len(path)]) + b"".join(struct.pack(">I", p) for p in path)


def test_version(backend):
    r = backend.exchange(0xE0, 0x01, 0, 0, b"")
    assert r.data == bytes([0, 1, 0])


def test_spend_pub_matches_host(backend):
    pub, _ = expected()
    assert backend.exchange(0xE0, 0x10, 0, 0, path_bytes(PATH)).data == pub


def test_view_key_export_needs_consent(backend, navigator, device):
    pub, view = expected()
    with backend.exchange_async(0xE0, 0x10, 1, 0, path_bytes(PATH)):
        if device.is_nano:
            navigator.navigate_until_text(NavInsID.RIGHT_CLICK, [NavInsID.BOTH_CLICK], "Export",
                                          screen_change_after_last_instruction=False)
        else:
            navigator.navigate([NavInsID.USE_CASE_CHOICE_CONFIRM], screen_change_after_last_instruction=False)
    assert backend.last_async_response.data == pub + view


def test_view_key_export_rejected(backend, navigator, device):
    from ragger.error import ExceptionRAPDU
    try:
        with backend.exchange_async(0xE0, 0x10, 1, 0, path_bytes(PATH)):
            if device.is_nano:
                navigator.navigate_until_text(NavInsID.RIGHT_CLICK, [NavInsID.BOTH_CLICK], "Reject",
                                              screen_change_after_last_instruction=False)
            else:
                navigator.navigate([NavInsID.USE_CASE_CHOICE_REJECT], screen_change_after_last_instruction=False)
        assert False
    except ExceptionRAPDU as e:
        assert e.status == 0x6985


def test_non_shear_path_is_refused(backend):
    from ragger.error import ExceptionRAPDU
    try:
        backend.exchange(0xE0, 0x10, 0, 0, path_bytes([44 | 0x80000000, 60 | 0x80000000, 0x80000000]))
        assert False
    except ExceptionRAPDU as e:
        assert e.status == 0x6A80


def test_spend_auth_waits_for_d1(backend):
    from ragger.error import ExceptionRAPDU
    try:
        backend.exchange(0xE0, 0x12, 0, 0, b"")
        assert False
    except ExceptionRAPDU as e:
        assert e.status == 0x6A8B
