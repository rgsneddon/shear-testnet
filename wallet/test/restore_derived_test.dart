import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_fs1.dart';
import 'package:shear_wallet/shear_ed25519.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_native_prove.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_pack.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_vault_reward.dart';

void main() {
  test('a restored lock index does not restart at 0', () {
    final id = createIdentity();
    final seed = hexToBytes(id.seedHex);
    final ledger = ShearLedger()..spendSeed = seed;
    final portal = reservePortalIdFromSeed('', seed, 0);
    expect(portal, isNotNull);
    ledger.noteChainPortals([portal!]);
    expect(ledger.nextLockIndex, 1);
  });

  test('restore clears the notes cursor so sync reads below the sealed tip', () {
    final ledger = ShearLedger();
    final id = createIdentity();
    ledger.bindIdentity(id);
    ledger.restoreSealedTip(12);
    expect(ledger.rescanBelowSealed, isTrue);
    expect(ledger.sealedHeight, 12);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    expect(ledger.notesStamped(home), isFalse);
  });

  test('an open epoch lock is not withdrawable and a finished one is', () {
    final open = {
      'kind': 'lock',
      'scalar': Uint8List(32),
      'blind': Uint8List(32),
      'note': Uint8List(64),
      'epochs': [1],
    };
    expect(reserveLeafEpochEnded([open], 1), isFalse);
    expect(reserveLeafEpochEnded([
      {...open, 'epochs': [0]},
    ], 1), isTrue);
    expect(reserveLeafEpochEnded([
      {...open, 'epochs': [0, 1]},
    ], 1), isFalse);
    expect(reserveLeafEpochEnded([
      {...open, 'epochs': [0, 1]},
    ], 2), isTrue);
  });

  test('lock change scan keeps the floor and a gap past the highest index', () {
    expect(lockChangeIndexEnd(), kLockIndexFloor);
    expect(lockChangeIndexEnd(noteIndices: [10]), kLockIndexFloor);
    expect(lockChangeIndexEnd(noteIndices: [80]), 88);
    final seed = hexToBytes(createIdentity().seedHex);
    final portals = <String>{};
    for (var i = 0; i <= 70; i++) {
      final id = reservePortalIdFromSeed('', seed, i);
      expect(id, isNotNull);
      portals.add(id!);
    }
    expect(lockChangeIndexEnd(spendSeed: seed, portalIds: portals), 78);
  });

  test('scanSealedVouts finds a lock output past the floor', () {
    final id = createIdentity();
    final seed = hexToBytes(id.seedHex);
    const index = 70;
    final dest20 = reservePortalDest20FromSeed(seed, index);
    final owner = reservePortalSpendSeed(seed, index);
    expect(dest20, isNotNull);
    expect(owner, isNotNull);
    final sealed = attachAdmitPub(
      sealCoinbaseNote(1000, dest20: dest20, kind: 'lock'),
      spendSeed: owner,
    );
    final found = scanSealedVouts({
      'vouts': [sealed],
      'dest': id.address,
      'dests': [id.address],
      'spendSeed': seed,
      'lockChangeEnd': index,
    });
    final notes = (found['notes'] as List).cast<Map>();
    expect(notes, hasLength(1));
    expect(notes.single['kind'], 'lock');
    final missed = scanSealedVouts({
      'vouts': [sealed],
      'dest': id.address,
      'dests': [id.address],
      'spendSeed': seed,
      'lockChangeEnd': kLockIndexFloor,
    });
    expect((missed['notes'] as List), isEmpty);
  });

  test('a saved output commit recovers a vote change the rescan does not contain', () async {
    expect(Fs1Native.tryLoad(), isNotNull, reason: 'fs1_prover_unavailable');
    final id = createIdentity();
    final seed = hexToBytes(id.seedHex);
    const changeNanos = 100000;
    final fee = attachAdmitPub(
      nativeSealNote(200000, dest20: Uint8List(20)..[0] = 3, kind: 'pot'),
      spendSeed: seed,
    );
    final voteSeed = voteChangeSeedOf(seed, fee['commit'] as Uint8List);
    if (voteSeed == null) fail('vote seed');
    final voteChange = hiddenChangeNote(
      changeNanos,
      destCommitOf(voteSeed),
      spendSeed: voteSeed,
      admitBase: admitPub(admitBaseScalar(seed)),
    );
    expect(voteChange, isNotNull);
    final flux = <String, dynamic>{
      'pubs': <Object>[],
      'commits': <Object>[],
      'anchors': [
        {'height': 32, 'n': 0},
      ],
      'spendTags': <Object>[],
    };
    final pool = _RestorePool(flux);
    addTearDown(pool.close);
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    ledger.ingestChainTxs([
      {
        'kind': 'pot',
        'coinbase': true,
        'vout': [compactSealedVout(fee)],
      },
    ]);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final spec = ledger.exportCreditFollow(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      full: true,
    );
    final saved = spec['outputCommits'];
    expect(saved, isA<List>());
    expect((saved as List).isNotEmpty, isTrue);
    spec['notes'] = <Object?>[];
    final again = ShearLedger(pool: pool)..installCreditFollow(spec);
    again.ingestChainTxs([
      {
        'kind': 'leaf-vote',
        'vout': [compactSealedVout(voteChange!)],
      },
    ], dest: home);
    final found = again.notes.where(
      (n) => n['changeSeed'] is Uint8List && n['withdrawNonce'] == null && n['portalId'] == null,
    );
    expect(found, hasLength(1));
  });

  test('a wait is local time and a later remark clears it', () {
    final ledger = ShearLedger();
    ledger.noteReserveWait(DateTime.utc(2026, 1, 2, 3, 4).millisecondsSinceEpoch);
    ledger.noteReserveRemark('epoch still open');
    expect(ledger.reserveWaitMs, isNull);
    expect(ledger.reserveRemark, 'epoch still open');
    ledger.noteReserveWait(1_700_000_000_000);
    expect(ledger.reserveRemark, isEmpty);
    final copy = reservePostWaitCopy(waitMs: ledger.reserveWaitMs);
    expect(copy, startsWith('Scheduled for '));
    expect(copy, matches(RegExp(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}')));
    expect(copy, isNot(contains('Z')));
    ledger.clearReserveNotice();
    expect(ledger.reserveRemark, isEmpty);
    expect(ledger.reserveWaitMs, isNull);
    expect(reservePostWaitCopy(), reserveEpochStillOpenCopy());
  });

  test('tx fields recover the receipt, the withdraw change, and the vote change', () async {
    expect(Fs1Native.tryLoad(), isNotNull, reason: 'fs1_prover_unavailable');
    final id = createIdentity();
    final seed = hexToBytes(id.seedHex);
    final portal = reservePortalIdFromSeed('', seed, 0)!;
    final nonce = Uint8List(32)..[0] = 9;
    final changeSeed = withdrawChangeSeedOf(seed, portal, nonce);
    final payoutSeed = withdrawPayoutSeedOf(seed, portal, nonce);
    if (changeSeed == null || payoutSeed == null) fail('seeds');
    const changeNanos = 100000;
    const receiptNanos = 50000;
    final change = hiddenChangeNote(
      changeNanos,
      destCommitOf(changeSeed),
      spendSeed: changeSeed,
      admitBase: admitPub(admitBaseScalar(seed)),
    );
    final receipt = attachAdmitPub(
      nativeSealNote(receiptNanos, dest20: destCommitOf(payoutSeed), kind: 'withdraw'),
      spendSeed: payoutSeed,
      admitBase: admitPub(admitBaseScalar(seed)),
      v: BigInt.from(receiptNanos),
    );
    expect(change, isNotNull);
    expect(receipt['rEph'], isA<Uint8List>());
    final fee = attachAdmitPub(
      nativeSealNote(200000, dest20: Uint8List(20)..[0] = 3, kind: 'pot'),
      spendSeed: seed,
    );
    final voteSeed = voteChangeSeedOf(seed, fee['commit'] as Uint8List);
    if (voteSeed == null) fail('vote seed');
    final voteChange = hiddenChangeNote(
      changeNanos,
      destCommitOf(voteSeed),
      spendSeed: voteSeed,
      admitBase: admitPub(admitBaseScalar(seed)),
    );
    expect(voteChange, isNotNull);
    final compactChange = compactSealedVout(change!);
    expect(compactChange.containsKey('portalId'), isFalse);
    expect(compactChange.containsKey('withdrawNonce'), isFalse);
    expect(compactChange.containsKey('r'), isFalse);
    final flux = <String, dynamic>{
      'pubs': <Object>[],
      'commits': <Object>[],
      'anchors': [
        {'height': 32, 'n': 1},
      ],
      'spendTags': <Object>[],
    };
    final pool = _RestorePool(flux);
    addTearDown(pool.close);
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    ledger.restoreSealedTip(12);
    ledger.ingestChainTxs([
      {
        'kind': 'lock',
        'portalId': portal,
        'vout': [
          {'kind': 'lock', 'portalId': portal},
        ],
      },
      {
        'kind': 'pot',
        'coinbase': true,
        'vout': [compactSealedVout(fee)],
      },
      {
        'kind': 'leaf-vote',
        'vout': [compactSealedVout(voteChange!)],
      },
      {
        'kind': 'withdraw',
        'portalId': portal,
        'withdrawNonce': nonce,
        'vout': [
          compactSealedVout(receipt),
          compactChange,
        ],
      },
    ]);
    expect(ledger.nextLockIndex, 1);
    final foundReceipt = ledger.notes.where((n) => n['payoutSeed'] is Uint8List).toList();
    final foundChange = ledger.notes.where((n) => n['changeSeed'] is Uint8List && n['withdrawNonce'] != null).toList();
    final foundVote = ledger.notes.where((n) => n['changeSeed'] is Uint8List && n['withdrawNonce'] == null && n['portalId'] == null).toList();
    expect(foundReceipt, hasLength(1));
    expect(foundChange, hasLength(1));
    expect(foundVote, hasLength(1));
    expect(foundReceipt.single['r'], isA<Uint8List>());
    expect(foundVote.single['r'], isA<Uint8List>());
    final row = Map<String, dynamic>.from(foundChange.single);
    expect(row['r'], isA<Uint8List>());
    (flux['pubs'] as List).add(row['admitPub']);
    (flux['commits'] as List).add(row['commit']);
    final out = hiddenChangeNote(changeNanos - 100, Uint8List(20)..[0] = 4);
    expect(out, isNotNull);
    final spent = await ledger.spendFs1Notes(
      notes: [row],
      sealed: [out!],
      fee: 100,
      spendSeed: row['spendSeed'] as Uint8List,
      kind: 'send',
    );
    expect(spent.fs1.isNotEmpty, isTrue);
    expect(spent.fs1.first, 0xf1);
    expect(spent.vin, hasLength(1));
  }, timeout: const Timeout(Duration(minutes: 3)));
}

class _RestorePool extends ShearPoolClient {
  _RestorePool(this.flux)
      : super(
          baseUrl: 'http://127.0.0.1:9',
          http: HttpClient()..connectionTimeout = const Duration(milliseconds: 50),
        );

  final Map<String, dynamic> flux;

  @override
  Future<Map<String, dynamic>> fluxset() async => flux;
}

Uint8List destCommitOf(Uint8List seed) {
  final raw = destCommitFromSpendPub(ed25519PublicFromSeed(seed));
  return Uint8List.fromList(raw.sublist(0, 20));
}
