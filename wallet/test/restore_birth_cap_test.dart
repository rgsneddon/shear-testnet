import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';

/// P1-4 (WH review of the claude/* wallet branches). A restore's birth
/// height is what the user types. A wrong-high birth silently hid every coin
/// below it. Now it is capped at the tip this wallet verified, the user is
/// told what a birth hides, and Settings can lower it later.
void main() {
  test('a typed birth above the verified tip is capped there, with a warning', () {
    final r = restoreBirthFor(5000, verifiedTip: 1200);
    expect(r.birth, 1200);
    expect(r.warning, contains('above the verified chain tip (1200)'));
    expect(r.warning, contains('block 1200'));
  });

  test('with nothing verified a typed birth scans from genesis', () {
    final r = restoreBirthFor(1234, verifiedTip: 0);
    expect(r.birth, 0);
    expect(r.warning, contains('genesis'));
  });

  test('a birth at or under the tip stands, and the user is told what it hides', () {
    final r = restoreBirthFor(900, verifiedTip: 1200);
    expect(r.birth, 900);
    expect(r.warning, contains('below block 900 will not be found'));
    expect(r.warning, contains('Settings'));
    expect(restoreBirthFor(1200, verifiedTip: 1200).birth, 1200);
  });

  test('no birth (or a non-positive one) is genesis with nothing to warn', () {
    for (final typed in [0, -5]) {
      final r = restoreBirthFor(typed, verifiedTip: 1200);
      expect(r.birth, 0);
      expect(r.warning, isEmpty);
    }
  });

  test('Settings can lower the birth: the body scan reads again from there', () {
    final ledger = ShearLedger()..bindIdentity(createIdentity());
    ledger.setBirthHeight(500);
    ledger.restoreBodyScan(required: true, scanTo: 800);
    expect(ledger.bodyScanTo, 800);
    expect(ledger.lowerBirthHeight(600), isFalse, reason: 'only lowers');
    expect(ledger.birthHeight, 500);
    expect(ledger.lowerBirthHeight(200), isTrue);
    expect(ledger.birthHeight, 200);
    expect(ledger.bodyScanTo, 199, reason: 'bodies from the new birth are read');
    expect(ledger.lowerBirthHeight(0), isTrue);
    expect(ledger.bodyScanTo, 0);
  });
}
