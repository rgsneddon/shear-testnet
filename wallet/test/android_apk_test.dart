import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';

/// Inspects the packed 0.36 fat APK when present.
File _apk() {
  for (final p in [
    '../dist/shear-wallet-0.47-android.apk',
    'dist/shear-wallet-0.47-android.apk',
    '${Directory.current.path}/../dist/shear-wallet-0.47-android.apk',
  ]) {
    final f = File(p);
    if (f.existsSync()) return f;
  }
  return File('../dist/shear-wallet-0.47-android.apk');
}

String? _aapt() {
  for (final p in [
    '${Platform.environment['HOME']}/Library/Android/sdk/build-tools/36.0.0/aapt',
    '${Platform.environment['HOME']}/Library/Android/sdk/build-tools/35.0.0/aapt',
    '${Platform.environment['LOCALAPPDATA']}/Android/Sdk/build-tools/36.0.0/aapt.exe',
    '${Platform.environment['LOCALAPPDATA']}/Android/Sdk/build-tools/36.0.0/aapt',
    '${Platform.environment['ANDROID_HOME']}/build-tools/36.0.0/aapt.exe',
    '/opt/homebrew/bin/aapt',
  ]) {
    if (File(p).existsSync()) return p;
  }
  return null;
}

void main() {
  test('0.47 APK is a fat installable package (applicationId, versionCode > 52, INTERNET)', () {
    expect(kWalletVersion, '0.47');
    final apk = _apk();
    if (!apk.existsSync()) return;
    expect(apk.lengthSync(), greaterThan(10 * 1024 * 1024));
    final aapt = _aapt();
    expect(aapt, isNotNull, reason: 'aapt required to inspect packed APK');
    final badging = Process.runSync(aapt!, ['dump', 'badging', apk.path]);
    expect(badging.exitCode, 0, reason: badging.stderr.toString());
    final out = badging.stdout.toString();
    expect(out, contains("name='com.shear.shear_wallet'"));
    expect(RegExp(r"versionName='0\.47(\.0)?'").hasMatch(out), isTrue);
    final code = RegExp(r"versionCode='(\d+)'").firstMatch(out);
    expect(code, isNotNull);
    expect(int.parse(code!.group(1)!), 68);
    expect(out, contains("uses-permission: name='android.permission.INTERNET'"));
    expect(out.contains("testOnly='true'"), isFalse);
    expect(File('android/app/src/main/AndroidManifest.xml').readAsStringSync(),
        contains('android.permission.INTERNET'));
  });
}
