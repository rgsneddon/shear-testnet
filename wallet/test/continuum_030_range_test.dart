import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_native_prove.dart';
import 'package:shear_wallet/shear_note.dart';

/// Inbox 030. A pot, hash, finder-fee, reserve-fee, or pool-fee note is opened
/// only when the node range proof accepts. A receive still follows the value
/// proof. A flat stand-in is not a range proof.
///
/// Every row is an FS-1 leaf (N-1, #79, 14 Oct): its admitPub is the one this
/// wallet's seed derives for that note and kind, as a mined payout carries.
/// A row with no admit key is not a wallet note at all.
Map<String, dynamic> _leaf(Map<String, dynamic> note, Uint8List seed) =>
    attachAdmitPub(Map<String, dynamic>.from(note)..remove('admitPub'), spendSeed: seed);

void main() {
  test('payout ingest verifies the range proof and leaves receive alone', () {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final d20 = hash20FromAddress(dest)!;
    final spend = ledger.spendSeed!;
    const nanos = 7 * 1000000;
    const hashNanos = 512;
    final honest = _leaf(nativeSealNote(nanos, dest20: d20, kind: 'pot'), spend);
    final hashNote = _leaf(nativeSealNote(hashNanos, dest20: d20, kind: 'hash'), spend);
    expect(noteIsFs1Leaf(honest['admitPub'] as Uint8List, honest['commit'] as Uint8List), isTrue);
    final proof = Uint8List.fromList(honest['rangeProof'] as Uint8List);
    expect(proof.length, greaterThan(64));
    expect(proof[0], 2);

    Map<String, dynamic> row(String kind, {Uint8List? range, bool dropRange = false}) {
      final note = Map<String, dynamic>.from(honest);
      note['kind'] = kind;
      if (dropRange) {
        note.remove('rangeProof');
      } else if (range != null) {
        note['rangeProof'] = range;
      }
      return _leaf(note, spend);
    }

    Uint8List flipped() {
      final bad = Uint8List.fromList(proof);
      bad[bad.length - 1] ^= 0x01;
      return bad;
    }

    final standIn = Uint8List.fromList([2, ...List<int>.filled(64, 4)]);
    final scanned = scanSealedVouts({
      'vouts': [
        row('pot'),
        hashNote,
        row('finder-fee'),
        row('reserve-fee'),
        row('pool-fee'),
        row('pot', dropRange: true),
        row('hash', range: flipped()),
        row('pool-fee', range: standIn),
        row('receive', dropRange: true),
      ],
      'dests': [dest],
      'dest': dest,
      'spendSeed': spend,
    });
    final notes = (scanned['notes'] as List).cast<Map>();
    expect(notes, hasLength(9));

    bool opened(Map note) => note['verified'] == true;
    for (final kind in ['pot', 'finder-fee', 'reserve-fee', 'pool-fee']) {
      final hit = notes.where((n) => n['kind'] == kind && opened(n)).toList();
      expect(hit, hasLength(1), reason: kind);
      expect(hit.single['verifiedNanos'].toString(), '$nanos');
      expect(hit.single['amount'], closeTo(nanos / kUnitsPerShe, 1e-12));
    }
    final openedHash = notes.where((n) => n['kind'] == 'hash' && opened(n)).toList();
    expect(openedHash, hasLength(1));
    expect(openedHash.single['verifiedNanos'].toString(), '$hashNanos');
    expect(notes.where((n) => n['kind'] == 'pot' && !opened(n)), hasLength(1));
    expect(notes.where((n) => n['kind'] == 'hash' && !opened(n)), hasLength(1));
    expect(notes.where((n) => n['kind'] == 'pool-fee' && !opened(n)), hasLength(1));
    for (final note in notes.where((n) => !opened(n) && n['kind'] != 'receive')) {
      expect(note.containsKey('verified'), isFalse);
      expect(note.containsKey('amount'), isFalse);
      expect(note.containsKey('verifiedNanos'), isFalse);
    }
    final receive = notes.where((n) => n['kind'] == 'receive').single;
    expect(receive['verified'], isTrue);
    expect(receive['verifiedNanos'].toString(), '$nanos');
    expect(scanned['unopenedProofs'], 3);
    final folds = (scanned['hashFolds'] as List).cast<Map>();
    expect(folds, hasLength(1));
    expect(folds.single['she'], closeTo(hashNanos / kUnitsPerShe, 1e-12));

    final wire = scanSealedWire({
      'vouts': [honest],
      'dests': [dest],
      'dest': dest,
      'spendSeed': spend,
    });
    final wired = (wire['notes'] as List).cast<Map>().single;
    expect(wired['verified'], isTrue);
    expect(wired['kind'], 'pot');
  });

  test('a cached payout opening still needs a range proof', () {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final d20 = hash20FromAddress(dest)!;
    // A real sealed note: commit, blind and value proof. Its own range proof
    // is replaced by a flat stand-in, so only the cached opening could open it.
    final sealed = nativeSealNote(2500000000, dest20: d20, kind: 'hash');
    final key = proofCacheKey(sealed)!;
    Map<String, dynamic> scan(String kind) => scanSealedVouts({
          'vouts': [
            _leaf({
              'dest': dest,
              'kind': kind,
              'noteCommit': sealed['noteCommit'],
              'commit': sealed['commit'],
              'r': sealed['r'],
              'valueProof': sealed['valueProof'],
              'rangeProof': Uint8List.fromList([2, ...List<int>.filled(64, 4)]),
              'height': 1,
            }, ledger.spendSeed!),
          ],
          'dests': [dest],
          'dest': dest,
          'spendSeed': ledger.spendSeed,
          'openedProofs': [
            {'k': key, 'n': 2500000000},
          ],
        });

    final payout = (scan('hash')['notes'] as List).cast<Map>().single;
    expect(payout.containsKey('verified'), isFalse);
    expect(payout.containsKey('amount'), isFalse);
    final receive = (scan('receive')['notes'] as List).cast<Map>().single;
    expect(receive['verified'], isTrue);
    expect(receive['verifiedNanos'].toString(), '2500000000');
  });
}
