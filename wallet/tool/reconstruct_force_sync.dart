import 'dart:io';

import 'package:shear_wallet/shear_ledger.dart';

/// Live hasher sync through shipped [ShearLedger.syncCredits].
/// One HTTP 504 on /balance is retried inside that path. A second 504 throws.
/// A file body is not a sync.
Future<void> main(List<String> args) async {
  const dest =
      'ssa1q4ws2yd6xsedd7q0drkeup2c9wvan4xmps3zcglnz65nqvakrngcyv6xuylekk0rza8uusg9uzfdcktz6a5hq94gmp5';
  final base = args.isNotEmpty ? args[0] : 'http://127.0.0.1:8088';
  final http = HttpClient()
    ..connectionTimeout = const Duration(seconds: 20)
    ..idleTimeout = const Duration(seconds: 20);
  final pool = ShearPoolClient(baseUrl: base, http: http);
  final ledger = ShearLedger(pool: pool);
  stdout.writeln('source=syncCredits');
  stdout.writeln('base=$base');
  try {
    await ledger.syncCredits(dest);
  } catch (e) {
    stderr.writeln('FAIL syncCredits $e');
    exitCode = 1;
    http.close(force: true);
    return;
  }
  final wrote = ledger.spendable(dest);
  final owedShown = ledger.owedTowardPi(dest);
  Map<String, dynamic> liveJson;
  try {
    liveJson = await pool.balance(dest);
  } catch (e) {
    if (!poolHttp504(e)) {
      stderr.writeln('FAIL compare balance $e');
      exitCode = 1;
      http.close(force: true);
      return;
    }
    liveJson = await pool.balance(dest);
  }
  final live = (liveJson['balance'] as num).toDouble();
  final owed = (liveJson['owedPi'] as num?)?.toDouble() ?? 0;
  final height = liveJson['height'];
  stdout.writeln('height=$height live=$live wrote=$wrote owedPi=$owed owedShown=$owedShown');
  if ((wrote - live).abs() > 1e-9) {
    stderr.writeln('FAIL syncCredits did not write the live hasher balance');
    exitCode = 1;
  } else if ((owedShown - owed).abs() > 1e-6) {
    stderr.writeln('FAIL owedPi was folded into the balance book');
    exitCode = 1;
  } else {
    stdout.writeln('syncCredits wrote live hasher balance; owedPi stayed display-only');
  }
  http.close(force: true);
}
