import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_licenses.dart';

void main() {
  final asset = File('assets/licenses/THIRD_PARTY_NOTICES.txt').readAsStringSync();

  test('bundled notices carry the attribution verbatim and the Shear MIT licence', () {
    expect(asset, contains(kShearAttribution));
    expect(kShearAttribution, 'The Shear concept was inspired by Roy D Herbert, and the Chronoflux Principia.');
    expect(kShearLegalese, contains(kShearAttribution));
    expect(asset, contains('Copyright (c) 2026 Shear'));
  });

  test('parser yields entries for native libraries Flutter does not collect', () {
    final entries = parseThirdPartyNotices(asset);
    final packages = {for (final e in entries) ...e.packages};
    for (final name in [
      'Shear',
      'libsodium',
      'RandomX',
      'Node.js',
      'curve25519-dalek',
      'helioselene',
      'org.bouncycastle:bcprov-jdk18on',
      'com.google.mlkit:barcode-scanning',
      'SDWebImage',
      'pointycastle',
    ]) {
      expect(packages, contains(name), reason: name);
    }
    for (final e in entries) {
      final text = e.paragraphs.map((p) => p.text).join('\n');
      expect(text.trim(), isNotEmpty);
    }
  });

  test('registry serves the bundled notices', () async {
    debugResetShearLicenses();
    registerShearLicenses();
    final all = await LicenseRegistry.licenses.toList();
    expect(all.any((e) => e.packages.contains('libsodium')), isTrue);
    expect(
      all.any((e) => e.paragraphs.any((p) => p.text.contains(kShearAttribution))),
      isTrue,
    );
  });

  testWidgets('About and licences opens the licence page with the attribution', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => TextButton(
          onPressed: () => showShearLicenses(context, version: '0.72'),
          child: const Text('About and licences'),
        ),
      ),
    ));
    await tester.tap(find.text('About and licences'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(find.byType(LicensePage), findsOneWidget);
    expect(find.textContaining(kShearAttribution), findsOneWidget);
  });
}
