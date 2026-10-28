// R01b regtest checkpoint e2e (Russell, 28 Oct). Runs on the regtest book:
//
//   flutter test --dart-define=SHEAR_BOOK_MAGIC=shear-regtest tool/regtest_checkpoint_e2e_test.dart
//
// The node (test/fixtures/regtest_e2e_node.mjs) is a real regtest node on the
// pinned regtest checkpoint (node/tests/regtest_checkpoint.json), mining on
// top with real ShearHash, its coinbase paying this wallet. The wallet:
//   1. with no checkpoint, refuses a send with "waiting for header sync",
//      never "insufficient", and Spendable is not painted;
//   2. with the regtest checkpoint, installed through installCheckpoint like
//      the release pin, proves the headers and bodies, shows the exact
//      Spendable, sends it through the app's send path, and the node mines
//      that send.
// It lives in tool/ because it needs the regtest build setting; under the
// default testnet build the same pin is refused (test/book_magic_test.dart).
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart' show kSpendableSyncing, spendableFigureText;
import 'package:shear_wallet/shear_checkpoint.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';

final Uint8List _seed = Uint8List.fromList(
  sha256.convert(utf8.encode('shear-regtest-checkpoint-e2e-wallet')).bytes,
);

CheckpointPin _regtestPin() {
  final raw = jsonDecode(File('../node/tests/regtest_checkpoint.json').readAsStringSync());
  final pin = checkpointPinFromJson(Map<String, dynamic>.from(raw as Map));
  if (pin == null) throw StateError('regtest checkpoint is not well formed');
  return pin;
}

class _Node {
  _Node(this.proc, this.info, this._lines);
  final Process proc;
  final Map<String, dynamic> info;
  final StreamIterator<String> _lines;

  int get tip => (info['tip'] as num).toInt();
  String get base => 'http://127.0.0.1:${info['port']}';
  List<Map<String, dynamic>> get payments =>
      [for (final p in info['payments'] as List) Map<String, dynamic>.from(p as Map)];

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

Future<_Node> _startNode(String dest) async {
  final proc = await Process.start('node', ['test/fixtures/regtest_e2e_node.mjs', dest]);
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
  final home = (ShearLedger()..bindIdentity(id)).homeDest(id.address, paymentCode: id.paymentCode);
  final bobId = createIdentity();
  final bob = (ShearLedger()..bindIdentity(bobId)).homeDest(bobId.address, paymentCode: bobId.paymentCode);
  late _Node node;

  setUpAll(() async {
    expect(kBookMagic, kRegtestBookMagic,
        reason: 'run with --dart-define=SHEAR_BOOK_MAGIC=shear-regtest');
    node = await _startNode(home);
  });

  tearDownAll(() async {
    await node.stop();
  });

  Future<ContinuumSendResult> sendNanos(ShearLedger ledger, BigInt n) => submitContinuumSend(
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

  test('no checkpoint: a send waits for header sync, never "insufficient", and Spendable is not painted', () async {
    final pool = ShearPoolClient(baseUrl: node.base, http: HttpClient());
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    await ledger.populateSpendableFromNode(id.address, paymentCode: id.paymentCode);
    expect(ledger.spendableReadFailed, isTrue);
    expect(ledger.spendableReadError, kErrHeaderSync);
    final ready = ledger.spendableFigureReady(id.address, paymentCode: id.paymentCode);
    expect(ready, isFalse);
    expect(
      spendableFigureText(
        sourceBlocked: false,
        ready: ready,
        spendShe: ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      ),
      kSpendableSyncing,
    );
    expect(ledger.fundsRefusal(1).message, kErrHeaderSync);
    final refused = await sendNanos(ledger, BigInt.from(kUnitsPerShe));
    expect(refused.posted, isFalse);
    final why = '${refused.remark} $debugLastContinuumSendError';
    expect(why.toLowerCase(), isNot(contains('insufficient')), reason: why);
    pool.close();
  }, timeout: const Timeout(Duration(minutes: 10)));

  test('with the regtest checkpoint: exact Spendable, the full send posts, and the node mines it', () async {
    final pin = _regtestPin();
    expect(pin.network, kRegtestBookMagic);
    expect(checkpointAllowedFor(pin), isTrue);
    final pool = ShearPoolClient(baseUrl: node.base, http: HttpClient());
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    ledger.installCheckpoint(pin);
    await ledger.populateSpendableFromNode(id.address, paymentCode: id.paymentCode);
    expect(ledger.spendableReadFailed, isFalse, reason: ledger.spendableReadError);
    expect(ledger.bodyProofRequired, isTrue);
    expect(ledger.bodyScanTo, node.tip);

    var total = BigInt.zero;
    for (final p in node.payments) {
      total += BigInt.parse(p['nanos'] as String);
    }
    expect(ledger.spendableFigureReady(id.address, paymentCode: id.paymentCode), isTrue);
    expect(ledger.displayedSpendableNanos(id.address, paymentCode: id.paymentCode), total);
    expect(ledger.plannerSelectableNanos(id.address, paymentCode: id.paymentCode), total);

    final inputs = node.payments.fold<int>(0, (s, p) => s + (p['commits'] as List).length);
    final fee = BigInt.from(estimateSendLevyUnits(inputs: inputs, outputs: 3));
    final over = await sendNanos(ledger, total - fee + BigInt.one);
    expect(over.posted, isFalse, reason: 'one unit over what Spendable covers is refused');
    final sent = await sendNanos(ledger, total - fee);
    expect(sent.posted, isTrue, reason: '${sent.remark} $debugLastContinuumSendError');
    expect(debugLastPayNanos, total - fee);
    expect(debugLastChangeNanos, BigInt.zero, reason: 'pay + fee is the whole Spendable');

    final mined = await node.mine();
    expect(mined['mined'], isTrue, reason: '${mined['reason']}');
    final txs = mined['txs'] as List;
    expect(txs.length, 1, reason: 'the node mined the wallet send');
    expect(((txs.single as Map)['spendTags'] as List).length, inputs);
    pool.close();
  }, timeout: const Timeout(Duration(minutes: 15)));
}
