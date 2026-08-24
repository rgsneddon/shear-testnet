import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

const shearHrp = 'shear';
const destHrp = 'shp';
/// Public-facing silent ID is she1 (HRP she). Never a dest.
const payHrp = 'she';
const _charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

class ShearIdentity {
  ShearIdentity({required this.seedHex, required this.address, required this.viewKey});

  final String seedHex;
  final String address;
  final String viewKey;

  Map<String, String> toJson() => {
        'seedHex': seedHex,
        'address': address,
        'viewKey': viewKey,
        'network': 'shear-testnet-v1',
      };

  static ShearIdentity fromJson(Map<String, dynamic> j) {
    return ShearIdentity(
      seedHex: j['seedHex'] as String,
      address: j['address'] as String,
      viewKey: j['viewKey'] as String,
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

bool isPaymentCode(String s) {
  final t = s.trim();
  if (isShearAddress(t) || isDestAddress(t)) return false;
  return bech32Hrp(t) == 'she' && _bech32BodyOk(t) && t.length >= 80;
}

bool isDestAddress(String s) {
  final t = s.trim();
  if (isShearAddress(t)) return false;
  if (bech32Hrp(t) == 'she') return false;
  return bech32Hrp(t) == 'shp' && _bech32BodyOk(t);
}

ShearIdentity createIdentity([Uint8List? seed]) {
  final s = seed ?? _randomBytes(32);
  final seedHex = _hex(s);
  final hash20 = sha256.convert(s).bytes.sublist(0, 20);
  final address = encodeShearAddress(Uint8List.fromList(hash20));
  final view = sha256.convert(utf8.encode('shear-view-v1') + s);
  return ShearIdentity(seedHex: seedHex, address: address, viewKey: _hex(view.bytes));
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
