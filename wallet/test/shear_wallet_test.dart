import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_lock.dart';
import 'package:shear_wallet/shear_session.dart';
import 'package:shear_wallet/shear_hash.dart';
import 'package:shear_wallet/shear_pack.dart';
import 'package:shear_wallet/shear_shewall.dart';
import 'package:shear_wallet/shear_theme.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_ctf_cli.dart';
import 'package:shear_wallet/shear_vortex.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_join.dart';
import 'package:shear_wallet/shear_confirm_pie.dart';
import 'package:shear_wallet/shear_export.dart';
import 'package:shear_wallet/shear_biometrics.dart';
import 'package:shear_wallet/shear_qr.dart';
import 'package:shear_wallet/shear_social.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_levy.dart';
import 'package:crypto/crypto.dart';

const kGatePassword = 'correct-horse';

Future<void> _sealSession(WidgetTester tester, ShearSession session) async {
  await tester.runAsync(() async {
    await session.loadOrCreate();
    await session.setPassword(kGatePassword);
  });
}

Future<void> _unlockUi(WidgetTester tester) async {
  await tester.enterText(find.byType(TextField).first, kGatePassword);
  await tester.tap(find.text('Unlock'));
  await tester.pump();
  await tester.runAsync(() async {
    await Future<void>.delayed(const Duration(seconds: 2));
  });
  await tester.pump();
}

void _tallContinuum(WidgetTester tester) {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  test('release AndroidManifest grants INTERNET; debug/profile overlays are not the shipped grant', () {
    final main = File('android/app/src/main/AndroidManifest.xml');
    final debug = File('android/app/src/debug/AndroidManifest.xml');
    final profile = File('android/app/src/profile/AndroidManifest.xml');
    expect(main.existsSync(), isTrue);
    expect(debug.existsSync(), isTrue);
    expect(profile.existsSync(), isTrue);
    final grant = RegExp(r'<uses-permission\s+android:name="android\.permission\.INTERNET"\s*/>');
    expect(grant.hasMatch(main.readAsStringSync()), isTrue,
        reason: 'packaged APKs merge the main manifest; INTERNET only in debug/profile does not ship');
    final debugEnt = File('macos/Runner/DebugProfile.entitlements').readAsStringSync();
    final relEnt = File('macos/Runner/Release.entitlements').readAsStringSync();
    expect(debugEnt.contains('com.apple.security.network.client'), isTrue);
    expect(relEnt.contains('com.apple.security.network.client'), isTrue);
    expect(relEnt.contains('com.apple.security.device.camera'), isTrue);
    expect(debugEnt.contains('com.apple.security.device.camera'), isTrue);
    expect(main.readAsStringSync().contains('android:label="Shear 0.16"'), isTrue);
    expect(relEnt.contains('com.apple.security.device.biometry'), isTrue);
    expect(debugEnt.contains('com.apple.security.device.biometry'), isTrue);
    expect(main.readAsStringSync().contains('android.permission.CAMERA'), isTrue);
    final winMain = File('windows/runner/main.cpp').readAsStringSync();
    final winRc = File('windows/runner/Runner.rc').readAsStringSync();
    final linuxApp = File('linux/runner/my_application.cc').readAsStringSync();
    expect(winMain.contains('L"Shear 0.16"'), isTrue);
    expect(winMain.contains('Shear 0.6'), isFalse);
    expect(winRc.contains('"Shear 0.16"'), isTrue);
    expect(winRc.contains('Shear 0.7'), isFalse);
    expect(linuxApp.contains('"Shear 0.16"'), isTrue);
    expect(linuxApp.contains('Shear 0.6'), isFalse);
    final activity = File('android/app/src/main/kotlin/com/shear/shear_wallet/MainActivity.kt').readAsStringSync();
    expect(activity.contains('FlutterFragmentActivity'), isTrue);
    expect(activity.contains('FlutterActivity()'), isFalse);
    expect(main.path.contains('${Platform.pathSeparator}debug${Platform.pathSeparator}'), isFalse);
    expect(main.path.contains('${Platform.pathSeparator}profile${Platform.pathSeparator}'), isFalse);
  });

  test('new identity is shear1 with a stable view key after persist/reload', () async {
    final dir = Directory.systemTemp.createTempSync('shear-sess-');
    final store = File('${dir.path}/session.json');
    final s1 = ShearSession(store: store);
    final a = (await s1.loadOrCreate())!;
    await s1.setPassword(kGatePassword);
    expect(a.address.startsWith('shear1'), isTrue);
    expect(isShearAddress(a.address), isTrue);
    expect(a.paymentCode.startsWith('she1'), isTrue);
    expect(a.paymentCode.length < 50, isTrue);
    expect(isPaymentCode(a.paymentCode), isTrue);
    expect(isDestAddress(a.paymentCode), isFalse);
    expect(a.viewKey.isNotEmpty, isTrue);
    final s2 = ShearSession(store: store);
    expect(await s2.loadOrCreate(), isNull);
    expect(s2.needsUnlock, isTrue);
    await expectLater(s2.unlock('wrong-password'), throwsA(isA<FormatException>()));
    await expectLater(s2.unlock(''), throwsA(isA<FormatException>()));
    final b = await s2.unlock(kGatePassword);
    expect(b.address, a.address);
    expect(b.viewKey, a.viewKey);
    expect(b.paymentCode, a.paymentCode);
  });

  test('wallet stays lean: thousands of hashes never become thousands of txs', () {
    final id = createIdentity();
    final ledger = ShearLedger();
    ledger.creditHash(id.address, hashes: 4000);
    expect(ledger.pending(id.address), closeTo(4000 * kHashBonusShe, 1e-18));
    expect(ledger.spendable(id.address), 0);
    expect(ledger.pendingTxs(id.address), isEmpty);
    expect(ledger.transactions.where((t) => t.kind == 'hash').length, 1);
    expect(ledger.transactions.where((t) => t.kind == 'sample'), isEmpty);
    final fatDump = jsonEncode(exportShewall(identity: id, ledger: ledger));
    expect(fatDump.contains('"kind":"sample"'), isFalse);
    expect(utf8.encode(fatDump).length < 4000, isTrue);
    ledger.confirmRound(address: id.address, pot: 1, height: 7);
    expect(ledger.transactions.where((t) => t.kind == 'hash'), isEmpty);
    expect(ledger.transactions.length, 1);
    expect(ledger.pending(id.address), 0);
    expect(ledger.spendable(id.address), 0);
    expect(ledger.pendingTxs(id.address).single.kind, 'blockfound');
    ledger.settleTo(7 + ShearLedger.spendableConfirmations - 1);
    expect(ledger.pendingTxs(id.address), isEmpty);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(1 + 4000 * kHashBonusShe, 1e-18));
    ledger.prune();
    expect(ledger.transactions.length, 1);
    expect(ledger.shearviewTxs(id.address).length, 1);
  });

  test('pending hashes are not spendable until block found; explorer lists confirmed round', () {
    final id = createIdentity();
    final ledger = ShearLedger();
    ledger.creditHash(id.address, hashes: 4);
    expect(ledger.pending(id.address), closeTo(4 * kHashBonusShe, 1e-18));
    expect(ledger.spendable(id.address), 0);
    expect(ledger.pendingTxs(id.address), isEmpty);
    expect(ledger.ownerHistory(id.address), isEmpty);
    ledger.confirmRound(address: id.address, pot: 1, height: 3);
    expect(ledger.pending(id.address), 0);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
    expect(ledger.pendingTxs(id.address).where((t) => t.kind == 'hash'), isEmpty);
    expect(ledger.pendingTxs(id.address).any((t) => t.kind == 'blockfound'), isTrue);
    expect(ledger.shearviewTxs(id.address), isEmpty);
    ledger.settleTo(3 + ShearLedger.spendableConfirmations - 1);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(1 + 4 * kHashBonusShe, 1e-18));
    expect(ledger.ownerHistory(id.address).single.confirmed, isTrue);
    expect(ledger.ownerHistory(id.address).single.amount, closeTo(1 + 4 * kHashBonusShe, 1e-18));
    expect(ledger.pendingTxs(id.address), isEmpty);
    expect(ledger.shearviewTxs(id.address).single.amount, closeTo(1 + 4 * kHashBonusShe, 1e-18));
  });

  test('unconfirmed send is pending until the next block is found', () async {
    final id = createIdentity();
    final ledger = ShearLedger()..viewSecret = id.viewKey;
    final dest = ledger.currentDest(id.address);
    ledger.confirmRound(address: id.address, pot: 1, height: 2);
    ledger.settleTo(2 + ShearLedger.spendableConfirmations - 1);
    expect(ledger.sealedHeight, 2 + ShearLedger.spendableConfirmations - 1);
    expect(ledger.pendingTxs(id.address).where((t) => t.kind == 'send'), isEmpty);
    final bob = destForLogin(createIdentity().address, height: 1, viewKey: 'ab' * 32)!;
    final sent = await ledger.send(from: dest, to: bob, amount: 0.25);
    expect(sent.confirmed, isFalse);
    expect(ledger.pendingTxs(id.address).where((t) => t.id == sent.id).length, 1);
    ledger.confirmRound(address: id.address, pot: 1, height: 3);
    expect(ledger.pendingTxs(id.address).any((t) => t.id == sent.id), isTrue);
    expect(ledger.shearviewTxs(id.address).where((t) => t.id == sent.id), isEmpty);
    ledger.settleTo(3 + ShearLedger.spendableConfirmations - 1);
    expect(ledger.ownerHistory(id.address).where((t) => t.id == sent.id).single.confirmed, isTrue);
    expect(ledger.pendingTxs(id.address), isEmpty);
    expect(ledger.shearviewTxs(id.address).where((t) => t.id == sent.id).single.confirmed, isTrue);
    expect(ledger.sealedHeight, 3 + ShearLedger.continuumConfirmations - 1);
  });

  test('live pending hashes and receives become spendable on block-found', () {
    final id = createIdentity();
    final ledger = ShearLedger()..viewSecret = id.viewKey;
    final dest = ledger.currentDest(id.address);
    ledger.creditHash(id.address, hashes: 7);
    final peer = createIdentity();
    final from = destForLogin(peer.address, height: 1, viewKey: peer.viewKey)!;
    ledger.creditReceive(to: dest, amount: 0.4, from: from, id: 'in-1');
    expect(ledger.pendingTxs(id.address).any((t) => t.kind == 'hash'), isFalse);
    expect(ledger.pendingTxs(id.address).any((t) => t.kind == 'receive' && t.id == 'in-1'), isTrue);
    expect(ledger.spendable(id.address), 0);
    expect(ledger.pending(id.address), closeTo(0.4 + 7 * kHashBonusShe, 1e-18));
    ledger.confirmRound(address: id.address, pot: 0.1, height: 9);
    expect(ledger.pendingTxs(id.address).where((t) => t.kind == 'hash'), isEmpty);
    expect(ledger.pendingTxs(id.address).any((t) => t.id == 'in-1'), isTrue);
    expect(ledger.pending(id.address), 0);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
    expect(ledger.transactions.where((t) => t.kind == 'hash'), isEmpty);
    ledger.settleTo(9 + ShearLedger.spendableConfirmations - 1);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(0.1 + 0.4 + 7 * kHashBonusShe, 1e-18));
    expect(ledger.ownerHistory(id.address).any((t) => t.kind == 'blockfound' && t.confirmed), isTrue);
    expect(ledger.ownerHistory(id.address).where((t) => t.id == 'in-1').single.confirmed, isTrue);
    expect(ledger.pendingTxs(id.address), isEmpty);
    expect(ledger.shearviewTxs(id.address).any((t) => t.id == 'in-1'), isTrue);
  });

  test('syncCredits ingests pool incoming+hash pending and confirmRound on tip advance', () async {
    final id = createIdentity();
    final header = Uint8List(128);
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final live = _PoolLive(headerHex: hex, height: 3, balance: 0, pending: 7 * kHashBonusShe);
    final peer = createIdentity();
    final from = destForLogin(peer.address, height: 1, viewKey: peer.viewKey)!;
    final server = await _fakePool(live: live);
    addTearDown(() => server.close(force: true));
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _realHttp());
    final ledger = ShearLedger(pool: pool)..viewSecret = id.viewKey;
    ledger.applyTipHex(hex, sealedHeight: 3);
    final dest = ledger.currentDest(id.address);
    live.owner = dest;
    live.incoming = [
      {'id': 'in-1', 'from': from, 'to': dest, 'amount': 0.4, 'kind': 'receive', 'confirmed': false},
    ];
    await ledger.syncCredits(id.address, paymentCode: id.paymentCode);
    expect(ledger.sealedHeight, 3);
    expect(ledger.pendingTxs(id.address).any((t) => t.kind == 'hash'), isFalse);
    expect(ledger.pendingTxs(id.address).any((t) => t.kind == 'receive' && t.id == 'in-1'), isTrue);
    expect(ledger.spendable(id.address), 0);
    live.height = 9;
    live.pending = 0;
    live.incoming = [];
    live.balance = 0.1 + 0.4 + 7 * kHashBonusShe;
    await ledger.syncCredits(id.address, paymentCode: id.paymentCode);
    expect(ledger.pendingTxs(id.address).where((t) => t.kind == 'hash'), isEmpty);
    expect(ledger.pending(id.address), 0);
    expect(
      ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(0.1 + 0.4 + 7 * kHashBonusShe, 1e-18),
    );
    expect(ledger.ownerHistory(id.address).where((t) => t.id == 'in-1').single.confirmed, isTrue);
    ledger.settleTo(9 + ShearLedger.continuumConfirmations - 1);
    expect(ledger.pendingTxs(id.address), isEmpty);
  });

  test('first-boot syncCredits loads reconstructed spendable; open round stays pending', () async {
    final id = createIdentity();
    final header = Uint8List(128);
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    const reconstructed = 1.5;
    final live = _PoolLive(
      headerHex: hex,
      height: 40,
      balance: reconstructed,
      pending: 7 * kHashBonusShe,
    );
    final peer = createIdentity();
    final from = destForLogin(peer.address, height: 1, viewKey: peer.viewKey)!;
    final silent = payoutDest(id.paymentCode)!;
    live.owner = silent;
    live.incoming = [
      {'id': 'in-boot', 'from': from, 'to': silent, 'amount': 0.4, 'kind': 'receive', 'confirmed': false},
    ];
    final server = await _fakePool(live: live);
    addTearDown(() => server.close(force: true));
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _realHttp());
    final ledger = ShearLedger(pool: pool)..viewSecret = id.viewKey;
    expect(ledger.sealedHeight, 0);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);

    await ledger.syncCredits(id.address, paymentCode: id.paymentCode);

    expect(ledger.sealedHeight, 40);
    expect(
      ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(reconstructed, 1e-18),
    );
    expect(ledger.pendingTxs(id.address).any((t) => t.kind == 'hash'), isFalse);
    expect(ledger.pendingTxs(id.address).any((t) => t.kind == 'receive' && t.id == 'in-boot'), isTrue);
    expect(ledger.pending(id.paymentCode), closeTo(0.4 + 7 * kHashBonusShe, 1e-18));
    expect(ledger.syncDests(id.address, paymentCode: id.paymentCode).length < 8, isTrue);
    expect(live.balanceHits < 8, isTrue);
    expect(live.balanceHits > 0, isTrue);

    live.height = 41;
    live.pending = 0;
    live.incoming = [];
    live.balance = reconstructed + 0.4 + 7 * kHashBonusShe;
    await ledger.syncCredits(id.address, paymentCode: id.paymentCode);
    expect(ledger.pendingTxs(id.address).where((t) => t.kind == 'hash'), isEmpty);
    expect(ledger.pending(id.address), 0);
    expect(ledger.pendingTxs(id.address).any((t) => t.id == 'in-boot'), isTrue);
    expect(
      ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(reconstructed + 0.4 + 7 * kHashBonusShe, 1e-18),
    );
    ledger.settleTo(ledger.sealedHeight + ShearLedger.continuumConfirmations - 1);
    expect(ledger.pendingTxs(id.address), isEmpty);
  });

  test('syncCredits still settles after syncTip painted a newer height', () async {
    final id = createIdentity();
    final header = Uint8List(128);
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    const reconstructed = 1.5;
    final live = _PoolLive(
      headerHex: hex,
      height: 12,
      balance: reconstructed,
      pending: 7 * kHashBonusShe,
    );
    final peer = createIdentity();
    final from = destForLogin(peer.address, height: 1, viewKey: peer.viewKey)!;
    final silent = payoutDest(id.paymentCode)!;
    live.owner = silent;
    live.incoming = [
      {'id': 'in-tip', 'from': from, 'to': silent, 'amount': 0.4, 'kind': 'receive', 'confirmed': false},
    ];
    final server = await _fakePool(live: live);
    addTearDown(() => server.close(force: true));
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _realHttp());
    final ledger = ShearLedger(pool: pool)..viewSecret = id.viewKey;
    await ledger.syncCredits(id.address, paymentCode: id.paymentCode);
    expect(ledger.sealedHeight, 12);
    expect(ledger.settledHeight, 12);
    expect(ledger.pendingTxs(id.address).any((t) => t.kind == 'hash'), isFalse);
    expect(ledger.pendingTxs(id.address).any((t) => t.id == 'in-tip'), isTrue);
    expect(
      ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(reconstructed, 1e-18),
    );

    live.height = 13;
    live.pending = 0;
    live.incoming = [];
    live.balance = reconstructed + 0.4 + 7 * kHashBonusShe;
    await ledger.syncTip();
    expect(ledger.sealedHeight, 13);
    expect(ledger.pendingTxs(id.address).where((t) => t.kind == 'hash'), isEmpty);
    expect(ledger.pendingTxs(id.address).any((t) => t.id == 'in-tip'), isTrue);

    await ledger.syncCredits(id.address, paymentCode: id.paymentCode);
    expect(ledger.pending(id.paymentCode), 0);
    expect(ledger.pendingTxs(id.address).any((t) => t.id == 'in-tip'), isTrue);
    expect(
      ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(reconstructed + 0.4 + 7 * kHashBonusShe, 1e-18),
    );
    ledger.settleTo(ledger.sealedHeight + ShearLedger.continuumConfirmations - 1);
    expect(ledger.pendingTxs(id.address), isEmpty);
  });

  test('syncTip paints pool height without waiting for credit sync', () async {
    final id = createIdentity();
    final header = Uint8List(128);
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final live = _PoolLive(headerHex: hex, height: 3908, balance: 1.5);
    final server = await _fakePool(live: live);
    addTearDown(() => server.close(force: true));
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _realHttp());
    final ledger = ShearLedger(pool: pool)..viewSecret = id.viewKey;
    expect(ledger.sealedHeight, 0);
    await ledger.syncTip();
    expect(ledger.sealedHeight, 3908);
    live.height = 3910;
    await ledger.syncTip();
    expect(ledger.sealedHeight, 3910);
    expect(ledger.syncDests(id.address, paymentCode: id.paymentCode).length < 8, isTrue);
  });

  test('syncCredits dests stay a small constant at a high pool tip, not O(height)', () async {
    final id = createIdentity();
    final header = Uint8List(128);
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    const reconstructed = 1.5;
    const tip = 3908;
    final live = _PoolLive(
      headerHex: hex,
      height: tip,
      balance: reconstructed,
      pending: 7 * kHashBonusShe,
    );
    final silent = payoutDest(id.paymentCode)!;
    live.owner = silent;
    final server = await _fakePool(live: live);
    addTearDown(() => server.close(force: true));
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _realHttp());
    final ledger = ShearLedger(pool: pool)..viewSecret = id.viewKey;
    await ledger.syncCredits(id.address, paymentCode: id.paymentCode);
    expect(ledger.sealedHeight, tip);
    expect(
      ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(reconstructed, 1e-18),
    );
    expect(ledger.pending(id.paymentCode), closeTo(7 * kHashBonusShe, 1e-18));
    final dests = ledger.syncDests(id.address, paymentCode: id.paymentCode);
    expect(dests.length < 8, isTrue);
    expect(dests.isNotEmpty, isTrue);
    expect(live.balanceHits < 8, isTrue);
    expect(live.balanceHits > 0, isTrue);
    expect(live.balanceHits, lessThan(tip));
  });

  test('applyPoolSnapshot first boot does not wait for a local sealed height', () {
    final id = createIdentity();
    final ledger = ShearLedger()..viewSecret = id.viewKey;
    final dest = ledger.currentDest(id.address);
    expect(ledger.sealedHeight, 0);
    ledger.applyTipHex(List.filled(240, '0').join(), sealedHeight: 8);
    expect(ledger.sealedHeight, 8);
    final fresh = ShearLedger()..viewSecret = id.viewKey;
    expect(fresh.sealedHeight, 0);
    fresh.applyPoolSnapshot(
      dest,
      {
        'balance': 2.25,
        'pending': 5 * kHashBonusShe,
        'incoming': [
          {'id': 'in-snap', 'from': dest, 'to': dest, 'amount': 0.2, 'kind': 'receive', 'confirmed': false},
        ],
      },
      beforeHeight: 0,
      tipSealed: 8,
    );
    expect(fresh.spendable(dest), closeTo(2.25, 1e-18));
    expect(fresh.pendingTxs(dest).any((t) => t.kind == 'hash'), isFalse);
    expect(fresh.pendingTxs(dest).any((t) => t.id == 'in-snap'), isTrue);
    expect(fresh.pending(dest), closeTo(0.2 + 5 * kHashBonusShe, 1e-18));
  });

  test('consensus spendable at 6 confirmations; min_confirms 12 is third-party policy', () {
    expect(ShearLedger.spendableConfirmations, 6);
    expect(ShearLedger.continuumConfirmations, 6);
    expect(ShearLedger.minConfirms, 12);
    final id = createIdentity();
    final ledger = ShearLedger();
    ledger.confirmRound(address: id.address, pot: 1, height: 1);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
    ledger.settleTo(5);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
    ledger.settleTo(6);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 1);
    expect(ledger.policyAvailable(id.address, paymentCode: id.paymentCode), 0);
    ledger.settleTo(12);
    expect(ledger.policyAvailable(id.address, paymentCode: id.paymentCode), 1);
  });

  test('getpolicy freeze holds Continuum pending past 6; reorg bounces rows', () {
    final id = createIdentity();
    final ledger = ShearLedger();
    expect(ledger.confirmedNeed, 30);
    ledger.applyPolicy({
      'frozen': true,
      'operational': {'pool_merchant': 30, 'join_mark_paid': 200},
    });
    expect(ledger.creditsFrozen, isTrue);
    ledger.confirmRound(address: id.address, pot: 1, height: 1);
    ledger.settleTo(12);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
    ledger.applyPolicy({'frozen': false, 'operational': {'pool_merchant': 30}});
    ledger.settleTo(12);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 1);
    ledger.bounceHeights([1]);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), lessThan(1));
  });

  test('shewall.bin password seal restores address and balances; JSON refused', () async {
    final id = createIdentity();
    final ledger = ShearLedger();
    ledger.creditHash(id.address, hashes: 2);
    ledger.confirmRound(address: id.address, pot: 1, height: 1);
    ledger.settleTo(1 + ShearLedger.spendableConfirmations);
    const pw = 'correct-horse';
    final packed = exportShewall(identity: id, ledger: ledger);
    expect(packed[0], isNot(0x7b));
    final env = await sealShewallBin(packed, pw);
    expect(utf8.decode(env.sublist(0, shewallEncKind.length)), shewallEncKind);
    final opened = await openShewallBin(env, pw);
    final ledger2 = ShearLedger();
    final id2 = importShewall(opened, ledger2);
    expect(id2.address, id.address);
    expect(id2.viewKey, id.viewKey);
    expect(ledger2.spendable(id.address), closeTo(1 + 2 * kHashBonusShe, 1e-12));
    expect(ledger2.ownerHistory(id.address), isNotEmpty);
    expect(() => unpackShewall(Uint8List.fromList(utf8.encode('{"kind":"json"}'))), throwsA(anything));
    await expectLater(openShewallBin(env, 'wrong'), throwsA(anything));
    final dest = File('${Directory.systemTemp.createTempSync('shear-export-').path}/$shewallName');
    await exportEncryptedShewall(identity: id, ledger: ledger, password: pw, dest: dest);
    expect(isTempOnlyShewallPath(dest.path), isFalse);
    expect(dest.path.endsWith(shewallName), isTrue);
    final id3 = await importEncryptedShewall(src: dest, password: pw, ledger: ShearLedger());
    expect(id3.address, id.address);
    await expectLater(
      importEncryptedShewall(src: dest, password: 'nope-nope', ledger: ShearLedger()),
      throwsA(anything),
    );
  });

  test('first-run setPassword seals session; wrong password never unlocks', () async {
    final dir = Directory.systemTemp.createTempSync('shear-gate-');
    final store = File('${dir.path}/session.json');
    final s = ShearSession(store: store);
    await s.loadOrCreate();
    expect(s.needsPasswordSet, isTrue);
    await expectLater(s.setPassword('short'), throwsA(isA<FormatException>()));
    await expectLater(s.setPassword('correct-horse', confirm: 'other-horse'), throwsA(isA<FormatException>()));
    await s.setPassword('correct-horse', confirm: 'correct-horse');
    expect(s.sealed, isTrue);
    expect(jsonDecode(store.readAsStringSync())['kind'], 'shear-shewall-v1-enc');
    final locked = ShearSession(store: store);
    await locked.loadOrCreate();
    expect(locked.needsUnlock, isTrue);
    await expectLater(locked.unlock('not-the-password'), throwsA(isA<FormatException>()));
    final opened = await locked.unlock('correct-horse');
    expect(opened.address, s.identity!.address);
  });

  test('MemoryBiometrics stores password for convenience only; shewall still needs it', () async {
    final bio = MemoryBiometrics();
    expect(await bio.available, isTrue);
    await bio.rememberPassword(kGatePassword);
    expect(await bio.recalledPassword(), kGatePassword);
    bio.passAuth = false;
    expect(await bio.authenticate(), isFalse);
    bio.passAuth = true;
    expect(await bio.authenticate(), isTrue);
    expect(shearAuthOptions(macos: true).biometricOnly, isFalse);
    expect(shearAuthOptions(macos: false).biometricOnly, isTrue);
  });

  test('encodeReceiveQr is she1; parseReceiveQr accepts she1, ssa1, shear: prefix, rejects junk', () {
    final id = createIdentity();
    expect(id.paymentCode.startsWith('she1'), isTrue);
    expect(encodeReceiveQr(id.paymentCode), id.paymentCode);
    expect(parseReceiveQr(id.paymentCode), id.paymentCode);
    expect(parseReceiveQr('shear:${id.paymentCode}'), id.paymentCode);
    expect(parseReceiveQr('  shear:${id.paymentCode}  '), id.paymentCode);
    final dest = destForLogin(id.address, height: 1, viewKey: id.viewKey)!;
    expect(dest.startsWith('ssa1'), isTrue);
    expect(parseReceiveQr(dest), dest);
    expect(parseReceiveQr('shear:$dest'), dest);
    expect(parseReceiveQr('not-a-qr'), isNull);
    expect(parseReceiveQr(id.address), isNull);
    expect(parseReceiveQr(''), isNull);
  });

  test('new session biometrics default off; persist only stores true', () async {
    final dir = Directory.systemTemp.createTempSync('shear-bio-def-');
    final s = ShearSession(store: File('${dir.path}/session.json'));
    await s.loadOrCreate();
    expect(s.biometricsEnabled, isFalse);
    await s.setPassword(kGatePassword);
    final loadedOff = ShearSession(store: s.store);
    await loadedOff.loadOrCreate();
    final openedOff = await loadedOff.unlock(kGatePassword);
    expect(openedOff.address, s.identity!.address);
    expect(loadedOff.biometricsEnabled, isFalse);
    s.biometricsEnabled = true;
    await s.persist();
    final lockedOn = ShearSession(store: s.store);
    await lockedOn.loadOrCreate();
    expect(lockedOn.identity, isNull);
    expect(lockedOn.biometricsEnabled, isTrue);
    final loadedOn = ShearSession(store: s.store);
    await loadedOn.loadOrCreate();
    await loadedOn.unlock(kGatePassword);
    expect(loadedOn.biometricsEnabled, isTrue);
  });

  test('export dest is Downloads or Documents, never systemTemp/shewall.bin alone', () {
    final dest = defaultShewallExportFile(
      home: '/Users/tester',
      existsDir: (path) => path.endsWith('Downloads'),
      android: false,
      windows: false,
      ios: false,
    );
    expect(dest, isNotNull);
    expect(dest!.path, '/Users/tester/Downloads/shewall.bin');
    expect(isTempOnlyShewallPath(dest.path), isFalse);
    expect(dest.path.contains('Downloads') || dest.path.contains('Documents'), isTrue);
    final docs = defaultShewallExportFile(
      home: '/Users/tester',
      existsDir: (_) => false,
      android: false,
      windows: false,
      ios: false,
    );
    expect(docs!.path, '/Users/tester/Documents/shewall.bin');
    expect(isTempOnlyShewallPath(File('${Directory.systemTemp.path}/$shewallName').path), isTrue);
    expect(defaultShewallExportFile(android: true), isNull);
    expect(isPrivateAndroidFilesPath('/data/user/0/com.shear.shear_wallet/files/shewall.bin'), isTrue);
  });

  test('saveShewallBytes writes injected dest; picker cancel is export_cancelled', () async {
    final dest = File('${Directory.systemTemp.createTempSync('shear-save-').path}/Documents/$shewallName');
    final path = await saveShewallBytes(Uint8List.fromList([1, 2, 3, 4]), dest: dest);
    expect(path, dest.path);
    expect(dest.existsSync(), isTrue);
    expect(isTempOnlyShewallPath(path), isFalse);
    await expectLater(
      saveShewallBytes(Uint8List.fromList([1]), picker: ({bytes}) async => null),
      throwsA(isA<FormatException>()),
    );
  });

  test('desktop save picker must not pass bytes; always overwrite the returned path', () async {
    expect(shewallSavePassesBytes(android: false, ios: false), isFalse);
    expect(shewallSavePassesBytes(android: true, ios: false), isTrue);
    expect(shewallSavePassesBytes(android: false, ios: true), isTrue);
    final dir = Directory.systemTemp.createTempSync('shear-save-desk-');
    final dest = File('${dir.path}/Documents/$shewallName');
    dest.parent.createSync(recursive: true);
    dest.writeAsBytesSync(Uint8List.fromList([9, 9, 9, 9, 9]));
    Uint8List? seen;
    Future<String?> macosLike({Uint8List? bytes}) async {
      seen = bytes;
      if (bytes != null) throw UnsupportedError('Bytes are not supported on macOS');
      return dest.path;
    }

    final sealed = Uint8List.fromList([1, 2, 3, 4, 5, 6, 7, 8]);
    final path = await saveShewallBytes(sealed, picker: macosLike, passBytes: false);
    expect(path, dest.path);
    expect(seen, isNull);
    expect(dest.readAsBytesSync(), sealed);

    await expectLater(
      saveShewallBytes(sealed, picker: macosLike, passBytes: true),
      throwsA(isA<UnsupportedError>()),
    );
  });

  test('mobile save picker passes bytes and does not File-overwrite the SAF dest', () async {
    final dest = File('${Directory.systemTemp.createTempSync('shear-save-mob-').path}/$shewallName');
    dest.writeAsBytesSync(Uint8List.fromList([9, 9, 9]));
    Uint8List? seen;
    final sealed = Uint8List.fromList([1, 2, 3, 4]);
    final path = await saveShewallBytes(
      sealed,
      picker: ({bytes}) async {
        seen = bytes;
        return dest.path;
      },
      passBytes: true,
    );
    expect(path, dest.path);
    expect(seen, sealed);
    expect(dest.readAsBytesSync(), Uint8List.fromList([9, 9, 9]));
  });

  test('fresh device importEncryptedShewall restores identity then setPassword seals session', () async {
    final id = createIdentity();
    final ledger = ShearLedger();
    ledger.confirmRound(address: id.address, pot: 1, height: 1);
    ledger.settleTo(1 + ShearLedger.spendableConfirmations);
    final backup = File('${Directory.systemTemp.createTempSync('shear-imp-').path}/$shewallName');
    await exportEncryptedShewall(identity: id, ledger: ledger, password: kGatePassword, dest: backup);
    final freshDir = Directory.systemTemp.createTempSync('shear-fresh-');
    final fresh = ShearSession(store: File('${freshDir.path}/session.json'));
    expect(await fresh.loadOrCreate(), isNotNull);
    expect(fresh.identity!.address, isNot(id.address));
    final restoredLedger = ShearLedger();
    final restored = await importEncryptedShewall(src: backup, password: kGatePassword, ledger: restoredLedger);
    expect(restored.address, id.address);
    fresh.identity = restored;
    await fresh.setPassword(kGatePassword);
    final again = ShearSession(store: File('${freshDir.path}/session.json'));
    await again.loadOrCreate();
    final unlocked = await again.unlock(kGatePassword);
    expect(unlocked.address, id.address);
  });

  test('CTF dest is she1 with password C, not C-from-S', () {
    final a = createIdentity();
    final b = createIdentity();
    expect(destForLogin(a.address, height: 1), isNull);
    final paid = destForLogin(a.address, height: 1, viewKey: a.viewKey)!;
    expect(destHrp, 'ssa');
    expect(paid.startsWith('ssa1'), isTrue);
    expect(paid.startsWith('she1'), isFalse);
    expect(paid.startsWith('shear1'), isFalse);
    expect(isDestAddress(paid), isTrue);
    final she = encodeHrp('she', Uint8List.fromList(List.filled(20, 7)));
    expect(she.startsWith('she1'), isTrue);
    expect(isDestAddress(she), isFalse);
    expect(isPaymentCode(she), isTrue);
    expect(a.paymentCode.startsWith('she1'), isTrue);
    expect(isPaymentCode(a.paymentCode), isTrue);
    expect(isDestAddress(a.paymentCode), isFalse);
    final sheMine = destForLogin(a.paymentCode)!;
    expect(sheMine.startsWith('ssa1'), isTrue);
    expect(sheMine.startsWith('she1'), isFalse);
    expect(sheMine, isNot(a.paymentCode));
    expect(payoutDest(a.paymentCode), sheMine);
    final mined = ShearLedger();
    mined.viewSecret = a.viewKey;
    expect(mined.ownedAddresses(a.address, paymentCode: a.paymentCode), contains(sheMine));
    expect(mined.ownedAddresses(a.address, paymentCode: a.paymentCode).contains(a.paymentCode), isFalse);
    expect(isShearAddress(a.paymentCode), isFalse);
    expect(a.paymentCode.length < 50, isTrue);
    const viewKey = 'abababababababababababababababababababababababababababababababab';
    final hash20 = Uint8List.fromList(List.filled(20, 7));
    final p0 = paymentCodeAtIndex(viewKey, hash20, 0)!;
    expect(p0.startsWith('she1'), isTrue);
    expect(p0.length < 50, isTrue);
    expect(isPaymentCode(p0), isTrue);
    expect(p0, paymentCodeAtIndex(viewKey, hash20, 0));
    expect(paymentCodeAtIndex(viewKey, hash20, 1), isNot(paymentCodeAtIndex(viewKey, hash20, 0)));
    expect(isPaymentCode(paymentCodeAtIndex(viewKey, hash20, 2)!), isTrue);
    expect(isDestAddress(a.address), isFalse);
    expect(paid, isNot(a.address));
    expect(paid, isNot(degenerateDest(a.address, height: 1)));
    expect(destForLogin(a.address, height: 2, viewKey: a.viewKey), isNot(paid));
    final root2 = Uint8List(32)..fillRange(0, 32, 2);
    expect(
      destForLogin(a.address, continuityRoot: root2, height: 1, viewKey: a.viewKey),
      isNot(paid),
    );
    expect(
      destForLogin(a.address, height: 1, viewKey: a.viewKey),
      isNot(destForLogin(b.address, height: 1, viewKey: b.viewKey)),
    );
    expect(destsForViewKey('', a.address, heights: [1], ownerViewKey: a.viewKey), isEmpty);
    final aliceDests = destsForViewKey(a.viewKey, a.address, heights: [1, 2], ownerViewKey: a.viewKey);
    expect(aliceDests.first, paid);
    expect(destsForViewKey(b.viewKey, a.address, heights: [1], ownerViewKey: a.viewKey), isEmpty);
    expect(reserveRejectsDest(a.address, paid, viewKey: a.viewKey), isTrue);
    expect(vaultDest(a.address, viewKey: a.viewKey), isNot(a.address));
    expect(kWalletVersion, '0.16');
    expect(kWalletVersion.split('.').length, 2);
    expect(RegExp(r'^\d+\.\d+$').hasMatch(kWalletVersion), isTrue);
    expect(RegExp(r'^\d+\.\d+\.\d+$').hasMatch(kWalletVersion), isFalse);
    expect(RegExp(r'^\d+\.\d+$').hasMatch('0.11'), isTrue);
    expect(RegExp(r'^\d+\.\d+$').hasMatch('0.1.0'), isFalse);
    expect(formatShe(1), '1');
    expect(formatShe(kHashBonusShe), '0.000000000');
    expect(formatShe(1e-8), '0.000000010');
    expect(kHashBonusShe, 0.00000000001);
    expect(kShePublicDigits, 9);
    expect(levyNanos(kUnitsPerShe), 20000000);
    expect(levyNanos(kUnitsPerShe) / kUnitsPerShe, 0.0002);
    expect(kEip712ChainId, 2701);
    const login = 'she1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    const dest = 'ssa1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    const nanos = 5000000000;
    final digest = poolWithdrawDigest(login: login, dest: dest, nanos: nanos);
    expect(
      digest.map((e) => e.toRadixString(16).padLeft(2, '0')).join(),
      'd1ffd589655cb0f2b443c32b8c6fdefad1afa5ed81910a4a6c9c4636c78ab6a9',
    );
    final seed = Uint8List.fromList(List<int>.filled(32, 7));
    final sig = signPoolWithdraw(seed: seed, login: login, dest: dest, nanos: nanos);
    expect(verifyPoolWithdrawSig(login: login, dest: dest, nanos: nanos, sig: sig), isTrue);
    expect(verifyPoolWithdrawSig(login: login, dest: dest, nanos: nanos, sig: ''), isFalse);
    expect(verifyPoolWithdrawSig(login: login, dest: dest, nanos: nanos + 1, sig: sig), isFalse);
    final dartMain = File('lib/main.dart').readAsStringSync();
    expect(dartMain.contains("Key('pull-sign')"), isTrue);
    expect(dartMain.contains("Key('pull-sign-accept')"), isTrue);
    expect(dartMain.contains("Key('pull-sign-cancel')"), isTrue);
    expect(dartMain.contains('_handledPullIds'), isTrue);
    expect(dartMain.contains('Pool withdraw:'), isTrue);
    expect(dartMain.contains('_showPoolWithdrawError'), isTrue);
    expect(dartMain.contains('removeCurrentSnackBar'), isTrue);
    expect(dartMain.contains('Sign pool send'), isTrue);
    expect(dartMain.contains('Pull from pool'), isFalse);
    expect(dartMain.contains("Key('receive-qr')"), isTrue);
    expect(dartMain.contains("Key('show-qr')"), isTrue);
    expect(dartMain.contains("Key('unlock-biometrics')"), isTrue);
    expect(dartMain.contains('SHE (circulation)'), isTrue);
    expect(dartMain.contains('Show QR code'), isTrue);
    expect(dartMain.contains("Key('scan-qr')"), isTrue);
    expect(dartMain.contains("Key('bio-seal')"), isTrue);
    expect(dartMain.contains('Sign pool pull'), isTrue);
    expect(dartMain.contains('signPendingPull'), isTrue);
    expect(dartMain.contains("login != ident.paymentCode.split('.')[0]"), isTrue);
    final dartLedger = File('lib/shear_ledger.dart').readAsStringSync();
    expect(dartLedger.contains('signPoolWithdraw(seed: seed, login: login, dest: dest, nanos: nanos)'), isTrue);
    expect(dartLedger.contains('fetchPendingPull'), isTrue);
    const origin = 'https://dapp.example/stake-pool-a.json';
    const source = '{"id":"stake-pool-a"}';
    expect(issueVorticeKey('stake-pool-a'), isNull);
    expect(issueVorticeKey('shear-reserve-v1', origin: origin, source: source), isNull);
    final key = issueVorticeKey('stake-pool-a', origin: origin, source: source);
    expect(key, isNotNull);
    expect(key!.startsWith('vort1.'), isTrue);
    expect(parseVorticeKey(key)?.id, 'stake-pool-a');
    expect(parseVorticeKey(key)?.origin, origin);
    expect(addVortice(const [reserveVortice], key).length, 1);
    expect(addVortice(const [reserveVortice], key, source: source).length, 2);
    expect(verifyVorticeDownload(key, 'tamper'), isNull);
    expect(vorticeChipVisible(joinWatchVortice), isFalse);
    expect(
      reapExpiredJoin(const [reserveVortice, joinVortice, joinWatchVortice], expired: true)
          .every((v) => v.id != joinProgram),
      isTrue,
    );
    expect(poolUnlockProgram, 'pool-unlock-2044');
    expect(poolUnlockOpensHeight, 6312001);
    expect(poolUnlockDue(height: 64, nowMs: 1_700_000_000_000), isFalse);
    expect(poolUnlockDue(height: 6_312_001, nowMs: 1), isTrue);
    expect(poolUnlockDue(height: 1, nowMs: poolUnlockOpensAtMs), isTrue);
    expect(poolUnlockCountdown(nowMs: poolUnlockOpensAtMs - 1000, height: 64), contains('heights'));
    expect(poolUnlockCountdown(nowMs: poolUnlockOpensAtMs, height: 6_312_001), 'open');
  });

  test('poolUnlockSend returns dest/amount/memo when due else null', () {
    expect(poolUnlockSend(height: 64, nowMs: 1_700_000_000_000), isNull);
    final byHeight = poolUnlockSend(height: 6_312_001, nowMs: 1);
    expect(byHeight, isNotNull);
    expect(byHeight!['to'], poolUnlockDest);
    expect(byHeight['to'], 'ssa1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7mhq4z');
    expect(byHeight['amountShe'], poolUnlockAmountShe);
    expect(byHeight['amountShe'], 1000000.0);
    expect(byHeight['memo'], poolUnlockMemo);
    expect(byHeight['memo'], 'pool wallet is now unlocked');
    expect(byHeight.containsKey('dest'), isFalse);
    expect(byHeight.containsKey('confirm'), isFalse);
    expect(byHeight.containsKey('amount'), isFalse);
    expect(poolUnlockSend(height: 1, nowMs: poolUnlockOpensAtMs)!['to'], poolUnlockDest);
    expect(poolUnlockSend(height: 6_312_001, nowMs: 1, source: '{"id":"other-dapp"}'), isNull);
    expect(
      poolUnlockSend(height: 6_312_001, nowMs: 1, source: '{"id":"pool-unlock-2044"}')!['memo'],
      poolUnlockMemo,
    );
    final dartMain = File('lib/main.dart').readAsStringSync();
    expect(dartMain.contains('poolUnlockSend('), isTrue);
    expect(dartMain.contains('_maybeFirePoolUnlock'), isTrue);
  });

  testWidgets('poolUnlockSend vortice pane has no dest/amount/confirm fields', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-unlock-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    session.deployedVortices = [
      const Vortice(
        id: poolUnlockProgram,
        name: 'Pool wallet unlock',
        source: '{"id":"pool-unlock-2044"}',
      ),
    ];
    await tester.runAsync(() async {
      await session.persist();
    });
    await tester.pumpWidget(ShearWalletApp(session: session, startUnlocked: true, skipPoolSync: true));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Vortex'));
    await tester.pump();
    await tester.tap(find.text('Pool wallet unlock'));
    await tester.pump();
    expect(find.byKey(const Key('pool-unlock-countdown')), findsOneWidget);
    expect(find.text('To (ssa1…)'), findsNothing);
    expect(find.text('Amount SHE'), findsNothing);
    expect(find.widgetWithText(FilledButton, 'Send'), findsNothing);
  });

  test('downloadVorticeFromOrigin fetches the host named in the key and refuses a swap', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    const source = '{"id":"hosted-a","pane":"ok"}';
    server.listen((req) async {
      req.response.headers.contentType = ContentType.json;
      req.response.write(source);
      await req.response.close();
    });
    addTearDown(() => server.close(force: true));
    final origin = 'http://127.0.0.1:${server.port}/vortice.json';
    final key = mintVorticeDeployKey(
      programId: 'hosted-a',
      name: 'Hosted A',
      origin: origin,
      source: source,
    )!;
    final got = await downloadVorticeFromOrigin(key, http: _realHttp());
    expect(got?.id, 'hosted-a');
    expect(got?.origin, origin);
    expect(got?.source, source);
    expect(verifyVorticeDownload(key, 'tamper'), isNull);
    expect(addVortice(const [reserveVortice], key), hasLength(1));
    expect(addVortice(const [reserveVortice], key, source: source), hasLength(2));
    final again = mintVorticeDeployKey(
      programId: 'hosted-a',
      name: 'Hosted A',
      origin: origin,
      source: source,
    )!;
    expect(again, isNot(key));
    expect(parseVorticeKey(again)?.id, 'hosted-a');
    expect(verifyVorticeDownload(again, source)?.id, 'hosted-a');
  });

  test('currentDest is round ssa1 dest; destAtIndex mints unlimited ssa1 tied to shear1', () {
    final id = createIdentity();
    final ledger = ShearLedger();
    ledger.viewSecret = id.viewKey;
    final round = destForLogin(id.address, height: 1, viewKey: id.viewKey)!;
    expect(round.startsWith('ssa1'), isTrue);
    expect(ledger.currentDest(id.address), round);
    final d0 = destAtIndex(id.address, index: 0, viewKey: id.viewKey)!;
    expect(d0.startsWith('ssa1'), isTrue);
    expect(d0.startsWith('she1'), isFalse);
    final d1 = destAtIndex(id.address, index: 1, viewKey: id.viewKey)!;
    expect(d1, isNot(d0));
    expect(ledger.newDest(id.address), destAtIndex(id.address, index: 1, viewKey: id.viewKey));
    expect(ledger.destCount, 2);
    expect(destAtIndex(id.address, index: 0, viewKey: id.viewKey), d0);
    expect(destAtIndex(id.address, index: 99, viewKey: id.viewKey)!.startsWith('ssa1'), isTrue);
    expect(isDestAddress(encodeHrp('ssa', Uint8List.fromList(List.filled(20, 7)))), isTrue);
  });

  test('syncSpendable from pool /api/stats applyTipHex: currentDest is destForLogin(login, lag-1 offset 68, next height, no viewKey)', () async {
    final header = Uint8List(128);
    for (var i = 0; i < 32; i++) {
      header[68 + i] = 7;
    }
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final server = await _fakePool(headerHex: hex, height: 4);
    addTearDown(() => server.close(force: true));
    final id = createIdentity();
    final pool = ShearPoolClient(
      baseUrl: 'http://127.0.0.1:${server.port}',
      http: _realHttp(),
    );
    final ledger = ShearLedger(pool: pool);
    ledger.viewSecret = id.viewKey;
    await ledger.syncSpendable(ledger.currentDest(id.address));
    expect(ledger.tipHeight, 5);
    expect(ledger.lag1Root, header.sublist(68, 100));
    expect(
      ledger.currentDest(id.address),
      destForLogin(id.address, continuityRoot: header.sublist(68, 100), height: 5, viewKey: id.viewKey),
    );
    expect(ledger.currentDest(id.address), isNot(id.address));
    expect(ledger.currentDest(id.address).startsWith('ssa1'), isTrue);
    expect(isDestAddress(ledger.currentDest(id.address)), isTrue);
    expect(
      ledger.currentDest(id.address),
      isNot(degenerateDest(id.address, continuityRoot: header.sublist(68, 100), height: 5)),
    );
  });

  test('Dart ShearHash matches C selftest vector 5d00a242…', () {
    final header = shearSelftestHeader();
    expect(header.length, 128);
    expect(header[0], 1);
    expect(header.sublist(1).every((b) => b == 0), isTrue);
    final got = shearHashHex(header);
    expect(got, shearSelftestHash);
    expect(shearSelftest(), isTrue);
    expect(dartHashRound(header), shearHash(header));
  });

  test('Dart packALeaf digest equals JS packALeaf digest', () {
    final dest20 = Uint8List.fromList(List.filled(20, 7));
    final packed = packALeaf(dest20: dest20, count: 3);
    expect(packDigestHex(packed), 'f1e4aa9bf56bfdd19c0a60b2e6dd0b8c4f0d58e7df87ed631673a646a55a8774');
  });

  test('Dart packBLeaf digest equals JS packBLeaf digest', () {
    final dest20 = Uint8List.fromList(List.filled(20, 7));
    final packed = packBLeaf(
      dest20: dest20,
      unit: 1,
      nonce: 2,
      memoH: Uint8List.fromList(List.filled(32, 9)),
      tag: 'b-spend',
    );
    expect(packDigestHex(packed), '693ca5f2fc44619b8b20fe2df4de76477c7c3120aa1f86a788eb0fe89e979e12');
  });

  test('Dart packTx digest equals JS packTx digest', () {
    final dest20 = Uint8List.fromList(List.filled(20, 7));
    final packed = packTx(
      vins: [
        {'prev': Uint8List.fromList(List.filled(32, 1)), 'index': 0, 'dest20': dest20},
      ],
      vouts: [
        {'dest20': dest20, 'nanos': 5, 'kind': 0},
      ],
    );
    expect(packDigestHex(packed), '016143271e11c70f09a73dd9a245738ba81a59ad08a020cc6f260a5bff6e16cd');
  });

  test('in-app logo and macOS 1024 icon are square, not a stretched 802×848', () {
    List<int> pngSize(String path) {
      final b = File(path).readAsBytesSync();
      expect(b[0], 0x89);
      expect(b[1], 0x50);
      final w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
      final h = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
      return [w, h];
    }

    final logo = pngSize('assets/brand/logo.png');
    expect(logo[0], logo[1]);
    expect(logo[0] == 802 && logo[1] == 848, isFalse);
    final icon = pngSize('macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_1024.png');
    expect(icon[0], 1024);
    expect(icon[1], 1024);
  });

  testWidgets('first run requires matching hard password; wrong unlock fails', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-first-run-');
    final store = File('${dir.path}/session.json');
    final session = ShearSession(store: store);
    await session.loadOrCreate();
    expect(session.needsPasswordSet, isTrue);
    await tester.pumpWidget(ShearWalletApp(key: UniqueKey(), session: session, ledger: ShearLedger(), skipPoolSync: true));
    await tester.pump();
    expect(find.text('Set password'), findsOneWidget);
    expect(find.text('Import shewall.bin'), findsOneWidget);
    expect(find.text('Unlock'), findsNothing);
    await tester.enterText(find.byType(TextField).at(0), 'correct-horse');
    await tester.enterText(find.byType(TextField).at(1), 'other-horse');
    await tester.tap(find.text('Set password'));
    await tester.pump();
    expect(find.text('Passwords do not match.'), findsOneWidget);
    expect(find.text('Spendable'), findsNothing);
    await tester.enterText(find.byType(TextField).at(0), kGatePassword);
    await tester.enterText(find.byType(TextField).at(1), kGatePassword);
    await tester.tap(find.text('Set password'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    expect(find.text('Spendable'), findsOneWidget);
    expect(session.sealed, isTrue);

    final locked = ShearSession(store: store);
    await locked.loadOrCreate();
    expect(locked.needsUnlock, isTrue);
    await tester.pumpWidget(ShearWalletApp(key: UniqueKey(), session: locked, ledger: ShearLedger(), skipPoolSync: true));
    await tester.pump();
    expect(find.text('Unlock'), findsOneWidget);
    await tester.enterText(find.byType(TextField).first, 'not-the-password');
    await tester.tap(find.text('Unlock'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    expect(find.text('Wrong password.'), findsOneWidget);
    expect(find.text('Spendable'), findsNothing);
    await tester.enterText(find.byType(TextField).first, kGatePassword);
    await tester.tap(find.text('Unlock'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    expect(find.text('Spendable'), findsOneWidget);
  });

  testWidgets('Import shewall.bin on a fresh store restores the backup identity', (tester) async {
    final id = createIdentity();
    final srcLedger = ShearLedger();
    srcLedger.confirmRound(address: id.address, pot: 1, height: 1);
    srcLedger.settleTo(1 + ShearLedger.spendableConfirmations);
    final backup = File('${Directory.systemTemp.createTempSync('shear-imp-ui-').path}/$shewallName');
    await tester.runAsync(() async {
      await exportEncryptedShewall(identity: id, ledger: srcLedger, password: kGatePassword, dest: backup);
    });
    final dir = Directory.systemTemp.createTempSync('shear-imp-sess-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    expect(session.identity!.address, isNot(id.address));
    await tester.pumpWidget(ShearWalletApp(
      key: UniqueKey(),
      session: session,
      ledger: ShearLedger(),
      importSrc: () => backup,
      skipPoolSync: true,
    ));
    await tester.pump();
    expect(find.text('Import shewall.bin'), findsOneWidget);
    await tester.enterText(find.byType(TextField).first, kGatePassword);
    await tester.tap(find.text('Import shewall.bin'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    expect(find.text('Spendable'), findsOneWidget);
    expect(session.identity!.address, id.address);
  });

  testWidgets('Closure Export shewall.bin writes a user dest and Import restores it', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-closure-io-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    final ident = session.identity!;
    final dest = File('${dir.path}/Documents/$shewallName');
    await tester.pumpWidget(ShearWalletApp(
      key: UniqueKey(),
      session: session,
      ledger: ShearLedger(),
      startUnlocked: true,
      skipPoolSync: true,
      exportDest: () => dest,
    ));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Closure'));
    await tester.pump();
    expect(find.byKey(const Key('closure-shear1')), findsOneWidget);
    expect(find.text(ident.address), findsOneWidget);
    expect(ident.address.startsWith('shear1'), isTrue);
    expect(find.text('Export shewall.bin'), findsOneWidget);
    expect(find.text('Import shewall.bin'), findsWidgets);
    await tester.tap(find.text('Export shewall.bin'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    expect(dest.existsSync(), isTrue);
    expect(isTempOnlyShewallPath(dest.path), isFalse);
    expect(find.textContaining('Wrote encrypted'), findsOneWidget);

    final freshDir = Directory.systemTemp.createTempSync('shear-closure-imp-');
    final fresh = ShearSession(store: File('${freshDir.path}/session.json'));
    await fresh.loadOrCreate();
    expect(fresh.identity!.address, isNot(ident.address));
    await tester.pumpWidget(ShearWalletApp(
      key: UniqueKey(),
      session: fresh,
      ledger: ShearLedger(),
      importSrc: () => dest,
      skipPoolSync: true,
    ));
    await tester.pump();
    await tester.enterText(find.byType(TextField).first, kGatePassword);
    await tester.tap(find.text('Import shewall.bin'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    expect(find.text('Spendable'), findsOneWidget);
    expect(fresh.identity!.address, ident.address);
  });

  testWidgets('Closure Export on desktop picker does not pass bytes and overwrites', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-closure-pick-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    final dest = File('${dir.path}/Documents/$shewallName');
    dest.parent.createSync(recursive: true);
    dest.writeAsBytesSync(Uint8List.fromList([9, 9, 9, 9, 9, 9, 9, 9]));
    Uint8List? seen;
    await tester.pumpWidget(ShearWalletApp(
      key: UniqueKey(),
      session: session,
      ledger: ShearLedger(),
      startUnlocked: true,
      skipPoolSync: true,
      savePicker: ({bytes}) async {
        seen = bytes;
        if (bytes != null) throw UnsupportedError('Bytes are not supported on macOS');
        return dest.path;
      },
    ));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Closure'));
    await tester.pump();
    await tester.tap(find.text('Export shewall.bin'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    expect(seen, isNull);
    expect(dest.existsSync(), isTrue);
    expect(dest.lengthSync() > 8, isTrue);
    expect(dest.readAsBytesSync().sublist(0, 8), isNot(Uint8List.fromList([9, 9, 9, 9, 9, 9, 9, 9])));
    expect(find.textContaining('Wrote encrypted'), findsOneWidget);
    expect(find.textContaining('Export failed'), findsNothing);
    await tester.runAsync(() async {
      final restored = ShearLedger();
      final opened = await importEncryptedShewall(src: dest, password: kGatePassword, ledger: restored);
      expect(opened.address, session.identity!.address);
    });
  });

  testWidgets('six Chronoflux tabs and light pool colors', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-ui-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger(), startUnlocked: true, skipPoolSync: true));
    await tester.pump();
    expect(shearBg.value, 0xFFEEF3F8);
    expect(shearInk.value, 0xFF0D2137);
    final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.title, 'Shear 0.16');
    expect(kWalletVersion, '0.16');
    await tester.pump();
    expect(find.textContaining('0.16'), findsWidgets);
    expect(find.text('Copy ID'), findsWidgets);
    expect(session.identity!.paymentCode.startsWith('she1'), isTrue);
    expect(find.textContaining(session.identity!.paymentCode), findsWidgets);
    expect(find.byType(Image), findsWidgets);
    for (final name in kTabs) {
      expect(find.text(name), findsWidgets);
    }
    expect(kTabs, contains('Shearview'));
    expect(kTabs.contains('Explorer'), isFalse);
    expect(kTabs.contains('Shear'), isFalse);
    expect(kTabs.contains('Reserve'), isFalse);
    expect(kTabs.contains('Join'), isFalse);
    expect(kExplains, [
      'Your spendable balance and she1 address.',
      'Send SHEAR to anyone with a she1 address.',
      'Transactional data in a CLI output.',
      'Contracts which are deployed into your wallet.',
      'Your personal transaction explorer.',
      'Password and backup. Encrypts shewall.bin so you can restore this wallet on another install.',
    ]);
    expect(kExplains.length, kTabs.length);
    expect(kSymbols.length, kTabs.length);
    expect(kExplains.every((e) => e.length > 20), isTrue);
  });

  testWidgets('pack logo loads and dark mode swaps palette', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-theme-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger(), startUnlocked: true, skipPoolSync: true));
    await tester.pump();
    expect(shearDarkBg.value, isNot(shearBg.value));
    expect(kShearLogoAsset, 'assets/brand/logo.png');
    expect(kShearWordmarkLight, 'assets/brand/wordmark-text-light.png');
    expect(kShearWordmarkDark, 'assets/brand/wordmark-text-dark.png');
    expect(find.byType(Image), findsWidgets);
    await tester.tap(find.byTooltip('Dark mode'));
    await tester.pump();
    final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.themeMode, ThemeMode.dark);
    expect(app.darkTheme!.scaffoldBackgroundColor, shearDarkBg);
    expect(app.theme!.scaffoldBackgroundColor, shearBg);
    expect(Theme.of(tester.element(find.byType(Scaffold))).brightness, Brightness.dark);
    expect(Theme.of(tester.element(find.byType(Scaffold))).scaffoldBackgroundColor, shearDarkBg);
    final scaffold = tester.widget<Scaffold>(find.byType(Scaffold));
    expect(scaffold.backgroundColor, shearDarkBg);
    expect(app.darkTheme!.cardColor, shearDarkCard);
    expect(app.darkTheme!.cardTheme.color, shearDarkCard);
    expect(app.darkTheme!.inputDecorationTheme.fillColor, isNot(const Color(0xFFFFFFFF)));
    expect(app.theme!.cardColor, shearCard);
    expect(app.theme!.cardTheme.color, shearCard);
  });

  testWidgets('Continuum is spendable + Copy ID; explorer history is its own tab', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-continuum-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger(), startUnlocked: true, skipPoolSync: true));
    await tester.pump();
    await tester.pump();

    expect(find.textContaining('SHE'), findsWidgets);
    expect(find.text('Spendable'), findsOneWidget);
    expect(find.textContaining('block height:'), findsWidgets);
    expect(find.text('Copy ID'), findsOneWidget);
    expect(find.text('Receive ID'), findsOneWidget);
    expect(find.byTooltip('Discord'), findsOneWidget);
    expect(find.byTooltip('Telegram'), findsOneWidget);
    expect(find.byTooltip('X'), findsOneWidget);
    expect(kDiscordUrl, 'https://discord.gg/AzVtMnSxCe');
    expect(kTelegramUrl, 'https://t.me/shearprivacy');
    expect(kXUrl, 'https://x.com/shearprivacy');
    expect(find.textContaining(session.identity!.paymentCode), findsWidgets);
    final spendY = tester.getTopLeft(find.text('Spendable')).dy;
    final receiveY = tester.getTopLeft(find.text('Receive ID')).dy;
    final spendX = tester.getTopLeft(find.text('Spendable')).dx;
    final explainerX = tester.getTopLeft(find.text('1 SHE per block continuity')).dx;
    expect(spendY < receiveY, isTrue);
    expect(explainerX > spendX, isTrue);
    final spendBox = tester.getRect(find.byKey(const Key('continuum-spend')));
    final statsBox = tester.getRect(find.byKey(const Key('continuum-stats')));
    expect(spendBox.width / statsBox.width, closeTo(2.0, 0.2));
    expect(spendBox.height, closeTo(statsBox.height, 1));
    expect(statsBox.left > spendBox.right, isTrue);
    expect(find.text('Pending'), findsNothing);
    expect(find.text('Copy dest'), findsOneWidget);
    expect(find.text('ssa1 dest (from your shear1 — chain mailbox)'), findsOneWidget);
    expect(find.byKey(const Key('copy-id')), findsOneWidget);
    expect(find.byKey(const Key('copy-dest')), findsOneWidget);
    expect(find.byKey(const Key('continuum-ssa1')), findsOneWidget);
    final dest = ShearLedger()
      ..viewSecret = session.identity!.viewKey;
    final ssa1 = dest.homeDest(session.identity!.address, paymentCode: session.identity!.paymentCode);
    expect(ssa1.startsWith('ssa1'), isTrue);
    expect(find.textContaining(ssa1), findsWidgets);
    expect(find.text('New dest'), findsNothing);
    expect(find.text('Shearview  S_{μν}'), findsNothing);
    expect(find.text('No confirmed transactions yet.'), findsNothing);

    await tester.tap(find.text('Shearview'));
    await tester.pump();
    expect(find.text('Shearview  S_{μν}'), findsOneWidget);
    expect(find.text('No confirmed transactions yet.'), findsOneWidget);
    expect(find.text('Copy ID'), findsNothing);
  });

  test('Path 1 fold sums sealed pot vouts and excludes pending templates and hash bonus', () {
    const dest = 'ssa1fold';
    final sealed = <ShearTx>[
      ShearTx(id: 'p1', from: 'coinbase', to: dest, amount: 1, kind: 'pot', height: 1, confirmed: true),
      ShearTx(id: 'p2', from: 'coinbase', to: dest, amount: 1, kind: 'pot', height: 2, confirmed: true),
      ShearTx(
        id: 'cb3',
        from: 'coinbase',
        to: dest,
        amount: 1 + kHashBonusShe,
        kind: 'coinbase',
        height: 3,
        confirmed: true,
        hashAmount: kHashBonusShe,
      ),
      ShearTx(id: 'hash3', from: 'coinbase', to: dest, amount: kHashBonusShe, kind: 'hash', height: 3, confirmed: true),
      ShearTx(id: 'pend', from: 'coinbase', to: dest, amount: 1, kind: 'pot', height: 0, confirmed: false),
      ShearTx(id: 'tmpl', from: 'coinbase', to: dest, amount: 1, kind: 'pot', confirmed: false),
    ];
    final obs = foldSealedPots(sealed);
    expect(obs.quantumShe, kBlockPotShe);
    expect(obs.quantumShe, 1);
    expect(obs.targetIntervalMs, kTargetBlockIntervalMs);
    expect(obs.targetIntervalMs, 90000);
    expect(obs.integralQShe, 3);
    expect(obs.targetFluxShePerMs, kBlockPotShe / kTargetBlockIntervalMs);

    final ledger = ShearLedger();
    final id = createIdentity();
    ledger.viewSecret = id.viewKey;
    ledger.confirmRound(address: id.address, pot: 1, height: 10);
    ledger.confirmRound(address: id.address, pot: 1, height: 11);
    ledger.creditHash(id.address, hashes: 1);
    ledger.confirmRound(address: id.address, pot: 1, height: 12);
    expect(ledger.path1Observation().integralQShe, 3);
    expect(ledger.path1Observation().quantumShe, kBlockPotShe);

    final recv = ShearLedger()..viewSecret = id.viewKey;
    final payout = recv.currentDest(id.address);
    recv.creditReceive(to: payout, amount: 0.4, from: 'ssa1peer', id: 'in-q');
    recv.confirmRound(address: id.address, pot: 0, height: 20);
    expect(recv.path1Observation().integralQShe, 0);
    recv.confirmRound(address: id.address, pot: 1, height: 21);
    expect(recv.path1Observation().integralQShe, 1);
  });

  test('Path 1 observed interval is last sealed header dt and is not a mint input', () {
    final ledger = ShearLedger();
    final a = Uint8List(128);
    a[0] = 1;
    var t0 = 1_700_000_000_000;
    for (var i = 0; i < 8; i++) {
      a[100 + i] = t0 & 0xff;
      t0 >>= 8;
    }
    final b = Uint8List.fromList(a);
    var t1 = 1_700_000_090_000;
    for (var i = 0; i < 8; i++) {
      b[100 + i] = t1 & 0xff;
      t1 >>= 8;
    }
    ledger.applyTipHeader(a, sealedHeight: 1);
    expect(ledger.lastSealedHeaderDtMs, isNull);
    ledger.applyTipHeader(b, sealedHeight: 2);
    expect(ledger.lastSealedHeaderDtMs, 90000);
    expect(ledger.path1Observation().observedIntervalMs, 90000);
  });

  test('observed interval is the network-wide average from /api/stats, in ms for paint-as-seconds', () async {
    final header = Uint8List(128);
    header[0] = 1;
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final live = _PoolLive(headerHex: hex, height: 4, avgBlockTimeMs: 183266);
    final server = await _fakePool(live: live);
    addTearDown(() => server.close(force: true));
    final pool = ShearPoolClient(
      baseUrl: 'http://127.0.0.1:${server.port}',
      http: _realHttp(),
    );
    final ledger = ShearLedger(pool: pool);
    expect(ledger.observedIntervalMs, isNull);
    await ledger.syncTip();
    expect(ledger.observedIntervalMs, 183266);
    expect(ledger.path1Observation().observedIntervalMs, 183266);
  });

  test('Path 1 observed interval prefers pool average of all sealed blocks', () {
    final ledger = ShearLedger();
    final a = Uint8List(128);
    a[0] = 1;
    var t0 = 1_700_000_000_000;
    for (var i = 0; i < 8; i++) {
      a[100 + i] = t0 & 0xff;
      t0 >>= 8;
    }
    final b = Uint8List.fromList(a);
    var t1 = 1_700_000_090_000;
    for (var i = 0; i < 8; i++) {
      b[100 + i] = t1 & 0xff;
      t1 >>= 8;
    }
    ledger.applyTipHeader(a, sealedHeight: 1);
    ledger.applyTipHeader(b, sealedHeight: 2);
    expect(ledger.lastSealedHeaderDtMs, 90000);
    ledger.applyAvgBlockTimeMs(183266);
    expect(ledger.observedIntervalMs, 183266);
    expect(ledger.path1Observation().observedIntervalMs, 183266);
  });

  testWidgets('Continuum stacks equal panes on a narrow screen', (tester) async {
    final view = tester.view;
    view.physicalSize = const Size(390, 844);
    view.devicePixelRatio = 1;
    addTearDown(view.resetPhysicalSize);
    addTearDown(view.resetDevicePixelRatio);
    final dir = Directory.systemTemp.createTempSync('shear-continuum-narrow-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger(), startUnlocked: true, skipPoolSync: true));
    await tester.pump();
    await tester.pump();
    final spend = tester.getTopLeft(find.text('Spendable'));
    final receive = tester.getTopLeft(find.text('Receive ID'));
    final explainer = tester.getTopLeft(find.text('1 SHE per block continuity'));
    expect(spend.dy < receive.dy, isTrue);
    expect(receive.dy < explainer.dy, isTrue);
    expect((spend.dx - explainer.dx).abs() < 8, isTrue);
    final spendBox = tester.getRect(find.byKey(const Key('continuum-spend')));
    final statsBox = tester.getRect(find.byKey(const Key('continuum-stats')));
    expect(spendBox.width, closeTo(statsBox.width, 1));
    expect(statsBox.top > spendBox.bottom, isTrue);
  });

  testWidgets('Continuum shows 1 SHE per block continuity and sealed pot figures', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-path1-ui-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    final ident = session.identity!;
    final ledger = ShearLedger()..viewSecret = ident.viewKey;
    ledger.confirmRound(address: ident.address, pot: 1, height: 1);
    ledger.confirmRound(address: ident.address, pot: 1, height: 2);
    ledger.circulatingNanos = 12 * kUnitsPerShe;
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ledger, startUnlocked: true, skipPoolSync: true));
    await tester.pump();
    await tester.pump();

    expect(find.text('1 SHE per block continuity'), findsOneWidget);
    expect(find.textContaining('Closure quantum'), findsOneWidget);
    expect(find.textContaining('Target flux'), findsOneWidget);
    expect(find.textContaining('Integral Q'), findsOneWidget);
    expect(find.textContaining('Observed interval'), findsOneWidget);
    expect(find.text('Integral Q'), findsOneWidget);
    expect(find.textContaining('(circulation)'), findsOneWidget);
    expect(find.textContaining('12 SHE (circulation)'), findsOneWidget);
    expect(find.textContaining('infinite schedule'), findsNothing);
    expect(find.textContaining('Oracle rate'), findsNothing);
    expect(find.text('Vote'), findsNothing);
    expect(find.textContaining('Reserve interest'), findsNothing);
    expect(find.text('Spendable'), findsOneWidget);
    expect(find.text('Copy ID'), findsOneWidget);
  });

  testWidgets('Continuum lists pending sends until the next block, then Shearview has them', (tester) async {
    _tallContinuum(tester);
    final dir = Directory.systemTemp.createTempSync('shear-pending-ui-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    final ident = session.identity!;
    final ledger = ShearLedger()..viewSecret = ident.viewKey;
    final dest = ledger.currentDest(ident.address);
    ledger.confirmRound(address: ident.address, pot: 1, height: 2);
    ledger.settleTo(2 + ShearLedger.spendableConfirmations - 1);
    final other = createIdentity();
    final bob = destForLogin(other.address, height: 1, viewKey: other.viewKey)!;
    await ledger.send(from: dest, to: bob, amount: 0.25);
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ledger, startUnlocked: true, skipPoolSync: true));
    await tester.pump();
    await tester.pump();
    expect(find.text('Pending'), findsOneWidget);
    expect(find.textContaining(formatShe(0.25)), findsWidgets);
    expect(find.textContaining('block height:'), findsWidgets);
    await tester.tap(find.text('Shearview'));
    await tester.pump();
    expect(find.textContaining(formatShe(0.25)), findsNothing);
    ledger.confirmRound(address: ident.address, pot: 1, height: 3);
    await tester.tap(find.text('Continuum'));
    await tester.pump();
    expect(find.text('Pending'), findsOneWidget);
    expect(find.byKey(Key('confirm-pie-${ledger.pendingTxs(ident.address).first.id}')), findsWidgets);
    await tester.tap(find.text('Shearview'));
    await tester.pump();
    expect(find.textContaining(formatShe(0.25)), findsNothing);
    ledger.settleTo(3 + ShearLedger.continuumConfirmations - 1);
    await tester.tap(find.text('Shearview'));
    await tester.pump();
    expect(find.textContaining(formatShe(0.25)), findsWidgets);
    await tester.tap(find.text('Continuum'));
    await tester.pump();
    expect(find.text('Pending'), findsNothing);
  });

  testWidgets('Continuum live-feeds pending hashes and receives until block-found', (tester) async {
    _tallContinuum(tester);
    final dir = Directory.systemTemp.createTempSync('shear-live-feed-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    final ident = session.identity!;
    final ledger = ShearLedger()..viewSecret = ident.viewKey;
    final dest = ledger.currentDest(ident.address);
    ledger.creditHash(ident.address, hashes: 100000000);
    final peer = createIdentity();
    final from = destForLogin(peer.address, height: 1, viewKey: peer.viewKey)!;
    ledger.creditReceive(to: dest, amount: 0.4, from: from, id: 'in-live');
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ledger, startUnlocked: true, skipPoolSync: true));
    await tester.pump();
    await tester.pump();
    expect(find.text('Pending'), findsOneWidget);
    expect(find.textContaining('hash'), findsNothing);
    expect(find.textContaining('receive'), findsWidgets);
    expect(find.textContaining(formatShe(0.4)), findsWidgets);
    ledger.confirmRound(address: ident.address, pot: 0.1, height: 4);
    await tester.tap(find.text('Continuum'));
    await tester.pump();
    expect(find.textContaining('hash'), findsNothing);
    expect(find.textContaining('block'), findsWidgets);
    expect(find.byType(ConfirmPie), findsWidgets);
    expect(find.textContaining(formatShe(0.4)), findsWidgets);
    ledger.settleTo(4 + ShearLedger.continuumConfirmations - 1);
    await tester.tap(find.text('Continuum'));
    await tester.pump();
    expect(find.text('Pending'), findsNothing);
  });

  test('confirm pie fills one slice per confirmation up to 6', () {
    expect(kConfirmSliceColors, hasLength(6));
    expect(kConfirmSliceColors[0], const Color(0xFFE53935));
    expect(kConfirmSliceColors[1], const Color(0xFFFFFFFF));
    expect(kConfirmSliceColors[2], const Color(0xFF1E88E5));
    expect(kConfirmSliceColors[3], const Color(0xFFFB8C00));
    expect(kConfirmSliceColors[4], const Color(0xFF8E24AA));
    expect(kConfirmSliceColors[5], const Color(0xFF43A047));
    expect(confirmSlicesFilled(0), 0);
    expect(confirmSlicesFilled(1), 1);
    expect(confirmSlicesFilled(3), 3);
    expect(confirmSlicesFilled(6), 6);
    expect(confirmSlicesFilled(9), 6);
  });

  test('rollupExplorerTxs bundles thousands of hash rewards into one block row', () {
    final dest = destForLogin(createIdentity().address, height: 1, viewKey: 'ab' * 32)!;
    final fat = <ShearTx>[
      for (var i = 0; i < 4000; i++)
        ShearTx(
          id: 'hash-$i',
          from: 'hash',
          to: dest,
          amount: kHashBonusShe,
          kind: 'hash',
          height: 20,
          confirmed: true,
        ),
      ShearTx(id: 'cb-20', from: 'coinbase', to: dest, amount: 1, kind: 'coinbase', height: 20, confirmed: true),
      ShearTx(id: 'pay-1', from: dest, to: dest, amount: 0.2, kind: 'receive', height: 20, confirmed: true, memoPlain: 'hello-memo'),
    ];
    final rolled = rollupExplorerTxs(fat);
    expect(rolled.where((t) => t.kind == 'hash'), isEmpty);
    expect(rolled.where((t) => t.kind == 'blockfound').length, 1);
    expect(rolled.singleWhere((t) => t.kind == 'blockfound').amount, closeTo(1 + 4000 * kHashBonusShe, 1e-12));
    expect(rolled.where((t) => t.id == 'pay-1').length, 1);
  });

  test('shearviewMatches filters id dest kind amount height memo', () {
    final tx = ShearTx(
      id: 'abc123',
      from: 'ssa1from',
      to: 'ssa1dest',
      amount: 1.25,
      kind: 'receive',
      height: 44,
      confirmed: true,
      memoPlain: 'secret-note',
    );
    expect(shearviewMatches(tx, ''), isTrue);
    expect(shearviewMatches(tx, 'abc123'), isTrue);
    expect(shearviewMatches(tx, 'ssa1dest'), isTrue);
    expect(shearviewMatches(tx, 'receive'), isTrue);
    expect(shearviewMatches(tx, '1.25'), isTrue);
    expect(shearviewMatches(tx, '44'), isTrue);
    expect(shearviewMatches(tx, 'secret-note'), isTrue);
    expect(shearviewMatches(tx, 'nope-xyz'), isFalse);
  });

  test('ingest of per-hash history is rolled into Shearview blockfound rows', () async {
    final id = createIdentity();
    final header = Uint8List(128);
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final dest = payoutDest(id.paymentCode)!;
    final live = _PoolLive(headerHex: hex, height: 30, balance: 2);
    live.owner = dest;
    live.history = [
      for (var i = 0; i < 500; i++)
        {
          'id': 'h-$i',
          'from': 'hash',
          'to': dest,
          'amount': kHashBonusShe,
          'kind': 'hash',
          'height': 20,
          'confirmed': true,
        },
      {
        'id': 'cb-20',
        'from': 'coinbase',
        'to': dest,
        'amount': 1,
        'kind': 'coinbase',
        'height': 20,
        'confirmed': true,
      },
    ];
    final server = await _fakePool(live: live);
    addTearDown(() => server.close(force: true));
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _realHttp());
    final ledger = ShearLedger(pool: pool)..viewSecret = id.viewKey;
    await ledger.syncCredits(id.address, paymentCode: id.paymentCode);
    expect(ledger.transactions.where((t) => t.kind == 'hash'), isEmpty);
    expect(ledger.transactions.length < 20, isTrue);
    expect(ledger.shearviewTxs(id.address).where((t) => t.kind == 'hash'), isEmpty);
    expect(ledger.shearviewTxs(id.address).any((t) => t.kind == 'blockfound'), isTrue);
  });

  testWidgets('incoming pie evaporates at spendable confs; leftover pendings continue', (tester) async {
    _tallContinuum(tester);
    final dir = Directory.systemTemp.createTempSync('shear-pie-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    final ident = session.identity!;
    final ledger = ShearLedger()..viewSecret = ident.viewKey;
    final dest = ledger.currentDest(ident.address);
    final peer = createIdentity();
    final from = destForLogin(peer.address, height: 1, viewKey: peer.viewKey)!;
    ledger.creditReceive(to: dest, amount: 0.4, from: from, id: 'in-early');
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ledger, startUnlocked: true, skipPoolSync: true));
    await tester.pump();
    await tester.pump();
    expect(find.text('Pending'), findsOneWidget);
    expect(find.byKey(const Key('confirm-pie-in-early')), findsOneWidget);
    expect(tester.widget<ConfirmPie>(find.byKey(const Key('confirm-pie-in-early'))).size, 28);
    ledger.confirmRound(address: ident.address, pot: 0, height: 1);
    await tester.tap(find.text('Continuum'));
    await tester.pump();
    expect(find.byKey(const Key('confirm-pie-in-early')), findsOneWidget);
    expect(confirmSlicesFilled(ledger.confirmationsOf(1)), 1);
    ledger.settleTo(3);
    await tester.tap(find.text('Continuum'));
    await tester.pump();
    expect(find.byKey(const Key('confirm-pie-in-early')), findsOneWidget);
    expect(confirmSlicesFilled(ledger.confirmationsOf(1)), 3);
    ledger.creditReceive(to: dest, amount: 0.2, from: from, id: 'in-late');
    await tester.tap(find.text('Continuum'));
    await tester.pump();
    expect(find.byKey(const Key('confirm-pie-in-late')), findsOneWidget);
    ledger.settleTo(1 + ShearLedger.continuumConfirmations - 1);
    await tester.tap(find.text('Continuum'));
    await tester.pump();
    expect(find.byKey(const Key('confirm-pie-in-early')), findsNothing);
    expect(find.byKey(const Key('confirm-pie-in-late')), findsOneWidget);
    ledger.confirmRound(address: ident.address, pot: 0, height: ledger.sealedHeight + 1);
    ledger.settleTo(ledger.sealedHeight + ShearLedger.continuumConfirmations - 1);
    await tester.tap(find.text('Continuum'));
    await tester.pump();
    expect(find.byKey(const Key('confirm-pie-in-late')), findsNothing);
  });

  testWidgets('Shearview search keeps matching txs and drops the rest', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-search-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    final ident = session.identity!;
    final ledger = ShearLedger()..viewSecret = ident.viewKey;
    final dest = ledger.currentDest(ident.address);
    final peer = createIdentity();
    final from = destForLogin(peer.address, height: 1, viewKey: peer.viewKey)!;
    ledger.creditReceive(to: dest, amount: 0.4, from: from, id: 'in-search');
    // stamp memo
    final recv = ledger.pendingTxs(ident.address).singleWhere((t) => t.id == 'in-search');
    expect(recv.kind, 'receive');
    ledger.confirmRound(address: ident.address, pot: 1, height: 10);
    ledger.settleTo(10 + ShearLedger.continuumConfirmations - 1);
    expect(ledger.transactions.any((t) => t.id == 'in-search'), isTrue);
    ledger.replaceFromBackup(
      address: dest,
      spendable: ledger.spendable(dest),
      pending: 0,
      txs: [
        for (final t in ledger.transactions)
          t.id == 'in-search'
              ? ShearTx(
                  id: t.id,
                  from: t.from,
                  to: t.to,
                  amount: t.amount,
                  kind: t.kind,
                  height: t.height,
                  confirmed: true,
                  memo: true,
                  memoPlain: 'secret-note',
                )
              : t,
      ],
    );
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ledger, startUnlocked: true, skipPoolSync: true));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Shearview'));
    await tester.pump();
    expect(find.textContaining('block  '), findsWidgets);
    expect(find.textContaining('receive'), findsWidgets);
    await tester.enterText(find.byKey(const Key('shearview-search')), 'secret-note');
    await tester.pump();
    expect(find.textContaining('receive'), findsWidgets);
    expect(find.textContaining('block  '), findsNothing);
    await tester.enterText(find.byKey(const Key('shearview-search')), 'nope-xyz');
    await tester.pump();
    expect(find.textContaining('receive'), findsNothing);
    expect(find.text('No confirmed transactions yet.'), findsOneWidget);
  });

  testWidgets('dark mode cards and fields are dark with light ink; light mode inverts', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-surfaces-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger(), startUnlocked: true, skipPoolSync: true));
    await tester.pump();
    await tester.pump();

    var card = tester.widget<Card>(find.byType(Card).first);
    expect(card.color, shearCard);
    expect(card.color, isNot(shearDarkCard));

    await tester.tap(find.byIcon(Icons.dark_mode));
    await tester.pump();

    card = tester.widget<Card>(find.byType(Card).first);
    expect(card.color, shearDarkCard);
    expect(card.color!.value, isNot(0xFFFFFFFF));
    expect(Theme.of(tester.element(find.byType(Card).first)).colorScheme.onSurface, shearDarkInk);
    expect(Theme.of(tester.element(find.byType(Card).first)).scaffoldBackgroundColor, shearDarkBg);

    await tester.tap(find.text('Flow'));
    await tester.pump();
    final fieldCtx = tester.element(find.byType(TextField).first);
    final fieldTheme = Theme.of(fieldCtx);
    expect(fieldTheme.inputDecorationTheme.fillColor, shearDarkField);
    expect(fieldTheme.inputDecorationTheme.fillColor, isNot(const Color(0xFFFFFFFF)));
    expect(fieldTheme.colorScheme.onSurface, shearDarkInk);
    expect(tester.widget<Card>(find.byType(Card).first).color, shearDarkCard);

    await tester.tap(find.byIcon(Icons.light_mode));
    await tester.pump();
    expect(tester.widget<Card>(find.byType(Card).first).color, shearCard);
    expect(Theme.of(tester.element(find.byType(Card).first)).colorScheme.onSurface, shearInk);
    expect(Theme.of(tester.element(find.byType(TextField).first)).inputDecorationTheme.fillColor, shearField);
  });

  testWidgets('Resistance has no Mine/Stop and does not hash in the wallet', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-nomine-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger(), startUnlocked: true, skipPoolSync: true));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Resistance'));
    await tester.pump();
    expect(find.text('Mine'), findsNothing);
    expect(find.text('Stop'), findsNothing);
    expect(find.text('Mining…'), findsNothing);
    expect(find.textContaining('does not mine'), findsNothing);
    expect(find.textContaining('CTF CLI'), findsWidgets);
    expect(find.textContaining('Waiting for CTF'), findsWidgets);
    expect(File('lib/shear_miner_host.dart').existsSync(), isFalse);
    expect(tester.widget<ColoredBox>(find.byKey(const Key('resistance-cli'))).color, kCliLightBg);
    await tester.tap(find.byIcon(Icons.dark_mode));
    await tester.pump();
    expect(tester.widget<ColoredBox>(find.byKey(const Key('resistance-cli'))).color, kCliDarkBg);
    expect(tester.widget<SelectableText>(find.byType(SelectableText).last).style?.color, kCliDarkFg);
  });

  test('ctfTranscript uses destForLogin and prints she1 ssa1 shear1 spendable credit', () {
    final id = createIdentity();
    final ledger = ShearLedger()..viewSecret = id.viewKey;
    final tx = ledger.confirmRound(address: id.address, pot: 1, height: 7);
    ledger.settleTo(7 + ShearLedger.spendableConfirmations);
    expect(tx.to.startsWith('ssa1'), isTrue);
    final dest = destForLogin(
      id.address,
      height: ledger.tipHeight,
      continuityRoot: ledger.lag1Root,
      viewKey: id.viewKey,
    )!;
    expect(tx.to, dest);
    final text = ctfTranscript(
      identity: id,
      tx: tx,
      spendableAfter: ledger.spendable(id.address),
      continuityRoot: ledger.lag1Root,
    );
    expect(text.contains(id.address), isTrue);
    expect(id.address.startsWith('shear1'), isTrue);
    expect(text.contains(id.paymentCode), isTrue);
    expect(id.paymentCode.startsWith('she1'), isTrue);
    expect(text.contains(dest), isTrue);
    expect(dest.startsWith('ssa1'), isTrue);
    expect(text.contains(formatShe(tx.amount)), isTrue);
    expect(text.contains(ctfClosurePersonal), isTrue);
    expect(text.contains(ctfFlowPersonal), isTrue);
    expect(text.contains('spendable'), isTrue);
    expect(text.contains(closureCommit(id.viewKey).map((b) => b.toRadixString(16).padLeft(2, '0')).join()), isTrue);
  });

  testWidgets('Shearview tap opens Resistance CLI for that tx', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-cli-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    final ident = session.identity!;
    final ledger = ShearLedger()..viewSecret = ident.viewKey;
    final tx = ledger.confirmRound(address: ident.address, pot: 1, height: 3);
    ledger.settleTo(3 + ShearLedger.continuumConfirmations - 1);
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ledger, startUnlocked: true, skipPoolSync: true));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Shearview'));
    await tester.pump();
    await tester.tap(find.text('block  ${formatShe(tx.amount)} SHE'));
    await tester.pump();
    expect(find.textContaining('CTF CLI'), findsWidgets);
    expect(find.textContaining(formatShe(tx.amount)), findsWidgets);
    expect(find.textContaining(ident.address), findsWidgets);
    expect(find.textContaining(ident.paymentCode), findsWidgets);
    expect(find.textContaining(tx.to), findsWidgets);
    expect(find.textContaining('chronoflux-G-v1'), findsWidgets);
  });

  testWidgets('demoTx records a confirmed round on Resistance CLI', (tester) async {
    _tallContinuum(tester);
    final dir = Directory.systemTemp.createTempSync('shear-demo-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    final ident = session.identity!;
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger(), demoTx: true, startUnlocked: true, skipPoolSync: true));
    await tester.pump();
    await tester.pump();
    expect(find.text('Pending'), findsNothing);
    await tester.pump(const Duration(seconds: 3));
    expect(find.text('Pending'), findsOneWidget);
    expect(find.textContaining(formatShe(0.25)), findsWidgets);
    await tester.pump(const Duration(seconds: 6));
    expect(find.text('Pending'), findsOneWidget);
    expect(find.byType(ConfirmPie), findsWidgets);
    await tester.tap(find.text('Resistance'));
    await tester.pump();
    expect(find.textContaining('CTF CLI'), findsWidgets);
    expect(find.textContaining(formatShe(0.25)), findsWidgets);
    expect(find.textContaining(ident.address), findsWidgets);
    expect(find.textContaining(ident.paymentCode), findsWidgets);
    expect(find.textContaining('ssa1'), findsWidgets);
    expect(find.textContaining('chronoflux-J-v1'), findsWidgets);
  });

  test('Reserve π vote gate, first-deposit epoch, 99-day cutoff, no public shear1 leak', () {
    final alice = createIdentity();
    final bob = createIdentity();
    final va = vaultDest(alice.address, viewKey: alice.viewKey)!;
    final vb = vaultDest(bob.address, viewKey: bob.viewKey)!;
    expect(va, isNot(vb));
    expect(extraMintAllowed(kReserveProgram), isTrue);
    expect(extraMintAllowed('other-dapp'), isFalse);
    final r = ShearReserve();
    const t0 = 1700000000000;
    expect(r.deposit(dest: va, she: 1, nowMs: t0), isNull);
    expect(r.epochStartMs, 0);
    expect(r.portal(va).canVote, isFalse);
    expect(r.vote(dest: va, choice: kVoteIncrease, nowMs: t0), 'not_voter');
    expect(r.deposit(dest: va, she: kPiShe, nowMs: t0 + 1), isNull);
    expect(r.epochStartMs, t0 + 1);
    expect(r.portal(va).canVote, isTrue);
    expect(r.vote(dest: va, choice: kVoteIncrease, nowMs: t0 + 2), isNull);
    final late = t0 + 1 + (400 - 98) * 86400000;
    expect(r.canJoin(late), isFalse);
    expect(r.cutoffDisclaimer(late), isTrue);
    expect(r.cutoffDisclaimer(t0 + 1), isFalse);
    expect(r.deposit(dest: vb, she: kPiShe, nowMs: late), isNull);
    expect(r.portal(vb).idle, kPiSheNanos);
    expect(r.portal(vb).staked, 0);
    expect(r.portal(vb).canVote, isTrue);
    expect(r.vote(dest: vb, choice: kVoteIncrease, nowMs: late), isNull);
    expect(r.vote(dest: vb, choice: kVoteHold, nowMs: late), 'vote_locked');
    expect(r.deposit(dest: va, she: 0.5, nowMs: late), isNull);
    expect(r.portal(va).idle, kUnitsPerShe ~/ 2);
    expect(r.portal(va).canVote, isTrue);
    final outAlice = r.withdraw(dest: va, nowMs: t0 + 1 + kReserveEpochMs);
    expect(outAlice, isNotNull);
    expect(outAlice!['idle'], kUnitsPerShe ~/ 2);
    expect(outAlice['interest']! > 0, isTrue);
    final outBob = r.withdraw(dest: vb, nowMs: t0 + 1 + kReserveEpochMs);
    expect(outBob, isNotNull);
    expect(outBob!['interest'], 0);
    expect(outBob['idle'], kPiSheNanos);
    final dump = r.publicJson(late);
    expect(dump.contains(alice.address), isFalse);
    expect(dump.contains(alice.viewKey), isFalse);
    expect(dump.contains('shear1'), isFalse);
    expect(dump.contains('viewKey'), isFalse);
    expect(dump.contains('oracleBps'), isTrue);
  });

  test('Reserve withdraw extra-mints interest onto Continuum spendable', () async {
    final alice = createIdentity();
    final ledger = ShearLedger();
    ledger.viewSecret = alice.viewKey;
    ledger.confirmRound(address: alice.address, pot: 10, height: 1);
    ledger.settleTo(1 + ShearLedger.spendableConfirmations);
    final continuum = ledger.currentDest(alice.address);
    final vault = vaultDest(alice.address, viewKey: alice.viewKey)!;
    expect(continuum, isNot(vault));
    expect(ledger.spendable(continuum), closeTo(10, 1e-12));
    const t0 = 1700000000000;
    final r = ShearReserve();
    expect(r.deposit(dest: vault, she: kPiShe, nowMs: t0, payout: continuum), isNull);
    await ledger.send(
      from: continuum,
      to: vault,
      amount: kPiShe,
      local: true,
      kind: 'lock',
      programId: kReserveProgram,
    );
    final afterLock = ledger.spendable(continuum);
    expect(afterLock, closeTo(10 - kPiShe, 1e-12));
    expect(r.withdrawTo(ledger, dest: vault, payout: continuum, nowMs: t0 + 10 * 86400000), isNull);
    final out = r.withdrawTo(ledger, dest: vault, payout: continuum, nowMs: t0 + kReserveEpochMs);
    expect(out, isNotNull);
    expect(out!['interest']! > 0, isTrue);
    expect(out['principal'], kPiSheNanos);
    final paid = (out['principal']! + out['interest']!) / kUnitsPerShe;
    expect(ledger.spendable(continuum), closeTo(afterLock + paid, 1e-12));
    expect(ledger.spendable(continuum), closeTo(10 - kPiShe + paid, 1e-12));
    expect(ledger.ownerHistory(alice.address).where((t) => t.kind == 'reserve').single.to, continuum);
    expect(r.portal(vault).nanos, 0);
  });

  test('Reserve accrued rewards grow on staked SHE and stay zero on idle SHE', () {
    final alice = createIdentity();
    final bob = createIdentity();
    final va = vaultDest(alice.address, viewKey: alice.viewKey)!;
    final vb = vaultDest(bob.address, viewKey: bob.viewKey)!;
    final r = ShearReserve();
    const t0 = 1700000000000;
    expect(r.deposit(dest: va, she: kPiShe, nowMs: t0), isNull);
    expect(r.epochStartMs, t0);
    expect(r.rewards(va, t0).accrued, 0);
    expect(r.rewards(va, t0).projected > 0, isTrue);
    final mid = r.rewards(va, t0 + 200 * 86400000);
    expect(mid.accrued, greaterThan(0));
    expect(mid.accrued, lessThan(mid.projected));
    final end = r.rewards(va, t0 + kReserveEpochMs);
    expect(end.accrued, end.projected);
    expect(end.accrued, reserveInterestNanos(kPiSheNanos, kReserveOracleDefaultBps));
    final late = t0 + (400 - 50) * 86400000;
    expect(r.deposit(dest: vb, she: kPiShe, nowMs: late), isNull);
    expect(r.rewards(vb, late + 86400000).accrued, 0);
    expect(r.rewards(vb, late + 86400000).projected, 0);
  });

  test('Join credits Continuum 1:1, refuses a second claim, and burns the rest after 99 days', () {
    final alice = createIdentity();
    final ledger = ShearLedger()..viewSecret = alice.viewKey;
    final payout = ledger.currentDest(alice.address);
    const t0 = 1800000000000;
    const owner = 'prior1alice';
    const amountPrior = 100000000000;
    final commit = sha256
        .convert(utf8.encode(kJoinLeafPersonal) + utf8.encode(owner) + utf8.encode('$amountPrior'))
        .toString();
    final vault = ShearJoin();
    vault.fundGenesis(nanos: 4 * kUnitsPerShe, nowMs: t0, snapshotRoot: commit);
    final key =
        'join1.${base64Url.encode(utf8.encode(jsonEncode({
              'v': 1,
              'owner': owner,
              'amountPrior': amountPrior,
              'commit': commit,
              'index': 0,
              'proof': [],
            }))).replaceAll('=', '')}';
    expect(vault.windowOpen(t0 + 1000), isTrue);
    expect(vault.claimTo(ledger, key: key, payout: payout, nowMs: t0 + 1000), isNotNull);
    expect(ledger.spendable(payout), closeTo(1, 1e-12));
    expect(vault.claimTo(ledger, key: key, payout: payout, nowMs: t0 + 2000), isNull);
    expect(ledger.spendable(payout), closeTo(1, 1e-12));
    vault.burnUnclaimed(t0 + kJoinWindowMs);
    expect(vault.burned, isTrue);
    expect(vault.remainingNanos, 0);
    final dump = jsonEncode(vault.publicView(t0));
    expect(dump.contains(alice.address), isFalse);
    expect(dump.contains(alice.viewKey), isFalse);
  });

  testWidgets('Vortex Reserve has amount, Send, add more, and votes when portal holds π', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-reserve-ui-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    final ident = session.identity!;
    final vault = ShearReserve();
    final dest = vaultDest(ident.address, viewKey: ident.viewKey)!;
    vault.deposit(dest: dest, she: kPiShe, nowMs: DateTime.now().millisecondsSinceEpoch);
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger(), reserve: vault, startUnlocked: true, skipPoolSync: true));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Vortex'));
    await tester.pump();
    expect(kTabs.contains('Reserve'), isFalse);
    expect(kTabs.contains('Join'), isFalse);
    expect(find.text('The Reserve'), findsWidgets);
    expect(find.text('Amount SHEAR'), findsOneWidget);
    expect(find.text('Send'), findsOneWidget);
    expect(find.text('Add more SHE to the vault'), findsOneWidget);
    expect(find.text('increase bonus'), findsOneWidget);
    expect(find.text('decrease bonus'), findsOneWidget);
    expect(find.text('leave bonus as-is'), findsOneWidget);
    expect(find.text(kReserveCutoffDisclaimer), findsNothing);
    expect(find.textContaining('Bank of England'), findsNothing);
    expect(find.textContaining('BoE'), findsNothing);
    expect(find.textContaining('Reserve oracle'), findsWidgets);
    expect(find.textContaining(kReserveAccruedLabel), findsOneWidget);
    expect(find.textContaining('At epoch end'), findsOneWidget);
    expect(find.textContaining('Observed rate'), findsOneWidget);
    expect(find.text('The Join'), findsOneWidget);
    await tester.tap(find.text('The Join'));
    await tester.pump();
    expect(find.text('Migration key'), findsOneWidget);
    expect(find.text('Credit'), findsOneWidget);
    expect(kTabs.contains('Join'), isFalse);
    expect(find.text('Add new vortice'), findsOneWidget);
    expect(find.text(joinWatchProgram), findsNothing);
  });

  testWidgets('Vortex deploys a third-party dapp only after a valid vort1. key download', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-vortice-ui-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    const origin = 'https://dapp.example/stake-pool-a.json';
    const source = '{"id":"stake-pool-a","pane":"ok"}';
    final key = mintVorticeDeployKey(
      programId: 'stake-pool-a',
      name: 'Stake Pool A',
      origin: origin,
      source: source,
    )!;
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ShearLedger(),
      startUnlocked: true,
      skipPoolSync: true,
      downloadVortice: (k) async => verifyVorticeDownload(k, source),
    ));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Vortex'));
    await tester.pump();
    expect(find.text('Stake Pool A'), findsNothing);
    await tester.tap(find.text('Add new vortice'));
    await tester.pump();
    await tester.enterText(find.byKey(const Key('vortice-key')), key);
    await tester.tap(find.text('Add vortice'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    expect(find.text('Stake Pool A'), findsWidgets);
    expect(find.textContaining(origin), findsWidgets);
    expect(session.deployedVortices.single.id, 'stake-pool-a');
    await tester.runAsync(() => session.persist());
    final reloaded = ShearSession(store: File('${dir.path}/session.json'));
    await reloaded.loadOrCreate();
    await tester.runAsync(() => reloaded.unlock(kGatePassword));
    expect(reloaded.deployedVortices.single.id, 'stake-pool-a');
    expect(reloaded.deployedVortices.single.origin, origin);
  });

  testWidgets('Vortex Reserve idle disclaimer only when remaining is under 99 days', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-reserve-idle-ui-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    final ident = session.identity!;
    final vault = ShearReserve();
    final dest = vaultDest(ident.address, viewKey: ident.viewKey)!;
    final otherId = createIdentity();
    final other = vaultDest(otherId.address, viewKey: otherId.viewKey)!;
    final now = DateTime.now().millisecondsSinceEpoch;
    final t0 = now - (400 - 50) * 86400000;
    expect(vault.deposit(dest: other, she: kPiShe, nowMs: t0), isNull);
    expect(vault.deposit(dest: dest, she: kPiShe, nowMs: now), isNull);
    expect(vault.portal(dest).canVote, isTrue);
    expect(vault.cutoffDisclaimer(now), isTrue);
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger(), reserve: vault, startUnlocked: true, skipPoolSync: true));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Vortex'));
    await tester.pump();
    expect(find.text(kReserveCutoffDisclaimer), findsOneWidget);
    expect(find.text('increase bonus'), findsOneWidget);
    expect(find.text('Amount SHEAR'), findsOneWidget);
    expect(find.text('Send'), findsOneWidget);
    expect(find.text('Add more SHE to the vault'), findsOneWidget);
  });

  test('send posts ssa1 from + memoCt; sender and recipient dests open plaintext, other dest does not', () async {
    final posted = <Map<String, dynamic>>[];
    final header = Uint8List(128);
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final server = await _fakePool(headerHex: hex, height: 1, posted: posted);
    addTearDown(() => server.close(force: true));
    final alice = createIdentity();
    final bob = createIdentity();
    final pool = ShearPoolClient(
      baseUrl: 'http://127.0.0.1:${server.port}',
      http: _realHttp(),
    );
    final aliceL = ShearLedger(pool: pool);
    aliceL.viewSecret = alice.viewKey;
    final from = aliceL.currentDest(alice.address);
    final to = destForLogin(bob.address, height: 1, viewKey: bob.viewKey)!;
    expect(from.startsWith('ssa1'), isTrue);
    expect(isDestAddress(from), isTrue);
    expect(from, isNot(alice.address));
    aliceL.creditHash(alice.address, hashes: 0);
    aliceL.confirmRound(address: alice.address, pot: 1, height: 1);
    aliceL.settleTo(1 + ShearLedger.spendableConfirmations);
    expect(aliceL.spendable(from), closeTo(1, 1e-12));
    expect(aliceL.spendable(from), aliceL.spendable(alice.address));
    // Taxed send pays Phase B L on top of the amount (1 SHE empty L = 0.0002).
    final tx = await aliceL.send(from: from, to: to, amount: 0.5, memo: 'secret-flow');
    expect(tx.from, from);
    expect(tx.to, to);
    expect(tx.memoPlain, 'secret-flow');
    expect(posted, isNotEmpty);
    expect(posted.last['from'], from);
    expect(posted.last['to'], to);
    expect(posted.last['from'].toString().startsWith('shear1'), isFalse);
    expect(posted.last['memoCt'], isNotNull);
    expect(await memoOpen(to, tx.memoCt), 'secret-flow');
    final other = destForLogin(bob.address, height: 2, viewKey: bob.viewKey)!;
    expect(await memoOpen(other, tx.memoCt), isNull);
    expect(
      aliceL.ownerHistory(alice.address).where((t) => t.kind == 'send').single.memoPlain,
      'secret-flow',
    );
  });

  test('Flow send uses silent dest when Continuum spendable sits there, not currentDest', () async {
    final alice = createIdentity();
    final bob = createIdentity();
    final header = Uint8List(128);
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final live = _PoolLive(headerHex: hex, height: 20, balance: 0);
    final silent = payoutDest(alice.paymentCode)!;
    live.destBalances[silent] = 1.5;
    final posted = <Map<String, dynamic>>[];
    final server = await _fakePool(live: live, posted: posted);
    addTearDown(() => server.close(force: true));
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _realHttp());
    final aliceL = ShearLedger(pool: pool)..viewSecret = alice.viewKey;
    await aliceL.syncCredits(alice.address, paymentCode: alice.paymentCode);
    final flow = aliceL.currentDest(alice.address);
    expect(flow, isNot(silent));
    expect(aliceL.spendable(flow), 0);
    expect(aliceL.spendableOwned(alice.address, paymentCode: alice.paymentCode), closeTo(1.5, 1e-18));
    expect(aliceL.spendFrom(alice.address, paymentCode: alice.paymentCode, amount: 0.4), silent);

    final to = destForLogin(bob.address, height: 1, viewKey: bob.viewKey)!;
    final tx = await aliceL.send(
      from: flow,
      to: to,
      amount: 0.4,
      restFrame: alice.address,
      paymentCode: alice.paymentCode,
    );
    expect(tx.from, silent);
    expect(posted.single['from'], silent);
    expect(posted.single['to'], to);
    expect(aliceL.spendableOwned(alice.address, paymentCode: alice.paymentCode), closeTo(1.1, 1e-18));
  });

  test('Reserve lock spends owned Continuum, not currentDest-only', () async {
    final alice = createIdentity();
    final header = Uint8List(128);
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final live = _PoolLive(headerHex: hex, height: 20, balance: 0);
    final silent = payoutDest(alice.paymentCode)!;
    live.destBalances[silent] = kPiShe;
    final server = await _fakePool(live: live);
    addTearDown(() => server.close(force: true));
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _realHttp());
    final ledger = ShearLedger(pool: pool)..viewSecret = alice.viewKey;
    await ledger.syncCredits(alice.address, paymentCode: alice.paymentCode);
    final flow = ledger.currentDest(alice.address);
    expect(ledger.spendable(flow) < kPiShe, isTrue);
    expect(ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode), closeTo(kPiShe, 1e-12));
    final from = ledger.spendFrom(alice.address, paymentCode: alice.paymentCode, amount: kPiShe);
    expect(from, silent);
    final vault = vaultDest(alice.address, viewKey: alice.viewKey)!;
    final r = ShearReserve();
    expect(r.deposit(dest: vault, she: kPiShe, nowMs: 1700000000000, payout: from), isNull);
    final tx = await ledger.send(
      from: flow,
      to: vault,
      amount: kPiShe,
      local: true,
      kind: 'lock',
      programId: kReserveProgram,
      restFrame: alice.address,
      paymentCode: alice.paymentCode,
    );
    expect(tx.kind, 'lock');
    expect(tx.from, silent);
    expect(ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode), closeTo(0, 1e-12));
    expect(r.portal(vault).staked, kPiSheNanos);
  });

  test('recipient reconstructs a Flow send as pending then spendable after confirms', () async {
    final alice = createIdentity();
    final bob = createIdentity();
    final header = Uint8List(128);
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final live = _PoolLive(headerHex: hex, height: 20, balance: 0);
    final silent = payoutDest(alice.paymentCode)!;
    live.destBalances[silent] = 2;
    final server = await _fakePool(live: live);
    addTearDown(() => server.close(force: true));
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _realHttp());
    final aliceL = ShearLedger(pool: pool)..viewSecret = alice.viewKey;
    final bobL = ShearLedger(pool: pool)..viewSecret = bob.viewKey;
    await aliceL.syncCredits(alice.address, paymentCode: alice.paymentCode);
    final to = payoutDest(bob.paymentCode)!;
    await aliceL.send(
      from: aliceL.currentDest(alice.address),
      to: to,
      amount: 0.5,
      restFrame: alice.address,
      paymentCode: alice.paymentCode,
    );
    await bobL.syncCredits(bob.address, paymentCode: bob.paymentCode);
    expect(bobL.pendingTxs(bob.address).any((t) => t.kind == 'receive' && t.to == to), isTrue);
    expect(bobL.spendableOwned(bob.address, paymentCode: bob.paymentCode), 0);

    live.height = 21;
    live.incoming = [];
    live.destBalances[to] = 0.5;
    await bobL.syncCredits(bob.address, paymentCode: bob.paymentCode);
    expect(
      bobL.spendableOwned(bob.address, paymentCode: bob.paymentCode),
      closeTo(0.5, 1e-18),
    );
  });

  test('wallet reads Reserve portal and Join remaining from node vaults, not public vortices', () async {
    final alice = createIdentity();
    final header = Uint8List(128);
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final live = _PoolLive(headerHex: hex, height: 8, balance: 0);
    final vault = vaultDest(alice.address, viewKey: alice.viewKey)!;
    live.reservePortal = {
      'ok': true,
      'public': false,
      'programId': kReserveProgram,
      'staked': kPiSheNanos,
      'idle': 0,
      'accrued': 1000,
      'projected': 2000,
    };
    live.joinVault = {
      'ok': true,
      'public': false,
      'programId': 'shear-join-v1',
      'remainingNanos': 3 * kUnitsPerShe,
      'burned': false,
    };
    final server = await _fakePool(live: live);
    addTearDown(() => server.close(force: true));
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _realHttp());
    final portal = await pool.reservePortal(vault);
    expect(portal['public'], isFalse);
    expect(portal['staked'], kPiSheNanos);
    expect(portal['accrued'], 1000);
    final join = await pool.joinVault(dest: vault);
    expect(join['public'], isFalse);
    expect(join['remainingNanos'], 3 * kUnitsPerShe);
    final r = ShearReserve();
    r.applyRemotePortal(vault, portal);
    expect(r.portal(vault).staked, kPiSheNanos);
    expect(r.rewards(vault, DateTime.now().millisecondsSinceEpoch).accrued, 1000);
  });

  test('Join claimViaPool credits Continuum 1:1 from a prior-ledger join1. key and refuses a second claim', () async {
    final alice = createIdentity();
    final header = Uint8List(128);
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    const holders = [
      {'owner': 'prior1alice', 'coins': 2.0},
      {'owner': 'prior1bob', 'coins': 5.0},
    ];
    final issued = issueJoinKey(owner: 'prior1alice', holders: holders)!;
    final parsed = ShearJoin().decodeKey(issued.key)!;
    final live = _PoolLive(headerHex: hex, height: 8, balance: 0);
    live.joinVault = {
      'genesisMs': 1800000000000,
      'remainingNanos': issued.circulatingNanos,
      'circulatingNanos': issued.circulatingNanos,
      'burned': false,
      'root': issued.root,
    };
    final server = await _fakePool(live: live);
    addTearDown(() => server.close(force: true));
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _realHttp());
    final ledger = ShearLedger(pool: pool)..viewSecret = alice.viewKey;
    final payout = ledger.currentDest(alice.address);
    final join = ShearJoin();
    join.applyRemote(Map<String, dynamic>.from(live.joinVault!));
    expect(join.windowOpen(1800000001000), isTrue);
    final out = await join.claimViaPool(ledger, pool: pool, key: issued.key, payout: payout);
    expect(out, isNotNull);
    expect(out!['pending'], 1);
    expect(ledger.spendable(payout), 0);
    final again = await join.claimViaPool(ledger, pool: pool, key: issued.key, payout: payout);
    expect(again, isNull);
    expect(ledger.spendable(payout), 0);
    ledger.applyPoolSnapshot(
      payout,
      {'balance': issued.she, 'pending': 0},
      beforeHeight: 1,
      tipSealed: ShearLedger.spendableConfirmations + 2,
    );
    expect(ledger.spendable(payout), closeTo(issued.she, 1e-12));
  });

  test('Continuum spendable ignores Join vault leftover', () {
    final alice = createIdentity();
    final ledger = ShearLedger()..viewSecret = alice.viewKey;
    final payout = ledger.currentDest(alice.address);
    final vault = canonicalJoinVaultDest();
    expect(vault.startsWith('ssa1'), isTrue);
    expect(isJoinVaultDest(vault), isTrue);
    ledger.applyPoolSnapshot(payout, {'balance': 3.17486194576, 'pending': 0}, beforeHeight: 0, tipSealed: 8);
    ledger.applyPoolSnapshot(vault, {'balance': 16.82513805424, 'pending': 0}, beforeHeight: 0, tipSealed: 8);
    expect(ledger.spendable(vault), 0);
    expect(ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode), closeTo(3.17486194576, 1e-12));
  });

  test('Join claim is pending until pool snapshot, then spendable; vault leftover stays 0', () {
    final alice = createIdentity();
    final ledger = ShearLedger()..viewSecret = alice.viewKey;
    const she = 3.17486194576;
    const leftover = 16.82513805424;
    final payout = ledger.currentDest(alice.address);
    final vault = canonicalJoinVaultDest();
    ledger.noteJoinPending(to: payout, amount: she);
    expect(ledger.pending(payout), closeTo(she, 1e-12));
    expect(ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode), 0);
    ledger.applyPoolSnapshot(payout, {'balance': she, 'pending': 0}, beforeHeight: 0, tipSealed: 8);
    ledger.applyPoolSnapshot(vault, {'balance': leftover, 'pending': 0}, beforeHeight: 0, tipSealed: 8);
    expect(ledger.pending(payout), 0);
    expect(ledger.spendable(vault), 0);
    expect(ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode), closeTo(she, 1e-12));
  });

  test('ingestJoinClaims remembers dest at claim height so Continuum still sees spendable', () async {
    final alice = createIdentity();
    final header = Uint8List(128);
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    const claimHeight = 636;
    const tip = 700;
    const she = 3.17486194576;
    final root = lag1ContinuityFromHeader(header);
    final destAtClaim = destForLogin(
      alice.address,
      height: claimHeight,
      continuityRoot: root,
      viewKey: alice.viewKey,
    )!;
    final destNow = destForLogin(
      alice.address,
      height: tip,
      continuityRoot: root,
      viewKey: alice.viewKey,
    )!;
    expect(destAtClaim.startsWith('ssa1'), isTrue);
    expect(destAtClaim, isNot(equals(destNow)));
    final live = _PoolLive(headerHex: hex, height: tip, balance: 0);
    live.history = [
      {'kind': 'claim', 'to': destAtClaim, 'height': claimHeight, 'amount': she},
    ];
    live.destBalances[destAtClaim] = she;
    live.destBalances[destNow] = 0;
    final server = await _fakePool(live: live);
    addTearDown(() => server.close(force: true));
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _realHttp());
    final ledger = ShearLedger(pool: pool)..viewSecret = alice.viewKey;
    expect(ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode), 0);
    final got = await ledger.syncCredits(alice.address, paymentCode: alice.paymentCode);
    expect(ledger.syncDests(alice.address, paymentCode: alice.paymentCode), contains(destAtClaim));
    expect(ledger.spendable(destAtClaim), closeTo(she, 1e-12));
    expect(got, closeTo(she, 1e-12));
  });

  test('homeDest is a stable ssa1 from shear1 — never the rest-frame on chain', () {
    final alice = createIdentity();
    final ledger = ShearLedger()..viewSecret = alice.viewKey;
    expect(alice.address.startsWith('shear1'), isTrue);
    final home = ledger.homeDest(alice.address, paymentCode: alice.paymentCode);
    expect(home.startsWith('ssa1'), isTrue);
    expect(home, isNot(equals(alice.address)));
    expect(isShearAddress(home), isFalse);
    ledger.tipHeight = 900;
    ledger.lag1Root = Uint8List(32)..fillRange(0, 32, 9);
    expect(ledger.homeDest(alice.address, paymentCode: alice.paymentCode), home);
    expect(ledger.currentDest(alice.address), isNot(equals(home)));
  });

  test('Join dest-at-height recovers spendable onto shear1 after dests are wiped', () async {
    final alice = createIdentity();
    final claimHeader = Uint8List(128);
    for (var i = 68; i < 100; i++) {
      claimHeader[i] = 1;
    }
    final tipHeader = Uint8List(128);
    for (var i = 68; i < 100; i++) {
      tipHeader[i] = 2;
    }
    const claimHeight = 740;
    const tip = 770;
    const she = 5.342943808;
    final claimRoot = lag1ContinuityFromHeader(claimHeader);
    final destAtClaim = destForLogin(
      alice.address,
      height: claimHeight,
      continuityRoot: claimRoot,
      viewKey: alice.viewKey,
    )!;
    final destNow = destForLogin(
      alice.address,
      height: tip,
      continuityRoot: lag1ContinuityFromHeader(tipHeader),
      viewKey: alice.viewKey,
    )!;
    expect(destAtClaim, isNot(equals(destNow)));
    expect(destAtClaim.startsWith('ssa1'), isTrue);
    final live = _PoolLive(
      headerHex: tipHeader.map((b) => b.toRadixString(16).padLeft(2, '0')).join(),
      height: tip,
      balance: 0,
    );
    live.headerAtHeight[claimHeight] =
        claimHeader.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    live.history = [
      {'kind': 'claim', 'to': destAtClaim, 'height': claimHeight, 'amount': she},
    ];
    live.destBalances[destAtClaim] = she;
    live.destBalances[destNow] = 0;
    final server = await _fakePool(live: live);
    addTearDown(() => server.close(force: true));
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _realHttp());
    final ledger = ShearLedger(pool: pool)..viewSecret = alice.viewKey;
    expect(ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode), 0);
    final got = await ledger.syncCredits(alice.address, paymentCode: alice.paymentCode);
    expect(ledger.exportedDests(), contains(destAtClaim));
    expect(got, closeTo(she, 1e-12));
    expect(ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode), closeTo(she, 1e-12));
    // Prune dest cache — shear1 spendable must return via dest-at-height, not a kept list.
    final fresh = ShearLedger(pool: pool)..viewSecret = alice.viewKey;
    final again = await fresh.syncCredits(alice.address, paymentCode: alice.paymentCode);
    expect(again, closeTo(she, 1e-12));
    expect(fresh.spendableOwned(alice.address, paymentCode: alice.paymentCode), closeTo(she, 1e-12));
  });

  test('remembered dests restore onto a new ledger so Continuum does not paint zero', () {
    final alice = createIdentity();
    final ledger = ShearLedger()..viewSecret = alice.viewKey;
    final home = ledger.homeDest(alice.address, paymentCode: alice.paymentCode);
    ledger.applyPoolSnapshot(home, {'balance': 5.0, 'pending': 0}, beforeHeight: 0, tipSealed: 8);
    expect(ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode), closeTo(5.0, 1e-12));
    final dests = ledger.exportedDests();
    final resumed = ShearLedger()..viewSecret = alice.viewKey;
    resumed.restoreDests(dests);
    resumed.applyPoolSnapshot(home, {'balance': 5.0, 'pending': 0}, beforeHeight: 0, tipSealed: 8);
    expect(resumed.spendableOwned(alice.address, paymentCode: alice.paymentCode), closeTo(5.0, 1e-12));
  });

  test('incoming send from the pool dest does not adopt the pool dest as owned', () async {
    final alice = createIdentity();
    final header = Uint8List(128);
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    const poolDest = 'ssa1q59sd89tfvs3qeavud7lwhnf55v58ev8hcxy9kc';
    final live = _PoolLive(headerHex: hex, height: 20, balance: 0);
    final silent = payoutDest(alice.paymentCode)!;
    live.destBalances[silent] = 4.0;
    live.destBalances[poolDest] = 650.0;
    live.history = [
      {
        'id': 'send-pool',
        'kind': 'send',
        'from': poolDest,
        'to': silent,
        'amount': 4.0,
        'height': 10,
        'confirmed': true,
      },
    ];
    final server = await _fakePool(live: live);
    addTearDown(() => server.close(force: true));
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _realHttp());
    final ledger = ShearLedger(pool: pool)..viewSecret = alice.viewKey;
    await ledger.syncCredits(alice.address, paymentCode: alice.paymentCode);
    expect(ledger.exportedDests(), isNot(contains(poolDest)));
    expect(ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode), closeTo(4.0, 1e-12));
    expect(ledger.spendable(poolDest), 0);

    ledger.restoreDests([poolDest, silent]);
    ledger.applyPoolSnapshot(poolDest, {'balance': 650.0, 'pending': 0}, beforeHeight: 0, tipSealed: 20);
    await ledger.syncCredits(alice.address, paymentCode: alice.paymentCode);
    expect(ledger.exportedDests(), isNot(contains(poolDest)));
    expect(ledger.spendable(poolDest), 0);
    expect(ledger.spendableOwned(alice.address, paymentCode: alice.paymentCode), closeTo(4.0, 1e-12));
  });

  test('openingForDest matches silent dest and dest-at-height; send posts that opening', () async {
    final alice = createIdentity();
    final bob = createIdentity();
    final silent = payoutDest(alice.paymentCode)!;
    final d0 = destAtIndex(alice.address, index: 0, viewKey: alice.viewKey)!;
    final openSilent = openingForDest(from: silent, restFrame: alice.address, viewKey: alice.viewKey)!;
    expect(openSilent.length, 128);
    final openIdx = openingForDest(from: d0, restFrame: alice.address, viewKey: alice.viewKey)!;
    expect(openIdx.length, 120);
    expect(openSilent, isNot(openIdx));

    final header = Uint8List(128);
    final hex = header.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final live = _PoolLive(headerHex: hex, height: 20, balance: 0);
    live.destBalances[silent] = 2.0;
    final posted = <Map<String, dynamic>>[];
    final server = await _fakePool(live: live, posted: posted);
    addTearDown(() => server.close(force: true));
    final pool = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}', http: _realHttp());
    final ledger = ShearLedger(pool: pool)..viewSecret = alice.viewKey;
    await ledger.syncCredits(alice.address, paymentCode: alice.paymentCode);
    final to = destForLogin(bob.address, height: 1, viewKey: bob.viewKey)!;
    await ledger.send(
      from: silent,
      to: to,
      amount: 0.4,
      restFrame: alice.address,
      paymentCode: alice.paymentCode,
    );
    expect(posted.single['open'], openSilent);
    expect(posted.single['from'], silent);
  });

  test('third-party vortice cannot mint SHE or impersonate Reserve/Join/pool-unlock; UI has no password or join1', () {
    expect(extraMintAllowed(reserveProgram), isTrue);
    expect(extraMintAllowed('vort1.random-printer'), isFalse);
    expect(validProgramId(reserveProgram), isNull);
    expect(validProgramId(joinProgram), isNull);
    expect(validProgramId(poolUnlockProgram), isNull);
    expect(validOrigin('javascript:alert(1)'), isNull);
    final dartMain = File('lib/main.dart').readAsStringSync();
    final vortexFn = dartMain.substring(dartMain.indexOf('Widget _vortex('), dartMain.indexOf('Widget _closure('));
    expect(vortexFn.contains('labelText: \'Password\''), isFalse);
    expect(vortexFn.contains('twelve'), isFalse);
    expect(dartMain.contains('poolUnlockSend('), isTrue);
    expect(dartMain.contains('Third-party vortice cannot mint SHE'), isTrue);
    final third = dartMain.substring(
      dartMain.indexOf('Third-party vortice cannot mint SHE'),
      dartMain.indexOf('Widget _closure('),
    );
    expect(third.contains('join1.'), isFalse);
    expect(third.contains('Password'), isFalse);
  });

  testWidgets('unlocked matching she1 signs pending pool pull; cancel and mismatch do not', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-pull-sign-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    final ident = session.identity!;
    final dest = destForLogin(ident.address, height: 1, viewKey: ident.viewKey)!;
    expect(dest.startsWith('ssa1'), isTrue);
    const confirmedNanos = 5 * 100000000000; // 5 SHE confirmed, not a Flow field
    final other = createIdentity();
    final pool = _MemPullPool();
    final ledger = ShearLedger(pool: pool)..viewSecret = ident.viewKey;
    ledger.confirmRound(address: ident.address, pot: 1, height: 1);
    ledger.settleTo(ShearLedger.spendableConfirmations);
    final appKey = GlobalKey<ShearWalletAppState>();
    await tester.pumpWidget(ShearWalletApp(
      key: appKey,
      session: session,
      ledger: ledger,
      startUnlocked: true,
      skipPoolSync: true,
    ));
    await tester.pump();
    await tester.pump();
    expect(find.text('Spendable'), findsOneWidget);

    pool.pending = {
      'id': 'pull-other-1',
      'login': other.paymentCode,
      'dest': dest,
      'nanos': confirmedNanos,
      'chainId': 2701,
    };
    final mismatchFut = appKey.currentState!.pollPullNow();
    await tester.pump();
    await tester.pump();
    await mismatchFut;
    expect(find.byKey(const Key('pull-sign')), findsNothing);
    expect(find.text('Sign pool pull'), findsNothing);
    expect(pool.posted, isEmpty);
    expect(ledger.transactions.where((t) => t.kind == 'pool-withdraw'), isEmpty);

    pool.pending = {
      'id': 'pull-match-cancel',
      'login': ident.paymentCode,
      'dest': dest,
      'nanos': confirmedNanos,
      'chainId': 2701,
    };
    final cancelFut = appKey.currentState!.pollPullNow();
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('pull-sign')), findsOneWidget);
    expect(find.text('Sign pool pull'), findsOneWidget);
    expect(find.byKey(const Key('pull-sign-accept')), findsOneWidget);
    expect(find.byKey(const Key('pull-sign-cancel')), findsOneWidget);
    expect(
      find.descendant(of: find.byKey(const Key('pull-sign')), matching: find.byType(TextField)),
      findsNothing,
    );
    expect(
      find.descendant(of: find.byKey(const Key('pull-sign')), matching: find.text('Flow')),
      findsNothing,
    );
    expect(find.textContaining(dest), findsWidgets);
    await tester.tap(find.byKey(const Key('pull-sign-cancel')));
    await tester.pump();
    await cancelFut;
    expect(find.byKey(const Key('pull-sign')), findsNothing);
    expect(pool.posted, isEmpty);
    expect(ledger.transactions.where((t) => t.kind == 'pool-withdraw'), isEmpty);
    final cancelAgain = appKey.currentState!.pollPullNow();
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('pull-sign')), findsNothing);
    await cancelAgain;

    pool.withdrawOk = false;
    pool.withdrawReason = 'unsigned';
    pool.pending = {
      'id': 'pull-match-fail',
      'login': ident.paymentCode,
      'dest': dest,
      'nanos': confirmedNanos,
      'chainId': 2701,
    };
    final failFut = appKey.currentState!.pollPullNow();
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('pull-sign')), findsOneWidget);
    await tester.tap(find.byKey(const Key('pull-sign-accept')));
    await tester.pump();
    await failFut;
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('pull-sign')), findsNothing);
    expect(find.byKey(const Key('pull-sign-error-unsigned')), findsOneWidget);
    expect(find.textContaining('Pool withdraw: unsigned'), findsWidgets);
    final failAgain = appKey.currentState!.pollPullNow();
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('pull-sign')), findsNothing);
    await failAgain;

    pool.withdrawOk = true;
    pool.pending = {
      'id': 'pull-match-sign',
      'login': ident.paymentCode,
      'dest': dest,
      'nanos': confirmedNanos,
      'chainId': 2701,
    };
    final signFut = appKey.currentState!.pollPullNow();
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('pull-sign')), findsOneWidget);
    await tester.tap(find.byKey(const Key('pull-sign-accept')));
    await tester.pump();
    await signFut;
    pool.pending = null;
    expect(pool.posted, hasLength(2));
    final posted = pool.posted.last;
    expect(posted['login'], ident.paymentCode);
    expect(posted['dest'], dest);
    expect(posted['nanos'], confirmedNanos);
    expect(posted.containsKey('amount'), isFalse);
    expect(posted['nanos'], isNot(1 * 100000000000));
    expect(
      verifyPoolWithdrawSig(
        login: ident.paymentCode,
        dest: dest,
        nanos: confirmedNanos,
        sig: posted['sig']?.toString() ?? '',
      ),
      isTrue,
    );
    expect(
      verifyPoolWithdrawSig(
        login: ident.paymentCode,
        dest: dest,
        nanos: 1 * 100000000000,
        sig: posted['sig']?.toString() ?? '',
      ),
      isFalse,
    );
    final pulls = ledger.transactions.where((t) => t.kind == 'pool-withdraw').toList();
    expect(pulls, hasLength(1));
    expect(pulls.single.to, dest);
    expect(pulls.single.amount, closeTo(confirmedNanos / kUnitsPerShe, 1e-12));
    expect(find.byKey(const Key('pull-sign')), findsNothing);
    ledger.prune();
    expect(ledger.transactions.where((t) => t.kind == 'pool-withdraw'), hasLength(1));
    final continuum = ledger.pendingTxs(ident.address).where((t) => t.kind == 'pool-withdraw').toList();
    expect(continuum, hasLength(1));
    expect(continuum.single.to, dest);
    expect(continuum.single.confirmed, isFalse);
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.drag(find.byType(ListView).first, const Offset(0, -480));
    await tester.pump();
    expect(find.textContaining('pool-withdraw'), findsWidgets);
    expect(find.textContaining(formatShe(confirmedNanos / kUnitsPerShe)), findsWidgets);
    final afterOk = appKey.currentState!.pollPullNow();
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('pull-sign')), findsNothing);
    await afterOk;

    pool.withdrawOk = false;
    pool.withdrawReason = 'miner_coins';
    pool.pending = {
      'id': 'admin-send-5',
      'kind': 'admin-spendable',
      'login': ident.paymentCode,
      'dest': dest,
      'nanos': confirmedNanos,
      'chainId': 2701,
    };
    final adminFut = appKey.currentState!.pollPullNow();
    await tester.pump();
    await tester.pump();
    expect(find.text('Sign pool send'), findsOneWidget);
    await tester.tap(find.byKey(const Key('pull-sign-cancel')));
    await tester.pump();
    await adminFut;
    expect(find.byKey(const Key('pull-sign')), findsNothing);
    final adminAgain = appKey.currentState!.pollPullNow();
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('pull-sign')), findsNothing);
    await adminAgain;

    pool.pending = {
      'id': 'admin-send-5-fail',
      'kind': 'admin-spendable',
      'login': ident.paymentCode,
      'dest': dest,
      'nanos': confirmedNanos,
      'chainId': 2701,
    };
    final adminFail = appKey.currentState!.pollPullNow();
    await tester.pump();
    await tester.pump();
    expect(find.text('Sign pool send'), findsOneWidget);
    await tester.tap(find.byKey(const Key('pull-sign-accept')));
    await tester.pump();
    await adminFail;
    await tester.pump();
    await tester.pump();
    expect(pool.posted, hasLength(3));
    expect(find.byKey(const Key('pull-sign')), findsNothing);
    expect(find.byKey(const Key('pull-sign-error-miner_coins')), findsOneWidget);
    expect(find.textContaining('Pool withdraw: miner_coins'), findsWidgets);
    final adminFailAgain = appKey.currentState!.pollPullNow();
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('pull-sign')), findsNothing);
    await adminFailAgain;

    pool.withdrawOk = true;
    pool.pending = {
      'id': 'admin-send-5-ok',
      'kind': 'admin-spendable',
      'login': ident.paymentCode,
      'dest': dest,
      'nanos': confirmedNanos,
      'chainId': 2701,
    };
    final adminOk = appKey.currentState!.pollPullNow();
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('pull-sign')), findsOneWidget);
    expect(find.text('Sign pool send'), findsOneWidget);
    await tester.tap(find.byKey(const Key('pull-sign-accept')));
    await tester.pump();
    await adminOk;
    pool.pending = null;
    expect(pool.posted, hasLength(4));
    final adminPosted = pool.posted.last;
    expect(adminPosted['login'], ident.paymentCode);
    expect(adminPosted['dest'], dest);
    expect(adminPosted['nanos'], confirmedNanos);
    expect(
      verifyPoolWithdrawSig(
        login: ident.paymentCode,
        dest: dest,
        nanos: confirmedNanos,
        sig: adminPosted['sig']?.toString() ?? '',
      ),
      isTrue,
    );
    expect(find.byKey(const Key('pull-sign')), findsNothing);
    expect(find.text('Spendable'), findsOneWidget);
    final afterAdminOk = appKey.currentState!.pollPullNow();
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('pull-sign')), findsNothing);
    await afterAdminOk;
  });

  testWidgets('Continuum receive-qr encodes she1; Flow scan-qr fills To from scanQr', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-qr-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    final she1 = session.identity!.paymentCode;
    final dest = destForLogin(session.identity!.address, height: 1, viewKey: session.identity!.viewKey)!;
    String? scanned;
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ShearLedger(),
      startUnlocked: true,
      skipPoolSync: true,
      scanQr: () async => scanned,
    ));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('receive-qr')), findsNothing);
    expect(find.byKey(const Key('show-qr')), findsOneWidget);
    expect(find.text('Show QR code'), findsOneWidget);
    await tester.tap(find.byKey(const Key('show-qr')));
    await tester.pump();
    expect(find.byKey(const Key('receive-qr')), findsOneWidget);
    expect(find.byType(CustomPaint), findsWidgets);
    expect(encodeReceiveQr(she1), she1);
    expect(find.textContaining(she1), findsWidgets);
    expect(find.text('Pull from pool'), findsNothing);

    await tester.tap(find.text('Flow').first);
    await tester.pump();
    expect(find.byKey(const Key('scan-qr')), findsOneWidget);
    scanned = 'shear:$she1';
    await tester.tap(find.byKey(const Key('scan-qr')));
    await tester.pump();
    await tester.pump();
    final toField = find.byWidgetPredicate((w) =>
        w is TextField && w.decoration is InputDecoration && (w.decoration as InputDecoration).labelText == 'To (she1 or ssa1)');
    expect(tester.widget<TextField>(toField).controller!.text, she1);

    scanned = dest;
    await tester.tap(find.byKey(const Key('scan-qr')));
    await tester.pump();
    await tester.pump();
    expect(tester.widget<TextField>(toField).controller!.text, dest);

    scanned = 'not-a-qr';
    await tester.tap(find.byKey(const Key('scan-qr')));
    await tester.pump();
    await tester.pump();
    expect(find.text('Not a Shear receive QR.'), findsOneWidget);
    expect(tester.widget<TextField>(toField).controller!.text, dest);
  });

  testWidgets('lock gate Unlock with biometrics after Enable biometrics is sealed', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-bio-lock-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    session.biometricsEnabled = true;
    await tester.runAsync(() async {
      await session.persist();
    });
    final locked = ShearSession(store: session.store);
    final bio = MemoryBiometrics();
    await bio.rememberPassword(kGatePassword);
    final appKey = GlobalKey<ShearWalletAppState>();
    await tester.pumpWidget(ShearWalletApp(
      key: appKey,
      session: locked,
      ledger: ShearLedger(),
      biometrics: bio,
      skipPoolSync: true,
    ));
    await tester.pump();
    await tester.pump();
    expect(find.text('Spendable'), findsNothing);
    expect(find.byKey(const Key('unlock-biometrics')), findsOneWidget);
    expect(find.text('Unlock with biometrics'), findsOneWidget);
    await tester.runAsync(() async {
      await appKey.currentState!.unlockBiometricsNow();
    });
    await tester.pump();
    await tester.pump();
    expect(find.text('Spendable'), findsOneWidget);
  });

  testWidgets('MemoryBiometrics unlocks; toggling off forgets; shewall still needs password', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-bio-ui-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await _sealSession(tester, session);
    expect(session.biometricsEnabled, isFalse);
    final bio = MemoryBiometrics();
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ShearLedger(),
      biometrics: bio,
      startUnlocked: true,
      skipPoolSync: true,
    ));
    await tester.pump();
    await tester.pump();
    expect(find.text('Unlock with biometrics'), findsNothing);
    await tester.tap(find.text('Closure'));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const Key('settings-biometrics')));
    await tester.pump();
    final sw = tester.widget<SwitchListTile>(find.byKey(const Key('settings-biometrics')));
    expect(sw.value, isFalse);
    await tester.tap(find.descendant(
      of: find.byKey(const Key('settings-biometrics')),
      matching: find.byType(Switch),
    ));
    await tester.pump();
    expect(find.byKey(const Key('bio-seal')), findsOneWidget);
    await tester.enterText(find.byKey(const Key('bio-seal-password')), kGatePassword);
    await tester.tap(find.descendant(
      of: find.byKey(const Key('bio-seal')),
      matching: find.text('Seal'),
    ));
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));
    await tester.runAsync(() async {
      for (var i = 0; i < 40 && bio.stored != kGatePassword; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 25));
      }
    });
    await tester.pump();
    await tester.pump();
    expect(session.biometricsEnabled, isTrue);
    expect(bio.stored, kGatePassword);

    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ShearLedger(),
      biometrics: bio,
      startUnlocked: true,
      skipPoolSync: true,
    ));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Closure'));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const Key('settings-biometrics')));
    await tester.pump();
    expect(tester.widget<SwitchListTile>(find.byKey(const Key('settings-biometrics'))).value, isTrue);
    await tester.tap(find.descendant(
      of: find.byKey(const Key('settings-biometrics')),
      matching: find.byType(Switch),
    ));
    await tester.pump();
    await tester.runAsync(() async {
      for (var i = 0; i < 40 && bio.stored != null; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 25));
      }
    });
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));
    expect(session.biometricsEnabled, isFalse);
    expect(bio.stored, isNull);
    await tester.runAsync(() async {
      await session.persist();
    });
    await tester.pump(const Duration(seconds: 2));

    final locked = ShearSession(store: session.store);
    await tester.runAsync(() async {
      await locked.loadOrCreate();
      expect(locked.needsUnlock, isTrue);
      await expectLater(locked.unlock('not-the-password'), throwsA(isA<FormatException>()));
      final opened = await locked.unlock(kGatePassword);
      expect(opened.address, session.identity!.address);
      expect(locked.biometricsEnabled, isFalse);
    });

    session.biometricsEnabled = true;
    await tester.runAsync(() async {
      await session.persist();
      await bio.rememberPassword(kGatePassword);
    });
    await tester.pump(const Duration(seconds: 2));
    expect(await bio.authenticate(), isTrue);
    expect(await bio.recalledPassword(), kGatePassword);
  });
}

class _MemPullPool extends ShearPoolClient {
  _MemPullPool() : super(baseUrl: 'http://127.0.0.1:9');

  Map<String, dynamic>? pending;
  final List<Map<String, dynamic>> posted = [];
  bool withdrawOk = true;
  String withdrawReason = 'unsigned';

  @override
  Future<Map<String, dynamic>> pullPending(String login) async => {
        'ok': true,
        'public': false,
        'pending': pending,
        'chainId': 2701,
      };

  @override
  Future<Map<String, dynamic>> poolWithdraw({
    required String login,
    required String dest,
    required int nanos,
    required String sig,
  }) async {
    posted.add({'login': login, 'dest': dest, 'nanos': nanos, 'sig': sig});
    if (!withdrawOk) {
      return {'ok': false, 'reason': withdrawReason, 'public': false};
    }
    return {
      'ok': true,
      'tx': {'id': 'pull-tx-1', 'to': dest, 'nanos': nanos, 'kind': 'pool-withdraw'},
    };
  }
}

HttpClient _realHttp() {
  // Flutter's test binding stubs `HttpClient()` to HTTP 400. The default
  // HttpOverrides.createHttpClient path is the real dart:io client.
  return _PassthroughHttpOverrides().createHttpClient(null)
    ..connectionTimeout = const Duration(seconds: 8);
}

class _PassthroughHttpOverrides extends HttpOverrides {}

class _PoolLive {
  _PoolLive({
    required this.headerHex,
    required this.height,
    this.balance = 10,
    this.pending = 0,
    this.avgBlockTimeMs = 90000,
    this.owner,
    List<Map<String, dynamic>>? incoming,
    List<Map<String, dynamic>>? history,
  })  : incoming = incoming ?? [],
        history = history ?? [];

  String headerHex;
  int height;
  double balance;
  double pending;
  int avgBlockTimeMs;
  String? owner;
  List<Map<String, dynamic>> incoming;
  List<Map<String, dynamic>> history;
  int balanceHits = 0;
  /// Per-dest reconstructed spendable. When set, /api/wallet/balance and
  /// /api/wallet/send use it instead of the single [balance]/[owner] pair.
  final Map<String, double> destBalances = {};
  Map<String, dynamic>? reservePortal;
  Map<String, dynamic>? joinVault;
  final Set<String> joinClaimed = {};
  Map<String, dynamic>? pendingPull;
  final List<Map<String, dynamic>> postedWithdraws = [];
  final Map<int, String> headerAtHeight = {};

  double reconstructed(String addr) {
    if (destBalances.isEmpty) {
      final hit = owner == null ||
          addr == owner ||
          payoutDest(addr) == owner ||
          incoming.any((r) => r['to'] == addr);
      return hit ? balance : 0;
    }
    final paid = payoutDest(addr) ?? addr;
    return destBalances[addr] ?? destBalances[paid] ?? 0;
  }
}

Future<HttpServer> _fakePool({
  String? headerHex,
  int? height,
  List<Map<String, dynamic>>? posted,
  _PoolLive? live,
}) async {
  final state = live ??
      _PoolLive(
        headerHex: headerHex ?? '',
        height: height ?? 1,
      );
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((req) async {
    final chunks = <int>[];
    await for (final c in req) {
      chunks.addAll(c);
    }
    Map<String, dynamic> body = {};
    if (chunks.isNotEmpty) {
      body = Map<String, dynamic>.from(jsonDecode(utf8.decode(chunks)) as Map);
    }
    req.response.headers.contentType = ContentType.json;
    if (req.uri.path == '/api/stats') {
      req.response.write(jsonEncode({
        'ok': true,
        'height': state.height,
        'header': state.headerHex,
        'avgBlockTimeMs': state.avgBlockTimeMs,
        'networkAvgBlockTimeMs': state.avgBlockTimeMs,
      }));
    } else if (req.uri.path == '/api/explorer/header') {
      final h = int.tryParse(req.uri.queryParameters['height'] ?? '') ?? 0;
      final hex = state.headerAtHeight[h] ?? state.headerHex;
      req.response.write(jsonEncode({
        'ok': true,
        'height': h,
        'header': hex,
        'continuity': hex.length >= 200 ? hex.substring(136, 200) : '',
      }));
    } else if (req.uri.path == '/api/wallet/balance') {
      state.balanceHits += 1;
      final addr = req.uri.queryParameters['address'] ?? '';
      final incoming = state.incoming.where((r) => r['to'] == addr || payoutDest(r['to']?.toString() ?? '') == addr).toList();
      req.response.write(jsonEncode({
        'balance': state.reconstructed(addr),
        'pending': (state.destBalances.isEmpty &&
                (state.owner == null || addr == state.owner || payoutDest(addr) == state.owner))
            ? state.pending
            : 0,
        'incoming': incoming,
        'height': state.height,
      }));
    } else if (req.uri.path == '/api/wallet/history' || req.uri.path == '/api/explorer/history') {
      req.response.write(jsonEncode({'txs': state.history}));
    } else if (req.uri.path == '/api/wallet/register') {
      req.response.write(jsonEncode({'ok': true}));
    } else if (req.uri.path == '/api/vault/reserve') {
      req.response.write(jsonEncode(state.reservePortal ?? {'ok': true, 'public': false, 'staked': 0, 'idle': 0, 'accrued': 0}));
    } else if (req.uri.path == '/api/vault/join') {
      req.response.write(jsonEncode(state.joinVault ?? {'ok': true, 'public': false, 'remainingNanos': 0, 'burned': false}));
    } else if (req.uri.path == '/api/join/claim') {
      final key = body['key']?.toString() ?? '';
      final payout = body['payout']?.toString() ?? '';
      final j = ShearJoin();
      if (state.joinVault != null) j.applyRemote(Map<String, dynamic>.from(state.joinVault!));
      final parsed = j.decodeKey(key);
      if (parsed == null) {
        req.response.statusCode = 400;
        req.response.write(jsonEncode({'ok': false, 'reason': 'bad_key'}));
      } else if (j.genesisMs == 0) {
        req.response.statusCode = 400;
        req.response.write(jsonEncode({'ok': false, 'reason': 'no_snapshot'}));
      } else if (parsed != null && state.joinClaimed.contains(parsed.commit)) {
        req.response.statusCode = 400;
        req.response.write(jsonEncode({'ok': false, 'reason': 'already_claimed'}));
      } else {
        final err = j.claim(key: key, payout: payout, nowMs: DateTime.now().millisecondsSinceEpoch);
        if (err != null) {
          req.response.statusCode = 400;
          req.response.write(jsonEncode({'ok': false, 'reason': err}));
        } else {
          state.joinVault = Map<String, dynamic>.from(j.publicView(DateTime.now().millisecondsSinceEpoch));
          state.joinClaimed.add(parsed.commit);
          req.response.write(jsonEncode({
            'ok': true,
            'public': false,
            'she': parsed.she,
            'nanos': parsed.shearNanos,
            'to': payout,
            'remainingNanos': j.remainingNanos,
            'genesisMs': j.genesisMs,
            'burned': j.burned,
            'root': j.root,
          }));
        }
      }
    } else if (req.uri.path == '/api/pool/pullPending' || req.uri.path == '/api/pool/pullpending') {
      req.response.write(jsonEncode({
        'ok': true,
        'public': false,
        'pending': state.pendingPull,
        'chainId': 2701,
      }));
    } else if (req.uri.path == '/api/pool/withdraw') {
      state.postedWithdraws.add(Map<String, dynamic>.from(body));
      final login = body['login']?.toString() ?? '';
      final dest = body['dest']?.toString() ?? '';
      final nanos = (body['nanos'] as num?)?.round() ?? 0;
      final sig = body['sig']?.toString() ?? '';
      if (!verifyPoolWithdrawSig(login: login, dest: dest, nanos: nanos, sig: sig)) {
        req.response.statusCode = 400;
        req.response.write(jsonEncode({'ok': false, 'reason': 'unsigned'}));
      } else {
        state.pendingPull = null;
        req.response.write(jsonEncode({
          'ok': true,
          'tx': {'id': 'pull-tx-1', 'to': dest, 'nanos': nanos, 'kind': 'pool-withdraw'},
        }));
      }
    } else if (req.uri.path == '/api/wallet/send') {
      posted?.add(body);
      final from = body['from']?.toString() ?? '';
      final to = body['to']?.toString() ?? '';
      final amount = (body['amount'] as num?)?.toDouble() ?? 0;
      final fromKey = payoutDest(from) ?? from;
      final fromBal = state.reconstructed(from);
      if (fromBal < amount) {
        req.response.statusCode = 400;
        req.response.write(jsonEncode({'ok': false, 'reason': 'insufficient'}));
      } else {
        final next = fromBal - amount;
        if (state.destBalances.isNotEmpty) {
          state.destBalances[fromKey] = next;
        } else {
          state.balance = next;
        }
        state.incoming = [
          ...state.incoming,
          {
            'id': 'send-${state.incoming.length + 1}',
            'from': fromKey,
            'to': to,
            'amount': amount,
            'kind': 'receive',
            'confirmed': false,
          },
        ];
        req.response.write(jsonEncode({
          'ok': true,
          'fromBalance': next,
          'tx': {
            'id': 'send-${state.incoming.length}',
            'from': fromKey,
            'to': to,
            'amount': amount,
            'kind': 'send',
            'confirmed': false,
            'memo': body['memoCt'] != null,
          },
        }));
      }
    } else {
      req.response.statusCode = 404;
      req.response.write('{}');
    }
    await req.response.close();
  });
  return server;
}
