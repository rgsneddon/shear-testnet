import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_qr.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_ctf.dart';

void main() {
  ShearLedger bookWithOwed(ShearIdentity id, {required double chain, required double owed}) {
    final ledger = ShearLedger()..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.applyPoolSnapshot(
      home,
      {'balance': chain, 'owedPi': owed},
      beforeHeight: 0,
      tipSealed: 0,
    );
    return ledger;
  }

  test('reserve deposit posts from the painted figure when notes do not cover', () async {
    final id = createIdentity();
    final ledger = bookWithOwed(id, chain: 0.02, owed: 3);
    final notes = chainNoteSum(ledger, id.address, paymentCode: id.paymentCode);
    final painted = paintedContinuumSpendable(ledger, id.address, paymentCode: id.paymentCode);
    const she = 1.0;
    expect(notes, lessThan(she));
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), lessThan(she));
    expect(painted, greaterThan(she));
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
      local: true,
    );
    expect(posted.remark.toLowerCase(), isNot(contains('no spendable')));
    expect(posted.remark, isNot(contains('Not enough Continuum spendable')));
    expect(posted.posted, isTrue);
    expect(posted.tx, isNotNull);
    expect(posted.tx!.kind, 'lock');
    expect(ledger.transactions.where((t) => t.kind == 'lock').length, before + 1);
    expect(reserve.portal(dest).nanos, greaterThan(0));
  });

  test('reserve deposit refuses when the painted figure does not cover amount plus fee', () async {
    final id = createIdentity();
    final ledger = bookWithOwed(id, chain: 0.01, owed: 0.02);
    final painted = paintedContinuumSpendable(ledger, id.address, paymentCode: id.paymentCode);
    const she = 1.0;
    expect(painted, lessThan(she));
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
      local: true,
    );
    expect(refused.posted, isFalse);
    expect(refused.tx, isNull);
    expect(refused.remark, contains('Not enough Continuum spendable'));
    expect(ledger.transactions.length, before);
    expect(reserve.portal(dest).nanos, 0);
  });

  test('continuum send and receive use the full payable address', () async {
    final alice = createIdentity();
    final bob = createIdentity();
    final ledger = bookWithOwed(alice, chain: 0.01, owed: 5);
    final payload = encodeReceiveQr(bob.paymentCodeFull);
    expect(payload, bob.paymentCodeFull);
    expect(isFullPaymentCode(payload), isTrue);
    const startTo = '';
    final finger = await submitContinuumSend(
      ledger: ledger,
      restFrame: alice.address,
      paymentCode: alice.paymentCode,
      startTo: startTo,
      enteredTo: bob.paymentFingerprint,
      amount: 0.2,
      spendSeed: hexToBytes(alice.seedHex),
      local: true,
    );
    expect(finger.posted, isFalse);
    expect(finger.to, startTo);
    expect(finger.remark, kErrShortShe1);
    final she = await submitContinuumSend(
      ledger: ledger,
      restFrame: alice.address,
      paymentCode: alice.paymentCode,
      startTo: startTo,
      enteredTo: payload,
      amount: 0.2,
      spendSeed: hexToBytes(alice.seedHex),
      local: true,
    );
    expect(she.posted, isTrue, reason: she.remark);
    expect(she.to, payload);
    expect(she.tx, isNotNull);
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
      amount: 0.2,
      spendSeed: hexToBytes(alice.seedHex),
      local: true,
    );
    expect(ssaSend.posted, isTrue, reason: ssaSend.remark);
    expect(ssaSend.tx!.kind, 'send');
    final short = await submitContinuumSend(
      ledger: ledger,
      restFrame: alice.address,
      paymentCode: alice.paymentCode,
      startTo: payload,
      enteredTo: 'she1short',
      amount: 0.1,
      spendSeed: hexToBytes(alice.seedHex),
      local: true,
    );
    expect(short.posted, isFalse);
    expect(short.to, payload);
  });

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
