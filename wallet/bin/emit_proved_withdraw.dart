import 'dart:convert';
import 'dart:typed_data';

import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_fs1.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_ristretto.dart';
import 'package:shear_wallet/shear_withdraw.dart';

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Object? _json(Object? v) {
  if (v is Uint8List) return _hex(v);
  if (v is List<int>) return _hex(v);
  if (v is List) return [for (final row in v) _json(row)];
  if (v is Map) {
    return {for (final e in v.entries) e.key.toString(): _json(e.value)};
  }
  return v;
}

/// Two notes this seed owns, inside a four-note anchor row.
Map<String, dynamic> _ownedPot(int v, int i, Uint8List seed) {
  final note = sealCoinbaseNote(v, dest20: Uint8List(20)..fillRange(0, 20, i + 1), kind: 'pot');
  return attachAdmitPub(note, spendSeed: seed);
}

void main() {
  const pi = 314159265358;
  const anchor = 16;
  const id = 'dart-wd';
  const programId = 'shear-reserve-v1';
  final portal = 'ab' * 32;
  final seed = Uint8List(32)..[0] = 9;
  final nonce = Uint8List(32)..[31] = 7;
  final dest20 = Uint8List(20)..[0] = 0x11;
  if (Fs1Native.tryLoad() == null) {
    throw StateError('fs1_prover_unavailable');
  }
  final book = <Map<String, dynamic>>[
    for (var i = 0; i < 4; i++) _ownedPot(1000 + i, i, seed),
  ];
  final pubs = [for (final n in book) n['admitPub'] as Uint8List];
  final commits = [for (final n in book) n['commit'] as Uint8List];
  final spent = [
    for (final i in [0, 1])
      {
        'kind': 'pot',
        'commit': book[i]['commit'],
        'noteCommit': book[i]['noteCommit'],
        'r': book[i]['r'],
      },
  ];
  // Same body the JS verifier rebuilds: empty vout, this portal, this nonce.
  // The proof binds that digest. cTilde and the aggregate blob are not in it.
  final digest = fs1BodyDigest(
    magic: kBookMagic,
    kind: 'withdraw',
    anchor: anchor,
    fee: 0,
    nIn: 2,
    vout: const <Map<String, dynamic>>[],
    portalId: portal,
    programId: programId,
    id: id,
    withdrawNonce: nonce,
    reserveNanos: pi * 2,
  );
  late final Map<String, dynamic> proved;
  try {
    proved = proveFs1SpendWire({
      'notes': fs1NotesBytes(pubs, commits, 4),
      'indices': [0, 1],
      'spent': spent,
      'spendSeed': seed,
      'vout': <Map<String, dynamic>>[],
      'digest': digest,
      'anchor': anchor,
      'tree': const Fs1TreeState().toWire(),
    });
  } catch (e) {
    throw StateError('fs1_prove $e');
  }
  final tree = Fs1TreeState.fromWire(proved['tree']);
  try {
    final records = [for (final r in (proved['records'] as List)) r as Uint8List];
    final posted = [for (final r in records) fs1PostedProof(r)];
    final fs1 = proved['fs1'] as Uint8List;
    final excess = proved['excess'] as Uint8List;
    final leaves = <Map<String, Object?>>[];
    for (var i = 0; i < 2; i++) {
      final scalar = scalarBytes(hashToScalar([utf8Bytes('leaf-scalar-$i')]));
      final blind = scalarBytes(hashToScalar([utf8Bytes('leaf-blind-$i')]));
      final note = vaultLeafNote(amount: pi, scalar: scalar, blind: blind, unlock: 16);
      leaves.add({
        'scalar': scalar,
        'blind': blind,
        'note': note,
        'unlock': 16,
        'amount': pi,
        'epochs': [3, 4, 5],
        'withdrawPeriod': 3,
      });
    }
    final built = buildProvedWithdraw(
      dest20: dest20,
      nanos: pi * 2,
      id: id,
      portalId: portal,
      anchor: anchor,
      excess: excess,
      fs1: fs1,
      vin: [
        for (final p in posted) {'commit': p['cTilde']},
      ],
      admitProofs: [
        for (final p in posted)
          {
            'blob': p['blob'],
            'cTilde': p['cTilde'],
            'spendTag': p['spendTag'],
          },
      ],
      leaves: leaves,
      spendSeed: seed,
      releaseEpoch: 0,
      fee: 0,
      withdrawNonce: nonce,
    );
    if (built == null) throw StateError('null');
    print(jsonEncode(_json(built)));
  } finally {
    Fs1Native.tryLoad()?.treeFree(tree.handle);
  }
}
