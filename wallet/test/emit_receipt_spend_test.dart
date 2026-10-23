import 'package:flutter_test/flutter_test.dart';

import '../bin/emit_receipt_spend.dart' as emit;

/// flutter_tester can compile this package. The JS verifier reads the JSON line.
void main() {
  test('emit a receipt spend', () async {
    await emit.main();
  });
}
