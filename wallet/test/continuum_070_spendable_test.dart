import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_levy.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_read_sync.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_ristretto.dart';
import 'package:shear_wallet/shear_session.dart';

void main() {
  test('an opened coin is what a send can draw, and a follow does not replace it', () async {
    final dir = Directory.systemTemp.createTempSync('c070-spend-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    await session.setPassword('test-pass-1');
    final id = session.identity!;
    final ledger = ShearLedger()..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberNote({
      'address': home,
      'dest': home,
      'verified': true,
      'height': 1,
      'amount': 1.0,
      'nanos': kUnitsPerShe,
      'commit': Uint8List(32)..[0] = 4,
      'r': Uint8List(32)..[0] = 5,
    });
    ledger.rememberDest(home);
    ledger.restoreSealedTip(20);
    ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);

    final opened = ledger.spendableOwned(id.address, paymentCode: id.paymentCode);
    expect(opened, closeTo(1.0, 1e-9));
    expect(
      paintedContinuumSpendable(ledger, id.address, paymentCode: id.paymentCode),
      closeTo(opened, 1e-12),
    );

    await ledger.followOffUi(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      full: false,
      chain: false,
      sessionPath: session.store.path,
      sessionPassword: session.password,
    );
    expect(
      ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(opened, 1e-9),
    );

    ledger.rememberNodeChain(notes: [
      {
        'dest': home,
        'kind': 'coinbase',
        'height': 2,
        'valueProof': {'v': 5 * kUnitsPerShe},
      },
    ]);
    ledger.creditKnownNodeLands();
    ledger.applyPoolSnapshot(
      home,
      {'balance': 9.0, 'pending': 1.0, 'owedPi': 3.0},
      beforeHeight: 20,
      tipSealed: 20,
    );
    final shown = ledger.spendableOwned(id.address, paymentCode: id.paymentCode);
    expect(shown, closeTo(opened, 1e-9));
    expect(
      paintedContinuumSpendable(ledger, id.address, paymentCode: id.paymentCode),
      closeTo(shown, 1e-12),
    );
    expect(ledger.owedTowardPi(id.address, paymentCode: id.paymentCode), isNot(shown));

    final cover = planLockFunding(
      ledger,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      needShe: 0.4,
    );
    expect(cover.have, closeTo(shown, 1e-9));
    final dest = vaultDest(id.address, viewKey: id.viewKey)!;
    final posted = await postReserveDeposit(
      ledger: ledger,
      reserve: ShearReserve(),
      restFrame: id.address,
      paymentCode: id.paymentCode,
      dest: dest,
      she: 0.4,
      depth: 0,
      spendSeed: hexToBytes(id.seedHex),
      local: true,
    );
    expect(posted.posted, isTrue);
    expect(
      ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      lessThan(shown),
    );
    expect(
      paintedContinuumSpendable(ledger, id.address, paymentCode: id.paymentCode),
      closeTo(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 1e-12),
    );
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('login reads node notes before height and a pool figure does not raise spendable', () async {
    final paths = <String>[];
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      paths.add(req.uri.path);
      req.response.headers.contentType = ContentType.json;
      final path = req.uri.path;
      if (path == '/notes' || path == '/api/wallet/notes') {
        req.response.write(jsonEncode({
          'ok': true,
          'notes': [
            {
              'dest': req.uri.queryParameters['address'] ?? '',
              'kind': 'coinbase',
              'height': 1,
              'valueProof': {'v': 5 * kUnitsPerShe},
            },
          ],
        }));
      } else if (path == '/api/wallet/balance' || path == '/balance') {
        req.response.write(jsonEncode({
          'ok': true,
          'balance': 50,
          'address': req.uri.queryParameters['address'] ?? '',
        }));
      } else if (path == '/stats' || path == '/api/stats') {
        req.response.write(jsonEncode({
          'ok': true,
          'height': 20,
          'balance': 9,
          'owedPi': 3,
        }));
      } else {
        req.response.statusCode = 500;
        req.response.write('{"ok":false}');
      }
      await req.response.close();
    });
    final dir = Directory.systemTemp.createTempSync('c070-first-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    await session.setPassword('test-pass-1');
    final id = session.identity!;
    final ledger = ShearLedger(pool: ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}'))
      ..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberNote({
      'address': home,
      'dest': home,
      'verified': true,
      'height': 1,
      'amount': 1.0,
      'nanos': kUnitsPerShe,
      'commit': Uint8List(32)..[0] = 7,
      'r': Uint8List(32)..[0] = 8,
    });
    ledger.rememberDest(home);
    ledger.restoreSealedTip(20);
    ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    final opened = ledger.spendableOwned(id.address, paymentCode: id.paymentCode);
    expect(opened, closeTo(1.0, 1e-9));

    await ledger.followOffUi(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      full: false,
      chain: true,
      spendableFirst: true,
      sessionPath: session.store.path,
      sessionPassword: session.password,
    );

    expect(debugCreditFollowKind, 'spendable');
    expect(paths, isNotEmpty);
    expect(paths.first.contains('notes'), isTrue);
    final notesAt = paths.indexWhere((p) => p.contains('notes'));
    final balanceAt = paths.indexWhere((p) => p.contains('balance'));
    final statsAt = paths.indexWhere((p) => p.contains('stats'));
    expect(notesAt, greaterThanOrEqualTo(0));
    expect(balanceAt, greaterThan(notesAt));
    expect(statsAt, greaterThan(balanceAt));
    expect(paths.any((p) => p.contains('history')), isFalse);
    expect(paths.any((p) => p.contains('/block')), isFalse);
    expect(paths.any((p) => p.contains(kPoolFeeDest)), isFalse);
    expect(
      ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(opened, 1e-9),
    );
    expect(
      paintedContinuumSpendable(ledger, id.address, paymentCode: id.paymentCode),
      closeTo(opened, 1e-12),
    );
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('login with no live base reads node notes and a dead loopback does not paint spendable', () async {
    final paths = <String>[];
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      paths.add('${req.uri.path}?${req.uri.query}');
      req.response.headers.contentType = ContentType.json;
      final path = req.uri.path;
      if (path == '/notes' || path == '/api/wallet/notes') {
        req.response.write(jsonEncode({
          'ok': true,
          'notes': [
            {
              'dest': req.uri.queryParameters['address'] ?? '',
              'kind': 'coinbase',
              'height': 1,
              'valueProof': {'v': 50 * kUnitsPerShe},
            },
          ],
        }));
      } else if (path == '/stats' || path == '/api/stats') {
        req.response.write(jsonEncode({
          'ok': true,
          'height': 387,
          'header': 'aa',
          'network': kBookMagic,
          'magic': kBookMagic,
          'balance': 12,
        }));
      } else {
        req.response.statusCode = 404;
        req.response.write('{"ok":false}');
      }
      await req.response.close();
    });
    final dir = Directory.systemTemp.createTempSync('c070-discover-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    await session.setPassword('test-pass-1');
    final id = session.identity!;
    final live = 'http://127.0.0.1:${server.port}';
    final sync = ShearReadSync(
      seeds: [live, 'http://127.0.0.1:1', 'https://pool.shear.digital'],
      jitter: Duration.zero,
    );
    final ledger = ShearLedger(pool: ShearPoolClient(sync: sync))..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberNote({
      'address': home,
      'dest': home,
      'verified': true,
      'height': 1,
      'amount': 1.0,
      'nanos': kUnitsPerShe,
      'commit': Uint8List(32)..[0] = 9,
      'r': Uint8List(32)..[0] = 4,
    });
    ledger.rememberDest(home);
    ledger.restoreSealedTip(387);
    ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(1.0, 1e-9));
    expect(sync.liveBase, isNull);

    await ledger.followOffUi(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      full: false,
      chain: true,
      spendableFirst: true,
      sessionPath: session.store.path,
      sessionPassword: session.password,
    );

    expect(debugCreditFollowKind, 'spendable');
    expect(paths.where((p) => p.contains('notes')), isNotEmpty);
    expect(paths.where((p) => p.contains('balance')), isNotEmpty);
    expect(paths.where((p) => p.contains('stats')), isNotEmpty);
    expect(paths.any((p) => p.contains('history')), isFalse);
    expect(paths.any((p) => p.contains('/block')), isFalse);
    expect(paths.any((p) => p.contains(kPoolFeeDest)), isFalse);
    expect(
      ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(1.0, 1e-9),
    );

    paths.clear();
    await ledger.syncTip(proveChain: false);
    expect(paths.where((p) => p.contains('stats')), isNotEmpty);
    expect(paths.any((p) => p.contains('/block')), isFalse);
    expect(paths.any((p) => p.contains('compact')), isFalse);
    expect(sync.liveBase, live);
    expect(ledger.sealedHeight, 387);

    final mainSrc = File('lib/main.dart').readAsStringSync();
    expect('syncTip(proveChain: false)'.allMatches(mainSrc).length, greaterThanOrEqualTo(2));
    expect(mainSrc, contains('if (!_hostAndroid && !widget.skipPoolSync)'));
    expect(mainSrc.contains('_spendableAwaiting = true'), isTrue);
    expect(
      mainSrc.indexOf('_spendableAwaiting = true'),
      lessThan(mainSrc.indexOf('spendableFirst: true')),
    );
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('a compact pool-fee note opens at the sealed 1 percent and a node balance does not', () async {
    final feeNanos = (kBlockPotShe * kUnitsPerShe).round() * kPoolFeeBps ~/ 10000;
    final paths = <String>[];
    Map<String, dynamic>? feeWire;
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      paths.add('${req.uri.path}?${req.uri.query}');
      req.response.headers.contentType = ContentType.json;
      final path = req.uri.path;
      final addr = req.uri.queryParameters['address'] ?? '';
      if (path == '/notes' || path == '/api/wallet/notes') {
        final wire = feeWire;
        req.response.write(jsonEncode({
          'ok': true,
          'notes': [
            if (wire != null) wire,
            {
              'dest': addr,
              'kind': 'pool-fee',
              'height': 1,
              'valueProof': {'v': 50 * kUnitsPerShe},
            },
          ],
        }));
      } else if (path == '/api/wallet/balance' || path == '/balance') {
        req.response.write(jsonEncode({
          'ok': true,
          'balance': 40,
          'address': addr,
        }));
      } else if (path == '/stats' || path == '/api/stats') {
        req.response.write(jsonEncode({
          'ok': true,
          'height': 20,
          'balance': 9,
          'owedPi': 3,
        }));
      } else {
        req.response.statusCode = 404;
        req.response.write('{"ok":false}');
      }
      await req.response.close();
    });
    final dir = Directory.systemTemp.createTempSync('c070-fee-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    await session.setPassword('test-pass-1');
    final id = session.identity!;
    expect(id.address.startsWith('ssa1q4ke8'), isFalse);
    expect(kPoolFeeDest.startsWith('ssa1q4ke8'), isTrue);
    final ledger = ShearLedger(pool: ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}'))
      ..bindIdentity(id);
    final seed = ledger.spendSeed;
    expect(seed, isNotNull);
    // Login asks syncDests, which is the mining mailbox when the fingerprint
    // address is not that mailbox. The fee constant is not one of them.
    final queried = ledger.syncDests(id.address, paymentCode: id.paymentCode).toList();
    expect(queried, isNotEmpty);
    final dest = queried.first;
    expect(dest.startsWith('ssa1q4ke8'), isFalse);
    // Prove the value before the request. sealNote's range proof takes minutes.
    feeWire = _poolFeeWire(dest, seed!);
    final vp = feeWire!['valueProof'] as Map;
    final openedRaw = verifySealedNote({
      'commit': hexToBytes(feeWire!['commit'] as String),
      'valueProof': {
        'R': hexToBytes(vp['R'] as String),
        'z': hexToBytes(vp['z'] as String),
        'v': feeNanos,
      },
    }, feeNanos);
    expect(
      openedRaw,
      isTrue,
      reason: 'fee=$feeNanos commit=${(feeWire!['commit'] as String).length} '
          'R=${(vp['R'] as String).length} z=${(vp['z'] as String).length}',
    );
    final fetched = await ledger.pool!.notes(dest);
    final fetchedRows = fetched['notes'];
    expect(fetchedRows, isA<List>(), reason: '$fetched');
    final fetchedFirst = (fetchedRows as List).first as Map;
    final fetchedVp = fetchedFirst['valueProof'] as Map;
    expect(fetchedFirst['commit'], feeWire!['commit']);
    expect(
      verifySealedNote({
        'commit': hexToBytes(fetchedFirst['commit'] as String),
        'valueProof': {
          'R': hexToBytes(fetchedVp['R'] as String),
          'z': hexToBytes(fetchedVp['z'] as String),
          'v': feeNanos,
        },
      }, feeNanos),
      isTrue,
    );
    await ledger.followOffUi(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      full: false,
      chain: true,
      spendableFirst: true,
      sessionPath: session.store.path,
      sessionPassword: session.password,
    );
    final opened = feeNanos / kUnitsPerShe;
    expect(
      ledger.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(opened, 1e-9),
      reason: 'sealed=${ledger.sealedHeight} ready=${ledger.spendableFigureReady(id.address, paymentCode: id.paymentCode)} '
          'err=$debugCollateError '
          'notes=${ledger.notes.map((n) => '${n['kind']}/${n['verified']}/${n['amount']}/${n['dest']}').join('|')} '
          'paths=$paths',
    );
    expect(opened, isNot(closeTo(0, 1e-9)));
    expect(
      paintedContinuumSpendable(ledger, id.address, paymentCode: id.paymentCode),
      closeTo(opened, 1e-12),
    );
    expect(ledger.spendableFigureReady(id.address, paymentCode: id.paymentCode), isTrue);
    expect(paths.any((p) => p.contains('balance')), isTrue);
    expect(paths.any((p) => p.contains(dest)), isTrue);
    expect(paths.any((p) => p.contains(kPoolFeeDest)), isFalse);
    final cover = planLockFunding(
      ledger,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      needShe: opened / 2,
    );
    expect(cover.have, closeTo(opened, 1e-9));
    expect(cover.from, dest);
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('a failed notes read is not a confident zero and a balance figure is not spendable', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      req.response.headers.contentType = ContentType.json;
      final path = req.uri.path;
      if (path == '/api/wallet/balance' || path == '/balance') {
        req.response.write(jsonEncode({'ok': true, 'balance': 40}));
      } else if (path == '/stats' || path == '/api/stats') {
        req.response.write(jsonEncode({'ok': true, 'height': 20}));
      } else {
        req.response.statusCode = 500;
        req.response.write('{"ok":false}');
      }
      await req.response.close();
    });
    final dir = Directory.systemTemp.createTempSync('c070-miss-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    await session.setPassword('test-pass-1');
    final id = session.identity!;
    final ledger = ShearLedger(pool: ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}'))
      ..bindIdentity(id);
    await ledger.followOffUi(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      full: false,
      chain: true,
      spendableFirst: true,
      sessionPath: session.store.path,
      sessionPassword: session.password,
    );
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
    expect(ledger.spendableFigureReady(id.address, paymentCode: id.paymentCode), isFalse);
    expect(
      paintedContinuumSpendable(ledger, id.address, paymentCode: id.paymentCode),
      isNot(closeTo(40, 1e-9)),
    );
  }, timeout: const Timeout(Duration(minutes: 2)));
}

String _hex(Object? v) {
  if (v is! Uint8List) return '';
  final out = StringBuffer();
  for (final b in v) {
    out.write(b.toRadixString(16).padLeft(2, '0'));
  }
  return out.toString();
}

/// Pool-fee compact: R and z stay, v is gone, r is wrapped. No range proof.
/// The logged-in pin is the note's dest, not [kPoolFeeDest].
Map<String, dynamic> _poolFeeWire(String dest, Uint8List seed) {
  final d20 = hash20FromAddress(dest)!;
  final feeNanos = (kBlockPotShe * kUnitsPerShe).round() * kPoolFeeBps ~/ 10000;
  final r = randomScalar();
  final value = proveValue(feeNanos, r);
  var note = <String, dynamic>{
    'kind': 'pool-fee',
    'noteCommit': noteCommitOfDest20(d20),
    'commit': value['C'],
    'valueProof': {'R': value['R'], 'z': value['z'], 'v': feeNanos},
    'r': scalarBytes(r),
    'dest20': d20,
  };
  note = wrapNoteBlind(note, pointFrom(admitBaseBytes(seed)));
  note = compactSealedVout(note);
  final vp = Map<String, dynamic>.from(note['valueProof'] as Map)..remove('v');
  return {
    'kind': 'pool-fee',
    'height': 1,
    'noteCommit': _hex(note['noteCommit']),
    'commit': _hex(note['commit']),
    'valueProof': {'R': _hex(vp['R']), 'z': _hex(vp['z'])},
    'rEph': _hex(note['rEph']),
    'rCt': _hex(note['rCt']),
  };
}
