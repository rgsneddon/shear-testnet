import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_cli.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_public_confirm.dart';
import 'package:shear_wallet/shear_reserve.dart';

import 'support/sealed_book.dart';

void main() {
  test('the privacy hop, VPN service, and RPT client are gone', () {
    const banned = [
      'privacyHop',
      'PrivacyHop',
      'privacy_hop',
      'SHEAR-HOP',
      'RPT2',
      'RptClient',
      'RptObfuscation',
      'RptTraffic',
      'VpnService',
      'FOREGROUND_SERVICE',
      'WAKE_LOCK',
      'POST_NOTIFICATIONS',
      '77.42.91.84',
    ];
    final roots = [
      Directory('lib'),
      Directory('android'),
      Directory('linux'),
      Directory('macos'),
      Directory('windows'),
    ];
    final vpnToken = <String>[];
    for (final root in roots) {
      for (final file in root.listSync(recursive: true)) {
        if (file is! File) continue;
        final name = file.path.replaceAll('\\', '/');
        if (name.contains('/build/') || name.contains('/.dart_tool/') || name.contains('/ephemeral/')) {
          continue;
        }
        if (!_source(name)) continue;
        final text = file.readAsStringSync();
        for (final needle in banned) {
          if (needle == '77.42.91.84' && name.endsWith('shear_read_sync.dart')) {
            expect(text.contains('http://77.42.91.84'), isFalse, reason: name);
            expect(text.contains('https://77.42.91.84'), isFalse, reason: name);
            expect(text.contains(needle), isTrue, reason: name);
            continue;
          }
          expect(text.contains(needle), isFalse, reason: '$name contains $needle');
        }
        if (text.contains('shearPrivacyVpn')) vpnToken.add(name);
      }
    }
    expect(vpnToken, hasLength(1));
    expect(vpnToken.single, endsWith('shear_closure.dart'));
    expect(File('lib/shear_privacy_hop.dart').existsSync(), isFalse);
    expect(
      File('android/app/src/main/kotlin/com/shear/shear_wallet/PrivacyHopVpnService.kt').existsSync(),
      isFalse,
    );
    expect(
      File('android/app/src/main/kotlin/com/shear/shear_wallet/RptClientEngine.kt').existsSync(),
      isFalse,
    );
    final docs = File('../site/docs/content.js').readAsStringSync().replaceAll(r"\'", "'");
    expect(docs.contains('Shear Privacy VPN'), isFalse);
    expect(docs.contains('mask the Continuum IP'), isFalse);
    expect(docs.contains('confirm a VPN or accept that the node may see your IP'), isFalse);
    expect(docs.contains('full privacy'), isFalse);
    expect(docs, contains(kPublicNodeEverySendCopy));
    expect(kUnprivateConfirmHelper, kPublicNodeEverySendCopy);
    expect(RegExp(r'\btor\b').hasMatch(kPublicNodeEverySendCopy.toLowerCase()), isFalse);
    expect(kCliHelp, contains(kPublicNodeEverySendCopy));
    expect(File('lib/shear_cli.dart').readAsStringSync(), contains(r'$kPublicNodeEverySendCopy'));
    expect(File('lib/main.dart').readAsStringSync(), contains('_flowPublicConsent'));
    expect(File('lib/shear_ledger.dart').readAsStringSync(), contains('publicNodePostAllowed(consent: publicIpConsent)'));
    final releases = File('RELEASES.md').readAsStringSync();
    expect(
      releases,
      contains(
        'The Privacy hop, Android VpnService, and RPT client described in 0.45–0.43 are not in the current wallet.',
      ),
    );
  });

  // A lock is exactly one π leaf (Russell, 25 Oct 14:20), so each lock here is π.
  test('public lock, vote, and withdraw wait for consent and local posts do not', () async {
    final blocked = _book();
    final dest = vaultDest(blocked.id.address, viewKey: blocked.id.viewKey)!;
    final reserve = ShearReserve();
    final owned = blocked.ledger.spendableOwned(
      blocked.id.address,
      paymentCode: blocked.id.paymentCode,
    );
    final lock = await postReserveDeposit(
      ledger: blocked.ledger,
      reserve: reserve,
      restFrame: blocked.id.address,
      paymentCode: blocked.id.paymentCode,
      dest: dest,
      she: kPiShe,
      depth: 0,
      spendSeed: hexToBytes(blocked.id.seedHex),
      local: false,
    );
    expect(lock.posted, isFalse);
    expect(lock.tx, isNull);
    expect(lock.remark, kPublicIpWaitCopy);
    expect(blocked.pool.posts, isEmpty, reason: 'no consent: nothing reached the public node');
    expect(reserve.portal(dest).nanos, 0);
    expect(blocked.ledger.transactions.where((t) => t.kind == 'lock'), isEmpty);
    expect(
      blocked.ledger.spendableOwned(blocked.id.address, paymentCode: blocked.id.paymentCode),
      closeTo(owned, 1e-9),
    );

    reserve.portal(dest).staked = kPiSheNanos;
    // Current law: the public vote is a leaf vote. Consent is refused before
    // the census, and this path does not write a legacy kind=vote tx.
    final vote = await castPlannedLeafVotes(
      ledger: blocked.ledger,
      reserve: reserve,
      planDir: '',
      dest: dest,
      choice: kVoteHold,
      restFrame: blocked.id.address,
      paymentCode: blocked.id.paymentCode,
      spendSeed: hexToBytes(blocked.id.seedHex),
      local: false,
    );
    expect(vote.enacted, isFalse);
    expect(vote.remark, kPublicIpWaitCopy);
    expect(reserve.portal(dest).vote, isNull);
    expect(blocked.ledger.transactions.where((t) => t.kind == 'vote'), isEmpty);


    final localBook = _book();
    final localDest = vaultDest(localBook.id.address, viewKey: localBook.id.viewKey)!;
    final localReserve = ShearReserve();
    final localLock = await postReserveDeposit(
      ledger: localBook.ledger,
      reserve: localReserve,
      restFrame: localBook.id.address,
      paymentCode: localBook.id.paymentCode,
      dest: localDest,
      she: kPiShe,
      depth: 0,
      spendSeed: hexToBytes(localBook.id.seedHex),
      local: true,
    );
    expect(localLock.posted, isTrue, reason: localLock.remark);
    expect(localLock.tx!.kind, 'lock');
    expect(localBook.pool.posts, isEmpty, reason: 'a local lock is not a public post');

    final consented = _book();
    final consentedDest = vaultDest(consented.id.address, viewKey: consented.id.viewKey)!;
    final consentedReserve = ShearReserve();
    final consentedLock = await postReserveDeposit(
      ledger: consented.ledger,
      reserve: consentedReserve,
      restFrame: consented.id.address,
      paymentCode: consented.id.paymentCode,
      dest: consentedDest,
      she: kPiShe,
      depth: 0,
      spendSeed: hexToBytes(consented.id.seedHex),
      local: false,
      publicIpConsent: true,
    );
    expect(consentedLock.posted, isTrue, reason: consentedLock.remark);
    expect(consentedLock.tx!.kind, 'lock');
    expect(consentedLock.remark, isNot(kPublicIpWaitCopy));
    expect(consented.pool.posts.where((b) => b['kind'] == 'lock'), hasLength(1),
        reason: 'with consent the real FS-1 lock body is posted');

    final voteBook = _book();
    final voteDest = vaultDest(voteBook.id.address, viewKey: voteBook.id.viewKey)!;
    final voteReserve = ShearReserve()
      ..epochStartMs = 1
      ..currentEpoch = 1
      ..bonusEnacted = false;
    voteReserve.portal(voteDest).staked = kPiSheNanos;
    // Current law: consent lets the leaf vote proceed. This book has no
    // census, so it fails closed and still writes no legacy kind=vote tx.
    final consentedVote = await castPlannedLeafVotes(
      ledger: voteBook.ledger,
      reserve: voteReserve,
      planDir: '',
      dest: voteDest,
      choice: kVoteHold,
      restFrame: voteBook.id.address,
      paymentCode: voteBook.id.paymentCode,
      spendSeed: hexToBytes(voteBook.id.seedHex),
      local: false,
      publicIpConsent: true,
    );
    expect(consentedVote.remark, isNot(kPublicIpWaitCopy));
    expect(consentedVote.enacted, isFalse);
    expect(voteBook.ledger.transactions.where((t) => t.kind == 'vote'), isEmpty);

    // Withdraw: the posted π lock above left its provable leaf. A public
    // withdraw of it waits for consent before anything is read or posted; a
    // local one does not ask; with consent it goes on to read the vault book
    // (this one has no matured tranche, so nothing settles or posts).
    final leaves = reserveLockLeaves(consented.ledger.notes);
    expect(leaves, isNotNull, reason: 'the posted lock left its leaf');
    final seed = hexToBytes(consented.id.seedHex);
    consentedReserve
      ..epochStartMs = 1
      ..currentEpoch = 1;
    final postsBefore = consented.pool.posts.length;
    Future<({ShearTx tx, Map<String, int> settled})?> withdraw({required bool local, bool consent = false}) =>
        postReserveWithdraw(
          consented.ledger,
          reserve: consentedReserve,
          dest: consentedDest,
          payout: consented.home,
          nowMs: 1 + kReserveEpochMs,
          spendSeed: seed,
          leaves: leaves,
          local: local,
          publicIpConsent: consent,
        );
    await expectLater(
      withdraw(local: false),
      throwsA(isA<StateError>().having((e) => e.message, 'message', kPublicIpWaitCopy)),
    );
    expect(consented.pool.posts.length, postsBefore, reason: 'no consent: nothing posted');
    expect(await withdraw(local: true), isNull, reason: 'a local withdraw does not wait for consent');
    expect(await withdraw(local: false, consent: true), isNull, reason: 'consent: on to the vault book');
    expect(consented.pool.posts.length, postsBefore, reason: 'no matured tranche: nothing posted');
    expect(consented.ledger.transactions.where((t) => t.kind == 'withdraw'), isEmpty);
  });
}

bool _source(String path) {
  return path.endsWith('.dart') ||
      path.endsWith('.kt') ||
      path.endsWith('.xml') ||
      path.endsWith('.cc') ||
      path.endsWith('.h') ||
      path.endsWith('.swift') ||
      path.endsWith('.cpp');
}

/// One real sealed 10 SHE note mined 9 deep (never a node row or a round
/// credit), with a pool double that serves its note set and records posts.
({ShearIdentity id, ShearLedger ledger, String home, SealedNotePool pool}) _book() {
  final b = SealedBook.fund([10 * kUnitsPerShe]);
  expect(b.spendableUnits, 10 * kUnitsPerShe);
  final home = b.ledger.homeDest(b.id.address, paymentCode: b.id.paymentCode);
  return (id: b.id, ledger: b.ledger, home: home, pool: b.pool);
}
