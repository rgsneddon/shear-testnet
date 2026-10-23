import 'package:flutter_test/flutter_test.dart';

import '../bin/emit_shewall_backup.dart' as emit;

void main() {
  test('emit a shewall backup', () async {
    await emit.main();
  });
}
