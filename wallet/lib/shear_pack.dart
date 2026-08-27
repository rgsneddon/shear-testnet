import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

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
