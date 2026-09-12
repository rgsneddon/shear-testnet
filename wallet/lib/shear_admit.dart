import 'dart:typed_data';

import 'shear_note.dart';
import 'shear_ristretto.dart';

final admitDst = utf8Bytes('shear-admit-v1');
final admitXDst = utf8Bytes('shear-admit-x-v1');
final admitHpDst = utf8Bytes('shear-admit-Hp');

int kindByte(String? kind) {
  switch (kind) {
    case 'hash':
      return 1;
    case 'pot':
      return 2;
    case 'finder-fee':
      return 3;
    case 'reserve-fee':
      return 4;
    case 'dummy':
      return 5;
    default:
      return 0;
  }
}

Element hp(Element p) => hashToRistretto(pointBytes(p), admitHpDst);

Element admitPub(Scalar x) => mulG(x);

Element spendTagPoint(Scalar x, Element p) => mulEl(hp(p), x);

Scalar admitBaseScalar(Uint8List spendSeed) {
  return hashToScalar([admitXDst, utf8Bytes('base'), spendSeed]);
}

Scalar admitDelta(Map<String, dynamic> note) {
  final nc = note['noteCommit'];
  final c = note['commit'];
  if (nc is! Uint8List || c is! Uint8List) throw StateError('note');
  return hashToScalar([
    admitXDst,
    utf8Bytes('note'),
    nc,
    c,
    Uint8List.fromList([kindByte(note['kind'] as String?)]),
  ]);
}

Scalar admitScalarFromSeed(Uint8List spendSeed, Map<String, dynamic> note) {
  return scalarAdd(admitBaseScalar(spendSeed), admitDelta(note));
}

Element admitPubFromBase(Element B, Map<String, dynamic> note) {
  return addEl(B, mulG(admitDelta(note)));
}

Uint8List admitBaseBytes(Uint8List spendSeed) =>
    pointBytes(admitPub(admitBaseScalar(spendSeed)));

Map<String, dynamic> attachAdmitPub(
  Map<String, dynamic> vout, {
  Uint8List? spendSeed,
  Element? admitBase,
}) {
  if (vout['commit'] is! Uint8List) return vout;
  var out = Map<String, dynamic>.from(vout);
  if (out['admitPub'] is! Uint8List || (out['admitPub'] as Uint8List).length != 32) {
    if (spendSeed != null) {
      final x = admitScalarFromSeed(spendSeed, out);
      out['admitPub'] = pointBytes(admitPub(x));
    } else if (admitBase != null) {
      out['admitPub'] = pointBytes(admitPubFromBase(admitBase, out));
    } else {
      out['admitPub'] = pointBytes(admitPub(randomScalar()));
    }
  }
  if (admitBase != null) out = wrapNoteBlind(out, admitBase);
  return out;
}

int fluxsetIndexOf(List<Uint8List> pubs, Uint8List spendSeed, Map<String, dynamic> note) {
  final P = admitPub(admitScalarFromSeed(spendSeed, note));
  final want = pointBytes(P);
  for (var i = 0; i < pubs.length; i++) {
    if (pubs[i].length == want.length && _eq(pubs[i], want)) return i;
  }
  return -1;
}

bool _eq(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

Map<String, dynamic> admitProve({required Scalar x, required int index, required List<Uint8List> pubs}) {
  final n = pubs.length;
  if (n == 0) throw StateError('empty_fluxset');
  if (index < 0 || index >= n) throw StateError('index');
  final ring = List<Element>.generate(n, (i) => pointFrom(pubs[i]));
  final hpRing = List<Element>.generate(n, (i) => hp(ring[i]));
  final P = ring[index];
  final I = mulEl(hpRing[index], x);
  final Ibytes = pointBytes(I);
  final c = List<Scalar?>.filled(n, null);
  final r = List<Scalar?>.filled(n, null);
  final alpha = randomScalar();
  final Lj = mulG(alpha);
  final Rj = mulEl(hpRing[index], alpha);
  c[(index + 1) % n] = hashToScalar([Ibytes, pointBytes(Lj), pointBytes(Rj), admitDst]);
  for (var i = (index + 1) % n; i != index; i = (i + 1) % n) {
    r[i] = randomScalar();
    final L = varTimeDoubleBase(c[i]!, ring[i], r[i]!);
    final Rpt = varTimeMsm2(r[i]!, hpRing[i], c[i]!, I);
    c[(i + 1) % n] = hashToScalar([Ibytes, pointBytes(L), pointBytes(Rpt), admitDst]);
  }
  r[index] = scalarSub(alpha, scalarMul(c[index]!, x));
  return {
    'admit_proof': true,
    'spendTag': Ibytes,
    'c0': scalarBytes(c[0]!),
    'r': r.map((s) => scalarBytes(s!)).toList(),
  };
}

bool admitVerify(Map<String, dynamic> proof, List<Uint8List> pubs) {
  try {
    final n = pubs.length;
    final rs = proof['r'];
    if (n == 0 || rs is! List || rs.length != n) return false;
    final ring = pubs.map(pointFrom).toList();
    final tag = proof['spendTag'];
    if (tag is! Uint8List) return false;
    final I = pointFrom(tag);
    if (elementEq(I, ristrettoZero())) return false;
    var c = scalarFromBytes(proof['c0'] as Uint8List);
    for (var i = 0; i < n; i++) {
      final ri = scalarFromBytes(rs[i] as Uint8List);
      final L = addEl(mulG(ri), mulEl(ring[i], c));
      final R = addEl(mulEl(hp(ring[i]), ri), mulEl(I, c));
      c = hashToScalar([tag, pointBytes(L), pointBytes(R), admitDst]);
    }
    return scalarEq(c, scalarFromBytes(proof['c0'] as Uint8List));
  } catch (_) {
    return false;
  }
}

Map<String, dynamic> proveFlowSpend(
  Map<String, dynamic> tx, {
  required Uint8List spendSeed,
  required Map<String, dynamic> spentNote,
  required List<Uint8List> pubs,
}) {
  final x = admitScalarFromSeed(spendSeed, spentNote);
  final index = fluxsetIndexOf(pubs, spendSeed, spentNote);
  if (index < 0) throw StateError('not_in_fluxset');
  final proof = admitProve(x: x, index: index, pubs: pubs);
  tx['admit_proof'] = proof;
  tx['spendTag'] = proof['spendTag'];
  return tx;
}
