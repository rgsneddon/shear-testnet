import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';

Future<HttpServer> _pool(void Function(HttpRequest req, int balanceHits) onBalance) async {
  var balanceHits = 0;
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((req) {
    final path = req.uri.path;
    final header = 'ab' * 32;
    if (path.contains('balance')) {
      balanceHits += 1;
      onBalance(req, balanceHits);
    } else if (path.contains('stats')) {
      req.response.statusCode = 200;
      req.response.write('{"ok":true,"height":1,"header":"$header"}');
    } else if (path.contains('headers')) {
      req.response.statusCode = 200;
      req.response.write('{"ok":true,"headers":[{"height":1,"header":"$header"}]}');
    } else {
      req.response.statusCode = 200;
      req.response.write('{"ok":true,"notes":[],"txs":[]}');
    }
    req.response.close();
  });
  return server;
}

void main() {
  test('syncCredits retries one 504 then writes the live balance', () async {
    final id = createIdentity();
    final home = (ShearLedger()..bindIdentity(id)).homeDest(id.address, paymentCode: id.paymentCode);
    final server = await _pool((req, hits) {
      if (hits == 1) {
        req.response.statusCode = 504;
        req.response.write('{"ok":false}');
        return;
      }
      req.response.statusCode = 200;
      req.response.write(jsonEncode({
        'ok': true,
        'balance': 0.00002632704,
        'owedPi': 1.25,
        'confirmingPot': 1.25,
        'pending': 0,
        'height': 1,
      }));
    });
    final http = HttpClient();
    final ledger = ShearLedger(
      pool: ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: http),
    )..bindIdentity(id);
    final wrote = await ledger.syncCredits(id.address, paymentCode: id.paymentCode);
    expect(ledger.spendable(home), closeTo(0.00002632704, 1e-12));
    expect(wrote, closeTo(0.00002632704, 1e-12));
    expect(ledger.owedTowardPi(id.address, paymentCode: id.paymentCode), closeTo(1.25, 1e-9));
    http.close(force: true);
    await server.close(force: true);
  });

  test('a second balance 504 fails syncCredits instead of keeping the old spendable as success', () async {
    final id = createIdentity();
    final home = (ShearLedger()..bindIdentity(id)).homeDest(id.address, paymentCode: id.paymentCode);
    final server = await _pool((req, hits) {
      req.response.statusCode = 504;
      req.response.write('{"ok":false,"hit":$hits}');
    });
    final http = HttpClient();
    final ledger = ShearLedger(
      pool: ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: http),
    )..bindIdentity(id);
    ledger.rememberSpendable(home, 5);
    await expectLater(
      ledger.syncCredits(id.address, paymentCode: id.paymentCode),
      throwsA(predicate((Object e) => poolHttp504(e))),
    );
    expect(ledger.spendable(home), 5);
    http.close(force: true);
    await server.close(force: true);
  });
}
