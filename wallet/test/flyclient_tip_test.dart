import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_hash.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_read_sync.dart';
import 'package:shear_wallet/shear_session.dart';

String _le(int value, int bytes) {
  final b = Uint8List(bytes);
  var n = value;
  for (var i = 0; i < bytes; i++) {
    b[i] = n & 0xff;
    n >>= 8;
  }
  return b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
}

/// 24 leading zero bits. Under a 17-bit target, over a zero-work header.
String _digest(int n) => '000000${n.toRadixString(16).padLeft(58, 'a')}'.substring(0, 64);

String _header({required String prev, int bits = 17 * 65536, int timestamp = 1700000000000}) {
  final hex = _le(1, 4) +
      prev.padLeft(64, '0') +
      ('11' * 32) +
      ('22' * 32) +
      _le(timestamp, 8) +
      _le(bits, 4) +
      _le(1, 8) +
      _le(1, 8);
  if (hex.length != 256) throw StateError('header ${hex.length}');
  return hex;
}

class _Chain {
  _Chain(this.tip) {
    var prev = '00' * 32;
    for (var h = 1; h <= tip; h++) {
      headers[h] = _header(prev: prev);
      hashes[h] = _digest(h);
      prev = hashes[h]!;
    }
  }

  final int tip;
  final headers = <int, String>{};
  final hashes = <int, String>{};
}

Future<HttpServer> _serve(_Chain chain, List<String> paths, {bool spoilAbove = false}) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((req) async {
    paths.add(req.uri.path + (req.uri.hasQuery ? '?${req.uri.query}' : ''));
    req.response.headers.contentType = ContentType.json;
    final height = int.tryParse(req.uri.queryParameters['height'] ?? '') ?? 0;
    if (req.uri.path == '/stats' || req.uri.path == '/api/stats') {
      req.response.write(jsonEncode({
        'ok': true,
        'height': chain.tip,
        'magic': 'shear-testnet-v11',
        'network': 'shear-testnet-v11',
        'header': chain.headers[1],
      }));
    } else if (req.uri.path == '/headers' || req.uri.path == '/api/explorer/headers') {
      req.response.write(jsonEncode({
        'ok': true,
        'headers': [
          {'height': 1, 'header': chain.headers[1], 'hash': chain.hashes[1]},
        ],
      }));
    } else if (req.uri.path == '/header' || req.uri.path == '/api/explorer/header') {
      final bad = spoilAbove && height > 1;
      req.response.write(jsonEncode({
        'ok': true,
        'height': height,
        'header': bad ? 'abcd' : (chain.headers[height] ?? ''),
        'hash': bad ? '00' : (chain.hashes[height] ?? ''),
      }));
    } else if (req.uri.path.contains('notes') ||
        req.uri.path.contains('balance') ||
        req.uri.path.contains('history') ||
        req.uri.path == '/api/wallet/send') {
      req.response.statusCode = 500;
      req.response.write('{"ok":false}');
    } else {
      req.response.statusCode = 404;
      req.response.write('{"ok":false}');
    }
    await req.response.close();
  });
  return server;
}

void main() {
  test('a claimed digest meets packed 17 bits only when it is under the target', () {
    final easy = List<int>.filled(32, 0);
    final hard = List<int>.filled(32, 0xff);
    expect(shearMeetsTarget(easy, 17 * 65536), isTrue);
    expect(shearMeetsTarget(hard, 17 * 65536), isFalse);
    expect(shearMeetsTarget(easy, 17), isTrue);
    expect(shearMeetsTarget(hard, 17), isFalse);
  });

  test('Connect bare samples the heaviest honest tip and does not read notes', () async {
    final good = _Chain(6);
    final tall = _Chain(20);
    tall.headers[1] = good.headers[1]!;
    tall.hashes[1] = good.hashes[1]!;
    final paths = <String>[];
    final bad = await _serve(tall, paths, spoilAbove: true);
    final live = await _serve(good, paths);
    addTearDown(() => bad.close(force: true));
    addTearDown(() => live.close(force: true));
    final sync = ShearReadSync(
      seeds: [
        'http://127.0.0.1:${bad.port}',
        'http://127.0.0.1:${live.port}',
      ],
      http: HttpClient()..connectionTimeout = const Duration(seconds: 2),
      jitter: Duration.zero,
    );
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.confirmRound(address: id.address, pot: 1, height: 1);
    ledger.settleTo(ShearLedger.spendableConfirmations);
    final before = ledger.spendable(dest);
    await sync.sampleFlyclient();
    expect(sync.flyclientOk, isTrue);
    expect(sync.flyclientTip, 6);
    expect(sync.flyclientTip, isNot(20));
    expect(sync.flyclientFetched.length, lessThan(20));
    expect(sync.flyclientFetched, contains('/header?height=6'));
    expect(paths.any((p) => p.contains('notes')), isFalse);
    expect(paths.any((p) => p.contains('balance')), isFalse);
    expect(paths.any((p) => p.contains('history')), isFalse);
    expect(paths.any((p) => p.contains('address')), isFalse);
    expect(paths.any((p) => p.contains('/api/wallet/send')), isFalse);
    expect(paths.any((p) => p.contains('/header')), isTrue);
    expect(ledger.spendable(dest), before);
    expect(connectBareLinkWord(
      sampling: false,
      sampleOk: true,
      sampleFailed: false,
      sampleTip: sync.flyclientTip,
      noteTip: 0,
    ), 'CONNECTED');
    expect(connectBareLinkWord(
      sampling: false,
      sampleOk: true,
      sampleFailed: false,
      sampleTip: sync.flyclientTip,
      noteTip: 40,
      sampleGenesis: 'aa',
      noteGenesis: 'bb',
    ), 'tip disagree');
  });

  test('a pre-genesis session drops height 20 and a new genesis seeks height 1', () {
    final stale = scrubStaleBookCache({
      'seedHex': 'ab',
      'sealedHeight': 20,
      'chainGenesis': 'stub',
      'txs': [
        {'kind': 'pool-fee', 'height': 20},
      ],
      'openedProofs': [
        {'k': 'aa|bb|cc', 'n': 1000000000},
      ],
      'notes': [
        {'verified': true, 'height': 20},
      ],
      'notesCovered': 20,
      'dests': ['ssa1qexample'],
    });
    expect(stale['seedHex'], 'ab');
    expect(stale['sealedHeight'], 0);
    expect(stale.containsKey('chainGenesis'), isFalse);
    expect(stale['txs'], isEmpty);
    expect(stale['openedProofs'], isEmpty);
    expect(stale['notes'], isEmpty);
    expect(stale['notesCovered'], 0);
    expect(stale['dests'], ['ssa1qexample']);
    expect(stale['bookCacheGen'], kLiveBookCacheGen);
    final kept = scrubStaleBookCache({
      'bookCacheGen': kLiveBookCacheGen,
      'sealedHeight': 4,
      'chainGenesis': 'live',
    });
    expect(kept['sealedHeight'], 4);
    expect(kept['chainGenesis'], 'live');

    final ledger = ShearLedger();
    ledger.restoreSealedTip(20, genesis: 'stub');
    ledger.restoreOpenedProofs([
      {'k': 'aa|bb|cc', 'n': 1000000000},
    ]);
    expect(ledger.sealedHeight, 20);
    expect(ledger.exportOpenedProofs(), isNotEmpty);
    ledger.bindChainGenesis('v11-genesis');
    expect(ledger.sealedHeight, 0);
    expect(ledger.chainGenesis, 'v11-genesis');
    expect(ledger.exportOpenedProofs(), isEmpty);
    expect(flyclientTipDisagrees(
      sampleTip: 1,
      noteTip: ledger.sealedHeight,
      sampleGenesis: 'v11-genesis',
      noteGenesis: ledger.chainGenesis,
    ), isFalse);
    ledger.noteLiveHeight(1);
    expect(ledger.sealedHeight, 1);
    expect(ledger.displayHeight, 1);
  });

  test('a failed sample is not CONNECTED and a one-block gap is not a disagree', () {
    expect(flyclientSampleHeights(387).length, lessThan(387));
    expect(flyclientSampleHeights(387), containsAll([1, 387]));
    expect(flyclientTipDisagrees(sampleTip: 40, noteTip: 39), isFalse);
    expect(flyclientTipDisagrees(sampleTip: 40, noteTip: 10), isTrue);
    expect(flyclientTipDisagrees(sampleTip: 40, noteTip: 0), isFalse);
    expect(connectBareLinkWord(
      sampling: false,
      sampleOk: false,
      sampleFailed: true,
      sampleTip: 0,
      noteTip: 12,
    ), 'sample failed');
    expect(connectBareLinkWord(
      sampling: true,
      sampleOk: false,
      sampleFailed: false,
      sampleTip: 0,
      noteTip: 0,
    ), 'SYNCING');
    expect(connectBareLinkWord(
      sampling: false,
      sampleOk: false,
      sampleFailed: false,
      sampleTip: 0,
      noteTip: 0,
    ), 'not connected');
  });

  test('Connect bare and local node keep the tip unless the book changes', () async {
    final side = ShearNodeSidecar(
      nodeBinary: 'node',
      dataDir: '/tmp/shear-fly-handoff',
      emptyDatadir: false,
      startProcess: (binary, env, args) async {},
    );
    side.adoptBookPin(genesis: 'aa', magic: 'shear-testnet-v11', trustedTip: 40);
    side.select(ClosureSendMode.localNode);
    await side.apply();
    expect(side.committed, ClosureSendMode.localNode);
    expect(side.seekerTip, 40);
    expect(side.rescanFromGenesis, isFalse);
    side.select(ClosureSendMode.connectBare);
    await side.apply();
    expect(side.committed, ClosureSendMode.connectBare);
    expect(side.running, isFalse);
    expect(side.seekerTip, 40);
    expect(side.rescanFromGenesis, isFalse);
    side.adoptBookPin(genesis: 'bb', magic: 'shear-testnet-v11', trustedTip: 40);
    expect(side.rescanFromGenesis, isTrue);
    expect(side.seekerTip, 0);
    final kept = modeHandoff(
      trustedTip: 40,
      fromGenesis: 'aa',
      toGenesis: 'aa',
      fromMagic: 'shear-testnet-v11',
      toMagic: 'shear-testnet-v11',
    );
    expect(kept.rescanFromGenesis, isFalse);
    expect(kept.tip, 40);
    final changed = modeHandoff(
      trustedTip: 40,
      fromMagic: 'shear-testnet-v10',
      toMagic: 'shear-testnet-v11',
    );
    expect(changed.rescanFromGenesis, isTrue);
    expect(changed.tip, 0);
  });
}
