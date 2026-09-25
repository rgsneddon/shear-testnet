import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_cli.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_session.dart';
import 'package:shear_wallet/shear_shewall.dart';
import 'package:shear_wallet/shear_vortex.dart';

void main() {
  test('CLI help lists every GUI surface including sign, vote, vort1, rewards, Closure', () async {
    final out = StringBuffer();
    final code = await runShearCli(['help'], stdout: out, stderr: StringBuffer());
    expect(code, 0);
    final text = out.toString();
    for (final cmd in kCliRootCommands) {
      expect(text.contains(cmd), isTrue, reason: 'help missing $cmd');
    }
    expect(kCliGuiCoverage.keys.toSet().containsAll(kCliRootCommands), isTrue);
    expect(text, contains('sign'));
    expect(text, contains('vote'));
    expect(text, contains('vort1'));
    expect(text, contains('rewards'));
    expect(text, contains('backup'));
    expect(text, contains('restore'));
    expect(text, contains('shear-v1'));
  });

  test('CLI nested --help for sign / vortex / reserve / rewards', () async {
    for (final cmd in ['sign', 'vortex', 'reserve', 'rewards', 'backup', 'restore']) {
      final out = StringBuffer();
      final code = await runShearCli([cmd, '--help'], stdout: out, stderr: StringBuffer());
      expect(code, 0, reason: cmd);
      expect(out.toString(), contains(cmd));
    }
  });

  test('CLI refuses shear-v1 (mainnet not cut)', () async {
    final err = StringBuffer();
    final code = await runShearCli(
      ['status', '--network', 'shear-v1'],
      stdout: StringBuffer(),
      stderr: err,
    );
    expect(code, 3);
    expect(err.toString(), contains('clock_wait'));
  });

  test('CLI create → dest → backup → restore uses the same shewall.bin as GUI', () async {
    final dir = Directory.systemTemp.createTempSync('shear-cli-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final store = File('${dir.path}/session.json');
    final pwFile = File('${dir.path}/pw')..writeAsStringSync('correct-horse');
    final confirm = File('${dir.path}/pw2')..writeAsStringSync('correct-horse');
    final out = StringBuffer();
    var code = await runShearCli([
      'create',
      '--store',
      store.path,
      '--password-file',
      pwFile.path,
      '--confirm-file',
      confirm.path,
    ], stdout: out, stderr: StringBuffer());
    expect(code, 0, reason: out.toString());
    expect(out.toString(), contains('she1'));

    final destOut = StringBuffer();
    code = await runShearCli([
      'dest',
      '--store',
      store.path,
      '--password-file',
      pwFile.path,
    ], stdout: destOut, stderr: StringBuffer());
    expect(code, 0);
    final dest = destOut.toString().trim();
    expect(dest.startsWith('ssa1'), isTrue);

    final backup = File('${dir.path}/shewall.bin');
    final bakOut = StringBuffer();
    code = await runShearCli([
      'backup',
      '--store',
      store.path,
      '--password-file',
      pwFile.path,
      '--out',
      backup.path,
    ], stdout: bakOut, stderr: StringBuffer());
    expect(code, 0, reason: bakOut.toString());
    expect(backup.existsSync(), isTrue);
    final raw = backup.readAsBytesSync();
    expect(raw[0], isNot(0x7b), reason: 'shewall.bin must not be JSON');
    expect(String.fromCharCodes(raw.take(shewallEncKind.length)), shewallEncKind);

    // GUI import path opens the CLI backup.
    final guiLedger = ShearLedger();
    final imported = await importEncryptedShewall(
      src: backup,
      password: 'correct-horse',
      ledger: guiLedger,
    );
    expect(imported.paymentCode, startsWith('she1'));
    expect(kBookMagic, 'shear-testnet-v5');

    final store2 = File('${dir.path}/session2.json');
    final restOut = StringBuffer();
    code = await runShearCli([
      'restore',
      '--store',
      store2.path,
      '--file',
      backup.path,
      '--password-file',
      pwFile.path,
    ], stdout: restOut, stderr: StringBuffer());
    expect(code, 0, reason: restOut.toString());
    expect(restOut.toString(), contains(imported.paymentCode));

    final idOut = StringBuffer();
    code = await runShearCli([
      'id',
      '--store',
      store2.path,
      '--password-file',
      pwFile.path,
    ], stdout: idOut, stderr: StringBuffer());
    expect(code, 0);
    expect(idOut.toString().trim(), imported.paymentCode);
  });

  test('CLI dest prints homeDest twice for the same store', () async {
    final dir = Directory.systemTemp.createTempSync('shear-cli-dest-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final store = File('${dir.path}/session.json');
    final pwFile = File('${dir.path}/pw')..writeAsStringSync('correct-horse');
    final confirm = File('${dir.path}/pw2')..writeAsStringSync('correct-horse');
    final created = StringBuffer();
    var code = await runShearCli([
      'create',
      '--store',
      store.path,
      '--password-file',
      pwFile.path,
      '--confirm-file',
      confirm.path,
    ], stdout: created, stderr: StringBuffer());
    expect(code, 0, reason: created.toString());

    Future<String> destOnce() async {
      final destOut = StringBuffer();
      final destCode = await runShearCli([
        'dest',
        '--store',
        store.path,
        '--password-file',
        pwFile.path,
      ], stdout: destOut, stderr: StringBuffer());
      expect(destCode, 0, reason: destOut.toString());
      return destOut.toString().trim();
    }

    final first = await destOnce();
    final second = await destOnce();
    expect(first.startsWith('ssa1'), isTrue);
    expect(second, first);

    final session = ShearSession(store: store);
    final id = await session.unlock('correct-horse');
    final ledger = ShearLedger()..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    expect(first, home);

    final recOut = StringBuffer();
    code = await runShearCli([
      'receive',
      '--store',
      store.path,
      '--password-file',
      pwFile.path,
    ], stdout: recOut, stderr: StringBuffer());
    expect(code, 0, reason: recOut.toString());
    final received = recOut.toString().trim();
    expect(received.startsWith('ssa1'), isTrue);
    expect(received, isNot(home));
    expect(await destOnce(), home);
  });

  test('v1 shewall.bin still restores (Closure migrate) then reseals v2', () async {
    final dir = Directory.systemTemp.createTempSync('shear-cli-v1-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final id = createIdentity();
    final ledger = ShearLedger();
    ledger.viewSecret = id.viewKey;
    final packed = exportShewall(identity: id, ledger: ledger, vortices: const [reserveVortice]);
    final v1 = await sealShewallBinPbkdf2(packed, 'correct-horse');
    expect(shewallNeedsMigrate(v1), isTrue);
    final src = File('${dir.path}/old.bin')..writeAsBytesSync(v1);

    final opened = await openShewallBin(v1, 'correct-horse');
    final restored = importShewall(opened, ShearLedger());
    expect(restored.paymentCode, id.paymentCode);

    final dest = File('${dir.path}/new.bin');
    await exportEncryptedShewall(
      identity: restored,
      ledger: ShearLedger(),
      password: 'correct-horse',
      dest: dest,
    );
    final v2 = dest.readAsBytesSync();
    expect(shewallNeedsMigrate(v2), isFalse);
    final again = await importEncryptedShewall(src: dest, password: 'correct-horse', ledger: ShearLedger());
    expect(again.paymentCode, id.paymentCode);

    final store = File('${dir.path}/s.json');
    final pw = File('${dir.path}/pw')..writeAsStringSync('correct-horse');
    final out = StringBuffer();
    final code = await runShearCli([
      'restore',
      '--store',
      store.path,
      '--file',
      src.path,
      '--password-file',
      pw.path,
    ], stdout: out, stderr: StringBuffer());
    expect(code, 0, reason: out.toString());
  });

  test('GUI exportEncryptedShewall file restores via CLI', () async {
    final dir = Directory.systemTemp.createTempSync('shear-cli-gui-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final id = createIdentity();
    final ledger = ShearLedger();
    ledger.viewSecret = id.viewKey;
    final dest = File('${dir.path}/shewall.bin');
    await exportEncryptedShewall(
      identity: id,
      ledger: ledger,
      password: 'correct-horse',
      dest: dest,
      vortices: const [reserveVortice],
    );
    final store = File('${dir.path}/session.json');
    final pw = File('${dir.path}/pw')..writeAsStringSync('correct-horse');
    final out = StringBuffer();
    final code = await runShearCli([
      'restore',
      '--store',
      store.path,
      '--file',
      dest.path,
      '--password-file',
      pw.path,
    ], stdout: out, stderr: StringBuffer());
    expect(code, 0, reason: out.toString());
    expect(out.toString(), contains(id.paymentCode));
  });
}
