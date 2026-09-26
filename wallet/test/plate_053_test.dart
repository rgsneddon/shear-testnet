import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_levy.dart';
import 'package:shear_wallet/shear_native_prove.dart';
import 'package:shear_wallet/shear_qr.dart';
import 'package:shear_wallet/shear_reserve.dart';

void main() {
  sealFlowOnCaller = true;
  debugFlowCryptoOnCaller = true;
  ShearLedger bookWithOwed(ShearIdentity id, {required double chain, required double owed, ShearPoolClient? pool}) {
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.applyPoolSnapshot(
      home,
      {'balance': chain, 'owedPi': owed},
      beforeHeight: 0,
      tipSealed: 0,
    );
    return ledger;
  }

  String repoRoot() {
    final here = Directory.current.path.replaceAll('\\', '/');
    if (here.endsWith('/wallet')) return Directory.current.parent.path;
    return Directory.current.path;
  }

  HttpClient realHttp() {
    return _PassthroughHttpOverrides().createHttpClient(null)
      ..connectionTimeout = const Duration(seconds: 20);
  }

  Future<_Gate> openGate(String owedShe) async {
    final proc = await Process.start(
      'node',
      ['pool/tests/painted_gate_server.mjs'],
      workingDirectory: repoRoot(),
      environment: {'SHEAR_PAINTED_OWED_SHE': owedShe},
    );
    final out = StringBuffer();
    final err = StringBuffer();
    proc.stdout.transform(utf8.decoder).listen(out.write);
    proc.stderr.transform(utf8.decoder).listen(err.write);
    final deadline = DateTime.now().add(const Duration(seconds: 15));
    while (!out.toString().contains('PORT ') && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 30));
    }
    final line = out.toString().split(RegExp(r'\r?\n')).cast<String>().firstWhere(
          (row) => row.startsWith('PORT '),
          orElse: () => '',
        );
    if (line.isEmpty) {
      proc.kill();
      throw StateError('painted gate did not listen\n$out\n$err');
    }
    final port = int.parse(line.split(' ').last.trim());
    return _Gate(proc, port, realHttp(), err);
  }

  test('reserve deposit posts from the painted figure when notes do not cover', () async {
    final gate = await openGate('22.58');
    addTearDown(() async {
      gate.http.close(force: true);
      gate.proc.kill();
    });
    final id = createIdentity();
    final pool = ShearPoolClient(
      baseUrl: 'http://127.0.0.1:${gate.port}',
      http: gate.http,
    );
    final ledger = bookWithOwed(id, chain: 0.02, owed: 22.58, pool: pool);
    final notes = chainNoteSum(ledger, id.address, paymentCode: id.paymentCode);
    final painted = paintedContinuumSpendable(ledger, id.address, paymentCode: id.paymentCode);
    const she = 3.2;
    final need = she + levyNanos((she * kUnitsPerShe).round(), depth: 0) / kUnitsPerShe;
    expect(notes, lessThan(need));
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), lessThan(need));
    expect(painted, greaterThan(need));
    expect(ledger.pool, isNotNull);
    final local = reserveLockPostsLocal(
      hasPool: ledger.pool != null,
      skipPoolSync: false,
      postReserveLock: false,
    );
    expect(local, isFalse);
    final dest = vaultDest(id.address, viewKey: id.viewKey);
    expect(dest, isNotNull);
    final reserve = ShearReserve();
    final before = ledger.transactions.where((t) => t.kind == 'lock').length;
    final posted = await postReserveDeposit(
      ledger: ledger,
      reserve: reserve,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      dest: dest!,
      she: she,
      depth: 0,
      spendSeed: hexToBytes(id.seedHex),
      local: local,
    );
    expect(posted.remark.toLowerCase(), isNot(contains('no spendable')));
    expect(posted.remark, isNot(contains('Not enough Continuum spendable')), reason: '${posted.remark}\n${gate.err}');
    expect(posted.posted, isTrue, reason: '${posted.remark}\n${gate.err}');
    expect(posted.tx, isNotNull);
    expect(posted.tx!.id, startsWith('lock-'));
    expect(posted.tx!.kind, 'lock');
    expect(ledger.transactions.where((t) => t.kind == 'lock').length, before + 1);
    expect(reserve.portal(dest).nanos, greaterThan(0));
    expect(ledger.owedTowardPi(id.address, paymentCode: id.paymentCode), lessThan(22.58));
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), lessThan(need));
  }, timeout: const Timeout(Duration(minutes: 3)));

  test('reserve deposit refuses when the painted figure does not cover amount plus fee', () async {
    final id = createIdentity();
    final ledger = bookWithOwed(id, chain: 0.01, owed: 0.02);
    final painted = paintedContinuumSpendable(ledger, id.address, paymentCode: id.paymentCode);
    const she = 1.0;
    expect(painted, lessThan(she));
    final owedBefore = ledger.owedTowardPi(id.address, paymentCode: id.paymentCode);
    final chainBefore = ledger.spendableOwned(id.address, paymentCode: id.paymentCode);
    final dest = vaultDest(id.address, viewKey: id.viewKey)!;
    final reserve = ShearReserve();
    final before = ledger.transactions.length;
    final refused = await postReserveDeposit(
      ledger: ledger,
      reserve: reserve,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      dest: dest,
      she: she,
      depth: 0,
      spendSeed: hexToBytes(id.seedHex),
      local: reserveLockPostsLocal(hasPool: false, skipPoolSync: false, postReserveLock: false),
    );
    expect(refused.posted, isFalse);
    expect(refused.tx, isNull);
    expect(refused.remark, contains('Not enough Continuum spendable'));
    expect(ledger.transactions.length, before);
    expect(reserve.portal(dest).nanos, 0);
    expect(ledger.owedTowardPi(id.address, paymentCode: id.paymentCode), closeTo(owedBefore, 1e-12));
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(chainBefore, 1e-12));
  });

  test('a refused pool post restores the painted figure', () async {
    final gate = await openGate('0');
    addTearDown(() async {
      gate.http.close(force: true);
      gate.proc.kill();
    });
    final id = createIdentity();
    final pool = ShearPoolClient(
      baseUrl: 'http://127.0.0.1:${gate.port}',
      http: gate.http,
    );
    final ledger = bookWithOwed(id, chain: 0.02, owed: 22.58, pool: pool);
    final owedBefore = ledger.owedTowardPi(id.address, paymentCode: id.paymentCode);
    final chainBefore = ledger.spendableOwned(id.address, paymentCode: id.paymentCode);
    final dest = vaultDest(id.address, viewKey: id.viewKey)!;
    final local = reserveLockPostsLocal(
      hasPool: true,
      skipPoolSync: false,
      postReserveLock: false,
    );
    expect(local, isFalse);
    final refused = await postReserveDeposit(
      ledger: ledger,
      reserve: ShearReserve(),
      restFrame: id.address,
      paymentCode: id.paymentCode,
      dest: dest,
      she: 3.2,
      depth: 0,
      spendSeed: hexToBytes(id.seedHex),
      local: local,
    );
    expect(refused.posted, isFalse, reason: refused.remark);
    expect(refused.tx, isNull);
    expect(refused.remark.toLowerCase(), contains('insufficient'));
    expect(ledger.transactions.where((t) => t.kind == 'lock'), isEmpty);
    expect(ledger.owedTowardPi(id.address, paymentCode: id.paymentCode), closeTo(owedBefore, 1e-9));
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(chainBefore, 1e-9));

    final bob = createIdentity();
    final payload = encodeReceiveQr(bob.paymentCodeFull);
    final send = await submitContinuumSend(
      ledger: ledger,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      startTo: '',
      enteredTo: payload,
      amount: 0.2,
      spendSeed: hexToBytes(id.seedHex),
    );
    expect(send.posted, isFalse, reason: send.remark);
    expect(ledger.transactions.where((t) => t.kind == 'send'), isEmpty);
    expect(ledger.owedTowardPi(id.address, paymentCode: id.paymentCode), closeTo(owedBefore, 1e-9));
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(chainBefore, 1e-9));
  }, timeout: const Timeout(Duration(minutes: 4)));

  test('continuum send and receive use the full payable address', () async {
    final gate = await openGate('22.58');
    addTearDown(() async {
      gate.http.close(force: true);
      gate.proc.kill();
    });
    final alice = createIdentity();
    final bob = createIdentity();
    final pool = ShearPoolClient(
      baseUrl: 'http://127.0.0.1:${gate.port}',
      http: gate.http,
    );
    final ledger = bookWithOwed(alice, chain: 0.02, owed: 22.58, pool: pool);
    final payload = encodeReceiveQr(bob.paymentCodeFull);
    expect(payload, bob.paymentCodeFull);
    expect(isFullPaymentCode(payload), isTrue);
    final notes = chainNoteSum(ledger, alice.address, paymentCode: alice.paymentCode);
    const amount = 0.2;
    final need = amount + levyNanos((amount * kUnitsPerShe).round(), depth: 0) / kUnitsPerShe;
    expect(notes, lessThan(need));
    expect(ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode), lessThan(need));
    expect(
      paintedContinuumSpendable(ledger, alice.address, paymentCode: alice.paymentCode),
      greaterThan(need),
    );
    expect(ledger.pool, isNotNull);
    const startTo = '';
    final finger = await submitContinuumSend(
      ledger: ledger,
      restFrame: alice.address,
      paymentCode: alice.paymentCode,
      startTo: startTo,
      enteredTo: bob.paymentFingerprint,
      amount: amount,
      spendSeed: hexToBytes(alice.seedHex),
    );
    expect(finger.posted, isFalse);
    expect(finger.to, startTo);
    expect(finger.remark, kErrShortShe1);
    expect(ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode), closeTo(0.02, 1e-12));
    final she = await submitContinuumSend(
      ledger: ledger,
      restFrame: alice.address,
      paymentCode: alice.paymentCode,
      startTo: startTo,
      enteredTo: payload,
      amount: amount,
      spendSeed: hexToBytes(alice.seedHex),
    );
    expect(she.posted, isTrue, reason: '${she.remark}\n${debugLastContinuumSendError}\n${gate.err}');
    expect(she.to, payload);
    expect(she.tx, isNotNull);
    expect(she.tx!.id, startsWith('tx-'));
    expect(she.tx!.kind, 'send');
    final bobBook = ShearLedger()..bindIdentity(bob);
    final ssa = bobBook.homeDest(bob.address, paymentCode: bob.paymentCode);
    expect(isDestAddress(ssa), isTrue);
    final ssaSend = await submitContinuumSend(
      ledger: ledger,
      restFrame: alice.address,
      paymentCode: alice.paymentCode,
      startTo: payload,
      enteredTo: ssa,
      amount: amount,
      spendSeed: hexToBytes(alice.seedHex),
    );
    expect(ssaSend.posted, isTrue, reason: '${ssaSend.remark}\n${debugLastContinuumSendError}\n${gate.err}');
    expect(ssaSend.to, ssa);
    expect(ssaSend.tx!.id, startsWith('tx-'));
    expect(ssaSend.tx!.kind, 'send');
    final short = await submitContinuumSend(
      ledger: ledger,
      restFrame: alice.address,
      paymentCode: alice.paymentCode,
      startTo: payload,
      enteredTo: 'she1short',
      amount: 0.1,
      spendSeed: hexToBytes(alice.seedHex),
    );
    expect(short.posted, isFalse);
    expect(short.to, payload);
  }, timeout: const Timeout(Duration(minutes: 6)));

  test('local node spawn has no bootstrap URL and the light seeker stays strict', () {
    for (final mode in ClosureSendMode.values) {
      for (final empty in [true, false]) {
        final args = closureSpawnArgs(emptyDatadir: empty, mode: mode);
        expect(args.join(' '), isNot(contains('bootstrap')));
        expect(args.join(' '), isNot(contains('boot.shear.digital')));
      }
    }
    expect(kLocalNodeModeCopy.toLowerCase(), isNot(contains('auto-bootstrap')));
    expect(kLocalNodeModeCopy.toLowerCase(), isNot(contains('auto bootstrap')));
    expect(kLocalNodeFullModeCopy.toLowerCase(), isNot(contains('auto bootstrap')));
    expect(localNodeMatchesSeeker(nodeHeight: 0, ibd: false, seekerTip: 8), isFalse);
    expect(localNodeMatchesSeeker(nodeHeight: 8, ibd: true, seekerTip: 8), isFalse);
    expect(localNodeMatchesSeeker(nodeHeight: 7, ibd: false, seekerTip: 8), isFalse);
    expect(localNodeMatchesSeeker(nodeHeight: 8, ibd: false, seekerTip: 8), isTrue);
    expect(localNodeMatchesSeeker(nodeHeight: 9, ibd: false, seekerTip: 8), isTrue);
  });
}

class _Gate {
  _Gate(this.proc, this.port, this.http, this.err);

  final Process proc;
  final int port;
  final HttpClient http;
  final StringBuffer err;
}

class _PassthroughHttpOverrides extends HttpOverrides {}
