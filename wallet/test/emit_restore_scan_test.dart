import 'package:flutter_test/flutter_test.dart';

import '../bin/emit_restore_scan.dart' as emit;

void main() {
  test('restore a shewall and rescan mined outputs', () async {
    await emit.main();
  }, timeout: const Timeout(Duration(minutes: 6)));
}
