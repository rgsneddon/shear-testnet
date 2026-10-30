import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The wallet does not dial a privacy-hop relay and does not ship hop code.
void main() {
  test('privacy_hop_absent', () {
    final repo = _repoRoot();
    const gone = <String>[
      'wallet/lib/shear_privacy_hop.dart',
      'wallet/android/app/src/main/kotlin/com/shear/shear_wallet/PrivacyHopVpnService.kt',
      'wallet/android/app/src/main/kotlin/com/shear/shear_wallet/RptClientEngine.kt',
      'wallet/android/app/src/main/kotlin/com/shear/shear_wallet/RptObfuscation.kt',
      'wallet/android/app/src/main/kotlin/com/shear/shear_wallet/RptTrafficShape.kt',
      'wallet/assets/hop/node_elgamal.pub',
    ];
    for (final rel in gone) {
      expect(File(_join(repo.path, rel)).existsSync(), isFalse, reason: rel);
    }

    final needles = <RegExp>[
      RegExp(r'privacy[-_ ]hop', caseSensitive: false),
      RegExp(r'SHEAR-HOP', caseSensitive: false),
      RegExp(r'PrivacyHop'),
      RegExp(r'privacyHop'),
      RegExp(r'kPrivacyHop'),
      RegExp(r'HOP_HOST'),
      RegExp(r'HOP_PORT'),
      RegExp(r'HOP_CONNECT'),
      RegExp(r'HOP_DISCONNECT'),
      RegExp(r'shear/privacy_hop'),
      RegExp(r'hop-fee', caseSensitive: false),
      RegExp(r'hop fee', caseSensitive: false),
      RegExp(r'hopFee'),
      RegExp(r'\bRPT2\b'),
      RegExp(r'VpnService'),
      RegExp(r'BIND_VPN'),
      RegExp(r'addDnsServer'),
      RegExp(r'inet_pton'),
      RegExp(r'SOCK_DGRAM'),
      RegExp(r'\b44044\b'),
      RegExp(r'kErrPrivacyVpn'),
      RegExp(r'reserve-hop'),
      RegExp(r'reserve-privacy-hop'),
      RegExp(r'FOREGROUND_SERVICE'),
      RegExp(r'kHopProgress'),
      RegExp(r'Privacy hop', caseSensitive: false),
      RegExp(r'assets/hop'),
    ];

    final hits = <String>[];
    _walk(repo, (file) {
      final path = file.path.replaceAll('\\', '/');
      if (path.endsWith('/wallet/test/privacy_hop_absent_test.dart')) return;
      if (_skipFile(path)) return;
      String text;
      try {
        text = file.readAsStringSync();
      } catch (_) {
        return;
      }
      for (final needle in needles) {
        if (needle.hasMatch(text)) {
          hits.add('$path :: ${needle.pattern}');
          break;
        }
      }
    });
    expect(hits, isEmpty, reason: hits.join('\n'));
  });
}

Directory _repoRoot() {
  final cur = Directory.current;
  if (File(_join(cur.path, 'pubspec.yaml')).existsSync() &&
      Directory(_join(cur.path, 'lib')).existsSync()) {
    return cur.parent;
  }
  if (File(_join(cur.path, 'wallet/pubspec.yaml')).existsSync()) return cur;
  throw StateError('repo root not found from ${cur.path}');
}

void _walk(Directory dir, void Function(File file) onFile) {
  for (final ent in dir.listSync(followLinks: false)) {
    final name = ent.uri.pathSegments.where((s) => s.isNotEmpty).last;
    if (ent is Directory) {
      if (_skipDir(name)) continue;
      _walk(ent, onFile);
    } else if (ent is File) {
      onFile(ent);
    }
  }
}

bool _skipDir(String name) {
  const skip = {
    '.git',
    'node_modules',
    '.dart_tool',
    'build',
    '.gradle',
    'Pods',
    'ephemeral',
    'dist',
    'coverage',
    '.idea',
  };
  return skip.contains(name);
}

bool _skipFile(String path) {
  final lower = path.toLowerCase();
  const ext = [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.ico',
    '.icns',
    '.pdf',
    '.zip',
    '.apk',
    '.dmg',
    '.so',
    '.dll',
    '.exe',
    '.bin',
    '.ttf',
    '.otf',
    '.woff',
    '.woff2',
    '.mp4',
    '.mp3',
    '.wav',
    '.jar',
    '.aar',
  ];
  for (final e in ext) {
    if (lower.endsWith(e)) return true;
  }
  return false;
}

String _join(String a, String b) {
  if (a.endsWith('/') || a.endsWith('\\')) return '$a$b';
  return '$a${Platform.pathSeparator}$b';
}
