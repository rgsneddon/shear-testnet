import 'dart:io';

import 'package:shear_wallet/shear_cli.dart';

/// Headless Shear wallet. Same Closure backup as the GUI (`shewall.bin`).
Future<void> main(List<String> args) async {
  final out = StringBuffer();
  final err = StringBuffer();
  final code = await runShearCli(args, stdout: out, stderr: err);
  if (out.isNotEmpty) stdout.write(out);
  if (err.isNotEmpty) stderr.write(err);
  exit(code);
}
