import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_hash.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_levy.dart';
import 'package:shear_wallet/shear_native_prove.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_public_confirm.dart';
import 'package:shear_wallet/shear_ristretto.dart';
import 'package:shear_wallet/shear_session.dart';

/// Saved coin the old login painted before any read. 2.5 SHE, fully sealed.
const _savedNanos = 250000000000;

void main() {
  test(
    'spendableFigureReady is false until a read succeeds, failure first',
    () {
      final id = createIdentity();
      final ledger = ShearLedger()..bindIdentity(id);
      final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
      ledger.noteLiveHeight(40);
      ledger.settleTo(40);
      ledger.rememberNote(_coin(dest, nanos: _savedNanos, height: 1));
      ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
      expect(
        ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
        greaterThan(0),
      );
      expect(
        ledger.spendableFigureReady(id.address, paymentCode: id.paymentCode),
        isFalse,
      );
      ledger.noteSpendableReadFailed();
      expect(
        ledger.spendableFigureReady(id.address, paymentCode: id.paymentCode),
        isFalse,
      );
    },
  );

  test(
    'dart ShearHash-v3 matches committed vectors byte for byte',
    () {
      final cases = <String, String>{
        _v3SelfHex(): _v3SelfDigest,
        _v3PatHeader: _v3PatDigest,
        _v3GenesisHeader: _v3GenesisDigest,
        _v3ChildHeader: _v3ChildDigest,
      };
      for (final entry in cases.entries) {
        final got = shearHashV3(_hexBytes(entry.key));
        expect(got, isNotNull);
        expect(_hexOf(got!), entry.value);
      }
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );

  test(
    'a host live height is not spendable depth; only a pinned v3 chain is',
    () {
      final ledger = ShearLedger();
      ledger.noteLiveHeight(40);
      ledger.noteCovered(4);
      expect(ledger.sealedHeight, 40);
      expect(ledger.bookTip, 0);
      expect(ledger.notesCovered, 4);
      expect(ledger.confirmationsOf(1), 0);
      final genesis = _hexBytes(_v3GenesisHeader);
      final child = _hexBytes(_v3ChildHeader);
      final pin = _hexBytes(_v3GenesisDigest);
      ledger.applyTipHeader(child, sealedHeight: 2);
      expect(ledger.bookTip, 0, reason: 'no genesis pin');
      ledger.bindGenesisPin(pin, _v3GenesisMs);
      ledger.applyTipHeader(child, sealedHeight: 2);
      expect(ledger.bookTip, 0, reason: 'parent is not checked');
      ledger.applyTipHeader(genesis, sealedHeight: 1);
      expect(ledger.bookTip, 1);
      ledger.applyTipHeader(child, sealedHeight: 2);
      expect(ledger.bookTip, 2);
      expect(ledger.confirmationsOf(1), 2);
      final quote = asertQuoteForHeight(
        anchorTimeMs: _v3GenesisMs,
        blockTimeMs: _v3ChildMs,
        blockHeight: 2,
        parentTimeMs: _v3GenesisMs,
      );
      expect(quote.packed, _v3ChildBits);
      expect(quote.eased, 918332);
      expect(bitsAcceptAsert(_v3ChildBits, quote), isTrue);
      ledger.noteLiveHeight(55);
      expect(ledger.sealedHeight, 55);
      expect(ledger.bookTip, 2);

      final fake = Uint8List.fromList(genesis);
      fake[112] ^= 0xff;
      final fakeBook = ShearLedger()..bindGenesisPin(pin, _v3GenesisMs);
      fakeBook.applyTipHeader(fake, sealedHeight: 1);
      expect(fakeBook.bookTip, 0, reason: 'fake genesis');

      final broken = _linkedHeader(
        prev: pin,
        timestampMs: _v3GenesisMs + 60000,
        bits: _v3ChildBits,
      );
      broken[4] ^= 0xff;
      final brokenBook = ShearLedger()..bindGenesisPin(pin, _v3GenesisMs);
      brokenBook.applyTipHeader(genesis, sealedHeight: 1);
      brokenBook.applyTipHeader(broken, sealedHeight: 2);
      expect(brokenBook.bookTip, 1, reason: 'broken parent');

      final late = _linkedHeader(
        prev: pin,
        timestampMs: _v3GenesisMs + 26 * 60 * 60 * 1000,
        bits: 4 * 65536,
      );
      final lateBook = ShearLedger()..bindGenesisPin(pin, _v3GenesisMs);
      lateBook.applyTipHeader(genesis, sealedHeight: 1);
      lateBook.applyTipHeader(late, sealedHeight: 2);
      expect(lateBook.bookTip, 1, reason: '26h late 4-bit header');

      final ahead = _linkedHeader(
        prev: pin,
        timestampMs: _v3GenesisMs + 60000,
        bits: _v3ChildBits,
      );
      final futureBook = ShearLedger()
        ..bindGenesisPin(pin, _v3GenesisMs)
        ..bindHeaderClock(_v3GenesisMs);
      futureBook.applyTipHeader(genesis, sealedHeight: 1);
      futureBook.applyTipHeader(ahead, sealedHeight: 2);
      expect(futureBook.bookTip, 1, reason: 'future time');

      final low = Uint8List.fromList(child);
      low[108] = 1;
      low[109] = 0;
      low[110] = 0;
      low[111] = 0;
      final lowBook = ShearLedger()..bindGenesisPin(pin, _v3GenesisMs);
      lowBook.applyTipHeader(genesis, sealedHeight: 1);
      lowBook.applyTipHeader(low, sealedHeight: 2);
      expect(lowBook.bookTip, 1, reason: 'low bits');
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );

  test('desktop own-node depth comes from the node tip without settleTo', () {
    expect(
      desktopNodeTipCounts(ClosureSendMode.connectBare, ownNode: false),
      isFalse,
    );
    expect(
      desktopNodeTipCounts(ClosureSendMode.connectBare, ownNode: true),
      isTrue,
    );
    expect(
      desktopNodeTipCounts(ClosureSendMode.localNode, ownNode: false),
      isTrue,
    );
    expect(
      desktopNodeTipCounts(ClosureSendMode.localNodeFull, ownNode: false),
      isTrue,
    );
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberNote(_coin(dest, nanos: kUnitsPerShe, height: 1));
    ledger.noteLiveHeight(40);
    expect(ledger.bookTip, 0);
    expect(ledger.settledHeight, 0);
    expect(
      ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      0,
    );
    ledger.noteNodeCheckedTip(40);
    expect(ledger.bookTip, 40);
    expect(ledger.settledHeight, 0);
    final shown = ledger.spendableOwned(
      id.address,
      paymentCode: id.paymentCode,
    );
    expect(shown, greaterThan(0));
    expect(
      ledger.plannerSelectableNanos(id.address, paymentCode: id.paymentCode),
      ledger.displayedSpendableNanos(id.address, paymentCode: id.paymentCode),
    );
  });

  test('a 1.48 note under a 1 SHE stake shows 0.48 and the stake returns as change', () async {
    const noteNanos = 148000000000;
    const freeNanos = 48000000000;
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final note = _coin(home, nanos: noteNanos, height: 1, salt: 11);
    ledger.noteNodeCheckedTip(40);
    ledger.rememberNote(note);
    ledger.setReserveHeldNanos(home, kUnitsPerShe);
    expect(
      ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(0.48, 1e-9),
    );
    expect(
      ledger.displayedSpendableNanos(id.address, paymentCode: id.paymentCode),
      BigInt.from(freeNanos),
    );
    expect(
      ledger.plannerSelectableNanos(id.address, paymentCode: id.paymentCode),
      BigInt.from(freeNanos),
    );
    final bobId = createIdentity();
    final bob = (ShearLedger()..bindIdentity(bobId)).homeDest(
      bobId.address,
      paymentCode: bobId.paymentCode,
    );
    final tx = await ledger.send(
      from: home,
      to: bob,
      amount: 0.48,
      nanosWire: '$freeNanos',
      local: true,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      spendSeed: hexToBytes(id.seedHex),
      spendNote: note,
    );
    expect(tx.to, bob);
    final fee = levyNanos(freeNanos);
    final pay = BigInt.from(freeNanos) - BigInt.from(fee);
    expect(debugLastFeeNanos, BigInt.from(fee));
    expect(debugLastPayNanos, pay);
    expect(debugLastChangeNanos, BigInt.from(kUnitsPerShe));
    expect(tx.amount, closeTo(pay.toDouble() / kUnitsPerShe, 1e-12));
    final shown = await ledger.quoteConfirmRecipientShe(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      amount: 0.48,
      nanosWire: '$freeNanos',
    );
    expect(shown, formatSheFromNanos(pay.toInt()));
  });

  test(
    'a 5 plus 5 under a 3 SHE stake sends 7 minus the fee and returns the stake',
    () async {
      const note = 5 * kUnitsPerShe;
      const hold = 3 * kUnitsPerShe;
      const ask = 7 * kUnitsPerShe;
      final id = createIdentity();
      final ledger = ShearLedger()..bindIdentity(id);
      final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
      ledger.noteNodeCheckedTip(40);
      ledger.rememberNote(_coin(home, nanos: note, height: 1, salt: 21));
      ledger.rememberNote(_coin(home, nanos: note, height: 1, salt: 22));
      ledger.setReserveHeldNanos(home, hold);
      expect(
        ledger.displayedSpendableNanos(id.address, paymentCode: id.paymentCode),
        BigInt.from(ask),
      );
      final bobId = createIdentity();
      final bob = (ShearLedger()..bindIdentity(bobId)).homeDest(
        bobId.address,
        paymentCode: bobId.paymentCode,
      );
      final fee = estimateSendLevyUnits(inputs: 2, outputs: 3);
      final shown = await ledger.quoteConfirmRecipientShe(
        restFrame: id.address,
        paymentCode: id.paymentCode,
        amount: 7,
        nanosWire: '$ask',
      );
      final tx = await ledger.sendSpendableSum(
        from: home,
        to: bob,
        amount: 7,
        nanosWire: '$ask',
        local: true,
        restFrame: id.address,
        paymentCode: id.paymentCode,
        spendSeed: hexToBytes(id.seedHex),
      );
      final pay = BigInt.from(ask) - BigInt.from(fee);
      expect(debugLastFeeNanos, BigInt.from(fee));
      expect(debugLastPayNanos, pay);
      expect(debugLastChangeNanos, BigInt.from(hold));
      expect(tx.amount, closeTo(pay.toDouble() / kUnitsPerShe, 1e-12));
      expect(tx.to, bob);
      expect(shown, formatSheFromNanos(pay.toInt()));
    },
  );

  testWidgets('the flow line shows the reduced recipient amount', (tester) async {
    final oneFee = levyNanos(48000000000);
    final oneShe = formatSheFromNanos(48000000000 - oneFee);
    final manyFee = estimateSendLevyUnits(inputs: 2, outputs: 3);
    final manyShe = formatSheFromNanos(7 * kUnitsPerShe - manyFee);
    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: flowRecipientAmountLine(oneShe))),
    );
    expect(find.byKey(const Key('flow-recipient-amount')), findsOneWidget);
    expect(find.text('Recipient $oneShe SHE'), findsOneWidget);
    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: flowRecipientAmountLine(manyShe))),
    );
    expect(find.text('Recipient $manyShe SHE'), findsOneWidget);
  });

  test('displayed Spendable matches the planner max-send sum', () {
    final rnd = Random(0x5EE);
    for (var seed = 0; seed < 8; seed++) {
      final id = createIdentity();
      final ledger = ShearLedger()..bindIdentity(id);
      final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
      ledger.noteLiveHeight(100);
      ledger.settleTo(100);
      ledger.noteCovered(3);
      final eligible = _coin(
        dest,
        nanos: 100000000000 + seed,
        height: 1,
        salt: 1,
      );
      ledger.rememberNote(eligible);
      for (var i = 0; i < 24; i++) {
        ledger.rememberNote(_randomNote(rnd, dest, 10 + i + seed * 24));
      }
      ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
      final shown = ledger.displayedSpendableNanos(
        id.address,
        paymentCode: id.paymentCode,
      );
      final planned = ledger.plannerSelectableNanos(
        id.address,
        paymentCode: id.paymentCode,
      );
      expect(planned, shown, reason: 'seed=$seed');
      expect(
        shown,
        greaterThanOrEqualTo(BigInt.from(100000000000 + seed)),
        reason: 'seed=$seed',
      );
    }
  });

  test('a chain spend tag leaves Spendable before any send', () async {
    final book = await _liveBook();
    addTearDown(() async => book.close());
    final note = _coin(book.dest, nanos: _savedNanos, height: 1, salt: 7);
    final tag = _spendTagHex(book.ledger.spendSeed!, note);
    expect(tag, isNotEmpty);
    book.ledger.noteLiveHeight(40);
    book.ledger.settleTo(40);
    book.ledger.rememberNote(note);
    book.ledger.recheckRestFrameSpendable(
      book.id.address,
      paymentCode: book.id.paymentCode,
    );
    final before = book.ledger.displayedSpendableNanos(
      book.id.address,
      paymentCode: book.id.paymentCode,
    );
    expect(before, BigInt.from(_savedNanos));
    book.hold.spendTags.add(tag);
    await _remember(book);
    await book.ledger.followOffUi(
      restFrame: book.id.address,
      paymentCode: book.id.paymentCode,
      full: false,
      chain: true,
      spendableFirst: true,
      sessionPath: book.session.store.path,
      sessionPassword: book.session.password,
    );
    expect(
      book.ledger.displayedSpendableNanos(
        book.id.address,
        paymentCode: book.id.paymentCode,
      ),
      BigInt.zero,
    );
    expect(
      book.ledger.plannerSelectableNanos(
        book.id.address,
        paymentCode: book.id.paymentCode,
      ),
      BigInt.zero,
    );
    expect(book.ledger.notes.any((n) => n['spent'] == true), isTrue);
    expect(
      book.ledger.spendableOwned(
        book.id.address,
        paymentCode: book.id.paymentCode,
      ),
      0,
    );
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('a host reorg list does not wipe an opened note', () async {
    final book = await _liveBook();
    addTearDown(() async => book.close());
    final kept = _coin(book.dest, nanos: 100000000000, height: 3, salt: 3);
    final orphan = _coin(book.dest, nanos: _savedNanos, height: 7, salt: 7);
    book.ledger.noteLiveHeight(40);
    book.ledger.settleTo(40);
    book.ledger.noteCovered(4);
    final cursor = book.ledger.notesCovered;
    book.ledger.rememberNote(kept);
    book.ledger.rememberNote(orphan);
    book.ledger.recheckRestFrameSpendable(
      book.id.address,
      paymentCode: book.id.paymentCode,
    );
    expect(
      book.ledger.displayedSpendableNanos(
        book.id.address,
        paymentCode: book.id.paymentCode,
      ),
      BigInt.from(100000000000 + _savedNanos),
    );
    book.hold.stats['reorgHeights'] = [7];
    await _remember(book);
    await book.ledger.followOffUi(
      restFrame: book.id.address,
      paymentCode: book.id.paymentCode,
      full: false,
      chain: true,
      spendableFirst: true,
      sessionPath: book.session.store.path,
      sessionPassword: book.session.password,
    );
    expect(book.ledger.notes.any((n) => n['height'] == 7), isTrue);
    expect(book.ledger.notes.any((n) => n['height'] == 3), isTrue);
    expect(book.ledger.notesCovered, greaterThanOrEqualTo(cursor));
    expect(
      book.ledger.displayedSpendableNanos(
        book.id.address,
        paymentCode: book.id.paymentCode,
      ),
      BigInt.from(100000000000 + _savedNanos),
    );
    expect(
      book.ledger.plannerSelectableNanos(
        book.id.address,
        paymentCode: book.id.paymentCode,
      ),
      BigInt.from(100000000000 + _savedNanos),
    );
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('painted Spendable equals the max send', () {
    BigInt painted(ShearLedger ledger, ShearIdentity id) {
      final she = ledger.spendableOwned(
        id.address,
        paymentCode: id.paymentCode,
      );
      return BigInt.from((she * kUnitsPerShe).round());
    }

    void check(ShearLedger ledger, ShearIdentity id, BigInt want, String why) {
      final planned = ledger.plannerSelectableNanos(
        id.address,
        paymentCode: id.paymentCode,
      );
      expect(painted(ledger, id), planned, reason: why);
      expect(planned, want, reason: why);
      expect(
        paintedContinuumSpendable(
          ledger,
          id.address,
          paymentCode: id.paymentCode,
        ),
        closeTo(want.toDouble() / kUnitsPerShe, 1e-9),
        reason: why,
      );
    }

    final plain = createIdentity();
    final plainBook = ShearLedger()..bindIdentity(plain);
    final plainDest = plainBook.homeDest(
      plain.address,
      paymentCode: plain.paymentCode,
    );
    plainBook.settleTo(40);
    plainBook.confirmRound(address: plainDest, pot: 8, height: 1);
    expect(plainBook.spendable(plainDest), greaterThan(0));
    check(plainBook, plain, BigInt.zero, 'map fallback');

    final mixed = createIdentity();
    final mixedBook = ShearLedger()..bindIdentity(mixed);
    final mixedDest = mixedBook.homeDest(
      mixed.address,
      paymentCode: mixed.paymentCode,
    );
    mixedBook.settleTo(40);
    mixedBook.rememberNote(_coin(mixedDest, nanos: kUnitsPerShe, height: 1));
    mixedBook.rememberNote(
      _coin(mixedDest, nanos: 9 * kUnitsPerShe, height: 1, salt: 2)
        ..remove('noteCommit'),
    );
    mixedBook.rememberNote({
      'address': mixedDest,
      'dest': mixedDest,
      'amount': 4.0,
      'nanos': 4 * kUnitsPerShe,
      'height': 1,
    });
    mixedBook.rememberNote(
      _coin(mixedDest, nanos: 2 * kUnitsPerShe, height: 1, salt: 3)
        ..['verified'] = false,
    );
    mixedBook.rememberNote(
      _coin(mixedDest, nanos: 2 * kUnitsPerShe, height: 1, salt: 4)
        ..remove('verified'),
    );
    check(mixedBook, mixed, BigInt.from(kUnitsPerShe), 'unsealed bare unverified');

    final held = createIdentity();
    final heldBook = ShearLedger()..bindIdentity(held);
    final heldDest = heldBook.homeDest(
      held.address,
      paymentCode: held.paymentCode,
    );
    heldBook.settleTo(40);
    heldBook.rememberNote(
      _coin(heldDest, nanos: 5 * kUnitsPerShe, height: 1, salt: 5),
    );
    heldBook.rememberNote(
      _coin(heldDest, nanos: 5 * kUnitsPerShe, height: 1, salt: 6),
    );
    heldBook.setReserveHeldNanos(heldDest, 3 * kUnitsPerShe);
    check(heldBook, held, BigInt.from(7 * kUnitsPerShe), 'partial hold');
  });

  test('a send and a consolidation during follow leave the book consistent', () async {
    final id = createIdentity();
    final seed = hexToBytes(id.seedHex);
    final probe = ShearLedger()..bindIdentity(id);
    final dest = probe.homeDest(id.address, paymentCode: id.paymentCode);
    final d20 = hash20FromAddress(dest)!;
    final notes = <Map<String, dynamic>>[];
    final pubs = <Uint8List>[];
    final commits = <Uint8List>[];
    for (var i = 0; i < 2; i++) {
      var note = nativeSealNote(kUnitsPerShe, dest20: d20, kind: 'pot');
      note = attachAdmitPub(note, admitBase: pointFrom(admitBaseBytes(seed)));
      note = compactSealedVout(note);
      note['height'] = 2;
      notes.add(note);
      final x = admitScalarFromSeed(seed, note);
      pubs.add(pointBytes(admitPub(x)));
      commits.add(note['commit'] as Uint8List);
    }
    final commitHex = commits
        .map((c) => c.map((b) => b.toRadixString(16).padLeft(2, '0')).join())
        .toList();
    final pubHex = pubs
        .map((c) => c.map((b) => b.toRadixString(16).padLeft(2, '0')).join())
        .toList();
    final gate = Completer<void>();
    var heldNotes = false;
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() async {
      if (!gate.isCompleted) gate.complete();
      await server.close(force: true);
    });
    server.listen((req) async {
      try {
        final path = req.uri.path;
        if (path.contains('notes') && !heldNotes) {
          heldNotes = true;
          await gate.future;
        }
        req.response.headers.contentType = ContentType.json;
        if (path.contains('fluxset')) {
          req.response.write(
            jsonEncode({
              'ok': true,
              'pubs': pubHex,
              'commits': commitHex,
              'anchors': [
                {'height': 8, 'n': pubs.length},
              ],
              'spendTags': const <String>[],
            }),
          );
        } else if (path.contains('notes')) {
          req.response.write(
            jsonEncode({
              'ok': true,
              'notes': [
                for (final c in commitHex) {'commit': c, 'height': 2},
              ],
            }),
          );
        } else if (req.method == 'POST') {
          req.response.write(
            jsonEncode({
              'ok': true,
              'tx': {'id': 'mid-follow', 'from': dest, 'to': dest, 'amount': 0},
            }),
          );
        } else {
          req.response.write(
            jsonEncode({'ok': true, 'height': 40, 'balance': 0}),
          );
        }
        await req.response.close();
      } catch (_) {}
    });
    final pool = _MidPool(
      pubHex,
      commitHex,
      'http://127.0.0.1:${server.port}',
    );
    addTearDown(pool.close);
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    ledger.ingestSealedVouts(
      notes,
      spendSeed: seed,
      dest: dest,
      prev: Uint8List(32),
      startIndex: 0,
    );
    ledger.settleTo(40);
    ledger.setReserveHeldNanos(dest, 0);
    final holdBefore = ledger.plannerSelectableNanos(
      id.address,
      paymentCode: id.paymentCode,
    );
    expect(holdBefore, greaterThan(BigInt.zero));
    final before = <String>{
      for (final n in ledger.notes)
        if (n['commit'] != null)
          (n['commit'] as Uint8List)
              .map((b) => b.toRadixString(16).padLeft(2, '0'))
              .join(),
    };
    final cursor = ledger.notesCovered;
    final follow = ledger.followOffUi(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      full: false,
      chain: true,
      spendableFirst: true,
    );
    final deadline = DateTime.now().add(const Duration(seconds: 20));
    while (!heldNotes && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    expect(heldNotes, isTrue);
    final bobId = createIdentity();
    final bob = (ShearLedger()..bindIdentity(bobId)).homeDest(
      bobId.address,
      paymentCode: bobId.paymentCode,
    );
    await ledger.send(
      from: dest,
      to: bob,
      amount: 0.2,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      spendSeed: seed,
      allowPublicHttp: true,
    );
    final rounds = await ledger.consolidateSpendableNotes(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      spendSeed: seed,
      allowPublicHttp: true,
      publicNode: false,
    );
    expect(rounds, greaterThanOrEqualTo(0));
    final during = <String>{
      for (final n in ledger.notes)
        if (n['commit'] is Uint8List)
          (n['commit'] as Uint8List)
              .map((b) => b.toRadixString(16).padLeft(2, '0'))
              .join(),
    };
    expect(during.length, greaterThan(before.length));
    final spentBySend = <String>{
      for (final n in ledger.notes)
        if (n['spent'] == true) _commitHex(n),
    }..remove('');
    expect(spentBySend, isNotEmpty);
    if (!gate.isCompleted) gate.complete();
    await follow.timeout(const Duration(seconds: 40));
    final after = <String>[
      for (final n in ledger.notes)
        if (n['commit'] is Uint8List)
          (n['commit'] as Uint8List)
              .map((b) => b.toRadixString(16).padLeft(2, '0'))
              .join(),
    ];
    expect(after.toSet().length, after.length);
    for (final born in during.difference(before)) {
      expect(after.contains(born), isTrue, reason: born);
    }
    for (final spent in spentBySend) {
      final still = [
        for (final n in ledger.notes)
          if (_commitHex(n) == spent) n,
      ];
      expect(still, isNotEmpty, reason: spent);
      expect(still.every((n) => n['spent'] == true), isTrue, reason: spent);
    }
    expect(ledger.notesCovered, greaterThanOrEqualTo(cursor));
    final owned = BigInt.from(
      (ledger.spendableOwned(id.address, paymentCode: id.paymentCode) *
              kUnitsPerShe)
          .round(),
    );
    expect(
      owned,
      ledger.plannerSelectableNanos(id.address, paymentCode: id.paymentCode),
    );
  }, timeout: const Timeout(Duration(minutes: 3)));

  for (final mode in const ['connect-bare', 'own-node', 'p2p', 'solo']) {
    testWidgets('restored $mode book shows Syncing before the first read', (
      tester,
    ) async {
      await _restoredHidesUntilRead(tester, mode);
    }, timeout: const Timeout(Duration(minutes: 2)));
  }

  testWidgets('a failed read hides the figure that a previous read showed', (
    tester,
  ) async {
    _wide(tester);
    final book = (await tester.runAsync(_liveBook))!;
    addTearDown(() async => book.close());
    book.ledger.noteLiveHeight(40);
    book.ledger.settleTo(40);
    book.ledger.rememberNote(
      _coin(book.dest, nanos: _savedNanos, height: 1, salt: 4),
    );
    book.ledger.recheckRestFrameSpendable(
      book.id.address,
      paymentCode: book.id.paymentCode,
    );
    book.session
      ..publicNodeConsent = true
      ..publicNodeChoiceMade = true
      ..closureSendMode = kClosureModeBare;
    await tester.runAsync(() => _remember(book));
    final state = await _lockScreen(tester, book);
    await tester.runAsync(
      () => state.unlockNow().timeout(const Duration(seconds: 40)),
    );
    await tester.pump();
    final painted = tester
        .widget<Text>(find.byKey(const Key('continuum-spendable')))
        .data;
    final shown = book.ledger.spendableOwned(
      book.id.address,
      paymentCode: book.id.paymentCode,
    );
    expect(shown, greaterThan(0));
    expect(painted, '${formatShe(shown)} SHE');
    expect(painted, isNot(kSpendableSyncing));
    book.hold.failNotes = true;
    await tester.runAsync(
      () => book.ledger.followOffUi(
        restFrame: book.id.address,
        paymentCode: book.id.paymentCode,
        full: false,
        chain: true,
        spendableFirst: true,
        sessionPath: book.session.store.path,
        sessionPassword: book.session.password,
      ),
    );
    tester.element(find.byType(ShearWalletApp)).markNeedsBuild();
    await tester.pump();
    final hidden = tester
        .widget<Text>(find.byKey(const Key('continuum-spendable')))
        .data;
    expect(hidden, kSpendableSyncing);
    expect(hidden, isNot('${formatShe(shown)} SHE'));
    expect(
      book.ledger.spendableOwned(
        book.id.address,
        paymentCode: book.id.paymentCode,
      ),
      shown,
    );
    expect(
      book.ledger.spendableFigureReady(
        book.id.address,
        paymentCode: book.id.paymentCode,
      ),
      isFalse,
    );
    await _dropShell(tester, book.ledger);
  }, timeout: const Timeout(Duration(minutes: 2)));

  testWidgets('connect bare without consent says not syncing', (tester) async {
    await _blocked(tester, own: false);
  }, timeout: const Timeout(Duration(minutes: 2)));

  testWidgets('an unresolved own node says not syncing', (tester) async {
    await _blocked(tester, own: true);
  }, timeout: const Timeout(Duration(minutes: 2)));
}

class _MidPool extends ShearPoolClient {
  _MidPool(this.pubHex, this.commitHex, String baseUrl)
    : super(
        baseUrl: baseUrl,
        http: HttpClient()..idleTimeout = const Duration(milliseconds: 50),
      );
  final List<String> pubHex;
  final List<String> commitHex;

  @override
  Future<Map<String, dynamic>> fluxset() async => {
    'ok': true,
    'pubs': pubHex,
    'commits': commitHex,
    'anchors': [
      {'height': 8, 'n': pubHex.length},
    ],
    'spendTags': const <String>[],
  };

  @override
  Future<Map<String, dynamic>> mempoolPressure() async => {'depth': 0};

  @override
  Future<Map<String, dynamic>> send({
    required String from,
    required String to,
    required double amount,
    Map<String, dynamic>? memoCt,
    String? open,
    String? sig,
    String? portalOpen,
    String? kind,
    String? programId,
    String? choice,
    int? currentEpoch,
    int? epochStartMs,
    String? change,
    String? spendPub,
    String? ephPub,
    List<dynamic>? vin,
    List<dynamic>? vout,
    dynamic excess,
    Map<String, dynamic>? admitProof,
    List<Map<String, dynamic>>? admitProofs,
    String? spendTag,
    int? fee,
    int paintedOwedNanos = 0,
    bool legacyPoolSend = false,
    bool publicConsent = false,
    String? nanosWire,
    String? id,
    String? withdrawNonce,
    String? fs1,
    int? anchor,
  }) async => {
    'ok': true,
    'tx': {
      'id': 'mid-follow',
      'from': from,
      'to': to,
      'amount': amount,
      'kind': kind ?? 'send',
    },
  };
}

const _v3GenesisMs = 1600000000000;
const _v3ChildMs = 1600007199000;
const _v3ChildBits = 1049404;
const _v3SelfDigest =
    '98818c31d739ef821db0242f76bd244b96f1fb5049d27ea9a192e95c67b39a8b';
const _v3PatDigest =
    '14e89ca711850acd9389ba431fd2f9f44472aa479047e67586200b0afde68095';
const _v3GenesisDigest =
    '0000062e313064a7eb815f40f8d0c5ead15fd47d4ac293aaac7e09c9ea8fa4b7';
const _v3ChildDigest =
    '0000adea31617eaea4daef36f7e59c6c3f930aa1df1a7dccbd2e7c2cf4aaac31';
const _v3PatHeader =
    '0100000000000000000000000000000000000000000000000000000000000000000000000202020202020202020202020202020202020202020202020202020202020202ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0068e5cf8b0100000000200007000000000000000100000000000000';
const _v3GenesisHeader =
    '0100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000806e87740100000000110075fd0300000000000000000000000000';
const _v3ChildHeader =
    '010000000000062e313064a7eb815f40f8d0c5ead15fd47d4ac293aaac7e09c9ea8fa4b7000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001859dc87740100003c03100047e60000000000000000000000000000';

String _v3SelfHex() => '${'01'}${'00' * 127}';

Uint8List _hexBytes(String hex) {
  final out = Uint8List(hex.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

String _hexOf(Uint8List bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

Uint8List _linkedHeader({
  required Uint8List prev,
  required int timestampMs,
  required int bits,
}) {
  final h = Uint8List(128);
  h[0] = 1;
  h.setRange(4, 36, prev);
  var ts = timestampMs;
  for (var i = 0; i < 8; i++) {
    h[100 + i] = ts & 0xff;
    ts >>= 8;
  }
  var b = bits;
  for (var i = 0; i < 4; i++) {
    h[108 + i] = b & 0xff;
    b >>= 8;
  }
  return h;
}

String _commitHex(Map<dynamic, dynamic> note) {
  final c = note['commit'];
  if (c is! Uint8List || c.isEmpty) return '';
  return c.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

Map<String, dynamic> _coin(
  String dest, {
  required int nanos,
  required int height,
  int salt = 1,
}) {
  return {
    'address': dest,
    'dest': dest,
    'kind': 'pot',
    'commit': Uint8List.fromList(List<int>.filled(32, salt)),
    'noteCommit': Uint8List.fromList(List<int>.filled(32, salt + 1)),
    'r': Uint8List.fromList(List<int>.filled(32, salt + 2)),
    'nanos': nanos,
    'amount': nanos / kUnitsPerShe,
    'height': height,
    'verified': true,
    'spent': false,
  };
}

Map<String, dynamic> _randomNote(Random rnd, String dest, int i) {
  final note = _coin(
    dest,
    nanos: 1000000000 * (1 + rnd.nextInt(9)),
    height: rnd.nextBool() ? 1 : 95,
    salt: 20 + i,
  );
  if (rnd.nextInt(5) == 0) note['spent'] = true;
  if (rnd.nextInt(6) == 0) note['reorged'] = true;
  if (rnd.nextInt(5) == 0) note['locked'] = true;
  if (rnd.nextInt(4) == 0) note['verified'] = false;
  if (rnd.nextInt(7) == 0) {
    note['kind'] = 'lock';
    note['unlockAtMs'] = rnd.nextBool() ? 0 : 1;
  }
  if (rnd.nextInt(5) == 0) note['nanos'] = 0;
  if (rnd.nextInt(5) == 0) note.remove('r');
  return note;
}

String _spendTagHex(Uint8List seed, Map<String, dynamic> note) {
  final x = admitScalarFromSeed(seed, {
    'kind': note['kind'],
    'commit': note['commit'],
    'noteCommit': note['noteCommit'],
  });
  final raw = pointBytes(spendTagPoint(x, admitPub(x)));
  return raw.map((e) => e.toRadixString(16).padLeft(2, '0')).join();
}

class _Hold {
  HttpRequest? notes;
  bool failNotes = false;
  bool hold = false;
  final List<String> spendTags = [];
  final Map<String, dynamic> stats = {'ok': true, 'height': 40};
  final Completer<void> gate = Completer<void>();
}

class _Book {
  _Book(this.server, this.hold, this.ledger, this.session, this.id, this.dest);
  final HttpServer server;
  final _Hold hold;
  final ShearLedger ledger;
  final ShearSession session;
  final ShearIdentity id;
  final String dest;

  Future<void> close() async {
    if (!hold.gate.isCompleted) hold.gate.complete();
    ledger.pool?.close();
    await server.close(force: true);
  }
}

Future<_Book> _liveBook() async {
  final hold = _Hold();
  final server = await _bind(hold);
  final dir = Directory.systemTemp.createTempSync('shear-spendable-lock-');
  addTearDown(() {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
  });
  final session = ShearSession(store: File('${dir.path}/session.json'));
  await session.loadOrCreate();
  await session.setPassword('test-pass-1');
  final id = session.identity!;
  final http = HttpClient()..idleTimeout = const Duration(milliseconds: 50);
  final pool = ShearPoolClient(
    baseUrl: 'http://127.0.0.1:${server.port}',
    http: http,
  );
  final ledger = ShearLedger(pool: pool)..bindIdentity(id);
  final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
  return _Book(server, hold, ledger, session, id, dest);
}

Future<void> _remember(_Book book) async {
  book.session.rememberedNotes = book.ledger.exportNotesForSession();
  book.session.rememberedNotesCovered = 40;
  book.session.rememberedSealedHeight = 40;
  book.session.rememberedDests = [book.dest];
  await book.session.persist();
}

Future<HttpServer> _bind(_Hold hold) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  var held = false;
  server.listen((req) async {
    try {
      final path = req.uri.path;
      if (path.contains('notes')) {
        if (hold.hold && !held) {
          held = true;
          hold.notes = req;
          await hold.gate.future;
        }
        if (hold.failNotes) {
          req.response.statusCode = 500;
          req.response.write('{"ok":false}');
          await req.response.close();
          return;
        }
        req.response.headers.contentType = ContentType.json;
        req.response.write(jsonEncode({'ok': true, 'notes': const <Object>[]}));
        await req.response.close();
        return;
      }
      req.response.headers.contentType = ContentType.json;
      if (path.contains('fluxset')) {
        req.response.write(
          jsonEncode({'ok': true, 'spendTags': hold.spendTags}),
        );
      } else if (path.contains('stats')) {
        req.response.write(jsonEncode(hold.stats));
      } else {
        req.response.write('{"ok":true,"balance":0,"height":40}');
      }
      await req.response.close();
    } catch (_) {}
  });
  return server;
}

void _wide(WidgetTester tester) {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Future<void> _restoredHidesUntilRead(WidgetTester tester, String mode) async {
  _wide(tester);
  final book = (await tester.runAsync(_liveBook))!;
  addTearDown(() async => book.close());
  book.hold.hold = true;
  book.ledger.noteLiveHeight(40);
  book.ledger.settleTo(40);
  book.ledger.rememberNote(
    _coin(book.dest, nanos: _savedNanos, height: 1, salt: 9),
  );
  book.ledger.recheckRestFrameSpendable(
    book.id.address,
    paymentCode: book.id.paymentCode,
  );
  final saved = book.ledger.spendableOwned(
    book.id.address,
    paymentCode: book.id.paymentCode,
  );
  expect(saved, greaterThan(0));
  book.session.publicNodeChoiceMade = true;
  if (mode == 'connect-bare') {
    book.session
      ..publicNodeConsent = true
      ..closureSendMode = kClosureModeBare;
  } else if (mode == 'own-node') {
    book.session
      ..publicNodeConsent = false
      ..closureSendMode = kClosureModeBare
      ..ownNodeUrl = 'http://127.0.0.1:${book.server.port}';
  } else if (mode == 'p2p') {
    book.session
      ..publicNodeConsent = false
      ..closureSendMode = kClosureModeLocal;
  } else {
    book.session
      ..publicNodeConsent = false
      ..closureSendMode = kClosureModeFull;
  }
  await tester.runAsync(() => _remember(book));
  final state = await _lockScreen(tester, book);
  await tester.runAsync(() async {
    final unlock = state.unlockNow();
    final deadline = DateTime.now().add(const Duration(seconds: 30));
    while (book.hold.notes == null && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    expect(book.hold.notes, isNotNull, reason: mode);
    _draw(tester);
    final during = tester
        .widget<Text>(find.byKey(const Key('continuum-spendable')))
        .data;
    expect(during, kSpendableSyncing, reason: '$mode $during');
    expect(during, isNot('${formatShe(saved)} SHE'), reason: mode);
    expect(during, isNot('0 SHE'), reason: mode);
    expect(find.text('Spendable'), findsWidgets);
    if (!book.hold.gate.isCompleted) book.hold.gate.complete();
    await unlock.timeout(const Duration(seconds: 40));
  });
  await tester.pump();
  await _dropShell(tester, book.ledger);
}

Future<void> _blocked(WidgetTester tester, {required bool own}) async {
  _wide(tester);
  final previous = ownNodeLookup;
  ownNodeLookup = (host) async {
    if (host == 'missing.local') throw const SocketException('dns');
    return InternetAddress.lookup(host);
  };
  addTearDown(() => ownNodeLookup = previous);
  final book = (await tester.runAsync(_liveBook))!;
  addTearDown(() async => book.close());
  book.ledger.noteLiveHeight(40);
  book.ledger.settleTo(40);
  book.ledger.rememberNote(
    _coin(book.dest, nanos: _savedNanos, height: 1, salt: 11),
  );
  book.ledger.recheckRestFrameSpendable(
    book.id.address,
    paymentCode: book.id.paymentCode,
  );
  final saved = book.ledger.spendableOwned(
    book.id.address,
    paymentCode: book.id.paymentCode,
  );
  expect(saved, greaterThan(0));
  book.session
    ..publicNodeConsent = false
    ..publicNodeChoiceMade = true
    ..closureSendMode = kClosureModeBare;
  if (own) book.session.ownNodeUrl = 'http://missing.local:18332';
  await tester.runAsync(() => _remember(book));
  final state = await _lockScreen(tester, book);
  await tester.runAsync(
    () => state.unlockNow().timeout(const Duration(seconds: 40)),
  );
  await tester.pump();
  final text = tester
      .widget<Text>(find.byKey(const Key('continuum-spendable')))
      .data;
  expect(text, kSpendableNotSyncing, reason: _screen(tester));
  expect(text, isNot(kSpendableSyncing));
  expect(text, isNot('${formatShe(saved)} SHE'));
  expect(find.text('Spendable'), findsWidgets);
  await _dropShell(tester, book.ledger);
}

Future<ShearWalletAppState> _lockScreen(WidgetTester tester, _Book book) async {
  await tester.pumpWidget(
    ShearWalletApp(
      session: book.session,
      ledger: book.ledger,
      skipPoolSync: false,
    ),
  );
  await tester.pump();
  await tester.enterText(find.byType(TextField).first, 'test-pass-1');
  return tester.state<ShearWalletAppState>(find.byType(ShearWalletApp));
}

void _draw(WidgetTester tester) {
  final binding = tester.binding;
  binding.scheduleFrame();
  if (!binding.hasScheduledFrame) return;
  binding.handleBeginFrame(Duration.zero);
  binding.handleDrawFrame();
}

String _screen(WidgetTester tester) =>
    tester.widgetList<Text>(find.byType(Text)).map((w) => w.data).join(' | ');

Future<void> _dropShell(WidgetTester tester, ShearLedger ledger) async {
  ledger.pool?.close();
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 1)));
  await tester.pump(const Duration(seconds: 12));
}
