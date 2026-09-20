import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';

/// Inspects a built windows zip when one exists. Testnet is not gated on Windows.
File _shippedWindowsZip() {
  final candidates = <File>[
    File('../dist/shear-wallet-0.40-windows.zip'),
    File('dist/shear-wallet-0.40-windows.zip'),
    File('${Directory.current.path}/../dist/shear-wallet-0.40-windows.zip'),
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
  test('kWalletVersion public pin is two-part 0.40 (not 0.14.0)', () {
    expect(kWalletVersion, '0.40');
    final zipPy = File('pack/zip_windows.py').readAsStringSync();
    expect(zipPy, contains('kWalletVersion'));
    expect(zipPy, contains('shear-wallet-{PUBLIC_PIN}-windows.zip'));
    expect(kWalletVersion.split('.').length, 2);
    expect(RegExp(r'^\d+\.\d+$').hasMatch(kWalletVersion), isTrue);
    expect(RegExp(r'^\d+\.\d+\.\d+$').hasMatch(kWalletVersion), isFalse);
    final linux = File('pack/build_linux.sh').readAsStringSync();
    expect(linux, contains('--build-name='));
    expect(linux, isNot(contains('--build-name=0.14')));
    final macos = File('pack_macos.sh').readAsStringSync();
    expect(macos, contains('kWalletVersion'));
    expect(macos, isNot(contains('VER=0.14')));
  });

  test('built shear-wallet-0.40-windows.zip is a Flutter runner with no miner', () {
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

  test('built shear-wallet-0.40-linux.zip is ELF shear_wallet, libsodium, no miner', () {
    final zip = _zipAt('shear-wallet-0.40-linux.zip');
    expect(zip.existsSync(), isTrue, reason: 'missing ${zip.path}');
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

  test('built shear-wallet-0.40-archlinux.zip has PKGBUILD pkgver=0.40, ELF, no miner', () {
    final zip = _zipAt('shear-wallet-0.40-archlinux.zip');
    expect(zip.existsSync(), isTrue, reason: 'missing ${zip.path}');
    expect(zip.lengthSync(), greaterThan(1 * 1024 * 1024));
    final names = _zipNames(zip);
    expect(names.contains('PKGBUILD') || names.any((n) => n.endsWith('/PKGBUILD')), isTrue);
    expect(names.any((n) => n == 'shear_wallet' || n.endsWith('/shear_wallet')), isTrue);
    expect(names.any((n) => n.contains('libsodium.so')), isTrue, reason: names.join('\n'));
    final inspected = _inspectZip(zip);
    expect(inspected['out'], contains('MAGIC 7f454c46'));
    expect(inspected['out'], contains('pkgver=0.40'));
    expect(inspected['out']!.contains('pkgver=0.40.0'), isFalse);
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
