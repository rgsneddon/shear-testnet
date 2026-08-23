import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;

import 'shear_hash.dart';

export 'shear_hash.dart';

/// Desktop: spawn bundled shear-miner next to the GUI. Phones: Dart ShearHash.
class ShearMinerHost {
  ShearMinerHost({
    this.resolvedExecutable,
    bool? desktopOverride,
  }) : _desktopOverride = desktopOverride;

  final String? resolvedExecutable;
  final bool? _desktopOverride;
  Process? _proc;
  Timer? _timer;
  bool hashing = false;
  int hashesRun = 0;
  void Function(int hashes)? onHashes;

  bool get isDesktop =>
      _desktopOverride ??
      (!kIsWeb && (Platform.isMacOS || Platform.isWindows || Platform.isLinux));

  static String bundledPath({String? resolvedExecutable, bool? windows}) {
    final exe = resolvedExecutable ?? Platform.resolvedExecutable;
    final win = windows ?? Platform.isWindows;
    final ctx = win ? p.windows : p.posix;
    final dir = ctx.dirname(exe);
    final name = win ? 'shear-miner.exe' : 'shear-miner';
    return ctx.join(dir, name);
  }

  Future<Process?> start({
    required String address,
    required String pool,
    int threads = 1,
  }) async {
    if (!isDesktop) return null;
    final bin = bundledPath(
      resolvedExecutable: resolvedExecutable,
      windows: Platform.isWindows,
    );
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
    hashing = true;
    return _proc;
  }

  /// In-app ShearHash loop (phones). Each burst hashes real 120-byte headers.
  void startInApp({void Function(int hashes)? onHashes, Duration? period}) {
    this.onHashes = onHashes;
    hashing = true;
    hashesRun = 0;
    _timer?.cancel();
    final first = hashBurst();
    if (first > 0) this.onHashes?.call(first);
    _timer = Timer.periodic(period ?? const Duration(milliseconds: 50), (_) {
      if (!hashing) return;
      final n = hashBurst();
      if (n > 0) this.onHashes?.call(n);
    });
  }

  /// Hash a batch of headers with incrementing nonce. Returns hashes computed.
  int hashBurst({int count = 32, Uint8List? header}) {
    final buf = Uint8List.fromList(header ?? shearSelftestHeader());
    var n = 0;
    for (var i = 0; i < count; i++) {
      shearSetNonce(buf, hashesRun + i);
      shearHash(buf);
      n++;
    }
    hashesRun += n;
    return n;
  }

  void stop() {
    hashing = false;
    _timer?.cancel();
    _timer = null;
    _proc?.kill();
    _proc = null;
  }
}

/// In-app hasher — identical to C `shear_hash`.
List<int> dartHashRound(List<int> header) => shearHash(header);
