import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_hash.dart';
import 'package:shear_wallet/shear_hash_v3.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_read_sync.dart';
import 'package:shear_wallet/shear_session.dart';

class _Chain {
  _Chain._(this.tip);

  /// Parent-linked headers. Each digest is ShearHash-v3 and meets bits=1.
  /// The JSON hash field is not that digest.
  static _Chain mine(int tip) {
    expect(shearHashV3Ready, isTrue, reason: 'libshearhash.so ShearHash-v3');
    final chain = _Chain._(tip);
    var prev = Uint8List(32);
    for (var h = 1; h <= tip; h++) {
      final header = Uint8List(shearHeaderLen);
      header[0] = 1;
      header.setRange(4, 36, prev);
      var ts = 1700000000000;
      for (var i = 0; i < 8; i++) {
        header[100 + i] = ts & 0xff;
        ts >>= 8;
      }
      header[108] = 1;
      Uint8List? digest;
      for (var n = 0; n < 64; n++) {
        shearSetNonce(header, n);
        final got = shearHashV3(header);
        if (got != null && shearMeetsTarget(got, 1)) {
          digest = got;
          break;
        }
      }
      expect(digest, isNotNull, reason: 'flyclient header $h');
      chain.headers[h] = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
      chain.hashes[h] = 'ff' * 32;
      prev = digest!;
    }
    return chain;
  }

  int tip;
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
        'magic': kBookMagic,
        'network': kBookMagic,
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
    final good = _Chain.mine(6);
    final tall = _Chain.mine(1);
    tall.tip = 20;
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
