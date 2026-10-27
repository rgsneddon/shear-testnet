import 'package:flutter_test/flutter_test.dart';

import '../bin/emit_wallet_identity.dart' as emit;

/// The node e2e reads the one JSON line this prints (SHEAR_WALLET_SEED).
void main() {
  test('emit the wallet a seed restores', () async {
    await emit.main();
  });
}
