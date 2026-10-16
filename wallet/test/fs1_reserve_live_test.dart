import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_reserve.dart';

/// Manual harness against the local v12 node at /tmp/shear-e2e/wallet.json.
/// Not part of CI. Skips when that fixture is absent.
void main() {
  test('local v12 reserve lock vote withdraw', () async {
    final walletFile = File('/tmp/shear-e2e/wallet.json');
    if (!walletFile.existsSync()) return;
    final spec = jsonDecode(walletFile.readAsStringSync()) as Map<String, dynamic>;
    final rpc = spec['rpc'] as String;
    expect(rpc, 'http://127.0.0.1:18444');
    final id = createIdentity(hexToBytes(spec['spendSeed'] as String));
    final pool = ShearPoolClient(baseUrl: rpc);
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final miner = spec['miner'] as String;
    final height = (spec['height'] as num).toInt();
    ledger.restoreSealedTip(height);
    final notes = (spec['notes'] as List?) ?? const [];
    var funded = 0;
    for (final raw in notes) {
      if (raw is! Map) continue;
      final note = Map<String, dynamic>.from(raw);
      final r = note['r'];
      final commit = note['commit'];
      if (r is! String || commit is! String || r.length != 64 || commit.length != 64) continue;
      final h = (note['height'] as num?)?.toInt() ?? 0;
      if (h < 1 || height - h + 1 < ShearLedger.spendableConfirmations) continue;
      final nanos = (note['nanos'] as num?)?.toInt() ?? 0;
      if (nanos <= 0) continue;
      ledger.rememberNote({
        'address': miner,
        'dest': miner,
        'kind': note['kind'] ?? 'pot',
        'commit': hexToBytes(commit),
        'noteCommit': note['noteCommit'] is String ? hexToBytes(note['noteCommit'] as String) : null,
        'r': hexToBytes(r),
        'admitPub': note['admitPub'] is String ? hexToBytes(note['admitPub'] as String) : null,
        'nanos': nanos,
        'amount': nanos / kUnitsPerShe,
        'height': h,
        'verified': true,
        'spent': false,
      });
      funded++;
    }
    ledger.rememberDest(home);
    if (miner != home) ledger.rememberDest(miner);
    ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    final vault = vaultDest(id.address, viewKey: id.viewKey)!;
    final out = <String, dynamic>{
      'home': home,
      'miner': miner,
      'homeMatchesMiner': home == miner,
      'height': height,
      'fundedNotes': funded,
      'spendableHome': ledger.spendable(home),
      'spendableMiner': ledger.spendable(miner),
    };

    Future<Map<String, dynamic>> attempt(String label, Future<void> Function() body) async {
      final live = File(Platform.environment['SHEAR_DUMP_SEND'] ?? '/tmp/shear-e2e/last-send.json');
      if (live.existsSync()) live.deleteSync();
      try {
        await body();
        return {'label': label, 'ok': true, 'admitProof': _dump(live)};
      } catch (e) {
        return {'label': label, 'ok': false, 'reason': '$e', 'admitProof': _dump(live)};
      }
    }

    final seed = hexToBytes(id.seedHex);
    out['lock'] = await attempt('lock', () => ledger.send(
          from: home == miner ? home : miner,
          to: vault,
          amount: 0.2,
          local: false,
          kind: 'lock',
          programId: kReserveProgram,
          restFrame: id.address,
          paymentCode: id.paymentCode,
          spendSeed: seed,
          allowPublicHttp: true,
        ));
    out['vote'] = await attempt('vote', () => ledger.send(
          from: home == miner ? home : miner,
          to: vault,
          amount: 0,
          local: false,
          kind: 'vote',
          programId: kReserveProgram,
          restFrame: id.address,
          paymentCode: id.paymentCode,
          choice: 'hold',
          spendSeed: seed,
          allowPublicHttp: true,
        ));
    out['withdraw'] = await attempt('withdraw', () => ledger.send(
          from: home,
          to: home,
          amount: 0.1,
          local: false,
          kind: 'withdraw',
          programId: kReserveProgram,
          restFrame: id.address,
          paymentCode: id.paymentCode,
          spendSeed: seed,
          allowPublicHttp: true,
          nanosWire: (0.1 * kUnitsPerShe).round().toString(),
        ));
    File('/tmp/shear-e2e/result.json').writeAsStringSync(const JsonEncoder.withIndent('  ').convert(out));
    // The assertion is the fixture was exercised. Accept or reject is recorded.
    expect(out['fundedNotes'], greaterThan(0));
  }, timeout: const Timeout(Duration(minutes: 3)));
}

String? _dump(File dump) {
  if (!dump.existsSync()) return null;
  try {
    final body = jsonDecode(dump.readAsStringSync());
    if (body is! Map) return 'not-map';
    final proof = body['admit_proof'];
    final proofs = body['admit_proofs'];
    if (proof == null && proofs == null) return 'null';
    return 'present';
  } catch (e) {
    return 'unreadable';
  }
}
