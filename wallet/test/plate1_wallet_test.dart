import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_session.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_ctf.dart' show vaultDest;
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_levy.dart';
import 'package:shear_wallet/shear_public_confirm.dart';
import 'package:shear_wallet/shear_qr.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_vortex.dart';

import 'support/sealed_book.dart';

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

  test('vote fail copy is human and a portal vote send is refused as retired', () async {
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
    // Russell ruling 28 Oct: portal vote retired. The leaf vote carries the
    // seed (the "Cast vote posts spendSeed" test below); a kind=vote send is
    // refused before anything is built.
    final ledger = ShearLedger()..bindIdentity(id);
    final from = ledger.allocateReceiveDest(id.address, paymentCode: id.paymentCode);
    await expectLater(
      ledger.send(
        from: from,
        to: from,
        amount: 0,
        local: true,
        kind: 'vote',
        programId: kReserveProgram,
        spendSeed: seed,
        restFrame: id.address,
        paymentCode: id.paymentCode,
      ),
      throwsA(isA<StateError>().having((e) => e.message, 'message', kErrVoteRetired)),
    );
    expect(ledger.transactions.where((t) => t.kind == 'vote'), isEmpty);
  });

  // Books below hold real sealed notes mined 9 deep (Spendable is never a
  // round credit, Gate 3, 25 Oct); a lock is exactly one π leaf (25 Oct 14:20).
  test('reserve lock stays on the mining dest that holds the coins', () async {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    _fund(ledger, id, home, 3.96);
    const need = kPiShe;
    final from = ledger.consolidateSpendableForLock(
      id.address,
      paymentCode: id.paymentCode,
      needShe: need,
      keepHome: true,
    );
    expect(from, home);
    expect(ledger.spendable(home), closeTo(3.96, 1e-9));
    final before = ledger.spendableOwned(id.address, paymentCode: id.paymentCode);
    expect(before, greaterThanOrEqualTo(need));
    final tx = await ledger.send(
      from: home,
      to: home,
      amount: need,
      local: true,
      kind: 'lock',
      programId: kReserveProgram,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      spendSeed: hexToBytes(id.seedHex),
    );
    expect(tx.from, home);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), lessThan(before));
    expect(ledger.spendable(home), closeTo(3.96 - need, 0.001));
  });

  test('a fee-sized fund hops off the mining mailbox when it is the only cover', () async {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    _fund(ledger, id, home, 1);
    const levy = 0.001;
    final plan = planLockFunding(ledger, restFrame: id.address, paymentCode: id.paymentCode, needShe: levy);
    expect(plan.from, home);
    final from = ledger.consolidateSpendableForLock(id.address, paymentCode: id.paymentCode, needShe: levy);
    expect(from, isNot(home));
    expect(ledger.spendable(home), 0);
    expect(ledger.spendable(from), closeTo(1, 1e-9));
    // Russell ruling 28 Oct: portal vote retired; the posted half of this test
    // (a kind=vote send hopping off the mailbox) is gone with it.
  });

  test('flow spend refuses the mining mailbox and uses another covering dest', () {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final other = ledger.allocateReceiveDest(id.address, paymentCode: id.paymentCode);
    ledger.confirmRound(address: home, pot: 40, height: 1);
    ledger.settleTo(1 + ShearLedger.spendableConfirmations);
    final only = flowSpendFrom(ledger, restFrame: id.address, paymentCode: id.paymentCode, amount: 10);
    expect(only, home);
    ledger.confirmRound(address: other, pot: 25, height: 2);
    ledger.settleTo(2 + ShearLedger.spendableConfirmations);
    final from = flowSpendFrom(ledger, restFrame: id.address, paymentCode: id.paymentCode, amount: 20);
    expect(from, other);
    expect(from, isNot(home));
    expect(flowSendAdvisoryOf(StateError(kFlowMiningRefuse)), kFlowMiningRefuse);
  });

  test('2 plus 1.5 consolidates to one π lock from; shortfall names need and have', () {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final a = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final b = ledger.allocateReceiveDest(id.address, paymentCode: id.paymentCode);
    _fund(ledger, id, a, 2);
    _fund(ledger, id, b, 1.5);
    // Neither note covers a π lock and its levy alone; the two together do.
    final need = kPiShe + levyNanos(kPiSheNanos, depth: 0) / kUnitsPerShe;
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
    expect(parseReceiveQr(id.address), id.address);
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
    expect(closureModeFromStored('fullNode', android: true), ClosureSendMode.localNodeFull);
    expect(closureModeFromStored('fullNode', android: false), ClosureSendMode.localNodeFull);
    expect(closureStratumPort(ClosureSendMode.connectBare, android: false), isNull);
    expect(closureStratumPort(ClosureSendMode.connectBare, android: true), isNull);
    expect(closureStratumPort(ClosureSendMode.localNode, android: false), isNull);
    expect(closureStratumPort(ClosureSendMode.localNodeFull, android: true), isNull);
    expect(closureStratumPort(ClosureSendMode.localNodeFull, android: false), isNull);
    expect(closureModeStored(ClosureSendMode.connectBare), kClosureModeBare);
    expect(closureModeStored(closureModeFromStored(kClosureModeVpn, android: true)), kClosureModeBare);
    expect(closureModeStored(ClosureSendMode.localNode), isNot('continuumSendPath'));
    expect(closureSpawnArgs(emptyDatadir: true, mode: ClosureSendMode.connectBare), isEmpty);
    expect(kConnectBareCopy.toLowerCase(), isNot(contains('looking for the vpn')));
  });

  test('unprivate amounts stay open and a public post needs consent', () {
    expect(publicNodePostAllowed(consent: false), isFalse);
    expect(publicNodePostAllowed(consent: true), isTrue);
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
    expect(data.contains('testnet-v11'), isTrue);
    expect(closureDatadirEmpty(data), isTrue);
    final legacy = '${dir.path}${Platform.pathSeparator}shear-node-data';
    Directory(legacy).createSync(recursive: true);
    File('${legacy}${Platform.pathSeparator}chain.bin').writeAsBytesSync([0]);
    expect(closureNodeDataDir(besideDir: dir.path), legacy);
    expect(closureDatadirEmpty(legacy), isFalse);
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
    expect(side.progress.toLowerCase(), isNot(contains('privacy vpn')));
    expect(side.progress, contains(kPublicNodeEverySendCopy));
    expect(closureSpawnEnv(ClosureSendMode.localNode, android: false, dataDir: '/tmp/shear-node')['SHEAR_STRATUM'], isNull);
    expect(closureSpawnEnv(ClosureSendMode.localNode, android: false, dataDir: '/tmp/shear-node')['SHEAR_GETBLOCK_BATCH'], '1');
    expect(closureSpawnEnv(ClosureSendMode.localNodeFull, android: false, dataDir: '/tmp/shear-node')['SHEAR_STRATUM'], isNull);
    expect(closureSpawnEnv(ClosureSendMode.localNodeFull, android: false, dataDir: '/tmp/shear-node')['SHEAR_SOLO'], '1');
    expect(closureSpawnEnv(ClosureSendMode.localNodeFull, android: true, dataDir: '/tmp/shear-node')['SHEAR_SOLO'], '0');
    expect(closureSpawnArgs(emptyDatadir: false, mode: ClosureSendMode.localNodeFull), ['--solo']);
    expect(closureSpawnArgs(emptyDatadir: false, mode: ClosureSendMode.localNodeFull).first, '--solo');
    expect(closureSpawnArgs(emptyDatadir: false, mode: ClosureSendMode.localNodeFull, android: true), isEmpty);
    expect(closureSpawnArgs(emptyDatadir: false, mode: ClosureSendMode.localNode), isEmpty);
    side.select(ClosureSendMode.localNode);
    expect(await side.apply(), 'Restarting local node for new send path…');
    expect(side.listenPort, isNull);
    expect(side.running, isTrue);
    expect(side.honest, isFalse);
    expect(side.sendBlocked, isTrue);
    expect(side.sendBlockedCopy, 'Wait until your local node is synced to the tip before sending.');
    expect(started.single['SHEAR_SOLO'], '0');
    expect(started.single.containsKey('SHEAR_BOOTSTRAP'), isFalse);
    expect(started.single.containsKey('SHEAR_BOOTSTRAP_URL'), isFalse);
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
    expect(side.pending, ClosureSendMode.localNodeFull);
    expect(side.committed, ClosureSendMode.localNodeFull);
    expect(side.lastArgs, ['--solo']);
    expect(side.lastArgs.first, '--solo');
    expect(side.listenPort, isNull);
    expect(side.showSoloMine, isTrue);
    expect(side.showResistanceConsole, isTrue);
    expect(started.last['SHEAR_SOLO'], '1');
    expect(started.last['args'], '--solo');
    expect(started.last['SHEAR_STRATUM'], isNull);
    expect(started.last['SHEAR_GETBLOCK_BATCH'], '1');
    final retired = ShearNodeSidecar(
      android: false,
      storedMode: kClosureModeVpn,
      nodeBinary: 'node',
      dataDir: '/tmp/shear-node',
      emptyDatadir: true,
      startProcess: (binary, env, args) async {},
    );
    expect(retired.committed, ClosureSendMode.connectBare);
    expect(retired.pending, ClosureSendMode.connectBare);
    expect(await retired.apply(), kConnectBareCopy);
    expect(retired.running, isFalse);
    expect(retired.listenPort, isNull);
    expect(retired.showResistanceConsole, isFalse);
    final phone = ShearNodeSidecar(android: true);
    phone.select(ClosureSendMode.localNodeFull);
    expect(phone.pending, ClosureSendMode.localNodeFull);
    await phone.apply();
    expect(phone.committed, ClosureSendMode.localNodeFull);
    expect(phone.lastArgs, isEmpty);
    expect(phone.lastEnv['SHEAR_SOLO'], '0');
    expect(phone.showSoloMine, isFalse);
    expect(phone.listenPort, isNull);
  });

  test('local node synced notice is once per session after a lag and catch-up', () async {
    ShearNodeSidecar open() {
      final side = ShearNodeSidecar(
        android: false,
        nodeBinary: 'node',
        dataDir: '/tmp/shear-notice',
        emptyDatadir: true,
        startProcess: (binary, env, args) async {},
      );
      side.select(ClosureSendMode.localNode);
      return side;
    }

    const atTip = 'status height=10 hash=abcd peers=1 want=0 ibd=false hashBackend=native';
    const behind = 'status height=9 hash=aa peers=1 want=1 ibd=false hashBackend=native';
    final side = open();
    await side.apply();
    side.seekerTip = 10;
    final first = noteSidecarLine(side, atTip);
    expect(first, isTrue);
    expect(side.localSyncNoticeDue(caughtTip: first), isTrue);
    expect(noteSidecarLine(side, atTip), isFalse);
    expect(side.localSyncNoticeDue(caughtTip: false), isFalse);
    expect(noteSidecarLine(side, behind), isFalse);
    expect(side.honest, isFalse);
    final again = noteSidecarLine(side, atTip);
    expect(again, isTrue);
    expect(side.localSyncNoticeDue(caughtTip: again), isFalse);
    final fresh = open();
    await fresh.apply();
    fresh.seekerTip = 10;
    final opened = noteSidecarLine(fresh, atTip);
    expect(opened, isTrue);
    expect(fresh.localSyncNoticeDue(caughtTip: opened), isTrue);
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
    expect(side.lastEnv.containsKey('SHEAR_BOOTSTRAP'), isFalse);
    expect(side.lastEnv.containsKey('SHEAR_BOOTSTRAP_URL'), isFalse);
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
    expect(phone.lastEnv.containsKey('SHEAR_BOOTSTRAP'), isFalse);
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
    expect(find.byKey(const Key('closure-send-path-full')), findsOneWidget);
    expect(find.text('Full Node'), findsOneWidget);
    expect(find.text('p2P Node'), findsOneWidget);
    expect(find.byKey(const Key('settings-vpn-tunnel')), findsNothing);
    await tester.ensureVisible(find.text('p2P Node'));
    await tester.tap(find.text('p2P Node'));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const Key('closure-apply')));
    await tester.tap(find.byKey(const Key('closure-apply')));
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 400)));
    await tester.pump();
    expect(find.byKey(const Key('wallet-mode-local-node')), findsOneWidget);
    expect(find.text('P2P NODE'), findsOneWidget);
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
      _fund(ledger, id, other, 5);
      final bobId = createIdentity();
      final bobLedger = ShearLedger()..bindIdentity(bobId);
      bob = bobLedger.homeDest(bobId.address, paymentCode: bobId.paymentCode);
    });
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ledger,
      startUnlocked: true,
      skipPoolSync: true,
    ));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('wallet-mode-connect-bare')), findsOneWidget);
    expect(find.byKey(const Key('wallet-mode-vpn-hop')), findsNothing);
    expect(find.byKey(const Key('settings-vpn-tunnel')), findsNothing);
    await tester.tap(find.text('Flow'));
    await tester.pump();
    await tester.enterText(find.widgetWithText(TextField, 'To (she1, ssa1, or shear1)'), bob);
    await tester.enterText(find.byKey(const Key('flow-amount')), '1');
    final before = ledger.transactions.length;
    await tester.tap(find.byKey(const Key('flow-send')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('reserve-unprivate-accept')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('Privacy hop'), findsNothing);
    expect(find.text('sent'), findsOneWidget);
    final sent = ledger.transactions.lastWhere((t) => t.kind == 'send');
    expect(other, isNot(home));
    expect(sent.from, isNot(home));
  });

  // The Deposit folds split notes onto the dest holding the most, and a lock
  // may stay on the mining mailbox when that is it (keepHome, 0.62, 29 Sep:
  // "reserve lock stays on the mining dest that holds the coins" above). Here
  // the larger note is on the other dest, so the lock is not the mailbox's.
  testWidgets('Lock π consolidates 1.5+2 into a non-mailbox lock of π', (tester) async {
    final funded = await fundedSplit(tester, 1.5, 2);
    await depositSum(tester, '3.14159265358', consolidate: true);
    expect(find.text(kReserveLockSent), findsWidgets, reason: _snacks(tester));
    expect(find.text('insufficient'), findsNothing);
    final lock = funded.ledger.transactions.lastWhere((t) => t.kind == 'lock');
    expect((lock.amount * kUnitsPerShe).round(), kPiSheNanos);
    expect(lock.from, funded.other);
    // The mailbox note folded onto the lock's dest; what is left of the two
    // notes after π and its levy is Spendable there, exactly.
    final left = 3.5 - kPiShe - levyNanos(kPiSheNanos) / kUnitsPerShe;
    expect(funded.ledger.spendable(funded.home), 0);
    expect(funded.ledger.spendable(funded.other), closeTo(left, 1e-9));
    expect(funded.ledger.spendableOwned(funded.id.address, paymentCode: funded.id.paymentCode), closeTo(left, 1e-9));
    expect(funded.ledger.spendSeed, isNotNull);
  });

  testWidgets('Lock π locks π from split notes and the rest stays Spendable', (tester) async {
    final funded = await fundedSplit(tester, 1.5, 2.5);
    final owned = funded.ledger.spendableOwned(funded.id.address, paymentCode: funded.id.paymentCode);
    final levyShe = levyNanos(kPiSheNanos) / kUnitsPerShe;
    await depositSum(tester, '3.14159265358', consolidate: true);
    expect(find.text(kReserveLockSent), findsWidgets, reason: _snacks(tester));
    expect(find.text('insufficient'), findsNothing);
    final lock = funded.ledger.transactions.lastWhere((t) => t.kind == 'lock');
    expect(lock.from, funded.other, reason: 'the larger note is on the other dest');
    expect((lock.amount * kUnitsPerShe).round(), kPiSheNanos);
    final left = funded.ledger.spendableOwned(funded.id.address, paymentCode: funded.id.paymentCode);
    expect(left, closeTo(owned - kPiShe - levyShe, 1e-9));
  });

  // ShearK refuses to run on phones (exit 86, Russell's phone-mining ruling).
  // The phone wallet (Android and iOS: hostAndroid) says so under the mining
  // login; the desktop wallet does not.
  for (final phone in [true, false]) {
    testWidgets('the mining login ${phone ? 'says ShearK will not run on phones' : 'has no phone line on desktop'}', (tester) async {
      tester.view.physicalSize = const Size(900, 2600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final dir = Directory.systemTemp.createTempSync('plate1-phone-mining-');
      addTearDown(() {
        if (dir.existsSync()) dir.deleteSync(recursive: true);
      });
      final session = ShearSession(store: File('${dir.path}/session.json'));
      await tester.runAsync(() async {
        await session.loadOrCreate();
        await session.setPassword('test-pass-1');
      });
      final ledger = ShearLedger()..bindIdentity(session.identity!);
      await tester.pumpWidget(ShearWalletApp(
        session: session,
        ledger: ledger,
        startUnlocked: true,
        skipPoolSync: true,
        hostAndroid: phone,
      ));
      await tester.pump();
      await tester.pump();
      final login = find.byKey(const Key('continuum-ssa1'));
      expect(login, findsOneWidget, reason: 'the mining login pane is shown');
      expect(find.textContaining('Stable mining login for ShearK'), findsOneWidget);
      expect(find.text(kPhoneMiningLine), phone ? findsOneWidget : findsNothing);
      expect(kPhoneMiningLine, 'Mining is for desktops and servers; ShearK will not run on phones.');
    });
  }

  // A lock is exactly one π leaf (Russell, 25 Oct 14:20, Corrections 1), so
  // the Deposit amount is a fixed line, not free text. Withdraw (the only exit
  // from a matured lock) and Roll never wait on a Deposit amount.
  testWidgets('the Deposit shows π as a fixed amount and Lock π, Withdraw and Roll need nothing typed', (tester) async {
    final reserve = ShearReserve();
    final funded = await fundedSplit(tester, 0, 5, reserve: reserve);
    final vault = vaultDest(funded.id.address, viewKey: funded.id.viewKey)!;
    reserve.portal(vault)
      ..staked = kPiSheNanos
      ..joined = true;
    reserve.epochStartMs = DateTime.now().millisecondsSinceEpoch - 2 * kReserveEpochMs;
    await tester.tap(find.text('Vortex'));
    await tester.pump();
    await tester.pump();
    final amount = find.byKey(const Key('reserve-amount'));
    expect(amount, findsOneWidget);
    expect(tester.widget(amount), isA<Text>(), reason: 'read-only, not a field');
    expect(tester.widget<Text>(amount).data, kReserveLockAmountLine);
    expect(kReserveLockAmountLine, contains('3.14159265358'));
    expect(find.text('Amount SHEAR'), findsNothing);
    final lock = tester.widget<FilledButton>(find.byKey(const Key('reserve-send')));
    expect((lock.child as Text).data, kReserveLockButton);
    expect(lock.onPressed, isNotNull, reason: 'one π needs no typed amount');
    await tester.ensureVisible(find.byKey(const Key('reserve-withdraw')));
    expect(tester.widget<FilledButton>(find.byKey(const Key('reserve-withdraw'))).onPressed, isNotNull,
        reason: 'withdraw is independent of the Deposit');
    final roll = find.byKey(const Key('reserve-roll'));
    if (roll.evaluate().isNotEmpty) {
      expect(tester.widget<ButtonStyleButton>(roll).onPressed, isNotNull);
    }
  });

  // Moved from shear_wallet_test "Reserve deposit requires Sign, lock-in
  // stays, deposits sum to π then vote+results". Its "deposits sum to π" half
  // is retired: a lock is exactly one π leaf and partial deposits no longer
  // exist (Russell, 25 Oct 14:20, Corrections 1). The Sign / lock-in /
  // vote-results flow stays, on the real-vote pattern: a real FS-1 π lock,
  // the census from a node block body, one real leaf vote posted.
  testWidgets('Reserve deposit requires Sign, lock-in stays, the vote waits for 9 confirmations, then vote+results', (tester) async {
    final pool = SealedNotePool();
    final reserve = ShearReserve()..currentEpoch = 1;
    final funded = await fundedSplit(tester, 0, 10, extraOther: const [1], pool: pool, reserve: reserve);
    await tester.tap(find.text('Vortex'));
    await tester.pump();
    await tester.pump();
    expect(find.textContaining('Need'), findsWidgets);
    // No lock yet: the vote is below π.
    await tester.ensureVisible(find.byKey(Key('reserve-vote-$kVoteIncrease')));
    await tester.tap(find.byKey(Key('reserve-vote-$kVoteIncrease')));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const Key('reserve-vote-submit')));
    expect(tester.widget<FilledButton>(find.byKey(const Key('reserve-vote-submit'))).onPressed, isNotNull);
    await tester.tap(find.byKey(const Key('reserve-vote-submit')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text(kVoteBelowPi), findsOneWidget);
    expect(find.byKey(const Key('reserve-vote-confirm')), findsNothing);
    // The Deposit asks for Sign, with its one fee.
    await tester.ensureVisible(find.byKey(const Key('reserve-send')));
    await tester.tap(find.byKey(const Key('reserve-send')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('reserve-sign')), findsOneWidget);
    expect(find.byKey(const Key('reserve-lock-sign-levy')), findsOneWidget);
    expect(find.textContaining('One fee to add funds to the vault'), findsWidgets);
    await tester.tap(find.byKey(const Key('reserve-sign-accept')));
    await tester.pump();
    final consent = find.byKey(const Key('reserve-unprivate-accept'));
    if (consent.evaluate().isNotEmpty) {
      await tester.tap(consent);
      await tester.pump();
    }
    await _waitFor(tester, find.byKey(const Key('reserve-locked-in')));
    expect(pool.posts.where((b) => b['kind'] == 'lock'), hasLength(1), reason: 'one real FS-1 π lock');
    expect(find.text(kReserveLockSent), findsWidgets);
    expect(find.byKey(const Key('reserve-lock-sent')), findsOneWidget);
    expect(find.textContaining('Coins are locked in your portal'), findsOneWidget);
    expect(find.byKey(const Key('reserve-locked-in-levy')), findsOneWidget);
    // Locked but not mined: the vote waits on 9 confirmations.
    await tester.ensureVisible(find.byKey(const Key('reserve-vote-submit')));
    await tester.tap(find.byKey(const Key('reserve-vote-submit')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text(kVoteConfirmWait), findsOneWidget,
        reason: '${_snacks(tester)} locks=${funded.ledger.transactions.where((t) => t.kind == 'lock').map((t) => '${t.to}@${t.height}').join(',')}');
    expect(find.byKey(const Key('reserve-vote-confirm')), findsNothing);
    // The lock is mined (its change enters the live set) and is 9 deep; the
    // node's block body commits this epoch's census.
    final lockHeight = funded.ledger.sealedHeight + 1;
    final change = funded.ledger.lastSealedLock?['change'];
    expect(change, isA<Map>());
    pool.addLive(Map<String, dynamic>.from(change as Map), lockHeight);
    funded.ledger.confirmRound(address: funded.other, pot: 0, height: lockHeight);
    final voteTip = lockHeight + ShearLedger.spendableConfirmations - 1;
    funded.ledger.noteLiveHeight(voteTip);
    funded.ledger.settleTo(voteTip);
    funded.ledger.rememberNodeChain(bodies: [
      {
        'height': 2,
        'txs': [
          {
            'coinbase': true,
            'epochCensusCommit': [
              {'epoch': 1, 'leafCount': 1, 'openHeight': 2},
            ],
          },
        ],
      },
    ]);
    await tester.pump();
    final portalDest = vaultDest(funded.id.address, viewKey: funded.id.viewKey)!;
    expect(reserveVoteGate(funded.ledger, reserve, portalDest), isNull);
    expect(find.byKey(const Key('reserve-vote-results')), findsNothing);
    await tester.ensureVisible(find.byKey(const Key('reserve-vote-submit')));
    await tester.tap(find.byKey(const Key('reserve-vote-submit')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('reserve-vote-confirm')), findsOneWidget);
    expect(find.byKey(const Key('reserve-vote-confirm-levy')), findsOneWidget);
    expect(find.textContaining('One fee to cast this vote'), findsWidgets);
    final accept = find.byKey(const Key('reserve-vote-confirm-accept'));
    expect((tester.widget<FilledButton>(accept).child as Text).data, 'CONFIRM');
    expect(tester.widget<FilledButton>(accept).onPressed, isNull, reason: 'CONFIRM must be typed');
    await tester.enterText(find.byKey(const Key('reserve-vote-confirm-field')), 'CONFIRM');
    await tester.pump();
    expect(tester.widget<FilledButton>(accept).onPressed, isNotNull);
    await tester.tap(accept);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byKey(const Key('reserve-vote-sign')), findsOneWidget);
    expect(find.byKey(const Key('reserve-vote-sign-levy')), findsOneWidget);
    await tester.tap(find.byKey(const Key('reserve-vote-sign-accept')));
    await _waitFor(tester, find.text('Vote submitted — Your vote: $kVoteIncrease'));
    await _waitFor(tester, find.byKey(const Key('reserve-vote-results')));
    expect(pool.posts.where((b) => b['kind'] == 'leaf-vote'), hasLength(1), reason: 'one real leaf vote');
    expect(find.byKey(const Key('reserve-vote-confirm')), findsNothing);
    expect(find.byKey(const Key('reserve-vote-results')), findsOneWidget);
    expect(find.textContaining('your vote:'), findsNothing);
    expect(find.byKey(const Key('reserve-your-vote')), findsOneWidget);
    expect(find.text('Your vote: $kVoteIncrease'), findsOneWidget);
    expect(find.text('Cast vote'), findsNothing);
    expect(find.byKey(const Key('reserve-vote-submit')), findsNothing);
    expect(find.byKey(Key('reserve-vote-$kVoteDecrease')), findsNothing);
    expect(find.byKey(Key('reserve-vote-$kVoteHold')), findsNothing);
    expect(find.byKey(Key('reserve-vote-$kVoteIncrease')), findsOneWidget);
    final check = tester.widget<Icon>(
      find.descendant(of: find.byKey(Key('reserve-vote-$kVoteIncrease')), matching: find.byIcon(Icons.check)),
    );
    expect(check.color, const Color(0xFF1A9A4A));
    await tester.tap(find.byKey(Key('reserve-vote-$kVoteIncrease')));
    await tester.pump();
    expect(find.byKey(const Key('reserve-vote-confirm')), findsNothing);
    final resultsY = tester.getTopLeft(find.byKey(const Key('reserve-vote-results'))).dy;
    final yoursY = tester.getTopLeft(find.byKey(const Key('reserve-your-vote'))).dy;
    expect(yoursY, greaterThan(resultsY));
    await _dropShell(tester, funded.ledger);
  });

  // A vote is a leaf vote posted to a node (no local vote): the shell runs
  // with pool sync on, over a pool double that serves the live note set of
  // the real notes below and records each post. The lock is a real FS-1 π
  // lock, the census is the node block body that commits it, and the vote
  // fee is a second real note.
  testWidgets('Cast vote posts spendSeed and shows the submitted snack', (tester) async {
    final pool = SealedNotePool();
    final reserve = ShearReserve()..currentEpoch = 1;
    final funded = await fundedSplit(tester, 0, 10, extraOther: const [1], pool: pool, reserve: reserve);
    await depositSum(tester, '3.14159265358');
    expect(pool.posts.where((b) => b['kind'] == 'lock'), hasLength(1), reason: _snacks(tester));
    final lockHeight = funded.ledger.sealedHeight + 1;
    // The lock is mined at lockHeight: its hidden change enters the node's
    // live note set there, as it would on chain.
    final change = funded.ledger.lastSealedLock?['change'];
    expect(change, isA<Map>(), reason: 'the posted lock kept its change note');
    pool.addLive(Map<String, dynamic>.from(change as Map), lockHeight);
    funded.ledger.confirmRound(address: funded.other, pot: 0, height: lockHeight);
    final voteTip = lockHeight + ShearLedger.spendableConfirmations - 1;
    funded.ledger.noteLiveHeight(voteTip);
    funded.ledger.settleTo(voteTip);
    funded.ledger.rememberNodeChain(bodies: [
      {
        'height': 2,
        'txs': [
          {
            'coinbase': true,
            'epochCensusCommit': [
              {'epoch': 1, 'leafCount': 1, 'openHeight': 2},
            ],
          },
        ],
      },
    ]);
    await tester.pump();
    expect(find.text('Locked stake can vote'), findsOneWidget, reason: _snacks(tester));
    await tester.ensureVisible(find.byKey(const Key('reserve-vote-increase bonus')));
    await tester.tap(find.byKey(const Key('reserve-vote-increase bonus')));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const Key('reserve-vote-submit')));
    await tester.tap(find.byKey(const Key('reserve-vote-submit')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('reserve-vote-confirm')), findsOneWidget);
    final accept = tester.widget<FilledButton>(find.byKey(const Key('reserve-vote-confirm-accept')));
    final acceptChild = accept.child;
    expect(acceptChild, isA<Text>());
    expect((acceptChild as Text).data, 'CONFIRM');
    await tester.enterText(find.byKey(const Key('reserve-vote-confirm-field')), 'CONFIRM');
    await tester.pump();
    await tester.tap(find.byKey(const Key('reserve-vote-confirm-accept')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('reserve-vote-sign')), findsOneWidget);
    await tester.tap(find.byKey(const Key('reserve-vote-sign-accept')));
    await tester.pump();
    final submitted = find.text('Vote submitted — Your vote: increase bonus');
    final voteDeadline = DateTime.now().add(const Duration(seconds: 45));
    while (DateTime.now().isBefore(voteDeadline) && submitted.evaluate().isEmpty) {
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await tester.pump();
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
    final posted = pool.posts.where((b) => b['kind'] == 'leaf-vote').toList();
    expect(posted, hasLength(1), reason: 'one real leaf vote reached the node');
    expect(posted.single.containsKey('from'), isFalse);
    expect(posted.single['voteProof'], isNotNull);
    await _dropShell(tester, funded.ledger);
  });

  test('the device tunnel and extended scale client are gone', () {
    expect(leanContinuumVortices().any((v) => v.id == 'restore-privacy-v1'), isFalse);
    final activity = File('android/app/src/main/kotlin/com/shear/shear_wallet/MainActivity.kt').readAsStringSync();
    expect(activity.contains('VpnService'), isFalse);
    expect(activity.contains('privacy_hop'), isFalse);
    for (final path in [
      'windows/runner/flutter_window.cpp',
      'linux/runner/my_application.cc',
      'macos/Runner/MainFlutterWindow.swift',
      'android/app/src/main/AndroidManifest.xml',
    ]) {
      final text = File(path).readAsStringSync();
      expect(text.contains('privacy_hop'), isFalse, reason: path);
      expect(text.contains('77.42.91.84'), isFalse, reason: path);
      expect(text.contains('RPT'), isFalse, reason: path);
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
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ShearLedger(),
      startUnlocked: true,
      skipPoolSync: true,
    ));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('wallet-mode-local-node')), findsOneWidget);
    expect(find.text('P2P NODE'), findsOneWidget);
    await tester.tap(find.text('Closure'));
    await tester.pump();
    expect(find.byKey(const Key('settings-vpn-tunnel')), findsNothing);
    expect(find.byKey(const Key('closure-send-path-bare')), findsOneWidget);
    expect(find.byKey(const Key('closure-send-path-local')), findsOneWidget);
    expect(find.text('p2P Node'), findsOneWidget);
    expect(find.text('Full Node'), findsOneWidget);
    await tester.tap(find.text('Resistance'));
    await tester.pump();
    expect(find.byKey(const Key('resistance-vpn-console')), findsNothing);
    expect(find.text('VPN tunnel'), findsNothing);
    expect(find.text('Privacy hop'), findsNothing);
    expect(find.byKey(const Key('resistance-sync-height')), findsOneWidget);
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
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ShearLedger(),
      startUnlocked: true,
      skipPoolSync: true,
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
    expect(find.text('P2P NODE'), findsOneWidget);
    expect(find.byKey(const Key('resistance-node-console')), findsOneWidget);
    expect(find.byKey(const Key('resistance-sync-height')), findsOneWidget);
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
  });

  testWidgets('a restore-privacy vortice has no tunnel client', (tester) async {
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
          id: 'restore-privacy-v1',
          name: 'Restore Privacy',
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
    expect(find.text('Restore Privacy'), findsOneWidget);
    await tester.tap(find.text('Restore Privacy'));
    await tester.pump();
    expect(find.byKey(const Key('restore-privacy-pane')), findsNothing);
    expect(find.byKey(const Key('restore-privacy-traffic-shape')), findsNothing);
    expect(find.byKey(const Key('restore-privacy-obfuscation')), findsNothing);
    expect(find.text('IPv4 on'), findsNothing);
    expect(
      find.text('Third-party vortice cannot mint SHE; it must fund its own rewards.'),
      findsOneWidget,
    );
    expect(find.text('Privacy hop'), findsNothing);
  });
}

Future<({ShearSession session, ShearLedger ledger, ShearIdentity id, String home, String other})>
    fundedSplit(
  WidgetTester tester,
  double homeShe,
  double otherShe, {
  List<double> extraOther = const [],
  SealedNotePool? pool,
  ShearReserve? reserve,
}) async {
  tester.view.physicalSize = const Size(900, 2600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final dir = Directory.systemTemp.createTempSync('plate1-done-');
  addTearDown(() {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
  });
  final session = ShearSession(store: File('${dir.path}/session.json'));
  final ledger = ShearLedger(pool: pool);
  late ShearIdentity id;
  late String home;
  late String other;
  await tester.runAsync(() async {
    await session.loadOrCreate();
    await session.setPassword('test-pass-1');
    id = session.identity!;
    ledger.spendSeed = seedOf(id);
    if (pool != null) {
      // The user already chose the public node (first-run screen answered).
      session
        ..publicNodeConsent = true
        ..publicNodeChoiceMade = true;
    }
    ledger.bindIdentity(id);
    home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    other = ledger.allocateReceiveDest(id.address, paymentCode: id.paymentCode);
    if (homeShe > 0) _fund(ledger, id, home, homeShe, pool: pool);
    if (otherShe > 0) _fund(ledger, id, other, otherShe, pool: pool);
    for (final she in extraOther) {
      _fund(ledger, id, other, she, pool: pool);
    }
  });
  await tester.pumpWidget(ShearWalletApp(
    session: session,
    ledger: ledger,
    reserve: reserve,
    startUnlocked: true,
    skipPoolSync: pool == null,
  ));
  await tester.pump();
  await tester.pump();
  if (pool != null) {
    // With sync on the shell paints after the first (refused) reads return.
    final deadline = DateTime.now().add(const Duration(seconds: 30));
    while (find.text('Vortex').evaluate().isEmpty && DateTime.now().isBefore(deadline)) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      await tester.pump();
    }
    expect(find.text('Vortex'), findsWidgets,
        reason: 'the shell painted with sync on: ${tester.widgetList<Text>(find.byType(Text)).map((t) => t.data).join(' | ')}');
  }
  return (session: session, ledger: ledger, id: id, home: home, other: other);
}

Future<void> depositSum(WidgetTester tester, String amount, {bool consolidate = false}) async {
  await tester.tap(find.text('Vortex'));
  await tester.pump();
  await tester.pump();
  // A lock is exactly one π leaf: the amount is a fixed line, not a field.
  await tester.ensureVisible(find.byKey(const Key('reserve-amount')));
  expect(find.byType(TextField).evaluate().where((e) => e.widget.key == const Key('reserve-amount')), isEmpty);
  expect(tester.widget<Text>(find.byKey(const Key('reserve-amount'))).data, kReserveLockAmountLine);
  expect(kReserveLockAmountLine, contains(amount));
  await tester.ensureVisible(find.byKey(const Key('reserve-send')));
  expect(find.text(kReserveLockButton), findsOneWidget);
  await tester.tap(find.byKey(const Key('reserve-send')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  expect(find.byKey(const Key('reserve-sign')), findsOneWidget);
  await tester.tap(find.byKey(const Key('reserve-sign-accept')));
  await tester.pump();
  // With pool sync on the lock goes to a public node, which asks once.
  final consent = find.byKey(const Key('reserve-unprivate-accept'));
  if (consent.evaluate().isNotEmpty) {
    await tester.tap(consent);
    await tester.pump();
  }
  if (consolidate) {
    expect(find.byKey(const Key('reserve-deposit-progress')), findsOneWidget);
    expect(find.text('Consolidating Continuum notes for Deposit…'), findsOneWidget);
  }
  await tester.pump(const Duration(milliseconds: 50));
  await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 25)));
  await tester.pump();
}

String ledgerDest(ShearIdentity id) {
  final ledger = ShearLedger()..bindIdentity(id);
  return ledger.homeDest(id.address, paymentCode: id.paymentCode);
}

/// One real sealed note of [she] on [dest], mined at height 1 and read at
/// tip 1 + 9: Spendable is exactly the notes, never a round credit.
void _fund(ShearLedger ledger, ShearIdentity id, String dest, double she, {SealedNotePool? pool}) {
  final note = sealedNoteOn(dest, seedOf(id), (she * kUnitsPerShe).round(), height: 1);
  ledger.rememberNote(note);
  pool?.addLive(note, 1);
  final tip = 1 + ShearLedger.spendableConfirmations;
  ledger.noteLiveHeight(tip);
  ledger.settleTo(tip);
  ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
}

/// Every SnackBar text on screen, for a failure reason.
String _snacks(WidgetTester tester) => tester
    .widgetList<SnackBar>(find.byType(SnackBar))
    .map((s) {
      final c = s.content;
      return c is Text ? (c.data ?? c.textSpan?.toPlainText() ?? '') : c.toString();
    })
    .join(' | ');

Future<void> _dropShell(WidgetTester tester, ShearLedger ledger) async {
  ledger.pool?.close();
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 1)));
  await tester.pump(const Duration(seconds: 12));
}

/// Pumps fake and real time (an isolate seal, a pool round trip) until [f]
/// is on screen, as shear_wallet_test's _waitUntil does.
Future<void> _waitFor(WidgetTester tester, Finder f) async {
  final deadline = DateTime.now().add(const Duration(seconds: 60));
  while (DateTime.now().isBefore(deadline)) {
    await tester.pump();
    if (f.evaluate().isNotEmpty) return;
    await tester.pump(const Duration(milliseconds: 50));
    if (f.evaluate().isNotEmpty) return;
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
  }
  expect(f, findsWidgets, reason: _snacks(tester));
}
