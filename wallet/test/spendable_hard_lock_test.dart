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
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
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

  test('confirmations use the verified tip when the scan cursor is behind', () {
    final ledger = ShearLedger();
    ledger.noteLiveHeight(40);
    ledger.noteCovered(4);
    expect(ledger.bookTip, 40);
    expect(ledger.notesCovered, 4);
    expect(ledger.confirmationsOf(1), 40);
  });

  test('displayed Spendable matches the planner max-send sum', () {
    final rnd = Random(0x5EE);
    for (var seed = 0; seed < 8; seed++) {
      final id = createIdentity();
      final ledger = ShearLedger()..bindIdentity(id);
      final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
      ledger.noteLiveHeight(100);
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

  test('a reorg drops an opened note from Spendable', () async {
    final book = await _liveBook();
    addTearDown(() async => book.close());
    final kept = _coin(book.dest, nanos: 100000000000, height: 3, salt: 3);
    final orphan = _coin(book.dest, nanos: _savedNanos, height: 7, salt: 7);
    book.ledger.noteLiveHeight(40);
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
    expect(book.ledger.notes.any((n) => n['height'] == 7), isFalse);
    expect(book.ledger.notes.any((n) => n['height'] == 3), isTrue);
    expect(
      book.ledger.displayedSpendableNanos(
        book.id.address,
        paymentCode: book.id.paymentCode,
      ),
      BigInt.from(100000000000),
    );
    expect(
      book.ledger.plannerSelectableNanos(
        book.id.address,
        paymentCode: book.id.paymentCode,
      ),
      BigInt.from(100000000000),
    );
  }, timeout: const Timeout(Duration(minutes: 2)));

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
