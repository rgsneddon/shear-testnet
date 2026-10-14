import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';

/// Inspects the packed 0.36 fat APK when present.
File _apk() {
  for (final p in [
    '../dist/shear-wallet-0.48-android.apk',
    'dist/shear-wallet-0.48-android.apk',
    '${Directory.current.path}/../dist/shear-wallet-0.48-android.apk',
  ]) {
    final f = File(p);
    if (f.existsSync()) return f;
  }
  return File('../dist/shear-wallet-0.48-android.apk');
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
  test('0.48 APK is a fat installable package (applicationId, versionCode > 52, INTERNET)', () {
    expect(kWalletVersion, '0.72');
    final apk = _apk();
    if (!apk.existsSync()) return;
    expect(apk.lengthSync(), greaterThan(10 * 1024 * 1024));
    final aapt = _aapt();
    expect(aapt, isNotNull, reason: 'aapt required to inspect packed APK');
    final badging = Process.runSync(aapt!, ['dump', 'badging', apk.path]);
    expect(badging.exitCode, 0, reason: badging.stderr.toString());
    final out = badging.stdout.toString();
    expect(out, contains("name='com.shear.shear_wallet'"));
    expect(RegExp(r"versionName='0\.49\.0'").hasMatch(out), isTrue);
    final code = RegExp(r"versionCode='(\d+)'").firstMatch(out);
    expect(code, isNotNull);
    expect(int.parse(code!.group(1)!), 70);
    expect(out, contains("uses-permission: name='android.permission.INTERNET'"));
    expect(out.contains("testOnly='true'"), isFalse);
    expect(File('android/app/src/main/AndroidManifest.xml').readAsStringSync(),
        contains('android.permission.INTERNET'));
  });

  test('android floor is API 29, arm64-only, 16 KiB pages', () {
    final gradle = File('android/app/build.gradle.kts').readAsStringSync();
    final script = File('../crypto/native/build-android-arm64.sh').readAsStringSync();
    expect(gradle, contains('minSdk = 29'));
    expect(gradle.contains('flutter.minSdkVersion'), isFalse);
    expect(gradle, contains('abiFilters.add("arm64-v8a")'));
    expect(gradle, contains('lib/armeabi-v7a/**'));
    expect(gradle, contains('lib/x86_64/**'));
    expect(script, contains('SHEAR_ANDROID_API:-29'));
    expect(script, contains('max-page-size=16384'));
    expect(script.contains('--features admit-v3'), isFalse);
    expect(elfArm64Page16k(_elfFixture(machine: 183, align: 16384)), isTrue);
    expect(elfArm64Page16k(_elfFixture(machine: 62, align: 16384)), isFalse);
    expect(elfArm64Page16k(_elfFixture(machine: 183, align: 4096)), isFalse);
  });

  test('staged android libs are arm64 when a pack or jniLibs tree is present', () {
    final found = <File>[];
    final jni = Directory('android/app/src/main/jniLibs');
    if (jni.existsSync()) {
      for (final ent in jni.listSync(recursive: true)) {
        if (ent is File && ent.path.endsWith('.so')) found.add(ent);
      }
    }
    final apk = _apk();
    if (found.isEmpty && !apk.existsSync()) return;
    for (final so in found) {
      final rel = so.path.replaceAll('\\', '/');
      expect(rel.contains('/arm64-v8a/'), isTrue, reason: rel);
      expect(rel.contains('/armeabi'), isFalse, reason: rel);
      expect(rel.contains('/x86'), isFalse, reason: rel);
      expect(elfArm64Page16k(so.readAsBytesSync()), isTrue, reason: rel);
      final pin = File('${so.path}.sha256');
      if (so.path.endsWith('libshear_admit.so') && pin.existsSync()) {
        expect(pin.readAsStringSync().trim(), _sha256(so.readAsBytesSync()));
      }
    }
    if (found.isNotEmpty) {
      expect(found.any((f) => f.path.endsWith('libshear_admit.so')), isTrue);
    }
    if (!apk.existsSync()) return;
    final listed = Process.runSync('unzip', ['-Z1', apk.path]);
    expect(listed.exitCode, 0, reason: listed.stderr.toString());
    final names = listed.stdout.toString().split('\n').where((l) => l.endsWith('.so')).toList();
    expect(names.any((n) => n == 'lib/arm64-v8a/libshear_admit.so'), isTrue, reason: names.join('\n'));
    expect(names.any((n) => n == 'lib/arm64-v8a/libsodium.so'), isTrue, reason: names.join('\n'));
    expect(names.every((n) => n.startsWith('lib/arm64-v8a/')), isTrue, reason: names.join('\n'));
  });
}

String _sha256(List<int> bytes) => sha256.convert(bytes).toString();

/// Little-endian ELF64 with one LOAD segment. PT_LOAD p_align is at phdr+48.
Uint8List _elfFixture({required int machine, required int align}) {
  final buf = Uint8List(64 + 56);
  final bd = ByteData.sublistView(buf);
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  buf[4] = 2;
  buf[5] = 1;
  bd.setUint16(18, machine, Endian.little);
  bd.setUint64(32, 64, Endian.little);
  bd.setUint16(54, 56, Endian.little);
  bd.setUint16(56, 1, Endian.little);
  bd.setUint32(64, 1, Endian.little);
  bd.setUint64(64 + 48, align, Endian.little);
  return buf;
}

bool elfArm64Page16k(List<int> bytes) {
  if (bytes.length < 64) return false;
  if (bytes[0] != 0x7f || bytes[1] != 0x45 || bytes[2] != 0x4c || bytes[3] != 0x46) return false;
  if (bytes[4] != 2 || bytes[5] != 1) return false;
  final bd = ByteData.sublistView(Uint8List.fromList(bytes));
  if (bd.getUint16(18, Endian.little) != 183) return false;
  final phoff = bd.getUint64(32, Endian.little);
  final phentsize = bd.getUint16(54, Endian.little);
  final phnum = bd.getUint16(56, Endian.little);
  if (phentsize < 56 || phnum == 0) return false;
  var sawLoad = false;
  for (var i = 0; i < phnum; i++) {
    final off = phoff + i * phentsize;
    if (off + 56 > bytes.length) return false;
    if (bd.getUint32(off, Endian.little) != 1) continue;
    sawLoad = true;
    final align = bd.getUint64(off + 48, Endian.little);
    if (align < 16384) return false;
  }
  return sawLoad;
}
