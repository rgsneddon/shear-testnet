// Test support: a wallet book funded the way a live wallet is, from real
// sealed notes (a real Pedersen commit, range proof and admit key), never from
// a bare round credit or a pool figure. The note set the FS-1 prover spends
// from is served by [SealedNotePool], so a lock or a send builds a real FS-1
// spend over those notes and posts the real body.
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_vault_reward.dart' show hiddenChangeNote;

Uint8List seedOf(ShearIdentity id) => Uint8List.fromList([
      for (var i = 0; i < 32; i++) int.parse(id.seedHex.substring(i * 2, i * 2 + 2), radix: 16),
    ]);

/// A real sealed note of [nanos] on [dest], mined at [height] (null: not mined).
Map<String, dynamic> sealedNoteOn(
  String dest,
  Uint8List seed,
  int nanos, {
  int? height,
}) {
  final note = hiddenChangeNote(
    nanos,
    hash20FromAddress(dest)!,
    spendSeed: seed,
    admitBase: admitPub(admitBaseScalar(seed)),
  );
  expect(note, isNotNull, reason: 'a real sealed note (admit library loaded)');
  return {
    ...note!,
    'address': dest,
    'dest': dest,
    'kind': 'send',
    'nanos': nanos,
    'amount': nanos / kUnitsPerShe,
    'spendSeed': seed,
    'verified': true,
    if (height != null) 'height': height,
  };
}

/// Pool transport double: serves the live note set the notes above sit in,
/// and records every body the wallet posts. Nothing it returns is a balance.
class SealedNotePool extends ShearPoolClient {
  SealedNotePool()
      : super(
          baseUrl: 'http://127.0.0.1:9',
          http: HttpClient()..connectionTimeout = const Duration(milliseconds: 50),
        );

  final List<Uint8List> pubs = [];
  final List<Uint8List> commits = [];
  final List<Map<String, dynamic>> anchors = [];
  final List<Map<String, dynamic>> posts = [];

  /// Adds [note] to the live set, with an FS-1 anchor at [height] covering it.
  void addLive(Map<String, dynamic> note, int height) {
    pubs.add(Uint8List.fromList(note['admitPub'] as List<int>));
    commits.add(Uint8List.fromList(note['commit'] as List<int>));
    anchors.add({'height': height, 'n': pubs.length});
  }

  @override
  Future<Map<String, dynamic>> fluxset() async => {
        'pubs': pubs,
        'commits': commits,
        'anchors': anchors,
        'spendTags': const <Object>[],
      };

  @override
  Future<Map<String, dynamic>> reserveTrancheBook() async => {'ok': true, 'tranches': const []};

  @override
  Future<Map<String, dynamic>> postRaw(Map<String, dynamic> body) async {
    posts.add(body);
    return {'ok': true, 'id': body['id'] ?? 'tx-${posts.length}'};
  }
}

/// A wallet at [tip] holding one real note of [nanos] on a receive dest
/// (not the mining mailbox), mined at [height] and in the live note set.
class SealedBook {
  SealedBook._(this.id, this.seed, this.ledger, this.pool, this.from);

  final ShearIdentity id;
  final Uint8List seed;
  final ShearLedger ledger;
  final SealedNotePool pool;
  final String from;

  static SealedBook fund(List<int> nanosEach, {int height = 1, int? tip, ShearIdentity? identity}) {
    final id = identity ?? createIdentity();
    final seed = seedOf(id);
    final pool = SealedNotePool();
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    ledger.spendSeed = seed;
    final from = ledger.allocateReceiveDest(id.address, paymentCode: id.paymentCode);
    for (final nanos in nanosEach) {
      final note = sealedNoteOn(from, seed, nanos, height: height);
      ledger.rememberNote(note);
      pool.addLive(note, height);
    }
    final at = tip ?? height + ShearLedger.spendableConfirmations;
    ledger.noteLiveHeight(at);
    ledger.settleTo(at);
    ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    return SealedBook._(id, seed, ledger, pool, from);
  }

  int get spendableUnits {
    ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    return (ledger.spendableOwned(id.address, paymentCode: id.paymentCode) * kUnitsPerShe).round();
  }
}
