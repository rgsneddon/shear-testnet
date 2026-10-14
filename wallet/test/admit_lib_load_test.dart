import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit_ffi.dart';

void main() {
  test('release load uses only the absolute bundled path', () {
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
    for (final os in cases.keys) {
      final release = admitLibraryCandidates(
        releaseMode: true,
        exeDir: cases[os]!,
        envPath: env,
        cwd: cwd,
        operatingSystem: os,
      );
      expect(release, <String>[bundled[os]!]);
      expect(release.single.contains(env), isFalse);
      expect(release.single.contains('crypto/native'), isFalse);
      expect(
        release.single == 'libshear_admit.so' ||
            release.single == 'shear_admit.dll' ||
            release.single == 'libshear_admit.dylib',
        isFalse,
      );

      final debug = admitLibraryCandidates(
        releaseMode: false,
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
}
