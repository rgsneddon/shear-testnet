import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_note.dart';

/// Each wallet shows its own opened coins. A pool-fee row stays on the wallet
/// that received it until the confirmation floor, and does not appear on another.
void main() {
  test('pool-fee rows stay until 9 confirmations and do not credit another wallet', () {
    final feeId = createIdentity();
    final otherId = createIdentity();
    final fee = ShearLedger()..bindIdentity(feeId);
    final other = ShearLedger()..bindIdentity(otherId);
    final feeDest = fee.homeDest(feeId.address, paymentCode: feeId.paymentCode);
    final otherDest = other.homeDest(otherId.address, paymentCode: otherId.paymentCode);
    fee.rememberDest(feeDest);
    other.rememberDest(otherDest);

    fee.mergeChainTx(ShearTx(
      id: 'fee:13:$feeDest',
      from: 'coinbase',
      to: feeDest,
      amount: 0.01,
      kind: 'pool-fee',
      height: 13,
      confirmed: false,
    ));
    fee.mergeChainTx(ShearTx(
      id: 'fee:14:$feeDest',
      from: 'coinbase',
      to: feeDest,
      amount: 0.01,
      kind: 'pool-fee',
      height: 14,
      confirmed: false,
    ));
    other.mergeChainTx(ShearTx(
      id: 'recv:14:$otherDest',
      from: 'pending',
      to: otherDest,
      amount: 1.0,
      kind: 'receive',
      height: 14,
      confirmed: false,
    ));

    fee.settleTo(20);
    other.settleTo(20);

    final feePending = fee.pendingTxs(feeId.address);
    final feeHeights = feePending.where((t) => t.kind == 'pool-fee').map((t) => t.height).toSet();
    expect(feeHeights, {13, 14});
    expect(feePending.where((t) => t.amount == 0.01).length, 2);
    expect(other.pendingTxs(otherId.address).any((t) => t.amount == 0.01), isFalse);
    expect(other.pendingTxs(otherId.address).any((t) => t.to == otherDest && t.amount == 1.0), isTrue);
    expect(fee.pendingTxs(feeId.address).any((t) => t.to == otherDest), isFalse);

    fee.settleTo(21);
    final after = fee.pendingTxs(feeId.address).where((t) => t.kind == 'pool-fee').map((t) => t.height).toSet();
    expect(after.contains(13), isFalse);
    expect(after.contains(14), isTrue);
  });

  test('a cached opening is this proof only and does not open a swapped proof', () {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final d20 = hash20FromAddress(dest)!;
    final commit = Uint8List.fromList(List<int>.filled(32, 4));
    final r = Uint8List.fromList(List<int>.filled(32, 5));
    final z = Uint8List.fromList(List<int>.filled(32, 6));
    final swappedZ = Uint8List.fromList(List<int>.filled(32, 9));
    final blind = Uint8List.fromList(List<int>.filled(32, 7));
    String hex(Uint8List b) => b.map((e) => e.toRadixString(16).padLeft(2, '0')).join();
    final key = '${hex(commit)}|${hex(r)}|${hex(z)}';
    // The scan uses the identity spend seed. Admit is absent, so the cached
    // nanos are the only way this fake proof opens.
    final spend = ledger.spendSeed!;

    Map<String, dynamic> scan(Uint8List proofZ) => scanSealedVouts({
          'vouts': [
            {
              'dest': dest,
              'kind': 'receive',
              'noteCommit': noteCommitOfDest20(d20),
              'commit': commit,
              'r': blind,
              'valueProof': {'R': r, 'z': proofZ, 'v': 1},
              'height': 1,
            },
          ],
          'dests': [dest],
          'dest': dest,
          'spendSeed': spend,
          'openedProofs': [
            {'k': key, 'n': 2500000000},
          ],
        });

    final hit = (scan(z)['notes'] as List).cast<Map>();
    expect(hit, isNotEmpty);
    expect(hit.first['verified'], isTrue);
    expect(hit.first['verifiedNanos'], 2500000000);
    expect(hit.first['amount'], closeTo(2500000000 / kUnitsPerShe, 1e-12));

    final miss = (scan(swappedZ)['notes'] as List).cast<Map>();
    expect(miss.where((n) => n['verified'] == true), isEmpty);

    // A second wallet with no cache does not open this proof, and it does not
    // receive the fee. Kind receive fails the claimed v once and stops.
    final other = createIdentity();
    final otherLedger = ShearLedger()..bindIdentity(other);
    final otherDest = otherLedger.homeDest(other.address, paymentCode: other.paymentCode);
    final otherScan = scanSealedVouts({
      'vouts': [
        {
          'dest': otherDest,
          'kind': 'receive',
          'noteCommit': noteCommitOfDest20(hash20FromAddress(otherDest)!),
          'commit': commit,
          'r': blind,
          'valueProof': {'R': r, 'z': z, 'v': 1},
          'height': 1,
        },
      ],
      'dests': [otherDest],
      'dest': otherDest,
      'spendSeed': otherLedger.spendSeed,
    });
    final foreign = (otherScan['notes'] as List).cast<Map>();
    expect(foreign.where((n) => n['verified'] == true), isEmpty);
    expect(foreign.any((n) => n['kind'] == 'pool-fee'), isFalse);

    final noCache = scanSealedVouts({
      'vouts': [
        {
          'dest': dest,
          'kind': 'receive',
          'noteCommit': noteCommitOfDest20(d20),
          'commit': commit,
          'r': blind,
          'valueProof': {'R': r, 'z': z, 'v': 1},
          'height': 3,
        },
      ],
      'dests': [dest],
      'dest': dest,
      'spendSeed': spend,
    });
    expect((noCache['notes'] as List).where((n) => n is Map && n['verified'] == true), isEmpty);
  });
}
