import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_identity.dart';
import 'shear_note.dart';

/// Same bytes as crypto/pack.js shear-enc-v1.
const encMagic = 'shear-enc-v1';
const encA = 1;
const encB = 2;
const encTx = 3;

Uint8List _u64leUnits(BigInt n) {
  if (n < BigInt.zero || n.bitLength > 64) throw ArgumentError('u64');
  final b = Uint8List(8);
  var v = n;
  final mask = BigInt.from(0xff);
  for (var i = 0; i < 8; i++) {
    b[i] = (v & mask).toInt();
    v >>= 8;
  }
  return b;
}

Uint8List _u64le(int n) {
  if (n < 0) throw ArgumentError('u64');
  return _u64leUnits(BigInt.from(n));
}

Uint8List packALeaf({required Uint8List dest20, int count = 0}) {
  if (dest20.length != 20) throw ArgumentError('dest20');
  return Uint8List.fromList([
    ...utf8.encode(encMagic),
    encA,
    ...dest20,
    ..._u64le(count),
  ]);
}

Uint8List packBLeaf({
  required Uint8List dest20,
  int unit = 0,
  int nonce = 0,
  Uint8List? memoH,
  String tag = '',
}) {
  if (dest20.length != 20) throw ArgumentError('dest20');
  final tag8 = Uint8List(8);
  final tb = utf8.encode(tag);
  tag8.setRange(0, tb.length > 8 ? 8 : tb.length, tb);
  final memo = memoH ?? Uint8List(32);
  if (memo.length != 32) throw ArgumentError('memoH');
  return Uint8List.fromList([
    ...utf8.encode(encMagic),
    encB,
    ...dest20,
    ..._u64le(unit),
    ..._u64le(nonce),
    ...memo,
    ...tag8,
  ]);
}

Uint8List packTx({
  int version = 1,
  List<Map<String, dynamic>> vins = const [],
  List<Map<String, dynamic>> vouts = const [],
  Uint8List? memoH,
  int bFlag = 0,
}) {
  final out = BytesBuilder();
  out.add(utf8.encode(encMagic));
  out.add([encTx, version & 0xff, vins.length & 0xff]);
  for (final v in vins) {
    final prev = v['prev'] as Uint8List;
    final dest = v['dest20'] as Uint8List;
    if (prev.length != 32 || dest.length != 20) throw ArgumentError('vin');
    out.add(prev);
    final idx = ByteData(4)..setUint32(0, (v['index'] as int?) ?? 0, Endian.little);
    out.add(idx.buffer.asUint8List());
    out.add(dest);
  }
  out.add([vouts.length & 0xff]);
  for (final o in vouts) {
    final dest = o['dest20'] as Uint8List;
    if (dest.length != 20) throw ArgumentError('vout');
    out.add(dest);
    out.add(_u64leUnits(tryU64Units(o['nanos']) ?? BigInt.zero));
    out.add([(o['kind'] as int?) ?? 0]);
  }
  final hasMemo = memoH != null && memoH.length == 32;
  out.add([hasMemo ? 1 : 0, bFlag & 0xff]);
  if (hasMemo) out.add(memoH);
  return out.toBytes();
}

Uint8List packDigest(Uint8List packed) {
  return Uint8List.fromList(sha256.convert(packed).bytes);
}

String packDigestHex(Uint8List packed) {
  return packDigest(packed).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

int _kindByte(String? kind) {
  switch (kind) {
    case 'hash':
      return 1;
    case 'pot':
      return 2;
    case 'finder-fee':
      return 3;
    case 'reserve-fee':
      return 4;
    case 'dummy':
      return 5;
    default:
      return 0;
  }
}

Uint8List _as32(dynamic v) {
  if (v is Uint8List && v.length == 32) return v;
  if (v is String && v.length == 64) {
    final out = Uint8List(32);
    for (var i = 0; i < 32; i++) {
      out[i] = int.parse(v.substring(i * 2, i * 2 + 2), radix: 16);
    }
    return out;
  }
  return Uint8List(32);
}

/// Nanos the pool hashes: valueProof.v when set, otherwise nanos.
BigInt claimedVoutUnits(Map<String, dynamic> o) {
  final vp = o['valueProof'];
  if (vp is Map) {
    final units = tryU64Units(vp['v']);
    if (units != null) return units;
  }
  return tryU64Units(o['nanos']) ?? BigInt.zero;
}

/// Nanos the pool hashes, when they fit in a Dart int. A wider u64 is not clamped into this view.
int claimedVoutNanos(Map<String, dynamic> o) {
  final units = claimedVoutUnits(o);
  if (units.bitLength > 63) return 0;
  return units.toInt();
}

Uint8List spendPackDigest({
  required String from,
  required List<Map<String, dynamic>> vout,
  int height = 0,
  String? kind,
  List<Map<String, dynamic>>? vin,
  int fee = 0,
}) {
  final from20 = hash20FromAddress(from) ?? Uint8List(20);
  final vins = <Map<String, dynamic>>[];
  if (vin != null && vin.isNotEmpty) {
    for (var i = 0; i < vin.length; i++) {
      final v = vin[i];
      final nc = v['noteCommit'];
      Uint8List dest20;
      if (nc is Uint8List && nc.length == 32) {
        dest20 = nc.sublist(0, 20);
      } else if (nc is String && nc.length == 64) {
        dest20 = _as32(nc).sublist(0, 20);
      } else {
        dest20 = _dest20Bytes(v['dest20']);
      }
      vins.add({
        'prev': _as32(v['prev']),
        'index': (v['index'] as int?) ?? i,
        'dest20': dest20,
      });
    }
  } else {
    vins.add({'prev': Uint8List(32), 'index': height, 'dest20': from20});
  }
  final vouts = <Map<String, dynamic>>[];
  for (final o in vout) {
    final nc = o['noteCommit'];
    Uint8List dest20;
    if (nc is Uint8List && nc.length == 32) {
      dest20 = nc.sublist(0, 20);
    } else if (nc is String && nc.length >= 40) {
      dest20 = _as32(nc).sublist(0, 20);
    } else {
      final addr = (o['address'] as String?) ?? '';
      dest20 = hash20FromAddress(addr) ?? Uint8List(20);
    }
    final k = (o['kind'] as String?) ?? kind ?? '';
    final publicNanos = k == 'lock' || k == 'vote' || k == 'withdraw' || k == 'vortice-register';
    final sealed = o['commit'] != null && !publicNanos;
    vouts.add({
      'dest20': dest20,
      'nanos': sealed ? BigInt.zero : claimedVoutUnits(o),
      'kind': _kindByte((o['kind'] as String?) ?? kind),
    });
  }
  final packed = packDigest(packTx(vins: vins, vouts: vouts));
  final top = kind ?? (vout.isNotEmpty ? vout.first['kind'] as String? : null) ?? '';
  if (top == 'lock' || top == 'vote' || top == 'withdraw') return packed;
  final flowed = flowAmtDigest(packed, [for (final o in vout) _amtCtBytes(o['amtCt'])]);
  if (top != 'b-spend') return flowed;
  return Uint8List.fromList(sha256.convert([...flowed, ..._canonicalFee(fee)]).bytes);
}

final spendAmtDst = utf8.encode('shear-spend-amt-v1');

/// Same bytes as crypto/spend.js flowAmtDigest: every output's amtCt, empty when absent.
Uint8List flowAmtDigest(Uint8List packed, List<Uint8List> amtCts) {
  final b = BytesBuilder()
    ..add(spendAmtDst)
    ..add(packed)
    ..add(_u32le(amtCts.length));
  for (final ct in amtCts) {
    b.add(_u32le(ct.length));
    b.add(ct);
  }
  return Uint8List.fromList(sha256.convert(b.toBytes()).bytes);
}

Uint8List _amtCtBytes(Object? v) {
  if (v is Uint8List) return v;
  if (v is List<int>) return Uint8List.fromList(v);
  if (v is String && v.length.isEven && RegExp(r'^[0-9a-fA-F]+$').hasMatch(v)) {
    return Uint8List.fromList([for (var i = 0; i < v.length; i += 2) int.parse(v.substring(i, i + 2), radix: 16)]);
  }
  return Uint8List(0);
}

Uint8List spendMessage({
  required String from,
  required List<Map<String, dynamic>> vout,
  int height = 0,
  String? kind,
  List<Map<String, dynamic>>? vin,
  int fee = 0,
}) {
  final digest = spendPackDigest(from: from, vout: vout, height: height, kind: kind, vin: vin, fee: fee);
  return Uint8List.fromList(sha256.convert([...utf8.encode('shear-spend-v1'), ...digest]).bytes);
}

/// Same portal id `crypto/reserve_vault.js` puts on a lock, vote, or withdraw.
String reservePortalId(String dest) {
  return sha256.convert([...utf8.encode('shear-portal-v1'), ...utf8.encode(dest)]).toString();
}

Uint8List _dest20Bytes(dynamic v) {
  if (v is Uint8List && v.length >= 20) return Uint8List.sublistView(v, 0, 20);
  if (v is List && v.length >= 20) {
    final out = Uint8List(20);
    for (var i = 0; i < 20; i++) {
      final n = v[i];
      out[i] = n is int ? (n & 0xff) : 0;
    }
    return out;
  }
  if (v is String) {
    final hex = v.startsWith('0x') || v.startsWith('0X') ? v.substring(2) : v;
    if (hex.length >= 40) {
      final out = Uint8List(20);
      for (var i = 0; i < 20; i++) {
        out[i] = int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16);
      }
      return out;
    }
  }
  return Uint8List(20);
}

Uint8List _u32le(int n) {
  final b = Uint8List(4);
  ByteData.sublistView(b).setUint32(0, n & 0xffffffff, Endian.little);
  return b;
}

Uint8List _i64le(int n) {
  final b = Uint8List(8);
  ByteData.sublistView(b).setInt64(0, n, Endian.little);
  return b;
}

Uint8List _lenPrefUtf8(String s) {
  final body = utf8.encode(s);
  return Uint8List.fromList([..._u32le(body.length), ...body]);
}

/// JS `canonicalFee`: 8-byte LE, or eight zeros when the fee is not a positive safe integer.
Uint8List _canonicalFee(int fee) {
  final v = fee > 0 && fee <= 9007199254740991 ? fee : 0;
  return _u64le(v);
}

/// JS `Math.floor(Number(raw))` when it is a safe integer. Otherwise 0, matching `i64le`.
int jsSafeInt(Object? raw) {
  if (raw is int) {
    if (raw > 9007199254740991 || raw < -9007199254740991) return 0;
    return raw;
  }
  if (raw is String) {
    final n = int.tryParse(raw.trim());
    if (n == null || n > 9007199254740991 || n < 0) return 0;
    return n;
  }
  if (raw is num) {
    if (!raw.isFinite) return 0;
    final n = raw.floor();
    if (n > 9007199254740991 || n < -9007199254740991) return 0;
    return n;
  }
  return 0;
}

/// Spend message the pool's `verifySpendSig` checks for a lock, vote, or withdraw.
/// Flow sends stay on [spendMessage]. This adds the portal, fee, and reserve suffix.
/// A withdraw also signs [id] and the 32-byte [withdrawNonce] directly.
Uint8List reserveSpendMessage({
  required String from,
  required List<Map<String, dynamic>> vout,
  required List<Map<String, dynamic>> vin,
  required String kind,
  required String portalId,
  required String payoutPortalId,
  required String programId,
  required String choice,
  required int fee,
  required int suffixNanos,
  Uint8List? commit,
  String id = '',
  Uint8List? withdrawNonce,
}) {
  final packed = spendPackDigest(from: from, vout: vout, kind: kind, vin: vin);
  final portal = portalId.toLowerCase();
  final payout = payoutPortalId.toLowerCase();
  final commitBytes = (commit != null && commit.length == 32) ? commit : Uint8List(0);
  final choiceBytes = kind == 'vote' ? choice : '';
  final chunks = <int>[
    ...packed,
    ...utf8.encode(portal),
    ...utf8.encode(payout),
    ..._canonicalFee(fee),
    ..._u32le(0),
    ...utf8.encode('reserveact1'),
    ..._lenPrefUtf8(kind),
    ..._lenPrefUtf8(portal),
    ..._lenPrefUtf8(payout),
    ..._lenPrefUtf8(programId),
    ..._lenPrefUtf8(choiceBytes),
    ..._i64le(suffixNanos),
    ...commitBytes,
  ];
  if (kind == 'withdraw') {
    final nonce = (withdrawNonce != null && withdrawNonce.length == 32)
        ? withdrawNonce
        : Uint8List(32);
    chunks.addAll(_lenPrefUtf8(id));
    chunks.addAll(nonce);
  }
  final digest = Uint8List.fromList(sha256.convert(chunks).bytes);
  return Uint8List.fromList(sha256.convert([...utf8.encode('shear-spend-v1'), ...digest]).bytes);
}
