import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_ristretto.dart';

const noteBits = 64;
final noteDst = utf8Bytes('shear-note-v1');
final noteCommitPersonal = utf8Bytes('shear-note-commit-v1');
final valExtra = utf8Bytes('shear-note-val-v1');
final bitExtra = utf8Bytes('shear-note-bit-v1');
final consExtra = utf8Bytes('shear-note-cons-v1');

final Element noteH = hashToRistretto(utf8Bytes('shear-note-H-v1'), noteDst);
final Uint8List noteHBytes = pointBytes(noteH);
final Uint8List ristrettoGBytes = pointBytes(ristrettoG());
final Uint8List ristrettoIdBytes = Uint8List(32);

Uint8List commitBytes(int v, Uint8List r) {
  final vg = v == 0 ? Uint8List(32) : mulGBytes(scalarBytes(scalarFromInt(v)));
  return addBytes(vg, mulBytes(noteHBytes, r));
}

Uint8List noteCommitOfDest20(Uint8List dest20) {
  if (dest20.length != 20) throw ArgumentError('dest20');
  return Uint8List.fromList(sha256.convert([...noteCommitPersonal, ...dest20]).bytes);
}

Element commit(int v, Scalar r) {
  final vg = v == 0 ? ristrettoZero() : mulG(scalarFromInt(v));
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

Map<String, Uint8List> proveValue(int v, Scalar r) {
  final rb = scalarBytes(r);
  final C = commitBytes(v, rb);
  final vg = v == 0 ? ristrettoIdBytes : mulGBytes(scalarBytes(scalarFromInt(v)));
  final P = subBytes(C, vg);
  final sch = schnorrProveHBytes(P, rb, valExtra);
  return {'C': C, 'R': sch['R']!, 'z': sch['z']!};
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

Map<String, dynamic> sealNote(int v, {Uint8List? dest20, Uint8List? noteCommit, String kind = 'send'}) {
  final r = randomScalar();
  final value = proveValue(v, r);
  final nc = noteCommit ??
      (dest20 != null ? noteCommitOfDest20(dest20) : Uint8List(32));
  return {
    'kind': kind,
    'noteCommit': nc,
    'commit': value['C'],
    'valueProof': {'R': value['R'], 'z': value['z']},
    'rangeProof': proveRange(v, r),
    'r': scalarBytes(r),
    'nanos': v,
  };
}

final rwrapDst = utf8Bytes('shear-r-wrap-v1');

Map<String, Uint8List> wrapBlind(Uint8List r, Element admitBase, Uint8List extra) {
  final e = randomScalar();
  final rEph = mulG(e);
  final shared = mulEl(admitBase, e);
  final mask = hashToScalar([rwrapDst, pointBytes(shared), extra]);
  return {
    'rEph': pointBytes(rEph),
    'rCt': scalarBytes(scalarAdd(scalarFromBytes(r), mask)),
  };
}

Uint8List unwrapBlind(Uint8List rEph, Uint8List rCt, Scalar xBase, Uint8List extra) {
  final shared = mulEl(pointFrom(rEph), xBase);
  final mask = hashToScalar([rwrapDst, pointBytes(shared), extra]);
  return scalarBytes(scalarSub(scalarFromBytes(rCt), mask));
}

Map<String, dynamic> wrapNoteBlind(Map<String, dynamic> vout, Element admitBase) {
  final r = vout['r'];
  if (r is! Uint8List) return vout;
  if (vout['rEph'] is Uint8List && vout['rCt'] is Uint8List) return vout;
  final nc = vout['noteCommit'];
  final c = vout['commit'];
  if (nc is! Uint8List || c is! Uint8List) return vout;
  final wrap = wrapBlind(r, admitBase, concatBytes([nc, c]));
  return {...vout, 'rEph': wrap['rEph']!, 'rCt': wrap['rCt']!};
}

/// Compact a sealed vout the way chain persist does: drop r, keep rEph/rCt.
Map<String, dynamic> compactSealedVout(Map<String, dynamic> o) {
  final kind = (o['kind'] as String?) ?? 'pot';
  if (o['commit'] is! Uint8List) return {'kind': kind};
  final row = <String, dynamic>{
    'kind': kind,
    'noteCommit': o['noteCommit'],
    'commit': o['commit'],
    'valueProof': o['valueProof'],
  };
  if (o['rangeProof'] != null) row['rangeProof'] = o['rangeProof'];
  if (o['viewTag'] != null) row['viewTag'] = o['viewTag'];
  if (o['admitPub'] != null) row['admitPub'] = o['admitPub'];
  if (o['rEph'] != null) row['rEph'] = o['rEph'];
  if (o['rCt'] != null) row['rCt'] = o['rCt'];
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
  }
  return scalarBytes(s);
}
