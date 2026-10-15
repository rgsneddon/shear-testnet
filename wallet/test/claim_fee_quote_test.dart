import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_levy.dart';

void main() {
  const body = <String, dynamic>{
    'kind': 'reward-claim',
    'vin': <dynamic>[],
    'vout': <dynamic>[
      {'kind': 'reward-claim'},
    ],
  };

  test('stated mempool weight prices Low Medium High as distinct exact SHE', () {
    final empty = rewardClaimFeePresets(body: body);
    final floor = empty['floor'] as int;
    final emptyPresets = (empty['presets'] as List).cast<Map<String, dynamic>>();
    expect(emptyPresets.map((row) => row['fee']).toSet(), {floor});
    expect(emptyPresets.map((row) => row['she']).toSet(), {emptyPresets.first['she']});
    expect(floor, lessThan(1000));

    final quoted = rewardClaimFeePresets(
      body: body,
      mempool: const [
        {'fee': 1000, 'weight': 25},
        {'fee': 5000, 'weight': 25},
        {'fee': 20000, 'weight': 25},
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
    expect(presets.every((row) => (row['fee'] as int) <= kLevyCapNanos), isTrue);

    final rows = mempoolQuoteRows({
      'pending': [
        {'id': 'a', 'fee': 1000, 'weight': 25, 'kind': 'send'},
        {'id': 'b', 'fee': 5000, 'weight': 48, 'kind': 'send'},
        {'id': 'c', 'fee': 0, 'weight': 25},
        {'id': 'd', 'fee': 20000},
      ],
    });
    expect(rows, hasLength(3));
    expect(rows[1]['weight'], 48);
    expect(rows[2].containsKey('weight'), isFalse);
    final fromApi = rewardClaimFeePresets(body: body, mempool: rows);
    final apiPresets = (fromApi['presets'] as List).cast<Map<String, dynamic>>();
    expect(apiPresets[0]['fee'], isNot(apiPresets[2]['fee']));
    expect(apiPresets[0]['she'], isNot(apiPresets[2]['she']));
    expect(apiPresets[0]['fee'], greaterThanOrEqualTo(floor));
  });
}
