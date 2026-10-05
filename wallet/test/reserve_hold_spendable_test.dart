import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';

void main() {
  test('a confirmed 1 SHE reserve hold is not spendable, and a pending debit is not a second cut', () {
    final ledger = ShearLedger();
    final once = ledger.spendableAfterVaultHold(
      notesShe: 1.48,
      pendingDebitShe: 0,
      vaultShe: 1,
    );
    final both = ledger.spendableAfterVaultHold(
      notesShe: 1.48,
      pendingDebitShe: 1,
      vaultShe: 1,
    );
    final none = ledger.spendableAfterVaultHold(
      notesShe: 1.48,
      pendingDebitShe: 0,
      vaultShe: 0,
    );
    expect(once, closeTo(0.48, 1e-12));
    expect(both, closeTo(0.48, 1e-12));
    expect(none, closeTo(1.48, 1e-12));
  });

  test('vault principal comes off the opened fee notes once', () {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final vault = vaultDest(id.address, viewKey: id.viewKey);
    expect(vault, isNotNull);
    expect(vault, isNot(home));
    final commit = Uint8List.fromList(List<int>.filled(32, 4));
    ledger.rememberNote({
      'address': home,
      'dest': home,
      'kind': 'pool-fee',
      'commit': commit,
      'amount': 1.48,
      'height': 1,
      'verified': true,
      'proofChecked': true,
      'verifiedNanos': 148000000000,
      'proofKey': 'aa|bb|cc',
    });
    ledger.restoreOpenedProofs([
      {'k': 'aa|bb|cc', 'n': 148000000000},
    ]);
    final saved = ledger.exportNotesForSession();
    final fresh = ShearLedger()..bindIdentity(id);
    fresh.restoreSealedTip(9);
    fresh.restoreSessionNotes(saved, covered: 9, paymentCode: id.paymentCode);
    expect(
      fresh.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(1.48, 1e-9),
    );
    fresh.setReserveHeldNanos(vault!, kUnitsPerShe);
    expect(
      fresh.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(0.48, 1e-9),
    );
    fresh.setReserveHeldNanos(vault, kUnitsPerShe);
    expect(
      fresh.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(0.48, 1e-9),
    );
    expect(fresh.usableSpendable(home), closeTo(0.48, 1e-9));
  });
}
