import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';

/// Inspects the **built** `shear-wallet-0.5-windows.zip` (not a mocked listing).
/// Pack with `python wallet/pack/zip_windows.py` after `flutter build windows --release`.
File _shippedWindowsZip() {
  final candidates = <File>[
    File('../dist/shear-wallet-0.5-windows.zip'),
    File('dist/shear-wallet-0.5-windows.zip'),
    File('${Directory.current.path}/../dist/shear-wallet-0.5-windows.zip'),
  ];
  for (final f in candidates) {
    if (f.existsSync()) return f;
  }
  return candidates.first;
}

List<String> _zipNames(File zip) {
  final listed = Process.runSync('tar', ['-tf', zip.path], runInShell: true);
  expect(listed.exitCode, 0, reason: listed.stderr.toString());
  return listed.stdout
      .toString()
      .split(RegExp(r'\r?\n'))
      .map((s) => s.replaceAll('\\', '/').trim())
      .where((s) => s.isNotEmpty)
      .toList();
}

void main() {
  test('kWalletVersion public pin is two-part 0.5 (not 0.5.0)', () {
    expect(kWalletVersion, '0.5');
    expect(kWalletVersion.split('.').length, 2);
    expect(RegExp(r'^\d+\.\d+$').hasMatch(kWalletVersion), isTrue);
    expect(RegExp(r'^\d+\.\d+\.\d+$').hasMatch(kWalletVersion), isFalse);
  });

  test('built shear-wallet-0.5-windows.zip is a Flutter runner with no miner', () {
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

  test('built shear-wallet-0.4-linux.zip has shear_wallet and no miner', () {
    final zip = _zipAt('shear-wallet-0.4-linux.zip');
    if (!zip.existsSync()) return;
    expect(zip.lengthSync(), greaterThan(1 * 1024 * 1024));
    final names = _zipNames(zip);
    expect(names.any((n) => n == 'shear_wallet' || n.endsWith('/shear_wallet')), isTrue);
    for (final n in names) {
      final base = n.split('/').last;
      expect(base.toLowerCase(), isNot(equals('shear-miner')));
      expect(base, isNot(equals('Shear-Miner')));
      expect(base, isNot(equals('ShearK-Miner')));
    }
  });

  test('built shear-wallet-0.4-archlinux.zip has PKGBUILD pkgver=0.4 and no miner', () {
    final zip = _zipAt('shear-wallet-0.4-archlinux.zip');
    if (!zip.existsSync()) return;
    expect(zip.lengthSync(), greaterThan(1 * 1024 * 1024));
    final names = _zipNames(zip);
    expect(names.contains('PKGBUILD') || names.any((n) => n.endsWith('/PKGBUILD')), isTrue);
    expect(names.any((n) => n == 'shear_wallet' || n.endsWith('/shear_wallet')), isTrue);
    for (final n in names) {
      final base = n.split('/').last;
      expect(base.toLowerCase(), isNot(equals('shear-miner')));
      expect(base, isNot(equals('ShearK-Miner')));
    }
  });
}
