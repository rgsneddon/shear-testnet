import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

typedef _HashC = Void Function(Pointer<Uint8> header, Pointer<Uint8> out);
typedef _HashDart = void Function(Pointer<Uint8> header, Pointer<Uint8> out);

_HashDart? _fn;
bool _tried = false;

DynamicLibrary? _open() {
  if (Platform.isAndroid || Platform.isIOS) {
    try {
      return DynamicLibrary.open('libshear_v3.so');
    } catch (_) {
      return null;
    }
  }
  final env = Platform.environment['SHEAR_V3_LIB'];
  final cands = <String>[
    if (env != null && env.isNotEmpty) env,
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
  return _fn;
}

/// ShearHash-v3 through libshear_v3. The native library keeps the RandomX
/// cache for the current key. Null when the header is the wrong length or
/// the library did not load.
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
