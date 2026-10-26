import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ed25519.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_ristretto.dart';
import 'package:shear_wallet/shear_pack.dart';
import 'package:shear_wallet/shear_shewall.dart';
import 'package:shear_wallet/shear_vault_reward.dart' show hiddenChangeNote, kPiSheNanos;

void main() {
  test('two pays to one published code yield two dests; fingerprint cannot pay', () {
    final alice = createIdentity();
    expect(isFullPaymentCode(alice.paymentCodeFull), isTrue);
    expect(isPaymentFingerprint(alice.paymentCode), isTrue);
    expect(payoutDest(alice.paymentCode), isNull);
    final bob = silentPay(alice.paymentCodeFull)!;
    final carol = silentPay(alice.paymentCodeFull)!;
    expect(bob.dest.startsWith('ssa1'), isTrue);
    expect(carol.dest.startsWith('ssa1'), isTrue);
    expect(bob.dest, isNot(carol.dest));
    expect(bob.dest, isNot(aliasDestOfSilentId(alice.paymentCode)));
    expect(silentDestFromCode(alice.paymentFingerprint, bob.ephSeed), isNull);
    final rec = recognizeSilentDest(
      viewKey: alice.viewKey,
      spendPub: decodePaymentCode(alice.paymentCodeFull)!['spendPub']!,
      dest: bob.dest,
      ephPub: bob.ephPub,
    );
    expect(rec, isNotNull);
    expect(rec!['dest'], bob.dest);
  });

  test('dest-only memoOpen is null; shared secret opens; public hydrate drops secrets', () async {
    final alice = createIdentity();
    final pay = silentPay(alice.paymentCodeFull)!;
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

  test('a memo envelope is one size whatever the memo, in the shape the node admits', () async {
    final alice = createIdentity();
    final pay = silentPay(alice.paymentCodeFull)!;
    final longest = '${'é' * 127}x';
    expect(utf8.encode(longest).length, memoMaxBytes);
    final short = await memoSeal(pay.dest, '', pay.shared);
    final long = await memoSeal(pay.dest, longest, pay.shared);
    for (final env in [short, long]) {
      expect(env.keys.toList()..sort(), ['ct', 'mac', 'nonce', 'v']);
      expect(env['v'], 2);
      expect(base64Decode(env['ct'] as String).length, memoSlotBytes);
      expect(base64Decode(env['nonce'] as String).length, 12);
      expect(base64Decode(env['mac'] as String).length, 16);
    }
    expect(jsonEncode(short).length, jsonEncode(long).length);
    expect(await memoOpen(pay.dest, short, pay.shared), '');
    expect(await memoOpen(pay.dest, long, pay.shared), longest);
    await expectLater(memoSeal(pay.dest, 'x' * (memoMaxBytes + 1), pay.shared), throwsArgumentError);
    expect(await memoOpen(pay.dest, {...long, 'v': 1}, pay.shared), isNull, reason: 'the unpadded v1 envelope does not open');
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
    final parsed = decodePaymentCode(alice.paymentCodeFull)!;
    expect(parsed['spendPub']!.length, 32);
    expect(parsed['scanPub']!.length, 32);
    final pay = silentPay(alice.paymentCodeFull)!;
    final rec = recognizeSilentDest(
      viewKey: alice.viewKey,
      spendPub: parsed['spendPub']!,
      dest: pay.dest,
      ephPub: pay.ephPub,
    );
    expect(rec, isNotNull);
    expect(rec!['dest'], pay.dest);
    final oneTime = rec['spendPub'] as Uint8List;
    expect(
      encodeDestAddress(destCommitFromSpendPub(oneTime), admitBaseFromAddress(pay.dest)),
      pay.dest,
    );
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
    final bob = silentPay(alice.paymentCodeFull)!;
    final ledger = ShearLedger()..bindIdentity(alice);
    final home = ledger.homeDest(alice.address, paymentCode: alice.paymentCode);
    expect(home, ledger.currentDest(alice.address, paymentCode: alice.paymentCode));
    expect(destMatchesSpendPub(home, ledger.spendPub!), isTrue);
    expect(home, isNot(destAtIndex(alice.address, index: 0, viewKey: alice.viewKey)));
    final seed = Uint8List.fromList([
      for (var i = 0; i < 32; i++)
        int.parse(alice.seedHex.substring(i * 2, i * 2 + 2), radix: 16),
    ]);
    // Real sealed notes on homeDest, mined deep enough: a send spends notes,
    // never a painted figure. One covers the send, one the π lock.
    ledger.noteLiveHeight(40);
    ledger.settleTo(40);
    for (final she in [3, 5]) {
      ledger.rememberNote(_sealedNote(home, seed, she * kUnitsPerShe, height: 20));
    }
    ledger.recheckRestFrameSpendable(alice.address, paymentCode: alice.paymentCode);
    expect(ledger.spendFrom(alice.address, paymentCode: alice.paymentCode, amount: 1), home);
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
    // A lock is one π leaf, from the 5 SHE note.
    final vault = vaultDest(alice.address, viewKey: alice.viewKey)!;
    final lockFrom = ledger.spendFrom(alice.address, paymentCode: alice.paymentCode, amount: kPiSheNanos / kUnitsPerShe);
    expect(lockFrom, home);
    final lock = await ledger.send(
      from: lockFrom,
      to: vault,
      amount: kPiSheNanos / kUnitsPerShe,
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
    final ledger = ShearLedger()..bindIdentity(alice);
    final home = ledger.homeDest(alice.address, paymentCode: alice.paymentCode);
    final indexed = destAtIndex(alice.address, index: 0, viewKey: alice.viewKey)!;
    expect(home, isNot(indexed));
    final spend = ed25519PublicFromSeed(Uint8List.fromList([
      for (var i = 0; i < 32; i++)
        int.parse(alice.seedHex.substring(i * 2, i * 2 + 2), radix: 16),
    ]));
    expect(destMatchesSpendPub(home, spend), isTrue);
    expect(admitBaseFromAddress(home)?.length, 32);
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
    // A mined round pays a sealed note to homeDest. Once deep enough it is
    // Spendable, exactly; the same note on the dest-index is not this wallet's.
    final seed = Uint8List.fromList([
      for (var i = 0; i < 32; i++)
        int.parse(alice.seedHex.substring(i * 2, i * 2 + 2), radix: 16),
    ]);
    final tip = 20 + ShearLedger.spendableConfirmations;
    ledger.rememberNote(_sealedNote(home, seed, kUnitsPerShe, height: 20));
    ledger.noteLiveHeight(tip);
    ledger.settleTo(tip);
    ledger.recheckRestFrameSpendable(alice.address, paymentCode: alice.paymentCode);
    expect(
      (ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode) * kUnitsPerShe).round(),
      kUnitsPerShe,
    );

    final other = ShearLedger()..bindIdentity(alice);
    other.creditHash(indexed, hashes: 100);
    other.rememberNote(_sealedNote(indexed, seed, kUnitsPerShe, height: 20));
    other.noteLiveHeight(tip);
    other.settleTo(tip);
    other.recheckRestFrameSpendable(alice.address, paymentCode: alice.paymentCode);
    expect(other.spendableOwned(alice.address, paymentCode: alice.paymentCode), 0, reason: 'a dest-index note is not Spendable');
  });

  test('homeDest dest20||B wraps hash notes; dest20-only ingest cannot recover r', () {
    final alice = createIdentity();
    final ledger = ShearLedger()..bindIdentity(alice);
    final home = ledger.homeDest(alice.address, paymentCode: alice.paymentCode);
    final b = admitBaseFromAddress(home);
    expect(b, isNotNull);
    expect(b!.length, 32);
    expect(destMatchesSpendPub(home, ledger.spendPub!), isTrue);

    final d20 = hash20FromAddress(home)!;
    final r = randomScalar();
    var wrapped = <String, dynamic>{
      'kind': 'hash',
      'noteCommit': noteCommitOfDest20(d20),
      'commit': pointBytes(commit(1, r)),
      'r': scalarBytes(r),
      'address': home,
    };
    wrapped = attachAdmitPub(wrapped, admitBase: pointFrom(b));
    expect(wrapped['rEph'], isNotNull);
    expect(wrapped['rCt'], isNotNull);
    final rBytes = wrapped['r'] as Uint8List;
    final compacted = compactSealedVout(wrapped);
    expect(compacted.containsKey('r'), isFalse);
    expect(compacted['rEph'], isNotNull);
    expect(compacted['rCt'], isNotNull);

    ledger.ingestSealedVouts([compacted], spendSeed: ledger.spendSeed!, dest: home);
    final opened = ledger.notes.where((n) =>
        n['r'] != null && (n['address'] == home || n['dest'] == home));
    expect(opened, isNotEmpty);
    final got = opened.first['r'];
    expect(got, isA<Uint8List>());
    expect(got as Uint8List, rBytes);

    final dest20only = encodeDestAddress(destCommitFromSpendPub(ledger.spendPub!));
    expect(admitBaseFromAddress(dest20only), isNull);
    expect(dest20only, isNot(home));
    final rBare = randomScalar();
    var bare = <String, dynamic>{
      'kind': 'hash',
      'noteCommit': noteCommitOfDest20(hash20FromAddress(dest20only)!),
      'commit': pointBytes(commit(1, rBare)),
      'r': scalarBytes(rBare),
      'address': dest20only,
    };
    bare = attachAdmitPub(bare);
    final compactBare = compactSealedVout(bare);
    expect(compactBare['rEph'], isNull);
    expect(compactBare.containsKey('r'), isFalse);
    final probe = ShearLedger()..bindIdentity(alice);
    probe.ingestSealedVouts([compactBare], spendSeed: probe.spendSeed!, dest: dest20only);
    expect(probe.notes.any((n) => n['r'] != null), isFalse);
  });

  test('copy ID is the full payment code, not alias dest', () {
    final id = createIdentity();
    expect(isFullPaymentCode(id.paymentCodeFull), isTrue);
    expect(isPaymentFingerprint(id.paymentCode), isTrue);
    expect(id.paymentCode.startsWith('she1'), isTrue);
    expect(payoutDest(id.paymentCode), isNull);
    expect(id.paymentFingerprint.startsWith('she1'), isTrue);
    expect(id.paymentFingerprint, id.paymentCode);
    expect(id.paymentCodeFull, isNot(id.paymentCode));
  });
}

Uint8List utf8Json() => Uint8List.fromList([0x7b, 0x7d]);

/// A real sealed note on [dest] (hiddenChangeNote: commit, range proof, admit
/// key) that this wallet can spend, mined at [height].
Map<String, dynamic> _sealedNote(String dest, Uint8List seed, int nanos, {required int height}) {
  final note = hiddenChangeNote(
    nanos,
    hash20FromAddress(dest)!,
    spendSeed: seed,
    admitBase: admitPub(admitBaseScalar(seed)),
  );
  if (note == null) throw StateError('sealed note: the native admit library is required');
  return {
    ...note,
    'address': dest,
    'dest': dest,
    'kind': 'send',
    'nanos': nanos,
    'amount': nanos / kUnitsPerShe,
    'spendSeed': seed,
    'verified': true,
    'height': height,
  };
}
