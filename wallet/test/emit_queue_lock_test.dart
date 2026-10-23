import 'package:flutter_test/flutter_test.dart';

import '../bin/emit_queue_lock.dart' as emit;

/// flutter_tester can compile this package. `dart run` cannot: the prover
/// imports Flutter. The JS verifier reads the one JSON line from stdout.
void main() {
  test('emit a queued lock', () async {
    await emit.main();
  });
}
