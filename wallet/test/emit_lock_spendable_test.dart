import 'package:flutter_test/flutter_test.dart';

import '../bin/emit_lock_spendable.dart' as emit;

/// flutter_tester runs the wallet's prover; the node e2e reads the one JSON
/// line this prints (SHEAR_LOCK_FIXTURE, SHEAR_LOCK_PHASE).
void main() {
  test('emit a lock and the Spendable around it', () async {
    await emit.main();
  });
}
