import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_read_open.dart';
import 'package:shear_wallet/shear_ristretto.dart';
import 'package:shear_wallet/shear_read_sync.dart';

const _liveTip = 12;
const _read = <int>{2, 3, 4, 5};

Map<String, dynamic> _seal(int nanos, Uint8List dest20) {
  final value = proveValue(nanos, randomScalar());
  return {
    'kind': 'pot',
    'noteCommit': noteCommitOfDest20(dest20),
    'commit': value['C'],
    'valueProof': {'R': value['R'], 'z': value['z'], 'v': nanos},
    'dest20': dest20,
  };
}

String _hex(Object? v) {
  final bytes = v is Uint8List ? v : Uint8List.fromList(List<int>.from(v as List));
  return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

Map<String, dynamic> _hexNote(Map<String, dynamic> n) {
  final vp = Map<String, dynamic>.from(n['valueProof'] as Map);
  return {
    'kind': n['kind'],
    'noteCommit': _hex(n['noteCommit']),
    'commit': _hex(n['commit']),
    'dest20': _hex(n['dest20']),
    'valueProof': {'R': _hex(vp['R']), 'z': _hex(vp['z']), 'v': vp['v']},
  };
}

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
  return {
    'kind': note['kind'],
    'noteCommit': Uint8List.fromList(note['noteCommit'] as Uint8List),
    'commit': Uint8List.fromList(note['commit'] as Uint8List),
    'dest20': Uint8List.fromList(note['dest20'] as Uint8List),
    'valueProof': vp,
  };
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
        blocks[9]!,
        blocks[5]!,
        blocks[2]!,
        blocks[4]!,
        blocks[3]!,
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
  final good2 = _seal(1000, d20);
  final failedSame = _failSameValue(_seal(1000, d20));
  final foreignSame = _seal(1000, other20);
  final good5 = _hexNote(_seal(2500, d20));
  final bad = _seal(3000, d20);
  (bad['valueProof'] as Map)['v'] = 3001;
  final bare = _seal(4000, d20);
  bare['valueProof'] = {'v': 4000};
  final unread = _seal(9000, d20);
  return _Book(
    ident,
    {
      // Failed and foreign rows of the same value sit ahead of the note that opens.
      2: _block(2, [failedSame, foreignSame, good2]),
      3: _block(3, [bad]),
      4: _block(4, [bare]),
      5: _block(5, [good5]),
      9: _block(9, [unread]),
    },
    goodCommit: Uint8List.fromList(good2['commit'] as Uint8List),
    failedCommit: Uint8List.fromList(failedSame['commit'] as Uint8List),
    foreignCommit: Uint8List.fromList(foreignSame['commit'] as Uint8List),
  );
}

void _expectOpen(ReadBlockOpen opened, {required bool ibd}) {
  expect(opened.order, [2, 3, 4, 5]);
  expect(opened.openedHeights, [2, 5]);
  expect(opened.opened.every((n) => n.verified), isTrue);
  expect(opened.opened.map((n) => n.nanos).toList(), [1000, 2500]);
  expect(opened.spendableNanos, 3500);
  expect(opened.unspendable.map((n) => n.height).toList(), [2, 3, 4]);
  expect(opened.unspendable.map((n) => n.reason).toList(), ['proof', 'proof', 'bare-v']);
  expect(opened.order.contains(9), isFalse);
  expect(opened.openedHeights.contains(9), isFalse);
  expect(opened.unspendable.any((n) => n.height == 9), isFalse);
  expect(opened.catchingUp, isTrue);
  expect(opened.deferredUntilSync, isFalse);
  expect(opened.ibd, ibd);
  expect(opened.liveTip, _liveTip);
}

int _ledgerNanos(ShearLedger ledger, _Book book) =>
    (ledger.spendableOwned(book.ident.address, paymentCode: book.ident.paymentCode) * kUnitsPerShe).round();

/// Mature opened notes are on the ledger. The 9-confirmation floor still
/// withholds a younger opened note. A failed proof and a bare `{v}` are not coins.
void _expectLedger(ShearLedger ledger, _Book book, ReadBlockOpen opened, {required int nanos}) {
  expect(opened.catchingUp, isTrue);
  expect(opened.deferredUntilSync, isFalse);
  expect(_ledgerNanos(ledger, book), nanos);
  expect((ledger.spendable(book.ident.address) * kUnitsPerShe).round(), nanos);
  final verified = <int>[
    for (final n in ledger.notes)
      if (n['verified'] == true && n['spent'] != true && n['nanos'] is num) (n['nanos'] as num).round(),
  ];
  expect(verified.contains(1000), isTrue);
  expect(verified.contains(2500), isTrue);
  expect(verified.contains(3001), isFalse);
  expect(verified.contains(4000), isFalse);
  expect(verified.contains(9000), isFalse);
  final openedAt2 = opened.opened.where((n) => n.height == 2).toList();
  expect(openedAt2, hasLength(1));
  expect(_sameCommit(openedAt2.single.commit, book.goodCommit), isTrue);
  expect(_sameCommit(openedAt2.single.commit, book.failedCommit), isFalse);
  expect(_sameCommit(openedAt2.single.commit, book.foreignCommit), isFalse);
  final verifiedAt2 = [
    for (final n in ledger.notes)
      if (n['verified'] == true && ((n['height'] as num?)?.toInt() ?? 0) == 2) n,
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
  final openedAt2 = opened.opened.where((n) => n.height == 2).toList();
  final verifiedAt2 = [
    for (final n in ledger.notes)
      if (n['verified'] == true && ((n['height'] as num?)?.toInt() ?? 0) == 2) n,
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
  test('Connect bare opens each read block proof in height order while the tip is ahead', () {
    final book = _book();
    final sync = ShearReadSync(seeds: const ['http://127.0.0.1:9'], jitter: Duration.zero);
    final ledger = _bind(sync, null, book);
    expect(_ledgerNanos(ledger, book), 0);
    final prefix = sync.applyReadPage(
      pageBlocks: [book.blocks[5]!, book.blocks[2]!],
      liveTip: _liveTip,
      dest: book.dest,
    );
    expect(prefix.order, [2, 5]);
    expect(prefix.openedHeights, [2, 5]);
    expect(prefix.catchingUp, isTrue);
    expect(prefix.deferredUntilSync, isFalse);
    expect(prefix.ibd, isFalse);
    expect(sync.sampledTip, _liveTip);
    expect(sync.honest, isFalse);
    // Height 2 has 11 confirmations at tip 12. Height 5 has 8, under the floor.
    _expectLedger(ledger, book, prefix, nanos: 1000);
    _obs('connect-bare-prefix', prefix, ledger, book);

    final grown = sync.applyReadPage(
      pageBlocks: [book.blocks[4]!, book.blocks[3]!],
      liveTip: _liveTip,
      dest: book.dest,
    );
    _expectOpen(grown, ibd: false);
    expect(sync.lastOpen, same(grown));
    _expectLedger(ledger, book, grown, nanos: 1000);
    _obs('connect-bare-page', grown, ledger, book);

    final opened = sync.openConnectBare(
      blocks: book.shuffled,
      readHeights: _read,
      liveTip: _liveTip,
      dest: book.dest,
    );
    _expectOpen(opened, ibd: false);
    expect(sync.lastOpen, same(opened));
    _expectLedger(ledger, book, opened, nanos: 1000);
    _obs('connect-bare', opened, ledger, book);
  });

  test('Run node opens the same read-block proofs in height order while ibd is true', () {
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
    expect(side.reportedIbd, isTrue);
    expect(_ledgerNanos(ledger, book), 0);
    side.holdReadBlocks(
      book.shuffled,
      dest: book.dest,
      readHeights: _read,
      liveTip: _liveTip,
    );
    final line = '{"event":"status","height":5,"ibd":true,"peers":1}';
    expect(observeLocalTip(line), isFalse);
    expect(noteSidecarLine(side, line), isFalse);
    expect(side.reportedIbd, isTrue);
    final fromStatus = side.lastOpen!;
    _expectOpen(fromStatus, ibd: true);
    expect(fromStatus.order, bare.order);
    expect(fromStatus.openedHeights, bare.openedHeights);
    _expectLedger(ledger, book, fromStatus, nanos: 1000);
    _obs('run-node-status', fromStatus, ledger, book);

    final opened = side.openWhileCatchingUp();
    _expectOpen(opened, ibd: true);
    expect(opened.order, bare.order);
    expect(opened.openedHeights, bare.openedHeights);
    expect(side.reportedIbd, isTrue);
    _expectLedger(ledger, book, opened, nanos: 1000);
    _obs('run-node', opened, ledger, book);
  });

  test('block proofs open off the UI isolate', () async {
    final openSrc = File('lib/shear_read_open.dart').readAsStringSync();
    final closureSrc = File('lib/shear_closure.dart').readAsStringSync();
    final syncSrc = File('lib/shear_read_sync.dart').readAsStringSync();
    final mainSrc = File('lib/main.dart').readAsStringSync();
    expect(openSrc, contains('Isolate.run(() => openReadBlockProofsWire('));
    expect(closureSrc, contains('openWhileCatchingUpOffUi('));
    expect(syncSrc, contains('applyReadPageOffUi('));
    expect(mainSrc, contains('openProofs: false'));
    expect(mainSrc, contains('openWhileCatchingUpOffUi('));
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
      pageBlocks: [book.blocks[5]!, book.blocks[2]!],
      liveTip: _liveTip,
      dest: book.dest,
    );
    expect(page.order, [2, 5]);
    expect(page.openedHeights, [2, 5]);
    expect(page.catchingUp, isTrue);
    expect(debugReadProofIsolateRuns, 3);
    // ignore: avoid_print
    print(
      'PROOF_OFF_UI caller=$callerId stamp=${debugReadProofOffIsolateStamp.split('-').first} runs=$debugReadProofIsolateRuns order=${opened.order.join(',')}',
    );
  }, timeout: const Timeout(Duration(minutes: 2)));
}
