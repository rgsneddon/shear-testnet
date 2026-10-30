import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The walk-frames measurement build (integration_test/walk_frames_main.dart)
/// is never part of the wallet. The release build's entry is lib/main.dart;
/// nothing under lib/ imports integration_test/, the generated chain data
/// is gitignored, and no lib/ code calls the measurement entry.
void main() {
  test('nothing under lib/ reaches the walk-frames build', () {
    final lib = Directory('lib');
    for (final f in lib.listSync(recursive: true).whereType<File>()) {
      if (!f.path.endsWith('.dart')) continue;
      final src = f.readAsStringSync();
      expect(src.contains('integration_test/'), isFalse, reason: f.path);
      expect(src.contains('walk_frames_main'), isFalse, reason: f.path);
      expect(src.contains('walk_chain_data'), isFalse, reason: f.path);
      // Only its definition: no production code calls the measurement entry.
      final calls = RegExp(r'walkBelowCheckpointWorker\(').allMatches(src).length;
      final defs = RegExp(r'Future<Map<String, dynamic>> walkBelowCheckpointWorker\(').allMatches(src).length;
      expect(calls - defs, 0, reason: f.path);
    }
  });

  test('the release entry is lib/main.dart, and the chain data is not committed', () {
    final main = File('lib/main.dart').readAsStringSync();
    expect(main.contains('void main()') || main.contains('Future<void> main('), isTrue);
    final ignore = File('.gitignore').readAsStringSync();
    expect(ignore.contains('integration_test/walk_chain_data.dart'), isTrue);
    final gradle = File('android/app/build.gradle.kts').readAsStringSync();
    expect(gradle.contains('walk_frames'), isFalse, reason: 'no build variant points at it');
  });
}
