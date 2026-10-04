import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_session.dart';

/// Phone width. The top bar is the logo, the link, and the sealed height.
void main() {
  testWidgets('Android bar fits 360px and Closure has no node radios', (tester) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final dir = Directory.systemTemp.createTempSync('c068-bar-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    final ledger = ShearLedger()..bindIdentity(session.identity!);
    ledger.restoreSealedTip(86);
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ledger,
      startUnlocked: true,
      skipPoolSync: true,
      hostAndroid: true,
    ));
    await tester.pump();
    await tester.pump();

    expect(find.byKey(const Key('wallet-connected')), findsOneWidget);
    expect(find.text('not connected'), findsOneWidget);
    expect(find.byKey(const Key('wallet-block-height')), findsOneWidget);
    expect(find.text('height 86'), findsOneWidget);
    expect(find.textContaining('block height:'), findsNothing);
    expect(find.textContaining('synchronised'), findsNothing);
    expect(find.text('0.68'), findsNothing);
    expect(find.byKey(const Key('unlock-verifying')), findsNothing);
    expect(find.text('p2P Node'), findsNothing);
    expect(find.text('Full Node'), findsNothing);
    expect(tester.takeException(), isNull);

    await tester.tap(find.text('Closure'));
    await tester.pump();
    await tester.pump();
    expect(find.text('Connect Bare'), findsOneWidget);
    expect(find.text('p2P Node'), findsNothing);
    expect(find.text('Full Node'), findsNothing);
    expect(
      find.text('This phone reads height and confirms coins. It does not start a node.'),
      findsOneWidget,
    );
    expect(find.text('Settings'), findsOneWidget);
    final dark = find.byKey(const Key('settings-dark-mode'));
    // Address lines are their own zero-range scrollables. The page list is the
    // one with AlwaysScrollableScrollPhysics.
    final closureScroll = find.descendant(
      of: find.byKey(const PageStorageKey<String>('tab-5')),
      matching: find.byWidgetPredicate(
        (w) => w is Scrollable && w.physics is AlwaysScrollableScrollPhysics,
      ),
    );
    expect(closureScroll, findsOneWidget);
    final scrollState = tester.state<ScrollableState>(closureScroll);
    final box = tester.renderObject<RenderBox>(dark);
    final scrollBox = tester.renderObject<RenderBox>(closureScroll);
    final dy = box.localToGlobal(Offset.zero, ancestor: scrollBox).dy;
    final next = (scrollState.position.pixels + dy - 16)
        .clamp(0.0, scrollState.position.maxScrollExtent);
    scrollState.position.jumpTo(next);
    await tester.pump();
    final tileTop = tester.getTopLeft(dark).dy;
    expect(tileTop, greaterThan(56));
    expect(tileTop, lessThan(560));
    expect(dark, findsOneWidget);
    expect(find.text('Unlock with biometrics'), findsOneWidget);
    expect(find.byKey(const Key('android-banner-theme')), findsOneWidget);
    expect(find.byTooltip('Dark mode'), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.tap(dark);
    await tester.pump();
    final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.themeMode, ThemeMode.dark);
    expect(find.byKey(const Key('wallet-connected')), findsOneWidget);
    expect(find.byKey(const Key('wallet-block-height')), findsOneWidget);
    expect(find.text('p2P Node'), findsNothing);
    expect(find.text('Full Node'), findsNothing);
    expect(find.byKey(const Key('android-top-banner')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
