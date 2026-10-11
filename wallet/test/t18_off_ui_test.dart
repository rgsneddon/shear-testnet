import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Spawns the production hop check with FLUTTER_TEST unset.
/// The stamps are printed by test/t18_off_ui_check.dart.

void main() {
  test('selection, prove, and sign run off the caller isolate', () async {
    final dart = _dartBin();
    final wallet = _walletDir();
    final env = Map<String, String>.from(Platform.environment)
      ..remove('FLUTTER_TEST')
      ..['SHEAR_FLOW_OFF_UI'] = '1';
    final result = await Process.run(
      dart,
      ['run', 'test/t18_off_ui_check.dart'],
      workingDirectory: wallet.path,
      environment: env,
    );
    expect(
      result.exitCode,
      0,
      reason: 'stdout:\n${result.stdout}\nstderr:\n${result.stderr}',
    );
    expect(result.stdout.toString(), contains('T18_OFF_UI pass'));
  }, timeout: const Timeout(Duration(minutes: 3)));
}

String _dartBin() {
  final root = Platform.environment['FLUTTER_ROOT'];
  if (root != null && root.isNotEmpty) {
    final exe = File(
      '$root${Platform.pathSeparator}bin${Platform.pathSeparator}cache${Platform.pathSeparator}'
      'dart-sdk${Platform.pathSeparator}bin${Platform.pathSeparator}dart.exe',
    );
    if (exe.existsSync()) return exe.path;
    final unix = File(
      '$root${Platform.pathSeparator}bin${Platform.pathSeparator}cache${Platform.pathSeparator}'
      'dart-sdk${Platform.pathSeparator}bin${Platform.pathSeparator}dart',
    );
    if (unix.existsSync()) return unix.path;
  }
  final resolved = Platform.resolvedExecutable;
  final lower = resolved.toLowerCase();
  if (lower.endsWith('dart.exe') || lower.endsWith('${Platform.pathSeparator}dart')) {
    return resolved;
  }
  const fallback = r'C:\Users\rgsne\flutter\bin\cache\dart-sdk\bin\dart.exe';
  if (File(fallback).existsSync()) return fallback;
  throw StateError('dart sdk not found from $resolved');
}

Directory _walletDir() {
  var dir = Directory.current;
  for (var i = 0; i < 6; i++) {
    final pub = File('${dir.path}${Platform.pathSeparator}pubspec.yaml');
    if (pub.existsSync()) {
      final text = pub.readAsStringSync();
      if (text.contains('name: shear_wallet')) return dir;
    }
    final parent = dir.parent;
    if (parent.path == dir.path) break;
    dir = parent;
  }
  final script = File(Platform.script.toFilePath());
  return script.parent.parent;
}
