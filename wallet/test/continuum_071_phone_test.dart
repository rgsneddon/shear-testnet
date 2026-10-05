import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_biometrics.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_session.dart';

Future<void> _seal(WidgetTester tester, ShearSession session) async {
  await tester.runAsync(() async {
    await session.loadOrCreate();
    await session.setPassword('test-pass-1');
  });
}

void main() {
  testWidgets('Android shows Loading and then coins without the continuity card', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-phone-coins-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _seal(tester, session);

    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ShearLedger(),
      biometrics: const NoBiometrics(),
      startUnlocked: true,
      skipPoolSync: true,
      hostAndroid: true,
      bookLoading: true,
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('continuum-loading')), findsOneWidget);
    expect(find.text('Loading'), findsOneWidget);
    expect(find.text('1 SHE per block continuity'), findsNothing);
    expect(find.byKey(const Key('android-banner-theme')), findsOneWidget);

    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ShearLedger(),
      biometrics: const NoBiometrics(),
      startUnlocked: true,
      skipPoolSync: true,
      hostAndroid: true,
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('Spendable'), findsOneWidget);
    expect(find.text('1 SHE per block continuity'), findsNothing);
    expect(find.byKey(const Key('continuum-stats')), findsNothing);
    expect(find.byKey(const Key('continuum-loading')), findsNothing);
    expect(find.byKey(const Key('android-banner-theme')), findsOneWidget);
  });
}
