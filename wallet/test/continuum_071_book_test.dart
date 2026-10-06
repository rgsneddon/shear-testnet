import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_ristretto.dart';

/// Each wallet shows its own opened coins. A pool-fee row stays on the wallet
/// that received it until the confirmation floor, and does not appear on another.
void main() {
  test('a header ahead of the notes host does not count as caught up', () {
    expect(notesHostStamp(sealed: 40, hostHeight: 39), 39);
    expect(notesHostStamp(sealed: 40, hostHeight: 40), 40);
    expect(notesHostStamp(sealed: 40, hostHeight: 0), 0);
    final main = File('lib/main.dart').readAsStringSync();
    final fly = main.indexOf('Future<void> _runFlyclientSample');
    final bar = main.indexOf('PreferredSizeWidget _topBar');
    expect(fly, greaterThan(0));
    expect(bar, greaterThan(fly));
    final body = main.substring(fly, bar);
    expect(body.contains('noteLiveHeight'), isTrue);
    expect(body.contains('_kickNotesForTip'), isTrue);
  });

  test('a header above the covered notes does not mature the next fee', () {
    final ledger = ShearLedger();
    ledger.noteLiveHeight(9);
    ledger.noteCovered(9);
    expect(ledger.bookTip, 9);
    expect(ledger.confirmationsOf(1), 9);
    expect(ledger.confirmationsOf(2), 8);
    ledger.noteLiveHeight(11);
    expect(ledger.sealedHeight, 11);
    expect(ledger.bookTip, 9);
    expect(ledger.confirmationsOf(1), 9);
    expect(ledger.confirmationsOf(2), 8);
    ledger.noteCovered(11);
    expect(ledger.bookTip, 11);
    expect(ledger.confirmationsOf(3), 9);
    expect(ledger.confirmationsOf(4), 8);
  });

  test('pool stats fill the continuity box and do not move the tip', () async {
    final ledger = ShearLedger()..noteLiveHeight(4);
    ledger.applyContinuityStats({
      'height': 63,
      'hashrate': 6224.7,
      'circulatingNanos': 63 * kUnitsPerShe,
      'potEmittedNanos': 63 * kUnitsPerShe,
      'hashBonusEmittedNanos': 0,
      'bits': 19.0816,
      'blockBits': 1250529,
      'networkAvgBlockTimeMs': 112129.3,
      'avgBlockTimeMs': 92883,
    });
    expect(ledger.sealedHeight, 4);
    expect(ledger.networkHashrate, 6225);
    expect(ledger.circulatingNanos, 63 * kUnitsPerShe);
    expect(ledger.emittedAtHeight, 63);
    expect(ledger.networkWorkBits, closeTo(19.0816, 1e-6));
    expect(resistanceBitsLabel(ledger.networkWorkBits), '19.0816');
    expect(ledger.sealedMeanBlockMs, 112129);
    expect(observedIntervalLabel(ledger.sealedMeanBlockMs), '112.1 s');
    expect(
      avgBlockRewardLabel(
        potEmittedNanos: ledger.potEmittedNanos,
        hashBonusEmittedNanos: ledger.hashBonusEmittedNanos,
        height: ledger.emittedAtHeight ?? 0,
      ),
      '1 SHE',
    );
    expect(observedIntervalLabel(null), '');
    expect(resistanceBitsLabel(1250529), '');
    final meanOnly = sealedMeanBlockMsFromStats({'avgBlockTimeMs': 90000});
    expect(meanOnly, 90000);
    final preferSealed = sealedMeanBlockMsFromStats({
      'networkAvgBlockTimeMs': 112000,
      'avgBlockTimeMs': 90000,
    });
    expect(preferSealed, 112000);
    final mainSrc = File('lib/main.dart').readAsStringSync();
    final tick = mainSrc.indexOf('void _startAccrualTick');
    final paint = mainSrc.indexOf('unawaited(_paintContinuity())', tick);
    final tipWait = mainSrc.indexOf('timeout(const Duration(seconds: 4))', tick);
    expect(tick, greaterThan(0));
    expect(paint, greaterThan(tick));
    expect(tipWait, greaterThan(paint));
    final ledgerSrc = File('lib/shear_ledger.dart').readAsStringSync();
    final syncAt = ledgerSrc.indexOf('Future<void> syncTip');
    final spendAt = ledgerSrc.indexOf('Future<double> syncSpendable');
    expect(syncAt, greaterThan(0));
    expect(spendAt, greaterThan(syncAt));
    final syncBody = ledgerSrc.substring(syncAt, spendAt);
    expect(syncBody.contains('readContinuityFigures'), isFalse);
    expect(syncBody.contains('applyContinuityStats'), isFalse);
    final loop = ShearLedger(pool: ShearPoolClient(baseUrl: 'http://127.0.0.1:9'));
    expect(await loop.readContinuityFigures(), isFalse);
    expect(loop.sealedHeight, 0);
  });

  test('fee note open stays on the credit worker and does not nest another isolate', () {
    final src = File('lib/shear_ledger.dart').readAsStringSync();
    final start = src.indexOf('Future<void> _scanNotesProgressive');
    final end = src.indexOf('Future<bool> collateSpendNotes');
    expect(start, greaterThan(0));
    expect(end, greaterThan(start));
    final body = src.substring(start, end);
    expect(body.contains('Isolate.run'), isFalse);
    expect(body.contains('notesNotYetAccepted'), isTrue);
    expect(src.contains('Isolate.run(() => scanSealedWire'), isTrue);
    final mainSrc = File('lib/main.dart').readAsStringSync();
    final phone = mainSrc.indexOf('bool get _hostAndroid');
    expect(phone, greaterThan(0));
    expect(mainSrc.substring(phone, phone + 240), contains('Platform.isIOS'));
  });

  test('pool-fee rows stay until 9 confirmations and do not credit another wallet', () {
    final feeId = createIdentity();
    final otherId = createIdentity();
    final fee = ShearLedger()..bindIdentity(feeId);
    final other = ShearLedger()..bindIdentity(otherId);
    final feeDest = fee.homeDest(feeId.address, paymentCode: feeId.paymentCode);
    final otherDest = other.homeDest(otherId.address, paymentCode: otherId.paymentCode);
    fee.rememberDest(feeDest);
    other.rememberDest(otherDest);

    fee.mergeChainTx(ShearTx(
      id: 'fee:13:$feeDest',
      from: 'coinbase',
      to: feeDest,
      amount: 0.01,
      kind: 'pool-fee',
      height: 13,
      confirmed: false,
    ));
    fee.mergeChainTx(ShearTx(
      id: 'fee:14:$feeDest',
      from: 'coinbase',
      to: feeDest,
      amount: 0.01,
      kind: 'pool-fee',
      height: 14,
      confirmed: false,
    ));
    other.mergeChainTx(ShearTx(
      id: 'recv:14:$otherDest',
      from: 'pending',
      to: otherDest,
      amount: 1.0,
      kind: 'receive',
      height: 14,
      confirmed: false,
    ));

    fee.settleTo(20);
    other.settleTo(20);

    final feePending = fee.pendingTxs(feeId.address);
    final feeHeights = feePending.where((t) => t.kind == 'pool-fee').map((t) => t.height).toSet();
    expect(feeHeights, {13, 14});
    expect(feePending.where((t) => t.amount == 0.01).length, 2);
    expect(other.pendingTxs(otherId.address).any((t) => t.amount == 0.01), isFalse);
    expect(other.pendingTxs(otherId.address).any((t) => t.to == otherDest && t.amount == 1.0), isTrue);
    expect(fee.pendingTxs(feeId.address).any((t) => t.to == otherDest), isFalse);

    fee.settleTo(21);
    final after = fee.pendingTxs(feeId.address).where((t) => t.kind == 'pool-fee').map((t) => t.height).toSet();
    expect(after.contains(13), isFalse);
    expect(after.contains(14), isTrue);
  });

  test('fee pending keeps pool-fee once and another wallet is not doubled', () {
    final feeId = createIdentity();
    final userId = createIdentity();
    final fee = ShearLedger()..bindIdentity(feeId);
    final user = ShearLedger()..bindIdentity(userId);
    final feeDest = fee.homeDest(feeId.address, paymentCode: feeId.paymentCode);
    final userDest = user.homeDest(userId.address, paymentCode: userId.paymentCode);
    fee.rememberDest(feeDest);
    user.rememberDest(userDest);

    fee.mergeChainTx(ShearTx(
      id: 'blockfound:18:$feeDest',
      from: 'coinbase',
      to: feeDest,
      amount: 0.01,
      kind: 'coinbase',
      height: 18,
      confirmed: false,
    ));
    fee.rememberNote({
      'dest': feeDest,
      'address': feeDest,
      'kind': 'pool-fee',
      'amount': 0.01,
      'height': 18,
      'verified': true,
    });
    fee.settleTo(20);

    final feePending = fee.pendingTxs(feeId.address).where((t) => t.height == 18).toList();
    expect(feePending.where((t) => t.kind == 'pool-fee'), hasLength(1));
    expect(feePending.where((t) => t.kind == 'blockfound' || t.kind == 'coinbase'), isEmpty);
    expect(feePending.fold<double>(0, (n, t) => n + t.amount), closeTo(0.01, 1e-12));
    final feeView = fee.shearviewTxs(feeId.address).where((t) => t.height == 18).toList();
    expect(feeView.where((t) => t.kind == 'pool-fee'), hasLength(1));
    expect(feeView.where((t) => t.kind == 'blockfound' || t.kind == 'coinbase'), isEmpty);

    user.mergeChainTx(ShearTx(
      id: 'recv:18:$userDest',
      from: 'ssa1payer',
      to: userDest,
      amount: 1.5,
      kind: 'receive',
      height: 18,
      confirmed: false,
    ));
    user.mergeChainTx(ShearTx(
      id: 'recv-echo:18:$userDest',
      from: 'ssa1payer',
      to: userDest,
      amount: 1.5,
      kind: 'receive',
      height: 18,
      confirmed: false,
    ));
    user.mergeChainTx(ShearTx(
      id: 'cb-a:18:$userDest',
      from: 'coinbase',
      to: userDest,
      amount: 0.99,
      kind: 'coinbase',
      height: 18,
      confirmed: false,
    ));
    user.mergeChainTx(ShearTx(
      id: 'cb-b:18:$userDest',
      from: 'coinbase',
      to: userDest,
      amount: 0.99,
      kind: 'coinbase',
      height: 18,
      confirmed: false,
    ));
    user.mergeChainTx(ShearTx(
      id: 'hash:18:$userDest',
      from: 'hash',
      to: userDest,
      amount: kHashBonusShe,
      kind: 'hash',
      height: 18,
      confirmed: false,
    ));
    user.settleTo(20);

    final userPending = user.pendingTxs(userId.address).where((t) => t.height == 18).toList();
    final receives = userPending.where((t) => t.kind == 'receive').toList();
    expect(receives, hasLength(1));
    expect(receives.single.amount, closeTo(1.5, 1e-12));
    final blocks = userPending.where((t) => t.kind == 'blockfound').toList();
    expect(blocks, hasLength(1));
    expect(blocks.single.amount, closeTo(0.99 + kHashBonusShe, 1e-12));
    expect(user.pendingTxs(userId.address).any((t) => t.kind == 'hash'), isFalse);
    expect(user.pendingTxs(userId.address).any((t) => t.to == feeDest), isFalse);
  });

  test('a cached opening is this proof only and does not open a swapped proof', () {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final d20 = hash20FromAddress(dest)!;
    final commit = Uint8List.fromList(List<int>.filled(32, 4));
    final r = Uint8List.fromList(List<int>.filled(32, 5));
    final z = Uint8List.fromList(List<int>.filled(32, 6));
    final swappedZ = Uint8List.fromList(List<int>.filled(32, 9));
    final blind = Uint8List.fromList(List<int>.filled(32, 7));
    String hex(Uint8List b) => b.map((e) => e.toRadixString(16).padLeft(2, '0')).join();
    final key = '${hex(commit)}|${hex(r)}|${hex(z)}';
    // The scan uses the identity spend seed. Admit is absent, so the cached
    // nanos are the only way this fake proof opens.
    final spend = ledger.spendSeed!;

    Map<String, dynamic> scan(Uint8List proofZ) => scanSealedVouts({
          'vouts': [
            {
              'dest': dest,
              'kind': 'receive',
              'noteCommit': noteCommitOfDest20(d20),
              'commit': commit,
              'r': blind,
              'valueProof': {'R': r, 'z': proofZ, 'v': 1},
              'height': 1,
            },
          ],
          'dests': [dest],
          'dest': dest,
          'spendSeed': spend,
          'openedProofs': [
            {'k': key, 'n': 2500000000},
          ],
        });

    final hit = (scan(z)['notes'] as List).cast<Map>();
    expect(hit, isNotEmpty);
    expect(hit.first['verified'], isTrue);
    expect(hit.first['verifiedNanos'], 2500000000);
    expect(hit.first['amount'], closeTo(2500000000 / kUnitsPerShe, 1e-12));

    final miss = (scan(swappedZ)['notes'] as List).cast<Map>();
    expect(miss.where((n) => n['verified'] == true), isEmpty);

    // A second wallet with no cache does not open this proof, and it does not
    // receive the fee. Kind receive fails the claimed v once and stops.
    final other = createIdentity();
    final otherLedger = ShearLedger()..bindIdentity(other);
    final otherDest = otherLedger.homeDest(other.address, paymentCode: other.paymentCode);
    final otherScan = scanSealedVouts({
      'vouts': [
        {
          'dest': otherDest,
          'kind': 'receive',
          'noteCommit': noteCommitOfDest20(hash20FromAddress(otherDest)!),
          'commit': commit,
          'r': blind,
          'valueProof': {'R': r, 'z': z, 'v': 1},
          'height': 1,
        },
      ],
      'dests': [otherDest],
      'dest': otherDest,
      'spendSeed': otherLedger.spendSeed,
    });
    final foreign = (otherScan['notes'] as List).cast<Map>();
    expect(foreign.where((n) => n['verified'] == true), isEmpty);
    expect(foreign.any((n) => n['kind'] == 'pool-fee'), isFalse);

    final noCache = scanSealedVouts({
      'vouts': [
        {
          'dest': dest,
          'kind': 'receive',
          'noteCommit': noteCommitOfDest20(d20),
          'commit': commit,
          'r': blind,
          'valueProof': {'R': r, 'z': z, 'v': 1},
          'height': 3,
        },
      ],
      'dests': [dest],
      'dest': dest,
      'spendSeed': spend,
    });
    expect((noCache['notes'] as List).where((n) => n is Map && n['verified'] == true), isEmpty);

    final wired = scanSealedWire({
      'vouts': [
        {
          'dest': dest,
          'kind': 'receive',
          'noteCommit': noteCommitOfDest20(d20),
          'commit': commit,
          'r': blind,
          'valueProof': {'R': r, 'z': z, 'v': 1},
          'height': 1,
        },
      ],
      'dests': [dest],
      'dest': dest,
      'spendSeed': spend,
      'openedProofs': [
        {'k': key, 'n': 2500000000},
      ],
    });
    final wiredNotes = (wired['notes'] as List).cast<Map>();
    expect(wiredNotes, isNotEmpty);
    expect(wiredNotes.first['verifiedNanos'], 2500000000);
  });

  test('a saved note paints spendable without opening it again', () {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    final commit = Uint8List.fromList(List<int>.filled(32, 4));
    ledger.rememberNote({
      'address': dest,
      'dest': dest,
      'kind': 'pool-fee',
      'commit': commit,
      'amount': 0.01,
      'height': 1,
      'verified': true,
      'proofChecked': true,
      'verifiedNanos': 1000000000,
      'proofKey': 'aa|bb|cc',
    });
    ledger.restoreOpenedProofs([
      {'k': 'aa|bb|cc', 'n': 1000000000},
    ]);
    final saved = ledger.exportNotesForSession();
    final fresh = ShearLedger()..bindIdentity(id);
    fresh.restoreSealedTip(9);
    fresh.restoreSessionNotes(saved, covered: 9, paymentCode: id.paymentCode);
    expect(fresh.restoredBook, isTrue);
    expect(
      fresh.spendableOwned(id.address, paymentCode: id.paymentCode),
      closeTo(0.01, 1e-9),
    );
    expect(fresh.pendingTxs(id.address).where((t) => t.kind == 'pool-fee'), isEmpty);
    final again = notesNotYetAccepted([
      {'commit': commit, 'kind': 'pool-fee'},
      {'commit': Uint8List.fromList(List<int>.filled(32, 8)), 'kind': 'pool-fee'},
    ], {_commitHex(commit)});
    expect(again, hasLength(1));
  });

  test('the next block opens only the note that was not accepted', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    var generation = 0;
    Map<String, dynamic>? first;
    Map<String, dynamic>? second;
    server.listen((req) async {
      try {
        await req.drain<void>();
        req.response.headers.contentType = ContentType.json;
        final path = req.uri.path;
        if (path == '/notes' || path == '/api/wallet/notes') {
          req.response.write(jsonEncode(_jsonSafe({
            'ok': true,
            'notes': [
              if (first != null) first,
              if (generation > 0 && second != null) second,
            ],
          })));
        } else if (path == '/stats' || path == '/api/stats') {
          req.response.write(jsonEncode({'ok': true, 'height': 20}));
        } else if (path == '/api/wallet/balance' || path == '/balance') {
          req.response.write(jsonEncode({'ok': true, 'balance': 0}));
        } else {
          req.response.statusCode = 404;
          req.response.write('{"ok":false}');
        }
        await req.response.close();
      } catch (_) {
        try {
          req.response.statusCode = 500;
          await req.response.close();
        } catch (_) {}
      }
    });
    final id = createIdentity();
    final ledger = ShearLedger(
      pool: ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}'),
    )..bindIdentity(id);
    final dest = ledger.syncDests(id.address, paymentCode: id.paymentCode).first;
    final opened = _feeNote(dest, height: 1);
    final vp = opened['valueProof'] as Map;
    ledger.restoreOpenedProofs([
      {'k': proofCacheKey(opened), 'n': _feeNanos()},
    ]);
    first = opened;
    second = _feeNote(dest, height: 12);
    expect(proofCacheKey(second!), isNot(proofCacheKey(opened)));
    expect(vp['v'], _feeNanos());
    final saw = await ledger.collateSpendNotes(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      hostHeight: 9,
    );
    expect(saw, isTrue);
    expect(ledger.notes.where((n) => n['verified'] == true), isNotEmpty);
    generation = 1;
    debugNotesOpenedThisScan = -1;
    await ledger.collateSpendNotes(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      hostHeight: 12,
    );
    expect(debugNotesOpenedThisScan, 1);
  });
}

int _feeNanos() => (kBlockPotShe * kUnitsPerShe).round() * kPoolFeeBps ~/ 10000;

/// A pool-fee note whose claimed v opens. A stand-in proof never opens and
/// the 1..200 bps hunt does not return inside the test.
Map<String, dynamic> _feeNote(String dest, {required int height}) {
  final d20 = hash20FromAddress(dest)!;
  final fee = _feeNanos();
  final blind = randomScalar();
  final value = proveValue(fee, blind);
  return {
    'dest': dest,
    'kind': 'pool-fee',
    'noteCommit': noteCommitOfDest20(d20),
    'commit': value['C'],
    'r': scalarBytes(blind),
    'valueProof': {'R': value['R'], 'z': value['z'], 'v': fee},
    'height': height,
  };
}

String _commitHex(Uint8List b) => b.map((e) => e.toRadixString(16).padLeft(2, '0')).join();

/// HttpServer jsonEncode rejects Uint8List. The wallet accepts the hex form.
Object? _jsonSafe(Object? v) {
  if (v is Uint8List) return _commitHex(v);
  if (v is Map) {
    return v.map((k, val) => MapEntry(k.toString(), _jsonSafe(val)));
  }
  if (v is List) return v.map(_jsonSafe).toList();
  return v;
}
