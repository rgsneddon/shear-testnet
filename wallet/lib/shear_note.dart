import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_ristretto.dart';

const noteBits = 64;
final noteDst = utf8Bytes('shear-note-v1');
final noteCommitPersonal = utf8Bytes('shear-note-commit-v1');
final valExtra = utf8Bytes('shear-note-val-v1');
final bitExtra = utf8Bytes('shear-note-bit-v1');
final consExtra = utf8Bytes('shear-note-cons-v1');

/// Consensus note H. Native bpplus maps SHA-512("shear-bpplus-v2" || tag)
/// with from_uniform_bytes. IETF hash-to-curve is a different point, and the
/// chain then treats the lock as zero nanos (bad_amount).
Element consensusNoteH() {
  final wide = sha512.convert([
    ...utf8Bytes('shear-bpplus-v2'),
    ...utf8Bytes('shear-note-H-v1'),
  ]).bytes;
  final p = Element.newElement();
  p.fromUniformBytes(Uint8List.fromList(wide));
  return p;
}

final Element noteH = consensusNoteH();
final Uint8List noteHBytes = pointBytes(noteH);
final Uint8List ristrettoGBytes = pointBytes(ristrettoG());
final Uint8List ristrettoIdBytes = Uint8List(32);

/// A canonical u64. A digit string stays exact through 2^64-1. A Dart int
/// only covers the values it can name. A double is not an amount.
BigInt? tryU64Units(Object? v) {
  if (v is int) {
    if (v < 0) return null;
    return BigInt.from(v);
  }
  if (v is BigInt) {
    if (v < BigInt.zero || v.bitLength > noteBits) return null;
    return v;
  }
  if (v is String && RegExp(r'^\d+$').hasMatch(v)) {
    final b = BigInt.tryParse(v);
    if (b == null || b < BigInt.zero || b.bitLength > noteBits) return null;
    return b;
  }
  return null;
}

Uint8List commitBytesUnits(BigInt v, Uint8List r) {
  if (v < BigInt.zero || v.bitLength > noteBits) throw ArgumentError('u64');
  final vg = v == BigInt.zero ? Uint8List(32) : mulGBytes(scalarBytes(scalarFromU64(v)));
  return addBytes(vg, mulBytes(noteHBytes, r));
}

Uint8List commitBytes(int v, Uint8List r) {
  if (v < 0) throw ArgumentError('u64');
  return commitBytesUnits(BigInt.from(v), r);
}

Uint8List noteCommitOfDest20(Uint8List dest20) {
  if (dest20.length != 20) throw ArgumentError('dest20');
  return Uint8List.fromList(sha256.convert([...noteCommitPersonal, ...dest20]).bytes);
}

Element commit(int v, Scalar r) {
  if (v < 0) throw ArgumentError('u64');
  final units = BigInt.from(v);
  final vg = units == BigInt.zero ? ristrettoZero() : mulG(scalarFromU64(units));
  return addEl(vg, mulEl(noteH, r));
}

Map<String, Uint8List> schnorrProveH(Element p, Scalar r, Uint8List extra) {
  return schnorrProveHBytes(pointBytes(p), scalarBytes(r), extra);
}

Map<String, Uint8List> schnorrProveHBytes(Uint8List p, Uint8List r, Uint8List extra) {
  final k = scalarBytes(randomScalar());
  final R = mulBytes(noteHBytes, k);
  final e = hashToScalar([p, R, extra]);
  final z = scalarAdd(scalarFromBytes(k), scalarMul(e, scalarFromBytes(r)));
  return {'R': R, 'z': scalarBytes(z)};
}

bool schnorrVerifyH(Element p, Map<String, Uint8List> proof, Uint8List extra) {
  try {
    final R = pointFrom(proof['R']!);
    final z = scalarFromBytes(proof['z']!);
    final e = hashToScalar([pointBytes(p), proof['R']!, extra]);
    return elementEq(mulEl(noteH, z), addEl(R, mulEl(p, e)));
  } catch (_) {
    return false;
  }
}

Map<String, Uint8List> proveValueUnits(BigInt v, Scalar r) {
  if (v < BigInt.zero || v.bitLength > noteBits) throw ArgumentError('u64');
  final rb = scalarBytes(r);
  final C = commitBytesUnits(v, rb);
  final vg = v == BigInt.zero ? ristrettoIdBytes : mulGBytes(scalarBytes(scalarFromU64(v)));
  final P = subBytes(C, vg);
  final sch = schnorrProveHBytes(P, rb, valExtra);
  return {'C': C, 'R': sch['R']!, 'z': sch['z']!};
}

Map<String, Uint8List> proveValue(int v, Scalar r) {
  if (v < 0) throw ArgumentError('u64');
  return proveValueUnits(BigInt.from(v), r);
}

/// C = v·G + r·H. Same byte backend as [proveValue]. A mismatched v is not a coin.
bool verifyValueUnits(Uint8List cBytes, BigInt v, Map proof) {
  try {
    // noteBits is 64. A Dart int cannot name that width, so the amount is a BigInt.
    if (v < BigInt.zero || v.bitLength > noteBits) return false;
    final r = proof['R'];
    final z = proof['z'];
    if (r is! Uint8List || z is! Uint8List) return false;
    final vg = v == BigInt.zero ? ristrettoIdBytes : mulGBytes(scalarBytes(scalarFromU64(v)));
    final p = subBytes(cBytes, vg);
    final e = hashToScalar([p, r, valExtra]);
    final left = mulBytes(noteHBytes, z);
    final right = addBytes(r, mulBytes(p, scalarBytes(e)));
    if (left.length != right.length) return false;
    for (var i = 0; i < left.length; i++) {
      if (left[i] != right[i]) return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

bool verifyValue(Uint8List cBytes, int v, Map proof) {
  if (v < 0) return false;
  return verifyValueUnits(cBytes, BigInt.from(v), proof);
}

/// Value proof must hold. A flat stand-in range blob is not a range proof.
bool verifySealedNote(Map vout, int v) {
  final commit = vout['commit'];
  final proof = vout['valueProof'];
  if (commit is! Uint8List || proof is! Map) return false;
  if (!verifyValue(commit, v, proof)) return false;
  return true;
}

Map<String, Uint8List> bitOrProveBytes(Uint8List B, int b, Uint8List s) {
  final P0 = B;
  final P1 = subBytes(B, ristrettoGBytes);
  final real = b != 0 ? P1 : P0;
  final fake = b != 0 ? P0 : P1;
  final eFake = scalarBytes(randomScalar());
  final zFake = scalarBytes(randomScalar());
  final RFake = subBytes(mulBytes(noteHBytes, zFake), mulBytes(fake, eFake));
  final k = scalarBytes(randomScalar());
  final RReal = mulBytes(noteHBytes, k);
  final R0 = b != 0 ? RFake : RReal;
  final R1 = b != 0 ? RReal : RFake;
  final e = hashToScalar([B, R0, R1, bitExtra]);
  final eReal = scalarSub(e, scalarFromBytes(eFake));
  final zReal = scalarAdd(scalarFromBytes(k), scalarMul(eReal, scalarFromBytes(s)));
  return {
    'R0': R0,
    'R1': R1,
    'e0': b != 0 ? eFake : scalarBytes(eReal),
    'e1': b != 0 ? scalarBytes(eReal) : eFake,
    'z0': b != 0 ? zFake : scalarBytes(zReal),
    'z1': b != 0 ? scalarBytes(zReal) : zFake,
  };
}

Map<String, dynamic> proveRange(int v, Scalar r) {
  final bits = <Map<String, Uint8List>>[];
  final Bpts = <Uint8List>[];
  var n = v;
  var sSum = scalarZero();
  for (var i = 0; i < noteBits; i++) {
    final b = n & 1;
    n >>= 1;
    final si = randomScalar();
    final sib = scalarBytes(si);
    final Bi = commitBytes(b, sib);
    Bpts.add(Bi);
    bits.add(bitOrProveBytes(Bi, b, sib));
    sSum = scalarAdd(sSum, scalarMul(scalarFromBigShift(i), si));
  }
  final rDelta = scalarSub(r, sSum);
  final C = commitBytes(v, scalarBytes(r));
  var acc = Uint8List(32);
  for (var i = 0; i < noteBits; i++) {
    acc = addBytes(acc, mulBytes(Bpts[i], scalarBytes(scalarFromBigShift(i))));
  }
  final P = subBytes(C, acc);
  return {
    'bits': bits,
    'B': Bpts,
    'cons': schnorrProveHBytes(P, scalarBytes(rDelta), consExtra),
  };
}

/// Stored nanos. Values above 2^63-1 stay digit strings.
Object u64OnWire(BigInt v) {
  if (v.bitLength <= 63) return v.toInt();
  return v.toString();
}

/// Public-nanos seal for any u64. Same shape as `sealCoinbaseNote` in crypto/note.js.
Map<String, dynamic> sealCoinbaseUnits(BigInt v, {Uint8List? dest20, Uint8List? noteCommit, String kind = 'hash'}) {
  if (v < BigInt.zero || v.bitLength > noteBits) throw ArgumentError('u64');
  final r = randomScalar();
  final value = proveValueUnits(v, r);
  final nc = noteCommit ??
      (dest20 != null ? noteCommitOfDest20(dest20) : Uint8List(32));
  final shown = u64OnWire(v);
  return {
    'kind': kind,
    'noteCommit': nc,
    'commit': value['C'],
    'valueProof': {'R': value['R'], 'z': value['z'], 'v': shown},
    'r': scalarBytes(r),
    'nanos': shown,
    if (dest20 != null) 'dest20': dest20,
  };
}

/// Public-nanos seal (coinbase / Reserve). Same shape as `sealCoinbaseNote` in crypto/note.js.
Map<String, dynamic> sealCoinbaseNote(int v, {Uint8List? dest20, Uint8List? noteCommit, String kind = 'hash'}) {
  if (v < 0) throw ArgumentError('u64');
  return sealCoinbaseUnits(BigInt.from(v), dest20: dest20, noteCommit: noteCommit, kind: kind);
}

Map<String, dynamic> sealNote(int v, {Uint8List? dest20, Uint8List? noteCommit, String kind = 'send'}) {
  final r = randomScalar();
  final value = proveValue(v, r);
  final nc = noteCommit ??
      (dest20 != null ? noteCommitOfDest20(dest20) : Uint8List(32));
  return {
    'kind': kind,
    'noteCommit': nc,
    'commit': value['C'],
    'valueProof': {'R': value['R'], 'z': value['z'], 'v': v},
    'rangeProof': proveRange(v, r),
    'r': scalarBytes(r),
    'nanos': v,
    if (dest20 != null) 'dest20': dest20,
  };
}

final rwrapDst = utf8Bytes('shear-r-wrap-v1');

/// Same bytes as crypto/note.js: amtCt = u64le(v) XOR SHA-512("shear-amt-v1" ‖ e·B ‖ extra)[0..8].
final amtDst = utf8Bytes('shear-amt-v1');
const amountCtBytes = 8;

Uint8List _amountMask(Uint8List shared, Uint8List extra) {
  return Uint8List.sublistView(sha512Bytes(concatBytes([amtDst, shared, extra])), 0, amountCtBytes);
}

Uint8List _u64leBytes(BigInt v) {
  if (v < BigInt.zero || v.bitLength > noteBits) throw ArgumentError('u64');
  final b = Uint8List(amountCtBytes);
  var n = v;
  for (var i = 0; i < amountCtBytes; i++) {
    b[i] = (n & BigInt.from(0xff)).toInt();
    n >>= 8;
  }
  return b;
}

Map<String, Uint8List> wrapBlind(Uint8List r, Element admitBase, Uint8List extra, {BigInt? v}) {
  final e = randomScalar();
  final rEph = mulG(e);
  final shared = pointBytes(mulEl(admitBase, e));
  final mask = hashToScalar([rwrapDst, shared, extra]);
  final out = {
    'rEph': pointBytes(rEph),
    'rCt': scalarBytes(scalarAdd(scalarFromBytes(r), mask)),
  };
  if (v != null) {
    final m = _amountMask(shared, extra);
    final pt = _u64leBytes(v);
    out['amtCt'] = Uint8List.fromList([for (var i = 0; i < amountCtBytes; i++) pt[i] ^ m[i]]);
  }
  return out;
}

Uint8List unwrapBlind(Uint8List rEph, Uint8List rCt, Scalar xBase, Uint8List extra) {
  final shared = mulEl(pointFrom(rEph), xBase);
  final mask = hashToScalar([rwrapDst, pointBytes(shared), extra]);
  return scalarBytes(scalarSub(scalarFromBytes(rCt), mask));
}

/// Raw decrypt. Not checked against C; callers use [openNoteAmount].
BigInt? _unwrapAmount(Uint8List rEph, Uint8List amtCt, Scalar xBase, Uint8List extra) {
  if (amtCt.length != amountCtBytes) return null;
  final m = _amountMask(pointBytes(mulEl(pointFrom(rEph), xBase)), extra);
  var v = BigInt.zero;
  for (var i = amountCtBytes - 1; i >= 0; i--) {
    v = (v << 8) | BigInt.from(amtCt[i] ^ m[i]);
  }
  return v;
}

Uint8List? _noteBytes(Object? x) {
  if (x is Uint8List) return x;
  if (x is List<int>) return Uint8List.fromList(x);
  if (x is String && x.length.isEven && RegExp(r'^[0-9a-fA-F]*$').hasMatch(x)) {
    return Uint8List.fromList([for (var i = 0; i < x.length; i += 2) int.parse(x.substring(i, i + 2), radix: 16)]);
  }
  return null;
}

/// Owner recovery of (v, r) from rEph, rCt, amtCt. Null unless v·G + r·H is the output's C,
/// so a wrong key or a tampered ciphertext never yields an amount.
Map<String, Object>? openNoteAmount(Map vout, Scalar xBase) {
  try {
    final rEph = _noteBytes(vout['rEph']);
    final rCt = _noteBytes(vout['rCt']);
    final amtCt = _noteBytes(vout['amtCt']);
    final c = _noteBytes(vout['commit']);
    final nc = _noteBytes(vout['noteCommit']);
    if (rEph == null || rCt == null || amtCt == null || c == null || nc == null) return null;
    final extra = concatBytes([nc, c]);
    final v = _unwrapAmount(rEph, amtCt, xBase, extra);
    if (v == null) return null;
    final r = unwrapBlind(rEph, rCt, xBase, extra);
    final want = commitBytesUnits(v, r);
    if (want.length != c.length) return null;
    for (var i = 0; i < c.length; i++) {
      if (want[i] != c[i]) return null;
    }
    return {'v': v, 'r': r};
  } catch (_) {
    return null;
  }
}

Map<String, dynamic> wrapNoteBlind(Map<String, dynamic> vout, Element admitBase, {BigInt? v}) {
  final r = vout['r'];
  if (r is! Uint8List) return vout;
  if (vout['rEph'] is Uint8List && vout['rCt'] is Uint8List && (v == null || vout['amtCt'] is Uint8List)) return vout;
  final nc = vout['noteCommit'];
  final c = vout['commit'];
  if (nc is! Uint8List || c is! Uint8List) return vout;
  final wrap = wrapBlind(r, admitBase, concatBytes([nc, c]), v: v);
  return {...vout, ...wrap};
}

bool publicValueOpenKind(String? kind) {
  return kind == 'pot' ||
      kind == 'hash' ||
      kind == 'pool-fee' ||
      kind == 'finder-fee' ||
      kind == 'reserve-fee' ||
      kind == 'lock' ||
      kind == 'vote' ||
      kind == 'withdraw' ||
      kind == 'pool-withdraw';
}

/// Compact a sealed vout the way chain persist does: drop r, keep rEph/rCt.
/// Hidden kinds drop the value opening. The range proof stays.
Map<String, dynamic> compactSealedVout(Map<String, dynamic> o) {
  final posted = o['kind'] as String?;
  final kind = (posted == null || posted.isEmpty) ? 'pot' : posted;
  final keepOpen = publicValueOpenKind(posted);
  if (o['commit'] is! Uint8List) {
    if (kind == 'lock' || kind == 'vote' || kind == 'withdraw' || kind == 'vortice-register') {
      return {
        'kind': kind,
        if (o['address'] != null) 'address': o['address'],
        if (o['nanos'] != null) 'nanos': o['nanos'],
      };
    }
    return {'kind': kind};
  }
  final row = <String, dynamic>{
    'kind': kind,
    'noteCommit': o['noteCommit'],
    'commit': o['commit'],
    if (keepOpen && o['valueProof'] != null) 'valueProof': o['valueProof'],
  };
  if (o['rangeProof'] != null) row['rangeProof'] = o['rangeProof'];
  if (o['viewTag'] != null) row['viewTag'] = o['viewTag'];
  if (o['admitPub'] != null) row['admitPub'] = o['admitPub'];
  if (o['rEph'] != null) row['rEph'] = o['rEph'];
  if (o['rCt'] != null) row['rCt'] = o['rCt'];
  if (o['amtCt'] != null) row['amtCt'] = o['amtCt'];
  if (o['dest20'] != null) row['dest20'] = o['dest20'];
  if (kind == 'lock' || kind == 'vote' || kind == 'withdraw' || kind == 'vortice-register') {
    final addr = o['address'];
    if (addr is String && addr.isNotEmpty) row['address'] = addr;
    final n = tryU64Units(o['nanos']);
    if (n != null) row['nanos'] = u64OnWire(n);
  }
  final coinbaseMoney = posted == 'hash' || posted == 'pot' || posted == 'pool-fee' || posted == 'finder-fee' || posted == 'reserve-fee';
  if (keepOpen && coinbaseMoney) {
    final vp = row['valueProof'];
    final opened = tryU64Units(o['nanos']);
    if (vp is Map && vp['v'] == null && opened != null) {
      row['valueProof'] = {...vp, 'v': u64OnWire(opened)};
    } else if ((vp == null || (vp is Map && vp['v'] == null)) && opened != null) {
      row['valueProof'] = {'v': u64OnWire(opened)};
    }
  }
  return row;
}

Uint8List kernelExcess(List<Map<String, dynamic>> vouts, List<Map<String, dynamic>> vins) {
  var s = scalarZero();
  for (final o in vouts) {
    final r = o['r'];
    if (r is! Uint8List) throw StateError('missing_r');
    s = scalarAdd(s, scalarFromBytes(r));
  }
  for (final v in vins) {
    final r = v['r'];
    if (r is! Uint8List) throw StateError('missing_r');
    s = scalarSub(s, scalarFromBytes(r));
    final t = v['t'];
    if (t is Uint8List) s = scalarSub(s, scalarFromBytes(t));
  }
  return scalarBytes(s);
}
