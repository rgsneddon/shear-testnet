import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_node_proc.dart';

void main() {
  test('a spawned node does not inherit bootstrap or seed overrides', () async {
    expect(Platform.environment['PATH'], isNotEmpty);
    final lines = <String>[];
    final handle = await startNodeProcessOffUi(
      binary: '/usr/bin/python3',
      args: [
        '-c',
        'import os, time\n'
            'time.sleep(0.2)\n'
            'print("BOOT=" + os.environ.get("SHEAR_BOOTSTRAP", ""))\n'
            'print("URL=" + os.environ.get("SHEAR_BOOTSTRAP_URL", ""))\n'
            'print("SEEDS=" + os.environ.get("SHEAR_SEEDS", ""))\n'
            'print("PATH=" + os.environ.get("PATH", ""))\n'
            'print("ONLY=" + os.environ.get("ONLY", ""))\n',
      ],
      environment: const {'ONLY': 'yes'},
    );
    handle.listen(lines.add);
    final deadline = DateTime.now().add(const Duration(seconds: 10));
    while (DateTime.now().isBefore(deadline) && !lines.any((line) => line.startsWith('ONLY='))) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    await handle.kill();
    expect(lines, contains('BOOT='));
    expect(lines, contains('URL='));
    expect(lines, contains('SEEDS='));
    expect(lines, contains('PATH='));
    expect(lines, contains('ONLY=yes'));
    final src = File('lib/shear_node_proc.dart').readAsStringSync();
    expect(src, contains('includeParentEnvironment: false'));
  });
}
