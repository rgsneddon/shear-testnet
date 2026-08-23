import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_lock.dart';
import 'package:shear_wallet/shear_session.dart';
import 'package:shear_wallet/shear_theme.dart';

void main() {
  test('new identity is shear1 with a stable view key after persist/reload', () async {
    final dir = Directory.systemTemp.createTempSync('shear-sess-');
    final store = File('${dir.path}/session.json');
    final s1 = ShearSession(store: store);
    final a = await s1.loadOrCreate();
    expect(a.address.startsWith('shear1'), isTrue);
    expect(isShearAddress(a.address), isTrue);
    expect(a.viewKey.isNotEmpty, isTrue);
    final s2 = ShearSession(store: store);
    final b = await s2.loadOrCreate();
    expect(b.address, a.address);
    expect(b.viewKey, a.viewKey);
  });

  test('wallet stays lean: thousands of hashes never become thousands of txs', () {
    final id = createIdentity();
    final ledger = ShearLedger();
    ledger.creditHash(id.address, hashes: 4000);
    expect(ledger.pending(id.address), closeTo(4e-6, 1e-18));
    expect(ledger.spendable(id.address), 0);
    expect(ledger.transactions, isEmpty);
    final fatDump = jsonEncode(exportShewall(identity: id, ledger: ledger));
    expect(fatDump.contains('"kind":"sample"'), isFalse);
    expect(utf8.encode(fatDump).length < 4000, isTrue);
    ledger.confirmRound(address: id.address, pot: 1, height: 7);
    expect(ledger.transactions.length, 1);
    expect(ledger.pending(id.address), 0);
    ledger.prune();
    expect(ledger.transactions.length, 1);
  });

  test('pending hashes are not spendable until block found; explorer lists confirmed round', () {
    final id = createIdentity();
    final ledger = ShearLedger();
    ledger.creditHash(id.address, hashes: 4);
    expect(ledger.pending(id.address), closeTo(4e-9, 1e-18));
    expect(ledger.spendable(id.address), 0);
    expect(ledger.ownerHistory(id.address), isEmpty);
    ledger.confirmRound(address: id.address, pot: 1, height: 3);
    expect(ledger.pending(id.address), 0);
    expect(ledger.spendable(id.address), closeTo(1 + 4e-9, 1e-18));
    expect(ledger.ownerHistory(id.address).single.confirmed, isTrue);
    expect(ledger.ownerHistory(id.address).single.amount, closeTo(1 + 4e-9, 1e-18));
  });

  test('shewall.json password seal restores address and txs', () async {
    final id = createIdentity();
    final ledger = ShearLedger();
    ledger.creditHash(id.address, hashes: 2);
    ledger.confirmRound(address: id.address, pot: 1, height: 1);
    const pw = 'correct-horse';
    final dump = exportShewall(identity: id, ledger: ledger);
    final env = await ShearLock.seal(dump, pw);
    expect(env['kind'], ShearLock.kind);
    expect(env.containsKey('ct'), isTrue);
    final opened = await ShearLock.open(env, pw);
    final ledger2 = ShearLedger();
    final id2 = importShewall(opened, ledger2);
    expect(id2.address, id.address);
    expect(id2.viewKey, id.viewKey);
    expect(ledger2.spendable(id.address), closeTo(1 + 2e-9, 1e-18));
    expect(ledger2.ownerHistory(id.address), isNotEmpty);
    await expectLater(ShearLock.open(env, 'wrong'), throwsA(anything));
  });

  testWidgets('six Chronoflux tabs and light pool colors', (tester) async {
    final dir = Directory.systemTemp.createTempSync('shear-ui-');
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    await tester.pumpWidget(ShearWalletApp(session: session, ledger: ShearLedger()));
    await tester.pump();
    expect(shearBg.value, 0xFFEEF3F8);
    expect(shearInk.value, 0xFF0D2137);
    // password gate first
    await tester.enterText(find.byType(TextField), 'pw');
    await tester.tap(find.text('Unlock'));
    await tester.pump();
    for (final name in kTabs) {
      expect(find.text(name), findsWidgets);
    }
    expect(kExplains.length, kTabs.length);
    expect(kExplains.every((e) => e.length > 20), isTrue);
  });
}
