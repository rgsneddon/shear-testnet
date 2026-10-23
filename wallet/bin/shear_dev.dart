import 'dart:io';

import 'package:shear_wallet/shear_book_dev.dart';
import 'package:shear_wallet/shear_cli.dart';
import 'package:shear_wallet/shear_public_confirm.dart';
import 'package:shear_wallet/shear_session.dart';

/// Dev CLI. Refuses a product (release) VM. No dart-define.
Future<void> main(List<String> args) async {
  assert(!bool.fromEnvironment('dart.vm.product'), 'shear-dev wallet refuses release mode');
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
