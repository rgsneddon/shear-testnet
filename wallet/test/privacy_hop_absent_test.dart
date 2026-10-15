import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_public_confirm.dart';
import 'package:shear_wallet/shear_reserve.dart';

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
    final docs = File('../site/docs/content.js').readAsStringSync();
    expect(docs.contains('Shear Privacy VPN'), isFalse);
    expect(docs.contains('mask the Continuum IP'), isFalse);
    expect(docs, contains('confirm a VPN or accept that the node may see your IP'));
    final releases = File('RELEASES.md').readAsStringSync();
    expect(
      releases,
      contains(
        'The Privacy hop, Android VpnService, and RPT client described in 0.45–0.43 are not in the current wallet.',
      ),
    );
  });

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
      she: 0.4,
      depth: 0,
      spendSeed: hexToBytes(blocked.id.seedHex),
      local: false,
    );
    expect(lock.posted, isFalse);
    expect(lock.tx, isNull);
    expect(lock.remark, kPublicIpWaitCopy);
    expect(reserve.portal(dest).nanos, 0);
    expect(blocked.ledger.transactions.where((t) => t.kind == 'lock'), isEmpty);
    expect(
      blocked.ledger.spendableOwned(blocked.id.address, paymentCode: blocked.id.paymentCode),
      closeTo(owned, 1e-9),
    );

    reserve.portal(dest).staked = kPiSheNanos;
    final vote = await commandReserveVote(
      ledger: blocked.ledger,
      reserve: reserve,
      restFrame: blocked.id.address,
      paymentCode: blocked.id.paymentCode,
      dest: dest,
      choice: kVoteHold,
      depth: 0,
      spendSeed: hexToBytes(blocked.id.seedHex),
      local: false,
    );
    expect(vote.enacted, isFalse);
    expect(vote.remark, kPublicIpWaitCopy);
    expect(reserve.portal(dest).vote, isNull);
    expect(blocked.ledger.transactions.where((t) => t.kind == 'vote'), isEmpty);

    reserve.epochStartMs = 1;
    reserve.epochBps = 0;
    reserve.bonusEnacted = false;
    reserve.portal(dest)
      ..staked = 100000000000
      ..idle = 0
      ..joined = true;
    reserve.totalLockedNanos = 100000000000;
    final now = 1 + kReserveEpochMs;
    final early = await postReserveWithdraw(
      blocked.ledger,
      reserve: reserve,
      dest: dest,
      payout: blocked.home,
      nowMs: 1,
      local: false,
    );
    expect(early, isNull);
    expect(reserve.portal(dest).staked, 100000000000);
    await expectLater(
      postReserveWithdraw(
        blocked.ledger,
        reserve: reserve,
        dest: dest,
        payout: blocked.home,
        nowMs: now,
        local: false,
      ),
      throwsA(isA<StateError>().having((e) => e.message, 'message', kPublicIpWaitCopy)),
    );
    expect(reserve.portal(dest).staked, 100000000000);
    expect(blocked.ledger.transactions.where((t) => t.kind == 'withdraw'), isEmpty);

    final localBook = _book();
    final localDest = vaultDest(localBook.id.address, viewKey: localBook.id.viewKey)!;
    final localReserve = ShearReserve();
    final localLock = await postReserveDeposit(
      ledger: localBook.ledger,
      reserve: localReserve,
      restFrame: localBook.id.address,
      paymentCode: localBook.id.paymentCode,
      dest: localDest,
      she: 0.4,
      depth: 0,
      spendSeed: hexToBytes(localBook.id.seedHex),
      local: true,
    );
    expect(localLock.posted, isTrue, reason: localLock.remark);
    expect(localLock.tx!.kind, 'lock');

    final consented = _book();
    final consentedDest = vaultDest(consented.id.address, viewKey: consented.id.viewKey)!;
    final consentedReserve = ShearReserve();
    final consentedLock = await postReserveDeposit(
      ledger: consented.ledger,
      reserve: consentedReserve,
      restFrame: consented.id.address,
      paymentCode: consented.id.paymentCode,
      dest: consentedDest,
      she: 0.4,
      depth: 0,
      spendSeed: hexToBytes(consented.id.seedHex),
      local: false,
      publicIpConsent: true,
    );
    expect(consentedLock.posted, isTrue, reason: consentedLock.remark);
    expect(consentedLock.tx!.kind, 'lock');
    expect(consentedLock.remark, isNot(kPublicIpWaitCopy));

    final voteBook = _book();
    final voteDest = vaultDest(voteBook.id.address, viewKey: voteBook.id.viewKey)!;
    final voteReserve = ShearReserve()
      ..epochStartMs = 1
      ..currentEpoch = 1
      ..bonusEnacted = false;
    voteReserve.portal(voteDest).staked = kPiSheNanos;
    final consentedVote = await commandReserveVote(
      ledger: voteBook.ledger,
      reserve: voteReserve,
      restFrame: voteBook.id.address,
      paymentCode: voteBook.id.paymentCode,
      dest: voteDest,
      choice: kVoteHold,
      depth: 0,
      spendSeed: hexToBytes(voteBook.id.seedHex),
      local: false,
      publicIpConsent: true,
    );
    expect(consentedVote.remark, isNot(kPublicIpWaitCopy));
    expect(consentedVote.enacted, isTrue, reason: consentedVote.remark);
    expect(voteBook.ledger.transactions.where((t) => t.kind == 'vote'), isNotEmpty);

    final withdrawBook = _book();
    final withdrawDest = vaultDest(withdrawBook.id.address, viewKey: withdrawBook.id.viewKey)!;
    final withdrawReserve = ShearReserve()
      ..epochStartMs = 1
      ..epochBps = 0
      ..bonusEnacted = false
      ..totalLockedNanos = 100000000000;
    withdrawReserve.portal(withdrawDest)
      ..staked = 100000000000
      ..idle = 0
      ..joined = true;
    final withdrawn = await postReserveWithdraw(
      withdrawBook.ledger,
      reserve: withdrawReserve,
      dest: withdrawDest,
      payout: withdrawBook.home,
      nowMs: 1 + kReserveEpochMs,
      local: false,
      publicIpConsent: true,
    );
    expect(withdrawn, isNotNull);
    expect(withdrawn!.tx.kind, 'withdraw');
    expect(withdrawReserve.portal(withdrawDest).staked, 0);
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

({ShearIdentity id, ShearLedger ledger, String home}) _book() {
  final id = createIdentity();
  final ledger = ShearLedger()..bindIdentity(id);
  final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
  ledger.rememberNote({
    'address': home,
    'dest': home,
    'verified': true,
    'height': 1,
    'amount': 1.0,
    'commit': Uint8List(32)..[0] = 1,
    'r': Uint8List(32)..[0] = 2,
  });
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
  return (id: id, ledger: ledger, home: home);
}
