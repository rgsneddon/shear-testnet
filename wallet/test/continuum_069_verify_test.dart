import 'dart:io';
import 'dart:isolate';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_read_open.dart';
import 'package:shear_wallet/shear_read_sync.dart';
import 'package:shear_wallet/shear_session.dart';

void main() {
  testWidgets('unlock Verifying is short and off the UI isolate, then a later block stays off it', (tester) async {
    final dir = Directory.systemTemp.createTempSync('c069-verify-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    final sync = ShearReadSync(seeds: const ['http://127.0.0.1:9'], jitter: Duration.zero);
    final ledger = ShearLedger(pool: ShearPoolClient(sync: sync));
    debugCreditFollowRuns = 0;
    debugCreditFollowKinds.clear();
    debugCreditFollowStamps.clear();
    debugLastFollowSpecKeys = <String>[];
    debugReadProofIsolateRuns = 0;
    debugPopulationOrder.clear();
    final caller = identityHashCode(Isolate.current).toString();

    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ledger,
      skipPoolSync: false,
    ));
    await tester.pump();
    await tester.enterText(find.byType(TextField).first, 'test-pass-1');
    final state = tester.state<ShearWalletAppState>(find.byType(ShearWalletApp));
    final unlock = tester.runAsync(() => state.unlockNow());
    await unlock;
    await tester.pump();
    expect(find.byKey(const Key('continuum-spendable')), findsOneWidget);
    expect(find.byKey(const Key('wallet-block-height')), findsNothing);
    expect(find.byKey(const Key('unlock-verifying')), findsNothing);
    expect(debugPopulationOrder, ['spendable', 'shell', 'chrome']);
    await tester.pump();
    expect(find.byKey(const Key('wallet-block-height')), findsOneWidget);
    expect(debugCreditFollowRuns, greaterThan(0));
    expect(debugCreditFollowKind, 'spendable');
    expect(debugLastFollowSpecKeys, contains('sessionPath'));
    expect(debugLastFollowSpecKeys, contains('spendableFirst'));
    expect(debugLastFollowSpecKeys, isNot(contains('notes')));
    expect(debugLastFollowSpecKeys, isNot(contains('txs')));
    expect(debugLastFollowResultKeys, contains('notes'));
    expect(debugLastFollowResultKeys, isNot(contains('txs')));
    expect(debugLastFollowResultKeys, isNot(contains('nodeBodies')));
    expect(debugCreditFollowStamp, isNot(caller));
    expect(tester.takeException(), isNull);

    final main = File('lib/main.dart').readAsStringSync();
    final finish = main.indexOf('Future<void> _finishUnlockSync');
    final tip = main.indexOf('Future<void> _onNodeTip');
    final unlockBody = main.substring(finish, tip);
    expect(unlockBody, contains('spendableFirst: true'));
    expect(unlockBody.contains('chain: false'), isFalse);
    expect(main, contains('full: false, chain: false'));
    expect(main, contains('openConnectBareOffUi('));
    expect(main, isNot(contains('sync.openConnectBare(')));

    final firstStamp = debugReadProofOffIsolateStamp;
    await tester.runAsync(() => sync.applyReadPageOffUi(
          pageBlocks: [
            {'height': 2, 'header': 'aa', 'txs': <Map<String, dynamic>>[]},
          ],
          liveTip: 4,
          dest: 'ssa1population',
        ));
    expect(debugReadProofIsolateRuns, 1);
    expect(debugReadProofOffIsolateStamp.split('-').first, isNot(caller));
    expect(debugReadProofOffIsolateStamp, isNot(firstStamp));
    expect(sync.readBlocks, isNotEmpty);

    await tester.runAsync(() => sync.applyReadPageOffUi(
          pageBlocks: [
            {'height': 3, 'header': 'bb', 'txs': <Map<String, dynamic>>[]},
          ],
          liveTip: 4,
          dest: 'ssa1population',
        ));
    expect(debugReadProofIsolateRuns, 2);
    expect(debugReadProofOffIsolateStamp.split('-').first, isNot(caller));
    expect(sync.readBlocks.length, 2);

    final runs = debugReadProofIsolateRuns;
    await tester.runAsync(() => state.populateHeldBlocksNow());
    expect(debugReadProofIsolateRuns, runs);
    expect(debugLastFollowSpecKeys, isNot(contains('notes')));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 9));
  });
}
