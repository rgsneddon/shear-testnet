import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_cli.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_public_confirm.dart';
import 'package:shear_wallet/shear_read_sync.dart';
import 'package:shear_wallet/shear_session.dart';
import 'package:shear_wallet/shear_vortex.dart';

void main() {
  test('docs and the Flow gate agree, and a local send does not ask', () async {
    final docs = File('../site/docs/content.js').readAsStringSync().replaceAll(r"\'", "'");
    final ui = File('lib/main.dart').readAsStringSync();
    expect(docs, contains(kPublicNodeEverySendCopy));
    expect(docs.contains('confirm a VPN or accept that the node may see your IP'), isFalse);
    expect(docs.contains('full privacy'), isFalse);
    expect(kPublicIpWaitCopy, kPublicNodeEverySendCopy);
    expect(kCliHelp, contains(kPublicNodeEverySendCopy));
    expect(File('lib/shear_cli.dart').readAsStringSync(), contains(r'$kPublicNodeEverySendCopy'));
    expect(kUnprivateConfirmHelper, kPublicNodeEverySendCopy);
    expect(RegExp(r'\btor\b').hasMatch(kPublicNodeEverySendCopy.toLowerCase()), isFalse);
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
    expect(again.publicNodeConsent, isFalse);
    expect(again.publicNodeChoiceMade, isFalse);
    session.publicNodeConsent = true;
    session.publicNodeChoiceMade = true;
    await session.persist();
    final chosen = ShearSession(store: session.store);
    await chosen.unlock('test-pass-1');
    expect(chosen.publicNodeConsent, isTrue);
    expect(chosen.publicNodeChoiceMade, isTrue);

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
    expect(creditFollowReadSeeds(bare).any((s) => s.contains('shear.digital')), isFalse);
    bare.publicConsent = true;
    expect(creditFollowReadSeeds(bare).any((s) => s.contains('shear.digital')), isTrue);
    bare.publicConsent = false;
    expect(creditFollowReadSeeds(bare).any((s) => s.contains('shear.digital')), isFalse);
  });

  test('own-node URLs refuse public hosts, cleartext, and broken forms', () {
    expect(parseOwnNodeUrl('https://user:pass@mynode.example'), isNull);
    expect(parseOwnNodeUrl('https://mynode.example/rpc'), isNull);
    expect(parseOwnNodeUrl('https://mynode.example?x=1'), isNull);
    expect(parseOwnNodeUrl('[::1]:8080'), 'http://[::1]:8080');
    expect(parseOwnNodeUrl('http://[fd12::1]:8443'), 'http://[fd12::1]:8443');
    expect(parseOwnNodeUrl('http://[fe80::1]:18332'), 'http://[fe80::1]:18332');
    expect(parseOwnNodeUrl('p2p.shear.digital.'), isNull);
    expect(parseOwnNodeUrl('https://pool.shear.digital.:443'), isNull);
    expect(parseOwnNodeUrl('https://77.42.91.84'), isNull);
    expect(parseOwnNodeUrl('77.42.91.84.'), isNull);
    expect(parseOwnNodeUrl('http://1.2.3.4:18332'), isNull);
    expect(ownNodeSkipsPublicConsent('http://1.2.3.4:18332'), isFalse);
    expect(parseOwnNodeUrl('mynode.example:8443'), 'https://mynode.example:8443');
    expect(parseOwnNodeUrl('https://mynode.example:8443/'), 'https://mynode.example:8443');
    expect(rpcNeedsPublicIpWarning('http://127.0.0.1:18332'), isFalse);
    expect(rpcNeedsPublicIpWarning('http://192.168.1.9:18332'), isFalse);
    expect(rpcNeedsPublicIpWarning('https://p2p.shear.digital'), isTrue);
    expect(rpcNeedsPublicIpWarning('https://1.2.3.4:18332'), isTrue);
    final cli = File('lib/shear_cli.dart').readAsStringSync();
    expect('_warnPublicIp('.allMatches(cli).length, greaterThanOrEqualTo(4));
    expect(creditFollowProbesPublic(ownNode: true, base: ''), isFalse);
    expect(creditFollowProbesPublic(ownNode: false, base: 'http://10.0.0.8:18332'), isFalse);
    expect(creditFollowProbesPublic(ownNode: false, base: ''), isFalse);
    expect(creditFollowProbesPublic(ownNode: false, base: '', publicConsent: true), isTrue);
    expect(parseOwnNodeUrl('172.15.0.1:18332'), 'https://172.15.0.1:18332');
    expect(parseOwnNodeUrl('172.16.0.1:18332'), 'http://172.16.0.1:18332');
    expect(parseOwnNodeUrl('172.31.255.255:18332'), 'http://172.31.255.255:18332');
    expect(parseOwnNodeUrl('172.32.0.1:18332'), 'https://172.32.0.1:18332');
    expect(parseOwnNodeUrl('http://172.15.0.1:18332'), isNull);
    expect(parseOwnNodeUrl('http://172.32.0.1:18332'), isNull);
    expect(parseOwnNodeUrl('0.0.0.0:18332'), isNull);
    expect(parseOwnNodeUrl('[::]:18332'), isNull);
    expect(parseOwnNodeUrl('1311399764'), isNull);
    expect(parseOwnNodeUrl('0x4d2a5b54'), isNull);
    expect(parseOwnNodeUrl('https://0x4d.0x2a.0x5b.0x54'), isNull);
    expect(parseOwnNodeUrl('box0x.lan'), 'https://box0x.lan');
    expect(hostIsNonCanonicalNumeric('box0x.lan'), isFalse);
    expect(parseOwnNodeUrl('0115.052.0133.0124'), isNull);
    expect(parseOwnNodeUrl('[::ffff:77.42.91.84]:18332'), isNull);
    expect(parseOwnNodeUrl('[::ffff:4d2a:5b54]:8443'), isNull);
    expect(parseOwnNodeUrl('[::ffff:10.0.0.1]:18332'), 'http://10.0.0.1:18332');
    expect(parseOwnNodeUrl('https://157.180.70.110'), isNull);
    expect(parseOwnNodeUrl('https://2.28.8.89'), isNull);
    expect(parseOwnNodeUrl('https://178.156.222.223'), isNull);
    expect(rpcNeedsPublicIpWarning('p2p.shear.digital'), isTrue);
    expect(rpcNeedsPublicIpWarning('evil.com:18332'), isTrue);
    expect(cliAllowsPublicPost(rpc: 'https://p2p.shear.digital', publicOk: false), isFalse);
    expect(cliAllowsPublicPost(rpc: 'https://p2p.shear.digital', publicOk: true), isTrue);
    expect(cliAllowsPublicPost(rpc: 'http://127.0.0.1:18332', publicOk: true), isFalse);
    expect(cli.contains('publicIpConsent: true'), isFalse);
    expect(cli.contains('cliAllowsPublicPost'), isTrue);
    expect(cli.contains("flags['public-ok']"), isTrue);
    expect(
      nodeSendTargets('http://127.0.0.1:18332', pinned: 'https://p2p.shear.digital'),
      [kLocalNodeRpc],
    );
    expect(
      nodeSendTargets(
        'http://127.0.0.1:18332',
        pinned: 'https://p2p.shear.digital',
        publicConsent: true,
      ).first,
      'https://p2p.shear.digital',
    );

    final client = ShearPoolClient();
    addTearDown(client.close);
    expect(() => client.useOwnNode('[::1]:8080'), returnsNormally);
    expect(client.baseUrl, 'http://[::1]:8080');
    expect(client.usesOwnNode, isTrue);
  });

  test('local down with no consent never dials a public host', () async {
    final saw = _Saw();
    final http = _SawClient(saw, fail: true);
    final client = ShearPoolClient(
      http: http,
      sync: ShearReadSync(seeds: [kLocalNodeRpc], http: http, jitter: Duration.zero),
    );
    addTearDown(client.close);
    await expectLater(
      client.send(from: 'ssa1from', to: 'ssa1to', amount: 1, kind: 'lock'),
      throwsA(isA<StateError>().having((e) => e.message, 'message', kLocalNodeDownCopy)),
    );
    await expectLater(
      client.history('ssa1from', viewKey: 'ab' * 32),
      throwsA(isA<StateError>().having((e) => e.message, 'message', kLocalNodeDownCopy)),
    );
    expect(saw.uris, isNotEmpty);
    for (final uri in saw.uris) {
      expect(uri.host.contains('shear.digital'), isFalse, reason: '$uri');
      expect(uri.host, isNot('77.42.91.84'), reason: '$uri');
    }
  });

  test('an own node does not poll the public pool or follow redirects', () async {
    final saw = _Saw();
    final http = _SawClient(saw);
    final client = ShearPoolClient(
      http: http,
      sync: ShearReadSync(seeds: kPublicNodeSeeds, http: http, jitter: Duration.zero),
    );
    addTearDown(client.close);
    client.useOwnNode('10.1.1.8:18332');
    var opened = false;
    final ledger = ShearLedger(pool: client);
    final changed = await ledger.readContinuityFigures(open: (base) {
      opened = true;
      throw StateError('leaked $base');
    });
    expect(changed, isFalse);
    expect(opened, isFalse);
    final stats = await client.stats();
    expect(stats['ok'], true);
    expect(saw.redirects, isNotEmpty);
    expect(saw.redirects.every((follow) => follow == false), isTrue);
    expect(saw.uris.every((u) => u.host == '10.1.1.8'), isTrue);

    final probe = _Saw();
    final probeHttp = _SawClient(probe, fail: true);
    final sync = ShearReadSync(
      http: probeHttp,
      seeds: ['https://p2p.shear.digital', 'https://pool.shear.digital'],
      jitter: Duration.zero,
    );
    sync.liveBase = 'http://10.1.1.8:18332';
    sync.blockPublicProbe = true;
    expect(await sync.findLiveNode(), 'http://10.1.1.8:18332');
    expect(probe.uris, isEmpty);
  });

  test('default seeds dial nothing public before consent', () async {
    final previous = ownNodeLookup;
    ownNodeLookup = (host) async {
      if (host == 'alias.example') return [InternetAddress('77.42.91.84')];
      if (host == 'lan.local') return [InternetAddress('10.1.1.8')];
      return InternetAddress.lookup(host);
    };
    addTearDown(() => ownNodeLookup = previous);
    expect(await acceptOwnNodeUrl('https://alias.example'), isNull);
    expect(await acceptOwnNodeUrl('http://lan.local:18332'), 'http://lan.local:18332');
    expect(await firstLiveNodeSeed(kPublicNodeSeeds), '');

    final saw = _Saw();
    final http = _SawClient(saw, fail: true);
    final client = ShearPoolClient(http: http);
    addTearDown(client.close);
    expect(client.publicConsent, isFalse);
    expect(client.sync!.seeds.any((s) => s.contains('shear.digital')), isTrue);
    final ledger = ShearLedger(pool: client);
    await ledger.syncTip(proveChain: false);
    var opened = false;
    final figures = await ledger.readContinuityFigures(open: (base) {
      opened = true;
      throw StateError(base);
    });
    expect(figures, isFalse);
    expect(opened, isFalse);
    await expectLater(
      client.history('ssa1from', viewKey: 'ab' * 32),
      throwsA(isA<StateError>().having((e) => e.message, 'message', kLocalNodeDownCopy)),
    );
    await expectLater(
      client.send(from: 'ssa1from', to: 'ssa1to', amount: 1, kind: 'lock', publicConsent: false),
      throwsA(isA<StateError>().having((e) => e.message, 'message', kLocalNodeDownCopy)),
    );
    await creditFollowWorker(jsonEncode({
      'spendableFirst': true,
      'ownNode': false,
      'publicConsent': false,
      'baseUrl': '',
      'restFrame': '',
      'nodeSeeds': kPublicNodeSeeds,
    }));
    expect(saw.uris, isNotEmpty);
    expect(saw.redirects.every((follow) => follow == false), isTrue);
    for (final uri in saw.uris) {
      expect(uri.host.contains('shear.digital'), isFalse, reason: '$uri');
      expect(kRefusedPublicNodeIps.contains(uri.host), isFalse, reason: '$uri');
    }
  });

  test('revoke and a mode change leave no public read base', () async {
    final saw = _Saw();
    final http = _SawClient(saw, fail: true);
    final sync = ShearReadSync(seeds: kPublicNodeSeeds, http: http, jitter: Duration.zero);
    final client = ShearPoolClient(http: http, sync: sync);
    addTearDown(client.close);
    client.publicConsent = true;
    sync.liveBase = 'https://p2p.shear.digital';
    client.publicConsent = false;
    expect(sync.liveBase, isNull);
    expect(creditFollowReadBase(client), isEmpty);
    await expectLater(
      client.history('ssa1from', viewKey: 'ab' * 32),
      throwsA(isA<StateError>()),
    );
    client.publicConsent = true;
    sync.liveBase = 'https://r2r.shear.digital';
    final before = saw.uris.length;
    client.stopPublicReads();
    expect(sync.liveBase, isNull);
    expect(client.publicConsent, isFalse);
    expect(creditFollowReadBase(client), isEmpty);
    await expectLater(
      client.history('ssa1from', viewKey: 'cd' * 32),
      throwsA(isA<StateError>()),
    );
    for (final uri in saw.uris.skip(before)) {
      expect(uri.host.contains('shear.digital'), isFalse, reason: '$uri');
      expect(kRefusedPublicNodeIps.contains(uri.host), isFalse, reason: '$uri');
    }
  });

  test('a public vortice origin is refused until consent, and a name is resolved', () async {
    final previous = ownNodeLookup;
    ownNodeLookup = (host) async {
      if (host == 'alias.example') return [InternetAddress('77.42.91.84')];
      throw const SocketException('dns');
    };
    addTearDown(() => ownNodeLookup = previous);
    final rx = mintVorticeDeployKey(
      programId: 'rx-demo',
      name: 'Rx',
      origin: 'https://rx.shear.digital/vortices/rx.json',
      source: '{}',
    )!;
    await expectLater(
      downloadVorticeFromOrigin(rx),
      throwsA(isA<StateError>().having((e) => e.message, 'message', kPublicNodeEverySendCopy)),
    );
    final alias = mintVorticeDeployKey(
      programId: 'alias-demo',
      name: 'Alias',
      origin: 'https://alias.example/v.json',
      source: '{}',
    )!;
    await expectLater(
      downloadVorticeFromOrigin(alias),
      throwsA(isA<StateError>().having((e) => e.message, 'message', kPublicNodeEverySendCopy)),
    );
    await expectLater(
      walletConnectTask(Uri.parse('https://alias.example/v.json'), allowPublic: false),
      throwsA(isA<SocketException>()),
    );
    final offline = await checkOwnNodeUrl('https://missing.example:18332');
    expect(offline.url, isNull);
    expect(offline.dnsFailed, isTrue);
    final cli = File('lib/shear_cli.dart').readAsStringSync();
    expect(cli.contains('ShearPoolClient(userUrl: _rpc'), isFalse);
    expect(cli.contains('final client = await _rpcClient'), isTrue);
  });

  testWidgets('a send-mode change keeps an earlier public consent', (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final dir = Directory.systemTemp.createTempSync('flow-consent-reset-');
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
    await tester.tap(find.text('Flow'));
    await tester.pump();
    await tester.enterText(find.widgetWithText(TextField, 'To (she1, ssa1, or shear1)'), bob);
    await tester.enterText(find.byKey(const Key('flow-amount')), '0.2');
    await tester.tap(find.byKey(const Key('flow-send')));
    await tester.pump();
    expect(find.byKey(const Key('reserve-unprivate-confirm')), findsOneWidget);
    await tester.tap(find.byKey(const Key('reserve-unprivate-accept')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tap(find.text('Closure'));
    await tester.pump();
    await tester.tap(find.byKey(const Key('closure-send-path-local')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('closure-send-path-bare')));
    await tester.pump();
    await tester.tap(find.text('Flow'));
    await tester.pump();
    await tester.tap(find.byKey(const Key('flow-send')));
    await tester.pump();
    expect(find.byKey(const Key('reserve-unprivate-confirm')), findsNothing);
  });

  testWidgets('desktop first launch offers the existing P2P and solo nodes', (tester) async {
    final h = await _primePublicChoice(tester, 'flow-choice-desktop');
    expect(find.byKey(const Key('public-node-choice-accept')), findsOneWidget);
    expect(find.byKey(const Key('public-node-choice-local')), findsOneWidget);
    expect(find.text('P2P node'), findsOneWidget);
    expect(find.text('Solo node'), findsOneWidget);
    final ui = File('lib/main.dart').readAsStringSync();
    expect(ui, contains('_chooseExistingLocalMode(ClosureSendMode.localNode)'));
    expect(ui, contains('_chooseExistingLocalMode(ClosureSendMode.localNodeFull)'));

    await tester.ensureVisible(find.byKey(const Key('public-node-choice-p2p')));
    await tester.tap(find.byKey(const Key('public-node-choice-p2p')));
    await tester.pump();
    await tester.pump();
    expect(find.text(kDesktopNodeMissingCopy), findsOneWidget);
    expect(find.text('Spendable'), findsNothing);
    expect(h.session.publicNodeConsent, isFalse);
    expect(h.session.closureSendMode, kClosureModeLocal);
    expect(h.client.publicConsent, isFalse);
    expect(h.sync.liveBase, isNull);
    _expectNoPublicDial(h.saw);

    await tester.ensureVisible(find.byKey(const Key('local-node-choose-other')));
    await tester.tap(find.byKey(const Key('local-node-choose-other')));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('public-node-choice-solo')), findsOneWidget);
    await tester.ensureVisible(find.byKey(const Key('public-node-choice-solo')));
    await tester.tap(find.byKey(const Key('public-node-choice-solo')));
    await tester.pump();
    await tester.pump();
    expect(find.text(kDesktopNodeMissingCopy), findsOneWidget);
    expect(find.text('Spendable'), findsNothing);
    expect(h.session.publicNodeConsent, isFalse);
    expect(h.session.closureSendMode, kClosureModeFull);
    expect(h.client.publicConsent, isFalse);
    _expectNoPublicDial(h.saw);
  });

  testWidgets('android first launch offers own node and public node only', (tester) async {
    final h = await _primePublicChoice(tester, 'flow-choice-android', android: true);
    expect(find.byKey(const Key('public-node-choice-accept')), findsOneWidget);
    expect(find.byKey(const Key('public-node-choice-own')), findsOneWidget);
    expect(find.byKey(const Key('public-node-choice-p2p')), findsNothing);
    expect(find.byKey(const Key('public-node-choice-solo')), findsNothing);
    expect(find.byKey(const Key('public-node-choice-local')), findsNothing);
    expect(find.text('Spendable'), findsNothing);
    _expectNoPublicDial(h.saw);
  });

  testWidgets('accepting the public node shows Spendable and remembers consent', (tester) async {
    final h = await _primePublicChoice(tester, 'flow-choice-accept');
    await tester.tap(find.byKey(const Key('public-node-choice-accept')));
    await tester.pump();
    for (var i = 0; i < 24; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 250)));
      await tester.pump();
      if (find.text('Spendable').evaluate().isNotEmpty) break;
    }
    expect(find.text('Spendable'), findsOneWidget);
    expect(h.session.publicNodeConsent, isTrue);
    expect(h.session.publicNodeChoiceMade, isTrue);
    expect(h.client.publicConsent, isTrue);
    _expectNoPublicDial(h.saw);

    final state = tester.state<ShearWalletAppState>(find.byType(ShearWalletApp));
    state.didChangeAppLifecycleState(AppLifecycleState.paused);
    expect(h.session.publicNodeConsent, isTrue);
    expect(h.client.publicConsent, isTrue);

    await tester.tap(find.text('Closure'));
    await tester.pump();
    h.sync.liveBase = 'https://p2p.shear.digital';
    final before = h.saw.uris.length;
    await tester.ensureVisible(find.byKey(const Key('settings-public-node')));
    await tester.tap(find.byKey(const Key('settings-public-node')));
    await tester.pump();
    expect(h.session.publicNodeConsent, isFalse);
    expect(h.session.publicNodeChoiceMade, isTrue);
    expect(h.client.publicConsent, isFalse);
    expect(h.sync.liveBase, isNull);
    await tester.tap(find.text('Continuum'));
    await tester.pump();
    expect(find.text('Spendable'), findsOneWidget);
    for (final uri in h.saw.uris.skip(before)) {
      expect(uri.host.contains('shear.digital'), isFalse, reason: '$uri');
      expect(kRefusedPublicNodeIps.contains(uri.host), isFalse, reason: '$uri');
    }
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

  testWidgets('boot in Connect bare with no consent starts no node', (tester) async {
    final dir = Directory.systemTemp.createTempSync('boot-bare-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    expect(session.publicNodeConsent, isFalse);
    expect(session.closureSendMode, kClosureModeBare);
    var calls = 0;
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      startUnlocked: true,
      skipPoolSync: true,
      nodeBinary: 'node',
      startNode: (binary, env, args) async {
        calls += 1;
      },
    ));
    await tester.pump();
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump();
    expect(calls, 0);
    expect(File('lib/main.dart').readAsStringSync().contains('startDesktopBook'), isFalse);
  });

  testWidgets('a remembered P2P choice is what starts the node', (tester) async {
    final dir = Directory.systemTemp.createTempSync('boot-p2p-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    session.closureSendMode = kClosureModeLocal;
    session.publicNodeChoiceMade = true;
    var calls = 0;
    Map<String, String>? env;
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      startUnlocked: true,
      skipPoolSync: true,
      nodeBinary: 'node',
      startNode: (binary, got, args) async {
        calls += 1;
        env = got;
      },
    ));
    await tester.pump();
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump();
    expect(calls, 1);
    expect(env!['SHEAR_RPC_TOKEN'], isNotEmpty);
    expect(env!['SHEAR_P2P_BIND'], '127.0.0.1');
    expect(env!['SHEAR_STRATUM_BIND'], '127.0.0.1');
    expect(session.publicNodeConsent, isFalse);
  });

  testWidgets('Public node turns on only after the IP confirm', (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final dir = Directory.systemTemp.createTempSync('settings-public-on-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    session.publicNodeChoiceMade = true;
    session.publicNodeConsent = false;
    final saw = _Saw();
    final http = _SawClient(saw, fail: true);
    final client = ShearPoolClient(
      http: http,
      sync: ShearReadSync(http: http, seeds: const ['http://127.0.0.1:9'], jitter: Duration.zero),
    );
    addTearDown(client.close);
    final ledger = ShearLedger(pool: client)..bindIdentity(session.identity!);
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
    await tester.ensureVisible(find.byKey(const Key('settings-public-node')));
    await tester.tap(find.byKey(const Key('settings-public-node')));
    await tester.pump();
    expect(find.byKey(const Key('reserve-unprivate-confirm')), findsOneWidget);
    expect(session.publicNodeConsent, isFalse);
    expect(client.publicConsent, isFalse);
    await tester.tap(find.byKey(const Key('reserve-unprivate-cancel')));
    await tester.pump();
    expect(session.publicNodeConsent, isFalse);
    await tester.ensureVisible(find.byKey(const Key('settings-public-node')));
    await tester.tap(find.byKey(const Key('settings-public-node')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('reserve-unprivate-accept')));
    await tester.pump();
    expect(session.publicNodeConsent, isTrue);
    expect(client.publicConsent, isTrue);
  });

  testWidgets('Connect bare arms consent when Apply commits, not when the radio moves', (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final dir = Directory.systemTemp.createTempSync('apply-consent-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    session.publicNodeConsent = true;
    session.publicNodeChoiceMade = true;
    session.closureSendMode = kClosureModeLocal;
    final saw = _Saw();
    final http = _SawClient(saw, fail: true);
    final client = ShearPoolClient(
      http: http,
      sync: ShearReadSync(http: http, seeds: const ['http://127.0.0.1:9'], jitter: Duration.zero),
    );
    addTearDown(client.close);
    final ledger = ShearLedger(pool: client)..bindIdentity(session.identity!);
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ledger,
      startUnlocked: true,
      skipPoolSync: true,
    ));
    await tester.pump();
    await tester.pump();
    expect(client.publicConsent, isFalse);
    await tester.tap(find.text('Closure'));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const Key('closure-send-path-bare')));
    await tester.tap(find.byKey(const Key('closure-send-path-bare')));
    await tester.pump();
    expect(client.publicConsent, isFalse);
    expect(session.publicNodeConsent, isTrue);
    await tester.ensureVisible(find.byKey(const Key('closure-apply')));
    await tester.tap(find.byKey(const Key('closure-apply')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(client.publicConsent, isTrue);
  });

  testWidgets('accepting a vortice fetch leaves Public node off and the next public call asks', (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final dir = Directory.systemTemp.createTempSync('vortice-once-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    session.publicNodeChoiceMade = true;
    session.publicNodeConsent = false;
    final saw = _Saw();
    final http = _SawClient(saw, fail: true);
    final client = ShearPoolClient(
      http: http,
      sync: ShearReadSync(http: http, seeds: const ['http://127.0.0.1:9'], jitter: Duration.zero),
    );
    addTearDown(client.close);
    final ident = session.identity!;
    final ledger = ShearLedger(pool: client)..bindIdentity(ident);
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
    final key = mintVorticeDeployKey(
      programId: 'once-demo',
      name: 'Once',
      origin: 'https://rx.shear.digital/v.json',
      source: '{}',
    )!;
    await tester.tap(find.text('Vortex'));
    await tester.pump();
    await tester.tap(find.text('Add new vortice'));
    await tester.pump();
    await tester.enterText(find.byKey(const Key('vortice-key')), key);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('reserve-unprivate-confirm')), findsOneWidget);
    await tester.tap(find.byKey(const Key('reserve-unprivate-accept')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byKey(const Key('reserve-unprivate-confirm')), findsNothing);
    expect(session.publicNodeConsent, isFalse);
    expect(client.publicConsent, isFalse);
    await tester.tap(find.text('Closure'));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const Key('settings-public-node')));
    final tile = tester.widget<SwitchListTile>(find.byKey(const Key('settings-public-node')));
    expect(tile.value, isFalse);
    await tester.tap(find.text('Flow'));
    await tester.pump();
    await tester.enterText(find.widgetWithText(TextField, 'To (she1, ssa1, or shear1)'), bob);
    await tester.enterText(find.byKey(const Key('flow-amount')), '0.2');
    await tester.tap(find.byKey(const Key('flow-send')));
    await tester.pump();
    expect(find.byKey(const Key('reserve-unprivate-confirm')), findsOneWidget);
    expect(session.publicNodeConsent, isFalse);
  });
}

/// Flutter's test binding stubs `HttpClient()` to HTTP 400.
class _PassthroughHttpOverrides extends HttpOverrides {}

class _Saw {
  final uris = <Uri>[];
  final redirects = <bool>[];
}

class _SawClient implements HttpClient {
  _SawClient(this.saw, {this.fail = false, this.body = '{"ok":true,"height":1}'});

  final _Saw saw;
  final bool fail;
  final String body;

  @override
  bool autoUncompress = true;
  @override
  Duration? connectionTimeout;
  @override
  Duration idleTimeout = const Duration(seconds: 15);
  @override
  int? maxConnectionsPerHost;
  @override
  String? userAgent;
  @override
  void addCredentials(Uri url, String realm, HttpClientCredentials credentials) {}
  @override
  void addProxyCredentials(String host, int port, String realm, HttpClientCredentials credentials) {}
  @override
  Future<ConnectionTask<Socket>> Function(Uri url, String? proxyHost, int? proxyPort)? connectionFactory;
  @override
  Future<bool> Function(Uri url, String scheme, String realm)? authenticate;
  @override
  Future<bool> Function(String host, int port, String scheme, String realm)? authenticateProxy;
  @override
  bool Function(X509Certificate cert, String host, int port)? badCertificateCallback;
  @override
  void Function(String line)? keyLog;
  @override
  void close({bool force = false}) {}
  @override
  String Function(Uri url)? findProxy;

  Future<HttpClientRequest> _req(Uri url) async => _SawRequest(url, saw, fail: fail, body: body);

  @override
  Future<HttpClientRequest> delete(String host, int port, String path) => _req(Uri());
  @override
  Future<HttpClientRequest> deleteUrl(Uri url) => _req(url);
  @override
  Future<HttpClientRequest> get(String host, int port, String path) => _req(Uri());
  @override
  Future<HttpClientRequest> getUrl(Uri url) {
    saw.uris.add(url);
    return _req(url);
  }

  @override
  Future<HttpClientRequest> head(String host, int port, String path) => _req(Uri());
  @override
  Future<HttpClientRequest> headUrl(Uri url) => _req(url);
  @override
  Future<HttpClientRequest> open(String method, String host, int port, String path) => _req(Uri());
  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) => _req(url);
  @override
  Future<HttpClientRequest> patch(String host, int port, String path) => _req(Uri());
  @override
  Future<HttpClientRequest> patchUrl(Uri url) => _req(url);
  @override
  Future<HttpClientRequest> post(String host, int port, String path) => _req(Uri());
  @override
  Future<HttpClientRequest> postUrl(Uri url) {
    saw.uris.add(url);
    return _req(url);
  }

  @override
  Future<HttpClientRequest> put(String host, int port, String path) => _req(Uri());
  @override
  Future<HttpClientRequest> putUrl(Uri url) => _req(url);
}

class _SawRequest implements HttpClientRequest {
  _SawRequest(this.uri, this.saw, {required this.fail, required this.body});

  final _Saw saw;
  final bool fail;
  final String body;

  @override
  bool bufferOutput = true;
  @override
  int contentLength = -1;
  @override
  late Encoding encoding;
  @override
  bool followRedirects = true;
  @override
  final HttpHeaders headers = _SawHeaders();
  @override
  void add(List<int> data) {}
  @override
  void addError(Object error, [StackTrace? stackTrace]) {}
  @override
  Future<void> addStream(Stream<List<int>> stream) async {}
  @override
  Future<HttpClientResponse> close() async {
    saw.redirects.add(followRedirects);
    if (fail) throw const SocketException('down');
    return _SawResponse(body);
  }

  @override
  void abort([Object? exception, StackTrace? stackTrace]) {}
  @override
  HttpConnectionInfo? get connectionInfo => null;
  @override
  List<Cookie> get cookies => const [];
  @override
  Future<HttpClientResponse> get done async => _SawResponse(body);
  @override
  Future<void> flush() async {}
  @override
  int maxRedirects = 5;
  @override
  String get method => 'GET';
  @override
  bool persistentConnection = true;
  @override
  final Uri uri;
  @override
  void write(Object? obj) {}
  @override
  void writeAll(Iterable<dynamic> objects, [String separator = '']) {}
  @override
  void writeCharCode(int charCode) {}
  @override
  void writeln([Object? obj = '']) {}
}

class _SawResponse extends Stream<List<int>> implements HttpClientResponse {
  _SawResponse(String body) : _bytes = utf8.encode(body);

  final List<int> _bytes;

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    return Stream<List<int>>.value(_bytes).listen(
      onData,
      onError: onError,
      onDone: onDone,
      cancelOnError: cancelOnError,
    );
  }

  @override
  final HttpHeaders headers = _SawHeaders()..contentType = ContentType.json;
  @override
  int get statusCode => 200;
  @override
  int get contentLength => _bytes.length;
  @override
  X509Certificate? get certificate => null;
  @override
  HttpConnectionInfo? get connectionInfo => null;
  @override
  HttpClientResponseCompressionState get compressionState =>
      HttpClientResponseCompressionState.notCompressed;
  @override
  List<Cookie> get cookies => const [];
  @override
  Future<Socket> detachSocket() => Future<Socket>.error(UnsupportedError('saw'));
  @override
  bool get isRedirect => false;
  @override
  bool get persistentConnection => false;
  @override
  String get reasonPhrase => 'OK';
  @override
  Future<HttpClientResponse> redirect([String? method, Uri? url, bool? followLoops]) =>
      Future<HttpClientResponse>.error(UnsupportedError('saw'));
  @override
  List<RedirectInfo> get redirects => const [];
}

class _SawHeaders implements HttpHeaders {
  @override
  List<String>? operator [](String name) => const [];
  @override
  void add(String name, Object value, {bool preserveHeaderCase = false}) {}
  @override
  late bool chunkedTransferEncoding;
  @override
  void clear() {}
  @override
  int contentLength = -1;
  @override
  ContentType? contentType;
  @override
  DateTime? date;
  @override
  DateTime? expires;
  @override
  void forEach(void Function(String name, List<String> values) f) {}
  @override
  String? host;
  @override
  DateTime? ifModifiedSince;
  @override
  void noFolding(String name) {}
  @override
  late bool persistentConnection;
  @override
  int? port;
  @override
  void remove(String name, Object value) {}
  @override
  void removeAll(String name) {}
  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) {}
  @override
  String? value(String name) => null;
}

void _expectNoPublicDial(_Saw saw) {
  for (final uri in saw.uris) {
    expect(uri.host.contains('shear.digital'), isFalse, reason: '$uri');
    expect(kRefusedPublicNodeIps.contains(uri.host), isFalse, reason: '$uri');
  }
}

/// First-run screen, with a public read base already armed so a leak is visible.
Future<({ShearSession session, ShearLedger ledger, _Saw saw, ShearPoolClient client, ShearReadSync sync})>
    _primePublicChoice(WidgetTester tester, String label, {bool android = false}) async {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final dir = Directory.systemTemp.createTempSync(label);
  addTearDown(() {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
  });
  final session = ShearSession(store: File('${dir.path}/session.json'));
  await tester.runAsync(() async {
    await session.loadOrCreate();
    await session.setPassword('test-pass-1');
  });
  final saw = _Saw();
  final http = _SawClient(saw, fail: true);
  final sync = ShearReadSync(http: http, seeds: kPublicNodeSeeds, jitter: Duration.zero);
  final client = ShearPoolClient(http: http, sync: sync);
  addTearDown(client.close);
  client.publicConsent = true;
  sync.liveBase = 'https://p2p.shear.digital';
  final ledger = ShearLedger(pool: client)..bindIdentity(session.identity!);
  await tester.pumpWidget(ShearWalletApp(
    session: session,
    ledger: ledger,
    startUnlocked: true,
    skipPoolSync: true,
    askPublicNode: true,
    hostAndroid: android,
  ));
  await tester.pump();
  await tester.pump();
  return (session: session, ledger: ledger, saw: saw, client: client, sync: sync);
}
