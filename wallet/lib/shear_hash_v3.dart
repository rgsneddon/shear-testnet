import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:ffi/ffi.dart';
import 'package:flutter/foundation.dart';

import 'shear_hash.dart';
import 'shear_hash_pin.dart';

/// ShearHash-v3 selftest. Header byte 0 = 0x01, the rest zero.
/// A v1 digest (`5d00a242…`) must not be accepted as this.
const shearHashV3Selftest =
    '98818c31d739ef821db0242f76bd244b96f1fb5049d27ea9a192e95c67b39a8b';

/// RandomX light cache plus scratchpad. Below this, skip the hash.
const shearHashMemoryFloorBytes = (128 + 2 + 32) * 1024 * 1024;

typedef _WalletHashNative = Int32 Function(Pointer<Uint8> header, Pointer<Uint8> out);
typedef _WalletHashDart = int Function(Pointer<Uint8> header, Pointer<Uint8> out);

_WalletHashDart? _hash;
bool _opened = false;
bool _selftestOk = false;

/// ShearHash-v3 evaluations since process start, including the selftest.
int shearHashV3CallCount = 0;

/// True after the bundled interpreter loads, the pin matches, and the
/// selftest matches [shearHashV3Selftest].
bool get shearHashV3Ready {
  _ensure();
  return _selftestOk;
}

/// Recompute ShearHash-v3 for one 128-byte header.
/// Null when the binding is missing, the pin misses, memory is short, the
/// selftest misses, or the cache cannot be built. Never the server-claimed
/// hash, and never ShearHash-v1.
Uint8List? shearHashV3(Uint8List header) {
  if (header.length != shearHeaderLen) return null;
  if (!shearHashMemoryOk()) return null;
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
  if (!shearHashMemoryOk()) return Future<Uint8List?>.value(null);
  if (Platform.environment['FLUTTER_TEST'] == 'true') {
    return Future<Uint8List?>.value(shearHashV3(header));
  }
  final copy = Uint8List.fromList(header);
  return Isolate.run(() => shearHashV3(copy));
}

/// Linux and Android expose MemAvailable. Unknown or short memory fails closed.
/// Windows has no MemAvailable file; a failed native alloc still returns null.
bool shearHashMemoryOk() => shearHashMemoryOkFromMeminfo(_meminfoText());

@visibleForTesting
bool shearHashMemoryOkFromMeminfo(String? text) {
  if (text == null) {
    return !Platform.isLinux && !Platform.isAndroid;
  }
  final m = RegExp(r'MemAvailable:\s+(\d+)\s+kB').firstMatch(text);
  if (m == null) return false;
  final bytes = int.parse(m.group(1)!) * 1024;
  return bytes >= shearHashMemoryFloorBytes;
}

String? _meminfoText() {
  if (!Platform.isLinux && !Platform.isAndroid) return null;
  try {
    final file = File('/proc/meminfo');
    if (!file.existsSync()) return '';
    return file.readAsStringSync();
  } catch (_) {
    return '';
  }
}

void _ensure() {
  if (_opened) return;
  _opened = true;
  if (Platform.isAndroid) {
    _openAndroid();
    return;
  }
  final path = bundledShearHashLibrary(
    operatingSystem: Platform.operatingSystem,
    exeDir: _exeDir(),
  );
  final failure = shearHashBundledFailure(path);
  if (failure != null) return;
  _openPath(path);
}

/// Read the extracted library next to an already-loaded Flutter library and
/// check its SHA-256 before [DynamicLibrary.open]. The soname is not opened.
void _openAndroid() {
  final path = androidShearHashLibraryFromMaps(_mapsText());
  if (path == null) return;
  final failure = shearHashBundledFailure(path);
  if (failure != null) return;
  _openPath(path);
}

String _mapsText() {
  try {
    return File('/proc/self/maps').readAsStringSync();
  } catch (_) {
    return '';
  }
}

void _openPath(String path) {
  try {
    final lib = DynamicLibrary.open(path);
    final fn = lib.lookupFunction<_WalletHashNative, _WalletHashDart>('shear_wallet_hash');
    final got = _call(fn, shearSelftestHeader());
    if (got == null) return;
    final hex = _hex(got);
    if (hex != shearHashV3Selftest) return;
    _hash = fn;
    _selftestOk = true;
  } catch (_) {}
}

/// Null when [path] exists and its SHA-256 is the dart-define pin.
/// Tests may use the sidecar written next to the staged library.
@visibleForTesting
String? shearHashBundledFailure(String path) {
  final file = File(path);
  if (!file.existsSync()) return 'missing bundled library';
  final pin = shearHashExpectedPin(path);
  return shearHashPinFailure(file.readAsBytesSync(), pin);
}

/// Desktop pin is [kShearHashSha256]. Tests fall back to `<library>.sha256`.
@visibleForTesting
String shearHashExpectedPin(String libraryPath) {
  final define = kShearHashSha256.trim().toLowerCase();
  if (define.isNotEmpty) return define;
  if (Platform.environment['FLUTTER_TEST'] == 'true') {
    final side = File('$libraryPath.sha256');
    if (!side.existsSync()) return '';
    final line = side.readAsStringSync().trim().toLowerCase();
    if (line.isEmpty) return '';
    return line.split(RegExp(r'\s+')).first;
  }
  return '';
}

/// Null when [expectedHex] matches [bytes]. A reason otherwise.
@visibleForTesting
String? shearHashPinFailure(List<int> bytes, String expectedHex) {
  final want = expectedHex.trim().toLowerCase();
  if (want.isEmpty) return 'missing sha256 pin';
  final got = sha256.convert(bytes).toString();
  if (got != want) return 'sha256 mismatch';
  return null;
}

/// One absolute bundled path. [envPath] and [cwd] are ignored.
@visibleForTesting
List<String> shearHashLibraryCandidates({
  required String operatingSystem,
  required String exeDir,
  String? envPath,
  String? cwd,
}) {
  envPath;
  cwd;
  return <String>[
    bundledShearHashLibrary(operatingSystem: operatingSystem, exeDir: exeDir),
  ];
}

/// Directory of an already-mapped `libflutter.so` or `libapp.so`, plus
/// `libshearhash.so`. Null when the maps text has neither library.
@visibleForTesting
String? androidShearHashLibraryFromMaps(String maps) {
  final marked = RegExp(r'(\S*/(?:libflutter|libapp)\.so)');
  for (final line in maps.split('\n')) {
    final match = marked.firstMatch(line);
    if (match == null) continue;
    final loaded = match.group(1)!;
    final slash = loaded.lastIndexOf('/');
    if (slash < 0) continue;
    return '${loaded.substring(0, slash)}/libshearhash.so';
  }
  return null;
}

/// Linux `<exe>/lib/libshearhash.so`, Windows `<exe>\libshearhash.dll`,
/// macOS `<exe>/../Frameworks/libshearhash.dylib`, Android the extracted
/// library beside `libflutter.so`. The SHA-256 pin is checked before open.
@visibleForTesting
String bundledShearHashLibrary({
  required String operatingSystem,
  required String exeDir,
}) {
  if (operatingSystem == 'android') return 'libshearhash.so';
  if (operatingSystem == 'windows') {
    final sep = exeDir.contains('\\') ? '\\' : '/';
    return '$exeDir${sep}libshearhash.dll';
  }
  if (operatingSystem == 'macos') {
    final parent = exeDir.endsWith('/') ? exeDir.substring(0, exeDir.length - 1) : exeDir;
    final macOs = parent.lastIndexOf('/');
    final contents = macOs > 0 ? parent.substring(0, macOs) : '$parent/..';
    return '$contents/Frameworks/libshearhash.dylib';
  }
  return '$exeDir/lib/libshearhash.so';
}

/// Copy a built library onto the bundled path and write its pin sidecar.
/// The loader does not search [sourcePath].
@visibleForTesting
String stageBundledShearHashForTest(String sourcePath) {
  if (Platform.environment['FLUTTER_TEST'] != 'true') {
    throw StateError('stageBundledShearHashForTest is test-only');
  }
  final src = File(sourcePath);
  final destPath = bundledShearHashLibrary(
    operatingSystem: Platform.operatingSystem,
    exeDir: _exeDir(),
  );
  final dest = File(destPath);
  dest.parent.createSync(recursive: true);
  final srcBytes = src.readAsBytesSync();
  final pin = sha256.convert(srcBytes).toString();
  final side = File('$destPath.sha256');
  final already = dest.existsSync() &&
      side.existsSync() &&
      side.readAsStringSync().trim().split(RegExp(r'\s+')).first == pin &&
      sha256.convert(dest.readAsBytesSync()).toString() == pin;
  // Truncating a mapped library makes the next call jump into unmapped pages.
  if (!already) {
    if (_opened) {
      throw StateError('refusing to replace a loaded shearhash library');
    }
    dest.writeAsBytesSync(srcBytes);
  }
  side.writeAsStringSync('$pin\n');
  return destPath;
}

String _exeDir() => File(Platform.resolvedExecutable).parent.path;

Uint8List? _call(_WalletHashDart fn, Uint8List header) {
  shearHashV3CallCount += 1;
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

String _hex(Uint8List bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
