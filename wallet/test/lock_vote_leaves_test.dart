import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ctf.dart' show vaultDest;
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_pack.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_vault_reward.dart' show consensusUnlockPeriod, vaultLockBlindBytes, vaultLockOwnerBytes;
import 'package:shear_wallet/shear_vote_plan.dart';
import 'package:shear_wallet/shear_withdraw.dart' show vaultLeafNote;

import 'support/sealed_book.dart';

// Russell's GO (28 Oct): a user may make unlimited separate exactly-π locks,
// each staking and voting in its own right. Every book here is real sealed
// notes; every lock is a real FS-1 π lock posted through postReserveDeposit;
// every vote is a real leaf vote (proof, FS-1 fee spend) posted to the pool
// double, which records the bodies.

class _Voter {
  _Voter(this.book, this.reserve, this.dest, this.planDir);
  final SealedBook book;
  final ShearReserve reserve;
  final String dest;
  final String planDir;
  ShearLedger get ledger => book.ledger;
  List<Map<String, dynamic>> get votes => [
        for (final b in book.pool.posts)
          if (b['kind'] == 'leaf-vote') b,
      ];
  List<Map<String, dynamic>> get locks => [
        for (final b in book.pool.posts)
          if (b['kind'] == 'lock') b,
      ];
}

/// [locks] 10 SHE notes (one per lock) and [fees] 1 SHE fee notes.
_Voter _voter({required int locks, required int fees}) {
  final book = SealedBook.fund([
    for (var i = 0; i < locks; i++) 10 * kUnitsPerShe,
    for (var i = 0; i < fees; i++) kUnitsPerShe,
  ]);
  final dest = vaultDest(book.id.address, viewKey: book.id.viewKey)!;
  final dir = Directory.systemTemp.createTempSync('shear-leaf-votes-');
  addTearDown(() {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
    book.pool.close();
  });
  return _Voter(book, ShearReserve()..currentEpoch = 1, dest, votePlanFolder(dir.path));
}

Future<ReserveDepositResult> _lockPi(_Voter v) => postReserveDeposit(
      ledger: v.ledger,
      reserve: v.reserve,
      restFrame: v.book.id.address,
      paymentCode: v.book.id.paymentCode,
      dest: v.dest,
      she: kPiSheNanos / kUnitsPerShe,
      depth: 0,
      spendSeed: v.book.seed,
      local: false,
      publicIpConsent: true,
    );

bool _live(_Voter v, List<int> commit) => v.book.pool.commits.any((c) {
      if (c.length != commit.length) return false;
      for (var i = 0; i < c.length; i++) {
        if (c[i] != commit[i]) return false;
      }
      return true;
    });

/// Everything posted so far is mined at the next height: the locks, and
/// every change output (lock change, vote change) enters the live note set.
/// The tip moves to [deep] confirmations of that height.
void _mineLocks(_Voter v, {int deep = 9}) {
  final h = v.ledger.sealedHeight + 1;
  for (final n in v.ledger.notes) {
    if ((n['kind'] ?? '').toString() == 'lock' || n['spent'] == true) continue;
    final c = n['commit'];
    final pub = n['admitPub'];
    if (c is! List<int> || pub is! List<int> || _live(v, c)) continue;
    v.book.pool.addLive(n, h);
  }
  v.ledger.confirmRound(address: 'other', pot: 0, height: h);
  final tip = h + deep - 1;
  v.ledger.noteLiveHeight(tip);
  v.ledger.settleTo(tip);
}

/// The node block body that commits this epoch's census.
void _census(_Voter v) {
  v.ledger.rememberNodeChain(bodies: [
    {
      'height': 2,
      'txs': [
        {
          'coinbase': true,
          'epochCensusCommit': [
            {'epoch': 1, 'leafCount': 1, 'openHeight': 2},
          ],
        },
      ],
    },
  ]);
}

Future<ReserveVoteResult> _vote(_Voter v, String choice) => castPlannedLeafVotes(
      ledger: v.ledger,
      reserve: v.reserve,
      planDir: v.planDir,
      dest: v.dest,
      choice: choice,
      restFrame: v.book.id.address,
      paymentCode: v.book.id.paymentCode,
      spendSeed: v.book.seed,
      local: false,
      publicIpConsent: true,
      random: Random(7),
    );

Uint8List _epochLeaf(Uint8List seed, int index, int epoch) {
  final ownerSeed = reservePortalSpendSeed(seed, index)!;
  final scalar = vaultLockOwnerBytes(ownerSeed, index);
  final blind = vaultLockBlindBytes(ownerSeed, index, kPiSheNanos, 0);
  return vaultLeafNote(
    amount: kPiSheNanos,
    scalar: scalar,
    blind: blind,
    unlock: consensusUnlockPeriod(epoch),
  );
}

String _hex32(List<int> bytes) {
  final out = StringBuffer();
  for (final b in bytes) {
    out.write(b.toRadixString(16).padLeft(2, '0'));
  }
  return out.toString();
}

Future<void> _lockN(_Voter v, int n) async {
  for (var i = 0; i < n; i++) {
    final r = await _lockPi(v);
    expect(r.posted, isTrue, reason: 'lock ${i + 1}: ${r.remark}');
  }
}

void main() {
  test('nine π leaves each cast their first vote at seq 1', () async {
    final v = _voter(locks: 9, fees: 9);
    await _lockN(v, 9);
    expect(v.locks, hasLength(9));
    _mineLocks(v);
    _census(v);
    final r = await _vote(v, kVoteIncrease);
    expect(r.enacted, isTrue, reason: r.remark);
    expect(v.votes, hasLength(9), reason: 'every leaf votes, not 8 of 9: ${r.remark}');
    expect(v.votes.map((b) => b['voteSeq']).toSet(), {1}, reason: 'a first vote is seq 1 for every leaf');
    final heights = [for (final b in v.votes) b['height'] as int]..sort();
    for (var i = 1; i < heights.length; i++) {
      expect(heights[i] - heights[i - 1], greaterThanOrEqualTo(voteMinSeparation), reason: 'one vote per slot');
    }
    expect(r.remark, 'Vote submitted — Your vote: $kVoteIncrease');
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('a leaf locked after the wallet voted still votes this epoch; the voted leaf is skipped', () async {
    final v = _voter(locks: 2, fees: 3);
    await _lockN(v, 1);
    _mineLocks(v);
    _census(v);
    final first = await _vote(v, kVoteHold);
    expect(first.enacted, isTrue, reason: first.remark);
    expect(v.votes, hasLength(1));
    var status = reserveLeafVoteStatus(ledger: v.ledger, reserve: v.reserve, planDir: v.planDir);
    expect((status.total, status.voted), (1, 1));
    await _lockN(v, 1);
    _mineLocks(v);
    status = reserveLeafVoteStatus(ledger: v.ledger, reserve: v.reserve, planDir: v.planDir);
    expect((status.total, status.voted), (2, 1), reason: 'the new leaf has not voted');
    final second = await _vote(v, kVoteHold);
    expect(second.enacted, isTrue, reason: second.remark);
    expect(v.votes, hasLength(2), reason: 'only the new leaf posts');
    expect(v.votes.map((b) => b['voteSeq']).toList(), [1, 1]);
    final again = await _vote(v, kVoteHold);
    expect(again.enacted, isFalse);
    expect(again.remark, 'Vote already sealed for this epoch');
    expect(v.votes, hasLength(2));
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('a re-vote with another choice is that leaf\'s seq + 1', () async {
    final v = _voter(locks: 1, fees: 2);
    await _lockN(v, 1);
    _mineLocks(v);
    _census(v);
    expect((await _vote(v, kVoteIncrease)).enacted, isTrue);
    final re = await _vote(v, kVoteDecrease);
    expect(re.enacted, isTrue, reason: re.remark);
    expect(v.votes.map((b) => b['voteSeq']).toList(), [1, 2]);
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('a young leaf waits while a confirmed leaf votes', () async {
    final v = _voter(locks: 2, fees: 2);
    await _lockN(v, 1);
    _mineLocks(v);
    _census(v);
    await _lockN(v, 1); // posted, not mined
    expect(reserveVoteGate(v.ledger, v.reserve, v.dest), isNull, reason: 'the confirmed leaf is not held back');
    final r = await _vote(v, kVoteIncrease);
    expect(r.enacted, isTrue, reason: r.remark);
    expect(v.votes, hasLength(1));
    expect(r.remark, contains('1 of 2 leaves wait on 9 confirmations'));
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('two locks at once never reuse the lock index or the inputs', () async {
    final v = _voter(locks: 2, fees: 0);
    final both = await Future.wait([_lockPi(v), _lockPi(v)]);
    expect(both.map((r) => r.posted).toList(), [true, true], reason: both.map((r) => r.remark).join(' | '));
    expect(v.locks, hasLength(2));
    final indexes = [
      for (final n in v.ledger.notes)
        if ((n['kind'] ?? '').toString() == 'lock' && n['lockIndex'] is int) n['lockIndex'] as int,
    ]..sort();
    expect(indexes, [0, 1], reason: 'the second lock takes the next index');
    final spends = [for (final b in v.locks) (b['admit_proofs'] as List).map((p) => '${(p as Map)['spendTag']}').join()];
    expect(spends[0], isNot(spends[1]), reason: 'the second lock spends other inputs');
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('with only change still confirming, the next lock says so and never "insufficient"', () async {
    final v = _voter(locks: 1, fees: 0);
    expect((await _lockPi(v)).posted, isTrue);
    expect(v.book.spendableUnits, 0, reason: 'the change is not Spendable until it confirms');
    expect(v.ledger.confirmingOwnChangeNanos(), greaterThan(BigInt.from(kPiSheNanos)));
    final next = await _lockPi(v);
    expect(next.posted, isFalse);
    expect(next.remark, kNextLockWhenChangeConfirms);
    expect(next.remark.toLowerCase(), isNot(contains('insufficient')));
    expect(next.remark, isNot(contains('Not enough')));
    expect(v.locks, hasLength(1), reason: 'nothing more was posted');
    expect(v.book.spendableUnits, 0, reason: 'Spendable is never painted from the confirming change');
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('the testnet window holds 96 one-per-slot votes; more are placed as far as they fit', () {
    const open = 2;
    final close = voteCloseHeightOf(open)!;
    final lo = open + voteEdgeBlocks;
    final hi = close - voteEdgeBlocks;
    expect(close - open, 3 * kVaultDayBlocks, reason: 'testnet: 4-day epoch, 1-day cutoff');
    final rng = Random(3);
    final all = fitVoteHeights(120, lo, hi, const [], rng);
    expect(all, hasLength((hi - lo) ~/ voteMinSeparation + 1));
    expect(all.length, 96);
    final sorted = [...all]..sort();
    expect(sorted.first, greaterThanOrEqualTo(lo));
    expect(sorted.last, lessThanOrEqualTo(hi));
    for (var i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1], greaterThanOrEqualTo(voteMinSeparation));
    }
    // With votes already in the window, new ones keep the slot spacing from them too.
    final taken = sorted.take(40).toList();
    final more = fitVoteHeights(100, lo, hi, taken, rng);
    final mixed = [...taken, ...more]..sort();
    for (var i = 1; i < mixed.length; i++) {
      expect(mixed[i] - mixed[i - 1], greaterThanOrEqualTo(voteMinSeparation));
    }
    expect(mixed.length, lessThanOrEqualTo(96));
  });

  test('more leaves than the window holds: as many vote as fit, and the rest are named', () async {
    final v = _voter(locks: 97, fees: 97);
    await _lockN(v, 97);
    _mineLocks(v);
    _census(v);
    final r = await _vote(v, kVoteHold);
    expect(r.enacted, isTrue, reason: r.remark);
    expect(v.votes, hasLength(96), reason: 'every slot of the window votes');
    expect(r.remark, contains(reserveLeavesUnvotedCopy(1, 97, kVoteSlotReason)));
    final status = reserveLeafVoteStatus(ledger: v.ledger, reserve: v.reserve, planDir: v.planDir);
    expect((status.total, status.voted), (97, 96));
  }, timeout: const Timeout(Duration(minutes: 40)));

  test('a vote fee\'s change still confirming says when the next lock is possible', () async {
    final v = _voter(locks: 1, fees: 0);
    await _lockN(v, 1);
    _mineLocks(v);
    // The mine puts the lock change in the live note set and moves the tip
    // nine deep. Spendable still requires a height on the note itself.
    final minedAt = v.ledger.bookTip - ShearLedger.spendableConfirmations + 1;
    var stamped = 0;
    for (final n in v.ledger.notes) {
      if (n['spent'] == true || n['changeSeed'] == null) continue;
      if ((n['kind'] ?? '').toString() == 'lock') continue;
      if (n['height'] != null) continue;
      n['height'] = minedAt;
      stamped++;
    }
    expect(stamped, 1, reason: 'the lock change is the only fee note');
    _census(v);
    expect(v.book.spendableUnits, greaterThan(kPiSheNanos));
    expect((await _vote(v, kVoteHold)).enacted, isTrue);
    expect(v.book.spendableUnits, 0, reason: 'the vote change is not Spendable until it confirms');
    expect(v.ledger.confirmingOwnChangeNanos(), greaterThan(BigInt.from(kPiSheNanos)));
    final next = await _lockPi(v);
    expect(next.posted, isFalse);
    expect(next.remark, kNextLockWhenChangeConfirms);
    expect(next.remark.toLowerCase(), isNot(contains('insufficient')));
    expect(next.remark, isNot(contains('Not enough')));
    expect(v.book.spendableUnits, 0, reason: 'Spendable is never painted from the confirming vote change');
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('a chain leaf is not held back by a new lock that is still unmined', () async {
    final v = _voter(locks: 1, fees: 1);
    final portal = reservePortalIdFromSeed('', v.book.seed, 0);
    expect(portal, isNotNull);
    v.ledger.rememberDerivedLockLeaves([
      {'portalId': portal, 'epoch': 1, 'commit': ''},
    ]);
    expect(
      v.ledger.notes.where((n) => (n['kind'] ?? '').toString() == 'lock' && n['lockTxId'] == null),
      isNotEmpty,
      reason: 'the chain leaf is on the book with no lock tx',
    );
    final err = v.reserve.deposit(
      dest: v.dest,
      she: kPiSheNanos / kUnitsPerShe,
      nowMs: DateTime.now().millisecondsSinceEpoch,
      payout: v.book.from,
      lockIndex: 0,
    );
    expect(err, isNull, reason: 'the chain leaf is already staked');
    await _lockN(v, 1);
    expect(reserveVoteGate(v.ledger, v.reserve, v.dest), isNull, reason: 'the chain leaf is not held for the new lock');
    v.ledger.rememberNodeChain(bodies: [
      {
        'height': 2,
        'txs': [
          {
            'coinbase': true,
            'epochCensusCommit': [
              {'epoch': 1, 'leafCount': 2, 'openHeight': 2},
            ],
          },
        ],
      },
    ]);
    final r = await _vote(v, kVoteHold);
    expect(r.enacted, isTrue, reason: r.remark);
    expect(v.votes, hasLength(1), reason: 'the chain leaf voted');
    expect(r.remark, contains('1 of 2 leaves wait on 9 confirmations'));
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('a tranche with no commit restores that epoch\'s leaf, not epoch 0', () {
    for (final commit in <Object?>['', null]) {
      final v = _voter(locks: 0, fees: 0);
      final portal = reservePortalIdFromSeed('', v.book.seed, 0);
      expect(portal, isNotNull);
      final row = <String, dynamic>{'portalId': portal, 'epoch': 1};
      if (commit != null) row['commit'] = commit;
      v.ledger.rememberDerivedLockLeaves([row]);
      final locks = [
        for (final n in v.ledger.notes)
          if ((n['kind'] ?? '').toString() == 'lock') n,
      ];
      expect(locks, hasLength(1), reason: 'commit $commit still restores the leaf');
      expect(locks.single['lockEpoch'], 1, reason: 'commit $commit keeps the tranche epoch');
      expect(locks.single['unlock'], consensusUnlockPeriod(1));
      expect(locks.single['note'], _epochLeaf(v.book.seed, 0, 1));
    }
  });

  test('a later tranche commit replaces a leaf that is not that commit', () {
    final v = _voter(locks: 0, fees: 0);
    final portal = reservePortalIdFromSeed('', v.book.seed, 0)!;
    final ownerSeed = reservePortalSpendSeed(v.book.seed, 0)!;
    final wrong = _epochLeaf(v.book.seed, 0, 0);
    v.ledger.rememberNote({
      'kind': 'lock',
      'scalar': vaultLockOwnerBytes(ownerSeed, 0),
      'blind': vaultLockBlindBytes(ownerSeed, 0, kPiSheNanos, 0),
      'note': wrong,
      'unlock': consensusUnlockPeriod(0),
      'amount': kPiSheNanos,
      'nanos': kPiSheNanos,
      'epochs': <int>[0],
      'lockEpoch': 0,
      'lockIndex': 0,
      'portalId': portal,
      'vaultLock': true,
      'verified': true,
    });
    final right = _epochLeaf(v.book.seed, 0, 1);
    v.ledger.rememberDerivedLockLeaves([
      {'portalId': portal, 'epoch': 1, 'commit': _hex32(right.sublist(32))},
    ]);
    final locks = [
      for (final n in v.ledger.notes)
        if ((n['kind'] ?? '').toString() == 'lock') n,
    ];
    expect(locks, hasLength(1), reason: 'the wrong leaf is replaced, not kept beside the right one');
    expect(locks.single['lockEpoch'], 1);
    expect(locks.single['note'], right);
  });
}
