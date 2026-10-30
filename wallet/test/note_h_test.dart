import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_ristretto.dart';
import 'package:shear_wallet/shear_ctf.dart' show vaultDest;
import 'package:shear_wallet/shear_reserve.dart' show ShearReserve, postReserveDeposit;
import 'package:shear_wallet/shear_vault_reward.dart' show kPiSheNanos;

import 'support/sealed_book.dart';

void main() {
  test('note H is the consensus bpplus point', () {
    final hex = pointBytes(noteH).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    expect(hex, 'feea2914bda937d74acc1efa93bf1094f65ae709628a7aad9d1b913b6c80c301');
  });

  // A Vault lock is exactly one π leaf (Russell, 25 Oct 14:20, Corrections 1)
  // and its amount stays hidden: commit(π, blind) with a range proof under H
  // and no published value. Consensus (reserveAction, verifyReservePayout)
  // decodes the posted lock; a body that publishes its value is bad_amount.
  Map<String, dynamic> check(Map<String, dynamic> tx, String tag) {
    final file = File('${Directory.systemTemp.path}${Platform.pathSeparator}shear-lock-$tag-$pid.json');
    file.writeAsStringSync(jsonEncode(tx, toEncodable: (o) => o is Uint8List ? o.toList() : o.toString()));
    addTearDown(() {
      try {
        file.deleteSync();
      } catch (_) {}
    });
    final repo = Directory.current.path.replaceAll('\\', '/').endsWith('/wallet')
        ? Directory.current.parent.path
        : Directory.current.path;
    final checked = Process.runSync(
      'node',
      ['tests/verify_lock_seal.mjs', file.path],
      workingDirectory: repo,
    );
    final got = jsonDecode(checked.stdout as String) as Map;
    return {...Map<String, dynamic>.from(got), 'exit': checked.exitCode, 'err': '${checked.stderr}'};
  }

  test('the posted π lock verifies under consensus H with its amount hidden', () async {
    final book = SealedBook.fund([10 * kUnitsPerShe]);
    addTearDown(book.pool.close);
    final dest = vaultDest(book.id.address, viewKey: book.id.viewKey)!;
    final posted = await postReserveDeposit(
      ledger: book.ledger,
      reserve: ShearReserve(),
      restFrame: book.id.address,
      paymentCode: book.id.paymentCode,
      dest: dest,
      she: kPiSheNanos / kUnitsPerShe,
      depth: 0,
      spendSeed: book.seed,
      local: false,
      publicIpConsent: true,
    );
    expect(posted.posted, isTrue, reason: posted.remark);
    final body = book.pool.posts.single;
    expect(body['kind'], 'lock');
    expect(body.containsKey('nanos'), isFalse, reason: 'no plaintext amount beside the lock');
    final got = check(body, 'posted');
    expect(got['hidden'], true, reason: '$got');
    expect(got['sealOk'], true, reason: 'range proof under H on commit(π, blind): $got');
    expect(got['ok'], true, reason: '$got');
    expect(got['exit'], 0);
  });

  test('a lock that publishes its value is refused as bad_amount, π or 10 SHE', () {
    final vault = encodeDestAddress(Uint8List.fromList(List.filled(20, 9)));
    for (final nanos in [kPiSheNanos, (10 * kUnitsPerShe).round()]) {
      final sealed = compactSealedVout(sealedReserveVout(vault, nanos, 'lock'));
      expect((sealed['valueProof'] as Map)['v'], nanos);
      final got = check({
        'kind': 'lock',
        'to': vault,
        'nanos': nanos,
        'vout': [sealed],
      }, 'published-$nanos');
      expect(got['hidden'], false);
      expect(got['sealOk'], true, reason: 'the published seal itself opens under H: $got');
      expect(got['ok'], false);
      expect(got['reason'], 'bad_amount');
      expect(got['exit'], 1);
    }
  });
}
