import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_blunote.dart' show kBluKindFee, kBluKindWinner;
import 'package:shear_wallet/shear_checkpoint.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_ristretto.dart';

/// R28 wallet product work: the Dart wallet spends its BluNotes, both the
/// solo option (b) record coin (the record's fee note) and a share-paid
/// winner note, through the real FS-1 path. Runs on the regtest book:
///
///   flutter test --dart-define=SHEAR_BOOK_MAGIC=shear-regtest tool/blunote_spend_e2e_test.dart
///
/// The node (fixtures/blunote_spend_node.mjs) is a real R28 regtest node on
/// the pinned regtest checkpoint; every coin is mined by its own code and
/// found by the wallet's record scan. The spend key the FS-1 worker derives
/// from the seed opens each coin (x·G == P), its spend tag is the JS spec's
/// (crypto/blunote.js), Spendable is exactly what the send can use, the
/// whole of it is sent through the app's send path, and the node mines that
/// send with exactly the JS spend tags.

final Uint8List _seed = Uint8List.fromList(
  sha256.convert(utf8.encode('shear-blunote-spend-wallet')).bytes,
);

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Uint8List _unhex(String s) => Uint8List.fromList([
      for (var i = 0; i < s.length; i += 2) int.parse(s.substring(i, i + 2), radix: 16),
    ]);

class _Node {
  _Node(this.proc, this.info, this._lines);
  final Process proc;
  final Map<String, dynamic> info;
  final StreamIterator<String> _lines;

  int get port => (info['port'] as num).toInt();
  int get tip => (info['tip'] as num).toInt();
  String get base => 'http://127.0.0.1:$port';
  List<Map<String, dynamic>> get coins =>
      [for (final c in info['coins'] as List) Map<String, dynamic>.from(c as Map)];

  /// Mine one block from the node's mempool.
  Future<Map<String, dynamic>> mine() async {
    proc.stdin.writeln('mine');
    await proc.stdin.flush();
    while (await _lines.moveNext().timeout(const Duration(minutes: 5))) {
      final line = _lines.current.trim();
      if (line.startsWith('{')) return jsonDecode(line) as Map<String, dynamic>;
    }
    throw StateError('node closed');
  }

  Future<void> stop() async {
    await proc.stdin.close();
    await proc.exitCode.timeout(const Duration(seconds: 20), onTimeout: () {
      proc.kill();
      return -1;
    });
  }
}

Future<_Node> _startNode() async {
  final proc = await Process.start('node', ['test/fixtures/blunote_spend_node.mjs', _hex(_seed)]);
  final err = StringBuffer();
  proc.stderr.transform(utf8.decoder).listen(err.write);
  final lines = StreamIterator(proc.stdout.transform(utf8.decoder).transform(const LineSplitter()));
  Future<String> first() async {
    while (await lines.moveNext()) {
      if (lines.current.trim().startsWith('{')) return lines.current;
    }
    throw StateError('node exited: $err');
  }

  final line = await first().timeout(const Duration(minutes: 15));
  return _Node(proc, jsonDecode(line) as Map<String, dynamic>, lines);
}

CheckpointPin _regtestPin() {
  final raw = jsonDecode(File('../node/tests/regtest_checkpoint.json').readAsStringSync());
  final pin = checkpointPinFromJson(Map<String, dynamic>.from(raw as Map));
  if (pin == null) throw StateError('regtest checkpoint is not well formed');
  return pin;
}

void main() {
  final id = createIdentity(Uint8List.fromList(_seed));
  late _Node node;

  setUpAll(() async {
    expect(kBookMagic, kRegtestBookMagic,
        reason: 'run with --dart-define=SHEAR_BOOK_MAGIC=shear-regtest');
    node = await _startNode();
  });

  tearDownAll(() async {
    await node.stop();
  });

  test('a solo (b) record coin and a share-paid note: found, opened from the seed, sent whole, and mined with the JS spend tags', () async {
    final pool = ShearPoolClient(baseUrl: node.base, http: HttpClient());
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    ledger.installCheckpoint(_regtestPin());
    ledger.setBluMining(true);
    await ledger.populateSpendableFromNode(id.address, paymentCode: id.paymentCode);
    await ledger.bluScanInFlight;
    expect(ledger.spendableReadFailed, isFalse, reason: ledger.spendableReadError);
    expect(ledger.bodyScanTo, node.tip);

    final coins = node.coins;
    expect(coins.map((c) => c['kind']).toSet(), {'pool-fee', 'blunote'},
        reason: 'one solo (b) fee-note coin and one share-paid winner');
    var total = BigInt.zero;
    for (final c in coins) {
      final commit = c['commit'] as String;
      final rows = [
        for (final n in ledger.notes)
          if (n['commit'] is List<int> && _hex(n['commit'] as List<int>) == commit) n,
      ];
      expect(rows.length, 1, reason: '${c['kind']} at h=${c['height']} found once');
      final row = rows.single;
      expect(row['kind'], c['kind'] == 'pool-fee' ? kBluKindFee : kBluKindWinner);
      expect(_hex(row['admitPub'] as List<int>), c['admitPub']);
      // x from the seed alone, as the FS-1 worker derives it.
      final x = admitScalarFromSeed(_seed, row);
      expect(_hex(pointBytes(admitPub(x))), c['admitPub'], reason: 'x·G == P');
      final P = pointFrom(_unhex(c['admitPub'] as String));
      expect(_hex(pointBytes(spendTagPoint(x, P))), c['spendTag'],
          reason: 'Dart spend tag == JS spend tag (${c['kind']})');
      total += BigInt.parse(c['nanos'] as String);
    }

    // Spendable is exactly the two coins, and it is what a send can use.
    expect(ledger.spendableFigureReady(id.address, paymentCode: id.paymentCode), isTrue);
    expect(ledger.displayedSpendableNanos(id.address, paymentCode: id.paymentCode), total);
    expect(ledger.plannerSelectableNanos(id.address, paymentCode: id.paymentCode), total);

    // The app's send (the Flow button): submitContinuumSend plans the
    // inputs. Pay plus the weight levy for the two inputs is exactly the two
    // coins; one unit more is not covered.
    final bobId = createIdentity();
    final bob = (ShearLedger()..bindIdentity(bobId)).homeDest(bobId.address, paymentCode: bobId.paymentCode);
    Future<ContinuumSendResult> sendNanos(BigInt n) => submitContinuumSend(
          ledger: ledger,
          restFrame: id.address,
          paymentCode: id.paymentCode,
          startTo: bob,
          enteredTo: bob,
          amount: n.toDouble() / kUnitsPerShe,
          nanosWire: '$n',
          spendSeed: _seed,
          local: false,
          publicNode: false,
          allowPublicHttp: true,
        );
    final fee = BigInt.from(estimateSendLevyUnits(inputs: 2, outputs: 3));
    final over = await sendNanos(total - fee + BigInt.one);
    expect(over.posted, isFalse, reason: 'one unit over what Spendable covers is refused');
    final sent = await sendNanos(total - fee);
    expect(sent.posted, isTrue, reason: '${sent.remark} $debugLastContinuumSendError');
    expect(debugLastFeeNanos, fee);
    expect(debugLastPayNanos, total - fee);
    expect(debugLastChangeNanos, BigInt.zero, reason: 'pay + fee is the whole Spendable');

    final mined = await node.mine();
    expect(mined['mined'], isTrue, reason: '${mined['reason']}');
    final txs = [for (final t in mined['txs'] as List) Map<String, dynamic>.from(t as Map)];
    expect(txs.length, 1, reason: 'the node mined the Dart send');
    expect((txs.single['spendTags'] as List).toSet(), {for (final c in coins) c['spendTag']},
        reason: 'the node took exactly the JS spend tags of both BluNotes');
    pool.close();
  }, timeout: const Timeout(Duration(minutes: 20)));
}
