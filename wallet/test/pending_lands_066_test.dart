import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_cli.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_read_sync.dart';

class _PassthroughHttpOverrides extends HttpOverrides {}

HttpClient _http() =>
    _PassthroughHttpOverrides().createHttpClient(null)
      ..connectionTimeout = const Duration(seconds: 8);

String _hexHeader() => List.filled(128, 0x11).map((b) => b.toRadixString(16).padLeft(2, '0')).join();

Map<String, dynamic> _landBody(int height, String dest, double she) => {
      'height': height,
      'header': _hexHeader(),
      'txs': [
        {
          'coinbase': true,
          'vout': [
            {'dest': dest, 'kind': 'coinbase', 'amount': she},
          ],
        },
      ],
    };

void main() {
  test('package pin and CLI pin are Continuum 0.70', () {
    expect(kWalletVersion, '0.70');
    expect(kCliVersion, '0.70');
    expect(File('pubspec.yaml').readAsStringSync(), contains('version: 0.70.0+95'));
    expect(kBookMagic, 'shear-testnet-v10');
    final sync = ShearReadSync(jitter: Duration.zero);
    expect(sync.seeds.first, kLocalNodeRpc);
    expect(sync.seeds.contains(kPublicPoolHttp), isFalse);
    expect(sync.seeds.contains(kLocalPoolHttp), isFalse);
    expect(sync.seeds.contains('https://p2p.shear.digital'), isTrue);
    final poolOnly = chainPaintFromPoolPayload({
      'height': 40,
      'header': _hexHeader(),
      'hashrate': 999,
      'circulatingNanos': 5 * kUnitsPerShe,
      'bits': 12,
      'balance': 8,
      'owedPi': 3,
    });
    expect(poolOnly.usable, isFalse);
    expect(poolOnly.tip, 0);
    expect(poolOnly.hashrate, isNull);
    expect(poolOnly.circulatingNanos, isNull);
    expect(poolOnly.bits, isNull);
    final node = chainPaintFromNodeStats({
      'height': 9,
      'header': _hexHeader(),
      'hashrate': 100,
      'circulatingNanos': 2 * kUnitsPerShe,
      'bits': 16,
      'magic': kBookMagic,
    });
    expect(node.usable, isTrue);
    expect(node.tip, 9);
    expect(node.hashrate, 100);
    expect(node.bits, 16);
    expect(node.circulatingNanos, 2 * kUnitsPerShe);
    expect(chainPaintFromNodeStats(null).usable, isFalse);
  });

  test('tip delta above 1 credits every node land in the gap', () {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberDest(dest);
    ledger.rememberNodeChain(bodies: [
      for (final h in const [5, 6, 7]) _landBody(h, dest, 1),
    ]);
    ledger.applyTipHex(_hexHeader(), sealedHeight: 7);
    final lands = ledger.pendingTxs(id.address).where((t) => t.kind == 'blockfound').toList();
    expect(lands.map((t) => t.height).toSet(), {5, 6, 7});
    expect(lands.length, 3);
    expect(lands.map((t) => t.to).toSet(), {dest});
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
    expect(ledger.honestLandMisses, containsAll([1, 2, 3, 4]));
    expect(ledger.honestLandMisses.contains(5), isFalse);
  });

  test('a hole in the node gap is an honest miss, not a pool fill', () {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberDest(dest);
    ledger.rememberNodeChain(bodies: [
      _landBody(5, dest, 1),
      _landBody(7, dest, 1),
    ]);
    ledger.applyTipHex(_hexHeader(), sealedHeight: 7);
    final heights = ledger.pendingTxs(id.address).where((t) => t.kind == 'blockfound').map((t) => t.height).toSet();
    expect(heights, {5, 7});
    expect(ledger.honestLandMisses, contains(6));
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
  });

  test('a land mined to another money dest stays on that dest', () {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final other = encodeDestAddress(Uint8List.fromList(List.filled(20, 9)));
    expect(other, isNot(home));
    ledger.rememberDest(home);
    ledger.rememberDest(other);
    ledger.rememberNodeChain(bodies: [
      _landBody(3, other, 1.25),
    ]);
    ledger.applyTipHex(_hexHeader(), sealedHeight: 3);
    final rows = ledger.transactions.where((t) => t.kind == 'blockfound' || t.kind == 'mine').toList();
    expect(rows.single.to, other);
    expect(rows.single.height, 3);
    expect(rows.single.amount, closeTo(1.25, 1e-12));
    expect(ledger.pendingTxs(other).single.to, other);
    expect(ledger.pendingTxs(id.address).any((t) => t.to == home && t.kind == 'blockfound'), isFalse);
  });

  test('empty node history does not stamp caught-up while an owner land is absent', () async {
    final id = createIdentity();
    final header = _hexHeader();
    var historyHits = 0;
    var notesHits = 0;
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      if (req.uri.path.contains('history')) historyHits += 1;
      if (req.uri.path.contains('notes')) notesHits += 1;
      req.response.headers.contentType = ContentType.json;
      if (req.uri.path == '/stats' || req.uri.path == '/api/stats') {
        req.response.write(jsonEncode({
          'ok': true,
          'height': 4,
          'header': header,
          'magic': kBookMagic,
          'network': kBookMagic,
        }));
      } else if (req.uri.path == '/headers' || req.uri.path == '/api/explorer/headers') {
        req.response.write(jsonEncode({
          'ok': true,
          'headers': [
            {'height': 1, 'header': header},
          ],
        }));
      } else if (req.uri.path == '/header' || req.uri.path == '/api/explorer/header') {
        req.response.write(jsonEncode({'ok': true, 'height': 1, 'header': header}));
      } else if (req.uri.path.contains('history')) {
        req.response.write(jsonEncode({'ok': true, 'txs': <Object>[], 'amountsOnly': false, 'destProof': true}));
      } else if (req.uri.path.contains('notes')) {
        req.response.write(jsonEncode({'ok': true, 'notes': <Object>[]}));
      } else if (req.uri.path.contains('balance')) {
        req.response.write(jsonEncode({'balance': 0, 'pending': 0, 'incoming': <Object>[]}));
      } else {
        req.response.write(jsonEncode({'ok': true}));
      }
      await req.response.close();
    });
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _http());
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberDest(dest);
    ledger.rememberNodeChain(bodies: [_landBody(4, dest, 1)]);
    ledger.restoreSealedTip(4);
    expect(ledger.pendingTxs(id.address).where((t) => t.kind == 'blockfound'), isEmpty);
    await ledger.syncHistory(dest);
    expect(historyHits, 1);
    expect(ledger.historyStamped(dest), isFalse);
    expect(ledger.historyBehindTip, isTrue);
    expect(
      shouldFullSyncCredits(
        hasPendingReceive: false,
        historyBehindTip: ledger.historyBehindTip,
      ),
      isTrue,
    );
    await ledger.syncHistory(dest);
    expect(historyHits, 2);
    expect(ledger.historyStamped(dest), isFalse);
    expect(ledger.pendingTxs(id.address).where((t) => t.kind == 'blockfound'), isEmpty);
    await ledger.syncCredits(id.address, paymentCode: id.paymentCode);
    expect(historyHits, greaterThan(2));
    expect(notesHits, greaterThan(0));
    expect(
      ledger.pendingTxs(id.address).where((t) => t.kind == 'blockfound' && t.height == 4),
      isNotEmpty,
    );
  });

  test('pending admits height-less unconfirmed blockfound, coinbase, and mine', () {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    for (final kind in const ['blockfound', 'coinbase', 'mine']) {
      ledger.mergeChainTx(ShearTx(
        id: 'open-$kind',
        from: 'coinbase',
        to: dest,
        amount: 1,
        kind: kind,
        confirmed: false,
      ));
    }
    final pending = ledger.pendingTxs(id.address);
    for (final kind in const ['blockfound', 'coinbase', 'mine']) {
      expect(
        pending.any((t) => (t.height ?? 0) < 1 && (t.kind == kind || t.kind == 'blockfound')),
        isTrue,
        reason: kind,
      );
    }
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
  });

  test('Shearview lists a just-landed owner land and Spendable waits for 9', () {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberDest(dest);
    ledger.rememberNodeChain(bodies: [_landBody(5, dest, 1)]);
    ledger.applyTipHex(_hexHeader(), sealedHeight: 5);
    expect(ledger.confirmationsOf(5), 1);
    expect(ledger.shearviewTxs(id.address).any((t) => t.kind == 'blockfound' && t.height == 5), isTrue);
    expect(ledger.pendingTxs(id.address).any((t) => t.kind == 'blockfound' && t.height == 5), isTrue);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
    ledger.mergeChainTx(ShearTx(
      id: 'ahead',
      from: 'coinbase',
      to: dest,
      amount: 0.5,
      kind: 'blockfound',
      height: 20,
      confirmed: false,
    ));
    expect(ledger.confirmationsOf(20), 0);
    expect(ledger.shearviewTxs(id.address).any((t) => t.height == 20), isTrue);
    ledger.applyTipHex(_hexHeader(), sealedHeight: 13);
    expect(ledger.confirmationsOf(5), 9);
    expect(ledger.pendingTxs(id.address).where((t) => t.height == 5), isEmpty);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(1, 1e-9));
  });

  test('pool balance and owed-pi add neither a pending land nor spendable', () {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberDest(dest);
    ledger.applyTipHex(_hexHeader(), sealedHeight: 4);
    ledger.applyPoolSnapshot(
      dest,
      {'balance': 9.0, 'pending': 1.0, 'owedPi': 4.0, 'confirmingPot': 4.0},
      beforeHeight: 4,
      tipSealed: 8,
    );
    expect(ledger.pendingTxs(id.address).where((t) => t.kind == 'blockfound' || t.kind == 'coinbase' || t.kind == 'mine'), isEmpty);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
    expect(ledger.honestLandMisses, [5, 6, 7, 8]);
  });

  test('tip move and closure apply clear history stamps while a land is still out', () async {
    final id = createIdentity();
    final header = _hexHeader();
    var historyHits = 0;
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      if (req.uri.path.contains('history')) historyHits += 1;
      req.response.headers.contentType = ContentType.json;
      if (req.uri.path == '/stats' || req.uri.path == '/api/stats') {
        req.response.write(jsonEncode({
          'ok': true,
          'height': 6,
          'header': header,
          'magic': kBookMagic,
          'network': kBookMagic,
        }));
      } else if (req.uri.path.contains('history')) {
        req.response.write(jsonEncode({'ok': true, 'txs': <Object>[], 'amountsOnly': false, 'destProof': true}));
      } else if (req.uri.path == '/headers' || req.uri.path == '/api/explorer/headers') {
        req.response.write(jsonEncode({
          'ok': true,
          'headers': [
            {'height': 1, 'header': header},
          ],
        }));
      } else if (req.uri.path == '/header' || req.uri.path == '/api/explorer/header') {
        req.response.write(jsonEncode({'ok': true, 'height': 1, 'header': header}));
      } else {
        req.response.write(jsonEncode({'ok': true, 'balance': 0, 'pending': 0, 'notes': <Object>[]}));
      }
      await req.response.close();
    });
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _http());
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberDest(dest);
    ledger.restoreSealedTip(4);
    await ledger.syncHistory(dest);
    expect(historyHits, 1);
    expect(ledger.historyStamped(dest), isTrue);
    ledger.applyTipHex(header, sealedHeight: 5);
    expect(ledger.historyStamped(dest), isFalse);
    expect(ledger.notesStamped(dest), isFalse);
    expect(ledger.historyBehindTip, isTrue);
    expect(ledger.tipAdvancedWithoutLanding, isTrue);
    expect(
      shouldFullSyncCredits(
        hasPendingReceive: false,
        historyBehindTip: false,
        tipMovedWithoutLanding: true,
      ),
      isTrue,
    );
    expect(
      shouldFullSyncCredits(
        hasPendingReceive: true,
        historyBehindTip: false,
      ),
      isFalse,
    );
    await ledger.syncHistory(dest);
    expect(historyHits, 2);
    expect(ledger.historyStamped(dest), isTrue);
    ledger.onClosureApply();
    expect(ledger.historyStamped(dest), isFalse);
    expect(ledger.historyBehindTip, isTrue);
    ledger.rememberNodeChain(bodies: [_landBody(6, dest, 1)]);
    await ledger.syncHistory(dest);
    expect(historyHits, 3);
    expect(ledger.historyStamped(dest), isFalse);
    expect(ledger.pendingTxs(id.address).where((t) => t.kind == 'blockfound'), isEmpty);
    ledger.applyTipHex(header, sealedHeight: 6);
    expect(ledger.pendingTxs(id.address).any((t) => t.kind == 'blockfound' && t.height == 6), isTrue);
    expect(ledger.historyStamped(dest), isFalse);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
  });

  test('Bare hydrate lists node compact lands when pool /blocks is 404', () async {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberDest(dest);
    final header = _hexHeader();
    final poolHits = <String>[];
    final pool = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => pool.close(force: true));
    pool.listen((req) async {
      poolHits.add(req.uri.path);
      req.response.statusCode = 404;
      req.response.write('missing');
      await req.response.close();
    });
    final nodeHits = <String>[];
    final node = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => node.close(force: true));
    node.listen((req) async {
      nodeHits.add(req.uri.path);
      req.response.headers.contentType = ContentType.json;
      final path = req.uri.path;
      if (path == '/stats' || path == '/api/stats') {
        req.response.write(jsonEncode({
          'ok': true,
          'height': 3,
          'header': header,
          'magic': kBookMagic,
          'network': kBookMagic,
        }));
      } else if (path == '/headers' || path == '/api/explorer/headers') {
        final from = int.tryParse(req.uri.queryParameters['from'] ?? '') ?? 1;
        final to = int.tryParse(req.uri.queryParameters['to'] ?? '') ?? from;
        req.response.write(jsonEncode({
          'ok': true,
          'headers': [
            for (var h = from; h <= to && h <= 3; h++) {'height': h, 'header': header},
          ],
        }));
      } else if (path == '/header' || path == '/api/explorer/header') {
        req.response.write(jsonEncode({'ok': true, 'height': 1, 'header': header}));
      } else if (path == '/blocks' || path == '/compactblocks') {
        final from = int.tryParse(req.uri.queryParameters['from'] ?? '') ?? 1;
        final to = int.tryParse(req.uri.queryParameters['to'] ?? '') ?? 3;
        req.response.write(jsonEncode({
          'ok': true,
          'from': from,
          'to': to,
          'blocks': [
            for (var h = from; h <= to && h <= 3; h++) _landBody(h, dest, 1),
          ],
        }));
      } else if (path == '/jroot' || path == '/api/wallet/jroot' || path == '/fluxset') {
        req.response.write(jsonEncode({'ok': true, 'jroot': List.filled(64, '0').join()}));
      } else {
        req.response.statusCode = 404;
        req.response.write(jsonEncode({'ok': false}));
      }
      await req.response.close();
    });
    final sync = ShearReadSync(
      seeds: ['http://127.0.0.1:${node.port}'],
      http: _http(),
      jitter: Duration.zero,
    );
    sync.proofSink = ledger;
    sync.proofDest = dest;
    sync.proofDests = [dest];
    await sync.followTip();
    expect(nodeHits, contains('/blocks'));
    expect(poolHits, isEmpty);
    expect(sync.liveBase, 'http://127.0.0.1:${node.port}');
    final lands = ledger.pendingTxs(id.address).where((t) => t.kind == 'blockfound').map((t) => t.height).toSet();
    expect(lands, {1, 2, 3});
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
    expect(poolHits.where((p) => p == '/blocks'), isEmpty);
  });

  test('history blockfound stays spendable after the node balance snapshot', () async {
    final id = createIdentity();
    final probe = ShearLedger()..bindIdentity(id);
    final dest = probe.homeDest(id.address, paymentCode: id.paymentCode);
    final header = _hexHeader();
    const tip = 13;
    var balance = 0.0;
    var historyHits = 0;
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      final path = req.uri.path;
      if (path.contains('history')) historyHits += 1;
      req.response.headers.contentType = ContentType.json;
      if (path == '/stats' || path == '/api/stats') {
        req.response.write(jsonEncode({
          'ok': true,
          'height': tip,
          'header': header,
          'magic': kBookMagic,
          'network': kBookMagic,
        }));
      } else if (path == '/headers' || path == '/api/explorer/headers') {
        final from = int.tryParse(req.uri.queryParameters['from'] ?? '') ?? 1;
        final to = int.tryParse(req.uri.queryParameters['to'] ?? '') ?? from;
        req.response.write(jsonEncode({
          'ok': true,
          'headers': [
            for (var h = from; h <= to && h <= tip; h++) {'height': h, 'header': header},
          ],
        }));
      } else if (path == '/header' || path == '/api/explorer/header') {
        req.response.write(jsonEncode({'ok': true, 'height': 1, 'header': header}));
      } else if (path.contains('history')) {
        // Same shape as node walletHistoryFor: blockfound id, nanos, no amount.
        req.response.write(jsonEncode({
          'ok': true,
          'amountsOnly': false,
          'destProof': true,
          'txs': [
            {
              'id': 'blockfound:5:$dest',
              'kind': 'blockfound',
              'from': 'coinbase',
              'to': dest,
              'nanos': kUnitsPerShe,
              'height': 5,
              'confirmed': true,
            },
            {
              'id': 'blockfound:$tip:$dest',
              'kind': 'blockfound',
              'from': 'coinbase',
              'to': dest,
              'nanos': kUnitsPerShe,
              'height': tip,
              'confirmed': false,
            },
          ],
        }));
      } else if (path.contains('notes')) {
        req.response.write(jsonEncode({'ok': true, 'notes': <Object>[]}));
      } else if (path.contains('balance')) {
        req.response.write(jsonEncode({
          'ok': true,
          'balance': balance,
          'pending': 0,
          'owedPi': 0,
          'incoming': <Object>[],
        }));
      } else {
        req.response.write(jsonEncode({'ok': true}));
      }
      await req.response.close();
    });
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _http());
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    ledger.rememberDest(dest);
    await ledger.syncCredits(id.address, paymentCode: id.paymentCode);
    expect(historyHits, greaterThan(0));
    expect(ledger.sealedHeight, tip);
    expect(ledger.confirmationsOf(5), 9);
    expect(ledger.pendingTxs(id.address).where((t) => t.height == 5), isEmpty);
    expect(ledger.pendingTxs(id.address).any((t) => t.kind == 'blockfound' && t.height == tip), isTrue);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(1, 1e-9));
    balance = 1;
    await ledger.syncCredits(id.address, paymentCode: id.paymentCode);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(1, 1e-9));
    balance = 0;
    await ledger.syncBalancesOnly(id.address, paymentCode: id.paymentCode);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(1, 1e-9));
    ledger.applyPoolSnapshot(
      dest,
      {'balance': 0, 'pending': 0, 'owedPi': 0},
      beforeHeight: ledger.sealedHeight,
      tipSealed: ledger.sealedHeight,
    );
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(1, 1e-9));
    ledger.applyPoolSnapshot(
      dest,
      {'balance': 1, 'pending': 0},
      beforeHeight: ledger.sealedHeight,
      tipSealed: ledger.sealedHeight,
    );
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(1, 1e-9));
    ledger.applyPoolSnapshot(
      dest,
      {'balance': 9, 'pending': 4, 'owedPi': 3},
      beforeHeight: ledger.sealedHeight,
      tipSealed: ledger.sealedHeight,
    );
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(1, 1e-9));
    expect(ledger.pendingTxs(id.address).where((t) => t.height == 5), isEmpty);
    expect(ledger.pendingTxs(id.address).any((t) => t.height == tip), isTrue);
  });
}
