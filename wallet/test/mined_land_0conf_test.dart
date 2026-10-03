import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_read_sync.dart';

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

/// Node compact page for one owner land at the tip. No pool process.
Future<({HttpServer server, List<String> paths})> _node(String dest, int tip) async {
  final paths = <String>[];
  final header = _hexHeader();
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((req) async {
    paths.add(req.uri.path);
    req.response.headers.contentType = ContentType.json;
    final path = req.uri.path;
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
    } else if (path == '/blocks' || path == '/compactblocks') {
      final from = int.tryParse(req.uri.queryParameters['from'] ?? '') ?? 1;
      final to = int.tryParse(req.uri.queryParameters['to'] ?? '') ?? tip;
      req.response.write(jsonEncode({
        'ok': true,
        'from': from,
        'to': to,
        'blocks': [
          for (var h = from; h <= to && h <= tip; h++)
            h == tip ? _landBody(h, dest, 1) : {'height': h, 'header': header, 'txs': <Object>[]},
        ],
      }));
    } else if (path == '/block' || path == '/compactblock') {
      final h = int.tryParse(req.uri.queryParameters['height'] ?? '') ?? tip;
      req.response.write(jsonEncode(h == tip ? _landBody(h, dest, 1) : {'height': h, 'header': header, 'txs': <Object>[]}));
    } else if (path == '/jroot' || path == '/api/wallet/jroot' || path == '/fluxset' || path == '/api/wallet/fluxset') {
      req.response.write(jsonEncode({'ok': true, 'jroot': List.filled(64, 'ab').join()}));
    } else {
      req.response.statusCode = 404;
      req.response.write(jsonEncode({'ok': false}));
    }
    await req.response.close();
  });
  return (server: server, paths: paths);
}

void main() {
  test('a mined landing reaches Pending at 0 conf from node compact proofs on Bare, p2P, and Full with no pool ticket', () async {
    const tip = 4;
    final id = createIdentity();
    final home = ShearLedger()..bindIdentity(id);
    final dest = home.homeDest(id.address, paymentCode: id.paymentCode);
    final node = await _node(dest, tip);
    addTearDown(() => node.server.close(force: true));
    final base = 'http://127.0.0.1:${node.server.port}';

    Future<void> land(ClosureSendMode mode) async {
      final before = node.paths.length;
      final sync = ShearReadSync(
        seeds: [base],
        http: HttpClient()..connectionTimeout = const Duration(seconds: 8),
        jitter: Duration.zero,
      );
      sync.proofDest = dest;
      sync.proofDests = [dest];
      await sync.followTip();
      final fetched = node.paths.sublist(before);
      expect(fetched.any((p) => p == '/blocks' || p == '/compactblocks'), isTrue, reason: '$mode compact');
      expect(fetched.any((p) => p.contains('ticket')), isFalse, reason: '$mode ticket');
      expect(sync.readBlocks.any((b) => b['height'] == tip), isTrue, reason: '$mode body');

      final ledger = ShearLedger()..bindIdentity(id);
      ledger.rememberDest(dest);
      if (mode == ClosureSendMode.connectBare) {
        sync.proofSink = ledger;
        sync.openConnectBare(
          blocks: sync.readBlocks,
          readHeights: sync.readHeights,
          liveTip: sync.sampledTip,
          dest: dest,
        );
      } else {
        final side = ShearNodeSidecar();
        side.select(mode);
        await side.apply();
        expect(side.committed, mode);
        side.proofSink = ledger;
        side.holdReadBlocks(
          sync.readBlocks,
          dest: dest,
          readHeights: sync.readHeights,
          liveTip: sync.sampledTip,
        );
        await side.openWhileCatchingUpOffUi();
      }

      final pending = ledger.pendingTxs(id.address).where((t) => t.kind == 'blockfound' && t.height == tip).toList();
      final view = ledger.shearviewTxs(id.address).where((t) => t.kind == 'blockfound' && t.height == tip).toList();
      expect(pending, isNotEmpty, reason: '$mode pending');
      expect(view, isNotEmpty, reason: '$mode shearview');
      expect(pending.single.to, dest);
      expect(view.single.to, dest);
      expect(pending.single.amount, closeTo(1, 1e-12));
      // Including block counts as 1. The row is the immature landing: under
      // the 9-conf spendable floor, so Pending shows it at 0-conf maturity.
      expect(ledger.confirmationsOf(tip), 1);
      expect(ledger.confirmationsOf(tip), lessThan(ShearLedger.spendableConfirmations));
      expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
      expect(view.map((t) => t.height).toSet(), pending.map((t) => t.height).toSet());
    }

    await land(ClosureSendMode.connectBare);
    await land(ClosureSendMode.localNode);
    await land(ClosureSendMode.localNodeFull);
    expect(node.paths.any((p) => p.contains('ticket')), isFalse);
  });
}
