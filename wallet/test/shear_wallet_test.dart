import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_lock.dart';
import 'package:shear_wallet/shear_session.dart';
import 'package:shear_wallet/shear_hash.dart';
import 'package:shear_wallet/shear_miner_host.dart';
import 'package:shear_wallet/shear_theme.dart';
import 'package:shear_wallet/shear_ctf.dart';

void main() {
  test('new identity is shear1 with a stable view key after persist/reload', () async {
    final dir = Directory.systemTemp.createTempSync('shear-sess-');
    final store = File('${dir.path}/session.json');
    final s1 = ShearSession(store: store);
    final a = await s1.loadOrCreate();
    expect(a.address.startsWith('shear1'), isTrue);
    expect(isShearAddress(a.address), isTrue);
    expect(a.viewKey.isNotEmpty, isTrue);
    final s2 = ShearSession(store: store);
    final b = await s2.loadOrCreate();
    expect(b.address, a.address);
    expect(b.viewKey, a.viewKey);
  });

  test('wallet stays lean: thousands of hashes never become thousands of txs', () {
    final id = createIdentity();
    final ledger = ShearLedger();
    ledger.creditHash(id.address, hashes: 4000);
    expect(ledger.pending(id.address), closeTo(4e-6, 1e-18));
    expect(ledger.spendable(id.address), 0);
    expect(ledger.transactions, isEmpty);
    final fatDump = jsonEncode(exportShewall(identity: id, ledger: ledger));
    expect(fatDump.contains('"kind":"sample"'), isFalse);
    expect(utf8.encode(fatDump).length < 4000, isTrue);
    ledger.confirmRound(address: id.address, pot: 1, height: 7);
    expect(ledger.transactions.length, 1);
    expect(ledger.pending(id.address), 0);
    ledger.prune();
    expect(ledger.transactions.length, 1);
  });

  test('pending hashes are not spendable until block found; explorer lists confirmed round', () {
    final id = createIdentity();
    final ledger = ShearLedger();
    ledger.creditHash(id.address, hashes: 4);
    expect(ledger.pending(id.address), closeTo(4e-9, 1e-18));
    expect(ledger.spendable(id.address), 0);
    expect(ledger.ownerHistory(id.address), isEmpty);
    ledger.confirmRound(address: id.address, pot: 1, height: 3);
    expect(ledger.pending(id.address), 0);
    expect(ledger.spendable(id.address), closeTo(1 + 4e-9, 1e-18));
    expect(ledger.ownerHistory(id.address).single.confirmed, isTrue);
    expect(ledger.ownerHistory(id.address).single.amount, closeTo(1 + 4e-9, 1e-18));
  });

  test('shewall.json password seal restores address and txs', () async {
    final id = createIdentity();
    final ledger = ShearLedger();
    ledger.creditHash(id.address, hashes: 2);
    ledger.confirmRound(address: id.address, pot: 1, height: 1);
    const pw = 'correct-horse';
    final dump = exportShewall(identity: id, ledger: ledger);
    final env = await ShearLock.seal(dump, pw);
    expect(env['kind'], ShearLock.kind);
    expect(env.containsKey('ct'), isTrue);
    final opened = await ShearLock.open(env, pw);
    final ledger2 = ShearLedger();
    final id2 = importShewall(opened, ledger2);
    expect(id2.address, id.address);
    expect(id2.viewKey, id.viewKey);
    expect(ledger2.spendable(id.address), closeTo(1 + 2e-9, 1e-18));
    expect(ledger2.ownerHistory(id.address), isNotEmpty);
    await expectLater(ShearLock.open(env, 'wrong'), throwsA(anything));
  });

  test('CTF dest ≠ login, changes with height/continuity, two logins differ, view-key isolation, Reserve rest-frame', () {
    const addr = 'shear1qqyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqt0p2rt';
    expect(destForLogin(addr, height: 1), 'shear1qa9fmadth4c9y25hc8wjrm9t5kq7qrfhp3sczuf');
    expect(destForLogin(addr, height: 2), 'shear1qjz8q7jyptellt2z8g79fjg3va9z45mqlavjcpl');
    expect(destForLogin(addr, height: 1), isNot(addr));
    final root2 = Uint8List(32);
    root2.fillRange(0, 32, 2);
    expect(
      destForLogin(addr, continuityRoot: root2, height: 1),
      'shear1qlqqee4eex7wguz7wardr64az4ltrz20qnf53jc',
    );
    final a = createIdentity();
    final b = createIdentity();
    expect(destForLogin(a.address, height: 1), isNot(destForLogin(b.address, height: 1)));
    expect(destsForViewKey('', a.address, heights: [1], ownerViewKey: a.viewKey), isEmpty);
    final aliceDests = destsForViewKey(a.viewKey, a.address, heights: [1, 2], ownerViewKey: a.viewKey);
    final bobDests = destsForViewKey(b.viewKey, b.address, heights: [1, 2], ownerViewKey: b.viewKey);
    expect(aliceDests.first, destForLogin(a.address, height: 1));
    expect(destsForViewKey(b.viewKey, a.address, heights: [1], ownerViewKey: a.viewKey), isEmpty);
    expect(aliceDests.length, 2);
    expect(aliceDests[0], isNot(bobDests[0]));
    expect(reservePrincipal(a.address), a.address);
    expect(reserveRejectsDest(a.address, destForLogin(a.address, height: 1)), isTrue);
    expect(reserveRejectsDest(a.address, a.address), isFalse);
    expect(kWalletVersion, '0.0.2');
    expect(kWalletVersion.contains('0.0.10'), isFalse);
  });

  test('currentDest equals destForLogin with lag-1 from tip header and next height', () {
    final id = createIdentity();
    final ledger = ShearLedger();
    final header = Uint8List(120);
    for (var i = 0; i < 32; i++) {
      header[68 + i] = 3;
    }
    ledger.applyTipHeader(header, sealedHeight: 4);
    expect(ledger.tipHeight, 5);
    expect(ledger.lag1Root, header.sublist(68, 100));
    expect(
      ledger.currentDest(id.address),
      destForLogin(id.address, continuityRoot: header.sublist(68, 100), height: 5),
    );
  });

  test('syncSpendable from pool /api/stats applyTipHex: currentDest is destForLogin(login, lag-1 offset 68, next height, no viewKey)', () async {
    final header = Uint8List(120);
    for (var i = 0; i < 32; i++) {
      header[68 + i] = 7;
    }
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final server = await _fakePool(headerHex: hex, height: 4);
    addTearDown(() => server.close(force: true));
    final id = createIdentity();
    final pool = ShearPoolClient(
      baseUrl: 'http://127.0.0.1:${server.port}',
      http: _realHttp(),
    );
    final ledger = ShearLedger(pool: pool);
    // Same call _boot uses: syncSpendable → syncTip → applyTipHex(stats.header).
    await ledger.syncSpendable(id.address);
    expect(ledger.tipHeight, 5);
    expect(ledger.lag1Root, header.sublist(68, 100));
    final paid = destForLogin(
      id.address,
      continuityRoot: header.sublist(68, 100),
      height: 5,
    );
    expect(ledger.currentDest(id.address), paid);
    expect(paid, isNot(id.address));
    expect(
      ledger.currentDest(id.address),
      isNot(destForLogin(id.address, height: 5)),
    );
    expect(
      ledger.currentDest(id.address),
      isNot(destForLogin(
        id.address,
        continuityRoot: header.sublist(68, 100),
        height: 5,
        viewKey: id.viewKey,
      )),
    );
  });

  test('Dart ShearHash matches C selftest vector 6e95b903…', () {
    final header = shearSelftestHeader();
    expect(header.length, 120);
    expect(header[0], 1);
    expect(header.sublist(1).every((b) => b == 0), isTrue);
    final got = shearHashHex(header);
    expect(got, shearSelftestHash);
    expect(shearSelftest(), isTrue);
    expect(dartHashRound(header), shearHash(header));
    final host = ShearMinerHost(desktopOverride: false);
    expect(host.hashBurst(count: 3), 3);
    expect(host.hashesRun, 3);
  });

  test('bundled miner path is next to the GUI on Windows and Linux', () {
    final win = ShearMinerHost.bundledPath(
      resolvedExecutable: r'C:\Shear\Shear.exe',
      windows: true,
    );
    expect(win, r'C:\Shear\shear-miner.exe');
    final linux = ShearMinerHost.bundledPath(
      resolvedExecutable: '/opt/shear/shear_wallet',
      windows: false,
    );
    expect(linux, '/opt/shear/shear-miner');
    final mac = ShearMinerHost.bundledPath(
      resolvedExecutable: '/Applications/Shear.app/Contents/MacOS/Shear',
      windows: false,
    );
    expect(mac, '/Applications/Shear.app/Contents/MacOS/shear-miner');
  });

  testWidgets('six Chronoflux tabs and light pool colors', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-ui-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger()));
    await tester.pump();
    expect(shearBg.value, 0xFFEEF3F8);
    expect(shearInk.value, 0xFF0D2137);
    final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.title, 'Shear 0.0.2');
    expect(kWalletVersion, '0.0.2');
    // password gate first
    await tester.enterText(find.byType(TextField), 'pw');
    await tester.tap(find.text('Unlock'));
    await tester.pump();
    expect(find.textContaining('Shear  0.0.2'), findsWidgets);
    for (final name in kTabs) {
      expect(find.text(name), findsWidgets);
    }
    expect(kExplains.length, kTabs.length);
    expect(kExplains.every((e) => e.length > 20), isTrue);
  });

  testWidgets('non-desktop Mine runs in-app ShearHash, not a single fake credit', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-mine-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    final id = await session.loadOrCreate();
    final ledger = ShearLedger();
    final miner = ShearMinerHost(desktopOverride: false);
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ledger,
      miner: miner,
    ));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'pw');
    await tester.tap(find.text('Unlock'));
    await tester.pump();
    await tester.tap(find.text('Resistance'));
    await tester.pump();
    expect(ledger.pending(id.address), 0);
    expect(miner.hashesRun, 0);
    await tester.tap(find.text('Mine'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 120));
    expect(miner.hashing, isTrue);
    expect(miner.hashesRun, greaterThan(1));
    expect(ledger.pending(id.address), closeTo(miner.hashesRun * 1e-9, 1e-12));
    expect(find.text('Mining…'), findsWidgets);
    await tester.tap(find.text('Stop'));
    await tester.pump();
    expect(miner.hashing, isFalse);
  });
}

HttpClient _realHttp() {
  // Flutter's test binding stubs `HttpClient()` to HTTP 400. The default
  // HttpOverrides.createHttpClient path is the real dart:io client.
  return _PassthroughHttpOverrides().createHttpClient(null)
    ..connectionTimeout = const Duration(seconds: 8);
}

class _PassthroughHttpOverrides extends HttpOverrides {}

Future<HttpServer> _fakePool({required String headerHex, required int height}) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((req) async {
    await req.drain();
    req.response.headers.contentType = ContentType.json;
    if (req.uri.path == '/api/stats') {
      req.response.write(jsonEncode({
        'ok': true,
        'height': height,
        'header': headerHex,
      }));
    } else if (req.uri.path == '/api/wallet/balance') {
      req.response.write(jsonEncode({'balance': 0, 'pending': 0}));
    } else if (req.uri.path == '/api/wallet/history' || req.uri.path == '/api/explorer/history') {
      req.response.write(jsonEncode({'txs': []}));
    } else if (req.uri.path == '/api/wallet/register') {
      req.response.write(jsonEncode({'ok': true}));
    } else {
      req.response.statusCode = 404;
      req.response.write('{}');
    }
    await req.response.close();
  });
  return server;
}
