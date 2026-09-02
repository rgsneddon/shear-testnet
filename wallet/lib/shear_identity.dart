import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_x25519.dart';

const shearHrp = 'shear';
const destHrp = 'ssa';
/// Public-facing silent ID is she1 (HRP she). Never a dest.
const payHrp = 'she';
const _charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

class ShearIdentity {
  ShearIdentity({
    required this.seedHex,
    required this.address,
    required this.viewKey,
    required this.paymentCode,
  });

  final String seedHex;
  final String address;
  final String viewKey;
  /// Public-facing silent ID (she1). Never a dest, never rest-frame.
  final String paymentCode;

  Map<String, String> toJson() => {
        'seedHex': seedHex,
        'address': address,
        'viewKey': viewKey,
        'paymentCode': paymentCode,
        'network': 'shear-testnet-v1',
      };

  static ShearIdentity fromJson(Map<String, dynamic> j) {
    final address = j['address'] as String;
    final viewKey = j['viewKey'] as String;
    final hash20 = spendHashFromAddress(address);
    final stored = (j['paymentCode'] as String?)?.trim() ?? '';
    // she1 is perpetual. Never rotate a stored ID — even if derivation
    // changed. Only mint idx0 when this wallet has never had a she1.
    var code = stored;
    if (!isPaymentCode(code) && stored.isEmpty && hash20 != null) {
      code = paymentCodeAtIndex(viewKey, hash20, 0) ?? '';
    }
    return ShearIdentity(
      seedHex: j['seedHex'] as String,
      address: address,
      viewKey: viewKey,
      paymentCode: code,
    );
  }
}

String bech32Hrp(String s) {
  final t = s.trim().toLowerCase();
  final one = t.indexOf('1');
  if (one < 1) return '';
  return t.substring(0, one);
}

bool _bech32BodyOk(String s) {
  final t = s.trim();
  final one = t.indexOf('1');
  if (one < 1) return false;
  final body = t.substring(one + 1).toLowerCase();
  if (body.length < 6) return false;
  return RegExp(r'^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$').hasMatch(body);
}

bool isShearAddress(String s) {
  final t = s.trim();
  return bech32Hrp(t) == 'shear' && _bech32BodyOk(t);
}

bool isPaymentCode(String s) => decodePaymentCode(s) != null;

bool isDestAddress(String s) {
  final t = s.trim();
  if (isShearAddress(t)) return false;
  if (bech32Hrp(t) == 'she') return false;
  return bech32Hrp(t) == 'ssa' && _bech32BodyOk(t);
}

String identityOfLogin(String login) => login.trim().split('.').first;

bool isMineLogin(String s) {
  final id = identityOfLogin(s);
  return isDestAddress(id) || isPaymentCode(id);
}

/// On-chain dest for a miner login. she1 pays ssa1 of the same 20 bytes.
String? payoutDest(String login) {
  final id = identityOfLogin(login);
  if (isDestAddress(id)) return id;
  final pay = decodePaymentCode(id);
  if (pay == null) return null;
  return encodeDestAddress(pay['hash20']!);
}

Uint8List? decodeBech32Payload(String address) {
  final raw = address.trim();
  final one = raw.indexOf('1');
  if (one < 1) return null;
  final body = raw.substring(one + 1).toLowerCase();
  final vals = <int>[];
  for (final ch in body.split('')) {
    final i = _charset.indexOf(ch);
    if (i < 0) return null;
    vals.add(i);
  }
  if (vals.length < 7) return null;
  final data = vals.sublist(0, vals.length - 6);
  final bytes = _convertBits(data.sublist(1), 5, 8, false);
  if (bytes.isEmpty) return null;
  return Uint8List.fromList(bytes);
}

Map<String, Uint8List>? decodePaymentCode(String s) {
  final t = s.trim();
  if (isShearAddress(t) || bech32Hrp(t) != 'she' || !_bech32BodyOk(t)) return null;
  final p = decodeBech32Payload(t);
  if (p == null || p.length != 20) return null;
  return {'hash20': p.sublist(0, 20)};
}

Uint8List paymentIdHash(Uint8List scanPub, Uint8List spendPub) {
  if (scanPub.length != 32 || spendPub.length != 32) {
    throw ArgumentError('silent code keys must be 32 bytes');
  }
  return Uint8List.fromList(
    sha256.convert([...utf8.encode('shear-she1-v2'), ...scanPub, ...spendPub]).bytes.sublist(0, 20),
  );
}

String encodePaymentCode({required Uint8List scanPub, required Uint8List spendPub}) {
  return encodeHrp(payHrp, paymentIdHash(scanPub, spendPub));
}

Uint8List scanSeedFromView(String viewKey, [int index = 0]) {
  final n = Uint8List(8);
  var x = index;
  for (var i = 0; i < 8; i++) {
    n[i] = x & 0xff;
    x >>= 8;
  }
  return Uint8List.fromList(sha256.convert(utf8.encode('shear-scan-v1') + utf8.encode(viewKey) + n).bytes);
}

Uint8List _asSpend(Uint8List h) {
  if (h.length == 32) return h;
  return Uint8List.fromList(sha256.convert(h).bytes);
}

String? paymentCodeAtIndex(String viewKey, Uint8List spendHash20, int index) {
  if (index < 0) return null;
  final scanPub = x25519PublicFromSeed(scanSeedFromView(viewKey, index));
  final idx = Uint8List(8);
  var x = index;
  for (var i = 0; i < 8; i++) {
    idx[i] = x & 0xff;
    x >>= 8;
  }
  final spend = Uint8List.fromList(sha256.convert(utf8.encode('shear-spend-v1') + _asSpend(spendHash20) + idx).bytes);
  return encodePaymentCode(scanPub: scanPub, spendPub: spend);
}

ShearIdentity createIdentity([Uint8List? seed]) {
  final s = seed ?? _randomBytes(32);
  final seedHex = _hex(s);
  final hash20 = Uint8List.fromList(sha256.convert(s).bytes.sublist(0, 20));
  final address = encodeShearAddress(hash20);
  final view = sha256.convert(utf8.encode('shear-view-v1') + s);
  final viewKey = _hex(view.bytes);
  final paymentCode = paymentCodeAtIndex(viewKey, hash20, 0)!;
  return ShearIdentity(seedHex: seedHex, address: address, viewKey: viewKey, paymentCode: paymentCode);
}

Uint8List? hash20FromAddress(String address) {
  final raw = address.trim();
  final one = raw.lastIndexOf('1');
  if (one < 1) return null;
  final body = raw.substring(one + 1).toLowerCase();
  final vals = <int>[];
  for (final ch in body.split('')) {
    final i = _charset.indexOf(ch);
    if (i < 0) return null;
    vals.add(i);
  }
  if (vals.length < 7) return null;
  final data = vals.sublist(0, vals.length - 6);
  final bytes = _convertBits(data.sublist(1), 5, 8, false);
  if (bytes.length < 20) return null;
  return Uint8List.fromList(bytes.sublist(0, 20));
}

Uint8List? spendHashFromAddress(String address) {
  if (!isShearAddress(address)) return null;
  return hash20FromAddress(address);
}

String encodeHrp(String hrp, Uint8List bytes) {
  if (bytes.isEmpty) {
    throw ArgumentError('empty payload');
  }
  final values = [0, ..._convertBits(bytes, 8, 5, true)];
  final checksum = _polymod([..._hrpExpand(hrp), ...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  final ret = [...values];
  for (var i = 0; i < 6; i++) {
    ret.add((checksum >> (5 * (5 - i))) & 31);
  }
  return '${hrp}1${ret.map((v) => _charset[v]).join()}';
}

String encodeShearAddress(Uint8List pubkeyHash20) => encodeHrp(shearHrp, pubkeyHash20);

/// Global Join vault dest. Not a user Continuum dest. Not The Reserve portal.
String canonicalJoinVaultDest() {
  final h = Uint8List.fromList(sha256.convert(utf8.encode('shear-join-v1-vault')).bytes.sublist(0, 20));
  return encodeDestAddress(h);
}

bool isJoinVaultDest(String addr) {
  final a = addr.trim();
  if (a.isEmpty) return false;
  if (a == canonicalJoinVaultDest()) return true;
  final got = hash20FromAddress(a);
  if (got == null || got.length < 20) return false;
  final want = sha256.convert(utf8.encode('shear-join-v1-vault')).bytes.sublist(0, 20);
  for (var i = 0; i < 20; i++) {
    if (got[i] != want[i]) return false;
  }
  return true;
}

String encodeDestAddress(Uint8List pubkeyHash20) {
  if (pubkeyHash20.length != 20) {
    throw ArgumentError('spend hash must be 20 bytes');
  }
  return encodeHrp(destHrp, pubkeyHash20);
}

List<int> _hrpExpand(String hrp) {
  final out = <int>[];
  for (final c in hrp.codeUnits) {
    out.add(c >> 5);
  }
  out.add(0);
  for (final c in hrp.codeUnits) {
    out.add(c & 31);
  }
  return out;
}

int _polymod(List<int> values) {
  const gens = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  var chk = 1;
  for (final v in values) {
    final b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (var i = 0; i < 5; i++) {
      if (((b >> i) & 1) != 0) chk ^= gens[i];
    }
  }
  return chk;
}

List<int> _convertBits(List<int> data, int from, int to, bool pad) {
  var acc = 0;
  var bits = 0;
  final maxv = (1 << to) - 1;
  final out = <int>[];
  for (final value in data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.add((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) out.add((acc << (to - bits)) & maxv);
  return out;
}

Uint8List _randomBytes(int n) {
  final r = Random.secure();
  return Uint8List.fromList(List<int>.generate(n, (_) => r.nextInt(256)));
}

String _hex(List<int> b) => b.map((e) => e.toRadixString(16).padLeft(2, '0')).join();
