import 'dart:isolate';
import 'dart:typed_data';

import 'shear_identity.dart';
import 'shear_note.dart';

/// How many [openReadBlockProofsWire] calls [Isolate.run] has returned.
int debugReadProofIsolateRuns = 0;

/// Stamp from the last proof walk. Differs from this isolate when the walk
/// ran in [Isolate.run].
String debugReadProofOffIsolateStamp = '';

/// One owned note whose value proof opened against its commit.
class OpenedReadNote {
  const OpenedReadNote({
    required this.height,
    required this.nanos,
    required this.verified,
    required this.commit,
    this.dest = '',
  });

  final int height;
  final int nanos;
  final bool verified;

  /// Commit bytes that [verifySealedNote] accepted for [nanos].
  final Uint8List commit;

  /// Money dest this note opened against. Empty means the walk's single dest.
  final String dest;
}

/// An owned note at a height already read whose proof did not open.
class UnspendableReadNote {
  const UnspendableReadNote({required this.height, required this.reason, this.commit});

  final int height;

  /// `bare-v` when R or z is missing. `proof` when verification fails.
  final String reason;

  /// Commit of the note that failed, when the row had one.
  final Uint8List? commit;
}

/// Result of walking blocks already read, in ascending height.
class ReadBlockOpen {
  const ReadBlockOpen({
    required this.order,
    required this.opened,
    required this.unspendable,
    required this.catchingUp,
    required this.deferredUntilSync,
    required this.spendableNanos,
    required this.ibd,
    required this.liveTip,
  });

  /// Read heights visited, ascending. An unread height is absent.
  final List<int> order;
  final List<OpenedReadNote> opened;
  final List<UnspendableReadNote> unspendable;

  /// Live tip is still ahead of the read prefix, or the node is still in IBD.
  final bool catchingUp;

  /// Opening is not held until catch-up finishes.
  final bool deferredUntilSync;
  final int spendableNanos;
  final bool ibd;
  final int liveTip;

  List<int> get openedHeights => [for (final n in opened) n.height];
}

/// Ledger (or a test double) that receives one finished walk.
abstract class ReadProofSink {
  void ingestReadOpen(ReadBlockOpen open, {required List blocks, String? dest});
}

int readBlockHeight(Object? block) {
  if (block is! Map) return 0;
  final h = block['height'];
  if (h is num) return h.toInt();
  return int.tryParse('$h') ?? 0;
}

/// Open sealed value proofs for heights already read.
///
/// [blocks] may arrive in any order. A height outside [readHeights] is not
/// opened, including while [liveTip] is still ahead or [ibd] is still true.
/// The same walk is what Connect bare and Run node call.
ReadBlockOpen openReadBlockProofs({
  required List blocks,
  required Set<int> readHeights,
  required int liveTip,
  String? dest,
  bool ibd = false,
}) {
  final heights = readHeights.where((h) => h >= 1).toList()..sort();
  final byHeight = <int, Map>{};
  for (final raw in blocks) {
    if (raw is! Map) continue;
    final h = readBlockHeight(raw);
    if (h < 1 || byHeight.containsKey(h)) continue;
    byHeight[h] = raw;
  }
  final dest20 = (dest == null || dest.isEmpty) ? null : hash20FromAddress(dest);
  final want = (dest20 != null && dest20.length == 20) ? noteCommitOfDest20(dest20) : null;
  final opened = <OpenedReadNote>[];
  final unspendable = <UnspendableReadNote>[];
  var spendable = 0;
  for (final h in heights) {
    final block = byHeight[h];
    if (block == null) continue;
    for (final note in _notesOf(block)) {
      if (!_owned(note, dest, dest20, want)) continue;
      final openedNote = _openOwned(note, h);
      if (openedNote != null) {
        opened.add(openedNote);
        spendable += openedNote.nanos;
      } else {
        unspendable.add(UnspendableReadNote(
          height: h,
          reason: _unspendableReason(note),
          commit: _copyCommit(note['commit']),
        ));
      }
    }
  }
  final maxRead = heights.isEmpty ? 0 : heights.last;
  return ReadBlockOpen(
    order: List<int>.unmodifiable(heights),
    opened: List<OpenedReadNote>.unmodifiable(opened),
    unspendable: List<UnspendableReadNote>.unmodifiable(unspendable),
    catchingUp: ibd || liveTip > maxRead,
    deferredUntilSync: false,
    spendableNanos: spendable,
    ibd: ibd,
    liveTip: liveTip,
  );
}

/// Sendable result of [openReadBlockProofs]. The walk stays in the worker.
Map<String, dynamic> openReadBlockProofsWire(Map<String, dynamic> input) {
  final heights = input['readHeights'];
  final opened = openReadBlockProofs(
    blocks: input['blocks'] as List,
    readHeights: heights is Set<int>
        ? heights
        : Set<int>.from((heights as List).map((h) => (h as num).toInt())),
    liveTip: (input['liveTip'] as num).toInt(),
    dest: input['dest'] as String?,
    ibd: input['ibd'] == true,
  );
  return {
    'isolateStamp':
        '${identityHashCode(Isolate.current)}-${DateTime.now().microsecondsSinceEpoch}',
    'order': opened.order,
    'opened': [
      for (final n in opened.opened)
        {
          'height': n.height,
          'nanos': n.nanos,
          'verified': n.verified,
          'commit': n.commit,
        },
    ],
    'unspendable': [
      for (final n in opened.unspendable)
        {
          'height': n.height,
          'reason': n.reason,
          if (n.commit != null) 'commit': n.commit,
        },
    ],
    'catchingUp': opened.catchingUp,
    'deferredUntilSync': opened.deferredUntilSync,
    'spendableNanos': opened.spendableNanos,
    'ibd': opened.ibd,
    'liveTip': opened.liveTip,
  };
}

ReadBlockOpen readBlockOpenFromWire(Map<String, dynamic> wire) {
  Uint8List? bytes(Object? raw) {
    if (raw == null) return null;
    if (raw is Uint8List) return raw;
    return Uint8List.fromList(List<int>.from(raw as List));
  }

  return ReadBlockOpen(
    order: [for (final h in (wire['order'] as List)) (h as num).toInt()],
    opened: [
      for (final raw in (wire['opened'] as List))
        if (raw is Map)
          OpenedReadNote(
            height: (raw['height'] as num).toInt(),
            nanos: (raw['nanos'] as num).toInt(),
            verified: raw['verified'] == true,
            commit: bytes(raw['commit']) ?? Uint8List(0),
          ),
    ],
    unspendable: [
      for (final raw in (wire['unspendable'] as List))
        if (raw is Map)
          UnspendableReadNote(
            height: (raw['height'] as num).toInt(),
            reason: (raw['reason'] as String?) ?? 'proof',
            commit: bytes(raw['commit']),
          ),
    ],
    catchingUp: wire['catchingUp'] == true,
    deferredUntilSync: wire['deferredUntilSync'] == true,
    spendableNanos: (wire['spendableNanos'] as num).toInt(),
    ibd: wire['ibd'] == true,
    liveTip: (wire['liveTip'] as num).toInt(),
  );
}

/// Open the same blocks once per money dest. Each opened note keeps that dest.
/// A mailbox that is not the home dest is not rewritten onto the home dest.
ReadBlockOpen openReadBlockProofsForDests({
  required List blocks,
  required Set<int> readHeights,
  required int liveTip,
  required List<String> dests,
  bool ibd = false,
}) {
  final want = dests.where((d) => d.isNotEmpty).toList();
  if (want.length <= 1) {
    return openReadBlockProofs(
      blocks: blocks,
      readHeights: readHeights,
      liveTip: liveTip,
      dest: want.isEmpty ? null : want.first,
      ibd: ibd,
    );
  }
  final opened = <OpenedReadNote>[];
  final unspendable = <UnspendableReadNote>[];
  final order = <int>{};
  var spendable = 0;
  var catching = false;
  var deferred = false;
  for (final d in want) {
    final part = openReadBlockProofs(
      blocks: blocks,
      readHeights: readHeights,
      liveTip: liveTip,
      dest: d,
      ibd: ibd,
    );
    order.addAll(part.order);
    catching = catching || part.catchingUp;
    deferred = deferred || part.deferredUntilSync;
    for (final n in part.opened) {
      opened.add(OpenedReadNote(
        height: n.height,
        nanos: n.nanos,
        verified: n.verified,
        commit: n.commit,
        dest: n.dest.isNotEmpty ? n.dest : d,
      ));
      spendable += n.nanos;
    }
    unspendable.addAll(part.unspendable);
  }
  final heights = order.toList()..sort();
  return ReadBlockOpen(
    order: List<int>.unmodifiable(heights),
    opened: List<OpenedReadNote>.unmodifiable(opened),
    unspendable: List<UnspendableReadNote>.unmodifiable(unspendable),
    catchingUp: catching,
    deferredUntilSync: deferred,
    spendableNanos: spendable,
    ibd: ibd,
    liveTip: liveTip,
  );
}

/// Proof walk for Connect bare and Run node. The UI isolate only applies the
/// result; [verifySealedNote] runs in [Isolate.run].
Future<ReadBlockOpen> openReadBlockProofsOffUi({
  required List blocks,
  required Set<int> readHeights,
  required int liveTip,
  String? dest,
  bool ibd = false,
}) {
  return Isolate.run(() => openReadBlockProofsWire({
        'blocks': blocks,
        'readHeights': readHeights.toList(),
        'liveTip': liveTip,
        'dest': dest,
        'ibd': ibd,
      })).then((wire) {
    debugReadProofIsolateRuns += 1;
    debugReadProofOffIsolateStamp = (wire['isolateStamp'] as String?) ?? '';
    return readBlockOpenFromWire(wire);
  });
}

List<Map> _notesOf(Map block) {
  final txs = block['txs'];
  if (txs is List && txs.isNotEmpty) {
    final out = <Map>[];
    for (final tx in txs) {
      if (tx is! Map) continue;
      for (final key in const ['vout', 'vouts', 'notes']) {
        final list = tx[key];
        if (list is! List) continue;
        for (final item in list) {
          if (item is Map) out.add(item);
        }
      }
    }
    if (out.isNotEmpty) return out;
  }
  final out = <Map>[];
  for (final key in const ['notes', 'vouts', 'vout']) {
    final list = block[key];
    if (list is! List) continue;
    for (final item in list) {
      if (item is Map) out.add(item);
    }
  }
  return out;
}

bool _owned(Map note, String? dest, Uint8List? dest20, Uint8List? wantCommit) {
  if (dest == null || dest.isEmpty) return false;
  final address = note['address']?.toString() ?? '';
  final rowDest = note['dest']?.toString() ?? '';
  if (address.isNotEmpty && address == dest) return true;
  if (rowDest.isNotEmpty && rowDest == dest) return true;
  final nc = _asBytes(note['noteCommit']);
  if (nc != null && wantCommit != null && _bytesEq(nc, wantCommit)) return true;
  final row20 = _asBytes(note['dest20']);
  if (row20 != null && dest20 != null && _prefixEq(row20, dest20)) return true;
  return false;
}

OpenedReadNote? _openOwned(Map note, int height) {
  final vp = note['valueProof'];
  if (vp is! Map) return null;
  final commit = _asBytes(note['commit']);
  final r = _asBytes(vp['R']);
  final z = _asBytes(vp['z']);
  final raw = vp['v'];
  if (commit == null || r == null || z == null || raw is! num) return null;
  final v = raw.round();
  if (v <= 0) return null;
  if (!verifySealedNote({
    'commit': commit,
    'valueProof': {'R': r, 'z': z, 'v': v},
  }, v)) {
    return null;
  }
  return OpenedReadNote(
    height: height,
    nanos: v,
    verified: true,
    commit: Uint8List.fromList(commit),
  );
}

Uint8List? _copyCommit(dynamic raw) {
  final bytes = _asBytes(raw);
  if (bytes == null || bytes.isEmpty) return null;
  return Uint8List.fromList(bytes);
}

String _unspendableReason(Map note) {
  final vp = note['valueProof'];
  if (vp is! Map) return 'bare-v';
  if (_asBytes(vp['R']) == null || _asBytes(vp['z']) == null || vp['v'] is! num) return 'bare-v';
  return 'proof';
}

Uint8List? _asBytes(dynamic v) {
  if (v is Uint8List) return v;
  if (v is List) {
    try {
      return Uint8List.fromList(List<int>.from(v));
    } catch (_) {
      return null;
    }
  }
  if (v is String) {
    final h = v.startsWith('0x') ? v.substring(2) : v;
    if (h.length < 2 || h.length.isOdd) return null;
    if (!RegExp(r'^[0-9a-fA-F]+$').hasMatch(h)) return null;
    final out = Uint8List(h.length ~/ 2);
    for (var i = 0; i < out.length; i++) {
      final byte = int.tryParse(h.substring(i * 2, i * 2 + 2), radix: 16);
      if (byte == null) return null;
      out[i] = byte;
    }
    return out;
  }
  return null;
}

bool _bytesEq(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

bool _prefixEq(Uint8List row, Uint8List dest20) {
  if (dest20.length != 20 || row.length < 20) return false;
  for (var i = 0; i < 20; i++) {
    if (row[i] != dest20[i]) return false;
  }
  return true;
}
