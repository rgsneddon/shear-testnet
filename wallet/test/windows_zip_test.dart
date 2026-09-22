import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';

import 'windows_sxs_manifest.dart';

/// Inspects a built windows zip when one exists. Testnet is not gated on Windows.
File _shippedWindowsZip() {
  final candidates = <File>[
    File('../dist/shear-wallet-0.48-windows.zip'),
    File('dist/shear-wallet-0.48-windows.zip'),
    File('${Directory.current.path}/../dist/shear-wallet-0.48-windows.zip'),
  ];
  for (final f in candidates) {
    if (f.existsSync()) return f;
  }
  return candidates.first;
}

String _pythonBin() {
  final candidates = Platform.isWindows
      ? <String>['python', 'python3']
      : <String>['python3', 'python'];
  for (final c in candidates) {
    final r = Process.runSync(c, ['-c', 'import zipfile,sys; sys.stdout.write("ok")']);
    if (r.exitCode == 0 && r.stdout.toString().contains('ok')) return c;
  }
  fail('python with zipfile not found');
}

List<String> _zipNames(File zip) {
  final listed = Process.runSync(_pythonBin(), [
    '-c',
    'import zipfile,sys; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))',
    zip.path,
  ]);
  expect(listed.exitCode, 0, reason: listed.stderr.toString());
  return listed.stdout
      .toString()
      .split(RegExp(r'\r?\n'))
      .map((s) => s.replaceAll('\\', '/').trim())
      .where((s) => s.isNotEmpty)
      .toList();
}

void main() {
  test('kWalletVersion displayed patch is 0.48.0 (not 0.14.0)', () {
    expect(kWalletVersion, '0.48.0');
    final zipPy = File('pack/zip_windows.py').readAsStringSync();
    expect(zipPy, contains('kWalletVersion'));
    expect(zipPy, contains('shear-wallet-{PUBLIC_PIN}-windows.zip'));
    expect(kWalletVersion.split('.').length, 3);
    expect(RegExp(r'^\d+\.\d+\.\d+$').hasMatch(kWalletVersion), isTrue);
    expect(kWalletVersion, isNot('0.14.0'));
    final linux = File('pack/build_linux.sh').readAsStringSync();
    expect(linux, contains('--build-name='));
    expect(linux, isNot(contains('--build-name=0.14')));
    final macos = File('pack_macos.sh').readAsStringSync();
    expect(macos, contains('kWalletVersion'));
    expect(macos, isNot(contains('VER=0.14')));
  });

  test('built shear-wallet-0.48-windows.zip is a Flutter runner with no miner', () {
    final zip = _shippedWindowsZip();
    if (!zip.existsSync()) {
      return; // leftover on Windows; Darwin Mac-cut does not pack this zip
    }
    expect(zip.lengthSync(), greaterThan(1 * 1024 * 1024));

    final names = _zipNames(zip);
    expect(names, isNotEmpty);
    expect(
      names.any((n) => n == 'shear_wallet.exe' || n.endsWith('/shear_wallet.exe')),
      isTrue,
      reason: 'Flutter Windows runner missing in $names',
    );
    expect(
      names.any((n) => n.contains('flutter_windows.dll') || n.endsWith('.dll')),
      isTrue,
      reason: 'Flutter Windows DLLs missing',
    );
    expect(
      names.any((n) => n.contains('data/') || n.contains('icudtl.dat') || n.contains('app.so')),
      isTrue,
      reason: 'Flutter data bundle missing',
    );

    const banned = {
      'shear-miner.exe',
      'shear-miner',
      'shear-miner.bat',
      'sheark-miner.exe',
      'sheark-miner',
    };
    for (final n in names) {
      final base = n.split('/').last.toLowerCase();
      expect(banned.contains(base), isFalse, reason: 'miner inside wallet zip: $n');
      expect(base, isNot(equals('Shear-Miner.exe'.toLowerCase())));
      expect(base, isNot(equals('ShearK-Miner.exe'.toLowerCase())));
    }
  });

  test('shipped runner.exe.manifest is schema-legal Win32 fusion XML', () {
    final xml = File('windows/runner/runner.exe.manifest').readAsStringSync();
    checkFusionManifestLegal(xml);
    expect(fusionWindowsSettingNames(xml), containsAll(['dpiAwareness', 'dpiAware']));
    expect(fusionWindowsSettingNames(xml), isNot(contains('webcam')));
  });

  test('PR #24 webcam fusion windowsSettings is rejected as illegal SxS', () {
    expect(fusionWindowsSettingNames(kPr24IllegalWebcamFusionXml), contains('webcam'));
    expect(
      () => checkFusionManifestLegal(kPr24IllegalWebcamFusionXml),
      throwsA(isA<StateError>()),
    );
    expect(kLegalFusionWindowsSettings.contains('webcam'), isFalse);
  });

  test('packed shear_wallet.exe RT_MANIFEST is schema-legal fusion XML', () {
    final zip = _shippedWindowsZip();
    if (!zip.existsSync()) {
      return;
    }
    final py = Process.runSync(_pythonBin(), [
      '-c',
      r'''
import re, sys, zipfile, xml.etree.ElementTree as ET
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
exe_name = next(n for n in names if n.replace("\\","/").rstrip("/").split("/")[-1] == "shear_wallet.exe")
blob = z.read(exe_name)
# Embedded RT_MANIFEST is UTF-8 XML in .rsrc.
m = re.search(br"<\?xml\b[^>]*\?>\s*<assembly\b.*?</assembly>", blob, re.S)
if not m:
    m = re.search(br"<assembly\b[^>]*manifestVersion.*?</assembly>", blob, re.S)
if not m:
    sys.stderr.write("no fusion XML in packed shear_wallet.exe\n")
    sys.exit(2)
xml = m.group(0).decode("utf-8")
print(xml)
root = ET.fromstring(xml)
# ElementTree expands xmlns; collect windowsSettings children local names.
illegal = []
settings = []
def local(tag):
    return tag.rsplit("}", 1)[-1]
for el in root.iter():
    if local(el.tag) == "windowsSettings":
        for child in list(el):
            settings.append(local(child.tag))
legal = {
    "dpiAwareness", "dpiAware", "activeCodePage", "longPathAware",
    "gdiScaling", "heapType", "disableTheming", "disableWindowFiltering",
    "printerDriverIsolation",
}
for name in settings:
    if name not in legal:
        illegal.append(name)
print("SETTINGS", ",".join(settings))
if "webcam" in settings or illegal:
    sys.stderr.write("illegal fusion windowsSettings: %s\n" % (illegal or settings))
    sys.exit(3)
if "dpiAwareness" not in settings:
    sys.stderr.write("missing dpiAwareness\n")
    sys.exit(4)
''',
      zip.path,
    ]);
    expect(py.exitCode, 0, reason: 'packed RT_MANIFEST SxS parse failed: ${py.stderr}\n${py.stdout}');
    final out = py.stdout.toString();
    expect(out.toLowerCase(), isNot(contains('<webcam')));
    expect(out, contains('dpiAwareness'));
    checkFusionManifestLegal(out.split('SETTINGS').first);
  });

  File _zipAt(String name) {
    final candidates = <File>[
      File('../dist/$name'),
      File('dist/$name'),
      File('${Directory.current.path}/../dist/$name'),
    ];
    for (final f in candidates) {
      if (f.existsSync()) return f;
    }
    return candidates.first;
  }

  Map<String, String> _inspectZip(File zip) {
    final py = Process.runSync(_pythonBin(), [
      '-c',
      r'''
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
print("NAMES", "\n".join(names))
wallet = "shear_wallet" if "shear_wallet" in names else next(n for n in names if n.endswith("/shear_wallet") or n.endswith("shear_wallet"))
print("MAGIC", z.read(wallet)[:4].hex())
if "PKGBUILD" in names:
    print("PKGBUILD", z.read("PKGBUILD").decode())
''',
      zip.path,
    ]);
    expect(py.exitCode, 0, reason: py.stderr.toString());
    return {'out': py.stdout.toString()};
  }

  test('built shear-wallet-0.48-linux.zip is ELF shear_wallet, libsodium, no miner', () {
    final zip = _zipAt('shear-wallet-0.48-linux.zip');
    if (!zip.existsSync()) return; // packed on Dedicated-de / wallet-linux workflow
    expect(zip.lengthSync(), greaterThan(1 * 1024 * 1024));
    final names = _zipNames(zip);
    expect(names.any((n) => n == 'shear_wallet' || n.endsWith('/shear_wallet')), isTrue);
    expect(names.any((n) => n.contains('libsodium.so')), isTrue, reason: names.join('\n'));
    final inspected = _inspectZip(zip);
    expect(inspected['out'], contains('MAGIC 7f454c46'));
    expect(inspected['out']!.toLowerCase().contains('cffaedfe'), isFalse);
    expect(inspected['out']!.contains('MAGIC 4d5a'), isFalse);
    for (final n in names) {
      final base = n.split('/').last;
      expect(base.toLowerCase(), isNot(equals('shear-miner')));
      expect(base, isNot(equals('Shear-Miner')));
      expect(base, isNot(equals('ShearK-Miner')));
      expect(base.toLowerCase(), isNot(equals('sheark-miner.exe')));
      expect(base.toLowerCase(), isNot(equals('shear_wallet.exe')));
    }
  });

  test('built shear-wallet-0.48-archlinux.zip has PKGBUILD pkgver=0.48, ELF, no miner', () {
    final zip = _zipAt('shear-wallet-0.48-archlinux.zip');
    if (!zip.existsSync()) return; // packed on the linux host
    expect(zip.lengthSync(), greaterThan(1 * 1024 * 1024));
    final names = _zipNames(zip);
    expect(names.contains('PKGBUILD') || names.any((n) => n.endsWith('/PKGBUILD')), isTrue);
    expect(names.any((n) => n == 'shear_wallet' || n.endsWith('/shear_wallet')), isTrue);
    expect(names.any((n) => n.contains('libsodium.so')), isTrue, reason: names.join('\n'));
    final inspected = _inspectZip(zip);
    expect(inspected['out'], contains('MAGIC 7f454c46'));
    expect(inspected['out'], contains('pkgver=0.48'));
    expect(inspected['out']!.contains('pkgver=0.48.0'), isFalse);
    expect(inspected['out']!.contains('pkgver=0.33'), isFalse);
    for (final n in names) {
      final base = n.split('/').last;
      expect(base.toLowerCase(), isNot(equals('shear-miner')));
      expect(base, isNot(equals('ShearK-Miner')));
    }
  });

  test('leftover shear-wallet-0.31 zip names stay historical (not recut)', () {
    for (final name in [
      'shear-wallet-0.32-windows.zip',
      'shear-wallet-0.32-linux.zip',
      'shear-wallet-0.32-archlinux.zip',
      'shear-wallet-0.31-windows.zip',
      'shear-wallet-0.31-linux.zip',
      'shear-wallet-0.31-archlinux.zip',
    ]) {
      final f = _zipAt(name);
      if (!f.existsSync()) continue;
      expect(f.lengthSync(), greaterThan(1 * 1024 * 1024));
    }
  });
}
