import 'dart:typed_data';

import 'shear_identity.dart';
import 'shear_note.dart';

/// One owned note whose value proof opened against its commit.
class OpenedReadNote {
  const OpenedReadNote({required this.height, required this.nanos, required this.verified});

  final int height;
  final int nanos;
  final bool verified;
}

/// An owned note at a height already read whose proof did not open.
class UnspendableReadNote {
  const UnspendableReadNote({required this.height, required this.reason});

  final int height;

  /// `bare-v` when R or z is missing. `proof` when verification fails.
  final String reason;
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
        unspendable.add(UnspendableReadNote(height: h, reason: _unspendableReason(note)));
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
  return OpenedReadNote(height: height, nanos: v, verified: true);
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
