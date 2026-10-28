import 'dart:io';

import 'package:flutter/material.dart';
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
    expect(addr.length, 128);
    final shown = tester.widget<SelectableText>(find.byKey(const Key('settings-blu-address')));
    expect(shown.data, addr);
    expect(find.byKey(const Key('settings-blu-address-copy')), findsOneWidget);
  });

  testWidgets('Restore asks "Did this wallet mine?"; yes turns the scan on', (tester) async {
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
    await tester.runAsync(() => _wallet(tester).importShewallNow());
    await tester.pump();
    await tester.pump();
    expect(session.identity!.address, id.address);
    expect(find.byKey(const Key('restore-did-mine')), findsOneWidget);
    expect(session.bluMining, isFalse, reason: 'nothing changes before the answer');
    await tester.tap(find.byKey(const Key('restore-did-mine-yes')));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 300)));
    await tester.pump();
    expect(find.byKey(const Key('restore-did-mine')), findsNothing);
    expect(session.bluMining, isTrue);
    expect(ledger.bluMining, isTrue);
  });
}
