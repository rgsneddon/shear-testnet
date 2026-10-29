import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_checkpoint.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';

/// P1-3 and T-1 (WH review of the claude/* wallet branches). When the
/// header a body read needs has left the checked window, the wallet walks
/// its headers again from the pin. Every body proof above the pin was made
/// against headers it just dropped, so each one is made again: the body
/// cursor goes back to the pin and nothing above it stays proven. Spendable
/// is never painted from a proof whose header is gone.
///
/// The chain is the node's own (fixtures/body_scan_node.mjs), 30 blocks
/// above the pin so the tip runs past the 16-header window.

final Uint8List _seed = Uint8List.fromList(
  sha256.convert(utf8.encode('shear-body-scan-window-reset-wallet')).bytes,
);

String _hex(List<int> b) =>
    b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

int _units(double she) => (she * kUnitsPerShe).round();

const _abovePin = 30;

void main() {
  final id = createIdentity(Uint8List.fromList(_seed));
  final home =
      (ShearLedger()..bindIdentity(id)).homeDest(id.address, paymentCode: id.paymentCode);
  late Process proc;
  late Map<String, dynamic> info;
  late Directory dir;

  setUpAll(() async {
    dir = Directory.systemTemp.createTempSync('shear-window-reset-');
    proc = await Process.start('node', [
      'test/fixtures/body_scan_node.mjs',
      home,
      _hex(_seed),
      '12',
      '$_abovePin',
    ]);
    final err = StringBuffer();
    proc.stderr.transform(utf8.decoder).listen(err.write);
    final first = Completer<String>();
    proc.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
      if (!first.isCompleted && line.trim().startsWith('{')) first.complete(line);
    });
    unawaited(proc.exitCode.then((code) {
      if (!first.isCompleted) first.completeError(StateError('node exited $code: $err'));
    }));
    info = jsonDecode(await first.future.timeout(const Duration(minutes: 12)))
        as Map<String, dynamic>;
  });

  tearDownAll(() async {
    await proc.stdin.close();
    await proc.exitCode.timeout(const Duration(seconds: 20), onTimeout: () {
      proc.kill();
      return -1;
    });
    dir.deleteSync(recursive: true);
  });

  CheckpointPin pinOf() {
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

  // The node's bodies. One retry on a fresh socket: a keep-alive socket the
  // node closed while the wallet was hashing headers is not a missing body.
  Future<Map<String, dynamic>?> Function(int) bodies(ShearPoolClient pool) =>
      (int h) async {
        try {
          return await pool.wireBlock(h);
        } on HttpException {
          return await pool.wireBlock(h);
        }
      };

  test('a header-window reset after bodies are proven rewinds the body scan to the pin', () async {
    final base = 'http://127.0.0.1:${(info['port'] as num).toInt()}';
    final tip = (info['tip'] as num).toInt();
    final pin = pinOf();
    final store = '${dir.path}/headers.json';
    final pays = [
      for (final raw in info['payments'] as List)
        (
          height: ((raw as Map)['height'] as num).toInt(),
          nanos: int.parse(raw['nanos'].toString()),
        ),
    ];
    expect(tip - pin.height, _abovePin);

    // Book A proves every body up to the tip and saves its header window.
    final poolA = ShearPoolClient(baseUrl: base, http: HttpClient());
    final a = ShearLedger(pool: poolA)..bindIdentity(id);
    a.installCheckpoint(pin, storePath: store);
    // R28: the wallet is paid by its shares' draw; it scans block records.
    a.setBluMining(true);
    final okA = await a.scanVerifiedBodies(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      hostTip: tip,
      rounds: 8,
      fetch: bodies(poolA),
    );
    if (!okA) a.noteSpendableReadFailed();
    await a.bluScanInFlight;
    expect(okA, isTrue, reason: "${a.bodyScanTo} ${a.bookTip} ${a.spendableReadError}");
    expect(a.bodyScanTo, tip);
    a.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    var deep = 0;
    for (final p in pays) {
      // The tip's record is named by no block yet (ruling 7): never Spendable.
      if (p.height < tip && a.confirmationsOf(p.height) >= ShearLedger.spendableConfirmations) {
        deep += p.nanos;
      }
    }
    expect(deep, greaterThan(0));
    expect(_units(a.spendableOwned(id.address, paymentCode: id.paymentCode)), deep);

    // Book B: the same wallet whose saved session is older than its header
    // window (the cursor two blocks above the pin, the notes there proven),
    // while the window holds only the last 16 headers. The next body it
    // needs has no checked header: the window is reset to the pin.
    final early = pin.height + 2;
    final poolB = ShearPoolClient(baseUrl: base, http: HttpClient());
    final b = ShearLedger(pool: poolB)..bindIdentity(id);
    b.installCheckpoint(pin, storePath: store);
    b.setBluMining(true);
    b.noteLiveHeight(tip);
    b.settleTo(tip);
    b.restoreBodyScan(required: true, scanTo: early);
    b.restoreSessionNotes(
      [
        for (final n in a.exportNotesForSession())
          if (((n['height'] as num?)?.toInt() ?? 0) <= early) n,
      ],
      paymentCode: id.paymentCode,
    );
    final provenEarly = b.notes.where((n) => n['bodyProven'] == true).length;
    expect(provenEarly, greaterThan(0), reason: 'the session carried proven notes');
    b.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    expect(_units(b.spendableOwned(id.address, paymentCode: id.paymentCode)), greaterThan(0));

    final okB = await b.scanVerifiedBodies(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      hostTip: 0,
      rounds: 1,
      fetch: bodies(poolB),
    );
    await b.bluScanInFlight;
    expect(okB, isFalse);
    b.noteSpendableReadFailed();
    expect(b.spendableReadError, 'rechecking headers from the checkpoint');
    expect(b.bodyScanTo, pin.height, reason: 'the body cursor goes back to the pin');
    for (final n in b.notes) {
      final h = (n['height'] as num?)?.toInt() ?? 0;
      if (h > pin.height) {
        expect(n['bodyProven'], isNot(true),
            reason: 'h=$h: its proof was made against a header the reset dropped');
      }
    }
    b.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    expect(_units(b.spendableOwned(id.address, paymentCode: id.paymentCode)), 0,
        reason: 'nothing above the pin is Spendable until its body is proven again');

    // The re-walk proves the bodies again against the headers it checks now.
    final again = await b.scanVerifiedBodies(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      hostTip: tip,
      rounds: 8,
      fetch: bodies(poolB),
    );
    await b.bluScanInFlight;
    expect(again, isTrue, reason: b.spendableReadError);
    expect(b.bodyScanTo, tip);
    b.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    expect(_units(b.spendableOwned(id.address, paymentCode: id.paymentCode)), deep);
    poolA.close();
    poolB.close();
  }, timeout: const Timeout(Duration(minutes: 20)));
}
