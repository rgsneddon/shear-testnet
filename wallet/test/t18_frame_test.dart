import 'dart:async';
import 'dart:io';
import 'dart:isolate';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_session.dart';

/// Progress and Cancel while a send is in flight. The crypto isolate stamps
/// are [t18_off_ui_test.dart]. This file checks the window still draws for
/// the whole hold, and that a send book stays inside a memory ceiling.

/// A send turn may cost one idle frame plus this slack. 50 ms is about three
/// vsyncs past the app's own frame. A longer steady turn has stopped the window.
const Duration kSendFrameSlack = Duration(milliseconds: 50);

/// The amount field and the first send rebuild may hitch once. A one-note
/// entry already costs about a fifth of a second in this harness. 400 ms is
/// the stop line for that turn. Later frames use [kSendFrameSlack].
const Duration kSendEntryHitch = Duration(milliseconds: 400);

/// The first frame, and the hold's frames, must return inside this. A longer
/// wait is a hang, not a slow paint.
const Duration kSendFrameHang = Duration(seconds: 15);

/// How many paints the hold must draw. One paint is the old peek. This is a
/// run of frames while Cancel is still up.
const int kSendHoldFrames = 8;

/// Resident-set ceiling for one remembered note, plus a fixed allocator pad.
/// A planner row is a handful of fields. 8 KiB is the leak line.
const int kSendNoteRssCeiling = 8 * 1024;
const int kSendRssNoiseCeiling = 8 * 1024 * 1024;

void main() {
  testWidgets('Flow send shows progress and Cancel and still draws a frame', (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final dir = Directory.systemTemp.createTempSync('t18-frame-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    final ident = session.identity!;
    final pool = _HoldSendPool();
    addTearDown(pool.close);
    final ledger = ShearLedger(pool: pool)..bindIdentity(ident);
    ledger.viewSecret = ident.viewKey;
    ledger.confirmRound(address: ident.address, pot: 2, height: 2);
    ledger.settleTo(2 + ShearLedger.spendableConfirmations);
    final bobId = createIdentity();
    final bob = (ShearLedger()..bindIdentity(bobId)).homeDest(bobId.address, paymentCode: bobId.paymentCode);

    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ledger,
      startUnlocked: true,
      skipPoolSync: true,
    ));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Flow'));
    await tester.pump();
    await tester.enterText(find.widgetWithText(TextField, 'To (she1, ssa1, or shear1)'), bob);
    await tester.enterText(find.byKey(const Key('flow-amount')), '0.2');
    await tester.tap(find.byKey(const Key('flow-send')));
    await tester.pump();

    expect(find.byKey(const Key('flow-send-progress')), findsOneWidget);
    expect(find.byKey(const Key('flow-send-cancel')), findsOneWidget);
    final label = tester.widget<Text>(find.byKey(const Key('flow-send-progress'))).data ?? '';
    expect(label, isNotEmpty);
    expect(
      label.contains('Selecting') || label.contains('Building proof') || label.contains('Broadcasting'),
      isTrue,
      reason: label,
    );
    expect(tester.widget<FilledButton>(find.byKey(const Key('flow-send'))).onPressed, isNull);

    var drew = false;
    tester.binding.addPostFrameCallback((_) => drew = true);
    await tester.pump();
    expect(drew, isTrue);
    expect(find.byKey(const Key('flow-send-cancel')), findsOneWidget);
    expect(tester.takeException(), isNull);

    final state = tester.state<ShearWalletAppState>(find.byType(ShearWalletApp));
    expect(state.debugFlowSending, isTrue);
    await tester.tap(find.byKey(const Key('flow-send-cancel')));
    await tester.pump();
    expect(state.debugFlowProgress, isNotNull);
    expect(state.debugFlowProgress!.cancelRequested, isTrue);
    expect(state.debugFlowSending, isTrue);

    if (!pool.gate.isCompleted) {
      pool.gate.complete(<String, dynamic>{'ok': false, 'reason': 'held'});
    }
    final deadline = DateTime.now().add(const Duration(seconds: 20));
    while (state.debugFlowSending && DateTime.now().isBefore(deadline)) {
      await tester.pump();
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
    }
    expect(state.debugFlowSending, isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Flow send draws the whole hold inside the idle frame budget', (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final counts = <int>[
      1,
      3,
      kMaxInputsPerSend - 1,
      kMaxInputsPerSend,
      kMaxInputsPerSend + 1,
      2000,
    ];
    final typeUsByCount = <int, int>{};
    final firstUsByCount = <int, int>{};
    for (final count in counts) {
      final dir = Directory.systemTemp.createTempSync('t18-frame-hold-');
      addTearDown(() {
        if (dir.existsSync()) dir.deleteSync(recursive: true);
      });
      final session = ShearSession(store: File('${dir.path}/session.json'));
      await tester.runAsync(() async {
        await session.loadOrCreate();
        await session.setPassword('test-pass-1');
      });
      final ident = session.identity!;
      final pool = _HoldSendPool();
      addTearDown(pool.close);
      final ledger = ShearLedger(pool: pool)..bindIdentity(ident);
      ledger.viewSecret = ident.viewKey;
      final rssBefore = ProcessInfo.currentRss;
      _rememberUnsealed(ledger, ident, count);
      final rssNotes = ProcessInfo.currentRss;
      ledger.confirmRound(address: ident.address, pot: 2, height: 2);
      ledger.settleTo(2 + ShearLedger.spendableConfirmations);
      final memo = count.isOdd;

      final cold = Stopwatch()..start();
      await tester.pumpWidget(ShearWalletApp(
        session: session,
        ledger: ledger,
        startUnlocked: true,
        skipPoolSync: true,
      ));
      await tester.pump();
      cold.stop();
      expect(
        cold.elapsed < kSendFrameHang,
        isTrue,
        reason: 'cold notes=$count ms=${cold.elapsedMilliseconds}',
      );
      await tester.tap(find.text('Flow'));
      await tester.pump();

      final idle = <int>[];
      for (var i = 0; i < 4; i++) {
        idle.add(await _timedPump(tester));
      }
      final idleMax = idle.reduce((a, b) => a > b ? a : b);
      final budgetUs = idleMax + kSendFrameSlack.inMicroseconds;

      final bobId = createIdentity();
      final bob = (ShearLedger()..bindIdentity(bobId)).homeDest(bobId.address, paymentCode: bobId.paymentCode);
      await tester.enterText(find.widgetWithText(TextField, 'To (she1, ssa1, or shear1)'), bob);
      final typed = Stopwatch()..start();
      await tester.enterText(find.byKey(const Key('flow-amount')), '0.2');
      if (memo) {
        await tester.enterText(find.widgetWithText(TextField, 'Memo (optional)'), 'note');
      }
      typed.stop();
      final sent = Stopwatch()..start();
      await tester.tap(find.byKey(const Key('flow-send')));
      sent.stop();

      final hold = <int>[];
      final deadline = DateTime.now().add(kSendFrameHang);
      while (hold.length < kSendHoldFrames && DateTime.now().isBefore(deadline)) {
        final state = tester.state<ShearWalletAppState>(find.byType(ShearWalletApp));
        expect(
          state.debugFlowSending,
          isTrue,
          reason: 'send ended after ${hold.length} frames notes=$count',
        );
        var drew = false;
        tester.binding.addPostFrameCallback((_) => drew = true);
        final us = await _timedPump(tester);
        expect(drew, isTrue, reason: 'notes=$count frame=${hold.length}');
        expect(tester.takeException(), isNull);
        expect(find.byKey(const Key('flow-send-progress')), findsOneWidget);
        expect(find.byKey(const Key('flow-send-cancel')), findsOneWidget);
        expect(tester.widget<FilledButton>(find.byKey(const Key('flow-send'))).onPressed, isNull);
        hold.add(us);
      }
      expect(
        hold.length,
        kSendHoldFrames,
        reason: 'notes=$count drew ${hold.length} before ${kSendFrameHang.inSeconds}s',
      );

      typeUsByCount[count] = typed.elapsedMicroseconds;
      firstUsByCount[count] = hold.first;
      // ignore: avoid_print
      print(
        'T18_FRAME notes=$count memo=$memo coldMs=${cold.elapsedMilliseconds} '
        'rssBefore=$rssBefore rssNotes=$rssNotes idleUs=$idle '
        'typeUs=${typed.elapsedMicroseconds} tapUs=${sent.elapsedMicroseconds} '
        'holdUs=$hold budgetUs=$budgetUs',
      );
      final hitchUs = kSendEntryHitch.inMicroseconds;
      expect(typed.elapsedMicroseconds <= hitchUs, isTrue, reason: 'type notes=$count');
      expect(sent.elapsedMicroseconds <= hitchUs, isTrue, reason: 'tap notes=$count');
      expect(hold.first <= hitchUs, isTrue, reason: 'first frame notes=$count us=${hold.first}');
      for (var i = 1; i < hold.length; i++) {
        expect(
          hold[i] <= budgetUs,
          isTrue,
          reason: 'frame $i notes=$count us=${hold[i]} budget=$budgetUs',
        );
      }

      final state = tester.state<ShearWalletAppState>(find.byType(ShearWalletApp));
      await tester.tap(find.byKey(const Key('flow-send-cancel')));
      await tester.pump();
      expect(state.debugFlowProgress, isNotNull);
      expect(state.debugFlowProgress!.cancelRequested, isTrue);
      if (!pool.gate.isCompleted) {
        pool.gate.complete(<String, dynamic>{'ok': false, 'reason': 'held'});
      }
      final end = DateTime.now().add(const Duration(seconds: 20));
      while (state.debugFlowSending && DateTime.now().isBefore(end)) {
        await tester.pump();
        await tester.runAsync(() async {
          await Future<void>.delayed(const Duration(milliseconds: 20));
        });
      }
      expect(state.debugFlowSending, isFalse, reason: 'notes=$count');
      expect(tester.takeException(), isNull);
    }
    final typeAdded = typeUsByCount[2000]! - typeUsByCount[1]!;
    final firstAdded = firstUsByCount[2000]! - firstUsByCount[1]!;
    // ignore: avoid_print
    print('T18_FRAME spread typeAddedUs=$typeAdded firstAddedUs=$firstAdded');
    final slack = kSendFrameSlack.inMicroseconds;
    expect(typeAdded <= slack, isTrue, reason: 'typing 2000 notes added $typeAdded us');
    expect(firstAdded <= slack, isTrue, reason: 'first frame at 2000 notes added $firstAdded us');
  }, timeout: const Timeout(Duration(minutes: 3)));

  test('a send book stays inside a per-note memory ceiling', () async {
    final counts = <int>[
      1,
      3,
      kMaxInputsPerSend - 1,
      kMaxInputsPerSend,
      kMaxInputsPerSend + 1,
      2000,
    ];
    final ui = identityHashCode(Isolate.current).toString();
    for (final count in counts) {
      for (final memo in [false, true]) {
        final ident = createIdentity();
        final ledger = ShearLedger()..bindIdentity(ident);
        final before = ProcessInfo.currentRss;
        final sw = Stopwatch()..start();
        _rememberUnsealed(ledger, ident, count);
        await ledger.quoteSendLevyUnits(
          restFrame: ident.address,
          paymentCode: ident.paymentCode,
          amount: 0.5,
          memo: memo,
        );
        sw.stop();
        final after = ProcessInfo.currentRss;
        final growth = after - before;
        final ceiling = count * kSendNoteRssCeiling + kSendRssNoiseCeiling;
        // ignore: avoid_print
        print(
          'T18_RSS notes=$count memo=$memo ms=${sw.elapsedMilliseconds} '
          'rssBefore=$before rssAfter=$after growth=$growth ceiling=$ceiling '
          'stamp=$debugSendSelectStamp',
        );
        expect(sw.elapsed < kSendFrameHang, isTrue, reason: 'notes=$count memo=$memo');
        expect(growth <= ceiling, isTrue, reason: 'notes=$count memo=$memo growth=$growth');
        expect(debugSendSelectStamp, isNotEmpty);
        expect(debugSendSelectStamp, isNot(ui), reason: 'selection ran on the caller');
      }
    }
  }, timeout: const Timeout(Duration(minutes: 2)));
}

String _nanosFor(int i) {
  if (i % 11 == 0) return '9007199254740993';
  if (i % 7 == 0) return '1';
  return (BigInt.from(i + 1) * BigInt.from(100000000000)).toString();
}

void _rememberUnsealed(ShearLedger ledger, ShearIdentity ident, int count) {
  final dest = ledger.currentDest(ident.address, paymentCode: ident.paymentCode);
  for (var i = 0; i < count; i++) {
    ledger.rememberNote(<String, dynamic>{
      'address': dest,
      'dest': dest,
      'height': 1,
      'nanos': _nanosFor(i),
      'spent': false,
    });
  }
}

Future<int> _timedPump(WidgetTester tester) async {
  final sw = Stopwatch()..start();
  await tester.pump();
  sw.stop();
  return sw.elapsedMicroseconds;
}

class _HoldSendPool extends ShearPoolClient {
  _HoldSendPool()
      : super(
          baseUrl: 'http://127.0.0.1:9',
          http: HttpClient()..connectionTimeout = const Duration(milliseconds: 200),
        );

  final Completer<Map<String, dynamic>> gate = Completer<Map<String, dynamic>>();

  @override
  Future<Map<String, dynamic>> send({
    required String from,
    required String to,
    required double amount,
    Map<String, dynamic>? memoCt,
    String? open,
    String? sig,
    String? portalOpen,
    String? kind,
    String? programId,
    String? choice,
    int? currentEpoch,
    int? epochStartMs,
    String? change,
    String? spendPub,
    String? ephPub,
    List<dynamic>? vin,
    List<dynamic>? vout,
    dynamic excess,
    Map<String, dynamic>? admitProof,
    List<Map<String, dynamic>>? admitProofs,
    String? spendTag,
    int? fee,
    int paintedOwedNanos = 0,
    bool legacyPoolSend = false,
    String? nanosWire,
    String? id,
    String? withdrawNonce,
  }) {
    return gate.future;
  }
}
