import 'package:flutter_test/flutter_test.dart';

import '../bin/emit_proved_withdraw.dart' as emit;

/// flutter_tester can compile this package. `dart run` cannot: the prover
/// imports Flutter. The JS verifier reads the one JSON line from stdout.
void main() {
  test('emit a proved withdraw', () {
    emit.main();
  });
}
