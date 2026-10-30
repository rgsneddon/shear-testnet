import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';

import 'support/sealed_book.dart';

const _tip = 10;

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
      req.response.write('{"ok":true,"height":$_tip,"header":"$header"}');
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

/// A wallet holding one real sealed note of [nanos] on its home dest, mined
/// at height 1 with the tip at [_tip] (10 confirmations).
({ShearIdentity id, ShearLedger ledger, String home}) _book(
  int port,
  HttpClient http,
  int nanos,
) {
  final id = createIdentity();
  final seed = seedOf(id);
  final ledger = ShearLedger(
    pool: ShearPoolClient(baseUrl: 'http://127.0.0.1:$port', http: http),
  )..bindIdentity(id);
  ledger.spendSeed = seed;
  final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
  ledger.rememberNote(sealedNoteOn(home, seed, nanos, height: 1));
  ledger.noteLiveHeight(_tip);
  ledger.settleTo(_tip);
  ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
  return (id: id, ledger: ledger, home: home);
}

/// Spendable is what a send can use: the opened notes. The pool's balance
/// figure is read (and retried once on a 504) but never becomes Spendable.
void main() {
  test('syncCredits retries one 504, and Spendable stays the opened note, not the balance figure', () async {
    var hitsSeen = 0;
    final server = await _pool((req, hits) {
      hitsSeen = hits;
      if (hits == 1) {
        req.response.statusCode = 504;
        req.response.write('{"ok":false}');
        return;
      }
      req.response.statusCode = 200;
      req.response.write(jsonEncode({
        'ok': true,
        'balance': 9.5,
        'owedPi': 1.25,
        'confirmingPot': 1.25,
        'pending': 0,
        'height': _tip,
      }));
    });
    final http = HttpClient();
    const noteNanos = 2632704; // 0.00002632704 SHE
    final b = _book(server.port, http, noteNanos);
    expect((b.ledger.spendable(b.home) * kUnitsPerShe).round(), noteNanos);
    final wrote = await b.ledger.syncCredits(b.id.address, paymentCode: b.id.paymentCode);
    expect(hitsSeen, greaterThanOrEqualTo(2), reason: 'the 504 was retried');
    expect(b.ledger.spendable(b.home), closeTo(0.00002632704, 1e-12));
    expect(wrote, closeTo(0.00002632704, 1e-12));
    expect(
      b.ledger.spendableOwned(b.id.address, paymentCode: b.id.paymentCode),
      closeTo(0.00002632704, 1e-12),
      reason: 'the 9.5 SHE pool figure is not Spendable',
    );
    expect(b.ledger.owedTowardPi(b.id.address, paymentCode: b.id.paymentCode), closeTo(1.25, 1e-9));
    http.close(force: true);
    await server.close(force: true);
  });

  test('a second balance 504 fails syncCredits instead of keeping the old spendable as success', () async {
    final server = await _pool((req, hits) {
      req.response.statusCode = 504;
      req.response.write('{"ok":false,"hit":$hits}');
    });
    final http = HttpClient();
    final b = _book(server.port, http, 5 * kUnitsPerShe);
    // A remembered figure is not a coin; the note is.
    b.ledger.rememberSpendable(b.home, 7);
    expect(b.ledger.spendable(b.home), 5);
    await expectLater(
      b.ledger.syncCredits(b.id.address, paymentCode: b.id.paymentCode),
      throwsA(predicate((Object e) => poolHttp504(e))),
    );
    expect(b.ledger.spendable(b.home), 5);
    http.close(force: true);
    await server.close(force: true);
  });
}
