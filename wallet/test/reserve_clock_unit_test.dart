import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_reserve.dart';

void main() {
  test('a positive epoch start ignores a later no-clock row', () {
    final alice = createIdentity();
    final va = vaultDest(alice.address, viewKey: alice.viewKey)!;
    final r = ShearReserve();
    const start = 1700000000000;
    expect(
      r.deposit(dest: va, she: kPiShe, nowMs: start, noteIsPrincipal: true),
      isNull,
    );
    expect(r.epochStartMs, start);
    expect(
      r.deposit(dest: va, she: 1, nowMs: 0, noteIsPrincipal: true),
      isNull,
    );
    expect(r.portal(va).deposits.last.atMs, 0);
    r.reanchorVerifiedClock(start + 8000);
    expect(r.epochStartMs, start);
    expect(r.epochs.single.startMs, start);
    expect(r.portal(va).deposits.first.atMs, start);
    expect(r.portal(va).deposits.last.atMs, 0);
    r.reanchorVerifiedClock(0);
    expect(r.epochStartMs, start);
    expect(r.portal(va).deposits.last.atMs, 0);
  });

  test('postReserveDeposit with no clock keeps the principal and hides Withdraw', () async {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final vault = vaultDest(id.address, viewKey: id.viewKey)!;
    expect(ledger.verifiedMedianTimeMs, isNull);
    ledger.rememberNote({
      'address': home,
      'dest': home,
      'verified': true,
      'height': 1,
      'amount': 1.0,
      'nanos': kUnitsPerShe,
      'commit': Uint8List(32)..[0] = 4,
      'r': Uint8List(32)..[0] = 5,
    });
    ledger.rememberDest(home);
    ledger.restoreSealedTip(20);
    ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    final reserve = ShearReserve();
    final posted = await postReserveDeposit(
      ledger: ledger,
      reserve: reserve,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      dest: vault,
      she: 0.4,
      depth: 0,
      spendSeed: hexToBytes(id.seedHex),
      local: true,
    );
    expect(posted.posted, isTrue, reason: posted.remark);
    expect(reserve.epochStartMs, 0);
    final row = reserve.portal(vault).deposits.single;
    expect(row.noteIsPrincipal, isTrue);
    expect(row.atMs, 0);
    expect(reserve.legacyWithdrawVisible(vault), isFalse);
  });

  test('a second compact of a sealed lock keeps the hex commit', () {
    final id = createIdentity();
    final vault = vaultDest(id.address, viewKey: id.viewKey)!;
    final sealed = compactSealedVout(sealedReserveVout(vault, kUnitsPerShe, 'lock'));
    expect(sealed['commit'], isA<Uint8List>());
    String hexOf(Object? raw) =>
        (raw as Uint8List).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final again = compactSealedVout({
      ...sealed,
      'commit': hexOf(sealed['commit']),
      'noteCommit': hexOf(sealed['noteCommit']),
    });
    expect(again['commit'], isA<Uint8List>());
    expect(hexOf(again['commit']), hexOf(sealed['commit']));
    expect(again['noteCommit'], isNotNull);
    expect(again['address'], vault);
    expect(again['kind'], 'lock');
  });

  test('reserve lock keeps the vin dest that the signature covers', () async {
    final id = createIdentity();
    final seed = hexToBytes(id.seedHex);
    final posted = <Map<String, dynamic>>[];
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      final raw = await utf8.decoder.bind(req).join();
      if (req.method == 'POST' && req.uri.path == '/api/wallet/send' && raw.isNotEmpty) {
        posted.add(Map<String, dynamic>.from(jsonDecode(raw) as Map));
      }
      req.response.headers.contentType = ContentType.json;
      if (req.uri.path == '/api/mempoolPressure') {
        req.response.write(jsonEncode({'ok': true, 'depth': 0}));
      } else if (req.uri.path == '/api/wallet/send') {
        req.response.write(jsonEncode({
          'ok': true,
          'tx': {'id': 'lock-vin', 'kind': 'lock', 'confirmed': false},
        }));
      } else {
        req.response.write(jsonEncode({'ok': true}));
      }
      await req.response.close();
    });
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}');
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    final from = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final vault = vaultDest(id.address, viewKey: id.viewKey)!;
    ledger.confirmRound(address: from, pot: 2, height: 1);
    ledger.settleTo(1 + ShearLedger.spendableConfirmations);
    await ledger.send(
      from: from,
      to: vault,
      amount: 0.2,
      kind: 'lock',
      programId: kReserveProgram,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      spendSeed: seed,
    );
    expect(posted, hasLength(1));
    final vin = Map<String, dynamic>.from((posted.single['vin'] as List).first as Map);
    expect(vin['address'], from);
    expect(vin['dest20'], isNotNull);
    final stripped = flowPostHex(<String, dynamic>{
      'vin': <Map<String, dynamic>>[vin],
      'vout': posted.single['vout'],
    });
    final again = Map<String, dynamic>.from((stripped['vin'] as List).first as Map);
    expect(again.containsKey('address'), isFalse);
    expect(again.containsKey('dest20'), isFalse);
  });

  test('reserve wire keeps the admit proof and does not strip the vin dest', () {
    final blob = Uint8List.fromList([0xf1, 1, 2, 3]);
    final cTilde = Uint8List(32)..[0] = 9;
    final proof = <String, dynamic>{
      'v': 3,
      'blob': blob,
      'cTilde': cTilde,
      'spendTag': Uint8List(32)..[0] = 4,
    };
    final vin = <Map<String, dynamic>>[
      {'address': 'ssa1qexample', 'dest20': Uint8List(20)..[0] = 7, 'commit': cTilde},
    ];
    final wire = reserveWireBody(
      vin: vin,
      vout: <Map<String, dynamic>>[
        {'kind': 'lock'},
      ],
      admitProof: proof,
    );
    final kept = Map<String, dynamic>.from((wire['vin'] as List).first as Map);
    expect(kept['address'], 'ssa1qexample');
    expect(kept['dest20'], isNotNull);
    final posted = Map<String, dynamic>.from(wire['admitProof'] as Map);
    expect(posted['blob'], 'f1010203');
    expect(posted['cTilde'], isA<String>());
    expect((posted['cTilde'] as String).length, 64);
  });
}
