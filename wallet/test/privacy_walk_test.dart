import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ed25519.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_pack.dart';
import 'package:shear_wallet/shear_shewall.dart';

void main() {
  test('two pays to one published code yield two dests; fingerprint cannot pay', () {
    final alice = createIdentity();
    expect(isFullPaymentCode(alice.paymentCode), isTrue);
    expect(payoutDest(alice.paymentCode), isNull);
    final bob = silentPay(alice.paymentCode)!;
    final carol = silentPay(alice.paymentCode)!;
    expect(bob.dest.startsWith('ssa1'), isTrue);
    expect(carol.dest.startsWith('ssa1'), isTrue);
    expect(bob.dest, isNot(carol.dest));
    expect(bob.dest, isNot(aliasDestOfSilentId(alice.paymentCode)));
    expect(silentDestFromCode(alice.paymentFingerprint, bob.ephSeed), isNull);
    final rec = recognizeSilentDest(
      viewKey: alice.viewKey,
      spendPub: decodePaymentCode(alice.paymentCode)!['spendPub']!,
      dest: bob.dest,
      ephPub: bob.ephPub,
    );
    expect(rec, isNotNull);
    expect(rec!['dest'], bob.dest);
  });

  test('dest-only memoOpen is null; shared secret opens; public hydrate drops secrets', () async {
    final alice = createIdentity();
    final pay = silentPay(alice.paymentCode)!;
    final env = await memoSeal(pay.dest, 'hello stealth', pay.shared);
    expect(await memoOpen(pay.dest, env), isNull);
    expect(await memoOpen(pay.dest, env, pay.shared), 'hello stealth');
    final pub = explorerRowPublic({
      'id': 'x',
      'from': pay.dest,
      'to': pay.dest,
      'amount': 1,
      'height': 1,
      'memoCt': env,
      'memoPlain': 'hello stealth',
    });
    expect(pub['memo'], isTrue);
    expect(pub['to'], pay.dest);
    expect(pub.containsKey('memoCt'), isFalse);
    expect(pub.containsKey('memoPlain'), isFalse);
    expect(pub['amount'], 1);
  });

  test('shewall Argon2id round-trip and PBKDF2 migrate; JSON refused', () async {
    final packed = packShewall(
      seed32: Uint8List.fromList(List.filled(32, 7)),
      dest20: Uint8List.fromList(List.filled(20, 3)),
    );
    final sealed = await sealShewallBin(packed, 'correct-horse');
    expect(String.fromCharCodes(sealed.sublist(0, shewallEncKind.length)), shewallEncKind);
    final opened = await openShewallBin(sealed, 'correct-horse');
    expect(opened, packed);
    final old = await sealShewallBinPbkdf2(packed, 'correct-horse');
    expect(shewallNeedsMigrate(old), isTrue);
    final migrated = await openAndResealShewallBin(old, 'correct-horse');
    expect(shewallNeedsMigrate(migrated), isFalse);
    expect(await openShewallBin(migrated, 'correct-horse'), packed);
    expect(
      () => openShewallBin(Uint8List.fromList(utf8Json()), 'x'),
      throwsA(isA<FormatException>()),
    );
  });

  test('stealth dest commits to one-time spend pub; wallet scans and keeps dest', () {
    final alice = createIdentity();
    final parsed = decodePaymentCode(alice.paymentCode)!;
    expect(parsed['spendPub']!.length, 32);
    expect(parsed['scanPub']!.length, 32);
    final pay = silentPay(alice.paymentCode)!;
    final rec = recognizeSilentDest(
      viewKey: alice.viewKey,
      spendPub: parsed['spendPub']!,
      dest: pay.dest,
      ephPub: pay.ephPub,
    );
    expect(rec, isNotNull);
    final oneTime = rec!['spendPub'] as Uint8List;
    expect(encodeDestAddress(destCommitFromSpendPub(oneTime)), pay.dest);
    final ledger = ShearLedger();
    ledger.viewSecret = alice.viewKey;
    ledger.creditReceive(
      to: pay.dest,
      amount: 1,
      ephPub: pay.ephPub,
      paymentCode: alice.paymentCode,
    );
    expect(ledger.exportedDests(), contains(pay.dest));
    ledger.keepOwnedDests(alice.address, paymentCode: alice.paymentCode);
    expect(ledger.exportedDests(), contains(pay.dest));
  });

  test('homeDest spendFrom send and lock dest-bind destCommit, not destAtIndex', () async {
    final alice = createIdentity();
    final bob = silentPay(alice.paymentCode)!;
    final ledger = ShearLedger();
    ledger.viewSecret = alice.viewKey;
    ledger.spendPub = decodePaymentCode(alice.paymentCode)!['spendPub'];
    final home = ledger.homeDest(alice.address, paymentCode: alice.paymentCode);
    expect(home, ledger.currentDest(alice.address, paymentCode: alice.paymentCode));
    expect(destMatchesSpendPub(home, ledger.spendPub!), isTrue);
    expect(home, isNot(destAtIndex(alice.address, index: 0, viewKey: alice.viewKey)));
    ledger.rememberSpendable(home, 3);
    expect(ledger.spendFrom(alice.address, paymentCode: alice.paymentCode, amount: 1), home);
    final seed = Uint8List.fromList([
      for (var i = 0; i < 32; i++)
        int.parse(alice.seedHex.substring(i * 2, i * 2 + 2), radix: 16),
    ]);
    final tx = await ledger.send(
      from: ledger.spendFrom(alice.address, paymentCode: alice.paymentCode, amount: 1),
      to: bob.dest,
      amount: 1,
      local: true,
      restFrame: alice.address,
      paymentCode: alice.paymentCode,
      spendSeed: seed,
    );
    expect(tx.from, home);
    expect(destMatchesSpendPub(tx.from, ed25519PublicFromSeed(seed)), isTrue);
    ledger.rememberSpendable(home, 3);
    final vault = vaultDest(alice.address, viewKey: alice.viewKey)!;
    final lockFrom = ledger.spendFrom(alice.address, paymentCode: alice.paymentCode, amount: 1);
    expect(lockFrom, home);
    final lock = await ledger.send(
      from: lockFrom,
      to: vault,
      amount: 1,
      local: true,
      kind: 'lock',
      programId: 'shear-reserve-v1',
      restFrame: alice.address,
      paymentCode: alice.paymentCode,
      spendSeed: seed,
    );
    expect(lock.from, home);
    expect(destMatchesSpendPub(lock.from, ed25519PublicFromSeed(seed)), isTrue);
  });

  test('hash credits land on homeDest destCommit; dest-index is not spendable', () {
    final alice = createIdentity();
    final ledger = ShearLedger()..viewSecret = alice.viewKey;
    final home = ledger.homeDest(alice.address, paymentCode: alice.paymentCode);
    final indexed = destAtIndex(alice.address, index: 0, viewKey: alice.viewKey)!;
    expect(home, isNot(indexed));
    expect(destMatchesSpendPub(home, decodePaymentCode(alice.paymentCode)!['spendPub']!), isTrue);
    ledger.creditHash(home, hashes: 256);
    expect(
      ledger.pending(alice.address, paymentCode: alice.paymentCode),
      closeTo(256 * kHashBonusShe, 1e-18),
    );
    expect(ledger.pending(indexed), 0);
    expect(ledger.spendFrom(alice.address, paymentCode: alice.paymentCode, amount: 0), isNot(indexed));
    ledger.creditHash(indexed, hashes: 100);
    expect(ledger.spendFrom(alice.address, paymentCode: alice.paymentCode, amount: 0), isNot(indexed));
    expect(
      ledger.pending(alice.address, paymentCode: alice.paymentCode),
      closeTo(256 * kHashBonusShe, 1e-18),
    );
  });

  test('copy ID is the full payment code, not alias dest', () {
    final id = createIdentity();
    expect(isFullPaymentCode(id.paymentCode), isTrue);
    expect(id.paymentCode.startsWith('she1'), isTrue);
    expect(payoutDest(id.paymentCode), isNull);
    expect(id.paymentFingerprint.startsWith('she1'), isTrue);
    expect(id.paymentFingerprint, isNot(id.paymentCode));
  });
}

Uint8List utf8Json() => Uint8List.fromList([0x7b, 0x7d]);
