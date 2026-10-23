import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_identity.dart';

void main() {
  test('global kBookMagic is shear-testnet-v12', () {
    expect(kBookMagic, 'shear-testnet-v12');
  });
}
