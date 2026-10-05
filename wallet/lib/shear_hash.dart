import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

/// Port of miner/src/shear_hash.c (ShearHash-v1, 8 rounds).
const shearPersonal = 'ShearHash-v1';
const shearAlgo = 'ShearHash';
const shearHeaderLen = 128;
const shearHashRounds = 8;

/// C `SHEAR_SELFTEST_HASH` for header version=1, remaining zeros.
const shearSelftestHash =
    '5d00a24233609829e59d6e83d9fcd2f262c4014e772a23024fd3db4e66ee2066';

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

BigInt _hashToBig(List<int> hash) {
  var n = BigInt.zero;
  for (final b in hash) {
    n = (n << 8) | BigInt.from(b & 0xff);
  }
  return n;
}

/// Packed Q16.16 target. `bitsFp` is the real bit-difficulty, not the wire word.
BigInt shearTargetFromBitsFp(double bitsFp) {
  final exp = 256 - bitsFp;
  if (!exp.isFinite || exp >= 256) return (BigInt.one << 256) - BigInt.one;
  if (exp <= 0) return BigInt.one;
  final i = exp.floor();
  final frac = exp - i;
  final scale = BigInt.from((math.pow(2, frac) * math.pow(2, 48)).round());
  return ((BigInt.one << i) * scale) >> 48;
}

/// True when [hash] is under the header's work target.
/// A wire word `>= 65536` is Q16.16 (`bits / 65536`). A smaller word is whole bits.
bool shearMeetsTarget(List<int> hash, int bits) {
  if (bits >= 65536) {
    return _hashToBig(hash) < shearTargetFromBitsFp(bits / 65536);
  }
  final k = bits.clamp(0, 256);
  if (k <= 0) return true;
  final full = k ~/ 8;
  final rem = k % 8;
  for (var i = 0; i < full; i++) {
    if (i >= hash.length || hash[i] != 0) return false;
  }
  if (rem == 0) return true;
  if (full >= hash.length) return false;
  return hash[full] < (1 << (8 - rem));
}
