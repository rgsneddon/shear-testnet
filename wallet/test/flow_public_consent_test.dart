import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_cli.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_public_confirm.dart';
import 'package:shear_wallet/shear_read_sync.dart';
import 'package:shear_wallet/shear_session.dart';

void main() {
  test('docs and the Flow gate agree, and a local send does not ask', () async {
    final docs = File('../site/docs/content.js').readAsStringSync();
    final ui = File('lib/main.dart').readAsStringSync();
    expect(docs, contains(kPublicNodeEverySendCopy));
    expect(docs, contains('confirm a VPN or accept that the node may see your IP'));
    expect(kCliHelp, contains(kPublicNodeEverySendCopy));
    expect(File('lib/shear_cli.dart').readAsStringSync(), contains(r'$kPublicNodeEverySendCopy'));
    expect(kUnprivateConfirmHelper, kPublicNodeEverySendCopy);
    expect(kPublicNodeEverySendCopy.toLowerCase(), isNot(contains('tor')));
    expect(ui, contains('_flowPublicConsent'));
    expect(ui, contains('publicNode: _flowPostsToPublicNode()'));

    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final bobId = createIdentity();
    final bob = (ShearLedger()..bindIdentity(bobId)).homeDest(
      bobId.address,
      paymentCode: bobId.paymentCode,
    );

    final refused = await submitContinuumSend(
      ledger: ledger,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      startTo: '',
      enteredTo: bob,
      amount: 0.1,
      local: false,
      allowPublicHttp: true,
      publicNode: true,
    );
    expect(refused.posted, isFalse);
    expect(refused.remark, kPublicIpWaitCopy);
    expect(ledger.transactions, isEmpty);

    final opened = await submitContinuumSend(
      ledger: ledger,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      startTo: '',
      enteredTo: bob,
      amount: 0.1,
      local: false,
      allowPublicHttp: true,
      publicNode: true,
      publicIpConsent: true,
    );
    expect(opened.posted, isFalse);
    expect(opened.remark, isNot(kPublicIpWaitCopy));
    expect(opened.remark, kErrSendGeneric);

    final local = await submitContinuumSend(
      ledger: ledger,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      startTo: '',
      enteredTo: bob,
      amount: 0.1,
      local: true,
      allowPublicHttp: false,
      publicNode: true,
    );
    expect(local.remark, isNot(kPublicIpWaitCopy));
    expect(ledger.transactions.where((t) => t.kind == 'send'), isEmpty);

    await expectLater(
      ledger.consolidateSpendableNotes(
        restFrame: id.address,
        paymentCode: id.paymentCode,
        spendSeed: Uint8List(32),
        allowPublicHttp: true,
        publicNode: true,
      ),
      throwsA(isA<StateError>().having((e) => e.message, 'message', kPublicIpWaitCopy)),
    );
    final rounds = await ledger.consolidateSpendableNotes(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      spendSeed: Uint8List(32),
      allowPublicHttp: true,
      publicNode: true,
      publicIpConsent: true,
    );
    expect(rounds, 0);
  });

  test('an own node is saved, invalid text is rejected, and posts and reads use it', () async {
    expect(ownNodeUrlError(''), isNull);
    expect(parseOwnNodeUrl(''), isNull);
    expect(ownNodeSkipsPublicConsent(''), isFalse);
    expect(ownNodeUrlError('not a url'), kOwnNodeUrlError);
    expect(parseOwnNodeUrl('ftp://10.0.0.8:18332'), isNull);
    expect(parseOwnNodeUrl('https://p2p.shear.digital'), isNull);
    expect(parseOwnNodeUrl('http://'), isNull);
    expect(parseOwnNodeUrl('10.0.0.8:99999'), isNull);
    expect(parseOwnNodeUrl('192.168.1.9:18332'), 'http://192.168.1.9:18332');
    expect(parseOwnNodeUrl('https://mynode.example:8443/'), 'https://mynode.example:8443');
    expect(ownNodeSkipsPublicConsent('192.168.1.9:18332'), isTrue);

    final dir = Directory.systemTemp.createTempSync('own-node-session-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    await session.setPassword('test-pass-1');
    session.ownNodeUrl = parseOwnNodeUrl('10.1.1.8:18332')!;
    await session.persist();
    final again = ShearSession(store: session.store);
    await again.unlock('test-pass-1');
    expect(again.ownNodeUrl, 'http://10.1.1.8:18332');

    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    final hits = <String>[];
    server.listen((req) async {
      hits.add('${req.method} ${req.uri.path}');
      await req.drain<void>();
      req.response.headers.contentType = ContentType.json;
      req.response.write('{"ok":true,"height":2}');
      await req.response.close();
    });
    final http = _PassthroughHttpOverrides().createHttpClient(null);
    final client = ShearPoolClient(
      http: http,
      sync: ShearReadSync(
        seeds: ['http://127.0.0.1:${server.port}'],
        http: http,
        jitter: Duration.zero,
      ),
    );
    addTearDown(client.close);
    client.useOwnNode('127.0.0.1:${server.port}');
    expect(client.usesOwnNode, isTrue);
    expect(client.baseUrl, 'http://127.0.0.1:${server.port}');
    final stats = await client.stats();
    expect(stats['ok'], true);
    final posted = await client.send(from: 'ssa1from', to: 'ssa1to', amount: 1, kind: 'lock');
    expect(posted['ok'], true);
    expect(hits, contains('GET /stats'));
    expect(hits, contains('POST /api/wallet/send'));
    expect(hits.any((hit) => hit.contains('shear.digital')), isFalse);
    expect(() => client.useOwnNode('not a url'), throwsArgumentError);

    final bare = ShearPoolClient(
      http: http,
      sync: ShearReadSync(seeds: kPublicNodeSeeds, http: http, jitter: Duration.zero),
    );
    addTearDown(bare.close);
    bare.useOwnNode('10.0.0.8:18332');
    expect(bare.sync!.liveBase, 'http://10.0.0.8:18332');
    expect(creditFollowReadBase(bare), 'http://10.0.0.8:18332');
    expect(creditFollowReadSeeds(bare), ['http://10.0.0.8:18332']);
    bare.useOwnNode(null);
    expect(bare.usesOwnNode, isFalse);
    expect(bare.sync!.liveBase, isNull);
    expect(creditFollowReadSeeds(bare).any((s) => s.contains('shear.digital')), isTrue);
  });

  testWidgets('public Flow send asks, an own node does not, and a bad URL is rejected', (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final dir = Directory.systemTemp.createTempSync('flow-consent-ui-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    final ident = session.identity!;
    final ledger = ShearLedger()..bindIdentity(ident);
    ledger.viewSecret = ident.viewKey;
    final bobId = createIdentity();
    final bob = (ShearLedger()..bindIdentity(bobId)).homeDest(
      bobId.address,
      paymentCode: bobId.paymentCode,
    );
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
    await tester.ensureVisible(find.byKey(const Key('connect-own-node')));
    expect(find.text(kPublicNodeEverySendCopy), findsWidgets);
    await tester.enterText(find.byKey(const Key('connect-own-node')), 'not a url');
    await tester.tap(find.byKey(const Key('connect-own-node-save')));
    await tester.pump();
    expect(find.text(kOwnNodeUrlError), findsOneWidget);
    expect(session.ownNodeUrl, isEmpty);

    await tester.tap(find.text('Flow'));
    await tester.pump();
    await tester.enterText(find.widgetWithText(TextField, 'To (she1, ssa1, or shear1)'), bob);
    await tester.enterText(find.byKey(const Key('flow-amount')), '0.2');
    await tester.tap(find.byKey(const Key('flow-send')));
    await tester.pump();
    expect(find.byKey(const Key('reserve-unprivate-confirm')), findsOneWidget);
    expect(find.text(kPublicNodeEverySendCopy), findsWidgets);
    await tester.tap(find.byKey(const Key('reserve-unprivate-cancel')));
    await tester.pump();
    expect(find.text(kPublicIpWaitCopy), findsOneWidget);

    session.ownNodeUrl = 'http://127.0.0.1:18332';
    await tester.tap(find.byKey(const Key('flow-send')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('reserve-unprivate-confirm')), findsNothing);
  });
}

/// Flutter's test binding stubs `HttpClient()` to HTTP 400.
class _PassthroughHttpOverrides extends HttpOverrides {}
