import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_body_scan.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_read_open.dart';
import 'package:shear_wallet/shear_vault_reward.dart' show hiddenChangeNote;

/// P0-1 (WH review of the claude/* wallet branches). `bodyProven` is the
/// wallet's own mark: a body it proved against a header it verified. A node
/// cannot hand it over. Every node input drops it, and only the body scan
/// sets it. Spendable is never painted from a node's word.

final Uint8List _seed = Uint8List.fromList(
  sha256.convert(utf8.encode('shear-body-proven-ingress-wallet')).bytes,
);

String _hex(List<int> b) =>
    b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

int _units(double she) => (she * kUnitsPerShe).round();

void main() {
  final id = createIdentity(Uint8List.fromList(_seed));
  final home =
      (ShearLedger()..bindIdentity(id)).homeDest(id.address, paymentCode: id.paymentCode);
  const nanos = 300000000000;

  Map<String, dynamic> sealed() {
    final note = hiddenChangeNote(
      nanos,
      hash20FromAddress(home)!,
      spendSeed: _seed,
      admitBase: admitPub(admitBaseScalar(_seed)),
    );
    expect(note, isNotNull, reason: 'a real note this wallet opens');
    return note!;
  }

  /// The node's wire output for [note], claiming a proven body at height 20.
  Map<String, dynamic> lyingVout(Map<String, dynamic> note) => {
        ...compactSealedVout(note),
        'kind': 'send',
        'height': 20,
        'bodyProven': true,
      };

  ShearLedger bodyModeBook() {
    final ledger = ShearLedger()..bindIdentity(id);
    ledger.noteLiveHeight(40);
    ledger.settleTo(40);
    ledger.restoreBodyScan(required: true, scanTo: 40);
    return ledger;
  }

  Map<String, dynamic>? noteFor(ShearLedger ledger, Map<String, dynamic> note) {
    final want = _hex(note['commit'] as List<int>);
    for (final n in ledger.notes) {
      final c = n['commit'];
      if (c is List<int> && _hex(c) == want) return n;
    }
    return null;
  }

  void expectNothingPainted(ShearLedger ledger, Map<String, dynamic> note) {
    final got = noteFor(ledger, note);
    expect(got, isNotNull, reason: 'the wallet did open the note (the test is not vacuous)');
    expect(got!['bodyProven'], isNot(true), reason: 'a node cannot mark a body proven');
    ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    expect(_units(ledger.spendableOwned(id.address, paymentCode: id.paymentCode)), 0,
        reason: 'Spendable is never painted from a node-supplied bodyProven');
    expect(ledger.plannerSelectableNanos(id.address, paymentCode: id.paymentCode), BigInt.zero);
    expect(ledger.pickableNotes, isEmpty);
  }

  test('the scan never copies a node-supplied bodyProven onto a note', () {
    final note = sealed();
    final rows = stampChainScanVouts([
      {
        'kind': 'withdraw',
        'vout': [lyingVout(note)],
      },
    ]);
    expect(rows.single.containsKey('bodyProven'), isFalse,
        reason: 'stampChainScanVouts drops the key from node JSON');
    final out = scanSealedVouts({
      'vouts': [lyingVout(note)],
      'dests': [home],
      'dest': home,
      'spendSeed': _seed,
    });
    final opened = (out['notes'] as List).cast<Map>();
    expect(opened, isNotEmpty, reason: 'the scan opened the note');
    for (final n in opened) {
      expect(n.containsKey('bodyProven'), isFalse);
    }
  });

  test('a body-scan row carries no bodyProven of its own: only the proof sets it', () {
    final rows = wireScanRows(
      [
        {
          'kind': 'send',
          'vout': [
            {'commit': List<int>.filled(32, 7), 'bodyProven': true},
          ],
        },
      ],
      height: 20,
      blockHash: Uint8List(32),
    );
    expect(rows.single.containsKey('bodyProven'), isFalse);
  });

  test('a node page carrying bodyProven:true leaves Spendable at 0 (chain-tx page)', () {
    final note = sealed();
    final ledger = bodyModeBook();
    ledger.ingestChainTxs([
      {
        'kind': 'withdraw',
        'vout': [lyingVout(note)],
      },
    ], dest: home);
    expectNothingPainted(ledger, note);
  });

  test('a node notes row carrying bodyProven:true leaves Spendable at 0 (sealed rows)', () {
    final note = sealed();
    final ledger = bodyModeBook();
    ledger.ingestSealedVouts([lyingVout(note)], spendSeed: _seed, dest: home);
    expectNothingPainted(ledger, note);
  });

  test('a read page (or sidecar) carrying bodyProven:true leaves Spendable at 0', () {
    // A read page opens public-value outputs (a coinbase-style seal).
    final note = attachAdmitPub(
      sealCoinbaseNote(nanos, dest20: hash20FromAddress(home)!, kind: 'pot'),
      spendSeed: _seed,
      admitBase: admitPub(admitBaseScalar(_seed)),
      v: BigInt.from(nanos),
    );
    final ledger = bodyModeBook();
    final vout = {
      ...compactSealedVout(note),
      'valueProof': note['valueProof'],
      'height': 20,
      'bodyProven': true,
    };
    final block = {
      'height': 20,
      'txs': [
        {
          'kind': 'send',
          'vout': [vout],
        },
      ],
    };
    ledger.ingestReadOpen(
      ReadBlockOpen(
        order: const [20],
        opened: [
          OpenedReadNote(
            height: 20,
            nanos: nanos,
            verified: true,
            commit: Uint8List.fromList(note['commit'] as List<int>),
            dest: home,
          ),
        ],
        unspendable: const [],
        catchingUp: false,
        deferredUntilSync: false,
        spendableNanos: nanos,
        ibd: false,
        liveTip: 40,
      ),
      blocks: [block],
      dest: home,
    );
    expectNothingPainted(ledger, note);
  });

  test('a node row cannot move a proven note to another height', () {
    final note = sealed();
    final ledger = bodyModeBook();
    ledger.rememberNote({
      ...note,
      'address': home,
      'dest': home,
      'kind': 'send',
      'nanos': nanos,
      'amount': nanos / kUnitsPerShe,
      'verified': true,
      'height': 38,
      'bodyProven': true,
    });
    ledger.ingestSealedVouts([
      {...lyingVout(note), 'height': 5},
    ], spendSeed: _seed, dest: home);
    final got = noteFor(ledger, note)!;
    expect(got['height'], 38, reason: 'the proven height stands; a node claim cannot deepen it');
    ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    expect(_units(ledger.spendableOwned(id.address, paymentCode: id.paymentCode)), 0,
        reason: '3 confirmations is not Spendable');
  });
}
