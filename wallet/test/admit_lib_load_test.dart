import 'dart:ffi';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit_ffi.dart';
import 'package:shear_wallet/shear_admit_pin.dart';

void main() {
  test('profile and release load only the absolute bundled path', () {
    const env = '/tmp/evil/libshear_admit.so';
    const cwd = '/tmp/cwd';
    final cases = <String, String>{
      'linux': '/opt/shear',
      'windows': r'C:\Shear',
      'macos': '/App/Contents/MacOS',
    };
    final bundled = <String, String>{
      'linux': '/opt/shear/lib/libshear_admit.so',
      'windows': r'C:\Shear\shear_admit.dll',
      'macos': '/App/Contents/Frameworks/libshear_admit.dylib',
    };
    expect(admitPinnedLoad(debugMode: false), isTrue);
    expect(admitPinnedLoad(debugMode: true), isFalse);
    for (final os in cases.keys) {
      final pinned = admitLibraryCandidates(
        pinned: admitPinnedLoad(debugMode: false),
        exeDir: cases[os]!,
        envPath: env,
        cwd: cwd,
        operatingSystem: os,
      );
      expect(pinned, <String>[bundled[os]!]);
      expect(pinned.single.contains(env), isFalse);
      expect(pinned.single.contains('crypto/native'), isFalse);
      expect(
        pinned.single == 'libshear_admit.so' ||
            pinned.single == 'shear_admit.dll' ||
            pinned.single == 'libshear_admit.dylib',
        isFalse,
      );

      final debug = admitLibraryCandidates(
        pinned: admitPinnedLoad(debugMode: true),
        exeDir: cases[os]!,
        envPath: env,
        cwd: cwd,
        operatingSystem: os,
      );
      expect(debug.first, env);
      expect(debug.contains(bundled[os]), isTrue);
      expect(debug.any((name) => name.contains('crypto/native/admit/target/release')), isTrue);
      expect(
        debug.any((name) =>
            name == 'libshear_admit.so' || name == 'shear_admit.dll' || name == 'libshear_admit.dylib'),
        isFalse,
      );
    }
  });

  test('sha256 pin rejects an empty or mismatched digest before open', () {
    const bytes = <int>[1, 2, 3, 4];
    expect(admitPinFailure(bytes, ''), 'missing sha256 pin');
    expect(admitPinFailure(bytes, '00'), 'sha256 mismatch');
    expect(
      admitPinFailure(bytes, '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a'),
      isNull,
    );
  });

  test('release smoke checks the bundled bytes and the macOS signature', () {
    const bytes = <int>[1, 2, 3, 4];
    const digest = '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a';
    const id = 'Developer ID Application: Russell Sneddon (SFCBP95595)';
    expect(kShearAdmitSignId, id);
    expect(
      admitBundledLoadFailure(
        bytes: bytes,
        operatingSystem: 'linux',
        pinHex: '',
        codesignText: '',
        signId: id,
      ),
      'missing sha256 pin',
    );
    expect(
      admitBundledLoadFailure(
        bytes: bytes,
        operatingSystem: 'linux',
        pinHex: digest,
        codesignText: 'Signature=adhoc',
        signId: id,
      ),
      isNull,
    );
    expect(
      admitBundledLoadFailure(
        bytes: bytes,
        operatingSystem: 'macos',
        pinHex: digest,
        codesignText: 'Signature=adhoc\n',
        signId: id,
      ),
      'adhoc signature',
    );
    expect(
      admitBundledLoadFailure(
        bytes: bytes,
        operatingSystem: 'macos',
        pinHex: digest,
        codesignText: 'Authority=$id\n',
        signId: id,
      ),
      isNull,
    );
    expect(
      admitBundledLoadFailure(
        bytes: bytes,
        operatingSystem: 'macos',
        pinHex: digest,
        codesignText: 'Authority=Developer ID Application: Other (XXXX)\n',
        signId: id,
      ),
      'sign identity mismatch',
    );

    final dir = Directory.systemTemp.createTempSync('admit-pin-smoke');
    try {
      final lib = File('${dir.path}/lib/libshear_admit.so');
      lib.parent.createSync(recursive: true);
      lib.writeAsBytesSync(bytes);
      File('${lib.path}.sha256').writeAsStringSync('$digest\n');
      final bundled = bundledAdmitLibrary(operatingSystem: 'linux', exeDir: dir.path);
      expect(bundled, lib.path);
      final pinnedBytes = File(bundled).readAsBytesSync();
      expect(
        admitBundledLoadFailure(
          bytes: pinnedBytes,
          operatingSystem: 'linux',
          pinHex: File('$bundled.sha256').readAsStringSync(),
          codesignText: '',
          signId: id,
        ),
        isNull,
      );
    } finally {
      dir.deleteSync(recursive: true);
    }
  });

  test('debug cdylib opens when the cargo artifact is present', () {
    final so = File('../crypto/native/admit/target/debug/libshear_admit.so');
    if (!so.existsSync()) return;
    final lib = DynamicLibrary.open(so.absolute.path);
    lib.lookup<NativeFunction<Int32 Function(Uint64, Pointer<Uint8>, Pointer<Uint8>, Uint32, Pointer<Uint32>)>>(
      'shear_range_prove',
    );
    expect(
      () => lib.lookup<NativeFunction<Void Function()>>('shear_admit_prove_v3'),
      throwsA(isA<ArgumentError>()),
    );
  });
}
