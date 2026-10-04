import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_read_sync.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_session.dart';

void main() {
  test('an opened coin is what a send can draw, and a follow does not replace it', () async {
    final dir = Directory.systemTemp.createTempSync('c070-spend-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    await session.setPassword('test-pass-1');
    final id = session.identity!;
    final ledger = ShearLedger()..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberNote({
      'address': home,
      'dest': home,
      'verified': true,
      'height': 1,
      'amount': 1.0,
      'nanos': kUnitsPerShe,
      'commit': Uint8List(32)..[0] = 4,
      'r': Uint8List(32)..[0] = 5,
    });
    ledger.rememberDest(home);
    ledger.restoreSealedTip(20);
    ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);

    final opened = ledger.spendableOwned(id.address, paymentCode: id.paymentCode);
    expect(opened, closeTo(1.0, 1e-9));
    expect(
      paintedContinuumSpendable(ledger, id.address, paymentCode: id.paymentCode),
      closeTo(opened, 1e-12),
    );

    await ledger.followOffUi(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      full: false,
      chain: false,
      sessionPath: session.store.path,
      sessionPassword: session.password,
    );
    expect(
      ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(opened, 1e-9),
    );

    ledger.rememberNodeChain(notes: [
      {
        'dest': home,
        'kind': 'coinbase',
        'height': 2,
        'valueProof': {'v': 5 * kUnitsPerShe},
      },
    ]);
    ledger.creditKnownNodeLands();
    ledger.applyPoolSnapshot(
      home,
      {'balance': 9.0, 'pending': 1.0, 'owedPi': 3.0},
      beforeHeight: 20,
      tipSealed: 20,
    );
    final shown = ledger.spendableOwned(id.address, paymentCode: id.paymentCode);
    expect(shown, closeTo(opened, 1e-9));
    expect(
      paintedContinuumSpendable(ledger, id.address, paymentCode: id.paymentCode),
      closeTo(shown, 1e-12),
    );
    expect(ledger.owedTowardPi(id.address, paymentCode: id.paymentCode), isNot(shown));

    final cover = planLockFunding(
      ledger,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      needShe: 0.4,
    );
    expect(cover.have, closeTo(shown, 1e-9));
    final dest = vaultDest(id.address, viewKey: id.viewKey)!;
    final posted = await postReserveDeposit(
      ledger: ledger,
      reserve: ShearReserve(),
      restFrame: id.address,
      paymentCode: id.paymentCode,
      dest: dest,
      she: 0.4,
      depth: 0,
      spendSeed: hexToBytes(id.seedHex),
      local: true,
    );
    expect(posted.posted, isTrue);
    expect(
      ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      lessThan(shown),
    );
    expect(
      paintedContinuumSpendable(ledger, id.address, paymentCode: id.paymentCode),
      closeTo(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 1e-12),
    );
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('login reads node notes before height and a pool figure does not raise spendable', () async {
    final paths = <String>[];
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      paths.add(req.uri.path);
      req.response.headers.contentType = ContentType.json;
      final path = req.uri.path;
      if (path == '/notes' || path == '/api/wallet/notes') {
        req.response.write(jsonEncode({
          'ok': true,
          'notes': [
            {
              'dest': req.uri.queryParameters['address'] ?? '',
              'kind': 'coinbase',
              'height': 1,
              'valueProof': {'v': 5 * kUnitsPerShe},
            },
          ],
        }));
      } else if (path == '/stats' || path == '/api/stats') {
        req.response.write(jsonEncode({
          'ok': true,
          'height': 20,
          'balance': 9,
          'owedPi': 3,
        }));
      } else {
        req.response.statusCode = 500;
        req.response.write('{"ok":false}');
      }
      await req.response.close();
    });
    final dir = Directory.systemTemp.createTempSync('c070-first-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    await session.setPassword('test-pass-1');
    final id = session.identity!;
    final ledger = ShearLedger(pool: ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}'))
      ..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberNote({
      'address': home,
      'dest': home,
      'verified': true,
      'height': 1,
      'amount': 1.0,
      'nanos': kUnitsPerShe,
      'commit': Uint8List(32)..[0] = 7,
      'r': Uint8List(32)..[0] = 8,
    });
    ledger.rememberDest(home);
    ledger.restoreSealedTip(20);
    ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    final opened = ledger.spendableOwned(id.address, paymentCode: id.paymentCode);
    expect(opened, closeTo(1.0, 1e-9));

    await ledger.followOffUi(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      full: false,
      chain: true,
      spendableFirst: true,
      sessionPath: session.store.path,
      sessionPassword: session.password,
    );

    expect(debugCreditFollowKind, 'spendable');
    expect(paths, isNotEmpty);
    expect(paths.first.contains('notes'), isTrue);
    final notesAt = paths.indexWhere((p) => p.contains('notes'));
    final statsAt = paths.indexWhere((p) => p.contains('stats'));
    expect(notesAt, greaterThanOrEqualTo(0));
    expect(statsAt, greaterThan(notesAt));
    expect(paths.any((p) => p.contains('history')), isFalse);
    expect(paths.any((p) => p.contains('block')), isFalse);
    expect(paths.any((p) => p.contains('balance')), isFalse);
    expect(
      ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(opened, 1e-9),
    );
    expect(
      paintedContinuumSpendable(ledger, id.address, paymentCode: id.paymentCode),
      closeTo(opened, 1e-12),
    );
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('login with no live base reads node notes and a dead loopback does not paint spendable', () async {
    final paths = <String>[];
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      paths.add('${req.uri.path}?${req.uri.query}');
      req.response.headers.contentType = ContentType.json;
      final path = req.uri.path;
      if (path == '/notes' || path == '/api/wallet/notes') {
        req.response.write(jsonEncode({
          'ok': true,
          'notes': [
            {
              'dest': req.uri.queryParameters['address'] ?? '',
              'kind': 'coinbase',
              'height': 1,
              'valueProof': {'v': 50 * kUnitsPerShe},
            },
          ],
        }));
      } else if (path == '/stats' || path == '/api/stats') {
        req.response.write(jsonEncode({
          'ok': true,
          'height': 387,
          'header': 'aa',
          'network': kBookMagic,
          'magic': kBookMagic,
          'balance': 12,
        }));
      } else {
        req.response.statusCode = 404;
        req.response.write('{"ok":false}');
      }
      await req.response.close();
    });
    final dir = Directory.systemTemp.createTempSync('c070-discover-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    await session.setPassword('test-pass-1');
    final id = session.identity!;
    final live = 'http://127.0.0.1:${server.port}';
    final sync = ShearReadSync(
      seeds: [live, 'http://127.0.0.1:1', 'https://pool.shear.digital'],
      jitter: Duration.zero,
    );
    final ledger = ShearLedger(pool: ShearPoolClient(sync: sync))..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberNote({
      'address': home,
      'dest': home,
      'verified': true,
      'height': 1,
      'amount': 1.0,
      'nanos': kUnitsPerShe,
      'commit': Uint8List(32)..[0] = 9,
      'r': Uint8List(32)..[0] = 4,
    });
    ledger.rememberDest(home);
    ledger.restoreSealedTip(387);
    ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(1.0, 1e-9));
    expect(sync.liveBase, isNull);

    await ledger.followOffUi(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      full: false,
      chain: true,
      spendableFirst: true,
      sessionPath: session.store.path,
      sessionPassword: session.password,
    );

    expect(debugCreditFollowKind, 'spendable');
    expect(paths.where((p) => p.contains('notes')), isNotEmpty);
    expect(paths.where((p) => p.contains('stats')), isNotEmpty);
    expect(paths.any((p) => p.contains('history')), isFalse);
    expect(paths.any((p) => p.contains('block')), isFalse);
    expect(
      ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(1.0, 1e-9),
    );

    paths.clear();
    await ledger.syncTip(proveChain: false);
    expect(paths.where((p) => p.contains('stats')), isNotEmpty);
    expect(paths.any((p) => p.contains('/block')), isFalse);
    expect(paths.any((p) => p.contains('compact')), isFalse);
    expect(sync.liveBase, live);
    expect(ledger.sealedHeight, 387);

    final mainSrc = File('lib/main.dart').readAsStringSync();
    expect('syncTip(proveChain: false)'.allMatches(mainSrc).length, greaterThanOrEqualTo(2));
    expect(mainSrc, contains('if (!_hostAndroid && !widget.skipPoolSync)'));
  }, timeout: const Timeout(Duration(minutes: 2)));
}
