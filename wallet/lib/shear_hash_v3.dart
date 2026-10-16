import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import 'shear_hash.dart';

/// ShearHash-v3 selftest. Header byte 0 = 0x01, the rest zero.
/// A v1 digest (`5d00a242…`) must not be accepted as this.
const shearHashV3Selftest =
    '98818c31d739ef821db0242f76bd244b96f1fb5049d27ea9a192e95c67b39a8b';

typedef _WalletHashNative = Int32 Function(Pointer<Uint8> header, Pointer<Uint8> out);
typedef _WalletHashDart = int Function(Pointer<Uint8> header, Pointer<Uint8> out);

_WalletHashDart? _hash;
bool _opened = false;
bool _selftestOk = false;

/// True after the native interpreter loads and matches [shearHashV3Selftest].
bool get shearHashV3Ready {
  _ensure();
  return _selftestOk;
}

/// Recompute ShearHash-v3 for one 128-byte header.
/// Null when the binding is missing, the selftest misses, or the cache
/// cannot be built. Never the server-claimed hash, and never ShearHash-v1.
Uint8List? shearHashV3(Uint8List header) {
  if (header.length != shearHeaderLen) return null;
  _ensure();
  final fn = _hash;
  if (fn == null || !_selftestOk) return null;
  return _call(fn, header);
}

/// Same recompute off the UI isolate.
/// flutter_tester deadlocks inside [Isolate.run], so tests hash on the caller.
/// Production leaves `FLUTTER_TEST` unset.
Future<Uint8List?> shearHashV3OffUi(Uint8List header) {
  if (header.length != shearHeaderLen) return Future<Uint8List?>.value(null);
  if (Platform.environment['FLUTTER_TEST'] == 'true') {
    return Future<Uint8List?>.value(shearHashV3(header));
  }
  final copy = Uint8List.fromList(header);
  return Isolate.run(() => shearHashV3(copy));
}

void _ensure() {
  if (_opened) return;
  _opened = true;
  for (final path in _libCandidates()) {
    try {
      final lib = DynamicLibrary.open(path);
      final fn = lib.lookupFunction<_WalletHashNative, _WalletHashDart>('shear_wallet_hash');
      final got = _call(fn, shearSelftestHeader());
      if (got == null) continue;
      final hex = got.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
      if (hex != shearHashV3Selftest) continue;
      _hash = fn;
      _selftestOk = true;
      return;
    } catch (_) {}
  }
}

Uint8List? _call(_WalletHashDart fn, Uint8List header) {
  final hin = malloc<Uint8>(shearHeaderLen);
  final out = malloc<Uint8>(32);
  try {
    hin.asTypedList(shearHeaderLen).setAll(0, header);
    if (fn(hin, out) != 0) return null;
    final bytes = Uint8List.fromList(out.asTypedList(32));
    for (final b in bytes) {
      if (b != 0) return bytes;
    }
    return null;
  } finally {
    malloc.free(hin);
    malloc.free(out);
  }
}

List<String> _libCandidates() {
  final out = <String>[];
  final env = Platform.environment['SHEAR_HASH_LIB'];
  if (env != null && env.isNotEmpty) out.add(env);
  final cwd = Directory.current.path;
  out.addAll([
    '$cwd/crypto/native/libshearhash.so',
    '$cwd/../crypto/native/libshearhash.so',
    '$cwd/../../crypto/native/libshearhash.so',
  ]);
  try {
    final exe = File(Platform.resolvedExecutable).parent.path;
    out.add('$exe/lib/libshearhash.so');
    out.add('$exe/libshearhash.so');
  } catch (_) {}
  if (Platform.isLinux) out.add('libshearhash.so');
  return out;
}
