import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_identity.dart';

/// Same bytes as crypto/pack.js shear-enc-v1.
const encMagic = 'shear-enc-v1';
const encA = 1;
const encB = 2;
const encTx = 3;

Uint8List _u64le(int n) {
  final b = ByteData(8);
  b.setUint64(0, n, Endian.little);
  return b.buffer.asUint8List();
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
    out.add(_u64le((o['nanos'] as int?) ?? 0));
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

Uint8List spendPackDigest({
  required String from,
  required List<Map<String, dynamic>> vout,
  int height = 0,
  String? kind,
  List<Map<String, dynamic>>? vin,
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
        dest20 = Uint8List(20);
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
    final sealed = o['commit'] != null;
    vouts.add({
      'dest20': dest20,
      'nanos': sealed ? 0 : ((o['nanos'] as int?) ?? 0),
      'kind': _kindByte((o['kind'] as String?) ?? kind),
    });
  }
  return packDigest(packTx(vins: vins, vouts: vouts));
}

Uint8List spendMessage({
  required String from,
  required List<Map<String, dynamic>> vout,
  int height = 0,
  String? kind,
  List<Map<String, dynamic>>? vin,
}) {
  final digest = spendPackDigest(from: from, vout: vout, height: height, kind: kind, vin: vin);
  return Uint8List.fromList(sha256.convert([...utf8.encode('shear-spend-v1'), ...digest]).bytes);
}
