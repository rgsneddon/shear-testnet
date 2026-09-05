import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import 'shear_pack.dart';

const shewallName = 'shewall.bin';
const shewallEncKind = 'shear-shewall-bin-v1-enc';
/// Trailer after the v1 identity head: this user's dests + txs (wallet.dat analog).
const shewallArchiveTag = 0x02;
const shewallHeadLen = 13 + 32 + 20 + 16;

Uint8List packShewall({
  required Uint8List seed32,
  required Uint8List dest20,
  int spendableNanos = 0,
  int pendingNanos = 0,
  Map<String, dynamic>? archive,
}) {
  if (seed32.length != 32) throw ArgumentError('seed32');
  if (dest20.length != 20) throw ArgumentError('dest20');
  final head = <int>[
    ...utf8.encode(encMagic),
    0x77,
    ...seed32,
    ...dest20,
    ..._u64(spendableNanos),
    ..._u64(pendingNanos),
  ];
  if (archive == null) return Uint8List.fromList(head);
  final js = utf8.encode(jsonEncode(archive));
  final len = ByteData(4)..setUint32(0, js.length, Endian.little);
  return Uint8List.fromList([
    ...head,
    shewallArchiveTag,
    ...len.buffer.asUint8List(),
    ...js,
  ]);
}

Map<String, Uint8List> unpackShewall(Uint8List buf) {
  if (buf.length >= 1 && buf[0] == 0x7b) {
    throw const FormatException('json_refused');
  }
  final magic = utf8.encode(encMagic);
  if (buf.length < shewallHeadLen) throw const FormatException('not_shewall_bin');
  for (var i = 0; i < magic.length; i++) {
    if (buf[i] != magic[i]) throw const FormatException('not_shewall_bin');
  }
  if (buf[12] != 0x77) throw const FormatException('not_shewall_bin');
  return {
    'seed32': buf.sublist(13, 45),
    'dest20': buf.sublist(45, 65),
    'spendableNanos': buf.sublist(65, 73),
    'pendingNanos': buf.sublist(73, 81),
  };
}

/// This user's dests and txs from a 0.20 shewall.bin. Null on a v1-only file.
Map<String, dynamic>? unpackShewallArchive(Uint8List buf) {
  if (buf.length <= shewallHeadLen) return null;
  if (buf[shewallHeadLen] != shewallArchiveTag) return null;
  if (buf.length < shewallHeadLen + 1 + 4) return null;
  final len = ByteData.sublistView(buf, shewallHeadLen + 1, shewallHeadLen + 5)
      .getUint32(0, Endian.little);
  final start = shewallHeadLen + 5;
  if (len < 2 || start + len > buf.length) return null;
  final decoded = jsonDecode(utf8.decode(buf.sublist(start, start + len)));
  if (decoded is Map<String, dynamic>) return decoded;
  if (decoded is Map) return Map<String, dynamic>.from(decoded);
  return null;
}

int shewallU64(Uint8List le) {
  var n = 0;
  for (var i = 7; i >= 0; i--) {
    n = (n << 8) | le[i];
  }
  return n;
}

Future<Uint8List> sealShewallBin(Uint8List packed, String password) async {
  final salt = _rand(16);
  final nonce = _rand(12);
  final kdf = Pbkdf2(macAlgorithm: Hmac.sha256(), iterations: 100000, bits: 256);
  final key = await kdf.deriveKeyFromPassword(password: password, nonce: salt);
  final box = await AesGcm.with256bits().encrypt(packed, secretKey: key, nonce: nonce);
  return Uint8List.fromList([
    ...utf8.encode(shewallEncKind),
    ...salt,
    ...nonce,
    ...box.mac.bytes,
    ...box.cipherText,
  ]);
}

Future<Uint8List> openShewallBin(Uint8List env, String password) async {
  if (env.isNotEmpty && env[0] == 0x7b) throw const FormatException('json_refused');
  final prefix = utf8.encode(shewallEncKind);
  if (env.length < prefix.length + 16 + 12 + 16) {
    throw const FormatException('not_shewall_bin');
  }
  for (var i = 0; i < prefix.length; i++) {
    if (env[i] != prefix[i]) throw const FormatException('not_shewall_bin');
  }
  var o = prefix.length;
  final salt = env.sublist(o, o + 16);
  o += 16;
  final nonce = env.sublist(o, o + 12);
  o += 12;
  final mac = Mac(env.sublist(o, o + 16));
  o += 16;
  final ct = env.sublist(o);
  final kdf = Pbkdf2(macAlgorithm: Hmac.sha256(), iterations: 100000, bits: 256);
  final key = await kdf.deriveKeyFromPassword(password: password, nonce: salt);
  final clear = await AesGcm.with256bits().decrypt(
    SecretBox(ct, nonce: nonce, mac: mac),
    secretKey: key,
  );
  return Uint8List.fromList(clear);
}

Uint8List _u64(int n) {
  final b = ByteData(8);
  b.setUint64(0, n, Endian.little);
  return b.buffer.asUint8List();
}

Uint8List _rand(int n) {
  final r = Random.secure();
  return Uint8List.fromList(List<int>.generate(n, (_) => r.nextInt(256)));
}
