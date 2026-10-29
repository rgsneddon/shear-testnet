import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_blunote.dart';
import 'package:shear_wallet/shear_eip712.dart' show hexToBytes;
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_session.dart';

const _pw = 'correct-horse';

void _tall(WidgetTester tester) {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

ShearWalletAppState _wallet(WidgetTester tester) =>
    tester.state<ShearWalletAppState>(find.byType(ShearWalletApp));

/// R28 "This wallet mines" in Settings, and the restore question (D4).
void main() {
  testWidgets('Settings: the mining switch is off; on shows the mining address', (tester) async {
    _tall(tester);
    final dir = Directory.systemTemp.createTempSync('shear-blu-ui-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword(_pw);
    });
    final ledger = ShearLedger();
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ledger,
      startUnlocked: true,
      skipPoolSync: true,
    ));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Closure'));
    await tester.pump();
    final key = find.byKey(const Key('settings-blu-mining'));
    await tester.ensureVisible(key);
    await tester.pump();
    expect(tester.widget<SwitchListTile>(key).value, isFalse);
    expect(find.byKey(const Key('settings-blu-address')), findsNothing);
    expect(ledger.bluMining, isFalse);

    await tester.tap(find.descendant(of: key, matching: find.byType(Switch)));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 300)));
    await tester.pump();
    expect(session.bluMining, isTrue);
    expect(ledger.bluMining, isTrue);
    final addr = bluMiningAddress(hexToBytes(session.identity!.seedHex));
    expect(addr, startsWith('shm1'));
    expect(addr.length, 114);
    final shown = tester.widget<SelectableText>(find.byKey(const Key('settings-blu-address')));
    expect(shown.data, addr);

    // Each button copies exactly its string (Russell, 28 Oct).
    final copied = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        copied.add((call.arguments as Map)['text'] as String);
      }
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    for (final k in ['settings-blu-address-copy', 'settings-blu-pool-command', 'settings-blu-solo-command']) {
      final b = find.byKey(Key(k));
      await tester.ensureVisible(b);
      await tester.pump();
      await tester.tap(b);
      await tester.pump();
    }
    expect(copied, [
      addr,
      './ShearK-Miner --pool stratum+ssl://pool.shear.digital:443 --user rig1 --blu $addr --threads 8',
      './ShearK-Miner --pool 127.0.0.1:1111 --user rig1 --blu $addr --solo --threads 8',
    ]);
    for (final c in copied) {
      expect(c.contains('ssa1'), isFalse, reason: 'no ssa1 in a mining command');
    }
    expect(decodeMiningAddress(addr), isNotNull);
  });

  // Ruling 7: a restore asks where the scan starts. The birth is the height
  // the user gives, or genesis without one; the mining answer does not move it.
  for (final given in <int?>[1234, null]) {
    testWidgets('Restore asks for a birth height (${given ?? 'none: genesis'}) and whether the wallet mined', (tester) async {
      _tall(tester);
      final id = createIdentity();
      final backup = File('${Directory.systemTemp.createTempSync('shear-blu-imp-').path}/$shewallName');
      await tester.runAsync(() async {
        await exportEncryptedShewall(identity: id, ledger: ShearLedger(), password: _pw, dest: backup);
      });
      final dir = Directory.systemTemp.createTempSync('shear-blu-imp-sess-');
      final session = ShearSession(store: File('${dir.path}/session.json'));
      await session.loadOrCreate();
      final ledger = ShearLedger();
      await tester.pumpWidget(ShearWalletApp(
        key: UniqueKey(),
        session: session,
        ledger: ledger,
        importSrc: () => backup,
        skipPoolSync: true,
      ));
      await tester.pump();
      await tester.enterText(find.byType(TextField).first, _pw);
      late Future<void> done;
      await tester.runAsync(() async {
        done = _wallet(tester).importShewallNow();
        for (var i = 0; i < 40 && find.byKey(const Key('restore-scan')).evaluate().isEmpty; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 100));
          tester.binding.scheduleFrame();
        }
      });
      await tester.pump();
      expect(find.byKey(const Key('restore-scan')), findsOneWidget);
      expect(session.bluMining, isFalse, reason: 'nothing changes before the answer');
      if (given != null) {
        await tester.enterText(find.byKey(const Key('restore-birth-height')), '$given');
      }
      await tester.tap(find.byKey(const Key('restore-did-mine')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('restore-scan-start')));
      await tester.pump();
      await tester.runAsync(() => done);
      await tester.pump();
      expect(find.byKey(const Key('restore-scan')), findsNothing);
      expect(session.identity!.address, id.address);
      // WH P1-4: a typed birth is capped at the verified tip (none in this
      // book: genesis), and the user is told.
      final want = given == null ? 0 : restoreBirthFor(given, verifiedTip: ledger.verifiedHeaderTip).birth;
      expect(session.birthHeight, want);
      expect(ledger.birthHeight, want);
      expect(find.byKey(const Key('restore-birth-warning')), given == null ? findsNothing : findsOneWidget);
      expect(session.bluMining, isTrue);
      expect(ledger.bluMining, isTrue);
    });
  }

  testWidgets('Restore without mining keeps the switch off and still scans from the birth', (tester) async {
    _tall(tester);
    final id = createIdentity();
    final backup = File('${Directory.systemTemp.createTempSync('shear-blu-imp-').path}/$shewallName');
    await tester.runAsync(() async {
      await exportEncryptedShewall(identity: id, ledger: ShearLedger(), password: _pw, dest: backup);
    });
    final dir = Directory.systemTemp.createTempSync('shear-blu-imp-sess-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    final ledger = ShearLedger();
    await tester.pumpWidget(ShearWalletApp(
      key: UniqueKey(),
      session: session,
      ledger: ledger,
      importSrc: () => backup,
      skipPoolSync: true,
    ));
    await tester.pump();
    await tester.enterText(find.byType(TextField).first, _pw);
    late Future<void> done;
    await tester.runAsync(() async {
      done = _wallet(tester).importShewallNow();
      for (var i = 0; i < 40 && find.byKey(const Key('restore-scan')).evaluate().isEmpty; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
        tester.binding.scheduleFrame();
      }
    });
    await tester.pump();
    await tester.tap(find.byKey(const Key('restore-scan-start')));
    await tester.pump();
    await tester.runAsync(() => done);
    await tester.pump();
    expect(session.identity!.address, id.address);
    expect(session.birthHeight, 0, reason: 'no height: genesis');
    expect(session.bluMining, isFalse);
    expect(ledger.bluMining, isFalse);
  });
}
