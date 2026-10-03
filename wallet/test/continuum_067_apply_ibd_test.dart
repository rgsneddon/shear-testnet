import 'dart:io';
import 'dart:isolate';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_session.dart';

/// Apply's credit follow, after unlock has finished sealing the session.
/// SHEAR_NODE_BIN must be a process that starts (so the sidecar is in IBD)
/// and is not the live shear node.
void main() {
  testWidgets('Apply during node IBD uses the balances follow, off the UI isolate', (tester) async {
    expect(Platform.environment['SHEAR_NODE_BIN'], isNotNull);
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    debugCreditFollowKinds.clear();
    debugCreditFollowStamps.clear();
    debugCreditFollowRuns = 0;
    final paths = <String>[];
    final server = await tester.runAsync(() => HttpServer.bind(InternetAddress.loopbackIPv4, 0));
    if (server == null) fail('loopback server did not bind');
    addTearDown(() => tester.runAsync(() => server.close(force: true)));
    server.listen((req) async {
      paths.add(req.uri.path);
      req.response.statusCode = 200;
      req.response.headers.contentType = ContentType.json;
      req.response.write('{"height":1,"header":"aa","balance":0,"owedPi":0,"notes":[],"txs":[],"headers":[]}');
      await req.response.close();
    });
    final dir = Directory.systemTemp.createTempSync('continuum-067-apply-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    final ledger = ShearLedger(pool: ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}'));
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ledger,
      startUnlocked: true,
      skipPoolSync: false,
    ));
    await tester.pump();
    final caller = identityHashCode(Isolate.current).toString();
    final until = DateTime.now().add(const Duration(seconds: 40));
    while (DateTime.now().isBefore(until)) {
      await tester.pump(const Duration(milliseconds: 50));
      final verifying = find.byKey(const Key('unlock-verifying'));
      if (debugCreditFollowRuns > 0 && verifying.evaluate().isEmpty) break;
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    }
    expect(find.byKey(const Key('unlock-verifying')), findsNothing);
    expect(debugCreditFollowRuns, greaterThan(0));
    final before = debugCreditFollowRuns;
    final beforePaths = paths.length;
    await tester.tap(find.text('Closure'));
    await tester.pump();
    await tester.pump();
    await tester.ensureVisible(find.text('p2P Node'));
    await tester.tap(find.text('p2P Node'));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const Key('closure-apply')));
    await tester.tap(find.byKey(const Key('closure-apply')));
    await tester.pump();
    final applyUntil = DateTime.now().add(const Duration(seconds: 30));
    while (DateTime.now().isBefore(applyUntil)) {
      final added = debugCreditFollowKinds.length > before
          ? debugCreditFollowKinds.sublist(before)
          : const <String>[];
      if (added.contains('balances')) break;
      await tester.pump(const Duration(milliseconds: 50));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    }
    expect(debugCreditFollowRuns, greaterThan(before));
    final addedKinds = debugCreditFollowKinds.sublist(before);
    final addedStamps = debugCreditFollowStamps.sublist(before);
    expect(addedKinds, contains('balances'));
    final balanceAt = addedKinds.indexOf('balances');
    expect(addedStamps[balanceAt], isNot(caller));
    final addedPaths = paths.sublist(beforePaths);
    expect(addedPaths.any((p) => p.contains('balance')), isTrue);
    expect(addedPaths.any((p) => p.contains('notes')), isFalse);
    // Drop the wallet so its tip retry timer fires as cancelled, then close
    // the server. A pending fake timer fails the binding check.
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 9));
  });
}
