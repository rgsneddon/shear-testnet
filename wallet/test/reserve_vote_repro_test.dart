import 'dart:async';
import 'dart:io';
import 'dart:isolate';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_session.dart';

void main() {
  tearDown(() {
    debugReserveIsolateRuns = 0;
    debugReserveOffIsolateStamp = '';
    debugUiHeavyCount = 0;
  });

  test('4-coin lock waits on 9 confirmations', () async {
    final caller = reserveIsolateStamp;
    final book = await _lockedParts([4]);
    final lock = book.ledger.transactions.lastWhere((t) => t.kind == 'lock');
    expect(lock.amount, 4);
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

  test('several top-ups that sum past Pi wait on 9 confirmations', () async {
    final book = await _lockedParts([1.6, 1.7]);
    expect(book.reserve.portal(book.dest).canVote, isTrue);
    expect(book.ledger.transactions.where((t) => t.kind == 'lock').length, 2);
    final shown = await _vote(book, local: true);
    // ignore: avoid_print
    print('VOTE_WAIT_SUM $shown');
    expect(shown, kVoteConfirmWait);
    expect(book.reserve.votesIncrease, 0);
    expect(book.ledger.transactions.where((t) => t.kind == 'vote'), isEmpty);
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('under Pi sum is ineligible', () async {
    final book = await _lockedParts([1]);
    expect(book.reserve.portal(book.dest).canVote, isFalse);
    final shown = await _vote(book, local: true);
    // ignore: avoid_print
    print('VOTE_SHORT $shown');
    expect(shown, kVoteBelowPi);
    expect(book.reserve.votesIncrease, 0);
    expect(book.ledger.transactions.where((t) => t.kind == 'vote'), isEmpty);
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('one nano deposit is accepted and the vote stays ineligible', () async {
    final nano = 1 / kUnitsPerShe;
    final book = await _lockedParts([nano], fund: 1);
    expect(book.reserve.portal(book.dest).nanos, greaterThan(0));
    expect(book.reserve.portal(book.dest).nanos, lessThan(kPiSheNanos));
    final shown = await _vote(book, local: true);
    // ignore: avoid_print
    print('VOTE_NANO $shown');
    expect(shown, kVoteBelowPi);
    expect(book.reserve.votesIncrease, 0);
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('9 confirmations then the fee enact one vote', () async {
    final book = await _lockedParts([4]);
    _matureLock(book.ledger);
    final first = await _vote(book, local: true);
    // ignore: avoid_print
    print('VOTE_ENACT $first tally=${book.reserve.votesIncrease}');
    expect(first, 'Vote submitted — Your vote: increase bonus');
    expect(book.reserve.votesIncrease, 1);
    final second = await _vote(book, local: true);
    // ignore: avoid_print
    print('VOTE_SECOND $second tally=${book.reserve.votesIncrease}');
    expect(second, 'Vote already sealed for this epoch');
    expect(book.reserve.votesIncrease, 1);
    expect(book.ledger.transactions.where((t) => t.kind == 'vote').length, 1);
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
    final book = await _lockedParts([4]);
    expect(debugReserveIsolateRuns, greaterThan(0));
    expect(debugReserveOffIsolateStamp, isNot(caller));
    expect(debugReserveOffIsolateStamp, isNotEmpty);
    final lockRuns = debugReserveIsolateRuns;
    final lockStamp = debugReserveOffIsolateStamp;
    _matureLock(book.ledger);
    final remark = await _vote(book, local: true);
    expect(remark, 'Vote submitted — Your vote: increase bonus');
    expect(book.reserve.votesIncrease, 1);
    expect(debugReserveIsolateRuns, greaterThan(lockRuns));
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

  test('top-ups that reach Pi enact once after 9 confirmations', () async {
    final book = await _lockedParts([1.6, 1.6]);
    expect(book.reserve.portal(book.dest).canVote, isTrue);
    final early = await _vote(book, local: true);
    expect(early, kVoteConfirmWait);
    _matureLock(book.ledger);
    final dust = await postReserveDeposit(
      ledger: book.ledger,
      reserve: book.reserve,
      restFrame: book.id.address,
      paymentCode: book.id.paymentCode,
      dest: book.dest,
      she: 0.01,
      depth: 0,
      spendSeed: hexToBytes(book.id.seedHex),
      local: true,
    );
    expect(dust.posted, isTrue, reason: dust.remark);
    final held = await _vote(book, local: true);
    // ignore: avoid_print
    print('VOTE_TOPUP_HELD $held');
    expect(held, kVoteConfirmWait);
    expect(book.reserve.votesIncrease, 0);
    _matureLock(book.ledger);
    final first = await _vote(book, local: true);
    // ignore: avoid_print
    print('VOTE_TOPUP_ENACT $first tally=${book.reserve.votesIncrease}');
    expect(first, 'Vote submitted — Your vote: increase bonus');
    expect(book.reserve.votesIncrease, 1);
    final second = await _vote(book, local: true);
    expect(second, 'Vote already sealed for this epoch');
    expect(book.reserve.votesIncrease, 1);
  }, timeout: const Timeout(Duration(minutes: 2)));
}

class _Book {
  _Book(this.ledger, this.reserve, this.id, this.dest);
  final ShearLedger ledger;
  final ShearReserve reserve;
  final ShearIdentity id;
  final String dest;
}

Future<_Book> _lockedParts(List<double> parts, {double? fund}) async {
  final id = createIdentity();
  final reserve = ShearReserve();
  final ledger = ShearLedger()..bindIdentity(id);
  final from = ledger.allocateReceiveDest(id.address, paymentCode: id.paymentCode);
  final dest = vaultDest(id.address, viewKey: id.viewKey)!;
  final sum = parts.fold<double>(0, (a, b) => a + b);
  ledger.confirmRound(address: from, pot: fund ?? (sum + 4), height: 1);
  ledger.settleTo(1 + ShearLedger.spendableConfirmations);
  for (final she in parts) {
    final lock = await postReserveDeposit(
      ledger: ledger,
      reserve: reserve,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      dest: dest,
      she: she,
      depth: 0,
      spendSeed: hexToBytes(id.seedHex),
      local: true,
    );
    expect(lock.posted, isTrue, reason: lock.remark);
  }
  final locked = ledger.transactions.lastWhere((t) => t.kind == 'lock');
  expect(reserveLockConfirmations(ledger, locked), lessThan(ShearLedger.spendableConfirmations));
  return _Book(ledger, reserve, id, dest);
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
  final result = await commandReserveVote(
    ledger: book.ledger,
    reserve: book.reserve,
    restFrame: book.id.address,
    paymentCode: book.id.paymentCode,
    dest: book.dest,
    choice: kVoteIncrease,
    depth: 0,
    spendSeed: hexToBytes(book.id.seedHex),
    local: local,
  );
  return result.remark;
}
