import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

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
    expect(kShearAdmitTeamId, 'SFCBP95595');
    expect(kCodesignBin, '/usr/bin/codesign');
    final verifyArgs = admitMacVerifyArgs(
      '/App/Contents/Frameworks/libshear_admit.dylib',
      kShearAdmitTeamId,
    );
    expect(verifyArgs, contains('--verify'));
    expect(verifyArgs, contains('--strict'));
    final requirement = verifyArgs[verifyArgs.indexOf('-R') + 1];
    expect(requirement, admitMacRequirement(kShearAdmitTeamId));
    expect(requirement, contains('anchor apple generic'));
    expect(requirement, contains('certificate 1[field.$kDevIdIntermediateOid] /* exists */'));
    expect(requirement, contains('certificate leaf[field.$kDevIdLeafOid] /* exists */'));
    expect(requirement, contains('certificate leaf[subject.OU] = "SFCBP95595"'));
    expect(verifyArgs.last, '/App/Contents/Frameworks/libshear_admit.dylib');
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
        codesignExit: 1,
        signId: id,
        teamId: kShearAdmitTeamId,
      ),
      'adhoc signature',
    );
    expect(
      admitBundledLoadFailure(
        bytes: bytes,
        operatingSystem: 'macos',
        pinHex: digest,
        codesignText: 'TeamIdentifier=${kShearAdmitTeamId}\nAuthority=$id\nvalid on disk\n',
        codesignExit: 0,
        signId: id,
        teamId: kShearAdmitTeamId,
      ),
      isNull,
    );
    expect(
      admitBundledLoadFailure(
        bytes: bytes,
        operatingSystem: 'macos',
        pinHex: digest,
        codesignText: 'TeamIdentifier=XXXXXXXXXX\nvalid on disk\n',
        codesignExit: 0,
        signId: id,
        teamId: kShearAdmitTeamId,
      ),
      'sign identity mismatch',
    );
    expect(
      admitBundledLoadFailure(
        bytes: bytes,
        operatingSystem: 'macos',
        pinHex: digest,
        codesignText: 'valid on disk\n',
        codesignExit: 1,
        signId: id,
        teamId: kShearAdmitTeamId,
      ),
      'codesign verify failed',
    );
    expect(
      admitMacSignFailure(
        'Authority=self-signed\nTeamIdentifier=${kShearAdmitTeamId}\n',
        id,
        exitCode: 0,
        teamId: kShearAdmitTeamId,
      ),
      'self-signed',
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

  test('a self-signed certificate with the team OU is rejected', () {
    const team = 'SFCBP95595';
    final requirement = admitMacRequirement(team);
    expect(
      requirement,
      'anchor apple generic'
      ' and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */'
      ' and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */'
      ' and certificate leaf[subject.OU] = "SFCBP95595"',
    );
    expect(
      admitMacRequirementFailure(
        anchorAppleGeneric: true,
        developerIdIntermediate: true,
        developerIdLeaf: true,
        leafOu: team,
        teamId: team,
      ),
      isNull,
    );

    final dir = Directory.systemTemp.createTempSync('admit-self-signed');
    try {
      final made = Process.runSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        '${dir.path}/key.pem',
        '-out',
        '${dir.path}/cert.pem',
        '-days',
        '1',
        '-nodes',
        '-subj',
        '/OU=$team/CN=self-signed',
      ]);
      expect(made.exitCode, 0, reason: '${made.stderr}');
      final names = Process.runSync('openssl', [
        'x509',
        '-in',
        '${dir.path}/cert.pem',
        '-noout',
        '-subject',
        '-issuer',
        '-nameopt',
        'RFC2253',
      ]);
      expect(names.exitCode, 0, reason: '${names.stderr}');
      final lines = names.stdout.toString().trim().split('\n');
      expect(lines, hasLength(2));
      final subject = lines[0].replaceFirst(RegExp(r'^subject='), '').trim();
      final issuer = lines[1].replaceFirst(RegExp(r'^issuer='), '').trim();
      expect(subject, issuer);
      final selfSigned = issuer == subject;
      final ou = RegExp(r'(?:^|,)OU=([^,]+)').firstMatch(subject);
      expect(ou, isNotNull);
      expect(ou!.group(1), team);

      final der = Process.runSync(
        'openssl',
        ['x509', '-in', '${dir.path}/cert.pem', '-outform', 'DER'],
        stdoutEncoding: null,
      );
      expect(der.exitCode, 0, reason: '${der.stderr}');
      final bytes = Uint8List.fromList((der.stdout as List).cast<int>());
      expect(_derHasOid(bytes, kDevIdIntermediateOid), isFalse);
      expect(_derHasOid(bytes, kDevIdLeafOid), isFalse);
      expect(
        admitMacRequirementFailure(
          anchorAppleGeneric: !selfSigned,
          developerIdIntermediate: _derHasOid(bytes, kDevIdIntermediateOid),
          developerIdLeaf: _derHasOid(bytes, kDevIdLeafOid),
          leafOu: ou.group(1)!,
          teamId: team,
        ),
        'self-signed',
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

List<int> _derOid(String oid) {
  final parts = oid.split('.').map(int.parse).toList();
  final out = <int>[40 * parts[0] + parts[1]];
  for (final part in parts.skip(2)) {
    final stack = <int>[part & 0x7f];
    var value = part >> 7;
    while (value > 0) {
      stack.add((value & 0x7f) | 0x80);
      value >>= 7;
    }
    for (var i = stack.length - 1; i >= 0; i--) {
      out.add(stack[i]);
    }
  }
  return out;
}

bool _derHasOid(List<int> der, String oid) {
  final needle = _derOid(oid);
  for (var i = 0; i + needle.length <= der.length; i++) {
    var found = true;
    for (var j = 0; j < needle.length; j++) {
      if (der[i + j] != needle[j]) {
        found = false;
        break;
      }
    }
    if (found) return true;
  }
  return false;
}
