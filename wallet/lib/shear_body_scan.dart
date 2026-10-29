import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

/// Ruling 6 (Russell, 28 Oct): the node no longer serves notes (v12 AL-5),
/// so the wallet reads block bodies itself. A body counts only once its
/// tx digests give the merkle root of a header the wallet verified.
///
/// This is chain.js digestTx (TX_DIGEST=body-v2) and crypto/merkle.js:
///   leaf = sha256('shear-tx-digest-v2' || core || canon)
///   canon = sha256('shear-tx-body-v2' || canonicalEncode(body))
/// where body is the compact row without its id (a withdraw keeps it).
/// The wallet computes canon from the row it read. The node serves core
/// (GET /block?wire=1 txCores); the leaf binds canon, so a wrong core only
/// fails the proof and cannot pass a changed row.

const String kTxDigestDomain = 'shear-tx-digest-v2';
const String kTxBodyDomain = 'shear-tx-body-v2';

/// crypto/merkle.js EMPTY_ROOT.
final Uint8List kEmptyMerkleRoot = Uint8List.fromList(
  sha256.convert(utf8.encode('shear-empty-root-v1')).bytes,
);

final RegExp _evenLowerHex = RegExp(r'^(?:[0-9a-f]{2})*$');

Uint8List _hexBytes(String hex) {
  final out = Uint8List(hex.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

String _hexOf(List<int> bytes) {
  final b = StringBuffer();
  for (final x in bytes) {
    b.write(x.toRadixString(16).padLeft(2, '0'));
  }
  return b.toString();
}

/// canonical_row.js byteContainer, on a decoded JSON value: bytes held as
/// `{"$hex"}` (p2p hexify) or `{type:'Buffer', data}` (a JSON-loaded Buffer).
Uint8List? wireByteContainer(Object? v) {
  if (v is Uint8List) return v;
  if (v is! Map) return null;
  if (v.length == 1 && v.containsKey(r'$hex')) {
    final h = v[r'$hex'];
    if (h is String && _evenLowerHex.hasMatch(h)) return _hexBytes(h);
    return null;
  }
  if (v.length == 2 && v['type'] == 'Buffer' && v['data'] is List) {
    final data = v['data'] as List;
    for (final x in data) {
      if (x is! int || x < 0 || x > 255) return null;
    }
    return Uint8List.fromList(data.cast<int>());
  }
  return null;
}

/// JSON.stringify of a string: the same escapes, byte for byte.
String _jsString(String s) {
  final out = StringBuffer('"');
  final units = s.codeUnits;
  for (var i = 0; i < units.length; i++) {
    final c = units[i];
    if (c == 0x22) {
      out.write(r'\"');
    } else if (c == 0x5c) {
      out.write(r'\\');
    } else if (c == 0x08) {
      out.write(r'\b');
    } else if (c == 0x0c) {
      out.write(r'\f');
    } else if (c == 0x0a) {
      out.write(r'\n');
    } else if (c == 0x0d) {
      out.write(r'\r');
    } else if (c == 0x09) {
      out.write(r'\t');
    } else if (c < 0x20) {
      out.write('\\u${c.toRadixString(16).padLeft(4, '0')}');
    } else if (c >= 0xd800 && c <= 0xdbff) {
      final next = i + 1 < units.length ? units[i + 1] : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out.writeCharCode(c);
        out.writeCharCode(next);
        i++;
      } else {
        out.write('\\u${c.toRadixString(16)}');
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out.write('\\u${c.toRadixString(16)}');
    } else {
      out.writeCharCode(c);
    }
  }
  out.write('"');
  return out.toString();
}

/// JSON.stringify of a number. A number JSON cannot carry is null.
String _jsNumber(num n) {
  if (n is int) return n.toString();
  final d = n.toDouble();
  if (!d.isFinite) return 'null';
  if (d == 0) return '0';
  var s = d.toString();
  if (s.endsWith('.0')) s = s.substring(0, s.length - 2);
  return s;
}

/// crypto/canonical_row.js canonicalEncode, on a decoded wire value.
/// Throws [FormatException] on a value JSON cannot hold.
String canonicalEncodeWire(Object? v) {
  final bytes = wireByteContainer(v);
  if (bytes != null) return '{"\$b":${_jsString(_hexOf(bytes))}}';
  if (v is BigInt) return '{"\$big":${_jsString(v.toString())}}';
  if (v is List) return '[${v.map(canonicalEncodeWire).join(',')}]';
  if (v is Map) {
    final keys = <String>[for (final k in v.keys) k.toString()]..sort();
    return '{${keys.map((k) => '${_jsString(k)}:${canonicalEncodeWire(v[k])}').join(',')}}';
  }
  if (v == null) return 'null';
  if (v is bool) return v ? 'true' : 'false';
  if (v is num) return _jsNumber(v);
  if (v is String) return _jsString(v);
  throw FormatException('canonical: ${v.runtimeType}');
}

/// crypto/canonical_row.js canonicalAliasPath: the path of the first value
/// whose encoding is another value's, or '' when there is none. A plain
/// object holding only "$b" or "$big" encodes like bytes or a bigint.
String canonicalAliasPathWire(Object? v, [String at = '']) {
  if (v is double) return v.isFinite ? '' : (at.isEmpty ? '.' : at);
  if (v is! Map && v is! List) return '';
  if (wireByteContainer(v) != null) return '';
  if (v is List) {
    for (var i = 0; i < v.length; i++) {
      final hit = canonicalAliasPathWire(v[i], '$at[$i]');
      if (hit.isNotEmpty) return hit;
    }
    return '';
  }
  final m = v as Map;
  if (m.length == 1) {
    final k = m.keys.first.toString();
    if (k == r'$b' || k == r'$big') return at.isEmpty ? k : '$at.$k';
  }
  for (final k in m.keys) {
    final key = k.toString();
    final hit = canonicalAliasPathWire(m[k], at.isEmpty ? key : '$at.$key');
    if (hit.isNotEmpty) return hit;
  }
  return '';
}

Uint8List _sha256(List<List<int>> parts) {
  final sink = _DigestSink();
  final input = sha256.startChunkedConversion(sink);
  for (final p in parts) {
    input.add(p);
  }
  input.close();
  return Uint8List.fromList(sink.value!.bytes);
}

class _DigestSink implements Sink<Digest> {
  Digest? value;
  @override
  void add(Digest data) => value = data;
  @override
  void close() {}
}

/// chain.js digestTx of one wire row, given the core half of its leaf.
Uint8List wireTxLeaf(Map tx, Uint8List core) {
  final body = <String, dynamic>{
    for (final e in tx.entries) e.key.toString(): e.value,
  };
  final kind = body['kind'];
  if (!(kind is String && kind == 'withdraw')) body.remove('id');
  final canon = _sha256([
    utf8.encode(kTxBodyDomain),
    utf8.encode(canonicalEncodeWire(body)),
  ]);
  return _sha256([utf8.encode(kTxDigestDomain), core, canon]);
}

/// crypto/merkle.js merkleRoot. An odd last leaf pairs with itself.
Uint8List merkleRootOfLeaves(List<Uint8List> leaves) {
  if (leaves.isEmpty) return Uint8List.fromList(kEmptyMerkleRoot);
  var layer = <Uint8List>[
    for (final l in leaves) l.length == 32 ? l : _sha256([l]),
  ];
  while (layer.length > 1) {
    final next = <Uint8List>[];
    for (var i = 0; i < layer.length; i += 2) {
      final a = layer[i];
      final b = i + 1 < layer.length ? layer[i + 1] : a;
      next.add(_sha256([a, b]));
    }
    layer = next;
  }
  return layer.first;
}

/// The merkle root field of a 128-byte header (crypto/header.js).
Uint8List? headerMerkleRoot(Uint8List header) {
  if (header.length != 128) return null;
  return Uint8List.fromList(header.sublist(36, 68));
}

bool _same(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

/// One wire body checked against a verified header's merkle root.
class WireBodyProof {
  const WireBodyProof._(this.ok, this.reason, this.txs);

  final bool ok;

  /// Empty when [ok]. Otherwise why the body was refused.
  final String reason;

  /// The rows the root covers, in block order. Empty unless [ok].
  final List<Map<String, dynamic>> txs;

  static WireBodyProof refused(String reason) =>
      WireBodyProof._(false, reason, const []);
}

/// Prove [block] (GET /block?wire=1) against [merkleRoot], the root of the
/// header this wallet verified at [height]. A row that is not the one the
/// header commits to, a missing or extra row, a repeated row, or a missing
/// core is refused.
WireBodyProof proveWireBody(
  Map block, {
  required Uint8List merkleRoot,
  required int height,
}) {
  final h = block['height'];
  if (h is! num || h.toInt() != height) return WireBodyProof.refused('height');
  final txs = block['txs'];
  final cores = block['txCores'];
  if (txs is! List) return WireBodyProof.refused('no_txs');
  if (cores is! List || cores.length != txs.length) {
    return WireBodyProof.refused('no_cores');
  }
  final rows = <Map<String, dynamic>>[];
  final leaves = <Uint8List>[];
  final seen = <String>{};
  for (var i = 0; i < txs.length; i++) {
    final tx = txs[i];
    final core = cores[i];
    if (tx is! Map) return WireBodyProof.refused('row');
    if (core is! String || core.length != 64 || !_evenLowerHex.hasMatch(core)) {
      return WireBodyProof.refused('core');
    }
    if (canonicalAliasPathWire(tx).isNotEmpty) {
      return WireBodyProof.refused('alias');
    }
    final Uint8List leaf;
    try {
      leaf = wireTxLeaf(tx, _hexBytes(core));
    } on FormatException {
      return WireBodyProof.refused('row');
    }
    // chain.js blockLeaves: [A, B, C] and [A, B, C, C] share a root.
    if (!seen.add(_hexOf(leaf))) return WireBodyProof.refused('dup_leaf');
    leaves.add(leaf);
    rows.add(<String, dynamic>{
      for (final e in tx.entries) e.key.toString(): e.value,
    });
  }
  if (!_same(merkleRootOfLeaves(leaves), merkleRoot)) {
    return WireBodyProof.refused('merkle');
  }
  return WireBodyProof._(true, '', List.unmodifiable(rows));
}

/// A proven wire value with its byte containers as [Uint8List].
Object? reviveWireBytes(Object? v) {
  final bytes = wireByteContainer(v);
  if (bytes != null) return Uint8List.fromList(bytes);
  if (v is List) return [for (final x in v) reviveWireBytes(x)];
  if (v is Map) {
    return <String, dynamic>{
      for (final e in v.entries) e.key.toString(): reviveWireBytes(e.value),
    };
  }
  return v;
}

/// Scan rows of one proven body, in the shape the notes route used to send
/// (rpc.js notesForAddress before AL-5): each output with its block hash,
/// index, height, and coinbase flag. Tx-level portalId and withdrawNonce
/// ride on each output, as the chain scan needs for payouts and change.
/// Ownership is left to the scan, which opens only this wallet's outputs.
List<Map<String, dynamic>> wireScanRows(
  List<Map<String, dynamic>> provenTxs, {
  required int height,
  required Uint8List blockHash,
}) {
  final out = <Map<String, dynamic>>[];
  for (final raw in provenTxs) {
    final tx = reviveWireBytes(raw) as Map<String, dynamic>;
    final coinbase = tx['coinbase'] == true;
    final txKind = (tx['kind'] ?? '').toString();
    final vout = tx['vout'];
    if (vout is! List) continue;
    for (var i = 0; i < vout.length; i++) {
      final o = vout[i];
      if (o is! Map) continue;
      final row = Map<String, dynamic>.from(o);
      final kind = (row['kind'] ?? '').toString();
      row['kind'] = kind.isNotEmpty ? kind : (coinbase ? 'pot' : 'send');
      row['prev'] = Uint8List.fromList(blockHash);
      row['index'] = i;
      row['height'] = height;
      row['coinbase'] = coinbase;
      // Node JSON never says a body was proven. _applyBodyRows marks the
      // notes from these rows once their commits are in [provenAt].
      row.remove('bodyProven');
      final portal = tx['portalId'];
      if ((row['portalId'] ?? '').toString().isEmpty &&
          portal != null &&
          portal.toString().isNotEmpty) {
        row['portalId'] = portal;
      }
      if (row['withdrawNonce'] == null && tx['withdrawNonce'] != null) {
        row['withdrawNonce'] = tx['withdrawNonce'];
      }
      if (txKind.isNotEmpty) row['scanTxKind'] = txKind;
      out.add(row);
    }
  }
  return out;
}

/// Commit (hex) of every output in [provenTxs].
Set<String> wireOutputCommits(List<Map<String, dynamic>> provenTxs) {
  final out = <String>{};
  for (final tx in provenTxs) {
    final vout = tx['vout'];
    if (vout is! List) continue;
    for (final o in vout) {
      if (o is! Map) continue;
      final c = wireByteContainer(o['commit']);
      if (c != null && c.isNotEmpty) out.add(_hexOf(c));
    }
  }
  return out;
}
