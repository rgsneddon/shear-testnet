import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

/// libsodium ristretto255 (prove hot path). Falls back to Dart if missing.
final class ShearSodium {
  ShearSodium._(this._lib)
      : _init = _lib.lookupFunction<Int32 Function(), int Function()>('sodium_init'),
        _scmul = _lib.lookupFunction<
            Int32 Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>),
            int Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>)>('crypto_scalarmult_ristretto255'),
        _scbase = _lib.lookupFunction<
            Int32 Function(Pointer<Uint8>, Pointer<Uint8>),
            int Function(Pointer<Uint8>, Pointer<Uint8>)>('crypto_scalarmult_ristretto255_base'),
        _add = _lib.lookupFunction<
            Int32 Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>),
            int Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>)>('crypto_core_ristretto255_add'),
        _sub = _lib.lookupFunction<
            Int32 Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>),
            int Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>)>('crypto_core_ristretto255_sub'),
        _fromHash = _lib.lookupFunction<
            Int32 Function(Pointer<Uint8>, Pointer<Uint8>),
            int Function(Pointer<Uint8>, Pointer<Uint8>)>('crypto_core_ristretto255_from_hash');

  final DynamicLibrary _lib;
  final int Function() _init;
  final int Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>) _scmul;
  final int Function(Pointer<Uint8>, Pointer<Uint8>) _scbase;
  final int Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>) _add;
  final int Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>) _sub;
  final int Function(Pointer<Uint8>, Pointer<Uint8>) _fromHash;

  static ShearSodium? tryLoad() {
    for (final name in _libNames()) {
      try {
        final lib = DynamicLibrary.open(name);
        final s = ShearSodium._(lib);
        s._init();
        return s;
      } catch (_) {
        continue;
      }
    }
    return null;
  }

  static List<String> _libNames() {
    final out = <String>[];
    try {
      final exe = File(Platform.resolvedExecutable).parent.path;
      if (Platform.isMacOS) {
        out.addAll([
          '$exe/../Frameworks/libsodium.26.dylib',
          '$exe/../Frameworks/libsodium.dylib',
          '$exe/libsodium.26.dylib',
          '$exe/libsodium.dylib',
        ]);
      } else if (Platform.isLinux) {
        out.addAll([
          '$exe/lib/libsodium.so.26',
          '$exe/lib/libsodium.so.23',
          '$exe/libsodium.so.26',
          '$exe/libsodium.so.23',
          '$exe/libsodium.so',
        ]);
      }
    } catch (_) {}
    if (Platform.isMacOS) {
      out.addAll([
        'libsodium.26.dylib',
        'libsodium.dylib',
        '/opt/homebrew/lib/libsodium.dylib',
        '/usr/local/lib/libsodium.dylib',
      ]);
    } else if (Platform.isLinux) {
      out.addAll([
        'libsodium.so.26',
        'libsodium.so.23',
        'libsodium.so',
        '/usr/lib/x86_64-linux-gnu/libsodium.so.23',
        '/usr/lib/x86_64-linux-gnu/libsodium.so.26',
        '/usr/local/lib/libsodium.so',
      ]);
    }
    return out;
  }

  Uint8List scalarmult(Uint8List n, Uint8List p) {
    if (n.length != 32 || p.length != 32) throw ArgumentError('ristretto');
    if (_isZero(n) || _isZero(p)) return Uint8List(32);
    return _call32((q, nn, pp) {
      _load(nn, n);
      _load(pp, p);
      _scmul(q, nn, pp);
    });
  }

  Uint8List scalarmultBase(Uint8List n) {
    if (n.length != 32) throw ArgumentError('scalar');
    if (_isZero(n)) return Uint8List(32);
    return _call32((q, nn, _) {
      _load(nn, n);
      _scbase(q, nn);
    });
  }

  Uint8List add(Uint8List a, Uint8List b) {
    if (a.length != 32 || b.length != 32) throw ArgumentError('ristretto');
    if (_isZero(a)) return Uint8List.fromList(b);
    if (_isZero(b)) return Uint8List.fromList(a);
    return _call32((r, p, q) {
      _load(p, a);
      _load(q, b);
      final rc = _add(r, p, q);
      if (rc != 0) throw StateError('ristretto_add');
    });
  }

  Uint8List sub(Uint8List a, Uint8List b) {
    if (a.length != 32 || b.length != 32) throw ArgumentError('ristretto');
    if (_isZero(b)) return Uint8List.fromList(a);
    return _call32((r, p, q) {
      _load(p, a);
      _load(q, b);
      final rc = _sub(r, p, q);
      if (rc != 0) throw StateError('ristretto_sub');
    });
  }

  Uint8List fromHash(Uint8List h64) {
    if (h64.length != 64) throw ArgumentError('hash64');
    final p = malloc<Uint8>(32);
    final h = malloc<Uint8>(64);
    try {
      for (var i = 0; i < 64; i++) {
        h[i] = h64[i];
      }
      final rc = _fromHash(p, h);
      if (rc != 0) throw StateError('ristretto_from_hash');
      return Uint8List.fromList(p.asTypedList(32));
    } finally {
      malloc.free(p);
      malloc.free(h);
    }
  }

  Uint8List _call32(void Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>) fn) {
    final a = malloc<Uint8>(32);
    final b = malloc<Uint8>(32);
    final c = malloc<Uint8>(32);
    try {
      fn(a, b, c);
      return Uint8List.fromList(a.asTypedList(32));
    } finally {
      malloc.free(a);
      malloc.free(b);
      malloc.free(c);
    }
  }

  static void _load(Pointer<Uint8> p, Uint8List b) {
    for (var i = 0; i < 32; i++) {
      p[i] = b[i];
    }
  }

  static bool _isZero(Uint8List b) {
    var acc = 0;
    for (final x in b) {
      acc |= x;
    }
    return acc == 0;
  }
}
