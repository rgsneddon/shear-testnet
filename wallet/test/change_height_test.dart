import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_ristretto.dart';

// Gate 3 (Russell 26 Oct): Spendable needs a block height. This wallet's own
// change has none until a chain read gives it one, so: the pool notes path
// reads a held note again until it has a height; until then the change is
// Pending on home and the send planner does not count it; once it has its
// height and confirmations it is sendable.

int _nanos() => (kBlockPotShe * kUnitsPerShe).round() * kPoolFeeBps ~/ 10000;

/// A note whose claimed v opens, as the pool lists it: an FS-1 leaf this
/// wallet's seed admits.
Map<String, dynamic> _listed(String dest, Uint8List seed, {int? height}) {
  final d20 = hash20FromAddress(dest)!;
  final v = _nanos();
  final blind = randomScalar();
  final value = proveValue(v, blind);
  final nc = noteCommitOfDest20(d20);
  return {
    'dest': dest,
    'kind': 'pool-fee',
    'noteCommit': nc,
    'commit': value['C'],
    'admitPub': pointBytes(admitPub(admitScalarFromSeed(seed, {'kind': 'pool-fee', 'noteCommit': nc, 'commit': value['C']}))),
    'r': scalarBytes(blind),
    'valueProof': {'R': value['R'], 'z': value['z'], 'v': v},
    if (height != null) 'height': height,
  };
}

/// The same note as this wallet holds it right after posting: verified, no height.
Map<String, dynamic> _held(Map<String, dynamic> listed) {
  final held = Map<String, dynamic>.from(listed)..remove('height');
  return {
    ...held,
    'address': listed['dest'],
    'nanos': _nanos(),
    'amount': _nanos() / kUnitsPerShe,
    'verified': true,
    'proofChecked': true,
    'verifiedNanos': _nanos(),
  };
}

dynamic _jsonSafe(dynamic v) {
  if (v is List<int>) return v.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  if (v is Map) return {for (final e in v.entries) e.key.toString(): _jsonSafe(e.value)};
  if (v is List) return v.map(_jsonSafe).toList();
  return v;
}

void main() {
  test('own change: Pending until mined, re-read on the pool path, then sendable', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    Map<String, dynamic>? listed;
    server.listen((req) async {
      try {
        await req.drain<void>();
        req.response.headers.contentType = ContentType.json;
        final path = req.uri.path;
        if (path == '/notes' || path == '/api/wallet/notes') {
          req.response.write(jsonEncode(_jsonSafe({'ok': true, 'notes': [if (listed != null) listed]})));
        } else if (path == '/stats' || path == '/api/stats') {
          req.response.write(jsonEncode({'ok': true, 'height': 9}));
        } else if (path == '/api/wallet/balance' || path == '/balance') {
          req.response.write(jsonEncode({'ok': true, 'balance': 0}));
        } else {
          req.response.statusCode = 404;
          req.response.write('{"ok":false}');
        }
        await req.response.close();
      } catch (_) {
        try {
          req.response.statusCode = 500;
          await req.response.close();
        } catch (_) {}
      }
    });
    final id = createIdentity();
    final ledger = ShearLedger(
      pool: ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}'),
    )..bindIdentity(id);
    ledger.restoreSealedTip(9);
    ledger.settleTo(9);
    final dest = ledger.syncDests(id.address, paymentCode: id.paymentCode).first;
    final mined = _listed(dest, ledger.spendSeed!, height: 1);
    final she = _nanos() / kUnitsPerShe;

    // Posted change: verified, no height.
    ledger.rememberNote(_held(mined));
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(0, 1e-12));
    expect(ledger.unminedChangeShe(id.address, paymentCode: id.paymentCode), closeTo(she, 1e-9));
    expect(ledger.destCoveringSpend(id.address, paymentCode: id.paymentCode, needShe: she / 2), isNull,
        reason: 'the planner counts what Spendable counts');
    expect(ledger.fundsRefusal(she / 2).message, kErrChangePending);

    // The pool lists the mined copy, with its height. The wallet already holds
    // the commit, but a held note with no height is read again.
    listed = mined;
    debugNotesOpenedThisScan = -1;
    final saw = await ledger.collateSpendNotes(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      hostHeight: 9,
    );
    expect(saw, isTrue);
    expect(debugNotesOpenedThisScan, 1, reason: 'the heightless held note is read again');
    String hexOf(dynamic b) => b is List<int> ? b.map((x) => x.toRadixString(16).padLeft(2, '0')).join() : '$b';
    final want = hexOf(mined['commit'] as Uint8List);
    final note = ledger.notes.firstWhere((n) => hexOf(n['commit']) == want);
    expect(note['height'], 1);

    // With its height and confirmations the change is Spendable and sendable.
    expect(ledger.unminedChangeShe(id.address, paymentCode: id.paymentCode), closeTo(0, 1e-12));
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(she, 1e-9));
    expect(ledger.destCoveringSpend(id.address, paymentCode: id.paymentCode, needShe: she / 2), isNotNull);

    // A note that has its height is not read again.
    debugNotesOpenedThisScan = -1;
    await ledger.collateSpendNotes(restFrame: id.address, paymentCode: id.paymentCode, hostHeight: 9);
    expect(debugNotesOpenedThisScan, 0);
  });
}
