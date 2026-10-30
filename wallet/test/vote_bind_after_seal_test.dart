import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_levy.dart';
import 'package:shear_wallet/shear_reserve.dart';

/// Vote fee is bindWeightFee on the sealed body the pool measures, then signed.
/// Any choice length. The floor is not special-cased.
void main() {
  test('stable weight fee covers any body and never moves down', () {
    final sizes = <int>[
      0,
      1,
      100,
      2047,
      2048,
      2049,
      10000,
      100000,
      204800,
      300000,
      500000,
      1000000,
    ];
    int? previous;
    for (final n in sizes) {
      final source = <String, dynamic>{
        'kind': 'vote',
        'pad': 'x' * n,
      };
      final withMax = bindStableWeightFee(source, maxLevy: true);
      final plain = bindStableWeightFee(source, maxLevy: false);
      expect(weightFeeCovers(withMax, source, maxLevy: true), isTrue, reason: 'max $n');
      expect(weightFeeCovers(plain, source, maxLevy: false), isTrue, reason: 'plain $n');
      expect(weightFeeCovers(withMax - 1, source, maxLevy: true), isFalse, reason: 'short $n');
      expect(withMax, inInclusiveRange(kLevyFloorUnits, kLevyCapNanos));
      expect(plain, inInclusiveRange(kLevyFloorUnits, kLevyCapNanos));
      if (n > kLevyFloorUnits * kLevyWeightRateDen) {
        expect(withMax, greaterThan(kLevyFloorUnits), reason: 'above floor $n');
      }
      if (previous != null) expect(withMax, greaterThanOrEqualTo(previous));
      previous = withMax;
      expect(source.containsKey('fee'), isFalse, reason: 'source untouched $n');
      expect(source.containsKey('sig'), isFalse);
      expect(weightFeeCovers(kLevyCapNanos + 1, source, maxLevy: true), isFalse);
      expect(weightFeeCovers(-1, source, maxLevy: true), isFalse);
    }
  });

  // Russell ruling 28 Oct: portal vote retired. "a posted vote fee is the
  // pool draft levy for any choice" checked the portal vote's fee; it is
  // replaced by the refusal below. The leaf vote's fee is leaf_vote_wire_test.
  test('a portal vote (kind=vote) is refused as retired for any choice and nothing is posted', () async {
    final choices = <String>['hold', kVoteHold, kVoteIncrease, kVoteDecrease, 'x', 'y' * 200];
    final id = createIdentity();
    final posts = <Map<String, dynamic>>[];
    final pool = _VotePool(posts);
    addTearDown(pool.close);
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    final from = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final vault = vaultDest(id.address, viewKey: id.viewKey)!;
    for (final choice in choices) {
      await expectLater(
        ledger.send(
          from: from,
          to: vault,
          amount: 0,
          kind: 'vote',
          programId: kReserveProgram,
          choice: choice,
          restFrame: id.address,
          paymentCode: id.paymentCode,
          spendSeed: hexToBytes(id.seedHex),
        ),
        throwsA(isA<StateError>().having((e) => e.message, 'message', kErrVoteRetired)),
        reason: choice,
      );
    }
    expect(posts, isEmpty);
    expect(kErrVoteRetired, startsWith('vote_retired'), reason: 'the same reason the node gives');
  });
}

class _VotePool extends ShearPoolClient {
  _VotePool(this.posts)
      : super(
          baseUrl: 'http://127.0.0.1:9',
          http: HttpClient()..connectionTimeout = const Duration(milliseconds: 50),
        );

  final List<Map<String, dynamic>> posts;

  @override
  Future<Map<String, dynamic>> mempoolPressure() async => {'depth': 0};

  @override
  Future<Map<String, dynamic>> send({
    required String from,
    required String to,
    required double amount,
    Map<String, dynamic>? memoCt,
    String? open,
    String? sig,
    String? portalOpen,
    String? kind,
    String? programId,
    String? choice,
    int? currentEpoch,
    int? epochStartMs,
    String? change,
    String? spendPub,
    String? ephPub,
    List<dynamic>? vin,
    List<dynamic>? vout,
    dynamic excess,
    Map<String, dynamic>? admitProof,
    List<Map<String, dynamic>>? admitProofs,
    String? spendTag,
    int? fee,
    int paintedOwedNanos = 0,
    bool legacyPoolSend = false,
    bool publicConsent = false,
    String? nanosWire,
    String? id,
    String? withdrawNonce,
    String? portalId,
    String? payoutPortalId,
    String? lockAuth,
    String? ownerPub,
    String? vaultLockNote,
    String? fs1,
    int? anchor,
  }) async {
    posts.add({
      'from': from,
      'to': to,
      'amount': amount,
      if (fee != null) 'fee': fee,
      'kind': kind,
      'programId': programId,
      'choice': choice,
      'sig': sig,
      'spendPub': spendPub,
      'vin': vin,
      'vout': vout,
    });
    return {
      'ok': true,
      'tx': {
        'id': 'vote-test',
        'from': from,
        'to': to,
        'amount': amount,
        'kind': kind ?? 'vote',
      },
    };
  }
}
