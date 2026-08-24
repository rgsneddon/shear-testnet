import 'dart:typed_data';

/// RFC 7748 X25519 base-point public key from a 32-byte seed (matches Node crypto).
Uint8List x25519PublicFromSeed(Uint8List secret32) {
  if (secret32.length != 32) {
    throw ArgumentError('x25519 seed must be 32 bytes');
  }
  final e = Uint8List.fromList(secret32);
  e[0] &= 248;
  e[31] &= 127;
  e[31] |= 64;
  final p = (BigInt.one << 255) - BigInt.from(19);
  BigInt a(BigInt v) {
    var x = v % p;
    if (x.isNegative) x += p;
    return x;
  }

  BigInt x1 = BigInt.from(9);
  BigInt x2 = BigInt.one;
  BigInt z2 = BigInt.zero;
  BigInt x3 = x1;
  BigInt z3 = BigInt.one;
  var swap = 0;
  for (var t = 254; t >= 0; t--) {
    final kt = (e[t >> 3] >> (t & 7)) & 1;
    swap ^= kt;
    if (swap == 1) {
      var tmp = x2;
      x2 = x3;
      x3 = tmp;
      tmp = z2;
      z2 = z3;
      z3 = tmp;
    }
    swap = kt;
    final a2 = a(x2 + z2);
    final aa = a(a2 * a2);
    final b = a(x2 - z2);
    final bb = a(b * b);
    final e2 = a(aa - bb);
    final c = a(x3 + z3);
    final d = a(x3 - z3);
    final da = a(d * a2);
    final cb = a(c * b);
    x3 = a((da + cb) * (da + cb));
    z3 = a(x1 * (da - cb) * (da - cb));
    x2 = a(aa * bb);
    z2 = a(e2 * (aa + BigInt.from(121665) * e2));
  }
  if (swap == 1) {
    final tmp = x2;
    x2 = x3;
    x3 = tmp;
    final tmpz = z2;
    z2 = z3;
    z3 = tmpz;
  }
  final u = a(x2 * z2.modPow(p - BigInt.two, p));
  final out = Uint8List(32);
  var x = u;
  for (var i = 0; i < 32; i++) {
    out[i] = (x & BigInt.from(0xff)).toInt();
    x >>= 8;
  }
  return out;
}
