import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:ffi/ffi.dart';
import 'package:flutter/foundation.dart';

import 'shear_admit_pin.dart';
import 'shear_range_isolate.dart';

export 'shear_range_isolate.dart' show debugFlowCryptoOnCaller, rangeOnUiIsolate, requireRangeOffUi;

/// In-process BP+ range proofs. Same C ABI as `libshear_admit`
/// (`shear_range_prove` / `shear_range_verify`). Send prove stays fail-closed
/// until FS-1. The opening is staged in a calloc buffer and wiped before free.
class AdmitNative {
  AdmitNative._(DynamicLibrary lib)
      : _range = lib.lookupFunction<_RangeC, _RangeDart>('shear_range_prove'),
        _verify = lib.lookupFunction<_VerifyC, _VerifyDart>('shear_range_verify');

  /// Test stand-in. [debugRange] supplies the native call.
  @visibleForTesting
  AdmitNative.debug()
      : _range = ((_, __, ___, ____, _____) => 0),
        _verify = ((_, __, ___) => 0);

  final _RangeDart _range;
  final _VerifyDart _verify;

  static const int rangeCap = 65536;

  static AdmitNative? _cached;
  static bool _tried = false;

  /// Observes the secret calloc buffer after it has been wiped and before free.
  @visibleForTesting
  static void Function(Pointer<Uint8> p, int n)? debugSecretBeforeFree;

  /// When set, [proveRange] calls this instead of the loaded library.
  @visibleForTesting
  static int Function(int v, Pointer<Uint8> r, Pointer<Uint8> out, Pointer<Uint32> olen, int cap)? debugRange;

  static AdmitNative? tryLoad() {
    if (_tried) return _cached;
    try {
      final lib = _open();
      _cached = AdmitNative._(lib);
      _tried = true;
      return _cached;
    } catch (e) {
      stderr.writeln('admit_lib_load: $e');
      if (!kDebugMode && !_mobile) {
        throw StateError('admit_lib_load: $e');
      }
      _tried = true;
      return null;
    }
  }

  /// `v` is a u64. The caller's [r] is left intact. The native copy is wiped.
  Uint8List? proveRange(BigInt v, Uint8List r) {
    requireRangeOffUi();
    if (v < BigInt.zero || v.bitLength > 64 || r.length != 32) return null;
    final rr = calloc<Uint8>(32);
    final out = calloc<Uint8>(rangeCap);
    final olen = calloc<Uint32>();
    try {
      for (var i = 0; i < 32; i++) {
        rr[i] = r[i];
      }
      final rc = debugRange != null
          ? debugRange!(v.toInt(), rr, out, olen, rangeCap)
          : _range(v.toInt(), rr, out, rangeCap, olen);
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
    requireRangeOffUi();
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

  static bool get _mobile => Platform.isIOS || Platform.isAndroid;

  static DynamicLibrary _open() {
    if (Platform.isIOS) {
      Object? last;
      for (final opener in <DynamicLibrary Function()>[
        DynamicLibrary.process,
        DynamicLibrary.executable,
      ]) {
        try {
          final lib = opener();
          lib.lookup<NativeFunction<_RangeC>>('shear_range_prove');
          return lib;
        } catch (e) {
          last = e;
        }
      }
      throw StateError('admit_lib_load: iOS process image has no shear_range_prove ($last)');
    }
    if (Platform.isAndroid) {
      try {
        return DynamicLibrary.open('libshear_admit.so');
      } catch (e) {
        throw StateError('admit_lib_load: libshear_admit.so: $e');
      }
    }
    // Profile and release. Debug (kDebugMode) is the only unpinned path.
    if (!kDebugMode) {
      return _openPinned();
    }
    Object? last;
    for (final name in admitLibraryCandidates(
      pinned: false,
      exeDir: _exeDir(),
      envPath: Platform.environment['SHEAR_ADMIT_LIB'],
      cwd: Directory.current.path,
      operatingSystem: _osName(),
    )) {
      try {
        return DynamicLibrary.open(name);
      } catch (e) {
        last = e;
      }
    }
    throw StateError('admit_lib_load: no debug library ($last)');
  }

  static DynamicLibrary _openPinned() {
    final path = bundledAdmitLibrary(operatingSystem: _osName(), exeDir: _exeDir());
    final file = File(path);
    if (!file.existsSync()) {
      throw StateError('admit_lib_load: $path: missing bundled library');
    }
    final bytes = file.readAsBytesSync();
    final failure = admitBundledLoadFailure(
      bytes: bytes,
      operatingSystem: _osName(),
      pinHex: _osName() == 'macos' ? _sidecarHex(path) : kShearAdmitSha256,
      codesignText: _osName() == 'macos' ? _codesignText(path) : '',
      signId: kShearAdmitSignId,
    );
    if (failure != null) throw StateError('admit_lib_load: $path: $failure');
    try {
      return DynamicLibrary.open(path);
    } catch (e) {
      throw StateError('admit_lib_load: $path: $e');
    }
  }
}

String _sidecarHex(String libraryPath) {
  final side = File('$libraryPath.sha256');
  if (!side.existsSync()) return '';
  return side.readAsStringSync();
}

String _codesignText(String libraryPath) {
  if (!Platform.isMacOS) return '';
  final r = Process.runSync('codesign', ['-dv', '--verbose=4', libraryPath]);
  return '${r.stdout}\n${r.stderr}';
}

/// True for profile and release. Debug keeps the env and cwd candidates.
@visibleForTesting
bool admitPinnedLoad({required bool debugMode}) => !debugMode;

/// Profile and release load one absolute bundled path. Debug may also use
/// the env var and cwd.
@visibleForTesting
List<String> admitLibraryCandidates({
  required bool pinned,
  required String exeDir,
  String? envPath,
  String? cwd,
  required String operatingSystem,
}) {
  final bundled = bundledAdmitLibrary(operatingSystem: operatingSystem, exeDir: exeDir);
  if (pinned) return <String>[bundled];
  final names = <String>[];
  if (envPath != null && envPath.isNotEmpty) names.add(envPath);
  names.add(bundled);
  if (cwd != null && cwd.isNotEmpty) {
    for (final dir in <String>[
      '$cwd/crypto/native/admit/target/release',
      '$cwd/../crypto/native/admit/target/release',
    ]) {
      if (operatingSystem == 'windows') {
        names.add('$dir\\shear_admit.dll');
      } else if (operatingSystem == 'macos') {
        names.add('$dir/libshear_admit.dylib');
      } else {
        names.add('$dir/libshear_admit.so');
      }
    }
  }
  return names;
}

/// Linux `<exe>/lib/libshear_admit.so`, Windows `<exe>\\shear_admit.dll`,
/// macOS `<exe>/../Frameworks/libshear_admit.dylib`.
@visibleForTesting
String bundledAdmitLibrary({required String operatingSystem, required String exeDir}) {
  if (operatingSystem == 'windows') {
    final sep = exeDir.contains('\\') ? '\\' : '/';
    return '$exeDir${sep}shear_admit.dll';
  }
  if (operatingSystem == 'macos') {
    final parent = exeDir.endsWith('/') ? exeDir.substring(0, exeDir.length - 1) : exeDir;
    final macOs = parent.lastIndexOf('/');
    final contents = macOs > 0 ? parent.substring(0, macOs) : '$parent/..';
    return '$contents/Frameworks/libshear_admit.dylib';
  }
  return '$exeDir/lib/libshear_admit.so';
}

/// Null when [expectedHex] matches [bytes]. A reason otherwise.
@visibleForTesting
String? admitPinFailure(List<int> bytes, String expectedHex) {
  final want = expectedHex.trim().toLowerCase();
  if (want.isEmpty) return 'missing sha256 pin';
  final got = sha256.convert(bytes).toString();
  if (got != want) return 'sha256 mismatch';
  return null;
}

/// Null when [codesignText] is a Developer ID seal for [expectedIdentity].
/// `Signature=adhoc` fails closed.
@visibleForTesting
String? admitMacSignFailure(String codesignText, String expectedIdentity) {
  final id = expectedIdentity.trim();
  if (id.isEmpty) return 'missing sign identity';
  if (RegExp(r'Signature=adhoc').hasMatch(codesignText)) return 'adhoc signature';
  final authority = RegExp(r'^Authority=(.*)$', multiLine: true).firstMatch(codesignText);
  final got = authority?.group(1)?.trim() ?? '';
  if (got != id) return 'sign identity mismatch';
  return null;
}

/// Pin check that runs before [DynamicLibrary.open] on a profile or release
/// desktop build. macOS uses the post-sign sidecar and the signature identity.
/// Linux and Windows use the `--dart-define` hash only.
@visibleForTesting
String? admitBundledLoadFailure({
  required List<int> bytes,
  required String operatingSystem,
  required String pinHex,
  required String codesignText,
  required String signId,
}) {
  final pin = admitPinFailure(bytes, pinHex);
  if (pin != null) return pin;
  if (operatingSystem == 'macos') return admitMacSignFailure(codesignText, signId);
  return null;
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
  AdmitNative.debugSecretBeforeFree?.call(p, n);
  calloc.free(p);
}

String _osName() {
  if (Platform.isWindows) return 'windows';
  if (Platform.isMacOS) return 'macos';
  return 'linux';
}

String _exeDir() => File(Platform.resolvedExecutable).parent.path;

typedef _RangeC = Int32 Function(Uint64, Pointer<Uint8>, Pointer<Uint8>, Uint32, Pointer<Uint32>);
typedef _RangeDart = int Function(int, Pointer<Uint8>, Pointer<Uint8>, int, Pointer<Uint32>);
typedef _VerifyC = Int32 Function(Pointer<Uint8>, Pointer<Uint8>, Uint32);
typedef _VerifyDart = int Function(Pointer<Uint8>, Pointer<Uint8>, int);
