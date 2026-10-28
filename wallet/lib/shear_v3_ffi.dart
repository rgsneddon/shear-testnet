import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

typedef _HashC = Void Function(Pointer<Uint8> header, Pointer<Uint8> out);
typedef _HashDart = void Function(Pointer<Uint8> header, Pointer<Uint8> out);
typedef _BackendC = Pointer<Utf8> Function();

Pointer<Utf8> Function()? _backendFn;

/// The backend libshear_v3 hashes with: "jit" once it reproduced the
/// interpreter's digests at load, else "interpreter". Null when the library
/// did not load or predates the probe.
String? shearV3Backend() {
  if (_load() == null) return null;
  final fn = _backendFn;
  if (fn == null) return null;
  return fn().toDartString();
}

_HashDart? _fn;
bool _tried = false;

/// Library packaged beside the executable.
/// Linux `<exe>/lib/libshear_v3.so`, Windows `<exe>\shear_v3.dll`,
/// macOS `<exe>/../Frameworks/libshear_v3.dylib`.
String shearV3BundledLibrary({
  required String operatingSystem,
  required String exeDir,
}) {
  if (operatingSystem == 'windows') {
    final sep = exeDir.contains('\\') ? '\\' : '/';
    return '$exeDir${sep}shear_v3.dll';
  }
  if (operatingSystem == 'macos') {
    final parent = exeDir.endsWith('/')
        ? exeDir.substring(0, exeDir.length - 1)
        : exeDir;
    final macOs = parent.lastIndexOf('/');
    final contents = macOs > 0 ? parent.substring(0, macOs) : '$parent/..';
    return '$contents/Frameworks/libshear_v3.dylib';
  }
  return '$exeDir/lib/libshear_v3.so';
}

String _exeDir() {
  final exe = Platform.resolvedExecutable;
  final slash = exe.lastIndexOf('/');
  final back = exe.lastIndexOf('\\');
  final cut = slash > back ? slash : back;
  if (cut <= 0) return '';
  return exe.substring(0, cut);
}

DynamicLibrary? _open() {
  if (Platform.isAndroid || Platform.isIOS) {
    try {
      return DynamicLibrary.open('libshear_v3.so');
    } catch (_) {
      return null;
    }
  }
  final env = Platform.environment['SHEAR_V3_LIB'];
  final exeDir = _exeDir();
  final bundled = exeDir.isEmpty
      ? ''
      : shearV3BundledLibrary(
          operatingSystem: Platform.operatingSystem,
          exeDir: exeDir,
        );
  final beside = exeDir.isEmpty
      ? ''
      : Platform.isWindows
      ? '$exeDir\\libshear_v3.dll'
      : '$exeDir/libshear_v3.so';
  final cands = <String>[
    if (env != null && env.isNotEmpty) env,
    if (bundled.isNotEmpty) bundled,
    if (beside.isNotEmpty) beside,
    'native/libshear_v3.so',
    'wallet/native/libshear_v3.so',
    '../wallet/native/libshear_v3.so',
  ];
  Object? last;
  for (final path in cands) {
    try {
      return DynamicLibrary.open(path);
    } catch (e) {
      last = e;
    }
  }
  stderr.writeln('shear_v3_load: $last');
  return null;
}

_HashDart? _load() {
  if (_tried) return _fn;
  _tried = true;
  final lib = _open();
  if (lib == null) return null;
  _fn = lib.lookupFunction<_HashC, _HashDart>('shear_v3_hash');
  try {
    _backendFn = lib.lookupFunction<_BackendC, Pointer<Utf8> Function()>('shear_v3_backend');
  } catch (_) {
    _backendFn = null;
  }
  return _fn;
}

/// ShearHash-v3 through libshear_v3. The key includes the previous hash, so
/// each new header rebuilds the RandomX cache. Null when the header is the
/// wrong length or the library did not load. Calls are serialized in the
/// library so two isolates cannot hash at once.
Uint8List? shearV3Native(Uint8List header) {
  if (header.length != 128) return null;
  final fn = _load();
  if (fn == null) return null;
  final inp = calloc<Uint8>(128);
  final out = calloc<Uint8>(32);
  try {
    for (var i = 0; i < 128; i++) {
      inp[i] = header[i];
    }
    fn(inp, out);
    final got = Uint8List.fromList(out.asTypedList(32));
    var any = false;
    for (final b in got) {
      if (b != 0) {
        any = true;
        break;
      }
    }
    if (!any) return null;
    return got;
  } finally {
    calloc.free(inp);
    calloc.free(out);
  }
}
