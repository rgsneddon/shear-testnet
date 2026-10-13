import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_admit.dart';
import 'shear_note.dart';
import 'shear_ristretto.dart';

/// Book magic the v12 node binds into the membership statement.
const String kMembershipMagic = 'shear-testnet-v12';

/// Interim statement length. FS-1 replaces [flowMembershipStatement].
const int kMembershipStatementBytes = 64;

const int kMembershipAnchorQuantum = 8;
const int kMembershipConfirmations = 9;

/// Consensus input cap for one flow spend.
const int kMembershipInputCap = 8;

/// Newest multiple of the anchor quantum at least [kMembershipConfirmations]
/// behind the block that will include the spend. Null means the chain is
/// still too short.
int? walletMembershipAnchor(int includeHeight) {
  if (includeHeight - kMembershipConfirmations < kMembershipAnchorQuantum) {
    return null;
  }
  return ((includeHeight - kMembershipConfirmations) ~/ kMembershipAnchorQuantum) *
      kMembershipAnchorQuantum;
}

Uint8List _u32le(int n) {
  final b = Uint8List(4);
  final v = n < 0 ? 0 : n;
  b[0] = v & 0xff;
  b[1] = (v >> 8) & 0xff;
  b[2] = (v >> 16) & 0xff;
  b[3] = (v >> 24) & 0xff;
  return b;
}

Uint8List _u64le(int n) {
  final b = Uint8List(8);
  var v = n < 0 ? 0 : n;
  for (var i = 0; i < 8; i++) {
    b[i] = v & 0xff;
    v >>= 8;
  }
  return b;
}

Uint8List _lenPref(Uint8List raw) {
  return Uint8List.fromList([..._u32le(raw.length), ...raw]);
}

Uint8List _bytes32(Object? value) {
  if (value is Uint8List && value.length == 32) return value;
  return Uint8List(32);
}

Uint8List _asBytes(Object? value) {
  if (value is Uint8List) return value;
  return Uint8List(0);
}

/// SHA-256 transcript of a flow body. Matches the node's tx digest for a
/// send or transfer that carries these inputs and outputs. FS-1 replaces
/// the statement that consumes this digest.
Uint8List flowMembershipDigest({
  required String kind,
  required int anchor,
  required int fee,
  int? maxLevy,
  required List<({Uint8List spendTag, Uint8List cTilde})> inputs,
  required List<Map<String, dynamic>> vout,
  String magic = kMembershipMagic,
  Uint8List? memoH,
}) {
  // Absent maxLevy hashes as 0, matching the node's tx digest.
  // A posted fee is passed in when the node will store that fee as maxLevy.
  final levy = maxLevy ?? 0;
  final parts = <Uint8List>[
    Uint8List.fromList([
      ...utf8Bytes('shear-admit-v3-txd'),
      0x03,
      ...utf8Bytes(magic),
    ]),
    _lenPref(utf8Bytes(kind)),
    _u64le(anchor),
    _u64le(fee < 0 ? 0 : fee),
    _u64le(levy < 0 ? 0 : levy),
    _bytes32(memoH),
    _u32le(inputs.length),
  ];
  for (final row in inputs) {
    parts.add(_bytes32(row.spendTag));
    parts.add(_bytes32(row.cTilde));
  }
  parts.add(_u32le(vout.length));
  for (final o in vout) {
    final outKind = (o['kind'] as String?) ?? kind;
    final range = _asBytes(o['rangeProof']);
    final view = _asBytes(o['viewTag']);
    final publicKind = outKind == 'lock' || outKind == 'vote' || outKind == 'withdraw';
    var publicNanos = 0;
    if (publicKind) {
      final vp = o['valueProof'];
      final raw = vp is Map ? vp['v'] : o['nanos'];
      final units = tryU64Units(raw);
      if (units != null && units.bitLength <= 63) publicNanos = units.toInt();
    }
    final dest = _asBytes(o['dest20']);
    final destPref = dest.length >= 20 ? dest.sublist(0, 20) : Uint8List(0);
    parts.add(_lenPref(utf8Bytes(outKind)));
    parts.add(_bytes32(o['commit']));
    parts.add(_bytes32(o['admitPub']));
    parts.add(_bytes32(o['noteCommit']));
    parts.add(_bytes32(o['rEph']));
    parts.add(_lenPref(_asBytes(o['rCt'])));
    parts.add(_lenPref(_asBytes(o['memoCt'])));
    parts.add(Uint8List.fromList([view.isEmpty ? 0 : view[0]]));
    parts.add(Uint8List.fromList(sha256.convert(range).bytes));
    parts.add(_u64le(publicNanos));
    parts.add(_lenPref(destPref));
  }
  parts.add(_lenPref(Uint8List(0)));
  parts.add(_lenPref(Uint8List(0)));
  parts.add(_lenPref(Uint8List(0)));
  final flat = BytesBuilder(copy: false);
  for (final p in parts) {
    flat.add(p);
  }
  return Uint8List.fromList(sha256.convert(flat.toBytes()).bytes);
}

/// Interim testnet membership statement pending FS-1.
/// FS-1 replaces this function. Callers pass the returned bytes through.
Uint8List flowMembershipStatement({
  required int anchor,
  required Uint8List root,
  required int n,
  required Uint8List digest,
  String magic = kMembershipMagic,
}) {
  final mag = utf8Bytes(magic);
  final flat = BytesBuilder(copy: false);
  flat.add(utf8Bytes('shear-admit-v3'));
  flat.add(const [0x03]);
  flat.add(_u32le(mag.length));
  flat.add(mag);
  flat.add(_u64le(anchor));
  flat.add(_bytes32(root));
  flat.add(_u64le(n));
  flat.add(_bytes32(digest));
  final out = Uint8List.fromList(sha512.convert(flat.toBytes()).bytes);
  if (out.length != kMembershipStatementBytes) {
    throw StateError('membership_statement');
  }
  return out;
}

/// Blind one input. The tag and C̃ do not depend on the statement, so every
/// input can be bound before the statement is hashed.
({Uint8List spendTag, Uint8List cTilde, Uint8List t, int index}) bindMembershipInput({
  required Uint8List spendSeed,
  required Map<String, dynamic> spentNote,
  required List<Uint8List> pubs,
  Uint8List? t,
}) {
  final index = fluxsetIndexOf(pubs, spendSeed, spentNote);
  if (index < 0) throw StateError('not_in_fluxset');
  final blind = t ?? scalarBytes(randomScalar());
  if (blind.length != 32) throw StateError('membership_native_required');
  final x = admitScalarFromSeed(spendSeed, spentNote);
  final commit = spentNote['commit'];
  if (commit is! Uint8List || commit.length != 32) throw StateError('note');
  final cTilde = addBytes(commit, mulBytes(noteHBytes, blind));
  final tag = pointBytes(spendTagPoint(x, pointFrom(pubs[index])));
  return (spendTag: tag, cTilde: cTilde, t: blind, index: index);
}
