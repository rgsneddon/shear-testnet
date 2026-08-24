import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

/// Port of miner/src/shear_hash.c (ShearHash-v1, 8 rounds).
const shearPersonal = 'ShearHash-v1';
const shearAlgo = 'ShearHash';
const shearHeaderLen = 120;
const shearHashRounds = 8;

/// C `SHEAR_SELFTEST_HASH` for header version=1, remaining zeros.
const shearSelftestHash =
    '6e95b9033c5d044d08bbf854fb2e5343ca3103b96ae37bde101258d43cfacc63';

Uint8List shearSelftestHeader() {
  final h = Uint8List(shearHeaderLen);
  h[0] = 1;
  return h;
}

void shearSetNonce(Uint8List header, int nonce) {
  var n = nonce;
  for (var i = 0; i < 8; i++) {
    header[112 + i] = n & 0xff;
    n >>= 8;
  }
}

/// Same buffer layout as C `shear_hash`.
Uint8List shearHash(List<int> header) {
  if (header.length != shearHeaderLen) {
    throw ArgumentError('header must be $shearHeaderLen bytes');
  }
  final personal = utf8.encode(shearPersonal);
  final algo = utf8.encode(shearAlgo);
  var out = sha256.convert([...personal, ...algo, ...header]).bytes;
  for (var r = 0; r < shearHashRounds; r++) {
    out = sha256.convert([...out, ...personal, 0x30 + r, ...header]).bytes;
  }
  return Uint8List.fromList(out);
}

String shearHashHex(List<int> header) {
  return shearHash(header).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

bool shearSelftest() => shearHashHex(shearSelftestHeader()) == shearSelftestHash;

/// Same bytes as C `shear_hash` — used by the selftest vector unit test, not wallet mining.
List<int> dartHashRound(List<int> header) => shearHash(header);
