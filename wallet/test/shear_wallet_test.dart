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
import 'package:crypto/crypto.dart';

void main() {
  test('new identity is shear1 with a stable view key after persist/reload', () async {
    final dir = Directory.systemTemp.createTempSync('shear-sess-');
    final store = File('${dir.path}/session.json');
    final s1 = ShearSession(store: store);
    final a = await s1.loadOrCreate();
    expect(a.address.startsWith('shear1'), isTrue);
    expect(isShearAddress(a.address), isTrue);
    expect(a.paymentCode.startsWith('she1'), isTrue);
    expect(a.paymentCode.length < 50, isTrue);
    expect(isPaymentCode(a.paymentCode), isTrue);
    expect(isDestAddress(a.paymentCode), isFalse);
    expect(a.viewKey.isNotEmpty, isTrue);
    final s2 = ShearSession(store: store);
    final b = await s2.loadOrCreate();
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
    expect(ledger.pendingTxs(id.address).length, 1);
    expect(ledger.pendingTxs(id.address).single.kind, 'hash');
    expect(ledger.transactions.where((t) => t.kind == 'sample'), isEmpty);
    final fatDump = jsonEncode(exportShewall(identity: id, ledger: ledger));
    expect(fatDump.contains('"kind":"sample"'), isFalse);
    expect(utf8.encode(fatDump).length < 4000, isTrue);
    ledger.confirmRound(address: id.address, pot: 1, height: 7);
    expect(ledger.transactions.where((t) => t.kind == 'hash'), isEmpty);
    expect(ledger.transactions.length, 1);
    expect(ledger.pending(id.address), 0);
    expect(ledger.spendable(id.address), 0);
    expect(ledger.pendingTxs(id.address).single.kind, 'coinbase');
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
    expect(ledger.pendingTxs(id.address).single.kind, 'hash');
    expect(ledger.ownerHistory(id.address), isEmpty);
    ledger.confirmRound(address: id.address, pot: 1, height: 3);
    expect(ledger.pending(id.address), 0);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
    expect(ledger.pendingTxs(id.address).where((t) => t.kind == 'hash'), isEmpty);
    expect(ledger.pendingTxs(id.address).any((t) => t.kind == 'coinbase'), isTrue);
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
    expect(ledger.pendingTxs(id.address).length, 2);
    expect(ledger.pendingTxs(id.address).any((t) => t.kind == 'hash'), isTrue);
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
    expect(ledger.ownerHistory(id.address).any((t) => t.kind == 'coinbase' && t.confirmed), isTrue);
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
    expect(ledger.pendingTxs(id.address).length, 2);
    expect(ledger.pendingTxs(id.address).any((t) => t.kind == 'hash'), isTrue);
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
    expect(ledger.pendingTxs(id.address).any((t) => t.kind == 'hash'), isTrue);
    expect(ledger.pendingTxs(id.address).any((t) => t.kind == 'receive' && t.id == 'in-boot'), isTrue);
    expect(ledger.pending(id.paymentCode), closeTo(0.4 + 7 * kHashBonusShe, 1e-18));
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
    expect(ledger.pendingTxs(id.address).any((t) => t.kind == 'hash'), isTrue);
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
    expect(fresh.pendingTxs(dest).any((t) => t.kind == 'hash'), isTrue);
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
    expect(kWalletVersion, '0.1');
    expect(kWalletVersion.split('.').length, 2);
    expect(RegExp(r'^\d+\.\d+$').hasMatch(kWalletVersion), isTrue);
    expect(RegExp(r'^\d+\.\d+\.\d+$').hasMatch(kWalletVersion), isFalse);
    expect(RegExp(r'^\d+\.\d+$').hasMatch('0.10'), isTrue);
    expect(RegExp(r'^\d+\.\d+$').hasMatch('0.1.0'), isFalse);
    expect(formatShe(1), '1');
    expect(formatShe(kHashBonusShe), '0.00000000');
    expect(formatShe(1e-8), '0.00000001');
    expect(kHashBonusShe, 0.00000000001);
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

  testWidgets('six Chronoflux tabs and light pool colors', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-ui-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger()));
    await tester.pump();
    expect(shearBg.value, 0xFFEEF3F8);
    expect(shearInk.value, 0xFF0D2137);
    final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.title, 'Shear 0.1');
    expect(kWalletVersion, '0.1');
    // password gate first
    await tester.enterText(find.byType(TextField), 'pw');
    await tester.tap(find.text('Unlock'));
    await tester.pump();
    await tester.pump();
    expect(find.textContaining('0.1'), findsWidgets);
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
    await session.loadOrCreate();
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger()));
    await tester.pump();
    expect(shearDarkBg.value, isNot(shearBg.value));
    expect(kShearLogoAsset, 'assets/brand/logo.png');
    expect(kShearWordmarkLight, 'assets/brand/wordmark-text-light.png');
    expect(kShearWordmarkDark, 'assets/brand/wordmark-text-dark.png');
    expect(find.byType(Image), findsWidgets);
    await tester.tap(find.text('Dark mode'));
    await tester.pumpAndSettle();
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
    await session.loadOrCreate();
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger()));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'pw');
    await tester.tap(find.text('Unlock'));
    await tester.pump();
    await tester.pump();

    expect(find.textContaining('SHE'), findsWidgets);
    expect(find.text('Spendable'), findsOneWidget);
    expect(find.textContaining('block height:'), findsWidgets);
    expect(find.text('Copy ID'), findsOneWidget);
    expect(find.text('Receive ID'), findsOneWidget);
    expect(find.textContaining(session.identity!.paymentCode), findsWidgets);
    expect(find.text('Pending'), findsNothing);
    expect(find.text('Copy dest'), findsNothing);
    expect(find.text('New dest'), findsNothing);
    expect(find.text('Shearview  S_{μν}'), findsNothing);
    expect(find.text('No confirmed transactions yet.'), findsNothing);

    await tester.tap(find.text('Shearview'));
    await tester.pump();
    expect(find.text('Shearview  S_{μν}'), findsOneWidget);
    expect(find.text('No confirmed transactions yet.'), findsOneWidget);
    expect(find.text('Copy ID'), findsNothing);
  });

  testWidgets('Continuum lists pending sends until the next block, then Shearview has them', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-pending-ui-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    final ident = session.identity!;
    final ledger = ShearLedger()..viewSecret = ident.viewKey;
    final dest = ledger.currentDest(ident.address);
    ledger.confirmRound(address: ident.address, pot: 1, height: 2);
    ledger.settleTo(2 + ShearLedger.spendableConfirmations - 1);
    final other = createIdentity();
    final bob = destForLogin(other.address, height: 1, viewKey: other.viewKey)!;
    await ledger.send(from: dest, to: bob, amount: 0.25);
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ledger));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'pw');
    await tester.tap(find.text('Unlock'));
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
    final dir = Directory.systemTemp.createTempSync('shear-live-feed-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    final ident = session.identity!;
    final ledger = ShearLedger()..viewSecret = ident.viewKey;
    final dest = ledger.currentDest(ident.address);
    ledger.creditHash(ident.address, hashes: 100000000);
    final peer = createIdentity();
    final from = destForLogin(peer.address, height: 1, viewKey: peer.viewKey)!;
    ledger.creditReceive(to: dest, amount: 0.4, from: from, id: 'in-live');
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ledger));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'pw');
    await tester.tap(find.text('Unlock'));
    await tester.pump();
    await tester.pump();
    expect(find.text('Pending'), findsOneWidget);
    expect(find.textContaining('hash'), findsWidgets);
    expect(find.textContaining('receive'), findsWidgets);
    expect(find.textContaining(formatShe(0.4)), findsWidgets);
    expect(find.textContaining(formatShe(0.001)), findsWidgets);
    ledger.confirmRound(address: ident.address, pot: 0.1, height: 4);
    await tester.tap(find.text('Continuum'));
    await tester.pump();
    expect(find.textContaining('hash'), findsNothing);
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
    final dir = Directory.systemTemp.createTempSync('shear-pie-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    final ident = session.identity!;
    final ledger = ShearLedger()..viewSecret = ident.viewKey;
    final dest = ledger.currentDest(ident.address);
    final peer = createIdentity();
    final from = destForLogin(peer.address, height: 1, viewKey: peer.viewKey)!;
    ledger.creditReceive(to: dest, amount: 0.4, from: from, id: 'in-early');
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ledger));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'pw');
    await tester.tap(find.text('Unlock'));
    await tester.pump();
    await tester.pump();
    expect(find.text('Pending'), findsOneWidget);
    expect(find.byKey(const Key('confirm-pie-in-early')), findsOneWidget);
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
    await session.loadOrCreate();
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
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ledger));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'pw');
    await tester.tap(find.text('Unlock'));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Shearview'));
    await tester.pump();
    expect(find.textContaining('coinbase'), findsWidgets);
    expect(find.textContaining('receive'), findsWidgets);
    await tester.enterText(find.byKey(const Key('shearview-search')), 'secret-note');
    await tester.pump();
    expect(find.textContaining('receive'), findsWidgets);
    expect(find.textContaining('coinbase'), findsNothing);
    await tester.enterText(find.byKey(const Key('shearview-search')), 'nope-xyz');
    await tester.pump();
    expect(find.textContaining('receive'), findsNothing);
    expect(find.text('No confirmed transactions yet.'), findsOneWidget);
  });

  testWidgets('dark mode cards and fields are dark with light ink; light mode inverts', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-surfaces-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger()));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'pw');
    await tester.tap(find.text('Unlock'));
    await tester.pump();
    await tester.pump();

    var card = tester.widget<Card>(find.byType(Card));
    expect(card.color, shearCard);
    expect(card.color, isNot(shearDarkCard));

    await tester.tap(find.byIcon(Icons.dark_mode));
    await tester.pumpAndSettle();

    card = tester.widget<Card>(find.byType(Card));
    expect(card.color, shearDarkCard);
    expect(card.color!.value, isNot(0xFFFFFFFF));
    expect(Theme.of(tester.element(find.byType(Card))).colorScheme.onSurface, shearDarkInk);
    expect(Theme.of(tester.element(find.byType(Card))).scaffoldBackgroundColor, shearDarkBg);

    await tester.tap(find.text('Flow'));
    await tester.pump();
    final fieldCtx = tester.element(find.byType(TextField).first);
    final fieldTheme = Theme.of(fieldCtx);
    expect(fieldTheme.inputDecorationTheme.fillColor, shearDarkField);
    expect(fieldTheme.inputDecorationTheme.fillColor, isNot(const Color(0xFFFFFFFF)));
    expect(fieldTheme.colorScheme.onSurface, shearDarkInk);
    expect(tester.widget<Card>(find.byType(Card)).color, shearDarkCard);

    await tester.tap(find.byIcon(Icons.light_mode));
    await tester.pumpAndSettle();
    expect(tester.widget<Card>(find.byType(Card)).color, shearCard);
    expect(Theme.of(tester.element(find.byType(Card))).colorScheme.onSurface, shearInk);
    expect(Theme.of(tester.element(find.byType(TextField).first)).inputDecorationTheme.fillColor, shearField);
  });

  testWidgets('Resistance has no Mine/Stop and does not hash in the wallet', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-nomine-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger()));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'pw');
    await tester.tap(find.text('Unlock'));
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
    await tester.pumpAndSettle();
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
    await session.loadOrCreate();
    final ident = session.identity!;
    final ledger = ShearLedger()..viewSecret = ident.viewKey;
    final tx = ledger.confirmRound(address: ident.address, pot: 1, height: 3);
    ledger.settleTo(3 + ShearLedger.continuumConfirmations - 1);
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ledger));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'pw');
    await tester.tap(find.text('Unlock'));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Shearview'));
    await tester.pump();
    await tester.tap(find.text('${tx.kind}  ${formatShe(tx.amount)} SHE'));
    await tester.pump();
    expect(find.textContaining('CTF CLI'), findsWidgets);
    expect(find.textContaining(formatShe(tx.amount)), findsWidgets);
    expect(find.textContaining(ident.address), findsWidgets);
    expect(find.textContaining(ident.paymentCode), findsWidgets);
    expect(find.textContaining(tx.to), findsWidgets);
    expect(find.textContaining('chronoflux-G-v1'), findsWidgets);
  });

  testWidgets('demoTx records a confirmed round on Resistance CLI', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-demo-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    final ident = session.identity!;
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger(), demoTx: true));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'pw');
    await tester.tap(find.text('Unlock'));
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
    expect(r.portal(vb).canVote, isFalse);
    expect(r.vote(dest: vb, choice: kVoteIncrease, nowMs: late), 'not_voter');
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
    await session.loadOrCreate();
    final ident = session.identity!;
    final vault = ShearReserve();
    final dest = vaultDest(ident.address, viewKey: ident.viewKey)!;
    vault.deposit(dest: dest, she: kPiShe, nowMs: DateTime.now().millisecondsSinceEpoch);
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger(), reserve: vault));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'pw');
    await tester.tap(find.text('Unlock'));
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
    await session.loadOrCreate();
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
      downloadVortice: (k) async => verifyVorticeDownload(k, source),
    ));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'pw');
    await tester.tap(find.text('Unlock'));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Vortex'));
    await tester.pump();
    expect(find.text('Stake Pool A'), findsNothing);
    await tester.tap(find.text('Add new vortice'));
    await tester.pump();
    await tester.enterText(find.byType(TextField), key);
    await tester.pump();
    await tester.pump();
    expect(find.text('Stake Pool A'), findsWidgets);
    expect(find.textContaining(origin), findsWidgets);
    expect(session.deployedVortices.single.id, 'stake-pool-a');
    final reloaded = ShearSession(store: File('${dir.path}/session.json'));
    await reloaded.loadOrCreate();
    expect(reloaded.deployedVortices.single.id, 'stake-pool-a');
    expect(reloaded.deployedVortices.single.origin, origin);
  });

  testWidgets('Vortex Reserve idle disclaimer only when remaining is under 99 days', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-reserve-idle-ui-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    final ident = session.identity!;
    final vault = ShearReserve();
    final dest = vaultDest(ident.address, viewKey: ident.viewKey)!;
    final otherId = createIdentity();
    final other = vaultDest(otherId.address, viewKey: otherId.viewKey)!;
    final now = DateTime.now().millisecondsSinceEpoch;
    final t0 = now - (400 - 50) * 86400000;
    expect(vault.deposit(dest: other, she: kPiShe, nowMs: t0), isNull);
    expect(vault.deposit(dest: dest, she: kPiShe, nowMs: now), isNull);
    expect(vault.portal(dest).canVote, isFalse);
    expect(vault.cutoffDisclaimer(now), isTrue);
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger(), reserve: vault));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'pw');
    await tester.tap(find.text('Unlock'));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Vortex'));
    await tester.pump();
    expect(find.text(kReserveCutoffDisclaimer), findsOneWidget);
    expect(find.text('increase bonus'), findsNothing);
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
    final tx = await aliceL.send(from: from, to: to, amount: 1, memo: 'secret-flow');
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
    this.owner,
    List<Map<String, dynamic>>? incoming,
    List<Map<String, dynamic>>? history,
  })  : incoming = incoming ?? [],
        history = history ?? [];

  String headerHex;
  int height;
  double balance;
  double pending;
  String? owner;
  List<Map<String, dynamic>> incoming;
  List<Map<String, dynamic>> history;
  int balanceHits = 0;
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
      }));
    } else if (req.uri.path == '/api/wallet/balance') {
      state.balanceHits += 1;
      final addr = req.uri.queryParameters['address'] ?? '';
      final hit = state.owner == null ||
          addr == state.owner ||
          payoutDest(addr) == state.owner ||
          state.incoming.any((r) => r['to'] == addr);
      req.response.write(jsonEncode({
        'balance': hit ? state.balance : 0,
        'pending': hit ? state.pending : 0,
        'incoming': hit ? state.incoming : <Map<String, dynamic>>[],
        'height': state.height,
      }));
    } else if (req.uri.path == '/api/wallet/history' || req.uri.path == '/api/explorer/history') {
      req.response.write(jsonEncode({'txs': state.history}));
    } else if (req.uri.path == '/api/wallet/register') {
      req.response.write(jsonEncode({'ok': true}));
    } else if (req.uri.path == '/api/wallet/send') {
      posted?.add(body);
      req.response.write(jsonEncode({
        'ok': true,
        'fromBalance': 9,
        'tx': {
          'id': 'send-1',
          'from': body['from'],
          'to': body['to'],
          'amount': body['amount'],
          'kind': 'send',
          'confirmed': false,
          'memo': body['memoCt'] != null,
        },
      }));
    } else {
      req.response.statusCode = 404;
      req.response.write('{}');
    }
    await req.response.close();
  });
  return server;
}
