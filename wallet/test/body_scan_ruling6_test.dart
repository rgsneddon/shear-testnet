import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart' show kSpendableSyncing, spendableFigureText;
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_body_scan.dart';
import 'package:shear_wallet/shear_checkpoint.dart';
import 'package:shear_wallet/shear_fs1.dart' show kErrFs1Anchor;
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_reserve.dart' show readVaultPortal;
import 'package:shear_wallet/shear_vault_reward.dart' show hiddenChangeNote, kPiSheNanos;

/// Ruling 6 (Russell, 28 Oct): the v12 node has no notes route, so the
/// wallet scans block bodies against the headers it verified. Every chain
/// here is built and served by the node's own code (fixtures/
/// body_scan_node.mjs): its template, its append, its RPC, real ShearHash
/// above the pin.

final Uint8List _seed = Uint8List.fromList(
  sha256.convert(utf8.encode('shear-body-scan-ruling6-wallet')).bytes,
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
  final line = await first.future.timeout(const Duration(minutes: 8));
  return _Node(proc, jsonDecode(line) as Map<String, dynamic>);
}

ShearIdentity _id() => createIdentity(Uint8List.fromList(_seed));

String _homeOf(ShearIdentity id) =>
    (ShearLedger()..bindIdentity(id)).homeDest(id.address, paymentCode: id.paymentCode);

String _payeeDest() => _homeOf(createIdentity());

ShearPoolClient _client(_Node node) =>
    ShearPoolClient(baseUrl: node.base, http: HttpClient());

int _units(double she) => (she * kUnitsPerShe).round();

/// The wallet's notes at [height], as commits.
Set<String> _commitsAt(ShearLedger ledger, int height) => {
      for (final n in ledger.notes)
        if ((n['height'] as num?)?.toInt() == height && n['commit'] is List<int>)
          _hex(n['commit'] as List<int>),
    };

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

  test('the wallet sees its coins on its own v12 node: proven bodies, exact Spendable, the young coin Pending', () async {
    final pool = _client(node);
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    ledger.installCheckpoint(node.pin);
    final pinH = node.pin.height;

    // The node no longer answers notes (AL-5): the read is the body scan.
    final notes = await HttpClient()
        .getUrl(Uri.parse('${node.base}/notes?address=$home'))
        .then((r) => r.close());
    expect(notes.statusCode, 404);
    await notes.drain<void>();

    await ledger.populateSpendableFromNode(id.address, paymentCode: id.paymentCode);
    expect(ledger.bodyProofRequired, isTrue);
    expect(ledger.spendableReadFailed, isFalse, reason: ledger.spendableReadError);
    expect(ledger.bodyScanTo, node.tip, reason: 'every body up to the verified tip');
    expect(ledger.bookTip, node.tip);

    final pays = node.payments;
    expect(pays.length, 3);
    var deep = 0;
    var young = 0;
    for (final p in pays) {
      expect(_commitsAt(ledger, p.height), containsAll(p.commits), reason: 'h=${p.height} found');
      for (final n in ledger.notes) {
        if ((n['height'] as num?)?.toInt() != p.height) continue;
        expect(n['bodyProven'], isTrue, reason: 'h=${p.height} proven');
      }
      if (ledger.confirmationsOf(p.height) >= ShearLedger.spendableConfirmations) {
        deep += p.nanos;
      } else {
        young += p.nanos;
      }
    }
    expect(deep, greaterThan(0));
    expect(young, greaterThan(0));
    expect(ledger.spendableFigureReady(id.address, paymentCode: id.paymentCode), isTrue);
    expect(_units(ledger.spendableOwned(id.address, paymentCode: id.paymentCode)), deep,
        reason: 'Spendable is exactly the proven, confirmed coins');
    expect(_units(ledger.unconfirmedIncomingShe(id.address, paymentCode: id.paymentCode)), young,
        reason: 'the coin short of 9 confirmations is Pending');
    expect(
      spendableFigureText(sourceBlocked: false, ready: true, spendShe: deep / kUnitsPerShe),
      '${formatShe(deep / kUnitsPerShe)} SHE',
    );

    // The worker hands the cursor and the proof mode back to the UI book.
    final out = ledger.exportCreditFollow(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      full: true,
    );
    final ui = ShearLedger()..bindIdentity(id);
    ui.installCreditFollow(out);
    expect(ui.bodyProofRequired, isTrue);
    expect(ui.bodyScanTo, node.tip);
    expect(pinH, lessThan(pays.first.height));
    pool.close();
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('a tampered body is refused and nothing in it is ever counted', () async {
    final pool = _client(node);
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    ledger.installCheckpoint(node.pin);
    final pinH = node.pin.height;
    final paid = node.payments.first;

    Future<Map<String, dynamic>?> Function(int) bent(
      void Function(Map<String, dynamic> block) change,
    ) =>
        (int h) async {
          final real = await pool.wireBlock(h);
          if (h != paid.height) return real;
          final copy = jsonDecode(jsonEncode(real)) as Map<String, dynamic>;
          change(copy);
          return copy;
        };

    Map<String, dynamic> coinbaseOf(Map<String, dynamic> block) =>
        (block['txs'] as List).cast<Map<String, dynamic>>().firstWhere((t) => t['coinbase'] == true);

    final tampers = <String, void Function(Map<String, dynamic>)>{
      // A changed output: the amount the coinbase publishes.
      'output amount': (b) {
        final o = (coinbaseOf(b)['vout'] as List).first as Map<String, dynamic>;
        final vp = o['valueProof'] as Map<String, dynamic>;
        vp['v'] = (vp['v'] as num).toInt() + 1;
      },
      // A changed output: its commitment.
      'output commit': (b) {
        final o = (coinbaseOf(b)['vout'] as List).first as Map<String, dynamic>;
        final c = (o['commit'] as Map)[r'$hex'] as String;
        o['commit'] = {r'$hex': '${c.substring(0, 62)}${c.endsWith('00') ? '01' : '00'}'};
      },
      // A tx the header does not commit to, paying the wallet.
      'extra tx': (b) {
        final forged = jsonDecode(jsonEncode(coinbaseOf(b))) as Map<String, dynamic>;
        forged['coinbase'] = false;
        forged['kind'] = 'send';
        (b['txs'] as List).add(forged);
        (b['txCores'] as List).add((b['txCores'] as List).first);
      },
      // The same row twice: [A] and [A, A] must not both pass.
      'repeated tx': (b) {
        (b['txs'] as List).add(jsonDecode(jsonEncode((b['txs'] as List).first)));
        (b['txCores'] as List).add((b['txCores'] as List).first);
      },
      // A core that is not the row's.
      'wrong core': (b) {
        (b['txCores'] as List)[0] = 'ab' * 32;
      },
      // A body with its cores dropped cannot be checked, so it is refused.
      'no cores': (b) {
        b.remove('txCores');
      },
    };

    for (final e in tampers.entries) {
      final ok = await ledger.scanVerifiedBodies(
        restFrame: id.address,
        paymentCode: id.paymentCode,
        hostTip: node.tip,
        fetch: bent(e.value),
      );
      expect(ok, isFalse, reason: e.key);
      ledger.noteSpendableReadFailed();
      expect(ledger.spendableReadError, 'block ${paid.height}: body does not match its verified header', reason: e.key);
      expect(ledger.spendableFigureReady(id.address, paymentCode: id.paymentCode), isFalse, reason: e.key);
      expect(ledger.bodyScanTo, pinH, reason: '${e.key}: the cursor stays below the refused body');
      expect(_commitsAt(ledger, paid.height), isEmpty, reason: '${e.key}: nothing from the refused body');
      for (final n in ledger.notes) {
        expect(n['bodyProven'] == true && (n['height'] as num?)?.toInt() == paid.height, isFalse);
      }
      expect(_units(ledger.spendableOwned(id.address, paymentCode: id.paymentCode)), 0, reason: e.key);
    }

    // The same wallet, the real bodies: the coin is found and proven.
    final ok = await ledger.scanVerifiedBodies(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      hostTip: node.tip,
    );
    expect(ok, isTrue);
    expect(_commitsAt(ledger, paid.height), containsAll(paid.commits));
    pool.close();
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('a header below the checkpoint that does not hash to its child\'s link is refused', () async {
    final pool = _client(node);
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    ledger.installCheckpoint(node.pin);
    final pinH = node.pin.height;
    Future<List<({int height, Uint8List header})>> bentHeaders(int from, int to) async {
      final out = <({int height, Uint8List header})>[];
      for (var h = from; h <= to; h++) {
        final j = await pool.headerAt(h);
        final raw = Uint8List.fromList([
          for (var i = 0; i < (j['header'] as String).length; i += 2)
            int.parse((j['header'] as String).substring(i, i + 2), radix: 16),
        ]);
        if (h == pinH - 3) raw[100] ^= 1; // its time: another header, another hash
        out.add((height: h, header: raw));
      }
      return out;
    }

    final ok = await ledger.scanVerifiedBodies(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      fetchHeaders: bentHeaders,
    );
    expect(ok, isFalse);
    ledger.noteSpendableReadFailed();
    expect(ledger.spendableReadError, 'headers below the checkpoint do not link to it');
    expect(ledger.bodyScanTo, 0, reason: 'no body below the pin was read');
    pool.close();
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('while the walk below the checkpoint runs: "syncing", nothing painted, a send waits for header sync', () async {
    final pool = _client(node);
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    ledger.installCheckpoint(node.pin);
    final pinH = node.pin.height;
    final gate = Completer<void>();
    final paused = Completer<void>();
    Future<List<({int height, Uint8List header})>> headers(int from, int to) async {
      if (from == 1 && !gate.isCompleted) {
        if (!paused.isCompleted) paused.complete();
        await gate.future;
      }
      final out = <({int height, Uint8List header})>[];
      for (var h = from; h <= to; h++) {
        final j = await pool.headerAt(h);
        final hex = j['header'] as String;
        out.add((height: h, header: Uint8List.fromList([
          for (var i = 0; i < hex.length; i += 2) int.parse(hex.substring(i, i + 2), radix: 16),
        ])));
      }
      return out;
    }

    final sw = Stopwatch()..start();
    final scan = ledger.scanVerifiedBodies(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      hostTip: node.tip,
      fetchHeaders: headers,
    );
    await paused.future;
    // Mid-walk: the figure is not ready, the line names the walk, and a
    // send is refused as waiting for header sync, not as insufficient.
    expect(ledger.headerVerifyLine, 'Verifying checkpoint headers 0/$pinH');
    final ready = ledger.spendableFigureReady(id.address, paymentCode: id.paymentCode);
    expect(ready, isFalse);
    expect(
      spendableFigureText(sourceBlocked: false, ready: ready, spendShe: ledger.spendableOwned(id.address, paymentCode: id.paymentCode)),
      kSpendableSyncing,
    );
    expect(ledger.fundsRefusal(1).message, kErrHeaderSync);
    Object? refused;
    try {
      await ledger.send(
        from: home,
        to: _payeeDest(),
        amount: 1,
        restFrame: id.address,
        paymentCode: id.paymentCode,
        spendSeed: _seed,
        allowPublicHttp: true,
      );
    } catch (e) {
      refused = e;
    }
    expect('$refused', contains(kErrHeaderSync));
    expect('$refused', isNot(contains('insufficient')));
    sw.reset();
    gate.complete();
    expect(await scan, isTrue, reason: ledger.spendableReadError);
    final ms = sw.elapsedMilliseconds;
    // ignore: avoid_print
    print('WALK_BELOW_PIN headers=$pinH total_ms=$ms per_header_ms=${(ms / pinH).toStringAsFixed(1)} (includes the scan above the pin)');
    expect(ledger.headerVerifyLine, isNull);
    expect(ledger.bodyScanTo, node.tip);
    pool.close();
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('a failed read never shows 0: the figure is "syncing" and the error is named', () async {
    // 1. No checkpoint pin (a debug or pre-cut build): depth is unknown, so
    // the own node's bodies cannot be proven and nothing is a verified zero.
    final pool = _client(node);
    final bare = ShearLedger(pool: pool)..bindIdentity(id);
    await bare.populateSpendableFromNode(id.address, paymentCode: id.paymentCode);
    expect(bare.spendableReadFailed, isTrue);
    expect(bare.spendableReadError, kErrHeaderSync);
    final ready = bare.spendableFigureReady(id.address, paymentCode: id.paymentCode);
    expect(ready, isFalse);
    final shown = spendableFigureText(
      sourceBlocked: false,
      ready: ready,
      spendShe: bare.spendableOwned(id.address, paymentCode: id.paymentCode),
    );
    expect(shown, kSpendableSyncing);
    expect(shown.contains('0'), isFalse, reason: 'never 0 as a value');

    // 2. Verified headers, but the node does not send a body.
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    ledger.installCheckpoint(node.pin);
    final cut = node.payments[1].height;
    final ok = await ledger.scanVerifiedBodies(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      hostTip: node.tip,
      fetch: (h) async => h >= cut ? null : pool.wireBlock(h),
    );
    expect(ok, isFalse);
    ledger.noteSpendableReadFailed();
    expect(ledger.spendableReadError, 'block $cut: the node did not send its body');
    final ready2 = ledger.spendableFigureReady(id.address, paymentCode: id.paymentCode);
    expect(ready2, isFalse);
    expect(
      spendableFigureText(
        sourceBlocked: false,
        ready: ready2,
        spendShe: ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      ),
      kSpendableSyncing,
    );
    expect(ledger.bodyScanTo, cut - 1, reason: 'the bodies before it were proven and kept');
    expect(_commitsAt(ledger, node.payments.first.height), containsAll(node.payments.first.commits));
    pool.close();
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('own-node vault read: the pane reads the node\'s own /reserve; a failed read is surfaced, never painted', () async {
    // The pool route is not on a node: it answers 400.
    final raw = await HttpClient()
        .getUrl(Uri.parse('${node.base}/api/vault/reserve?dest=${Uri.encodeQueryComponent(home)}'))
        .then((r) => r.close());
    expect(raw.statusCode, 400);
    await raw.drain<void>();

    for (final own in [false, true]) {
      final pool = _client(node);
      if (own) pool.useOwnNode(node.base);
      final read = await readVaultPortal(pool, home);
      expect(read.error, isEmpty, reason: 'own=$own');
      final p = read.portal!;
      // This wallet's portal, from the node's vault (it has locked nothing).
      expect(p['staked'], 0);
      expect(p['idle'], 0);
      expect(p['accrued'], 0);
      // The public vault view the pool route also spreads.
      for (final k in ['totalLockedNanos', 'totalStakedNanos', 'mintBankNanos', 'feeBankNanos', 'epochBps', 'epochStartMs', 'votes']) {
        expect(p.containsKey(k), isTrue, reason: 'own=$own $k');
      }
      pool.close();
    }

    // A node that does not answer: the error is named and no portal is given.
    final dead = ShearPoolClient(baseUrl: 'http://127.0.0.1:9', http: HttpClient()..connectionTimeout = const Duration(milliseconds: 300));
    dead.useOwnNode('http://127.0.0.1:9');
    final failed = await readVaultPortal(dead, home);
    expect(failed.portal, isNull);
    expect(failed.error, startsWith('Vault read failed (node reserve:'));
    dead.close();
  });

  test('in body mode a deep note whose body is not proven is Pending, never Spendable', () {
    final ledger = ShearLedger()..bindIdentity(id);
    ledger.noteLiveHeight(40);
    ledger.settleTo(40);
    ledger.restoreBodyScan(required: true, scanTo: 0);
    const nanos = 300000000000;
    final note = hiddenChangeNote(
      nanos,
      hash20FromAddress(home)!,
      spendSeed: _seed,
      admitBase: admitPub(admitBaseScalar(_seed)),
    );
    expect(note, isNotNull);
    ledger.rememberNote({
      ...note!,
      'address': home,
      'dest': home,
      'kind': 'send',
      'nanos': nanos,
      'amount': nanos / kUnitsPerShe,
      'spendSeed': _seed,
      'verified': true,
      'height': 20,
    });
    ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    expect(_units(ledger.spendableOwned(id.address, paymentCode: id.paymentCode)), 0);
    expect(_units(ledger.unconfirmedIncomingShe(id.address, paymentCode: id.paymentCode)), nanos);
  });

  test('the canonical encoding is the node\'s, byte for byte', () async {
    final values = <String>[
      r'{"b":1,"a":[1,2.5,-0,0.1,1e21,1e-7,123456789012,null,true,false],"A":3,"aa":4,"é":5,"_":6}',
      r'{"s":"a\"b\\c\n\t\r\b\f\u0001\u001f\u007f é 😀  "}',
      r'{"h":{"$hex":"00ff"},"u":{"$hex":"00FF"},"o":{"$hex":"0"},"e":{"$hex":""}}',
      r'{"buf":{"type":"Buffer","data":[1,2,255]},"notbuf":{"type":"Buffer","data":[256]},"extra":{"type":"Buffer","data":[1],"x":1}}',
      r'{"x":{"$b":"00"}}',
      r'[{"$big":"1"}]',
      r'{"nest":[[],{},[{"k":[1,{"$hex":"ab"}]}]]}',
    ];
    final dir = Directory.systemTemp.createTempSync('shear-canon-');
    final file = File('${dir.path}/values.jsonl')..writeAsStringSync('${values.join('\n')}\n');
    final ran = await Process.run('node', ['test/fixtures/canonical_encode.mjs', file.path]);
    dir.deleteSync(recursive: true);
    expect(ran.exitCode, 0, reason: ran.stderr.toString());
    final got = const LineSplitter().convert(ran.stdout.toString());
    expect(got.length, values.length);
    for (var i = 0; i < values.length; i++) {
      final want = jsonDecode(got[i]) as Map<String, dynamic>;
      final v = jsonDecode(values[i]);
      expect(canonicalEncodeWire(v), want['enc'], reason: values[i]);
      expect(canonicalAliasPathWire(v), want['alias'], reason: values[i]);
    }
  });

  test('in body mode no send, lock, vote fee or withdraw can pick a note Spendable does not count', () async {
    const nanos = 10 * kUnitsPerShe;
    final note = hiddenChangeNote(
      nanos,
      hash20FromAddress(home)!,
      spendSeed: _seed,
      admitBase: admitPub(admitBaseScalar(_seed)),
    );
    expect(note, isNotNull, reason: 'a real sealed note');
    Map<String, dynamic> row({required bool proven}) => {
          ...note!,
          'address': home,
          'dest': home,
          'kind': 'send',
          'nanos': nanos,
          'amount': nanos / kUnitsPerShe,
          'verified': true,
          'height': 20,
          if (proven) 'bodyProven': true,
        };
    // The node's live note set holds the note, so only the wallet's own
    // gate can keep it out of a lock.
    final flux = {
      'pubs': [_hex(note!['admitPub'] as List<int>)],
      'commits': [_hex(note['commit'] as List<int>)],
      'spendTags': const <String>[],
    };
    Future<Object?> lockError(ShearLedger ledger) async {
      try {
        await ledger.send(
          from: home,
          to: home,
          amount: kPiSheNanos / kUnitsPerShe,
          kind: 'lock',
          restFrame: id.address,
          paymentCode: id.paymentCode,
          spendSeed: _seed,
          allowPublicHttp: true,
        );
        return null;
      } catch (e) {
        return e;
      }
    }

    ShearLedger book({required bool proven}) {
      final ledger = ShearLedger(pool: _FluxPool(flux))..bindIdentity(id);
      ledger.noteLiveHeight(40);
      ledger.settleTo(40);
      ledger.restoreBodyScan(required: true, scanTo: 40);
      ledger.rememberNote(row(proven: proven));
      ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
      return ledger;
    }

    // Unproven and deep: Spendable leaves it out, so every pick does.
    final unproven = book(proven: false);
    expect(_units(unproven.spendableOwned(id.address, paymentCode: id.paymentCode)), 0);
    expect(unproven.plannerSelectableNanos(id.address, paymentCode: id.paymentCode), BigInt.zero);
    expect(unproven.pickableNotes, isEmpty, reason: 'withdraw host, vote fee and lock leaf picks read this');
    final refused = await lockError(unproven);
    expect('$refused', anyOf(contains('insufficient'), contains('fund'), contains('Spendable')),
        reason: 'the lock found no note it may spend: $refused');

    // The same note, proven: Spendable counts it and the lock picks it (it
    // then stops at the FS-1 anchor, which this book has none of).
    final proven = book(proven: true);
    expect(_units(proven.spendableOwned(id.address, paymentCode: id.paymentCode)), nanos);
    expect(proven.plannerSelectableNanos(id.address, paymentCode: id.paymentCode), BigInt.from(nanos));
    expect(proven.pickableNotes.length, 1);
    final picked = await lockError(proven);
    expect('$picked', isNot(contains('insufficient')), reason: 'the proven note was picked: $picked');
    expect('$picked', contains(kErrFs1Anchor));
  });
}

class _FluxPool extends ShearPoolClient {
  _FluxPool(this.flux)
      : super(
          baseUrl: 'http://127.0.0.1:9',
          http: HttpClient()..connectionTimeout = const Duration(milliseconds: 50),
        );

  final Map<String, dynamic> flux;

  @override
  Future<Map<String, dynamic>> fluxset() async => flux;

  @override
  Future<Map<String, dynamic>> reserveTrancheBook() async => {'ok': true, 'tranches': const []};
}
