import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_vault_reward.dart' show hiddenChangeNote;

Uint8List _seedOf(ShearIdentity id) => Uint8List.fromList([
      for (var i = 0; i < 32; i++) int.parse(id.seedHex.substring(i * 2, i * 2 + 2), radix: 16),
    ]);

/// Spendable is only real notes mined deep enough: never a remembered figure,
/// never a bare credit, never a note with no block height.
void main() {
  const tip = 40;
  const nanos = 300000000000; // 3 SHE

  ShearLedger ledgerAtTip(ShearIdentity id) {
    final ledger = ShearLedger()..bindIdentity(id);
    ledger.noteLiveHeight(tip);
    ledger.settleTo(tip);
    return ledger;
  }

  Map<String, dynamic> sealedOn(String dest, Uint8List seed, {int? height}) {
    final note = hiddenChangeNote(
      nanos,
      hash20FromAddress(dest)!,
      spendSeed: seed,
      admitBase: admitPub(admitBaseScalar(seed)),
    );
    expect(note, isNotNull, reason: 'a real sealed note');
    return {
      ...note!,
      'address': dest,
      'dest': dest,
      'kind': 'send',
      'nanos': nanos,
      'amount': nanos / kUnitsPerShe,
      'spendSeed': seed,
      'verified': true,
      if (height != null) 'height': height,
    };
  }

  int spendableUnits(ShearLedger ledger, ShearIdentity id) {
    ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    return (ledger.spendableOwned(id.address, paymentCode: id.paymentCode) * kUnitsPerShe).round();
  }

  test('a remembered figure with no note behind it is never Spendable', () {
    final id = createIdentity();
    final ledger = ledgerAtTip(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberSpendable(home, 5);
    ledger.rememberSpendable(id.address, 5);
    expect(spendableUnits(ledger, id), 0);
    expect(ledger.spendable(home), 0);
  });

  test('a bare round credit with no sealed note is never Spendable', () {
    final id = createIdentity();
    final ledger = ledgerAtTip(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.confirmRound(address: home, pot: 1, height: 20);
    ledger.settleTo(tip);
    expect(spendableUnits(ledger, id), 0);
  });

  test('a real note with no block height is Pending, and Spendable once mined deep enough', () {
    final id = createIdentity();
    final seed = _seedOf(id);
    final ledger = ledgerAtTip(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final unmined = sealedOn(home, seed);
    ledger.rememberNote(unmined);
    expect(spendableUnits(ledger, id), 0, reason: 'no height: not Spendable');
    expect((ledger.pending(id.address, paymentCode: id.paymentCode) * kUnitsPerShe).round(), nanos, reason: 'Pending until mined');

    final shallow = ShearLedger()..bindIdentity(id);
    shallow.noteLiveHeight(tip);
    shallow.settleTo(tip);
    shallow.rememberNote(sealedOn(home, seed, height: tip));
    expect(spendableUnits(shallow, id), 0, reason: 'too few confirmations: not Spendable');

    final deep = ledgerAtTip(id);
    deep.rememberNote(sealedOn(home, seed, height: 20));
    expect(spendableUnits(deep, id), nanos, reason: 'mined deep enough: exactly the note');
    expect((deep.pending(id.address, paymentCode: id.paymentCode) * kUnitsPerShe).round(), 0);
  });
}
