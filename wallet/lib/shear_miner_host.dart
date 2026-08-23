import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';

/// Desktop: spawn bundled shear-miner. Phones: Dart hasher.
class ShearMinerHost {
  Process? _proc;

  static String bundledPath([String? resolvedExecutable]) {
    if (Platform.isMacOS) {
      final exe = resolvedExecutable ?? Platform.resolvedExecutable;
      final dir = File(exe).parent.path;
      return '$dir/shear-miner';
    }
    if (Platform.isWindows) {
      return 'shear-miner.exe';
    }
    return 'shear-miner';
  }

  bool get isDesktop =>
      !kIsWeb && (Platform.isMacOS || Platform.isWindows || Platform.isLinux);

  Future<Process?> start({
    required String address,
    required String pool,
    int threads = 1,
  }) async {
    if (!isDesktop) return null;
    final bin = bundledPath();
    if (!File(bin).existsSync()) return null;
    _proc = await Process.start(bin, [
      '--pool',
      pool,
      '--user',
      '$address.wallet',
      '--threads',
      '$threads',
      '--notls',
    ]);
    return _proc;
  }

  void stop() {
    _proc?.kill();
    _proc = null;
  }
}

/// In-app ShearHash-style round for phones (not the C miner).
List<int> dartHashRound(List<int> header) {
  var out = sha256.convert(header).bytes;
  for (var r = 0; r < 8; r++) {
    out = sha256.convert([...out, ...header, r]).bytes;
  }
  return out;
}
