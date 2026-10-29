import 'dart:async';
import 'dart:io';
import 'dart:isolate';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_levy.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_session.dart';

import 'support/sealed_book.dart';

// A Vault lock is exactly one π leaf (Russell, 25 Oct 14:20, Corrections 1):
// a deposit of any other amount is refused in the wallet before anything is
// posted, so there are no top-ups that sum to π. Every book here is funded
// from one real sealed 10 SHE note mined 9 deep, never from a round credit or
// a pool figure, and a π lock posts a real FS-1 lock body.
void main() {
  tearDown(() {
    debugReserveIsolateRuns = 0;
    debugReserveOffIsolateStamp = '';
    debugUiHeavyCount = 0;
  });

  test('a π lock from a 10 SHE note waits on 9 confirmations', () async {
    final caller = reserveIsolateStamp;
    final book = await _lockedPi();
    final lock = book.ledger.transactions.lastWhere((t) => t.kind == 'lock');
    expect((lock.amount * kUnitsPerShe).round(), kPiSheNanos);
    expect(
      reserveLockConfirmations(book.ledger, lock),
      lessThan(ShearLedger.spendableConfirmations),
    );
    expect(debugReserveIsolateRuns, greaterThan(0));
    expect(debugReserveOffIsolateStamp, isNot(caller));
    expect(debugUiHeavyCount, 0);
    final shown = await _vote(book, local: true);
    // ignore: avoid_print
    print(
      'VOTE_WAIT $shown lockStamp=$debugReserveOffIsolateStamp caller=$caller runs=$debugReserveIsolateRuns uiHeavy=$debugUiHeavyCount',
    );
    expect(shown, kVoteConfirmWait);
    expect(shown.toLowerCase().contains('insuff'), isFalse);
    expect(book.reserve.votesIncrease, 0);
    expect(book.ledger.transactions.where((t) => t.kind == 'vote'), isEmpty);
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('top-ups below π are refused before posting, so they never sum to a vote', () async {
    final book = _funded();
    for (final she in [1.6, 1.7]) {
      final r = await _deposit(book, she);
      expect(r.posted, isFalse, reason: '$she SHE');
      expect(r.remark, kLockBelowPi, reason: '$she SHE');
    }
    expect(book.pool.posts, isEmpty, reason: 'nothing reached the pool');
    expect(book.ledger.transactions.where((t) => t.kind == 'lock'), isEmpty);
    expect(book.reserve.portal(book.dest).canVote, isFalse);
    expect(book.spendableUnits, 10 * kUnitsPerShe, reason: 'the note stays Spendable');
    final shown = await _vote(book, local: true);
    // ignore: avoid_print
    print('VOTE_TOPUPS_REFUSED $shown');
    expect(shown, kVoteBelowPi);
    expect(book.reserve.votesIncrease, 0);
    expect(book.ledger.transactions.where((t) => t.kind == 'vote'), isEmpty);
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('a 1 SHE deposit is refused and the vote is ineligible below π', () async {
    final book = _funded();
    final r = await _deposit(book, 1);
    expect(r.posted, isFalse);
    expect(r.remark, kLockBelowPi);
    expect(book.pool.posts, isEmpty);
    expect(book.reserve.portal(book.dest).canVote, isFalse);
    final shown = await _vote(book, local: true);
    // ignore: avoid_print
    print('VOTE_SHORT $shown');
    expect(shown, kVoteBelowPi);
    expect(book.reserve.votesIncrease, 0);
    expect(book.ledger.transactions.where((t) => t.kind == 'vote'), isEmpty);
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('a one-nano deposit is refused and the vote stays ineligible', () async {
    final book = _funded();
    final r = await _deposit(book, 1 / kUnitsPerShe);
    expect(r.posted, isFalse);
    expect(r.remark, kLockBelowPi);
    expect(book.pool.posts, isEmpty);
    expect(book.reserve.portal(book.dest).nanos, 0);
    final shown = await _vote(book, local: true);
    // ignore: avoid_print
    print('VOTE_NANO $shown');
    expect(shown, kVoteBelowPi);
    expect(book.reserve.votesIncrease, 0);
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('a deposit above π (4 SHE, π + 1 nano, 2π) is refused with the one-π sentence and posts nothing', () async {
    final book = _funded();
    for (final she in [4.0, (kPiSheNanos + 1) / kUnitsPerShe, 2 * kPiSheNanos / kUnitsPerShe]) {
      final r = await _deposit(book, she);
      expect(r.posted, isFalse, reason: '$she SHE');
      expect(r.remark, kErrLockAmount, reason: '$she SHE');
    }
    expect(book.pool.posts, isEmpty);
    expect(book.ledger.transactions.where((t) => t.kind == 'lock'), isEmpty);
    expect(book.spendableUnits, 10 * kUnitsPerShe);
    // The same book, the same path, exactly π: one real FS-1 lock body posts,
    // so the refusals above are the amount law and not a dead path.
    final ok = await _deposit(book, kPiSheNanos / kUnitsPerShe);
    expect(ok.posted, isTrue, reason: ok.remark);
    expect(book.pool.posts, hasLength(1));
    expect(book.pool.posts.single['kind'], 'lock');
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('a π lock at 9 confirmations with no census enacts no vote', () async {
    final book = await _lockedPi();
    _matureLock(book.ledger);
    // Current law: no synced census fails closed. The vote is not enacted
    // and no portal vote is posted.
    final first = await _vote(book, local: true);
    // ignore: avoid_print
    print('VOTE_ENACT $first tally=${book.reserve.votesIncrease}');
    expect(first, 'You’re not eligible to vote from this portal this epoch');
    expect(book.reserve.votesIncrease, 0);
    final second = await _vote(book, local: true);
    // ignore: avoid_print
    print('VOTE_SECOND $second tally=${book.reserve.votesIncrease}');
    expect(second, 'You’re not eligible to vote from this portal this epoch');
    expect(book.reserve.votesIncrease, 0);
    expect(book.ledger.transactions.where((t) => t.kind == 'vote').length, 0);
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('lock and vote run off the UI isolate', () async {
    final ledgerSrc = File('lib/shear_ledger.dart').readAsStringSync();
    final start = ledgerSrc.indexOf('Future<Map<String, dynamic>> _reserveSealOffUi');
    expect(start, greaterThan(0));
    final end = ledgerSrc.indexOf('\n}', start);
    final body = ledgerSrc.substring(start, end);
    expect(body, contains('Isolate.run(() => sealSignReserveWire(input))'));
    expect(body.contains('sealFlowOnCaller'), isFalse);
    expect(body.contains('debugNative'), isFalse);
    expect(body.contains('Future<Map<String, dynamic>>.value(sealSignReserveWire'), isFalse);
    final caller = reserveIsolateStamp;
    final book = await _lockedPi();
    expect(debugReserveIsolateRuns, greaterThan(0));
    expect(debugReserveOffIsolateStamp, isNot(caller));
    expect(debugReserveOffIsolateStamp, isNotEmpty);
    final lockRuns = debugReserveIsolateRuns;
    final lockStamp = debugReserveOffIsolateStamp;
    _matureLock(book.ledger);
    final remark = await _vote(book, local: true);
    // Current law: the leaf vote does not seal on the lock isolate. No census
    // means not_voter, and the isolate run count stays at the lock.
    expect(remark, 'You’re not eligible to vote from this portal this epoch');
    expect(book.reserve.votesIncrease, 0);
    expect(debugReserveIsolateRuns, lockRuns);
    expect(debugReserveOffIsolateStamp, isNot(caller));
    expect(debugUiHeavyCount, 0);
    // ignore: avoid_print
    print(
      'VOTE_OFF_UI remark=$remark caller=$caller lockStamp=$lockStamp voteStamp=$debugReserveOffIsolateStamp runs=$debugReserveIsolateRuns uiHeavy=$debugUiHeavyCount',
    );
    final launch = await _desktopLaunchAttempt();
    // ignore: avoid_print
    print(launch);
    expect(launch.contains('not-started'), isFalse);
    expect(launch.startsWith('DESKTOP_LAUNCH hung'), isFalse);
  }, timeout: const Timeout(Duration(minutes: 2)));

  testWidgets('cold unlock hydrates the archive off the UI isolate', (tester) async {
    final caller = identityHashCode(Isolate.current).toString();
    final dir = Directory.systemTemp.createTempSync('shear-cold-unlock-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final store = File('${dir.path}${Platform.pathSeparator}session.json');
    final session = ShearSession(store: store);
    await tester.runAsync(() async {
      await session.loadOrCreate();
      final dest = session.identity!.address;
      session.rememberedTxs = <Map<String, dynamic>>[
        for (var i = 0; i < 15000; i++)
          <String, dynamic>{
            'id': 'h$i',
            'from': '',
            'to': dest,
            'kind': 'coinbase',
            'height': 1,
            'nanos': 1000000000,
            'confirmed': true,
          },
      ];
      session.rememberedSealedHeight = 4;
      await session.setPassword('test-pass-1');
    });
    final cold = ShearSession(store: store);
    await tester.pumpWidget(ShearWalletApp(
      session: cold,
      ledger: ShearLedger(),
      skipPoolSync: true,
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('Unlock'), findsOneWidget);
    await tester.enterText(find.byType(TextField).first, 'test-pass-1');
    await tester.pump();
    final state = tester.state<ShearWalletAppState>(find.byType(ShearWalletApp));
    var during = 0;
    await tester.runAsync(() async {
      final timer = Timer.periodic(const Duration(milliseconds: 1), (_) {
        if (debugArchiveHydrateScheduled && !state.unlocked) during++;
      });
      await state.unlockNow();
      timer.cancel();
    });
    await tester.pump();
    expect(state.unlocked, isTrue);
    expect(during, greaterThan(0));
    expect(debugArchiveHydrateStamp, isNotEmpty);
    expect(debugArchiveHydrateStamp, isNot(caller));
    expect(state.ledger.transactions, hasLength(15000));
    final row = state.ledger.transactions.first;
    expect(row.id, 'h0');
    expect(row.from, 'coinbase');
    expect(row.amount, closeTo(0.01, 1e-12));
    expect(find.text('Unlock'), findsNothing);
    // ignore: avoid_print
    print(
      'COLD_UNLOCK during=$during stamp=$debugArchiveHydrateStamp caller=$caller txs=${state.ledger.transactions.length} unlocked=${state.unlocked} responsive=True',
    );
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('a π lock votes only after 9 confirmations, and a later top-up is refused', () async {
    final book = await _lockedPi();
    expect(book.reserve.portal(book.dest).canVote, isTrue);
    final early = await _vote(book, local: true);
    expect(early, kVoteConfirmWait);
    _matureLock(book.ledger);
    final posted = book.pool.posts.length;
    final dust = await _deposit(book, 0.01);
    expect(dust.posted, isFalse, reason: 'a top-up is not a lock');
    expect(dust.remark, kLockBelowPi);
    expect(book.pool.posts.length, posted, reason: 'the refused top-up posted nothing');
    final first = await _vote(book, local: true);
    // ignore: avoid_print
    print('VOTE_TOPUP_ENACT $first tally=${book.reserve.votesIncrease}');
    // Current law: matured locks still need a census row. No census is not_voter.
    expect(first, 'You’re not eligible to vote from this portal this epoch');
    expect(book.reserve.votesIncrease, 0);
    final second = await _vote(book, local: true);
    expect(second, 'You’re not eligible to vote from this portal this epoch');
    expect(book.reserve.votesIncrease, 0);
  }, timeout: const Timeout(Duration(minutes: 2)));
}

const kLockBelowPi = 'A lock is one π. Amounts below π stay spendable.';

class _Book {
  _Book(this.sealed, this.reserve, this.dest);
  final SealedBook sealed;
  final ShearReserve reserve;
  final String dest;
  ShearLedger get ledger => sealed.ledger;
  SealedNotePool get pool => sealed.pool;
  ShearIdentity get id => sealed.id;
  int get spendableUnits => sealed.spendableUnits;
}

/// One real sealed 10 SHE note, mined 9 deep: Spendable is exactly that note.
_Book _funded() {
  final sealed = SealedBook.fund([10 * kUnitsPerShe]);
  expect(sealed.spendableUnits, 10 * kUnitsPerShe);
  final dest = vaultDest(sealed.id.address, viewKey: sealed.id.viewKey)!;
  return _Book(sealed, ShearReserve(), dest);
}

/// [local] true is the book-only lock this file has always used (no pool
/// post; the seal still runs off the UI isolate). A refused amount is tried
/// with local false and consent, so a missing refusal would reach the pool.
Future<ReserveDepositResult> _deposit(_Book book, double she, {bool local = false}) => postReserveDeposit(
      ledger: book.ledger,
      reserve: book.reserve,
      restFrame: book.id.address,
      paymentCode: book.id.paymentCode,
      dest: book.dest,
      she: she,
      depth: 0,
      spendSeed: book.sealed.seed,
      local: local,
      publicIpConsent: !local,
    );

/// A π lock, not yet mined: the real FS-1 lock body reached the pool.
Future<_Book> _lockedPi() async {
  final book = _funded();
  final lock = await _deposit(book, kPiSheNanos / kUnitsPerShe, local: true);
  expect(lock.posted, isTrue, reason: lock.remark);
  // The π and its levy came off the one note; the rest is its change.
  expect(book.spendableUnits, lessThanOrEqualTo(10 * kUnitsPerShe - kPiSheNanos - levyNanos(kPiSheNanos, depth: 0)));
  final locked = book.ledger.transactions.lastWhere((t) => t.kind == 'lock');
  expect(reserveLockConfirmations(book.ledger, locked), lessThan(ShearLedger.spendableConfirmations));
  return book;
}

void _matureLock(ShearLedger ledger) {
  final h = ledger.sealedHeight + 1;
  ledger.confirmRound(address: 'other', pot: 0, height: h);
  ledger.settleTo(h + ShearLedger.spendableConfirmations - 1);
  final locked = ledger.transactions.lastWhere((t) => t.kind == 'lock');
  expect(reserveLockConfirmations(ledger, locked), greaterThanOrEqualTo(ShearLedger.spendableConfirmations));
}

/// Start the built Windows wallet. A missing exe or an immediate exit is the
/// launcher failure. A process that stays up and stops pumping frames is a hung
/// launch and fails the test. The process is killed either way.
Future<String> _desktopLaunchAttempt() async {
  final exe = File('build/windows/x64/runner/Release/shear_wallet.exe');
  if (!exe.existsSync()) {
    return 'DESKTOP_LAUNCH failed missing-exe ${exe.path}';
  }
  Process proc;
  try {
    proc = await Process.start(exe.path, const <String>[]);
  } catch (e) {
    return 'DESKTOP_LAUNCH failed $e';
  }
  final err = StringBuffer();
  proc.stderr.listen((b) => err.write(String.fromCharCodes(b)));
  try {
    final code = await proc.exitCode.timeout(const Duration(seconds: 5), onTimeout: () => -1);
    if (code != -1) {
      final detail = err.toString().trim();
      return 'DESKTOP_LAUNCH failed exit=$code ${detail.isEmpty ? 'no-stderr' : detail}';
    }
    final probe = await Process.run('powershell', <String>[
      '-NoProfile',
      '-Command',
      '(Get-Process -Id ${proc.pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Responding)',
    ]);
    final responding = probe.stdout.toString().trim();
    if (responding != 'True') {
      return 'DESKTOP_LAUNCH hung pid=${proc.pid} responding=$responding';
    }
    return 'DESKTOP_LAUNCH started pid=${proc.pid} responding=True';
  } finally {
    proc.kill();
    await Process.run('taskkill', <String>['/F', '/T', '/PID', '${proc.pid}']);
  }
}

Future<String> _vote(_Book book, {required bool local}) async {
  final result = await castPlannedLeafVotes(
    ledger: book.ledger,
    reserve: book.reserve,
    planDir: '',
    restFrame: book.id.address,
    paymentCode: book.id.paymentCode,
    dest: book.dest,
    choice: kVoteIncrease,
    spendSeed: book.sealed.seed,
    local: local,
  );
  return result.remark;
}
