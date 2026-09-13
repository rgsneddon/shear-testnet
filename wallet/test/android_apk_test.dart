import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';

/// Inspects the packed 0.33 fat APK when present.
File _apk() {
  for (final p in [
    '../dist/shear-wallet-0.33-android.apk',
    'dist/shear-wallet-0.33-android.apk',
    '${Directory.current.path}/../dist/shear-wallet-0.33-android.apk',
  ]) {
    final f = File(p);
    if (f.existsSync()) return f;
  }
  return File('../dist/shear-wallet-0.33-android.apk');
}

String? _aapt() {
  for (final p in [
    '${Platform.environment['HOME']}/Library/Android/sdk/build-tools/36.0.0/aapt',
    '${Platform.environment['HOME']}/Library/Android/sdk/build-tools/35.0.0/aapt',
    '/opt/homebrew/bin/aapt',
  ]) {
    if (File(p).existsSync()) return p;
  }
  return null;
}

void main() {
  test('0.33 APK is a fat installable package (applicationId, versionCode > 48, INTERNET)', () {
    expect(kWalletVersion, '0.33');
    final apk = _apk();
    if (!apk.existsSync()) return;
    expect(apk.lengthSync(), greaterThan(10 * 1024 * 1024));
    final aapt = _aapt();
    expect(aapt, isNotNull, reason: 'aapt required to inspect packed APK');
    final badging = Process.runSync(aapt!, ['dump', 'badging', apk.path]);
    expect(badging.exitCode, 0, reason: badging.stderr.toString());
    final out = badging.stdout.toString();
    expect(out, contains("name='com.shear.shear_wallet'"));
    expect(RegExp(r"versionName='0\.33(\.0)?'").hasMatch(out), isTrue);
    final code = RegExp(r"versionCode='(\d+)'").firstMatch(out);
    expect(code, isNotNull);
    expect(int.parse(code!.group(1)!), greaterThan(48));
    expect(out, contains("uses-permission: name='android.permission.INTERNET'"));
    expect(out.contains("testOnly='true'"), isFalse);
    expect(File('android/app/src/main/AndroidManifest.xml').readAsStringSync(),
        contains('android.permission.INTERNET'));
  });
}
