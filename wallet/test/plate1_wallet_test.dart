import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_session.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_levy.dart';
import 'package:shear_wallet/shear_privacy_hop.dart';
import 'package:shear_wallet/shear_qr.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_vortex.dart';
import 'package:shear_wallet/shear_vpn_profile.dart';

void main() {
  test('next owed sum matures in 6 seconds', () {
    expect(kNextOwedMatureMs, 6000);
    expect(owedMatureLeftMs(owedShe: 1.5, anchoredShe: 0, anchorMs: 0, nowMs: 5000), 6000);
    expect(owedMatureLeftMs(owedShe: 1.5, anchoredShe: 1.5, anchorMs: 1000, nowMs: 1000), 6000);
    expect(owedMatureLeftMs(owedShe: 1.5, anchoredShe: 1.5, anchorMs: 1000, nowMs: 4000), 3000);
    expect(owedMatureLeftMs(owedShe: 1.5, anchoredShe: 1.5, anchorMs: 1000, nowMs: 7000), 0);
    expect(owedMatureLeftMs(owedShe: 2, anchoredShe: 1.5, anchorMs: 1000, nowMs: 9000), 6000);
    expect(owedMatureLeftMs(owedShe: 0, anchoredShe: 1.5, anchorMs: 1000, nowMs: 2000), 0);
  });

  test('a pi deposit unlocks a vote and the plurality wins at epoch end', () {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final vault = ShearReserve();
    final now = 1700000000000;
    expect(vault.deposit(dest: dest, she: 4, nowMs: now), isNull);
    expect(vault.portal(dest).canVote, isTrue);
    expect(vault.vote(dest: dest, choice: kVoteIncrease, nowMs: now), isNull);
    expect(vault.votesIncrease, 1);
    final end = now + kReserveEpochMs;
    expect(vault.epochIsOver(end), isTrue);
    final out = vault.withdraw(dest: dest, nowMs: end);
    expect(vault.bonusEnacted, isTrue);
    expect(vault.enactedUp, 1);
    expect(vault.enactedDelta, 1);
    expect(vault.liveHashBonusNanos, 2);
    expect(out, isNotNull);
    expect(out!['payout'], greaterThan(0));
  });

  test('vote fail copy is human and the vote post carries spendSeed', () async {
    final id = createIdentity();
    final seed = hexToBytes(id.seedHex);
    expect(seed.length, 32);
    expect(voteFailCopy(StateError('not_voter')), 'You’re not eligible to vote from this portal this epoch');
    expect(voteFailCopy(StateError('vote_locked')), 'Vote already sealed for this epoch');
    expect(
      voteFailCopy(StateError(kErrLockUnsigned)),
      'Vote could not be signed — check Continuum fee and portal, then try again',
    );
    expect(voteFailCopy(StateError('unsigned')), contains('could not be signed'));
    expect(voteFailCopy(StateError('bad_vote')), contains('could not be signed'));
    expect(voteFailCopy(StateError('not_voter')).toLowerCase(), isNot(contains('privacy hop')));
    final ledger = ShearLedger()..bindIdentity(id);
    final from = ledger.allocateReceiveDest(id.address, paymentCode: id.paymentCode);
    ledger.confirmRound(address: from, pot: 1, height: 1);
    ledger.settleTo(1 + ShearLedger.spendableConfirmations);
    await ledger.send(
      from: from,
      to: from,
      amount: 0,
      local: true,
      kind: 'vote',
      programId: kReserveProgram,
      spendSeed: seed,
      restFrame: id.address,
      paymentCode: id.paymentCode,
    );
    expect(ledger.spendSeed, seed);
  });

  test('vote fee hops off the mining mailbox when it is the only cover', () async {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.confirmRound(address: home, pot: 1, height: 1);
    ledger.settleTo(1 + ShearLedger.spendableConfirmations);
    const levy = 0.001;
    final plan = planLockFunding(ledger, restFrame: id.address, paymentCode: id.paymentCode, needShe: levy);
    expect(plan.from, home);
    final from = ledger.consolidateSpendableForLock(id.address, paymentCode: id.paymentCode, needShe: levy);
    expect(from, isNot(home));
    expect(ledger.spendable(home), 0);
    expect(ledger.spendable(from), closeTo(1, 1e-9));
    final posted = ShearLedger()..bindIdentity(id);
    final postedHome = posted.homeDest(id.address, paymentCode: id.paymentCode);
    posted.confirmRound(address: postedHome, pot: 1, height: 1);
    posted.settleTo(1 + ShearLedger.spendableConfirmations);
    final tx = await posted.send(
      from: postedHome,
      to: postedHome,
      amount: 0,
      local: true,
      kind: 'vote',
      programId: kReserveProgram,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      spendSeed: hexToBytes(id.seedHex),
    );
    expect(tx.from, isNot(postedHome));
    expect(posted.spendable(postedHome), 0);
  });

  test('flow spend refuses the mining mailbox and uses another covering dest', () {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final other = ledger.allocateReceiveDest(id.address, paymentCode: id.paymentCode);
    ledger.confirmRound(address: home, pot: 40, height: 1);
    ledger.settleTo(1 + ShearLedger.spendableConfirmations);
    expect(
      () => flowSpendFrom(ledger, restFrame: id.address, paymentCode: id.paymentCode, amount: 10),
      throwsA(predicate((Object e) => '$e'.contains('mining mailbox'))),
    );
    ledger.confirmRound(address: other, pot: 25, height: 2);
    ledger.settleTo(2 + ShearLedger.spendableConfirmations);
    final from = flowSpendFrom(ledger, restFrame: id.address, paymentCode: id.paymentCode, amount: 20);
    expect(from, other);
    expect(from, isNot(home));
    expect(flowSendAdvisoryOf(StateError(kFlowMiningRefuse)), kFlowMiningRefuse);
  });

  test('70 plus 61 consolidates to one lock from; shortfall names need and have', () {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final a = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final b = ledger.allocateReceiveDest(id.address, paymentCode: id.paymentCode);
    ledger.confirmRound(address: a, pot: 70, height: 1);
    ledger.confirmRound(address: b, pot: 61, height: 1);
    ledger.settleTo(1 + ShearLedger.spendableConfirmations);
    const need = 100.001;
    final plan = planLockFunding(ledger, restFrame: id.address, paymentCode: id.paymentCode, needShe: need);
    expect(plan.consolidate, isTrue);
    expect(plan.from, isNull);
    expect(plan.sources.length, greaterThanOrEqualTo(2));
    final from = ledger.consolidateSpendableForLock(id.address, paymentCode: id.paymentCode, needShe: need);
    expect(from, isNotEmpty);
    expect(ledger.spendable(from), greaterThanOrEqualTo(need));
    final others = plan.sources.where((d) => d != from);
    for (final d in others) {
      expect(ledger.spendable(d), 0);
    }
    final short = planLockFunding(ledger, restFrame: id.address, paymentCode: id.paymentCode, needShe: 1000);
    expect(lockFundingShortfall(short), contains('need'));
    expect(lockFundingShortfall(short), contains('have'));
    expect(lockFundingShortfall(short), isNot('insufficient'));
  });

  test('parseReceiveQr accepts full she1 and ssa1 and leaves To on a fingerprint', () {
    final id = createIdentity();
    final full = id.paymentCodeFull;
    final finger = id.paymentFingerprint;
    final dest = ledgerDest(id);
    expect(parseReceiveQr(full), full);
    expect(parseReceiveQr(dest), dest);
    expect(isPaymentFingerprint(finger), isTrue);
    expect(parseReceiveQr(finger), isNull);
    const prior = 'ssa1untouched';
    expect(applyReceiveQrTo(prior, finger), prior);
    expect(receiveQrFailCopy(finger), 'Not a payable Shear receive code (fingerprint only)');
  });

  test('closure Apply defaults to Connect bare, Android drops C, and B does not arm 1111', () {
    expect(closureModeFromStored(null, android: false), ClosureSendMode.connectBare);
    expect(closureModeFromStored('', android: true), ClosureSendMode.connectBare);
    expect(closureModeFromStored(kClosureModeBare, android: true), ClosureSendMode.connectBare);
    expect(closureModeFromStored(kClosureModeVpn, android: false), ClosureSendMode.connectBare);
    expect(closureModeFromStored('not-a-mode', android: false), ClosureSendMode.connectBare);
    expect(closureModeFromStored('fullNode', android: true), ClosureSendMode.localNode);
    expect(closureModeFromStored('fullNode', android: false), ClosureSendMode.localNode);
    expect(closureStratumPort(ClosureSendMode.connectBare, android: false), isNull);
    expect(closureStratumPort(ClosureSendMode.connectBare, android: true), isNull);
    expect(closureStratumPort(ClosureSendMode.localNode, android: false), isNull);
    expect(closureStratumPort(ClosureSendMode.localNodeFull, android: true), isNull);
    expect(closureStratumPort(ClosureSendMode.localNodeFull, android: false), isNull);
    expect(closureModeStored(ClosureSendMode.connectBare), kClosureModeBare);
    expect(closureModeStored(ClosureSendMode.shearPrivacyVpn), 'shearPrivacyVpn');
    expect(closureModeStored(ClosureSendMode.localNode), isNot('continuumSendPath'));
    expect(closureSpawnArgs(emptyDatadir: true, mode: ClosureSendMode.connectBare), isEmpty);
    expect(kConnectBareCopy.toLowerCase(), isNot(contains('looking for the vpn')));
  });

  test('VPN down blocks public send with the exact string and probe-up does not claim a mask', () {
    final down = publicSendGate(vpnMode: true, tunUp: false, probeOnly: false, localReady: false);
    expect(down.sendBlocked, isTrue);
    expect(down.claimsIpMask, isFalse);
    expect(down.error, kErrPrivacyVpn);
    expect(down.error, 'Couldn’t reach Shear Privacy VPN — try again');
    final probe = publicSendGate(vpnMode: true, tunUp: true, probeOnly: true, localReady: false);
    expect(probe.sendBlocked, isTrue);
    expect(probe.claimsIpMask, isFalse);
    expect(kPrivacyHopHost, '77.42.91.84');
    expect(kPrivacyHopPort, 44044);
    expect(kPrivacyHopFeeShe, 0);
    expect(
      reserveSendReady(
        hopUp: false,
        poolUrl: 'https://pool.shear.digital',
        unprivateConfirmed: true,
      ),
      isTrue,
    );
    for (final she in [1e-11, 0.2, 22.58, 10000.0, 1e9]) {
      expect(unprivateAmountPermitted(she), isTrue, reason: '$she');
    }
    expect(unprivateAmountPermitted(0), isFalse);
    expect(unprivateAmountPermitted(-1), isFalse);
    expect(unprivateAmountPermitted(double.nan), isFalse);
    expect(unprivateAmountPermitted(double.infinity), isFalse);
  });

  test('shared node binary is the file beside Continuum', () {
    final dir = Directory.systemTemp.createTempSync('shear-node-bin-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    expect(resolveSharedNodeBinary(besideDir: dir.path), isNull);
    final bin = File('${dir.path}${Platform.pathSeparator}shear-node');
    bin.writeAsStringSync('not-a-real-node');
    expect(resolveSharedNodeBinary(besideDir: dir.path), bin.path);
    expect(resolveSharedNodeBinary(override: 'from-env', besideDir: dir.path), 'from-env');
    final data = closureNodeDataDir(besideDir: dir.path);
    expect(closureDatadirEmpty(data), isTrue);
    Directory(data).createSync(recursive: true);
    File('${data}${Platform.pathSeparator}chain.bin').writeAsBytesSync([0]);
    expect(closureDatadirEmpty(data), isFalse);
  });

  test('sidecar Apply arms 1111 only for desktop C and stops on A', () async {
    final started = <Map<String, String>>[];
    final side = ShearNodeSidecar(
      android: false,
      nodeBinary: 'node',
      dataDir: '/tmp/shear-node',
      emptyDatadir: true,
      startProcess: (binary, env, args) async {
        started.add({...env, 'binary': binary, 'args': args.join(' ')});
      },
    );
    expect(side.committed, ClosureSendMode.connectBare);
    expect(side.sendBlocked, isFalse);
    expect(await side.apply(), kConnectBareCopy);
    expect(started, isEmpty);
    expect(side.running, isFalse);
    expect(side.listenPort, isNull);
    expect(side.progress.toLowerCase(), isNot(contains('vpn')));
    expect(closureSpawnEnv(ClosureSendMode.localNode, android: false, dataDir: '/tmp/shear-node')['SHEAR_STRATUM'], isNull);
    expect(closureSpawnEnv(ClosureSendMode.localNode, android: false, dataDir: '/tmp/shear-node')['SHEAR_GETBLOCK_BATCH'], '1');
    expect(closureSpawnEnv(ClosureSendMode.localNodeFull, android: false, dataDir: '/tmp/shear-node')['SHEAR_STRATUM'], isNull);
    expect(closureSpawnEnv(ClosureSendMode.localNodeFull, android: false, dataDir: '/tmp/shear-node')['SHEAR_SOLO'], '0');
    side.select(ClosureSendMode.localNode);
    expect(await side.apply(), 'Restarting local node for new send path…');
    expect(side.listenPort, isNull);
    expect(side.running, isTrue);
    expect(side.honest, isFalse);
    expect(side.sendBlocked, isTrue);
    expect(side.sendBlockedCopy, 'Wait until your local node is synced to the tip before sending.');
    expect(started.single['SHEAR_SOLO'], '0');
    expect(started.single['SHEAR_BOOTSTRAP'], '1');
    expect(started.single['SHEAR_BOOTSTRAP_URL'], kPublicBootstrapUrl);
    expect(started.single['args'], '');
    expect(started.single['args'], isNot(contains('bootstrap')));
    expect(kLocalNodeModeCopy.toLowerCase(), isNot(contains('auto bootstrap')));
    expect(kLocalNodeFullModeCopy.toLowerCase(), isNot(contains('auto bootstrap')));
    expect(localNodeMatchesSeeker(nodeHeight: 0, ibd: false, seekerTip: 4), isFalse);
    expect(localNodeMatchesSeeker(nodeHeight: 4, ibd: true, seekerTip: 4), isFalse);
    expect(localNodeMatchesSeeker(nodeHeight: 3, ibd: false, seekerTip: 4), isFalse);
    expect(localNodeMatchesSeeker(nodeHeight: 4, ibd: false, seekerTip: 4), isTrue);
    expect(observeLocalTip('status height=0 hash=- peers=0 want=1 ibd=true hashBackend=native'), isFalse);
    expect(observeLocalTip('{"event":"status","height":4,"ibd":true,"peers":1}'), isFalse);
    const atTip = 'status height=4 hash=abcd peers=1 want=0 ibd=false hashBackend=native';
    expect(observeLocalTip(atTip), isTrue);
    side.seekerTip = 80;
    expect(noteSidecarLine(side, atTip), isFalse);
    expect(side.honest, isFalse, reason: 'local height 4 is behind the light-seeker tip');
    side.seekerTip = 4;
    expect(side.takeOverIfMatched(), isTrue);
    expect(side.honest, isTrue);
    expect(side.sendBlocked, isFalse);
    expect(noteSidecarLine(side, atTip), isFalse);
    side.select(ClosureSendMode.localNodeFull);
    await side.apply();
    expect(side.pending, ClosureSendMode.localNode);
    expect(side.listenPort, isNull);
    expect(side.showSoloMine, isFalse);
    expect(side.showResistanceConsole, isTrue);
    expect(started.last['SHEAR_STRATUM'], isNull);
    expect(started.last['SHEAR_GETBLOCK_BATCH'], '1');
    side.select(ClosureSendMode.shearPrivacyVpn);
    expect(await side.apply(), kConnectBareCopy);
    expect(side.committed, ClosureSendMode.connectBare);
    expect(side.running, isFalse);
    expect(side.listenPort, isNull);
    expect(side.showResistanceConsole, isFalse);
    final phone = ShearNodeSidecar(android: true);
    phone.select(ClosureSendMode.localNodeFull);
    expect(phone.pending, ClosureSendMode.localNode);
    await phone.apply();
    expect(phone.listenPort, isNull);
  });

  test('Resistance Start arms one syncing node and Stop returns to Connect bare', () async {
    var calls = 0;
    final dir = Directory.systemTemp.createTempSync('plate1-empty-start-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final side = ShearNodeSidecar(
      android: false,
      nodeBinary: 'node',
      dataDir: dir.path,
      emptyDatadir: true,
      datadirEmpty: () => closureDatadirEmpty(dir.path),
      startProcess: (binary, env, args) async {
        calls += 1;
      },
    );
    final first = await side.startResistanceNode();
    expect(first, kResistanceEmptyCopy);
    expect(calls, 1);
    expect(side.committed, ClosureSendMode.localNode);
    expect(side.running, isTrue);
    expect(side.listenPort, isNull);
    expect(side.lastEnv['SHEAR_SOLO'], '0');
    expect(side.lastEnv['SHEAR_GETBLOCK_BATCH'], '1');
    expect(side.lastEnv['SHEAR_BOOTSTRAP'], '1');
    expect(side.lastEnv['SHEAR_BOOTSTRAP_URL'], kPublicBootstrapUrl);
    expect(side.lastEnv.containsKey('SHEAR_STRATUM'), isFalse);
    expect(side.lastEnv['SHEAR_FAST_SYNC'], '1');
    expect(side.lastArgs, isEmpty);
    await side.startResistanceNode();
    expect(calls, 1);
    expect(side.running, isTrue);
    expect(await side.stopResistanceNode(), resistanceStopCopy(0));
    expect(calls, 1);
    expect(side.committed, ClosureSendMode.connectBare);
    expect(side.running, isFalse);
    expect(side.listenPort, isNull);
    expect(side.showResistanceConsole, isFalse);

    var phoneCalls = 0;
    final phone = ShearNodeSidecar(
      android: true,
      nodeBinary: 'node',
      dataDir: dir.path,
      emptyDatadir: true,
      datadirEmpty: () => closureDatadirEmpty(dir.path),
      startProcess: (binary, env, args) async {
        phoneCalls += 1;
      },
    );
    await phone.startResistanceNode();
    expect(phoneCalls, 1);
    expect(phone.committed, ClosureSendMode.localNode);
    expect(phone.pending, ClosureSendMode.localNode);
    expect(phone.listenPort, isNull);
    expect(phone.lastEnv.containsKey('SHEAR_STRATUM'), isFalse);
    expect(phone.lastEnv['SHEAR_FAST_SYNC'], '1');
    expect(phone.lastEnv['SHEAR_SOLO'], '0');
    expect(phone.lastEnv['SHEAR_BOOTSTRAP'], '1');
    await phone.startResistanceNode();
    expect(phoneCalls, 1);
    await phone.stopResistanceNode();
    expect(phone.committed, ClosureSendMode.connectBare);
    expect(phone.running, isFalse);
    expect(phoneCalls, 1);
  });

  test('Resistance Start resumes the saved tip and Stop keeps the book', () async {
    final dir = Directory.systemTemp.createTempSync('plate1-resume-tip-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    writeSavedNodeTip(dir.path, 40);
    File('${dir.path}${Platform.pathSeparator}chain.bin').writeAsBytesSync([1, 2, 3]);
    final started = <Map<String, String>>[];
    final side = ShearNodeSidecar(
      android: false,
      nodeBinary: 'node',
      dataDir: dir.path,
      emptyDatadir: false,
      datadirEmpty: () => closureDatadirEmpty(dir.path),
      startProcess: (binary, env, args) async {
        started.add(env);
      },
    );
    side.reportedHeight = 40;
    final startMsg = await side.startResistanceNode();
    expect(startMsg, resistanceResumeCopy(40));
    expect(started.single.containsKey('SHEAR_BOOTSTRAP'), isFalse);
    expect(started.single['SHEAR_GETBLOCK_BATCH'], '1');
    expect(started.single.containsKey('SHEAR_STRATUM'), isFalse);
    side.reportedHeight = 44;
    final stopMsg = await side.stopResistanceNode();
    expect(stopMsg, resistanceStopCopy(44));
    expect(readSavedNodeTip(dir.path), 44);
    expect(File('${dir.path}${Platform.pathSeparator}chain.bin').existsSync(), isTrue);
    expect(side.committed, ClosureSendMode.connectBare);
    expect(side.running, isFalse);
    expect(side.listenPort, isNull);
  });

  test('closureSendMode round-trips and does not write continuumSendPath', () async {
    final dir = Directory.systemTemp.createTempSync('closure-mode-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    expect(session.closureSendMode, kClosureModeBare);
    await session.setPassword('test-pass-1');
    session.closureSendMode = kClosureModeLocal;
    await session.persist();
    final envelope = File(session.store.path).readAsStringSync();
    expect(envelope.contains('continuumSendPath'), isFalse);
    final again = ShearSession(store: session.store);
    await again.unlock('test-pass-1');
    expect(again.closureSendMode, kClosureModeLocal);
  });

  testWidgets('Apply switches the chip and shows the Resistance console', (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final dir = Directory.systemTemp.createTempSync('closure-ui-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ShearLedger(),
      startUnlocked: true,
      skipPoolSync: true,
    ));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('wallet-mode-connect-bare')), findsOneWidget);
    expect(find.text('CONNECT BARE'), findsOneWidget);
    expect(find.text('VPN HOP MODE'), findsNothing);
    await tester.tap(find.text('Closure'));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('closure-she1-fingerprint')), findsOneWidget);
    expect(find.byKey(const Key('closure-solo-mine')), findsNothing);
    expect(find.byKey(const Key('closure-send-path-bare')), findsOneWidget);
    expect(find.byKey(const Key('closure-send-path-local')), findsOneWidget);
    expect(find.byKey(const Key('settings-vpn-tunnel')), findsNothing);
    await tester.ensureVisible(find.text('Run node'));
    await tester.tap(find.text('Run node'));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const Key('closure-apply')));
    await tester.tap(find.byKey(const Key('closure-apply')));
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 400)));
    await tester.pump();
    expect(find.byKey(const Key('wallet-mode-local-node')), findsOneWidget);
    expect(find.text('RUN NODE'), findsOneWidget);
    await tester.tap(find.text('Resistance'));
    await tester.pump();
    expect(find.byKey(const Key('resistance-node-console')), findsOneWidget);
    expect(find.text('Waiting for node output…'), findsOneWidget);
    final scroll = tester.widget<SizedBox>(find.byKey(const Key('resistance-node-console-scroll')));
    expect(scroll.height, 12 * 1.2 * 9);
    expect(find.byType(SingleChildScrollView), findsWidgets);
    expect(find.text('127.0.0.1:1111'), findsNothing);
  });

  testWidgets('a stored VPN session opens Connect bare and the send is not held for a tunnel', (tester) async {
    tester.view.physicalSize = const Size(900, 2600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final dir = Directory.systemTemp.createTempSync('plate1-flow-vpn-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    final ledger = ShearLedger();
    final hop = PrivacyHopController();
    late ShearIdentity id;
    late String home;
    late String other;
    late String bob;
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
      session.closureSendMode = kClosureModeVpn;
      id = session.identity!;
      ledger.bindIdentity(id);
      home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
      other = ledger.allocateReceiveDest(id.address, paymentCode: id.paymentCode);
      ledger.confirmRound(address: other, pot: 5, height: 1);
      ledger.settleTo(1 + ShearLedger.spendableConfirmations);
      final bobId = createIdentity();
      final bobLedger = ShearLedger()..bindIdentity(bobId);
      bob = bobLedger.homeDest(bobId.address, paymentCode: bobId.paymentCode);
    });
    hop.noteProbeOnly();
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ledger,
      startUnlocked: true,
      skipPoolSync: true,
      enforceReserveHopGate: true,
      privacyHop: hop,
    ));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('wallet-mode-connect-bare')), findsOneWidget);
    expect(find.byKey(const Key('wallet-mode-vpn-hop')), findsNothing);
    expect(find.byKey(const Key('settings-vpn-tunnel')), findsNothing);
    await tester.tap(find.text('Flow'));
    await tester.pump();
    await tester.enterText(find.widgetWithText(TextField, 'To (full she1 payment code or ssa1)'), bob);
    await tester.enterText(find.byKey(const Key('flow-amount')), '1');
    final before = ledger.transactions.length;
    await tester.tap(find.byKey(const Key('flow-send')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text(kErrPrivacyVpn), findsNothing);
    expect(find.text('sent'), findsOneWidget);
    expect(hop.isUp, isFalse);
    expect(hop.tunVerified, isFalse);
    final sent = ledger.transactions.lastWhere((t) => t.kind == 'send');
    expect(sent.from, other);
    expect(sent.from, isNot(home));
  });

  testWidgets('Deposit sum consolidates 70+61 into a non-mailbox lock of 100', (tester) async {
    final funded = await fundedSplit(tester, 70, 61);
    await depositSum(tester, '100', consolidate: true);
    expect(find.text(kReserveLockSent), findsWidgets);
    expect(find.text('insufficient'), findsNothing);
    final lock = funded.ledger.transactions.lastWhere((t) => t.kind == 'lock');
    expect(lock.amount, closeTo(100, 1e-9));
    expect(lock.from, isNot(funded.home));
    expect(funded.ledger.spendable(funded.home), 0);
    expect(funded.ledger.spendable(funded.other), 0);
    expect(funded.ledger.spendSeed, isNotNull);
  });

  testWidgets('Deposit sum locks max spendable minus levy from split notes', (tester) async {
    final funded = await fundedSplit(tester, 70, 61);
    final owned = funded.ledger.spendableOwned(funded.id.address, paymentCode: funded.id.paymentCode);
    final levyShe = levyNanos((owned * kUnitsPerShe).round()) / kUnitsPerShe;
    final maxShe = owned - levyShe;
    await depositSum(tester, _trimAmount(maxShe), consolidate: true);
    expect(find.text(kReserveLockSent), findsWidgets);
    expect(find.text('insufficient'), findsNothing);
    final lock = funded.ledger.transactions.lastWhere((t) => t.kind == 'lock');
    expect(lock.from, isNot(funded.home));
    expect(lock.amount, closeTo(maxShe, 1e-6));
    final left = funded.ledger.spendableOwned(funded.id.address, paymentCode: funded.id.paymentCode);
    expect(left, lessThan(levyShe + 1e-6));
  });

  testWidgets('Cast vote posts spendSeed and shows the submitted snack', (tester) async {
    final funded = await fundedSplit(tester, 0, 20);
    await depositSum(tester, '10');
    expect(find.text('Locked stake can vote'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const Key('reserve-vote-increase bonus')));
    await tester.tap(find.byKey(const Key('reserve-vote-increase bonus')));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const Key('reserve-vote-submit')));
    await tester.tap(find.byKey(const Key('reserve-vote-submit')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('reserve-vote-confirm')), findsOneWidget);
    await tester.enterText(find.byKey(const Key('reserve-vote-confirm-field')), 'CONFIRM');
    await tester.pump();
    await tester.tap(find.byKey(const Key('reserve-vote-confirm-accept')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('reserve-vote-sign')), findsOneWidget);
    await tester.tap(find.byKey(const Key('reserve-vote-sign-accept')));
    await tester.pump();
    final submitted = find.text('Vote submitted — Your vote: increase bonus');
    for (var i = 0; i < 40 && submitted.evaluate().isEmpty; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    final snacks = tester.widgetList<SnackBar>(find.byType(SnackBar)).map((s) {
      final c = s.content;
      return c is Text ? (c.data ?? c.textSpan?.toPlainText() ?? '') : c.toString();
    }).toList();
    expect(submitted, findsOneWidget, reason: 'snacks=$snacks');
    expect(find.text('lock signature rejected'), findsNothing);
    expect(snacks.where((s) => s.toLowerCase().contains('privacy hop')), isEmpty);
    expect(find.text('Privacy hop'), findsNothing);
    expect(funded.ledger.spendSeed, hexToBytes(funded.id.seedHex));
    final vote = funded.ledger.transactions.lastWhere((t) => t.kind == 'vote');
    expect(vote.from, isNot(funded.home));
  });

  test('default tunnel is IPv4 and IPv6 with extended controls off', () {
    final profile = ShearVpnProfile();
    expect(profile.ipv4, isTrue);
    expect(profile.ipv6, isTrue);
    expect(profile.trafficShape, isFalse);
    expect(profile.outerObfuscation, isFalse);
    expect(profile.extendedOn, isFalse);
    expect(leanContinuumVortices().any((v) => v.id == kRestorePrivacyProgram), isFalse);
    final vpn = File('android/app/src/main/kotlin/com/shear/shear_wallet/PrivacyHopVpnService.kt').readAsStringSync();
    final activity = File('android/app/src/main/kotlin/com/shear/shear_wallet/MainActivity.kt').readAsStringSync();
    expect(vpn, contains('addRoute("0.0.0.0", 0)'));
    expect(vpn, contains('addRoute("::", 0)'));
    expect(vpn.contains('addDisallowedApplication'), isFalse);
    expect(vpn, contains('applyPrivacyScale(trafficShape)'));
    expect(activity, contains('VpnService.prepare'));
    expect(activity, contains('startActivityForResult(prep, REQ_VPN)'));
    expect(activity, contains('override fun onDestroy'));
    for (final path in [
      'windows/runner/flutter_window.cpp',
      'linux/runner/my_application.cc',
      'macos/Runner/MainFlutterWindow.swift',
    ]) {
      expect(File(path).readAsStringSync(), contains('deviceApproval'), reason: path);
    }
  });

  testWidgets('the VPN tunnel switch is gone and Run node does not raise a hop', (tester) async {
    tester.view.physicalSize = const Size(800, 2800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final dir = Directory.systemTemp.createTempSync('plate1-vpn-tick-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
      session.closureSendMode = kClosureModeLocal;
    });
    final hop = PrivacyHopController(connectImpl: () async => true);
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ShearLedger(),
      startUnlocked: true,
      skipPoolSync: true,
      privacyHop: hop,
    ));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('wallet-mode-local-node')), findsOneWidget);
    expect(find.text('RUN NODE'), findsOneWidget);
    expect(hop.isUp, isFalse);
    await tester.tap(find.text('Closure'));
    await tester.pump();
    expect(find.byKey(const Key('settings-vpn-tunnel')), findsNothing);
    expect(find.byKey(const Key('closure-send-path-bare')), findsOneWidget);
    expect(find.byKey(const Key('closure-send-path-local')), findsOneWidget);
    expect(find.text('Run node'), findsOneWidget);
    await tester.tap(find.text('Resistance'));
    await tester.pump();
    expect(find.byKey(const Key('resistance-vpn-console')), findsNothing);
    expect(find.text('VPN tunnel'), findsNothing);
    expect(find.text('Privacy hop'), findsNothing);
    expect(find.byKey(const Key('resistance-sync-height')), findsOneWidget);
    expect(hop.isUp, isFalse);
  });

  testWidgets('Resistance Start and Stop stay on the heading', (tester) async {
    tester.view.physicalSize = const Size(800, 2800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final dir = Directory.systemTemp.createTempSync('plate1-resistance-start-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    final hop = PrivacyHopController(connectImpl: () async => true);
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ShearLedger(),
      startUnlocked: true,
      skipPoolSync: true,
      privacyHop: hop,
    ));
    await tester.pump();
    await tester.pump();
    final resistanceTab = find.descendant(
      of: find.byType(NavigationBar),
      matching: find.text('Resistance'),
    );
    await tester.tap(resistanceTab);
    await tester.pump();
    expect(find.byKey(const Key('resistance-start')), findsOneWidget);
    expect(find.byKey(const Key('resistance-stop')), findsOneWidget);
    expect(find.byKey(const Key('resistance-node-console')), findsNothing);
    expect(find.text('Privacy hop'), findsNothing);
    await tester.tap(find.byKey(const Key('resistance-start')));
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump();
    expect(find.byKey(const Key('wallet-mode-local-node')), findsOneWidget);
    expect(find.text('RUN NODE'), findsOneWidget);
    expect(find.byKey(const Key('resistance-node-console')), findsOneWidget);
    expect(find.byKey(const Key('resistance-sync-height')), findsOneWidget);
    expect(hop.isUp, isFalse);
    await tester.tap(find.byKey(const Key('resistance-stop')));
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump();
    expect(find.byKey(const Key('wallet-mode-connect-bare')), findsOneWidget);
    expect(find.text('CONNECT BARE'), findsOneWidget);
    expect(find.byKey(const Key('resistance-node-console')), findsNothing);
    expect(find.byKey(const Key('resistance-start')), findsOneWidget);
    expect(find.byKey(const Key('resistance-stop')), findsOneWidget);
    expect(find.byKey(const Key('settings-vpn-tunnel')), findsNothing);
    expect(find.text('Privacy hop'), findsNothing);
    expect(find.text('VPN HOP MODE'), findsNothing);
    expect(hop.isUp, isFalse);
  });

  testWidgets('Restore Privacy vort1 opens the client with extended controls off', (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final dir = Directory.systemTemp.createTempSync('plate1-restore-privacy-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
      session.deployedVortices = const [
        Vortice(
          id: kRestorePrivacyProgram,
          name: kRestorePrivacyName,
          origin: 'https://shear.digital/vortices/restore-privacy',
        ),
      ];
    });
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ShearLedger(),
      startUnlocked: true,
      skipPoolSync: true,
    ));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Vortex'));
    await tester.pump();
    expect(find.text(kRestorePrivacyName), findsOneWidget);
    await tester.tap(find.text(kRestorePrivacyName));
    await tester.pump();
    expect(find.byKey(const Key('restore-privacy-pane')), findsOneWidget);
    expect(find.text('IPv4 on'), findsOneWidget);
    expect(find.text('IPv6 on'), findsOneWidget);
    expect(tester.widget<SwitchListTile>(find.byKey(const Key('restore-privacy-traffic-shape'))).value, isFalse);
    expect(tester.widget<SwitchListTile>(find.byKey(const Key('restore-privacy-obfuscation'))).value, isFalse);
    expect(find.text('Privacy hop'), findsNothing);
  });
}

Future<({ShearSession session, ShearLedger ledger, ShearIdentity id, String home, String other})>
    fundedSplit(WidgetTester tester, double homeShe, double otherShe) async {
  tester.view.physicalSize = const Size(900, 2600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final dir = Directory.systemTemp.createTempSync('plate1-done-');
  addTearDown(() {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
  });
  final session = ShearSession(store: File('${dir.path}/session.json'));
  final ledger = ShearLedger();
  late ShearIdentity id;
  late String home;
  late String other;
  await tester.runAsync(() async {
    await session.loadOrCreate();
    await session.setPassword('test-pass-1');
    id = session.identity!;
    ledger.bindIdentity(id);
    home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    other = ledger.allocateReceiveDest(id.address, paymentCode: id.paymentCode);
    if (homeShe > 0) ledger.confirmRound(address: home, pot: homeShe, height: 1);
    if (otherShe > 0) ledger.confirmRound(address: other, pot: otherShe, height: 1);
    ledger.settleTo(1 + ShearLedger.spendableConfirmations);
  });
  await tester.pumpWidget(ShearWalletApp(
    session: session,
    ledger: ledger,
    startUnlocked: true,
    skipPoolSync: true,
  ));
  await tester.pump();
  await tester.pump();
  return (session: session, ledger: ledger, id: id, home: home, other: other);
}

Future<void> depositSum(WidgetTester tester, String amount, {bool consolidate = false}) async {
  await tester.tap(find.text('Vortex'));
  await tester.pump();
  await tester.pump();
  await tester.ensureVisible(find.byKey(const Key('reserve-amount')));
  await tester.enterText(find.byKey(const Key('reserve-amount')), amount);
  await tester.pump();
  await tester.ensureVisible(find.byKey(const Key('reserve-send')));
  expect(find.text('Deposit sum'), findsOneWidget);
  await tester.tap(find.byKey(const Key('reserve-send')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  expect(find.byKey(const Key('reserve-sign')), findsOneWidget);
  await tester.tap(find.byKey(const Key('reserve-sign-accept')));
  await tester.pump();
  if (consolidate) {
    expect(find.byKey(const Key('reserve-deposit-progress')), findsOneWidget);
    expect(find.text('Consolidating Continuum notes for Deposit…'), findsOneWidget);
  }
  await tester.pump(const Duration(milliseconds: 50));
  await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 25)));
  await tester.pump();
}

String _trimAmount(double she) {
  var s = she.toStringAsFixed(9);
  s = s.replaceFirst(RegExp(r'0+$'), '');
  s = s.replaceFirst(RegExp(r'\.$'), '');
  return s;
}

String ledgerDest(ShearIdentity id) {
  final ledger = ShearLedger()..bindIdentity(id);
  return ledger.homeDest(id.address, paymentCode: id.paymentCode);
}
