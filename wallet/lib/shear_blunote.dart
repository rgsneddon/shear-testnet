import 'dart:typed_data';

import 'package:crypto/crypto.dart' show sha256;

import 'shear_admit.dart';
import 'shear_note.dart';
import 'shear_ristretto.dart';

/// R28 BluNotes, the wallet side. Authoritative JS: crypto/blunote.js.
///
/// A share names a one-time key (R, P), never an address. The rig holds the
/// mining address (B, Y) and no secret. Only the scan scalar y finds a note
/// (S = y·R) and only x_base + delta spends it, delta = H(S). Each block
/// carries a record; its notes are derived from the record alone.

/// Winners per block (crypto/blunote.js BLUNOTE_WINNERS).
const int kBluWinners = 16;

final _scanDst = utf8Bytes('shear-blunote-scan-v1');
final _deltaDst = utf8Bytes('shear-blunote-delta-v1');
final _rhoDst = utf8Bytes('shear-blunote-rho-v1');
final _recDst = utf8Bytes('shear-blunote-record-v1');

/// Wallet kinds of a record note. 'pool-fee' is a different note in the
/// ledger (the Path 1 pool fee), so the fee note of a record is 'blunote-fee'.
const String kBluKindWinner = 'blunote';
const String kBluKindFee = 'blunote-fee';

bool isBluNoteKind(String? kind) => kind == kBluKindWinner || kind == kBluKindFee;

/// Scan scalar y = H("shear-blunote-scan-v1" || spendSeed).
Scalar bluScanScalar(Uint8List spendSeed) => hashToScalar([_scanDst, spendSeed]);

/// Y = y·G.
Uint8List bluScanPub(Uint8List spendSeed) => mulGBytes(scalarBytes(bluScanScalar(spendSeed)));

String _hex(Uint8List b) {
  final sb = StringBuffer();
  for (final x in b) {
    sb.write(x.toRadixString(16).padLeft(2, '0'));
  }
  return sb.toString();
}

Uint8List _unhex(String s) {
  if (s.length.isOdd || !RegExp(r'^[0-9a-fA-F]*$').hasMatch(s)) throw const FormatException('hex');
  final out = Uint8List(s.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(s.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

/// The mining address the rig takes as `--blu`: hex(B) || hex(Y), 128 hex.
/// Both halves are public keys. It holds no secret.
String bluMiningAddress(Uint8List spendSeed) =>
    _hex(admitBaseBytes(spendSeed)) + _hex(bluScanPub(spendSeed));

/// The keys one wallet scans with. [y] and [xBase] are secrets: they stay in
/// memory and are never written to the session or a log.
class BluKeys {
  BluKeys._(this.y, this.xBase, this.B);

  factory BluKeys.fromSeed(Uint8List spendSeed) {
    if (spendSeed.length != 32) throw ArgumentError('spendSeed');
    final xBase = admitBaseScalar(spendSeed);
    return BluKeys._(bluScanScalar(spendSeed), xBase, pointBytes(admitPub(xBase)));
  }

  final Scalar y;
  final Scalar xBase;
  final Uint8List B;
}

bool _eq32(Uint8List a, Uint8List b) {
  if (a.length != 32 || b.length != 32) return false;
  var d = 0;
  for (var i = 0; i < 32; i++) {
    d |= a[i] ^ b[i];
  }
  return d == 0;
}

bool _isZero32(Uint8List a) {
  for (final x in a) {
    if (x != 0) return false;
  }
  return true;
}

/// A canonical ristretto encoding that is not the identity, else null.
Uint8List? _point(Uint8List? raw) {
  if (raw == null || raw.length != 32 || _isZero32(raw)) return null;
  try {
    final p = pointFrom(raw);
    final back = pointBytes(p);
    return _eq32(back, raw) ? Uint8List.fromList(raw) : null;
  } catch (_) {
    return null;
  }
}

Scalar _deltaOfShared(Uint8List shared) => hashToScalar([_deltaDst, shared]);

/// delta = H("shear-blunote-delta-v1" || y·R). Null when R is not a point.
Scalar? bluDelta(Scalar y, Uint8List R) {
  final r = _point(R);
  if (r == null) return null;
  return _deltaOfShared(mulBytes(r, scalarBytes(y)));
}

/// Spend-side delta from the seed alone, for a note whose R the wallet keeps
/// (stored as the note's noteCommit). Nothing secret is stored with the note.
Scalar? bluDeltaFromSeed(Uint8List spendSeed, Uint8List R) => bluDelta(bluScanScalar(spendSeed), R);

/// Owner check for one (R, P): delta when P = B + delta·G, else null.
/// The record has no view tag, so every candidate costs one var-base and one
/// base multiplication.
Scalar? bluRecognise(BluKeys keys, Uint8List R, Uint8List P) {
  if (P.length != 32) return null;
  final delta = bluDelta(keys.y, R);
  if (delta == null) return null;
  final want = addBytes(keys.B, mulGBytes(scalarBytes(delta)));
  return _eq32(want, P) ? delta : null;
}

/// x = x_base + delta. x·G is the note's admitPub P.
Scalar bluSpendScalar(Scalar xBase, Scalar delta) => scalarAdd(xBase, delta);

/// A fresh one-time key for (B, Y) and nonce r. Tests and vectors only; the
/// rig draws r at random.
({Uint8List R, Uint8List P}) bluOneTimeKey(Uint8List B, Uint8List Y, Scalar r) {
  final rb = scalarBytes(r);
  final R = mulGBytes(rb);
  final shared = mulBytes(Y, rb);
  final P = addBytes(B, mulGBytes(scalarBytes(_deltaOfShared(shared))));
  return (R: R, P: P);
}

/// Public blinding of a record note: rho = H("shear-blunote-rho-v1" || P).
Scalar bluRho(Uint8List P) => hashToScalar([_rhoDst, P]);

/// C = v·G + rho·H with the chain's value generator H.
Uint8List bluCommit(BigInt v, Uint8List P) => commitBytesUnits(v, scalarBytes(bluRho(P)));

class BluWinnerRow {
  const BluWinnerRow(this.R, this.P, this.m);
  final Uint8List R;
  final Uint8List P;
  final int m;
}

/// One block's record:
/// batchRoot 32 | n u32 | W u64 | T u64 | feeV u64 | feeR 32 | feeP 32 |
/// count u8 | count × (R 32 | P 32 | m u8). Integers are little-endian.
class BluRecord {
  const BluRecord({
    required this.batchRoot,
    required this.n,
    required this.W,
    required this.T,
    required this.feeV,
    required this.feeR,
    required this.feeP,
    required this.winners,
  });

  final Uint8List batchRoot;
  final int n;
  final BigInt W;
  final BigInt T;
  final BigInt feeV;
  final Uint8List feeR;
  final Uint8List feeP;
  final List<BluWinnerRow> winners;

  /// Each winner gets m pieces of floor(T / k).
  BigInt get piece => T ~/ BigInt.from(kBluWinners);
}

const int _recHead = 32 + 4 + 8 + 8 + 8 + 64 + 1;

BigInt _u64le(Uint8List b, int at) {
  var v = BigInt.zero;
  for (var i = 7; i >= 0; i--) {
    v = (v << 8) | BigInt.from(b[at + i]);
  }
  return v;
}

/// Null when the bytes are not one whole record.
BluRecord? decodeBluRecord(Uint8List b) {
  if (b.length < _recHead) return null;
  final count = b[_recHead - 1];
  if (b.length != _recHead + count * 65) return null;
  final n = b[32] | (b[33] << 8) | (b[34] << 16) | (b[35] << 24);
  final winners = <BluWinnerRow>[
    for (var i = 0; i < count; i++)
      BluWinnerRow(
        Uint8List.fromList(b.sublist(_recHead + i * 65, _recHead + i * 65 + 32)),
        Uint8List.fromList(b.sublist(_recHead + i * 65 + 32, _recHead + i * 65 + 64)),
        b[_recHead + i * 65 + 64],
      ),
  ];
  return BluRecord(
    batchRoot: Uint8List.fromList(b.sublist(0, 32)),
    n: n,
    W: _u64le(b, 36),
    T: _u64le(b, 44),
    feeV: _u64le(b, 52),
    feeR: Uint8List.fromList(b.sublist(60, 92)),
    feeP: Uint8List.fromList(b.sublist(92, 124)),
    winners: winners,
  );
}

/// The `blunoteRecord` hex on a compact block row, or null.
Uint8List? bluRecordOfBlock(Map block) {
  final raw = block['blunoteRecord'];
  if (raw is Uint8List) return raw;
  if (raw is! String || raw.isEmpty) return null;
  try {
    return _unhex(raw);
  } catch (_) {
    return null;
  }
}

/// One record note this wallet owns.
class BluNoteFound {
  const BluNoteFound({
    required this.height,
    required this.kind,
    required this.R,
    required this.P,
    required this.v,
    required this.C,
    required this.rho,
    required this.delta,
    required this.recordKey,
    this.m = 0,
  });

  final int height;
  final String kind;
  final Uint8List R;
  final Uint8List P;
  final BigInt v;
  final Uint8List C;
  final Scalar rho;

  /// Secret. The ledger does not store it: a spend derives it again from the
  /// seed and R.
  final Scalar delta;

  /// Names the record this note came from (height, head bytes, length).
  /// A reorg that replaces the record changes it.
  final String recordKey;
  final int m;
}

String bluRecordKey(int height, Uint8List record) {
  // The first 32 bytes are the batch root; with n, W and T they name the record.
  final head = record.length >= 52 ? record.sublist(0, 52) : record;
  return '$height:${_hex(Uint8List.fromList(head))}:${record.length}';
}

/// Every note of [record] this wallet owns: the pool fee note (when feeV > 0
/// and the fee key is ours) then each winner, in record order. A stranger's
/// row is not ours and is skipped. At most 1 + count candidates.
List<BluNoteFound> scanBluRecord(Uint8List record, BluKeys keys, int height) {
  final rec = decodeBluRecord(record);
  if (rec == null) return const [];
  final key = bluRecordKey(height, record);
  final out = <BluNoteFound>[];
  void take(String kind, Uint8List R, Uint8List P, BigInt v, int m) {
    if (v <= BigInt.zero || v.bitLength > noteBits) return;
    final delta = bluRecognise(keys, R, P);
    if (delta == null) return;
    final rho = bluRho(P);
    final C = commitBytesUnits(v, scalarBytes(rho));
    if (!noteIsFs1Leaf(P, C)) return;
    out.add(BluNoteFound(
      height: height,
      kind: kind,
      R: R,
      P: P,
      v: v,
      C: C,
      rho: rho,
      delta: delta,
      recordKey: key,
      m: m,
    ));
  }

  if (rec.feeV > BigInt.zero) take(kBluKindFee, rec.feeR, rec.feeP, rec.feeV, 0);
  final piece = rec.piece;
  for (final w in rec.winners) {
    take(kBluKindWinner, w.R, w.P, piece * BigInt.from(w.m), w.m);
  }
  return out;
}

/// The ledger row of a found note on the wallet's money [dest]. It is an
/// FS-1 note like any other: admitPub P, commit C, blind r = rho. noteCommit
/// carries R so a spend can derive x = x_base + H(y·R) from the seed; vin is
/// C̃ only, so R is not posted. No secret is in the row.
Map<String, dynamic> bluNoteRow(BluNoteFound f, String dest, {required int unitsPerShe}) => {
      'kind': f.kind,
      'address': dest,
      'dest': dest,
      'height': f.height,
      'commit': f.C,
      'admitPub': f.P,
      'noteCommit': f.R,
      'r': scalarBytes(f.rho),
      'nanos': f.v.bitLength < 63 ? f.v.toInt() : f.v.toString(),
      'amount': f.v.toDouble() / unitsPerShe,
      'verified': true,
      'spent': false,
      'bluRecord': f.recordKey,
      if (f.m > 0) 'bluM': f.m,
    };

/// Isolate body: scan records off the UI isolate. Input `seed` (32 bytes)
/// and `records` [{height, hex}]. Output rows with byte fields, no delta.
List<Map<String, dynamic>> scanBluRecordsWire(Map<String, dynamic> input) {
  final seed = input['seed'] as Uint8List;
  final keys = BluKeys.fromSeed(seed);
  final out = <Map<String, dynamic>>[];
  for (final raw in (input['records'] as List)) {
    final m = raw as Map;
    final h = m['height'] as int;
    final rec = m['record'] as Uint8List;
    for (final f in scanBluRecord(rec, keys, h)) {
      out.add({
        'height': f.height,
        'kind': f.kind,
        'R': f.R,
        'P': f.P,
        'v': f.v.toString(),
        'C': f.C,
        'rho': scalarBytes(f.rho),
        'recordKey': f.recordKey,
        'recordRoot': bluRecordRootHex(rec),
        'm': f.m,
      });
    }
  }
  return out;
}

/// "This wallet mines" (Russell D4). Off by default. Only when on does the
/// wallet scan block records for winners, from [birthHeight] up. A record
/// already scanned under the same key is not scanned again.
class BluMiningScanner {
  BluMiningScanner({this.enabled = false, this.birthHeight = 0});

  bool enabled;
  int birthHeight;
  final Set<String> _scanned = {};

  int get scannedCount => _scanned.length;

  /// Forget what was scanned, so the next pass rescans every read block.
  void reset() => _scanned.clear();

  /// Records in [blocks] still to scan: [{height, record}]. Empty when off.
  List<Map<String, Object>> pending(Iterable blocks) {
    if (!enabled) return const [];
    final out = <Map<String, Object>>[];
    for (final raw in blocks) {
      if (raw is! Map) continue;
      final h = raw['height'];
      final height = h is num ? h.toInt() : int.tryParse('$h') ?? 0;
      if (height < 1 || height < birthHeight) continue;
      final rec = bluRecordOfBlock(raw);
      if (rec == null) continue;
      final key = bluRecordKey(height, rec);
      if (_scanned.contains(key)) continue;
      out.add({'height': height, 'record': rec, 'key': key});
    }
    return out;
  }

  void markScanned(Iterable<Map<String, Object>> done) {
    for (final d in done) {
      _scanned.add(d['key'] as String);
    }
  }

  /// Inline scan of [blocks] (tests and small pages). Empty when off.
  List<BluNoteFound> scanBlocks(Iterable blocks, Uint8List spendSeed) {
    final todo = pending(blocks);
    if (todo.isEmpty) return const [];
    final keys = BluKeys.fromSeed(spendSeed);
    final out = <BluNoteFound>[];
    for (final t in todo) {
      out.addAll(scanBluRecord(t['record'] as Uint8List, keys, t['height'] as int));
    }
    markScanned(todo);
    return out;
  }
}

/// Keys of the records on [blocks] by height. A note whose record key is not
/// the one now at its height was on a block that was replaced. Every R28
/// block has a record (an empty batch too), so a row without one is a row
/// the server sent without it, not a replaced block: it is left out.
Map<int, String> bluRecordKeysByHeight(Iterable blocks) {
  final out = <int, String>{};
  for (final raw in blocks) {
    if (raw is! Map) continue;
    final h = raw['height'];
    final height = h is num ? h.toInt() : int.tryParse('$h') ?? 0;
    if (height < 1) continue;
    final rec = bluRecordOfBlock(raw);
    if (rec == null) continue;
    out[height] = bluRecordKey(height, rec);
  }
  return out;
}


/// recordRoot = sha256("shear-blunote-record-v1" || record). Block h+1's
/// coinbase names it as `blunote.prev`, under that block's PoW.
String bluRecordRootHex(Uint8List record) =>
    _hex(Uint8List.fromList(sha256.convert([..._recDst, ...record]).bytes));

/// The parent record root each block's coinbase names, by that block's
/// height. A block with no coinbase blunote field is left out.
Map<int, String> bluPrevRootsByHeight(Iterable blocks) {
  final out = <int, String>{};
  for (final raw in blocks) {
    if (raw is! Map) continue;
    final h = raw['height'];
    final height = h is num ? h.toInt() : int.tryParse('$h') ?? 0;
    if (height < 1) continue;
    final txs = raw['txs'];
    if (txs is! List) continue;
    for (final tx in txs) {
      if (tx is! Map || tx['coinbase'] != true) continue;
      final blu = tx['blunote'];
      if (blu is! Map) continue;
      final prev = blu['prev'];
      if (prev is String && RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(prev)) {
        out[height] = prev.toLowerCase();
      }
    }
  }
  return out;
}
