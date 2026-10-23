import 'package:flutter_test/flutter_test.dart';

import '../bin/emit_leaf_vote.dart' as emit;

void main() {
  test('emit a leaf vote', () async {
    await emit.main();
  }, timeout: const Timeout(Duration(minutes: 3)));
}
