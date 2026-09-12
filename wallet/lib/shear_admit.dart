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

Uint8List hpBytes(Uint8List p) => fromHashBytes(expandMessageXmd(p, admitHpDst, 64));

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
  final hpRing = List<Uint8List>.generate(n, (i) => hpBytes(pubs[i]));
  final xb = scalarBytes(x);
  final Ibytes = mulBytes(hpRing[index], xb);
  final c = List<Uint8List?>.filled(n, null);
  final r = List<Uint8List?>.filled(n, null);
  final alpha = scalarBytes(randomScalar());
  final Lj = mulGBytes(alpha);
  final Rj = mulBytes(hpRing[index], alpha);
  c[(index + 1) % n] = scalarBytes(hashToScalar([Ibytes, Lj, Rj, admitDst]));
  for (var i = (index + 1) % n; i != index; i = (i + 1) % n) {
    r[i] = scalarBytes(randomScalar());
    final L = addBytes(mulGBytes(r[i]!), mulBytes(pubs[i], c[i]!));
    final Rpt = addBytes(mulBytes(hpRing[i], r[i]!), mulBytes(Ibytes, c[i]!));
    c[(i + 1) % n] = scalarBytes(hashToScalar([Ibytes, L, Rpt, admitDst]));
  }
  r[index] = scalarBytes(scalarSub(scalarFromBytes(alpha), scalarMul(scalarFromBytes(c[index]!), x)));
  return {
    'admit_proof': true,
    'spendTag': Ibytes,
    'c0': c[0]!,
    'r': r.map((s) => s!).toList(),
  };
}

bool admitVerify(Map<String, dynamic> proof, List<Uint8List> pubs) {
  try {
    final n = pubs.length;
    final rs = proof['r'];
    if (n == 0 || rs is! List || rs.length != n) return false;
    final tag = proof['spendTag'];
    if (tag is! Uint8List || tag.length != 32) return false;
    var acc = 0;
    for (final b in tag) {
      acc |= b;
    }
    if (acc == 0) return false;
    final c0 = proof['c0'];
    if (c0 is! Uint8List) return false;
    var c = c0;
    for (var i = 0; i < n; i++) {
      final ri = rs[i];
      if (ri is! Uint8List) return false;
      final L = addBytes(mulGBytes(ri), mulBytes(pubs[i], c));
      final R = addBytes(mulBytes(hpBytes(pubs[i]), ri), mulBytes(tag, c));
      c = scalarBytes(hashToScalar([tag, L, R, admitDst]));
    }
    return _eq(c, c0);
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
