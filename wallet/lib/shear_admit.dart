import 'dart:typed_data';

import 'shear_membership.dart';
import 'shear_membership_ffi.dart';
import 'shear_native_prove.dart';
import 'shear_note.dart';
import 'shear_ristretto.dart';

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

/// Interim testnet membership proof pending FS-1. Byte 3 plus the statement
/// the node checks. FS-1 replaces [flowMembershipStatement]; this function
/// keeps passing those bytes to the native prover.
Map<String, dynamic> proveFlowSpend(
  Map<String, dynamic> tx, {
  required Uint8List spendSeed,
  required Map<String, dynamic> spentNote,
  required List<Uint8List> pubs,
  List<Uint8List>? commits,
  Uint8List? statement,
  Uint8List? blindT,
  int? anchor,
  int fee = 0,
  int? maxLevy,
  String kind = 'send',
  List<({Uint8List spendTag, Uint8List cTilde})>? boundInputs,
}) {
  if (kind != 'send' && kind != 'transfer') throw StateError('bad_kind');
  final cs = commits ?? const <Uint8List>[];
  if (cs.length != pubs.length) throw StateError('membership_native_required');
  if (fluxsetIndexOf(pubs, spendSeed, spentNote) < 0) throw StateError('not_in_fluxset');
  if (debugNativeSpendProver != null) {
    final proof = nativeProveFlowSpend(
      spendSeed: spendSeed,
      spentNote: spentNote,
      pubs: pubs,
      commits: cs,
    );
    if (proof == null || proof['r'] != null) {
      throw StateError('membership_native_required');
    }
    tx['admit_proof'] = proof;
    tx['spendTag'] = proof['spendTag'];
    return tx;
  }
  final bound = bindFlowInput(
    spendSeed: spendSeed,
    spentNote: spentNote,
    pubs: pubs,
    t: blindT,
  );
  final inputs = boundInputs ??
      <({Uint8List spendTag, Uint8List cTilde})>[
        (spendTag: bound.spendTag, cTilde: bound.cTilde),
      ];
  final at = bound.index;
  var ctx = statement;
  if (ctx == null) {
    if (anchor == null) throw StateError('anchor_wait');
    final root = MembershipNative.tryLoad()?.pointRoot(pubs, cs);
    if (root == null || root.length != 32) throw StateError('membership_native_required');
    final vout = <Map<String, dynamic>>[
      for (final raw in (tx['vout'] as List? ?? const []))
        if (raw is Map) Map<String, dynamic>.from(raw),
    ];
    final digest = flowMembershipDigest(
      kind: kind,
      anchor: anchor,
      fee: fee,
      maxLevy: maxLevy,
      inputs: inputs,
      vout: vout,
    );
    ctx = flowMembershipStatement(
      anchor: anchor,
      root: root,
      n: pubs.length,
      digest: digest,
    );
  }
  if (ctx.length != kMembershipStatementBytes) {
    throw StateError('membership_native_required');
  }
  final x = scalarBytes(admitScalarFromSeed(spendSeed, spentNote));
  final proof = nativeProveFlowSpend(
    spendSeed: spendSeed,
    spentNote: spentNote,
    pubs: pubs,
    commits: cs,
    statement: ctx,
    blindT: bound.t,
    index: at,
    x: x,
    leaf: pubs[at],
    commit: spentNote['commit'] as Uint8List,
  );
  if (proof == null || proof['v'] != 3 || proof['r'] != null) {
    throw StateError('membership_native_required');
  }
  final blob = proof['blob'];
  final tag = proof['spendTag'];
  final ct = proof['cTilde'];
  if (blob is! Uint8List || blob.length < 33 || blob[0] != 3) {
    throw StateError('membership_native_required');
  }
  if (tag is! Uint8List || !_eq(tag, bound.spendTag) || !_eq(blob.sublist(1, 33), bound.spendTag)) {
    throw StateError('membership_native_required');
  }
  if (ct is! Uint8List || !_eq(ct, bound.cTilde)) {
    throw StateError('membership_native_required');
  }
  tx['admit_proof'] = proof;
  tx['spendTag'] = proof['spendTag'];
  return tx;
}

/// Native C̃ and spend tag for one note. The membership proof comes later.
/// FS-1 keeps this bind and replaces the statement.
({Uint8List spendTag, Uint8List cTilde, Uint8List t, int index}) bindFlowInput({
  required Uint8List spendSeed,
  required Map<String, dynamic> spentNote,
  required List<Uint8List> pubs,
  Uint8List? t,
}) {
  final at = fluxsetIndexOf(pubs, spendSeed, spentNote);
  if (at < 0 || at >= pubs.length) throw StateError('not_in_fluxset');
  final native = MembershipNative.tryLoad();
  if (native == null) throw StateError('membership_native_required');
  final commit = spentNote['commit'];
  if (commit is! Uint8List || commit.length != 32) throw StateError('note');
  final blind = t ?? scalarBytes(randomScalar());
  if (blind.length != 32) throw StateError('membership_native_required');
  final x = scalarBytes(admitScalarFromSeed(spendSeed, spentNote));
  final bound = native.bindInput(x: x, p: pubs[at], c: commit, t: blind);
  if (bound == null) throw StateError('membership_native_required');
  return (spendTag: bound.spendTag, cTilde: bound.cTilde, t: blind, index: at);
}

/// One statement for every input of a send or transfer.
/// The worker builds it. FS-1 replaces [flowMembershipStatement].
Map<String, dynamic> prepareFlowMembership(Map<String, dynamic> input) {
  final spendSeed = input['spendSeed'] as Uint8List;
  final pubs = <Uint8List>[
    for (final p in (input['pubs'] as List? ?? const []))
      if (p is Uint8List) p,
  ];
  final commits = <Uint8List>[
    for (final raw in (input['commits'] as List? ?? const []))
      if (raw is Uint8List) raw,
  ];
  final notes = <Map<String, dynamic>>[
    for (final raw in (input['notes'] as List? ?? const []))
      if (raw is Map) Map<String, dynamic>.from(raw),
  ];
  final vout = <Map<String, dynamic>>[
    for (final raw in (input['vout'] as List? ?? const []))
      if (raw is Map) Map<String, dynamic>.from(raw),
  ];
  final anchor = input['anchor'];
  if (anchor is! int) throw StateError('anchor_wait');
  final kind = (input['kind'] as String?) ?? 'send';
  final fee = (input['fee'] as int?) ?? 0;
  final maxLevy = input['maxLevy'] is int ? input['maxLevy'] as int : fee;
  if (notes.isEmpty || notes.length > kMembershipInputCap) {
    throw StateError('membership_native_required');
  }
  final rows = <Map<String, dynamic>>[];
  final bound = <({Uint8List spendTag, Uint8List cTilde})>[];
  for (final note in notes) {
    final one = bindFlowInput(spendSeed: spendSeed, spentNote: note, pubs: pubs);
    bound.add((spendTag: one.spendTag, cTilde: one.cTilde));
    rows.add({
      't': one.t,
      'spendTag': one.spendTag,
      'cTilde': one.cTilde,
      'index': one.index,
      'commit': note['commit'],
      'noteCommit': note['noteCommit'],
      'r': note['r'],
      'kind': note['kind'],
    });
  }
  final root = MembershipNative.tryLoad()?.pointRoot(pubs, commits);
  if (root == null || root.length != 32) throw StateError('membership_native_required');
  final digest = flowMembershipDigest(
    kind: kind,
    anchor: anchor,
    fee: fee,
    maxLevy: maxLevy,
    inputs: bound,
    vout: vout,
  );
  final statement = flowMembershipStatement(
    anchor: anchor,
    root: root,
    n: pubs.length,
    digest: digest,
  );
  return {'statement': statement, 'rows': rows, 'anchor': anchor};
}
