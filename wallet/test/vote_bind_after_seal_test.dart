import 'dart:convert';
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

  test('a posted vote fee is the pool draft levy for any choice', () async {
    final choices = <String>[
      'hold',
      kVoteHold,
      kVoteIncrease,
      kVoteDecrease,
      'x',
      'y' * 200,
    ];
    final repo = Directory.current.path.replaceAll('\\', '/').endsWith('/wallet')
        ? Directory.current.parent.path
        : Directory.current.path;
    for (var n = 0; n < choices.length; n++) {
      final id = createIdentity();
      final posts = <Map<String, dynamic>>[];
      final pool = _VotePool(posts);
      addTearDown(pool.close);
      final ledger = ShearLedger(pool: pool)..bindIdentity(id);
      final from = ledger.homeDest(id.address, paymentCode: id.paymentCode);
      final vault = vaultDest(id.address, viewKey: id.viewKey)!;
      ledger.confirmRound(address: from, pot: 2, height: 2);
      ledger.settleTo(2 + ShearLedger.spendableConfirmations);
      await ledger.send(
        from: from,
        to: vault,
        amount: 0,
        kind: 'vote',
        programId: kReserveProgram,
        choice: choices[n],
        restFrame: id.address,
        paymentCode: id.paymentCode,
        spendSeed: hexToBytes(id.seedHex),
      );
      expect(posts, hasLength(1), reason: choices[n]);
      final body = posts.single;
      expect(body['kind'], 'vote');
      expect(body['fee'], isA<int>());
      expect(body['fee'] as int, greaterThanOrEqualTo(kLevyFloorUnits));
      final file = File(
        '${Directory.systemTemp.path}${Platform.pathSeparator}shear-vote-bind-$n.json',
      );
      file.writeAsStringSync(jsonEncode(body));
      addTearDown(() {
        if (file.existsSync()) file.deleteSync();
      });
      final checked = Process.runSync(
        'node',
        ['tests/verify_posted_reserve.mjs', file.path],
        workingDirectory: repo,
      );
      expect(
        checked.exitCode,
        0,
        reason: '${choices[n]} ${checked.stdout} ${checked.stderr}',
      );
      final verified = jsonDecode(checked.stdout.toString()) as Map;
      expect(verified['equal'], true, reason: choices[n]);
      expect(verified['status'], 200);
      expect(verified['kind'], 'vote');
      expect(verified['fee'], body['fee']);
    }
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
    int? anchor,
    int? fee,
    int paintedOwedNanos = 0,
    bool legacyPoolSend = false,
    String? nanosWire,
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
