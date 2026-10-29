import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_reserve.dart' hide kPiSheNanos;
import 'package:shear_wallet/shear_vault_reward.dart';

/// Claim and roll both call [vaultRewardProveInput]. The chain leaf was opened
/// at the portal lock epoch. A missing lockEpoch opens epoch 0 instead.
void main() {
  test('claim and roll prove input matches the lockEpoch chain leaf', () {
    const dest = 'portal-lock-epoch-3';
    final reserve = ShearReserve();
    final portal = reserve.portal(dest)
      ..lockAmount = kPiSheNanos
      ..lockRemainMs = 1
      ..lockEpoch = 3
      ..lockIndex = 0;
    final seed = Uint8List(32);
    for (var i = 0; i < seed.length; i++) seed[i] = i + 1;
    final oracle = <String, dynamic>{
      'amount': portal.lockAmount,
      'seed': seed,
      'index': portal.lockIndex,
      'lockEpoch': portal.lockEpoch,
    };
    final chainLeaf = vaultLockOpeningNote(oracle);
    final other = Uint8List(64)..[0] = 1;
    final census = VaultLockCensus([other, chainLeaf], Uint8List(32)..[0] = 9);
    final input = vaultRewardProveInput(
      reserve: reserve,
      dest: dest,
      payout: dest,
      seed: seed,
    );
    expect(input, isNotNull);
    final attached = attachVaultLockCensus(input!, census);
    expect(attached['which'], 1);
  });
}
