import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_levy.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_session.dart';

void main() {
  test('epoch day is 1-based and never 0', () {
    const start = 1_700_000_000_000;
    expect(reserveDayOfEpoch(epochStartMs: 0, nowMs: start), 1);
    expect(
      reserveDayOfEpoch(epochStartMs: start, nowMs: start + 86400000 - 1),
      1,
    );
    expect(
      reserveDayOfEpoch(epochStartMs: start, nowMs: start + (86400000 * 1.4).floor()),
      2,
    );
    expect(
      reserveDayOfEpoch(epochStartMs: start, nowMs: start + 86400000 * 9),
      kReserveEpochDays,
    );
    expect(
      reserveDayOfEpoch(epochStartMs: start, nowMs: start),
      inInclusiveRange(1, kReserveEpochDays),
    );
  });

  test('avg block reward is gross sealed pot over height with no 1.0 clamp', () {
    final half = sealedAvgBlockRewardShe(
      potEmittedNanos: 50 * kUnitsPerShe,
      hashBonusEmittedNanos: 0,
      height: 100,
    );
    expect(half, 0.5);
    final gross = sealedAvgBlockRewardShe(
      potEmittedNanos: 100 * kUnitsPerShe,
      hashBonusEmittedNanos: 0,
      height: 100,
    );
    expect(gross, 1.0);
    expect(gross, isNot(0.99));
    expect(
      sealedAvgBlockRewardShe(potEmittedNanos: 0, hashBonusEmittedNanos: 0, height: 0),
      isNull,
    );
    final fat = sealedAvgBlockRewardShe(
      potEmittedNanos: 150 * kUnitsPerShe,
      hashBonusEmittedNanos: 50 * kUnitsPerShe,
      height: 100,
    );
    expect(fat, 2.0);
    final dust = sealedAvgBlockRewardShe(
      potEmittedNanos: 179600000000000,
      hashBonusEmittedNanos: 10477056,
      height: 1796,
    );
    expect(dust, isNotNull);
    expect(dust, isNot(1.0));
    expect(
      dust,
      (179600000000000 + 10477056) / 1796 / kUnitsPerShe,
    );
    expect(
      avgBlockRewardLabel(
        potEmittedNanos: 150 * kUnitsPerShe,
        hashBonusEmittedNanos: 50 * kUnitsPerShe,
        height: 100,
      ),
      isNot('1.000000000 SHE'),
    );
  });

  test('archive unlock does not invent spendable and a zero supply does not wipe Q', () {
    final id = createIdentity();
    final ledger = ShearLedger()..viewSecret = id.viewKey;
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    applyUserArchive(ledger, {
      'dests': [dest],
      'sealedHeight': 4,
      'txs': [
        {
          'id': 'land',
          'from': 'coinbase',
          'to': dest,
          'amount': 40,
          'kind': 'coinbase',
          'height': 2,
          'confirmed': true,
        },
      ],
    });
    expect(ledger.spendable(dest), 0);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
    ledger.rememberSpendable(dest, 0.25);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(0.25, 1e-12));
    ledger.applyCirculatingNanos(100 * kUnitsPerShe);
    ledger.applyCirculatingNanos(0);
    expect(ledger.circulatingNanos, 100 * kUnitsPerShe);
    expect(integralQCirculationLabel(null), '—');
    expect(integralQCirculationLabel(0), '—');
    expect(integralQCirculationLabel(ledger.circulatingNanos), contains('(circulation)'));
    expect(
      spendableExceedsCirculating(
        spendableShe: 0.25,
        circulatingNanos: ledger.circulatingNanos,
      ),
      isFalse,
    );
    expect(
      spendableExceedsCirculating(spendableShe: 101, circulatingNanos: 100 * kUnitsPerShe),
      isTrue,
    );
    expect(
      fundsNotCorrectlyShown(spendableShe: 101, circulatingNanos: 100 * kUnitsPerShe),
      isTrue,
    );
    expect(
      fundsNotCorrectlyShown(spendableShe: 0.25, circulatingNanos: ledger.circulatingNanos),
      isFalse,
    );
    expect(kFundsNotCorrectlyShown, 'Your funds are not correctly shown.');
  });

  test('withdraw sign does not credit Continuum spendable', () async {
    final alice = createIdentity();
    final ledger = ShearLedger()..bindIdentity(alice);
    final continuum = ledger.homeDest(alice.address, paymentCode: alice.paymentCode);
    ledger.confirmRound(address: continuum, pot: 10, height: 1);
    ledger.settleTo(1 + ShearLedger.spendableConfirmations);
    final vault = vaultDest(alice.address, viewKey: alice.viewKey)!;
    const t0 = 1700000000000;
    final reserve = ShearReserve();
    expect(reserve.deposit(dest: vault, she: kPiShe, nowMs: t0, payout: continuum), isNull);
    await ledger.send(
      from: continuum,
      to: vault,
      amount: kPiShe,
      local: true,
      kind: 'lock',
      programId: kReserveProgram,
    );
    final afterLock = ledger.spendable(continuum);
    expect(afterLock, lessThan(10));
    final out = reserve.withdrawTo(
      ledger,
      dest: vault,
      payout: continuum,
      nowMs: t0 + kReserveEpochMs,
    );
    expect(out, isNotNull);
    expect(ledger.spendable(continuum), closeTo(afterLock, 1e-12));
    expect(ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode), closeTo(afterLock, 1e-12));
    expect(reserve.portal(vault).nanos, 0);
    final painted = ledger.creditReserve(to: continuum, amount: kPiShe + 1);
    expect(painted.confirmed, isFalse);
    expect(ledger.spendable(continuum), closeTo(afterLock, 1e-12));
    expect(ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode), closeTo(afterLock, 1e-12));
    expect(ledger.transactions.where((t) => t.kind == 'reserve' || t.id == painted.id), isEmpty);
  });

  test('confirmed lock lowers spendableOwned by lock plus levy once', () async {
    final alice = createIdentity();
    final ledger = ShearLedger()..bindIdentity(alice);
    final continuum = ledger.homeDest(alice.address, paymentCode: alice.paymentCode);
    ledger.confirmRound(address: continuum, pot: 101, height: 1);
    ledger.settleTo(1 + ShearLedger.spendableConfirmations);
    final before = ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode);
    const lockShe = 100.0;
    final lockNanos = (lockShe * kUnitsPerShe).round();
    final levy = levyNanos(lockNanos);
    final vault = vaultDest(alice.address, viewKey: alice.viewKey)!;
    const t0 = 1700000000000;
    final reserve = ShearReserve();
    expect(reserve.deposit(dest: vault, she: lockShe, nowMs: t0, payout: continuum), isNull);
    final tx = await ledger.send(
      from: continuum,
      to: vault,
      amount: lockShe,
      local: true,
      kind: 'lock',
      programId: kReserveProgram,
    );
    expect(tx.kind, 'lock');
    final after = ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode);
    final levyShe = levy / kUnitsPerShe;
    expect(after, closeTo(before - lockShe - levyShe, 1e-9));
    expect(reserve.totalLockedNanos, lockNanos);
    expect(reserve.portal(vault).nanos, lockNanos);
    expect(ledger.spendable(vault), 0);
    expect(after + lockShe, closeTo(before - levyShe, 1e-9));
    ledger.settleTo(1 + ShearLedger.spendableConfirmations);
    expect(
      ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode),
      closeTo(after, 1e-9),
    );
    expect(reserve.totalLockedNanos, lockNanos);
  });
}
