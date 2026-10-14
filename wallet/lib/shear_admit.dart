import 'dart:typed_data';

import 'shear_note.dart';
import 'shear_ristretto.dart';

/// Shown when a send is attempted. The v3 prove stays off until FS-1.
const String kErrSendUnavailable = 'send unavailable until FS-1';

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

/// Canonical non-identity Ristretto255 point, or null.
Element? canonicalNonIdentity(Uint8List? raw) {
  if (raw == null || raw.length != 32) return null;
  try {
    final p = Element.newElement();
    p.setCanonicalBytes(raw);
    final back = pointBytes(p);
    if (back.length != 32) return null;
    for (var i = 0; i < 32; i++) {
      if (back[i] != raw[i]) return null;
    }
    if (elementEq(p, ristrettoZero())) return null;
    return p;
  } catch (_) {
    return null;
  }
}

/// N-1. The shear-fs1 leaf predicate: admitPub, commit, and Hp(admitPub)
/// each decode to a non-identity point. A wallet credits a note only after this.
bool noteIsFs1Leaf(Uint8List? admitPub, Uint8List? commit) {
  if (canonicalNonIdentity(admitPub) == null) return false;
  if (canonicalNonIdentity(commit) == null) return false;
  if (admitPub == null) return false;
  final hp = hashToRistretto(admitPub, admitHpDst);
  return !elementEq(hp, ristrettoZero());
}

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

/// Closed until FS-1. The wallet has no spend prover to call.
/// A missing helper used to surface as admit_native_required.
Map<String, dynamic> proveFlowSpend(
  Map<String, dynamic> tx, {
  required Uint8List spendSeed,
  required Map<String, dynamic> spentNote,
  required List<Uint8List> pubs,
  List<Uint8List>? commits,
}) {
  throw StateError(kErrSendUnavailable);
}
