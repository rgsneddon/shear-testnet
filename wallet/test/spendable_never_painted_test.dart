import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_vault_reward.dart' show hiddenChangeNote;

Uint8List _seedOf(ShearIdentity id) => Uint8List.fromList([
      for (var i = 0; i < 32; i++) int.parse(id.seedHex.substring(i * 2, i * 2 + 2), radix: 16),
    ]);

/// Spendable is only real notes mined deep enough: never a remembered figure,
/// never a bare credit, never a note with no block height.
void main() {
  const tip = 40;
  const nanos = 300000000000; // 3 SHE

  ShearLedger ledgerAtTip(ShearIdentity id) {
    final ledger = ShearLedger()..bindIdentity(id);
    ledger.noteLiveHeight(tip);
    ledger.settleTo(tip);
    return ledger;
  }

  Map<String, dynamic> sealedOn(String dest, Uint8List seed, {int? height}) {
    final note = hiddenChangeNote(
      nanos,
      hash20FromAddress(dest)!,
      spendSeed: seed,
      admitBase: admitPub(admitBaseScalar(seed)),
    );
    expect(note, isNotNull, reason: 'a real sealed note');
    return {
      ...note!,
      'address': dest,
      'dest': dest,
      'kind': 'send',
      'nanos': nanos,
      'amount': nanos / kUnitsPerShe,
      'spendSeed': seed,
      'verified': true,
      if (height != null) 'height': height,
    };
  }

  int spendableUnits(ShearLedger ledger, ShearIdentity id) {
    ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    return (ledger.spendableOwned(id.address, paymentCode: id.paymentCode) * kUnitsPerShe).round();
  }

  test('a remembered figure with no note behind it is never Spendable', () {
    final id = createIdentity();
    final ledger = ledgerAtTip(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberSpendable(home, 5);
    ledger.rememberSpendable(id.address, 5);
    expect(spendableUnits(ledger, id), 0);
    expect(ledger.spendable(home), 0);
  });

  test('a bare round credit with no sealed note is never Spendable', () {
    final id = createIdentity();
    final ledger = ledgerAtTip(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.confirmRound(address: home, pot: 1, height: 20);
    ledger.settleTo(tip);
    expect(spendableUnits(ledger, id), 0);
  });

  test('a real note with no block height is Pending, and Spendable once mined deep enough', () {
    final id = createIdentity();
    final seed = _seedOf(id);
    final ledger = ledgerAtTip(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final unmined = sealedOn(home, seed);
    ledger.rememberNote(unmined);
    expect(spendableUnits(ledger, id), 0, reason: 'no height: not Spendable');
    expect((ledger.pending(id.address, paymentCode: id.paymentCode) * kUnitsPerShe).round(), nanos, reason: 'Pending until mined');

    final shallow = ShearLedger()..bindIdentity(id);
    shallow.noteLiveHeight(tip);
    shallow.settleTo(tip);
    shallow.rememberNote(sealedOn(home, seed, height: tip));
    expect(spendableUnits(shallow, id), 0, reason: 'too few confirmations: not Spendable');

    final deep = ledgerAtTip(id);
    deep.rememberNote(sealedOn(home, seed, height: 20));
    expect(spendableUnits(deep, id), nanos, reason: 'mined deep enough: exactly the note');
    expect((deep.pending(id.address, paymentCode: id.paymentCode) * kUnitsPerShe).round(), 0);
  });

  // Ruling 6 (Russell, 28 Oct): a note is Spendable only once this wallet has
  // proven its body against a verified header. A node cannot say so for it.
  // The note law itself (spendableNote, which every Spendable figure and
  // every picker goes through) carries that gate, not only its callers.
  Map<String, dynamic> deepRow({bool readOpen = false, bool? bodyProven}) => {
        'address': 'd',
        'dest': 'd',
        'kind': 'send',
        'nanos': nanos,
        'amount': nanos / kUnitsPerShe,
        'height': 20,
        'verified': true,
        if (readOpen) 'readOpen': true,
        if (bodyProven != null) 'bodyProven': bodyProven,
      };

  test('P0: a read-page note with no proven body is never Spendable at the note law', () {
    expect(spendableNote(deepRow(), tip: tip, allowBare: true), isTrue, reason: 'a deep note counts');
    expect(spendableNote(deepRow(readOpen: true), tip: tip, allowBare: true), isFalse,
        reason: 'opened from a read page, body not proven: Pending');
    expect(spendableNote(deepRow(readOpen: true, bodyProven: true), tip: tip, allowBare: true), isTrue,
        reason: 'the body scan proved it');
  });

  test('P0: in body-proof mode the send pool counts a node-served note only once its body is proven', () {
    SpendablePool poolOf(Map<String, dynamic> row) => poolSpendableNotes({
          'notes': [row],
          'tip': tip,
          'allowBare': true,
          'bodyProof': true,
        });
    expect(poolOf(deepRow()).freeSum, BigInt.zero, reason: 'no proven body: not in the pool');
    expect(poolOf(deepRow(bodyProven: false)).freeSum, BigInt.zero);
    expect(poolOf(deepRow(bodyProven: true)).freeSum, BigInt.from(nanos));
    final plain = poolSpendableNotes({'notes': [deepRow()], 'tip': tip, 'allowBare': true});
    expect(plain.freeSum, BigInt.from(nanos), reason: 'outside body mode the deep note counts');
  });

  test('P0: body mode, a node-served deep note is Pending until the body scan proves it', () {
    debugBodyProofShipped = true;
    addTearDown(() => debugBodyProofShipped = false);
    final id = createIdentity();
    final seed = _seedOf(id);
    final ledger = ledgerAtTip(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    // The row a node serves: deep, value opened, no proven body.
    ledger.rememberNote({...sealedOn(home, seed, height: 20), 'bodyProven': true});
    final held = ledger.notes.singleWhere((n) => n['address'] == home);
    held.remove('bodyProven');
    expect(spendableUnits(ledger, id), 0, reason: 'unproven body: Pending');
    expect(ledger.spendable(home), 0);
    expect((ledger.unconfirmedIncomingShe(id.address, paymentCode: id.paymentCode) * kUnitsPerShe).round(), nanos,
        reason: 'a mined note with no proven body is incoming, not Spendable');
    held['bodyProven'] = true;
    expect(spendableUnits(ledger, id), nanos, reason: 'proven: exactly the note');
    expect((ledger.unconfirmedIncomingShe(id.address, paymentCode: id.paymentCode) * kUnitsPerShe).round(), 0);
  });

  test('P1: a refused send does not paint an unmined change note as Spendable on any dest', () async {
    final id = createIdentity();
    final seed = _seedOf(id);
    final ledger = ledgerAtTip(id)..spendSeed = seed;
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final changeDest = ledger.allocateChangeDest(id.address, from: home, paymentCode: id.paymentCode);
    expect(changeDest, isNot(home));
    // One deep note on home, and the change two earlier sends built: one
    // on home, one on the change dest, neither mined yet.
    ledger.rememberNote(sealedOn(home, seed, height: 20));
    ledger.rememberNote(sealedOn(home, seed));
    ledger.rememberNote(sealedOn(changeDest, seed));
    ledger.rememberDest(changeDest);
    expect(spendableUnits(ledger, id), nanos, reason: 'only the deep note');
    expect(ledger.spendable(home), closeTo(nanos / kUnitsPerShe, 1e-9));
    expect(ledger.spendable(changeDest), 0);

    final payee = createIdentity();
    final other = (ShearLedger()..bindIdentity(payee)).homeDest(payee.address, paymentCode: payee.paymentCode);
    await expectLater(
      ledger.send(
        from: home,
        to: other,
        amount: 2 * nanos / kUnitsPerShe,
        restFrame: id.address,
        paymentCode: id.paymentCode,
        spendSeed: seed,
        local: true,
      ),
      throwsA(isA<StateError>()),
      reason: 'the deep note does not cover it; the unmined change is not Spendable',
    );
    expect(ledger.spendable(home), closeTo(nanos / kUnitsPerShe, 1e-9),
        reason: 'the refusal rebinds home to the notes a send can use');
    expect(ledger.spendable(changeDest), 0, reason: 'unmined change on the change dest stays Pending');
    expect(spendableUnits(ledger, id), nanos);
    expect((ledger.pending(id.address, paymentCode: id.paymentCode) * kUnitsPerShe).round(), 2 * nanos,
        reason: 'both change notes are Pending');
  });
}
