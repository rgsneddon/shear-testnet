import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_x25519.dart';
import 'shear_ed25519.dart';

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
  /// Public-facing silent ID (she1). Full payment code (keys). Never a dest.
  final String paymentCode;

  String get paymentFingerprint {
    final d = decodePaymentCode(paymentCode);
    if (d != null && d['scanPub'] != null && d['spendPub'] != null) {
      return encodePaymentFingerprint(scanPub: d['scanPub']!, spendPub: d['spendPub']!);
    }
    return paymentCode;
  }

  Map<String, String> toJson() => {
        'seedHex': seedHex,
        'address': address,
        'viewKey': viewKey,
        'paymentCode': paymentCode,
        'network': 'shear-testnet-v2',
      };

  static ShearIdentity fromJson(Map<String, dynamic> j) {
    final address = j['address'] as String;
    final viewKey = j['viewKey'] as String;
    final hash20 = spendHashFromAddress(address);
    final stored = (j['paymentCode'] as String?)?.trim() ?? '';
    // she1 is perpetual. Never rotate a stored ID — even if derivation
    // changed. Only mint idx0 when this wallet has never had a she1.
    var code = stored;
    if (!isPaymentCode(code)) {
      final seedHex = j['seedHex'] as String?;
      if (seedHex != null && seedHex.length >= 64) {
        final seed = Uint8List.fromList([
          for (var i = 0; i < 32; i++)
            int.parse(seedHex.substring(i * 2, i * 2 + 2), radix: 16),
        ]);
        code = paymentCodeAtIndex(viewKey, ed25519PublicFromSeed(seed), 0) ?? '';
      }
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

/// Payable dest of a login. Payment codes are not payable.
String? payoutDest(String login) {
  final id = identityOfLogin(login);
  if (isDestAddress(id)) return id;
  return null;
}

String? aliasDestOfSilentId(String login) {
  final d = decodePaymentCode(identityOfLogin(login));
  if (d == null || d['hash20'] == null) return null;
  return encodeDestAddress(d['hash20']!);
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

const paymentCodeVersion = 1;

Map<String, Uint8List>? decodePaymentCode(String s) {
  final t = s.trim();
  if (isShearAddress(t) || bech32Hrp(t) != 'she' || !_bech32BodyOk(t)) return null;
  final p = decodeBech32Payload(t);
  if (p == null) return null;
  if (p.length == 65 && p[0] == paymentCodeVersion) {
    final scan = p.sublist(1, 33);
    final spend = p.sublist(33, 65);
    return {
      'scanPub': scan,
      'spendPub': spend,
      'hash20': paymentIdHash(scan, spend),
    };
  }
  if (p.length == 20) return {'hash20': p.sublist(0, 20)};
  return null;
}

bool isFullPaymentCode(String s) {
  final d = decodePaymentCode(s);
  return d != null && d['scanPub'] != null && d['spendPub'] != null;
}

bool isPaymentFingerprint(String s) {
  final d = decodePaymentCode(s);
  return d != null && d['hash20'] != null && d['scanPub'] == null;
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
  if (scanPub.length != 32 || spendPub.length != 32) {
    throw ArgumentError('silent code keys must be 32 bytes');
  }
  return encodeHrp(payHrp, Uint8List.fromList([paymentCodeVersion, ...scanPub, ...spendPub]));
}

String encodePaymentFingerprint({required Uint8List scanPub, required Uint8List spendPub}) {
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

String? paymentCodeAtIndex(String viewKey, Uint8List spendPub, int index) {
  if (index < 0) return null;
  final pub = spendPub.length == 32
      ? spendPub
      : Uint8List.fromList(sha256.convert(spendPub).bytes);
  if (pub.length != 32) return null;
  final scanPub = x25519PublicFromSeed(scanSeedFromView(viewKey, index));
  return encodePaymentCode(scanPub: scanPub, spendPub: pub);
}

String _hexOf(Uint8List b) => b.map((e) => e.toRadixString(16).padLeft(2, '0')).join();

/// 64-byte scan||spend hex. Proves dest hash20; she1 never on chain.
Uint8List spendMixAtIndex(Uint8List spendPub, int index) {
  return Uint8List.fromList(
    sha256.convert(utf8.encode('shear-spend-v1') + _asSpend(spendPub) + _u64leOpen(index)).bytes,
  );
}

String? silentDestFromCode(String fullCode, Uint8List ephSeed) {
  final parsed = decodePaymentCode(fullCode);
  if (parsed == null || parsed['scanPub'] == null || parsed['spendPub'] == null) return null;
  final shared = x25519Shared(ephSeed, parsed['scanPub']!);
  final oneTime = stealthTweakPub(parsed['spendPub']!, shared);
  return encodeDestAddress(destCommitFromSpendPub(oneTime));
}

Uint8List? silentSharedFromCode(String fullCode, Uint8List ephSeed) {
  final parsed = decodePaymentCode(fullCode);
  if (parsed == null || parsed['scanPub'] == null) return null;
  return x25519Shared(ephSeed, parsed['scanPub']!);
}

Map<String, dynamic>? recognizeSilentDest({
  required String viewKey,
  required Uint8List spendPub,
  required String dest,
  required Uint8List ephPub,
  int maxIndex = 16,
}) {
  for (var i = 0; i <= maxIndex; i++) {
    final shared = x25519Shared(scanSeedFromView(viewKey, i), ephPub);
    final oneTime = stealthTweakPub(spendPub, shared);
    final got = encodeDestAddress(destCommitFromSpendPub(oneTime));
    if (got == dest) {
      return {'dest': got, 'shared': shared, 'index': i, 'spendPub': oneTime};
    }
  }
  return null;
}

bool destMatchesSpendPub(String dest, Uint8List spendPub) {
  final want = hash20FromAddress(dest);
  if (want == null || want.length != 20) return false;
  final got = destCommitFromSpendPub(spendPub);
  for (var i = 0; i < 20; i++) {
    if (want[i] != got[i]) return false;
  }
  return true;
}

class SilentPay {
  SilentPay({required this.dest, required this.shared, required this.ephPub, required this.ephSeed});
  final String dest;
  final Uint8List shared;
  final Uint8List ephPub;
  final Uint8List ephSeed;
}

SilentPay? silentPay(String fullCode, [Uint8List? ephSeed]) {
  final seed = ephSeed ?? _randomBytes(32);
  final dest = silentDestFromCode(fullCode, seed);
  final shared = silentSharedFromCode(fullCode, seed);
  if (dest == null || shared == null) return null;
  return SilentPay(
    dest: dest,
    shared: shared,
    ephPub: x25519PublicFromSeed(seed),
    ephSeed: seed,
  );
}

String? freshStealthDest(String paymentCode) => silentPay(paymentCode)?.dest;

String destOpeningFromView(String viewKey, Uint8List spendHash20, [int index = 0]) {
  if (index < 0) return '';
  final scanPub = x25519PublicFromSeed(scanSeedFromView(viewKey, index));
  final idx = Uint8List(8);
  var x = index;
  for (var i = 0; i < 8; i++) {
    idx[i] = x & 0xff;
    x >>= 8;
  }
  final spend = Uint8List.fromList(
    sha256.convert(utf8.encode('shear-spend-v1') + _asSpend(spendHash20) + idx).bytes,
  );
  return _hexOf(Uint8List.fromList([...scanPub, ...spend]));
}

String indexedDestOpening(Uint8List spendHash20, Uint8List closure, int index) {
  if (index < 0) return '';
  return _hexOf(Uint8List.fromList([...spendHash20.sublist(0, 20), ...closure.sublist(0, 32), ..._u64leOpen(index)]));
}

Uint8List _u64leOpen(int n) {
  final o = Uint8List(8);
  var x = n;
  for (var i = 0; i < 8; i++) {
    o[i] = x & 0xff;
    x >>= 8;
  }
  return o;
}

final _ed25519SpkiPrefix = Uint8List.fromList([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);
final _ed25519Pkcs8Prefix = Uint8List.fromList([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

ShearIdentity createIdentity([Uint8List? seed]) {
  final s = seed ?? _randomBytes(32);
  final seedHex = _hex(s);
  final spendPub = ed25519PublicFromSeed(s);
  final spki = Uint8List.fromList([..._ed25519SpkiPrefix, ...spendPub]);
  final hash20 = Uint8List.fromList(sha256.convert(spki).bytes.sublist(0, 20));
  final address = encodeShearAddress(hash20);
  final view = sha256.convert(utf8.encode('shear-view-v1') + _ed25519Pkcs8Prefix + s);
  final viewKey = _hex(view.bytes);
  final paymentCode = paymentCodeAtIndex(viewKey, spendPub, 0)!;
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

String encodeDestAddress(Uint8List pubkeyHash20, [Uint8List? admitBase]) {
  if (pubkeyHash20.length != 20) {
    throw ArgumentError('spend hash must be 20 bytes');
  }
  if (admitBase != null) {
    if (admitBase.length != 32) {
      throw ArgumentError('admit base must be 32 bytes');
    }
    return encodeHrp(destHrp, Uint8List.fromList([...pubkeyHash20, ...admitBase]));
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
