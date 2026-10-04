import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_session.dart';

void main() {
  testWidgets('ShearWalletApp first frame is Shear 0.70 and throws nothing', (tester) async {
    final dir = Directory.systemTemp.createTempSync('c069-launch-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() => session.loadOrCreate());
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ShearLedger(),
      skipPoolSync: true,
    ));
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(tester.widget<MaterialApp>(find.byType(MaterialApp)).title, 'Shear 0.70');
    expect(kWalletVersion, '0.70');
    expect(find.byType(ShearWalletApp), findsOneWidget);
  });
}
