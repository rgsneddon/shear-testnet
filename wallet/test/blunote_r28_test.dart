import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_blunote.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_ristretto.dart';
import 'package:shear_wallet/shear_session.dart';

/// R28 BluNotes, wallet side. The vectors come from crypto/blunote.js
/// (test/fixtures/gen_blunote_vectors.mjs); every Dart derivation must match
/// them byte for byte.
Uint8List _b(String hex) => Uint8List.fromList([
      for (var i = 0; i < hex.length; i += 2) int.parse(hex.substring(i, i + 2), radix: 16),
    ]);

String _h(Uint8List b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Uint8List _seedOf(ShearIdentity id) => _b(id.seedHex);

void _u64(BytesBuilder o, BigInt v) {
  for (var i = 0; i < 8; i++) {
    o.addByte(((v >> (8 * i)) & BigInt.from(0xff)).toInt());
  }
}

/// Same layout as crypto/blunote.js encodeRecord.
Uint8List _record({
  required BigInt T,
  BigInt? feeV,
  Uint8List? feeR,
  Uint8List? feeP,
  required List<({Uint8List R, Uint8List P, int m})> winners,
  int salt = 0,
}) {
  final o = BytesBuilder();
  o.add(Uint8List(32)..[0] = salt);
  o.add([winners.length, 0, 0, 0]);
  _u64(o, BigInt.from(1024));
  _u64(o, T);
  _u64(o, feeV ?? BigInt.zero);
  o.add(feeR ?? Uint8List(32));
  o.add(feeP ?? Uint8List(32));
  o.addByte(winners.length);
  for (final w in winners) {
    o.add(w.R);
    o.add(w.P);
    o.addByte(w.m);
  }
  return o.toBytes();
}

void main() {
  final vec = jsonDecode(File('test/fixtures/blunote_vectors.json').readAsStringSync()) as Map<String, dynamic>;
  final wallets = {
    for (final w in (vec['wallets'] as List).cast<Map<String, dynamic>>()) w['label'] as String: w,
  };
  Uint8List seedOf(String label) => _b(wallets[label]!['seed'] as String);

  group('vectors from crypto/blunote.js', () {
    test('H is the chain value generator', () {
      expect(_h(noteHBytes), vec['H']);
    });

    test('seed gives y, Y, x_base, B and the mining address', () {
      expect(wallets.length, 3);
      for (final w in wallets.values) {
        final seed = _b(w['seed'] as String);
        expect(_h(scalarBytes(bluScanScalar(seed))), w['y'], reason: '${w['label']} y');
        expect(_h(bluScanPub(seed)), w['Y'], reason: '${w['label']} Y');
        expect(_h(scalarBytes(admitBaseScalar(seed))), w['xBase'], reason: '${w['label']} x_base');
        expect(_h(admitBaseBytes(seed)), w['B'], reason: '${w['label']} B');
        final addr = bluMiningAddress(seed);
        expect(addr, w['miningAddress']);
        expect(addr.length, 114, reason: 'shm1 + bech32 of B‖Y');
      }
    });

    test('(seed, r) gives R, P, delta, x and rho; P = x·G', () {
      final rows = (vec['oneTime'] as List).cast<Map<String, dynamic>>();
      expect(rows.length, 6);
      for (final row in rows) {
        final w = wallets[row['wallet']]!;
        final r = scalarFromBytes(_b(row['r'] as String));
        final k = bluOneTimeKey(_b(w['B'] as String), _b(w['Y'] as String), r);
        expect(_h(k.R), row['R']);
        expect(_h(k.P), row['P']);
        final keys = BluKeys.fromSeed(_b(w['seed'] as String));
        final delta = bluRecognise(keys, k.R, k.P);
        expect(delta, isNotNull);
        expect(_h(scalarBytes(delta!)), row['delta']);
        final x = bluSpendScalar(keys.xBase, delta);
        expect(_h(scalarBytes(x)), row['x']);
        expect(_h(pointBytes(mulG(x))), row['P'], reason: 'P = x·G');
        expect(_h(scalarBytes(bluRho(k.P))), row['rho']);
        for (final other in wallets.keys.where((l) => l != row['wallet'])) {
          expect(bluRecognise(BluKeys.fromSeed(seedOf(other)), k.R, k.P), isNull,
              reason: '$other must not recognise ${row['wallet']}');
        }
      }
    });

    test('the record decodes to its fields', () {
      final rec = decodeBluRecord(_b(vec['record']['hex'] as String))!;
      expect(rec.T.toString(), vec['record']['T']);
      expect(rec.piece.toString(), vec['record']['piece']);
      expect(rec.feeV.toString(), vec['record']['feeV']);
      expect(rec.n, 9);
      expect(rec.W, BigInt.from(4096));
      expect(rec.winners.length, 4);
      expect(bluRecordRootHex(_b(vec['record']['hex'] as String)), vec['record']['root']);
      final empty = decodeBluRecord(_b(vec['emptyRecord'] as String))!;
      expect(empty.winners, isEmpty);
      expect(empty.feeV, BigInt.zero);
    });

    test('scanning the record finds exactly each wallet\'s notes', () {
      final record = _b(vec['record']['hex'] as String);
      final want = (vec['record']['notes'] as List).cast<Map<String, dynamic>>();
      expect(want.length, 5);
      for (final label in wallets.keys) {
        final seed = seedOf(label);
        final found = scanBluRecord(record, BluKeys.fromSeed(seed), 77);
        final mine = want.where((n) => n['owner'] == label).toList();
        expect(found.length, mine.length, reason: label);
        for (var i = 0; i < mine.length; i++) {
          final f = found[i];
          final n = mine[i];
          expect(f.kind, n['kind'] == 'pool-fee' ? kBluKindFee : kBluKindWinner);
          expect(_h(f.R), n['R']);
          expect(_h(f.P), n['P']);
          expect(f.v.toString(), n['v']);
          expect(_h(f.C), n['C']);
          expect(_h(scalarBytes(f.rho)), n['rho']);
          expect(f.height, 77);
          if (n['m'] != null) expect(f.m, n['m']);
          // The spend path derives x from the seed and the stored R alone.
          final x = admitScalarFromSeed(seed, {'kind': f.kind, 'noteCommit': f.R, 'commit': f.C});
          expect(_h(scalarBytes(x)), n['x']);
          expect(_h(pointBytes(admitPub(x))), n['P'], reason: 'P = x·G');
          expect(noteIsFs1Leaf(f.P, f.C), isTrue);
        }
      }
      // alice: two winners. bob: the fee note and one winner. stranger: one.
      expect(want.where((n) => n['owner'] == 'alice').length, 2);
      expect(want.where((n) => n['owner'] == 'bob').length, 2);
      expect(want.where((n) => n['owner'] == 'stranger').length, 1);
      final outsider = BluKeys.fromSeed(_seedOf(createIdentity()));
      expect(scanBluRecord(record, outsider, 77), isEmpty);
    });

    test('an empty or a broken record finds nothing', () {
      final keys = BluKeys.fromSeed(seedOf('alice'));
      expect(scanBluRecord(_b(vec['emptyRecord'] as String), keys, 5), isEmpty);
      final record = _b(vec['record']['hex'] as String);
      expect(scanBluRecord(Uint8List.fromList(record.sublist(0, record.length - 1)), keys, 5), isEmpty);
      expect(decodeBluRecord(Uint8List(10)), isNull);
    });
  });

  group('"This wallet mines" switch', () {
    test('defaults off, and off scans nothing', () {
      final s = BluMiningScanner();
      expect(s.enabled, isFalse);
      final block = {'height': 3, 'blunoteRecord': vec['record']['hex']};
      expect(s.scanBlocks([block], seedOf('alice')), isEmpty);
      expect(s.scannedCount, 0, reason: 'off does not even mark the record');
      s.enabled = true;
      expect(s.scanBlocks([block], seedOf('alice')).length, 2);
      expect(s.scanBlocks([block], seedOf('alice')), isEmpty, reason: 'a record is scanned once');
      s.reset();
      expect(s.scanBlocks([block], seedOf('alice')).length, 2, reason: 'reset rescans');
      final late = BluMiningScanner(enabled: true, birthHeight: 4);
      expect(late.scanBlocks([block], seedOf('alice')), isEmpty, reason: 'below birth height');
      final atBirth = BluMiningScanner(enabled: true, birthHeight: 3);
      expect(atBirth.scanBlocks([block], seedOf('alice')).length, 2, reason: 'the birth block is scanned');
      // A clock never decides it: a block's time is not read.
      final genesis = BluMiningScanner(enabled: true);
      expect(genesis.scanBlocks([{...block, 'timeMs': 1}], seedOf('alice')).length, 2);
    });

    test('ruling 7 birth on create: verified tip minus 10, or genesis with no verified tip', () {
      expect(walletBirthForNewWallet(98), 88);
      expect(walletBirthForNewWallet(10), 0);
      expect(walletBirthForNewWallet(0), 0, reason: 'no verified tip: genesis, not a guess');
      final fresh = ShearLedger()..bindIdentity(createIdentity());
      expect(fresh.verifiedHeaderTip, 0);
      expect(walletBirthForNewWallet(fresh.verifiedHeaderTip), 0);
    });

    test('a new session has the switch off; it survives a seal and unlock', () async {
      final dir = Directory.systemTemp.createTempSync('shear-blu-session-');
      final session = ShearSession(store: File('${dir.path}/session.json'));
      expect(session.bluMining, isFalse);
      await session.loadOrCreate();
      expect(session.bluMining, isFalse);
      await session.setPassword('correct horse battery staple 1');
      session.bluMining = true;
      await session.persist();
      final again = ShearSession(store: File('${dir.path}/session.json'));
      await again.loadOrCreate();
      await again.unlock('correct horse battery staple 1');
      expect(again.bluMining, isTrue);
      dir.deleteSync(recursive: true);
    });

    test('ruling 7 birth: a height kept across a seal and unlock, and the ledger and scanner take it', () async {
      final dir = Directory.systemTemp.createTempSync('shear-blu-birth-');
      final session = ShearSession(store: File('${dir.path}/session.json'));
      await session.loadOrCreate();
      expect(session.birthHeight, 0);
      session.birthHeight = 4321;
      await session.setPassword('correct horse battery staple 1');
      final again = ShearSession(store: File('${dir.path}/session.json'));
      await again.loadOrCreate();
      await again.unlock('correct horse battery staple 1');
      expect(again.birthHeight, 4321);
      final ledger = ShearLedger()..bindIdentity(again.identity!);
      ledger.setBluMining(true, birthHeight: again.birthHeight);
      expect(ledger.birthHeight, 4321);
      expect(ledger.blu.birthHeight, 4321);
      expect(ledger.bodyScanTo, 4320, reason: 'no body below the birth is read');
      dir.deleteSync(recursive: true);
    });
  });

  group('ledger', () {
    const h = 20;
    final T = BigInt.from(16) * BigInt.from(3000000000) + BigInt.from(5);
    final piece = T ~/ BigInt.from(16);

    ShearLedger ledgerAt(ShearIdentity id, int tip) {
      final ledger = ShearLedger()..bindIdentity(id);
      ledger.bluScanInline = true;
      ledger.noteLiveHeight(tip);
      ledger.settleTo(tip);
      return ledger;
    }

    int spendableUnits(ShearLedger ledger, ShearIdentity id) {
      ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
      return (ledger.spendableOwned(id.address, paymentCode: id.paymentCode) * kUnitsPerShe).round();
    }

    /// Block h with [rec], and block h+1 whose coinbase names its root, as
    /// compact rows a node sends. Ruling 7: such a row is not proven against
    /// a verified header, so it binds nothing (the proven path is
    /// blunote_r28_coinbase_proof_test.dart).
    List<Map<String, dynamic>> bound(Uint8List rec, {String? prev}) => [
          {'height': h, 'blunoteRecord': _h(rec)},
          {
            'height': h + 1,
            'txs': [
              {
                'coinbase': true,
                'blunote': {'feeBps': 0, 'prev': prev ?? bluRecordRootHex(rec)},
              },
            ],
          },
        ];

    ({Uint8List R, Uint8List P, int m}) winnerFor(Uint8List seed, int j, int m) {
      final k = bluOneTimeKey(admitBaseBytes(seed), bluScanPub(seed), hashToScalar([utf8Bytes('ledger-r'), Uint8List.fromList([j])]));
      return (R: k.R, P: k.P, m: m);
    }

    test('off by default: a winning record adds nothing', () {
      final id = createIdentity();
      final ledger = ledgerAt(id, h + 20);
      expect(ledger.bluMining, isFalse);
      final rec = _record(T: T, winners: [winnerFor(_seedOf(id), 1, 2)]);
      ledger.ingestBluRecords([
        {'height': h, 'blunoteRecord': _h(rec)},
      ]);
      expect(ledger.notes.where((n) => isBluNoteKind(n['kind'] as String?)), isEmpty);
      expect(spendableUnits(ledger, id), 0);
    });

    test('on: own winners only; from compact rows alone they wait for the next record, with no figure', () {
      final id = createIdentity();
      final seed = _seedOf(id);
      final stranger = _seedOf(createIdentity());
      final rec = _record(T: T, winners: [
        winnerFor(seed, 1, 3),
        winnerFor(stranger, 2, 9),
        winnerFor(seed, 3, 1),
      ]);
      final blocks = bound(rec);

      // Depth 4: Pending, not Spendable.
      final shallow = ledgerAt(id, h + 3);
      shallow.setBluMining(true);
      shallow.ingestBluRecords(blocks);
      final found = shallow.notes.where((n) => isBluNoteKind(n['kind'] as String?)).toList();
      expect(found.length, 2, reason: 'the stranger\'s row is not ours');
      expect(spendableUnits(shallow, id), 0);
      final pendingUnits =
          (shallow.unconfirmedIncomingShe(id.address, paymentCode: id.paymentCode) * kUnitsPerShe).round();
      expect(pendingUnits, 0, reason: 'an unbound record note paints no figure');
      expect(shallow.bluAwaitingRecord, 2, reason: kBluAwaitingRecord);

      // Header depth unknown (the verified tip is below the note): Pending.
      final noHeaders = ledgerAt(id, h - 1);
      noHeaders.setBluMining(true);
      noHeaders.ingestBluRecords(blocks);
      expect(spendableUnits(noHeaders, id), 0);

      // Nine confirmations (h .. h+8), and a compact h+1 that names the
      // root: still not Spendable, as that row is not proven (ruling 7).
      final deep = ledgerAt(id, h + 8);
      deep.setBluMining(true);
      deep.ingestBluRecords(blocks);
      expect(spendableUnits(deep, id), 0);
      expect(deep.bluAwaitingRecord, 2);

      for (final n in deep.notes.where((n) => isBluNoteKind(n['kind'] as String?))) {
        final x = admitScalarFromSeed(seed, Map<String, dynamic>.from(n));
        expect(_h(pointBytes(admitPub(x))), _h(n['admitPub'] as Uint8List), reason: 'P = x·G');
        final v = BigInt.from(n['nanos'] as int);
        expect(_h(n['commit'] as Uint8List), _h(bluCommit(v, n['admitPub'] as Uint8List)));
        expect(spendTagHexOf(seed, Map<String, dynamic>.from(n)), isNotNull);
        expect(n.containsKey('delta'), isFalse, reason: 'no secret in the book');
      }
    });

    test('ruling 7: a coinbase row the node sends never binds its record, right root or wrong', () {
      final id = createIdentity();
      final seed = _seedOf(id);
      final rec = _record(T: T, winners: [winnerFor(seed, 1, 2)]);
      final two = (piece * BigInt.from(2)).toInt();

      // Nine confirmations but block h+1 not read yet: Pending, not Spendable.
      final unbound = ledgerAt(id, h + 8);
      unbound.setBluMining(true);
      unbound.ingestBluRecords([
        {'height': h, 'blunoteRecord': _h(rec)},
      ]);
      expect(unbound.notes.where((n) => isBluNoteKind(n['kind'] as String?)).length, 1);
      expect(spendableUnits(unbound, id), 0);
      // Block h+1 arrives as a compact row naming the right root: it is not
      // proven against a verified header, so the note still waits.
      unbound.ingestBluRecords(bound(rec));
      expect(spendableUnits(unbound, id), 0);
      expect(two, greaterThan(0));
      expect(unbound.notes.where((n) => isBluNoteKind(n['kind'] as String?)).single['verified'], isFalse);

      // A coinbase that names another root: never Spendable.
      final wrong = ledgerAt(id, h + 8);
      wrong.setBluMining(true);
      wrong.ingestBluRecords(bound(rec, prev: 'ab' * 32));
      expect(spendableUnits(wrong, id), 0);
    });

    test('a replaced record (reorg) marks its notes reorged', () {
      final id = createIdentity();
      final seed = _seedOf(id);
      final ledger = ledgerAt(id, h + 8);
      ledger.setBluMining(true);
      ledger.ingestBluRecords(bound(_record(T: T, winners: [winnerFor(seed, 1, 2)])));
      Map<String, dynamic> note() => ledger.notes.where((n) => isBluNoteKind(n['kind'] as String?)).single;
      expect(note()['reorged'], isFalse);
      // A row sent without its record is not a replaced block.
      ledger.ingestBluRecords([
        {'height': h},
      ]);
      expect(note()['reorged'], isFalse);
      ledger.ingestBluRecords(bound(_record(T: T, winners: const [], salt: 1)));
      expect(note()['reorged'], isTrue);
      expect(spendableUnits(ledger, id), 0);
      expect(ledger.bluAwaitingRecord, 0, reason: 'a replaced note is not waiting for a record');
    });

    test('the fee note of a record is found when the fee key is ours', () {
      final id = createIdentity();
      final seed = _seedOf(id);
      final fee = winnerFor(seed, 9, 0);
      final ledger = ledgerAt(id, h + 8);
      ledger.setBluMining(true);
      ledger.ingestBluRecords(
        bound(_record(T: T, feeV: BigInt.from(777), feeR: fee.R, feeP: fee.P, winners: const [])),
      );
      final notes = ledger.notes.where((n) => n['kind'] == kBluKindFee).toList();
      expect(notes.length, 1);
      expect(notes.single['nanos'], 777);
      expect(spendableUnits(ledger, id), 0, reason: 'its record is not proven yet');
      expect(ledger.bluAwaitingRecord, 1);
    });
  });
}
