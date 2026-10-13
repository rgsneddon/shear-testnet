import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_session.dart';

/// Spendable after a remembered vault principal, for any note sum and any
/// principal in that sum. The selector is usableSpendable / send, not paint.
void main() {
  final noteSizes = <int>[
    1,
    1000,
    kUnitsPerShe,
    kUnitsPerShe * 2 + 17,
    5 * kUnitsPerShe,
  ];

  test('remembered reserve cuts the selector for any principal', () async {
    final payee = createIdentity();
    final payeeHome = (ShearLedger()..bindIdentity(payee))
        .homeDest(payee.address, paymentCode: payee.paymentCode);
    for (final noteNanos in noteSizes) {
      final principals = <int>{
        0,
        if (noteNanos > 1) 1,
        if (noteNanos > 2) noteNanos ~/ 2,
        if (noteNanos > 1) noteNanos - 1,
        noteNanos,
      };
      for (final principal in principals) {
        final id = createIdentity();
        final ledger = _openedBook(id, noteNanos);
        final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
        final gross = ledger.spendableOwned(id.address, paymentCode: id.paymentCode);
        expect(gross, closeTo(noteNanos / kUnitsPerShe, 1e-12), reason: 'gross $noteNanos');
        final vault = vaultDest(id.address, viewKey: id.viewKey);
        expect(vault, isNotNull);
        final reserve = ShearReserve();
        reserve.installRemembered(ledger, {
          'dest': vault,
          'staked': principal,
          'idle': 0,
        });
        final leftNanos = noteNanos - principal;
        final leftShe = leftNanos / kUnitsPerShe;
        expect(
          ledger.usableSpendable(home),
          closeTo(leftShe, 1e-12),
          reason: 'usable notes $noteNanos principal $principal',
        );
        expect(
          ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
          closeTo(leftShe, 1e-12),
          reason: 'owned notes $noteNanos principal $principal',
        );
        if (principal > 0) {
          await expectLater(
            ledger.send(
              from: home,
              to: payeeHome,
              amount: noteNanos / kUnitsPerShe,
              restFrame: id.address,
              paymentCode: id.paymentCode,
            ),
            throwsA(
              isA<StateError>().having((e) => e.message, 'message', 'insufficient'),
            ),
            reason: 'send of the gross notes $noteNanos principal $principal',
          );
        }
      }
    }
  });

  test('a young note stays immature and a stats total is not this wallet', () async {
    final id = createIdentity();
    const mature = 2 * kUnitsPerShe;
    const young = 3 * kUnitsPerShe;
    final ledger = _openedBook(id, mature);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    expect(ledger.bookTip, greaterThanOrEqualTo(ShearLedger.spendableConfirmations));
    final proofs = ledger.exportOpenedProofs();
    ledger.rememberNote({
      'address': home,
      'dest': home,
      'kind': 'pool-fee',
      'commit': Uint8List.fromList(List<int>.filled(32, 9)),
      'amount': young / kUnitsPerShe,
      'height': ledger.bookTip,
      'verified': true,
      'proofChecked': true,
      'verifiedNanos': young,
      'proofKey': 'young|tip',
    });
    proofs.add({'k': 'young|tip', 'n': '$young'});
    ledger.restoreOpenedProofs(proofs);
    final gross = ledger.spendableOwned(id.address, paymentCode: id.paymentCode);
    expect(gross, closeTo(mature / kUnitsPerShe, 1e-12));
    ledger.vaultLockedNanos = mature * 10;
    expect(
      ledger.usableSpendable(home),
      closeTo(mature / kUnitsPerShe, 1e-12),
      reason: 'reserve total paint is not this wallet',
    );
    final vault = vaultDest(id.address, viewKey: id.viewKey)!;
    ShearReserve().installRemembered(ledger, {
      'dest': vault,
      'staked': kUnitsPerShe,
      'idle': 0,
    });
    expect(
      ledger.usableSpendable(home),
      closeTo((mature - kUnitsPerShe) / kUnitsPerShe, 1e-12),
    );
    ledger.vaultLockedNanos = 0;
    expect(
      ledger.usableSpendable(home),
      closeTo((mature - kUnitsPerShe) / kUnitsPerShe, 1e-12),
      reason: 'a thin stats zero does not restore spendable',
    );
  });

  test('blank fork clears the hold and a later ancestry flag does not revive it', () {
    final id = createIdentity();
    const noteNanos = 4 * kUnitsPerShe;
    final ledger = _openedBook(id, noteNanos);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final vault = vaultDest(id.address, viewKey: id.viewKey)!;
    ShearReserve().installRemembered(ledger, {
      'dest': vault,
      'staked': noteNanos,
      'idle': 0,
    });
    expect(ledger.usableSpendable(home), closeTo(0, 1e-12));
    ledger.applyVaultSeal({
      'blank_fork': true,
      'vault_seal_ancestry': false,
    });
    expect(ledger.usableSpendable(home), closeTo(noteNanos / kUnitsPerShe, 1e-12));
    ledger.applyVaultSeal({
      'blank_fork': false,
      'vault_seal_ancestry': true,
    });
    expect(ledger.usableSpendable(home), closeTo(noteNanos / kUnitsPerShe, 1e-12));
  });

  test('credit follow keeps any principal, including one above 2^53', () async {
    const above = 9007199254740993;
    final principals = <int>[1, kUnitsPerShe ~/ 3, kUnitsPerShe, above];
    for (final principal in principals) {
      final id = createIdentity();
      final noteNanos = principal > kUnitsPerShe * 5 ? kUnitsPerShe * 5 : principal;
      final ledger = _openedBook(id, noteNanos == 0 ? 1 : noteNanos);
      final vault = vaultDest(id.address, viewKey: id.viewKey)!;
      if (principal <= noteNanos) {
        ShearReserve().installRemembered(ledger, {
          'dest': vault,
          'staked': principal,
          'idle': 0,
        });
      } else {
        ledger.bindSnapshotHold(vault, principal);
      }
      final spec = ledger.exportCreditFollow(
        restFrame: id.address,
        paymentCode: id.paymentCode,
        full: true,
      );
      final held = Map<String, dynamic>.from(spec['reserveHeld'] as Map);
      expect(held.values.single.toString(), '$principal');
      final fresh = ShearLedger();
      fresh.installCreditFollow(spec);
      final again = fresh.exportCreditFollow(
        restFrame: id.address,
        paymentCode: id.paymentCode,
        full: true,
      );
      final heldAgain = Map<String, dynamic>.from(again['reserveHeld'] as Map);
      expect(heldAgain.values.single.toString(), '$principal');
      expect(
        selectionHoldNanos(
          lockDebits: [BigInt.one],
          reservePrincipals: [BigInt.parse(heldAgain.values.single.toString())],
        ),
        '$principal',
      );
      final biggerPending = BigInt.parse('$principal') + BigInt.one;
      expect(
        selectionHoldNanos(
          lockDebits: [biggerPending],
          reservePrincipals: [BigInt.parse('$principal')],
        ),
        biggerPending.toString(),
      );
      if (principal <= noteNanos) {
        final home = fresh.homeDest(id.address, paymentCode: id.paymentCode);
        expect(
          fresh.usableSpendable(home),
          closeTo((noteNanos - principal) / kUnitsPerShe, 1e-9),
          reason: 'follow usable $principal',
        );
      }
    }
  });

  test('shewall import and a no-chain follow keep the snapshot hold', () async {
    final id = createIdentity();
    const noteNanos = 4 * kUnitsPerShe + 1000;
    final source = _openedBook(id, noteNanos);
    final saved = source.exportNotesForSession();
    final vault = vaultDest(id.address, viewKey: id.viewKey)!;
    const principal = 2 * kUnitsPerShe + 1;
    final packed = exportShewall(
      identity: id,
      ledger: source,
      reserveSnapshot: {
        'dest': vault,
        'staked': principal,
        'idle': 0,
      },
    );
    final fresh = ShearLedger();
    final reserve = ShearReserve();
    final id2 = importShewall(packed, fresh, reserve: reserve);
    expect(id2.address, id.address);
    expect(reserve.portal(vault).nanos, principal);
    fresh.bindIdentity(id2);
    fresh.restoreSealedTip(9);
    fresh.restoreSessionNotes(saved, covered: 9, paymentCode: id2.paymentCode);
    final home = fresh.homeDest(id2.address, paymentCode: id2.paymentCode);
    expect(
      fresh.usableSpendable(home),
      closeTo((noteNanos - principal) / kUnitsPerShe, 1e-9),
    );
    await fresh.followOffUi(
      restFrame: id2.address,
      paymentCode: id2.paymentCode,
      full: false,
      chain: false,
    );
    expect(
      fresh.usableSpendable(home),
      closeTo((noteNanos - principal) / kUnitsPerShe, 1e-9),
    );
  });
}

ShearLedger _openedBook(ShearIdentity id, int noteNanos) {
  final ledger = ShearLedger()..bindIdentity(id);
  final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
  final commit = Uint8List.fromList(List<int>.filled(32, noteNanos & 255));
  commit[1] = (noteNanos >> 8) & 255;
  final key = 'hold|$noteNanos';
  ledger.rememberNote({
    'address': home,
    'dest': home,
    'kind': 'pool-fee',
    'commit': commit,
    'amount': noteNanos / kUnitsPerShe,
    'height': 1,
    'verified': true,
    'proofChecked': true,
    'verifiedNanos': noteNanos,
    'proofKey': key,
  });
  ledger.restoreOpenedProofs([
    {'k': key, 'n': '$noteNanos'},
  ]);
  final saved = ledger.exportNotesForSession();
  final fresh = ShearLedger()..bindIdentity(id);
  fresh.restoreSealedTip(9);
  fresh.restoreSessionNotes(saved, covered: 9, paymentCode: id.paymentCode);
  return fresh;
}
