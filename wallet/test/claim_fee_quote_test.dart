import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_levy.dart';
import 'package:shear_wallet/shear_reserve.dart';

void main() {
  const body = <String, dynamic>{
    'kind': 'reward-claim',
    'vin': <dynamic>[],
    'vout': <dynamic>[
      {'kind': 'reward-claim'},
    ],
  };
  const oneOut = <dynamic>[{}];
  const twoOut = <dynamic>[{}, {}];

  test('vin and vout price Low Medium High; a stated weight is ignored', () {
    final empty = rewardClaimFeePresets(body: body);
    final floor = empty['floor'] as int;
    final emptyPresets = (empty['presets'] as List).cast<Map<String, dynamic>>();
    expect(emptyPresets.map((row) => row['fee']).toSet(), {floor});
    expect(emptyPresets.map((row) => row['she']).toSet(), {emptyPresets.first['she']});
    expect(floor, lessThan(1000));

    final quoted = rewardClaimFeePresets(
      body: body,
      mempool: const [
        {'fee': 1000, 'weight': 999, 'vin': <dynamic>[], 'vout': oneOut},
        {'fee': 5000, 'weight': 1, 'vin': <dynamic>[], 'vout': oneOut},
        {'fee': 20000, 'weight': 1, 'vin': <dynamic>[], 'vout': oneOut},
      ],
    );
    final presets = (quoted['presets'] as List).cast<Map<String, dynamic>>();
    expect(quoted['weight'], 25);
    expect(presets.map((row) => row['id']), ['low', 'medium', 'high']);
    expect(presets[0]['fee'], 1000);
    expect(presets[1]['fee'], 5000);
    expect(presets[2]['fee'], 20000);
    expect(presets[0]['she'], '0.00000001');
    expect(presets[1]['she'], '0.00000005');
    expect(presets[2]['she'], '0.0000002');
    expect(presets.map((row) => row['she']).toSet(), hasLength(3));
    expect(presets.every((row) => (row['fee'] as int) <= kLevyCapRho), isTrue);

    final peer = rewardClaimFeePresets(
      body: body,
      mempool: const [
        {'fee': 1000, 'weight': 1, 'vin': <dynamic>[], 'vout': twoOut},
      ],
    );
    final peerPresets = (peer['presets'] as List).cast<Map<String, dynamic>>();
    expect(peerPresets.map((row) => row['fee']).toSet(), {521});

    final lied = rewardClaimFeePresets(
      body: {...body, 'weight': 999},
      mempool: const [
        {'fee': 1000, 'weight': 25},
      ],
    );
    expect(lied['weight'], 25);
    final liedPresets = (lied['presets'] as List).cast<Map<String, dynamic>>();
    expect(liedPresets.first['fee'], 12500);

    final rows = mempoolQuoteRows({
      'pending': [
        {'id': 'a', 'fee': 1000, 'weight': 999, 'kind': 'send', 'vin': <dynamic>[], 'vout': oneOut},
        {'id': 'b', 'fee': 5000, 'weight': 1, 'kind': 'send', 'vin': <dynamic>[], 'vout': twoOut},
        {'id': 'c', 'fee': 0, 'weight': 25},
        {'id': 'd', 'fee': 20000, 'vout': oneOut},
      ],
    });
    expect(rows, hasLength(3));
    expect(rows.every((row) => !row.containsKey('weight')), isTrue);
    expect((rows[1]['vout'] as List).length, 2);
    final fromApi = rewardClaimFeePresets(body: body, mempool: rows);
    final apiPresets = (fromApi['presets'] as List).cast<Map<String, dynamic>>();
    expect(apiPresets[0]['fee'], 1000);
    expect(apiPresets[2]['fee'], 20000);
    expect(apiPresets[0]['she'], isNot(apiPresets[2]['she']));
  });

  test('the reward-claim helper posts rho', () {
    final built = rewardClaimSendBody(
      to: 'ssa1payee',
      rho: 42,
      nullifier: '11' * 32,
      proof: const [],
      vout: const [
        {'kind': 'reward-claim'},
      ],
      fee: 1000,
    );
    final tx = built['tx'] as Map<String, dynamic>;
    expect(tx['rho'], 42);
    expect(tx.containsKey('nanos'), isFalse);
    expect(tx['fee'], 1000);
  });

  test('a local scan keeps only this vault and seals to our payee', () async {
    final ident = createIdentity();
    final lock = vaultDest(ident.address, viewKey: ident.viewKey)!;
    final payee = (ShearLedger()..bindIdentity(ident))
        .currentDest(ident.address, paymentCode: ident.paymentCode);
    expect(payee.isNotEmpty, isTrue);
    expect(payee == lock, isFalse);
    final portal = portalIdFromDest(lock);
    final mine = withdrawMintId(portal, 1);
    const foreign = '2222222222222222222222222222222222222222222222222222222222222222';
    final leaves = <Map<String, dynamic>>[
      {'nullifier': foreign, 'rho': 7},
      {'nullifier': mine, 'rho': 42},
    ];
    final root = rewardSetRoot(leaves);
    final badRoot = root.startsWith('a') ? 'b${root.substring(1)}' : 'a${root.substring(1)}';
    final spent = <Map<String, dynamic>>[
      {'nullifier': mine, 'rho': 42, 'spent': true},
    ];
    final input = <String, dynamic>{
      'viewKey': ident.viewKey,
      'address': ident.address,
      'payee': payee,
      'epochs': <int>[1],
      'spendSeed': hexToBytes(ident.seedHex),
      'sets': [
        {'root': root, 'leaves': leaves},
        {'root': badRoot, 'leaves': leaves},
        {'root': rewardSetRoot(spent), 'leaves': spent},
      ],
    };
    final built = buildRewardClaimsWire(input);
    expect(built['ok'], isTrue);
    final rows = (built['rows'] as List).cast<Map<String, dynamic>>();
    expect(rows, hasLength(1));
    expect(rows.single['nullifier'], mine);
    expect(rows.single['rho'], 42);
    expect(rows.single.containsKey('nanos'), isFalse);
    expect(rows.single.containsKey('viewKey'), isFalse);
    final blob = rows.single.toString();
    expect(blob.contains(ident.viewKey), isFalse);
    final note = rows.single['vout'] as Map<String, dynamic>;
    expect(note['kind'], 'reward-claim');
    expect(note['address'], payee);
    expect(note.containsKey('portalId'), isFalse);
    expect(note['commit'], isA<Uint8List>());
    expect((note['r'] as Uint8List).length, 32);

    final again = buildRewardClaimsWire(input);
    final other = (again['rows'] as List).single as Map<String, dynamic>;
    final r1 = (note['r'] as Uint8List).join(',');
    final r2 = ((other['vout'] as Map)['r'] as Uint8List).join(',');
    expect(r1, isNot(r2));

    final wrong = buildRewardClaimsWire({...input, 'payee': lock});
    expect(wrong['ok'], isFalse);
    expect(wrong['reason'], 'payee');
    expect(wrong['rows'], isEmpty);

    final off = await scanRewardClaimsOffUi(input);
    expect(off['isolateStamp'], isNot(reserveIsolateStamp));
    expect((off['rows'] as List).single['nullifier'], mine);
  });
}
