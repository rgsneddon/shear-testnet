import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_hash.dart' show shearHashV3;
import 'package:shear_wallet/shear_v3_ffi.dart' show shearV3Backend;

/// Russell, 28 Oct: the wallet uses RandomX only for header PoW checks, in
/// LIGHT mode with the INTERPRETER, on every platform: no JIT, no full
/// dataset. The in-process JIT probe crashed the app on a Samsung S24 Ultra
/// (Android 16): SIGSEGV, "trying to execute non-executable memory", in a
/// DartWorker thread on the first hash. These guards would have caught it.

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Uint8List _probe(int fill) => Uint8List(128)
  ..fillRange(0, 128, fill)
  ..[0] = 1;

void main() {
  test('the export selects only the light interpreter and refuses anything else', () {
    final src = File('native/shear_v3_export.c').readAsStringSync();
    expect(src, contains('#define SHEAR_V3_BACKEND "interpreter"'));
    expect(src, contains('shear_hash_set_backend(SHEAR_V3_BACKEND)'));
    expect(src, contains('shear_v3_request_backend'));
    expect(RegExp(r'set_backend\(\s*"(jit|jit-full|auto)"').hasMatch(src), isFalse, reason: 'no JIT selection');
  });

  test('every wallet build of libshear_v3 compiles the JIT selection out', () {
    for (final f in ['native/build-android-shear-v3.sh', 'native/build-shear-v3.sh', 'native/build-shear-v3.ps1']) {
      expect(File(f).readAsStringSync(), contains('-DSHEAR_HASH_INTERPRETER_ONLY'), reason: f);
    }
    final android = File('native/build-android-shear-v3.sh').readAsStringSync();
    expect(android, contains("grep -aq 'interpreter-only build refused backend'"), reason: 'built-library guard');
    final hash = File('../sheark-miner/src/shear_hash.c').readAsStringSync();
    expect(hash, contains('#ifdef SHEAR_HASH_INTERPRETER_ONLY'));
  });

  test('a built libshear_v3 is the interpreter-only build', () {
    final libs = [
      File('native/libshear_v3.so'),
      File('android/app/src/main/jniLibs/arm64-v8a/libshear_v3.so'),
    ].where((f) => f.existsSync()).toList();
    expect(libs, isNotEmpty, reason: 'build libshear_v3 first (native/build-shear-v3.sh)');
    for (final f in libs) {
      final bytes = f.readAsBytesSync();
      final text = String.fromCharCodes(bytes.where((b) => b >= 32 && b < 127 || b == 10));
      expect(text, contains('interpreter-only build refused backend'), reason: f.path);
      expect(text, isNot(contains('jit-full uses the 2 GiB dataset')), reason: f.path);
    }
  });

  test('the library reports the interpreter and gives the golden digests', () {
    expect(shearV3Backend(), 'interpreter');
    // Golden digests: the node's ShearHash on this tree (R40 FIPS SHA-512 key;
    // pre-R40 feat gives 98818c31... and b8e4d2bd..., as the S24 Ultra did).
    expect(_hex(shearHashV3(_probe(0))!), 'e9e9dee13e2240383e0bdfb65ae962f52d9962a2e3bebd7623d418464ceb8cd4');
    expect(_hex(shearHashV3(_probe(0xa5))!), '8927578439b9d205584885f7fbe18296b0c8f6397fbb0df4086690c69549f698');
  });
}
