import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

/// Ed25519 point/scalar helpers for stealth dests (RFC 8032).
final _p = (BigInt.one << 255) - BigInt.from(19);
final _l = BigInt.parse(
  '7237005577332262213973186563042994240857116359379907606001950938285454250989',
);
final _d = _mod(BigInt.from(-121665) * _inv(BigInt.from(121666)));
final _i = _powMod(BigInt.two, (_p - BigInt.one) >> 2);

BigInt _mod(BigInt x) {
  var r = x % _p;
  if (r.isNegative) r += _p;
  return r;
}

BigInt _inv(BigInt x) => _powMod(x, _p - BigInt.two);

BigInt _powMod(BigInt b, BigInt e) {
  var r = BigInt.one;
  var base = _mod(b);
  var exp = e;
  while (exp > BigInt.zero) {
    if (exp.isOdd) r = _mod(r * base);
    base = _mod(base * base);
    exp >>= 1;
  }
  return r;
}

BigInt _leToBig(Uint8List b) {
  var n = BigInt.zero;
  for (var i = 0; i < b.length; i++) {
    n |= BigInt.from(b[i]) << (8 * i);
  }
  return n;
}

Uint8List _bigToLe(BigInt n, int len) {
  final out = Uint8List(len);
  var x = n;
  for (var i = 0; i < len; i++) {
    out[i] = (x & BigInt.from(255)).toInt();
    x >>= 8;
  }
  return out;
}

class _Pt {
  _Pt(this.x, this.y, this.z, this.t);
  final BigInt x, y, z, t;
}

final _b = () {
  final y = _mod(BigInt.from(4) * _inv(BigInt.from(5)));
  final x = _recoverX(y, 0);
  return _Pt(x, y, BigInt.one, _mod(x * y));
}();

BigInt _recoverX(BigInt y, int sign) {
  final yy = _mod(y * y);
  final u = _mod(yy - BigInt.one);
  final v = _mod(_d * yy + BigInt.one);
  var x = _mod(u * _inv(v));
  x = _powMod(x, (_p + BigInt.from(3)) >> 3);
  if (_mod(x * x) != _mod(u * _inv(v))) x = _mod(x * _i);
  if (x.isOdd != (sign == 1)) x = _mod(-x);
  return x;
}

_Pt _add(_Pt a, _Pt b) {
  final A = _mod(a.x * b.x);
  final B = _mod(a.y * b.y);
  final C = _mod(_d * a.t * b.t);
  final D = _mod(a.z * b.z);
  final E = _mod((a.x + a.y) * (b.x + b.y) - A - B);
  final F = _mod(D - C);
  final G = _mod(D + C);
  final H = _mod(B - A);
  return _Pt(_mod(E * F), _mod(G * H), _mod(F * G), _mod(E * H));
}

_Pt _mul(_Pt p, BigInt n) {
  var r = _Pt(BigInt.zero, BigInt.one, BigInt.one, BigInt.zero);
  var q = p;
  var k = n;
  while (k > BigInt.zero) {
    if (k.isOdd) r = _add(r, q);
    q = _add(q, q);
    k >>= 1;
  }
  return r;
}

Uint8List _compress(_Pt p) {
  final zinv = _inv(p.z);
  final x = _mod(p.x * zinv);
  final y = _mod(p.y * zinv);
  final out = _bigToLe(y, 32);
  if (x.isOdd) out[31] |= 0x80;
  return out;
}

_Pt _decompress(Uint8List buf) {
  final s = Uint8List.fromList(buf);
  final sign = (s[31] >> 7) & 1;
  s[31] &= 0x7f;
  final y = _leToBig(s);
  final x = _recoverX(y, sign);
  return _Pt(x, y, BigInt.one, _mod(x * y));
}

Uint8List ed25519PublicFromSeed(Uint8List seed) {
  final h = sha512.convert(seed).bytes;
  var a = _leToBig(Uint8List.fromList(h.sublist(0, 32)));
  a &= (BigInt.one << 254) - BigInt.from(8);
  a |= BigInt.one << 254;
  return _compress(_mul(_b, a));
}

Uint8List stealthTweakPub(Uint8List longTermSpendPub, Uint8List shared) {
  final t = _leToBig(Uint8List.fromList(
        sha256.convert([...utf8.encode('shear-stealth-tweak-v1'), ...shared]).bytes,
      )) %
      _l;
  final p = _decompress(longTermSpendPub);
  return _compress(_add(p, _mul(_b, t)));
}

Uint8List destCommitFromSpendPub(Uint8List spendPub) {
  return Uint8List.fromList(
    sha256.convert([...utf8.encode('shear-silent-v1'), ...spendPub]).bytes.sublist(0, 20),
  );
}

Uint8List ed25519Sign(Uint8List seed, Uint8List message) {
  final h = sha512.convert(seed).bytes;
  var a = _leToBig(Uint8List.fromList(h.sublist(0, 32)));
  a &= (BigInt.one << 254) - BigInt.from(8);
  a |= BigInt.one << 254;
  final prefix = Uint8List.fromList(h.sublist(32));
  final pub = ed25519PublicFromSeed(seed);
  final rHash = sha512.convert([...prefix, ...message]).bytes;
  final r = _leToBig(Uint8List.fromList(rHash)) % _l;
  final rPoint = _compress(_mul(_b, r));
  final kHash = sha512.convert([...rPoint, ...pub, ...message]).bytes;
  final k = _leToBig(Uint8List.fromList(kHash)) % _l;
  final s = (r + k * a) % _l;
  return Uint8List.fromList([...rPoint, ..._bigToLe(s, 32)]);
}

bool ed25519Verify(Uint8List pub, Uint8List message, Uint8List sig) {
  if (pub.length != 32 || sig.length != 64) return false;
  try {
    final R = _decompress(sig.sublist(0, 32));
    final s = _leToBig(sig.sublist(32));
    if (s >= _l) return false;
    final A = _decompress(pub);
    final kHash = sha512.convert([...sig.sublist(0, 32), ...pub, ...message]).bytes;
    final k = _leToBig(Uint8List.fromList(kHash)) % _l;
    final left = _mul(_b, s);
    final right = _add(R, _mul(A, k));
    final lc = _compress(left);
    final rc = _compress(right);
    for (var i = 0; i < 32; i++) {
      if (lc[i] != rc[i]) return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

Uint8List stealthSign(Uint8List seed, Uint8List shared, Uint8List message) {
  final h = sha512.convert(seed).bytes;
  var a = _leToBig(Uint8List.fromList(h.sublist(0, 32)));
  a &= (BigInt.one << 254) - BigInt.from(8);
  a |= BigInt.one << 254;
  final prefix = Uint8List.fromList(h.sublist(32));
  final t = _leToBig(Uint8List.fromList(
        sha256.convert([...utf8.encode('shear-stealth-tweak-v1'), ...shared]).bytes,
      )) %
      _l;
  final scalar = (a + t) % _l;
  final pub = stealthTweakPub(ed25519PublicFromSeed(seed), shared);
  final rHash = sha512.convert([...prefix, ...message]).bytes;
  final r = _leToBig(Uint8List.fromList(rHash)) % _l;
  final rPoint = _compress(_mul(_b, r));
  final kHash = sha512.convert([...rPoint, ...pub, ...message]).bytes;
  final k = _leToBig(Uint8List.fromList(kHash)) % _l;
  final s = (r + k * scalar) % _l;
  return Uint8List.fromList([...rPoint, ..._bigToLe(s, 32)]);
}
