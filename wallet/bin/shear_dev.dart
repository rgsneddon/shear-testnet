import 'dart:io';

import 'package:shear_wallet/shear_book_dev.dart';
import 'package:shear_wallet/shear_cli.dart';
import 'package:shear_wallet/shear_public_confirm.dart';
import 'package:shear_wallet/shear_session.dart';

/// Dev CLI. Refuses a product (release) or profile VM. No dart-define.
/// `dart compile exe` strips asserts, so this exits.
Future<void> main(List<String> args) async {
  const release = bool.fromEnvironment('dart.vm.product');
  const profile = bool.fromEnvironment('dart.vm.profile');
  if (release || profile) {
    stderr.writeln('shear-dev wallet refuses release mode');
    exit(1);
  }
  armWalletConnect();
  final out = StringBuffer();
  final err = StringBuffer();
  final code = await runShearCli(
    args,
    stdout: out,
    stderr: err,
    bookMagic: kBookMagic,
    expectedFingerprintSha: kDevFingerprintSha,
    sessionFile: ShearSession.storeForMagic(kBookMagic),
  );
  if (out.isNotEmpty) stdout.write(out);
  if (err.isNotEmpty) stderr.write(err);
  exit(code);
}
