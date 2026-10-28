import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_blunote.dart';
import 'package:shear_wallet/shear_checkpoint.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';

/// Ruling 7 (Russell, 28 Oct): the wallet does not trust the coinbase row
/// that names a block's record (`blunote.prev`). It proves that row against
/// the header it verified (digest and merkle root) before a record note
/// counts. A record note whose next block is not proven yet is Pending as
/// "Waiting for next block's record", with no figure.
///
/// The chain is built and served by the node's own code (fixtures/
/// body_scan_node.mjs): real shares from this wallet's mining keys, the
/// node's draw, mined ShearHash above the pin.

final Uint8List _seed = Uint8List.fromList(
  sha256.convert(utf8.encode('shear-body-scan-ruling7-wallet')).bytes,
);


String _hex(List<int> b) =>
    b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

class _Node {
  _Node(this.proc, this.info);
  final Process proc;
  final Map<String, dynamic> info;

  int get port => (info['port'] as num).toInt();
  int get tip => (info['tip'] as num).toInt();
  String get base => 'http://127.0.0.1:$port';

  CheckpointPin get pin {
    final p = info['pin'] as Map<String, dynamic>;
    return CheckpointPin(
      network: p['network'] as String,
      height: (p['height'] as num).toInt(),
      hashHex: p['hashHex'] as String,
      timeMs: (p['timeMs'] as num).toInt(),
      bits: (p['bits'] as num).toInt(),
      anchorHeight: (p['anchorHeight'] as num).toInt(),
      anchorTimeMs: (p['anchorTimeMs'] as num).toInt(),
      anchorBits: (p['anchorBits'] as num).toInt(),
      priorTimesMs: [
        for (final t in p['priorTimesMs'] as List) (t as num).toInt(),
      ],
    );
  }

  List<({int height, List<String> commits, int nanos})> get payments => [
        for (final raw in info['payments'] as List)
          (
            height: ((raw as Map)['height'] as num).toInt(),
            commits: [for (final c in raw['commits'] as List) c.toString()],
            nanos: int.parse(raw['nanos'].toString()),
          ),
      ];

  Future<void> stop() async {
    await proc.stdin.close();
    await proc.exitCode.timeout(
      const Duration(seconds: 20),
      onTimeout: () {
        proc.kill();
        return -1;
      },
    );
  }
}

Future<_Node> _startNode(String dest) async {
  final proc = await Process.start('node', [
    'test/fixtures/body_scan_node.mjs',
    dest,
    _hex(_seed),
  ]);
  final err = StringBuffer();
  proc.stderr.transform(utf8.decoder).listen(err.write);
  final first = Completer<String>();
  proc.stdout
      .transform(utf8.decoder)
      .transform(const LineSplitter())
      .listen((line) {
    if (!first.isCompleted && line.trim().startsWith('{')) first.complete(line);
  });
  unawaited(proc.exitCode.then((code) {
    if (!first.isCompleted) first.completeError(StateError('node exited $code: $err'));
  }));
  final line = await first.future.timeout(const Duration(minutes: 15));
  return _Node(proc, jsonDecode(line) as Map<String, dynamic>);
}

ShearIdentity _id() => createIdentity(Uint8List.fromList(_seed));

String _homeOf(ShearIdentity id) =>
    (ShearLedger()..bindIdentity(id)).homeDest(id.address, paymentCode: id.paymentCode);

ShearPoolClient _client(_Node node) =>
    ShearPoolClient(baseUrl: node.base, http: HttpClient());

int _units(double she) => (she * kUnitsPerShe).round();

/// The wallet's notes at [height], as commits.
Set<String> _commitsAt(ShearLedger ledger, int height) => {
      for (final n in ledger.notes)
        if ((n['height'] as num?)?.toInt() == height && n['commit'] is List<int>)
          _hex(n['commit'] as List<int>),
    };


Map<String, dynamic> _copy(Map<String, dynamic> m) =>
    jsonDecode(jsonEncode(m)) as Map<String, dynamic>;

Map<String, dynamic> _coinbaseOf(Map<String, dynamic> block) =>
    (block['txs'] as List).cast<Map<String, dynamic>>().firstWhere((t) => t['coinbase'] == true);

Iterable<Map<String, dynamic>> _bluAt(ShearLedger ledger, int height) => ledger.notes.where(
      (n) => isBluNoteKind(n['kind'] as String?) && (n['height'] as num?)?.toInt() == height,
    );

void main() {
  final id = _id();
  final home = _homeOf(id);
  late _Node node;

  setUpAll(() async {
    node = await _startNode(home);
  });

  tearDownAll(() async {
    await node.stop();
  });

  ShearLedger walletOn(ShearPoolClient pool) {
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    ledger.installCheckpoint(node.pin);
    ledger.setBluMining(true);
    return ledger;
  }

  int deepNanos(ShearLedger ledger, {Set<int> skip = const {}}) {
    var n = 0;
    for (final p in node.payments) {
      if (p.height >= node.tip || skip.contains(p.height)) continue;
      if (ledger.confirmationsOf(p.height) >= ShearLedger.spendableConfirmations) n += p.nanos;
    }
    return n;
  }

  test('a record counts only once the coinbase row naming it is proven; a bent row is refused', () async {
    final pool = _client(node);
    final ledger = walletOn(pool);
    final paid = node.payments.first;
    final namer = paid.height + 1;

    // The node sends block h+1 with its coinbase naming another root.
    Future<Map<String, dynamic>?> bentPrev(int h) async {
      final real = await pool.wireBlock(h);
      if (h != namer) return real;
      final copy = _copy(real);
      final blu = _coinbaseOf(copy)['blunote'] as Map<String, dynamic>;
      expect(blu['prev'], isNotNull, reason: 'block h+1 names block h\'s record');
      blu['prev'] = blu['prev'] is Map ? {r'$hex': 'ab' * 32} : 'ab' * 32;
      return copy;
    }

    final refused = await ledger.scanVerifiedBodies(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      hostTip: node.tip,
      fetch: bentPrev,
    );
    await ledger.bluScanInFlight;
    expect(refused, isFalse, reason: 'the bent coinbase row fails its header\'s merkle root');
    expect(ledger.bodyScanTo, paid.height, reason: 'block h was proven; block h+1 was not');
    final read = _bluAt(ledger, paid.height).toList();
    expect({for (final n in read) _hex(n['commit'] as List<int>)}, containsAll(paid.commits),
        reason: 'the record at h was read');
    for (final n in read) {
      expect(n['verified'], isFalse, reason: 'not bound: its naming row is not proven');
      expect(n['bodyProven'] == true, isFalse);
    }
    expect(_units(ledger.spendableOwned(id.address, paymentCode: id.paymentCode)), 0);
    expect(_units(ledger.unconfirmedIncomingShe(id.address, paymentCode: id.paymentCode)), 0,
        reason: 'no figure is painted for an unbound note');
    expect(ledger.bluAwaitingRecord, read.length, reason: kBluAwaitingRecord);

    // The real bodies: block h+1's row is proven and names the record.
    final ok = await ledger.scanVerifiedBodies(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      hostTip: node.tip,
    );
    await ledger.bluScanInFlight;
    expect(ok, isTrue, reason: ledger.spendableReadError);
    for (final n in _bluAt(ledger, paid.height)) {
      expect(n['verified'], isTrue);
      expect(n['bodyProven'], isTrue);
    }
    final deep = deepNanos(ledger);
    expect(deep, greaterThan(0));
    expect(_units(ledger.spendableOwned(id.address, paymentCode: id.paymentCode)), deep,
        reason: 'exactly the bound records at 9 confirmations');
    pool.close();
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('a record the node swaps never binds, even under a proven row', () async {
    final pool = _client(node);
    final ledger = walletOn(pool);
    final paid = node.payments.first;

    // Same body (the record is not in the merkle root), another record: a
    // larger pot T, so the wallet's rows would be worth more.
    Future<Map<String, dynamic>?> swapped(int h) async {
      final real = await pool.wireBlock(h);
      if (h != paid.height) return real;
      final copy = _copy(real);
      final rec = copy['blunoteRecord'] as String;
      final bytes = [for (var i = 0; i < rec.length; i += 2) int.parse(rec.substring(i, i + 2), radix: 16)];
      bytes[44 + 1] = (bytes[44 + 1] + 1) & 0xff;
      copy['blunoteRecord'] = _hex(bytes);
      return copy;
    }

    final ok = await ledger.scanVerifiedBodies(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      hostTip: node.tip,
      fetch: swapped,
    );
    await ledger.bluScanInFlight;
    expect(ok, isTrue, reason: 'every body is the chain\'s');
    final forged = _bluAt(ledger, paid.height).toList();
    expect(forged, isNotEmpty, reason: 'the swapped record names this wallet');
    for (final n in forged) {
      expect(paid.commits.contains(_hex(n['commit'] as List<int>)), isFalse, reason: 'not the chain\'s notes');
      expect(n['verified'], isFalse);
      expect(n['reorged'], isTrue, reason: 'the proven row names another record');
    }
    expect(_units(ledger.spendableOwned(id.address, paymentCode: id.paymentCode)),
        deepNanos(ledger, skip: {paid.height}),
        reason: 'the other bound records count; the swapped one never does');
    pool.close();
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('the tip\'s record: no block names it yet, so it waits in Pending with no figure', () async {
    final pool = _client(node);
    final ledger = walletOn(pool);
    await ledger.populateSpendableFromNode(id.address, paymentCode: id.paymentCode);
    await ledger.bluScanInFlight;
    expect(ledger.spendableReadFailed, isFalse, reason: ledger.spendableReadError);
    final tipPay = node.payments.last;
    expect(tipPay.height, node.tip);
    final waiting = _bluAt(ledger, tipPay.height).toList();
    expect({for (final n in waiting) _hex(n['commit'] as List<int>)}, containsAll(tipPay.commits));
    for (final n in waiting) {
      expect(n['verified'], isFalse);
    }
    expect(ledger.bluAwaitingRecord, waiting.length);
    var young = 0;
    for (final p in node.payments) {
      if (p.height < node.tip &&
          ledger.confirmationsOf(p.height) < ShearLedger.spendableConfirmations) {
        young += p.nanos;
      }
    }
    expect(_units(ledger.unconfirmedIncomingShe(id.address, paymentCode: id.paymentCode)), young,
        reason: 'the bound young record is Pending with its figure; the waiting one has none');
    expect(
      ledger.pendingTxs(id.address).where((t) => (t.height ?? 0) == tipPay.height),
      isEmpty,
      reason: 'no Pending row with an amount for the waiting record',
    );
    expect(_units(ledger.spendableOwned(id.address, paymentCode: id.paymentCode)), deepNanos(ledger));
    pool.close();
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('ruling 7 birth: a note at birth+1 is found; no block below the birth is fetched or opened', () async {
    final pool = _client(node);
    final first = node.payments[0].height;
    final second = node.payments[1].height;
    expect(second, first + 1);

    Future<({ShearLedger ledger, Set<int> bodies, Set<int> headers})> scanFrom(int birth) async {
      final bodies = <int>{};
      final headers = <int>{};
      final ledger = walletOn(pool);
      ledger.setBirthHeight(birth);
      final ok = await ledger.scanVerifiedBodies(
        restFrame: id.address,
        paymentCode: id.paymentCode,
        hostTip: node.tip,
        fetch: (h) async {
          bodies.add(h);
          return pool.wireBlock(h);
        },
        fetchHeaders: (from, to) async {
          final out = <({int height, Uint8List header})>[];
          for (var h = from; h <= to; h++) {
            headers.add(h);
            final j = await pool.headerAt(h);
            final hex = j['header'] as String;
            out.add((
              height: h,
              header: Uint8List.fromList([
                for (var i = 0; i < hex.length; i += 2) int.parse(hex.substring(i, i + 2), radix: 16),
              ]),
            ));
          }
          return out;
        },
      );
      await ledger.bluScanInFlight;
      expect(ok, isTrue, reason: ledger.spendableReadError);
      return (ledger: ledger, bodies: bodies, headers: headers);
    }

    // Birth at the first paid block: the next block's note (birth+1) is found.
    final a = await scanFrom(first);
    expect({for (final n in _bluAt(a.ledger, second)) _hex(n['commit'] as List<int>)}, containsAll(node.payments[1].commits));
    expect(a.bodies.every((h) => h >= first), isTrue, reason: 'bodies read: ${a.bodies.toList()..sort()}');
    expect(a.bodies, contains(first), reason: 'the birth block itself is read');

    // Birth one block later: the first paid block is below it. Its body is
    // never fetched, so nothing in it is opened, and its note is not there.
    final b = await scanFrom(second);
    expect(b.bodies.contains(first), isFalse);
    expect(b.bodies.every((h) => h >= second), isTrue, reason: 'bodies read: ${b.bodies.toList()..sort()}');
    expect(_bluAt(b.ledger, first), isEmpty);
    expect({for (final n in _bluAt(b.ledger, second)) _hex(n['commit'] as List<int>)}, containsAll(node.payments[1].commits));
    // Both births are above the pin: no header below the pin is asked for.
    for (final s in [a, b]) {
      expect(s.headers.every((h) => h > node.pin.height), isTrue, reason: 'headers read: ${s.headers.toList()..sort()}');
    }
    pool.close();
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('ruling 7 birth on create, against a real node: ten blocks under the verified tip', () async {
    final pool = _client(node);
    final ledger = walletOn(pool);
    // Before any header is checked the verified tip is the pin itself.
    expect(ledger.verifiedHeaderTip, node.pin.height);
    expect(walletBirthForNewWallet(ledger.verifiedHeaderTip), node.pin.height - 10);
    // A ledger with no checkpoint has verified nothing: genesis.
    expect(walletBirthForNewWallet((ShearLedger()..bindIdentity(id)).verifiedHeaderTip), 0);
    final ok = await ledger.scanVerifiedBodies(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      hostTip: node.tip,
    );
    await ledger.bluScanInFlight;
    expect(ok, isTrue, reason: ledger.spendableReadError);
    expect(ledger.verifiedHeaderTip, node.tip);
    expect(walletBirthForNewWallet(ledger.verifiedHeaderTip), node.tip - 10);
    pool.close();
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('the old path: compact rows the node sends never bind a record', () async {
    final paid = node.payments.first;
    final got = await HttpClient()
        .getUrl(Uri.parse('${node.base}/blocks?from=${paid.height}&to=${paid.height + 1}'))
        .then((r) => r.close());
    final body = jsonDecode(await got.transform(utf8.decoder).join()) as Map<String, dynamic>;
    final rows = (body['blocks'] as List).cast<Map<String, dynamic>>();
    expect(rows.length, 2);
    expect(bluPrevRootsByHeight(rows)[paid.height + 1], bluRecordRootHex(bluRecordOfBlock(rows.first)!),
        reason: 'the compact row does name the right root');
    final ledger = ShearLedger()..bindIdentity(id);
    ledger.bluScanInline = true;
    ledger.noteLiveHeight(node.tip);
    ledger.settleTo(node.tip);
    ledger.setBluMining(true);
    ledger.ingestBluRecords(rows);
    final found = _bluAt(ledger, paid.height).toList();
    expect(found, isNotEmpty);
    for (final n in found) {
      expect(n['verified'], isFalse, reason: 'ruling 7: the row is not proven');
    }
    ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    expect(_units(ledger.spendableOwned(id.address, paymentCode: id.paymentCode)), 0);
  });
}
