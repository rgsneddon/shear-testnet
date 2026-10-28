import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_checkpoint.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_read_open.dart';
import 'package:shear_wallet/shear_ristretto.dart';
import 'package:shear_wallet/shear_read_sync.dart';

import 'support/sealed_book.dart';
import 'support/verified_chain.dart';

// Ruling 6 (Russell, 28 Oct): Spendable is verified-scanned, confirmed notes
// only. A read page carries value proofs under headers the wallet has not
// proven (here the stand-in 'aa'): its notes open and are verified, and they
// are Pending, Spendable 0, until the body scan proves their bodies. The
// book's depth is real: headers verified above a pin (verified_chain.dart),
// so the young/deep split is the 9-confirmation floor, not an unknown tip.
// Heights sit above the fixture pin at 15.
const _liveTip = 32;
const _read = <int>{22, 23, 24, 25};

/// A real owned coinbase output: public value proof, wrapped blind, admit key.
Map<String, dynamic> _seal(int nanos, Uint8List dest20, Uint8List seed) {
  final note = attachAdmitPub(sealCoinbaseNote(nanos, dest20: dest20, kind: 'pot'), spendSeed: seed);
  note.remove('r');
  return note;
}

String _hex(Object? v) {
  if (v is String) return v.toLowerCase();
  final bytes = v is Uint8List ? v : Uint8List.fromList(List<int>.from(v as List));
  return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

/// The same output as a page serves it: every byte field as hex.
Object? _hexAll(Object? v) {
  if (v is Uint8List) return _hex(v);
  if (v is Map) return {for (final e in v.entries) e.key.toString(): _hexAll(e.value)};
  if (v is List && v.isNotEmpty && v.first is! int) return [for (final x in v) _hexAll(x)];
  return v;
}

Map<String, dynamic> _hexNote(Map<String, dynamic> n) => Map<String, dynamic>.from(_hexAll(n) as Map);

Map<String, dynamic> _block(int height, List<Map<String, dynamic>> notes) => {
      'height': height,
      'header': 'aa',
      'txs': [
        {'vout': notes},
      ],
    };

/// Owned note of the same value whose R no longer opens that commit.
Map<String, dynamic> _failSameValue(Map<String, dynamic> note) {
  final vp = Map<String, dynamic>.from(note['valueProof'] as Map);
  final r = Uint8List.fromList(vp['R'] as Uint8List);
  r[0] = (r[0] + 1) & 0xff;
  vp['R'] = r;
  return {...note, 'valueProof': vp};
}

bool _sameCommit(Object? a, Object? b) {
  Uint8List? bytes(Object? v) {
    if (v is Uint8List) return v;
    if (v is List) return Uint8List.fromList(List<int>.from(v));
    return null;
  }

  final left = bytes(a);
  final right = bytes(b);
  if (left == null || right == null || left.length != right.length) return false;
  for (var i = 0; i < left.length; i++) {
    if (left[i] != right[i]) return false;
  }
  return true;
}

class _Book {
  _Book(
    this.ident,
    this.blocks, {
    required this.goodCommit,
    required this.failedCommit,
    required this.foreignCommit,
  });
  final ShearIdentity ident;
  final Map<int, Map<String, dynamic>> blocks;
  final Uint8List goodCommit;
  final Uint8List failedCommit;
  final Uint8List foreignCommit;
  String get dest => ident.address;

  List<Map<String, dynamic>> get shuffled => [
        blocks[29]!,
        blocks[25]!,
        blocks[22]!,
        blocks[24]!,
        blocks[23]!,
      ];
}

_Book _book() {
  final ident = createIdentity();
  final dest = ident.address;
  final d20 = hash20FromAddress(dest);
  if (d20 == null) throw StateError('dest20');
  final other = createIdentity();
  final other20 = hash20FromAddress(other.address);
  if (other20 == null) throw StateError('foreign dest20');
  final seed = seedOf(ident);
  final good2 = _seal(1000, d20, seed);
  final failedSame = _failSameValue(_seal(1000, d20, seed));
  final foreignSame = _seal(1000, other20, seedOf(other));
  final good5 = _hexNote(_seal(2500, d20, seed));
  final bad = _seal(3000, d20, seed);
  (bad['valueProof'] as Map)['v'] = 3001;
  final bare = _seal(4000, d20, seed);
  bare['valueProof'] = {'v': 4000};
  final unread = _seal(9000, d20, seed);
  return _Book(
    ident,
    {
      // Failed and foreign rows of the same value sit ahead of the note that opens.
      22: _block(22, [failedSame, foreignSame, good2]),
      23: _block(23, [bad]),
      24: _block(24, [bare]),
      25: _block(25, [good5]),
      29: _block(29, [unread]),
    },
    goodCommit: Uint8List.fromList(good2['commit'] as Uint8List),
    failedCommit: Uint8List.fromList(failedSame['commit'] as Uint8List),
    foreignCommit: Uint8List.fromList(foreignSame['commit'] as Uint8List),
  );
}

void _expectOpen(ReadBlockOpen opened, {required bool ibd}) {
  expect(opened.order, [22, 23, 24, 25]);
  expect(opened.openedHeights, [22, 25]);
  expect(opened.opened.every((n) => n.verified), isTrue);
  expect(opened.opened.map((n) => n.nanos).toList(), [1000, 2500]);
  expect(opened.spendableNanos, 3500);
  expect(opened.unspendable.map((n) => n.height).toList(), [22, 23, 24]);
  expect(opened.unspendable.map((n) => n.reason).toList(), ['proof', 'proof', 'bare-v']);
  expect(opened.order.contains(29), isFalse);
  expect(opened.openedHeights.contains(29), isFalse);
  expect(opened.unspendable.any((n) => n.height == 29), isFalse);
  expect(opened.catchingUp, isTrue);
  expect(opened.deferredUntilSync, isFalse);
  expect(opened.ibd, ibd);
  expect(opened.liveTip, _liveTip);
}

int _ledgerNanos(ShearLedger ledger, _Book book) =>
    (ledger.spendableOwned(book.ident.address, paymentCode: book.ident.paymentCode) * kUnitsPerShe).round();

int _pendingOf(ShearLedger ledger, ShearIdentity id) =>
    (ledger.unconfirmedIncomingShe(id.address, paymentCode: id.paymentCode) * kUnitsPerShe).round();

int _pendingNanos(ShearLedger ledger, _Book book) =>
    (ledger.unconfirmedIncomingShe(book.ident.address, paymentCode: book.ident.paymentCode) * kUnitsPerShe).round();

/// Opened notes are on the ledger, verified, at their heights, and Pending:
/// none is Spendable, the deep one included, because no body is proven.
/// A failed proof and a bare `{v}` are not coins.
void _expectLedger(ShearLedger ledger, _Book book, ReadBlockOpen opened, {required int pending}) {
  expect(opened.catchingUp, isTrue);
  expect(opened.deferredUntilSync, isFalse);
  expect(ledger.bookTip, _liveTip, reason: 'the depth is known: verified headers');
  expect(_ledgerNanos(ledger, book), 0, reason: 'ruling 6: no proven body, no Spendable');
  expect((ledger.spendable(book.ident.address) * kUnitsPerShe).round(), 0);
  expect(_pendingNanos(ledger, book), pending);
  expect(ledger.pickableNotes.where((n) => n['readOpen'] == true), isEmpty,
      reason: 'no send, lock, vote fee or withdraw picks a read-page note');
  final verified = <int>[
    for (final n in ledger.notes)
      if (n['verified'] == true && n['spent'] != true && n['nanos'] is num) (n['nanos'] as num).round(),
  ];
  expect(verified.contains(1000), isTrue);
  expect(verified.contains(2500), isTrue);
  expect(verified.contains(3001), isFalse);
  expect(verified.contains(4000), isFalse);
  expect(verified.contains(9000), isFalse);
  final openedAt2 = opened.opened.where((n) => n.height == 22).toList();
  expect(openedAt2, hasLength(1));
  expect(_sameCommit(openedAt2.single.commit, book.goodCommit), isTrue);
  expect(_sameCommit(openedAt2.single.commit, book.failedCommit), isFalse);
  expect(_sameCommit(openedAt2.single.commit, book.foreignCommit), isFalse);
  final verifiedAt2 = [
    for (final n in ledger.notes)
      if (n['verified'] == true && ((n['height'] as num?)?.toInt() ?? 0) == 22) n,
  ];
  expect(verifiedAt2, hasLength(1));
  expect(_sameCommit(verifiedAt2.single['commit'], openedAt2.single.commit), isTrue);
  expect(
    ledger.notes.any((n) => n['verified'] == true && _sameCommit(n['commit'], book.failedCommit)),
    isFalse,
  );
  expect(
    ledger.notes.any((n) => n['verified'] == true && _sameCommit(n['commit'], book.foreignCommit)),
    isFalse,
  );
}

void _obs(String mode, ReadBlockOpen opened, ShearLedger ledger, _Book book) {
  final unspendable = opened.unspendable.map((n) => '${n.height}:${n.reason}').join(',');
  final openedAt2 = opened.opened.where((n) => n.height == 22).toList();
  final verifiedAt2 = [
    for (final n in ledger.notes)
      if (n['verified'] == true && ((n['height'] as num?)?.toInt() ?? 0) == 22) n,
  ];
  final commitMatch = openedAt2.length == 1 &&
      verifiedAt2.length == 1 &&
      _sameCommit(openedAt2.single.commit, book.goodCommit) &&
      _sameCommit(verifiedAt2.single['commit'], openedAt2.single.commit);
  final failedVerified =
      ledger.notes.any((n) => n['verified'] == true && _sameCommit(n['commit'], book.failedCommit));
  // ignore: avoid_print
  print(
    'OBS mode=$mode order=${opened.order.join(',')} opened=${opened.openedHeights.join(',')} '
    'unspendable=$unspendable catchingUp=${opened.catchingUp} '
    'deferredUntilSync=${opened.deferredUntilSync} ibd=${opened.ibd} '
    'spendableNanos=${opened.spendableNanos} ledgerNanos=${_ledgerNanos(ledger, book)} '
    'commitMatch=$commitMatch failedVerified=$failedVerified',
  );
}

ShearLedger _bind(ShearReadSync? sync, ShearNodeSidecar? side, _Book book) {
  final ledger = ShearLedger();
  ledger.bindIdentity(book.ident);
  sync?.proofSink = ledger;
  side?.proofSink = ledger;
  return ledger;
}

void main() {
  test('Connect bare opens each read block proof in height order; the opened notes are Pending, not Spendable', () async {
    final book = _book();
    final sync = ShearReadSync(seeds: const ['http://127.0.0.1:9'], jitter: Duration.zero);
    final ledger = _bind(sync, null, book);
    await VerifiedChain(pinHeight: 15).verify(ledger, _liveTip);
    expect(_ledgerNanos(ledger, book), 0);
    final prefix = sync.applyReadPage(
      pageBlocks: [book.blocks[25]!, book.blocks[22]!],
      liveTip: _liveTip,
      dest: book.dest,
    );
    expect(prefix.order, [22, 25]);
    expect(prefix.openedHeights, [22, 25]);
    expect(prefix.catchingUp, isTrue);
    expect(prefix.deferredUntilSync, isFalse);
    expect(prefix.ibd, isFalse);
    expect(sync.sampledTip, _liveTip);
    expect(sync.honest, isFalse);
    // Height 22 has 11 confirmations at tip 32, height 25 has 8: both are
    // Pending, the deep one too, because neither body is proven.
    _expectLedger(ledger, book, prefix, pending: 3500);
    _obs('connect-bare-prefix', prefix, ledger, book);

    final grown = sync.applyReadPage(
      pageBlocks: [book.blocks[24]!, book.blocks[23]!],
      liveTip: _liveTip,
      dest: book.dest,
    );
    _expectOpen(grown, ibd: false);
    expect(sync.lastOpen, same(grown));
    _expectLedger(ledger, book, grown, pending: 3500);
    _obs('connect-bare-page', grown, ledger, book);

    final opened = sync.openConnectBare(
      blocks: book.shuffled,
      readHeights: _read,
      liveTip: _liveTip,
      dest: book.dest,
    );
    _expectOpen(opened, ibd: false);
    expect(sync.lastOpen, same(opened));
    _expectLedger(ledger, book, opened, pending: 3500);
    _obs('connect-bare', opened, ledger, book);
  }, timeout: const Timeout(Duration(minutes: 5)));

  test('Run node opens the same read-block proofs in height order while ibd is true; they stay Pending', () async {
    final book = _book();
    final sync = ShearReadSync(seeds: const ['http://127.0.0.1:9'], jitter: Duration.zero);
    final bare = sync.openConnectBare(
      blocks: book.shuffled,
      readHeights: _read,
      liveTip: _liveTip,
      dest: book.dest,
    );
    final side = ShearNodeSidecar();
    final ledger = _bind(null, side, book);
    await VerifiedChain(pinHeight: 15).verify(ledger, _liveTip);
    expect(side.reportedIbd, isTrue);
    expect(_ledgerNanos(ledger, book), 0);
    side.holdReadBlocks(
      book.shuffled,
      dest: book.dest,
      readHeights: _read,
      liveTip: _liveTip,
    );
    final line = '{"event":"status","height":25,"ibd":true,"peers":1}';
    expect(observeLocalTip(line), isFalse);
    expect(noteSidecarLine(side, line), isFalse);
    expect(side.reportedIbd, isTrue);
    final fromStatus = side.lastOpen!;
    _expectOpen(fromStatus, ibd: true);
    expect(fromStatus.order, bare.order);
    expect(fromStatus.openedHeights, bare.openedHeights);
    _expectLedger(ledger, book, fromStatus, pending: 3500);
    _obs('run-node-status', fromStatus, ledger, book);

    final opened = side.openWhileCatchingUp();
    _expectOpen(opened, ibd: true);
    expect(opened.order, bare.order);
    expect(opened.openedHeights, bare.openedHeights);
    expect(side.reportedIbd, isTrue);
    _expectLedger(ledger, book, opened, pending: 3500);
    _obs('run-node', opened, ledger, book);
  }, timeout: const Timeout(Duration(minutes: 5)));

  test('block proofs open off the UI isolate', () async {
    final openSrc = File('lib/shear_read_open.dart').readAsStringSync();
    final closureSrc = File('lib/shear_closure.dart').readAsStringSync();
    final syncSrc = File('lib/shear_read_sync.dart').readAsStringSync();
    final mainSrc = File('lib/main.dart').readAsStringSync();
    expect(openSrc, contains('Isolate.run(() => openReadBlockProofsWire('));
    expect(closureSrc, contains('openWhileCatchingUpOffUi('));
    expect(syncSrc, contains('applyReadPageOffUi('));
    // The wallet's node-log path never opens proofs on the UI isolate: it
    // parses status lines off it (parseNodeLogBatchOffUi) and does not call
    // noteSidecarLine, whose default walks the held proofs on the caller.
    // The walks it does run are the OffUi ones.
    expect(mainSrc, contains('await parseNodeLogBatchOffUi('));
    expect(mainSrc.contains('noteSidecarLine('), isFalse);
    expect(mainSrc, contains('openWhileCatchingUpOffUi('));
    expect(mainSrc.contains('openWhileCatchingUp()'), isFalse);
    expect(mainSrc, contains('openConnectBareOffUi('));
    expect(mainSrc.contains('.openConnectBare('), isFalse);
    final book = _book();
    final callerId = identityHashCode(Isolate.current).toString();
    debugReadProofIsolateRuns = 0;
    debugReadProofOffIsolateStamp = '';
    final opened = await openReadBlockProofsOffUi(
      blocks: book.shuffled,
      readHeights: _read,
      liveTip: _liveTip,
      dest: book.dest,
      ibd: true,
    );
    final direct = openReadBlockProofs(
      blocks: book.shuffled,
      readHeights: _read,
      liveTip: _liveTip,
      dest: book.dest,
      ibd: true,
    );
    expect(debugReadProofIsolateRuns, 1);
    expect(debugReadProofOffIsolateStamp.split('-').first, isNot(callerId));
    expect(opened.order, direct.order);
    expect(opened.openedHeights, direct.openedHeights);
    expect(opened.spendableNanos, direct.spendableNanos);
    expect(opened.unspendable.length, direct.unspendable.length);
    expect(opened.catchingUp, isTrue);
    final side = ShearNodeSidecar()..reportedIbd = true;
    side.holdReadBlocks(
      book.shuffled,
      dest: book.dest,
      readHeights: _read,
      liveTip: _liveTip,
    );
    final again = await side.openWhileCatchingUpOffUi();
    expect(again.order, direct.order);
    expect(again.openedHeights, direct.openedHeights);
    expect(side.lastOpen, same(again));
    expect(debugReadProofIsolateRuns, 2);
    final sync = ShearReadSync(seeds: const ['http://127.0.0.1:9'], jitter: Duration.zero);
    final page = await sync.applyReadPageOffUi(
      pageBlocks: [book.blocks[25]!, book.blocks[22]!],
      liveTip: _liveTip,
      dest: book.dest,
    );
    expect(page.order, [22, 25]);
    expect(page.openedHeights, [22, 25]);
    expect(page.catchingUp, isTrue);
    expect(debugReadProofIsolateRuns, 3);
    // ignore: avoid_print
    print(
      'PROOF_OFF_UI caller=$callerId stamp=${debugReadProofOffIsolateStamp.split('-').first} runs=$debugReadProofIsolateRuns order=${opened.order.join(',')}',
    );
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('a read page that hands over the blind in the clear still leaves its note Pending', () async {
    final ident = createIdentity();
    final d20 = hash20FromAddress(ident.address)!;
    // A page is the host's data: here it carries r beside the output.
    final withBlind = attachAdmitPub(sealCoinbaseNote(1000, dest20: d20, kind: 'pot'), spendSeed: seedOf(ident));
    expect(withBlind['r'], isNotNull);
    final book = _Book(ident, {22: _block(22, [withBlind])},
        goodCommit: Uint8List.fromList(withBlind['commit'] as Uint8List),
        failedCommit: Uint8List(32),
        foreignCommit: Uint8List(32));
    final sync = ShearReadSync(seeds: const ['http://127.0.0.1:9'], jitter: Duration.zero);
    final ledger = _bind(sync, null, book);
    await VerifiedChain(pinHeight: 15).verify(ledger, _liveTip);
    final opened = sync.applyReadPage(pageBlocks: [book.blocks[22]!], liveTip: _liveTip, dest: book.dest);
    expect(opened.openedHeights, [22]);
    expect(ledger.notes.where((n) => n['verified'] == true && n['readOpen'] == true), hasLength(1));
    expect(_ledgerNanos(ledger, book), 0, reason: 'an unproven body is never Spendable (ruling 6)');
    expect(_pendingNanos(ledger, book), 1000);
    expect(ledger.pickableNotes.where((n) => n['readOpen'] == true), isEmpty);
    // Saved and restored, it is still a read-page note.
    final restored = ShearLedger()..bindIdentity(ident);
    restored.restoreSessionNotes(ledger.exportNotesForSession(), paymentCode: ident.paymentCode);
    await VerifiedChain(pinHeight: 15).verify(restored, _liveTip);
    expect(_ledgerNanos(restored, book), 0);
    expect(_pendingNanos(restored, book), 1000);
  }, timeout: const Timeout(Duration(minutes: 5)));

  test('the same notes become Spendable once the body scan proves their bodies', () async {
    final seed = Uint8List.fromList(sha256.convert(utf8.encode('shear-read-open-then-body-scan')).bytes);
    final ident = createIdentity(seed);
    final home = (ShearLedger()..bindIdentity(ident)).homeDest(ident.address, paymentCode: ident.paymentCode);
    final node = await _startBodyNode(home, seed);
    addTearDown(() async {
      await node.proc.stdin.close();
      await node.proc.exitCode.timeout(const Duration(seconds: 20), onTimeout: () {
        node.proc.kill();
        return -1;
      });
    });
    final base = 'http://127.0.0.1:${(node.info['port'] as num).toInt()}';
    final tip = (node.info['tip'] as num).toInt();
    final pays = [
      for (final raw in node.info['payments'] as List)
        (
          height: ((raw as Map)['height'] as num).toInt(),
          commits: [for (final c in raw['commits'] as List) c.toString()],
          nanos: int.parse(raw['nanos'].toString()),
        ),
    ];
    final pool = ShearPoolClient(baseUrl: base, http: HttpClient());
    addTearDown(pool.close);
    final ledger = ShearLedger(pool: pool)..bindIdentity(ident);
    ledger.installCheckpoint(_pinOf(node.info));
    final sync = ShearReadSync(seeds: [base], jitter: Duration.zero);
    sync.proofSink = ledger;

    // The read page: the node's own blocks, as a page serves them.
    final page = [for (final p in pays) await _getJson('$base/block?height=${p.height}')];
    final opened = sync.applyReadPage(pageBlocks: page, liveTip: tip, dest: home);
    final paid = {for (final p in pays) ...p.commits};
    final readRows = [
      for (final n in ledger.notes)
        if (n['readOpen'] == true && paid.contains(_hex(n['commit']))) n,
    ];
    expect(opened.openedHeights, [for (final p in pays) p.height], reason: 'each coinbase opens from the page');
    expect(readRows.length, paid.length, reason: 'every paid output is on the book from the page');
    expect((ledger.spendableOwned(ident.address, paymentCode: ident.paymentCode) * kUnitsPerShe).round(), 0,
        reason: 'read-page notes are Pending until their bodies are proven');

    // The body scan proves those blocks against the headers it verifies.
    await ledger.populateSpendableFromNode(ident.address, paymentCode: ident.paymentCode);
    expect(ledger.spendableReadFailed, isFalse, reason: ledger.spendableReadError);
    expect(ledger.bookTip, tip);
    var deep = 0;
    var young = 0;
    for (final p in pays) {
      if (ledger.confirmationsOf(p.height) >= ShearLedger.spendableConfirmations) {
        deep += p.nanos;
      } else {
        young += p.nanos;
      }
    }
    expect(deep, greaterThan(0));
    expect(young, greaterThan(0));
    for (final n in ledger.notes) {
      if (!paid.contains(_hex(n['commit']))) continue;
      expect(n['readOpen'], isTrue, reason: 'the same row the page opened');
      expect(n['bodyProven'], isTrue, reason: 'its body is now proven');
    }
    expect((ledger.spendableOwned(ident.address, paymentCode: ident.paymentCode) * kUnitsPerShe).round(), deep,
        reason: 'proven and 9 deep: Spendable is exactly those notes');
    expect(_pendingOf(ledger, ident), young, reason: 'the young coin is still Pending');
  }, timeout: const Timeout(Duration(minutes: 10)));
}

/// A real v12 regtest node (fixtures/body_scan_node.mjs: the node's own
/// template, append and RPC, real ShearHash) whose coinbases pay [dest].
Future<({Process proc, Map<String, dynamic> info})> _startBodyNode(String dest, Uint8List seed) async {
  final proc = await Process.start('node', [
    'test/fixtures/body_scan_node.mjs',
    dest,
    _hex(seed),
  ]);
  final err = StringBuffer();
  proc.stderr.transform(utf8.decoder).listen(err.write);
  final first = Completer<String>();
  proc.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
    if (!first.isCompleted && line.trim().startsWith('{')) first.complete(line);
  });
  unawaited(proc.exitCode.then((code) {
    if (!first.isCompleted) first.completeError(StateError('node exited $code: $err'));
  }));
  final line = await first.future.timeout(const Duration(minutes: 8));
  return (proc: proc, info: jsonDecode(line) as Map<String, dynamic>);
}

CheckpointPin _pinOf(Map<String, dynamic> info) {
  final p = info['pin'] as Map<String, dynamic>;
  return CheckpointPin(
    network: p['network'] as String,
    height: (p['height'] as num).toInt(),
    hashHex: p['hashHex'] as String,
    timeMs: (p['timeMs'] as num).toInt(),
    bits: (p['bits'] as num).toInt(),
    anchorHeight: (p['anchorHeight'] as num).toInt(),
    anchorTimeMs: (p['anchorTimeMs'] as num).toInt(),
    anchorBits: (p['anchorBits'] as num).toInt(),
    priorTimesMs: [for (final t in p['priorTimesMs'] as List) (t as num).toInt()],
  );
}

Future<Map<String, dynamic>> _getJson(String url) async {
  final client = HttpClient();
  try {
    final res = await (await client.getUrl(Uri.parse(url))).close();
    final body = await res.transform(utf8.decoder).join();
    expect(res.statusCode, 200, reason: '$url $body');
    return jsonDecode(body) as Map<String, dynamic>;
  } finally {
    client.close(force: true);
  }
}
