import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_session.dart';

import 'support/sealed_book.dart';

void main() {
  test('spendable is the opened notes, and a smaller reserve deposit can use it', () async {
    final id = createIdentity();
    final seed = seedOf(id);
    final ledger = ShearLedger()..bindIdentity(id);
    ledger.spendSeed = seed;
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    // One real opened note (commit, note commit, blind, range proof, admit
    // key) of 4 SHE. A lock is exactly one π leaf (4e1ea9bc, 26 Oct), so the
    // smaller deposit is π, and 4 SHE covers π plus its levy.
    ledger.rememberNote(sealedNoteOn(home, seed, _noteNanos, height: 1));
    ledger.restoreSealedTip(20);
    ledger.rememberDest(home);
    ledger.rememberNodeChain(history: [
      {
        'kind': 'coinbase',
        'dest': home,
        'amount': 5.0,
        'height': 1,
      },
    ]);
    ledger.creditKnownNodeLands();
    ledger.settleTo(20);
    ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);

    const noteShe = _noteNanos / kUnitsPerShe;
    final owned = ledger.spendableOwned(id.address, paymentCode: id.paymentCode);
    expect(owned, closeTo(noteShe, 1e-9));
    expect(ledger.spendable(home), closeTo(noteShe, 1e-9));
    expect(ledger.usableSpendable(home), closeTo(noteShe, 1e-9));

    final cover = planLockFunding(
      ledger,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      needShe: kPiSheNanos / kUnitsPerShe,
    );
    expect(cover.have, closeTo(noteShe, 1e-9));
    expect(lockFundingShortfall(cover), isEmpty);

    final over = planLockFunding(
      ledger,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      needShe: 5,
    );
    expect(over.have, closeTo(noteShe, 1e-9));
    expect(lockFundingShortfall(over), contains('Not enough Continuum spendable'));

    final dest = vaultDest(id.address, viewKey: id.viewKey)!;
    final posted = await postReserveDeposit(
      ledger: ledger,
      reserve: ShearReserve(),
      restFrame: id.address,
      paymentCode: id.paymentCode,
      dest: dest,
      she: kPiSheNanos / kUnitsPerShe,
      depth: 0,
      spendSeed: hexToBytes(id.seedHex),
      local: true,
    );
    expect(posted.remark, isNot(contains('Not enough Continuum spendable')));
    expect(posted.posted, isTrue, reason: posted.remark);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), lessThan(noteShe));
  });

  test('unopened node rows and pool figures are not spendable', () async {
    final id = createIdentity();
    final payee = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final to = (ShearLedger()..bindIdentity(payee))
        .homeDest(payee.address, paymentCode: payee.paymentCode);
    expect(to, isNot(home));
    ledger.rememberDest(home);
    ledger.rememberNodeChain(
      notes: [
        {
          'dest': home,
          'kind': 'coinbase',
          'height': 1,
          'valueProof': {'v': 5 * kUnitsPerShe},
        },
      ],
      history: [
        {
          'kind': 'coinbase',
          'dest': home,
          'amount': 4.0,
          'height': 2,
        },
      ],
    );
    ledger.restoreSealedTip(20);
    ledger.creditKnownNodeLands();
    ledger.settleTo(20);
    ledger.applyPoolSnapshot(
      home,
      {'balance': 9.0, 'pending': 1.0, 'owedPi': 3.0},
      beforeHeight: 20,
      tipSealed: 20,
    );
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
    expect(ledger.usableSpendable(home), 0);
    // No note opened, so there is nothing to spend yet: the send waits for a
    // sealed note (kErrNoSealedNote) and never draws on the rows or the pool
    // figure. It is not a balance shortfall either.
    await expectLater(
      ledger.send(from: home, to: to, amount: 0.01, local: true),
      throwsA(
        isA<StateError>().having((e) => e.message, 'message', kErrNoSealedNote),
      ),
    );
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
  });

  test('Verifying follow reads the session in the worker and does not encode notes on the caller', () async {
    final dir = Directory.systemTemp.createTempSync('shear-follow-');
    addTearDown(() => dir.deleteSync(recursive: true));
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    await session.setPassword('test-pass-1');
    final id = session.identity!;
    final ledger = ShearLedger()..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberNote({
      'address': home,
      'dest': home,
      'verified': true,
      'height': 1,
      'amount': 3,
      'commit': Uint8List(32)..[0] = 9,
      'r': Uint8List(32)..[0] = 8,
    });
    final caller = identityHashCode(Isolate.current).toString();
    await ledger.followOffUi(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      full: false,
      sessionPath: session.store.path,
      sessionPassword: session.password,
    );
    expect(debugLastFollowSpecKeys, contains('sessionPath'));
    expect(debugLastFollowSpecKeys, isNot(contains('notes')));
    expect(debugLastFollowSpecKeys, isNot(contains('txs')));
    expect(debugCreditFollowStamp, isNot(caller));
    expect(debugCreditFollowKind, 'balances');
    final main = File('lib/main.dart').readAsStringSync();
    expect(main, contains('sessionPath: session.store.path'));
    expect(main, isNot(contains(
      'ledger.recheckRestFrameSpendable(id!.address, paymentCode: id!.paymentCode)',
    )));
    expect(kWalletVersion, '0.72');
  });
}

const int _noteNanos = 4 * kUnitsPerShe;
