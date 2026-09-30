import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_identity.dart';
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

Map<String, dynamic> _block(int height, Map<String, dynamic> note) => {
      'height': height,
      'header': 'aa',
      'txs': [
        {'vout': [note]},
      ],
    };

class _Book {
  _Book(this.dest, this.blocks);
  final String dest;
  final Map<int, Map<String, dynamic>> blocks;

  List<Map<String, dynamic>> get shuffled => [
        blocks[9]!,
        blocks[5]!,
        blocks[2]!,
        blocks[4]!,
        blocks[3]!,
      ];
}

_Book _book() {
  final dest = createIdentity().address;
  final d20 = hash20FromAddress(dest);
  if (d20 == null) throw StateError('dest20');
  final good2 = _seal(1000, d20);
  final good5 = _hexNote(_seal(2500, d20));
  final bad = _seal(3000, d20);
  (bad['valueProof'] as Map)['v'] = 3001;
  final bare = _seal(4000, d20);
  bare['valueProof'] = {'v': 4000};
  final unread = _seal(9000, d20);
  return _Book(dest, {
    2: _block(2, good2),
    3: _block(3, bad),
    4: _block(4, bare),
    5: _block(5, good5),
    9: _block(9, unread),
  });
}

void _expectOpen(ReadBlockOpen opened, {required bool ibd}) {
  expect(opened.order, [2, 3, 4, 5]);
  expect(opened.openedHeights, [2, 5]);
  expect(opened.opened.every((n) => n.verified), isTrue);
  expect(opened.opened.map((n) => n.nanos).toList(), [1000, 2500]);
  expect(opened.spendableNanos, 3500);
  expect(opened.unspendable.map((n) => n.height).toList(), [3, 4]);
  expect(opened.unspendable.map((n) => n.reason).toList(), ['proof', 'bare-v']);
  expect(opened.order.contains(9), isFalse);
  expect(opened.openedHeights.contains(9), isFalse);
  expect(opened.unspendable.any((n) => n.height == 9), isFalse);
  expect(opened.catchingUp, isTrue);
  expect(opened.deferredUntilSync, isFalse);
  expect(opened.ibd, ibd);
  expect(opened.liveTip, _liveTip);
}

void _obs(String mode, ReadBlockOpen opened) {
  final unspendable = opened.unspendable.map((n) => '${n.height}:${n.reason}').join(',');
  // ignore: avoid_print
  print(
    'OBS mode=$mode order=${opened.order.join(',')} opened=${opened.openedHeights.join(',')} '
    'unspendable=$unspendable catchingUp=${opened.catchingUp} '
    'deferredUntilSync=${opened.deferredUntilSync} ibd=${opened.ibd} '
    'spendableNanos=${opened.spendableNanos}',
  );
}

void main() {
  test('Connect bare opens each read block proof in height order while the tip is ahead', () {
    final book = _book();
    final sync = ShearReadSync(seeds: const ['http://127.0.0.1:9'], jitter: Duration.zero);
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
    _obs('connect-bare-prefix', prefix);

    final grown = sync.applyReadPage(
      pageBlocks: [book.blocks[4]!, book.blocks[3]!],
      liveTip: _liveTip,
      dest: book.dest,
    );
    _expectOpen(grown, ibd: false);
    expect(sync.lastOpen, same(grown));
    _obs('connect-bare-page', grown);

    final opened = sync.openConnectBare(
      blocks: book.shuffled,
      readHeights: _read,
      liveTip: _liveTip,
      dest: book.dest,
    );
    _expectOpen(opened, ibd: false);
    expect(sync.lastOpen, same(opened));
    _obs('connect-bare', opened);
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
    expect(side.reportedIbd, isTrue);
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
    _obs('run-node-status', fromStatus);

    final opened = side.openWhileCatchingUp();
    _expectOpen(opened, ibd: true);
    expect(opened.order, bare.order);
    expect(opened.openedHeights, bare.openedHeights);
    expect(side.reportedIbd, isTrue);
    _obs('run-node', opened);
  });
}
