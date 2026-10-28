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

/// R28 wallet product work: the Dart wallet finds and can spend its
/// BluNotes, both the solo option (b) record coin (the record's fee note) and
/// a share-paid winner note. Every coin is mined by the node's own code
/// (fixtures/blunote_spend_node.mjs) and found by the wallet's record scan.
/// The spend key the FS-1 worker derives from the seed opens each coin
/// (x·G == P), its spend tag is the JS spec's (crypto/blunote.js), and
/// Spendable is exactly what the send planner can use.

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
      priorTimesMs: [for (final t in p['priorTimesMs'] as List) (t as num).toInt()],
    );
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

void main() {
  final id = createIdentity(Uint8List.fromList(_seed));
  late _Node node;

  setUpAll(() async {
    node = await _startNode();
  });

  tearDownAll(() async {
    await node.stop();
  });

  test('a solo (b) record coin and a share-paid note: found, x from the seed, JS spend tags, Spendable is what the send plans', () async {
    final pool = ShearPoolClient(baseUrl: node.base, http: HttpClient());
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    ledger.installCheckpoint(node.pin);
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

    // The send's own planner (submitContinuumSend plans with it) uses the
    // whole Spendable: pay plus the weight levy for the two inputs is exactly
    // the two coins. One unit more is not covered.
    final fee = BigInt.from(estimateSendLevyUnits(inputs: 2, outputs: 3));
    final pay = total - fee;
    expect(
      await ledger.quoteConfirmRecipientShe(
        restFrame: id.address,
        paymentCode: id.paymentCode,
        amount: pay.toDouble() / kUnitsPerShe,
        nanosWire: '$pay',
      ),
      formatSheFromNanos(pay.toInt()),
    );
    expect(
      await ledger.quoteConfirmRecipientShe(
        restFrame: id.address,
        paymentCode: id.paymentCode,
        amount: (pay + BigInt.one).toDouble() / kUnitsPerShe,
        nanosWire: '${pay + BigInt.one}',
      ),
      isNull,
    );
    // Posting that send to this node, and the node mining it, waits on the
    // wallet's book magic: the Dart wallet signs FS-1 digests under
    // shear-testnet-v12 and a regtest node verifies under shear-regtest
    // (reported with R01b, the same gap).
    pool.close();
  }, timeout: const Timeout(Duration(minutes: 20)));
}
