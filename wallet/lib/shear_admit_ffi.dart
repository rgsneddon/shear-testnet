import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

/// In-process BP+ range proofs. Same C ABI as `libshear_admit`
/// (`shear_range_prove` / `shear_range_verify`). Send prove stays fail-closed
/// until FS-1. The opening `r` is copied and zeroized. Nothing is written to disk.
class AdmitNative {
  AdmitNative._(DynamicLibrary lib)
      : _range = lib.lookupFunction<_RangeC, _RangeDart>('shear_range_prove'),
        _verify = lib.lookupFunction<_VerifyC, _VerifyDart>('shear_range_verify');

  final _RangeDart _range;
  final _VerifyDart _verify;

  static const int rangeCap = 65536;

  static AdmitNative? _cached;
  static bool _tried = false;

  static AdmitNative? tryLoad() {
    if (_tried) return _cached;
    _tried = true;
    final lib = _open();
    if (lib == null) return null;
    try {
      _cached = AdmitNative._(lib);
      return _cached;
    } catch (_) {
      return null;
    }
  }

  /// `v` is a u64. The caller's [r] is left intact. The native copy is wiped.
  Uint8List? proveRange(BigInt v, Uint8List r) {
    if (v < BigInt.zero || v.bitLength > 64 || r.length != 32) return null;
    final rr = calloc<Uint8>(32);
    final out = calloc<Uint8>(rangeCap);
    final olen = calloc<Uint32>();
    try {
      for (var i = 0; i < 32; i++) {
        rr[i] = r[i];
      }
      final rc = _range(v.toInt(), rr, out, olen);
      final n = olen.value;
      if (rc != 1 || n <= 0 || n > rangeCap) return null;
      final blob = Uint8List.fromList(out.asTypedList(n));
      if (blob.isEmpty || blob[0] != 2) return null;
      return blob;
    } finally {
      _wipeFree(rr, 32);
      calloc.free(out);
      calloc.free(olen);
    }
  }

  bool verifyRange(Uint8List commit, Uint8List proof) {
    if (commit.length != 32 || proof.isEmpty) return false;
    final c = calloc<Uint8>(32);
    final p = calloc<Uint8>(proof.length);
    try {
      for (var i = 0; i < 32; i++) {
        c[i] = commit[i];
      }
      for (var i = 0; i < proof.length; i++) {
        p[i] = proof[i];
      }
      return _verify(c, p, proof.length) == 1;
    } finally {
      calloc.free(c);
      calloc.free(p);
    }
  }

  static DynamicLibrary? _open() {
    if (Platform.isIOS) {
      for (final opener in <DynamicLibrary Function()>[
        DynamicLibrary.process,
        DynamicLibrary.executable,
      ]) {
        try {
          final lib = opener();
          lib.lookup<NativeFunction<_RangeC>>('shear_range_prove');
          return lib;
        } catch (_) {}
      }
      return null;
    }
    if (Platform.isAndroid) {
      try {
        return DynamicLibrary.open('libshear_admit.so');
      } catch (_) {}
    }
    final names = <String>[];
    final env = Platform.environment['SHEAR_ADMIT_LIB'];
    if (env != null && env.isNotEmpty) names.add(env);
    try {
      final exe = File(Platform.resolvedExecutable).parent.path;
      if (Platform.isMacOS) {
        names.addAll([
          '$exe/../Frameworks/libshear_admit.dylib',
          '$exe/libshear_admit.dylib',
        ]);
      } else if (Platform.isWindows) {
        names.addAll([
          '$exe${Platform.pathSeparator}shear_admit.dll',
          '$exe${Platform.pathSeparator}libshear_admit.dll',
        ]);
      } else if (Platform.isLinux) {
        names.addAll([
          '$exe/lib/libshear_admit.so',
          '$exe/libshear_admit.so',
        ]);
      }
    } catch (_) {}
    final cwd = Directory.current.path;
    const rel = <String>[
      'crypto/native/admit/target/release',
      '../crypto/native/admit/target/release',
    ];
    for (final dir in rel) {
      final base = '$cwd/$dir';
      names.addAll([
        '$base/libshear_admit.so',
        '$base/libshear_admit.dylib',
        '$base/shear_admit.dll',
      ]);
    }
    if (Platform.isLinux) {
      names.add('libshear_admit.so');
    } else if (Platform.isMacOS) {
      names.add('libshear_admit.dylib');
    } else if (Platform.isWindows) {
      names.add('shear_admit.dll');
    }
    for (final name in names) {
      try {
        return DynamicLibrary.open(name);
      } catch (_) {}
    }
    return null;
  }
}

void zeroize(Uint8List? bytes) {
  if (bytes == null) return;
  for (var i = 0; i < bytes.length; i++) {
    bytes[i] = 0;
  }
}

void _wipeFree(Pointer<Uint8> p, int n) {
  for (var i = 0; i < n; i++) {
    p[i] = 0;
  }
  calloc.free(p);
}

typedef _RangeC = Int32 Function(Uint64, Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint32>);
typedef _RangeDart = int Function(int, Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint32>);
typedef _VerifyC = Int32 Function(Pointer<Uint8>, Pointer<Uint8>, Uint32);
typedef _VerifyDart = int Function(Pointer<Uint8>, Pointer<Uint8>, int);
