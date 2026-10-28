import 'dart:math' as math;
import 'dart:typed_data';

import 'rx_aes_luts.dart';

part 'rx_superscalar.dart';
part 'rx_vm.dart';

/// Pure Dart ShearHash-v3 (RandomX light, Shear configuration).
/// Same digest as crypto/shear_hash.js. No process and no native code.

const int kRxArgonBlocks = 131072;
const int kRxArgonPasses = 3;
const int kRxProgramSize = 256;
const int kRxProgramIters = 2048;
const int kRxProgramCount = 8;
const int kRxScratchpad = 1 << 21;
const int kRxCacheBytes = kRxArgonBlocks * 1024;
const int _m32 = 0xFFFFFFFF;
const int _m64 = 0xFFFFFFFFFFFFFFFF;

int _u32(int x) => x & _m32;
int _u64(int x) => x;

/// Logical shift. Dart `>>` sign-extends, and `0xFFFFFFFFFFFFFFFF` is -1,
/// so every uint64 lives in the signed bit pattern.
int _shr(int x, int n) {
  n &= 63;
  if (n == 0) return x;
  return (x >> n) & ~(-1 << (64 - n));
}

int _rotr(int x, int n) {
  n &= 63;
  if (n == 0) return x;
  return _shr(x, n) | (x << (64 - n));
}

int _rotl(int x, int n) => _rotr(x, (64 - (n & 63)) & 63);

int _mulh(int a, int b) {
  final ah = _shr(a, 32), al = a & _m32, bh = _shr(b, 32), bl = b & _m32;
  final x00 = al * bl;
  final x01 = al * bh;
  final x10 = ah * bl;
  final x11 = ah * bh;
  final m1 = (x10 & _m32) + (x01 & _m32) + _shr(x00, 32);
  final m2 = _shr(x10, 32) + _shr(x01, 32) + (x11 & _m32) + _shr(m1, 32);
  final m3 = _shr(x11, 32) + _shr(m2, 32);
  return (m3 << 32) | (m2 & _m32);
}

int _smulh(int a, int b) {
  var hi = _mulh(a, b);
  if (a.isNegative) hi -= b;
  if (b.isNegative) hi -= a;
  return hi;
}

int _sign32(int x) {
  x &= _m32;
  return x >= 0x80000000 ? x | ~_m32 : x;
}

// --- Blake2b ---------------------------------------------------------------

const List<int> _b2iv = [
  0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
  0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179,
];

const List<int> _b2sigma = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
  7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
  9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
  2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
  12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
  13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
  6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
  10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
];

class _B2 {
  final List<int> h = List<int>.from(_b2iv);
  final Uint8List buf = Uint8List(128);
  int t0 = 0, t1 = 0, buflen = 0, outlen = 64, f0 = 0;
  _B2(int out) {
    outlen = out;
    final p = Uint8List(64);
    p[0] = out;
    p[2] = 1;
    p[3] = 1;
    for (var i = 0; i < 8; i++) {
      var w = 0;
      for (var b = 0; b < 8; b++) {
        w |= p[i * 8 + b] << (8 * b);
      }
      h[i] = _u64(h[i] ^ w);
    }
  }
}

void _b2compress(_B2 s, Uint8List block, int off) {
  final m = List<int>.filled(16, 0);
  for (var i = 0; i < 16; i++) {
    var w = 0;
    final o = off + i * 8;
    for (var b = 0; b < 8; b++) {
      w |= block[o + b] << (8 * b);
    }
    m[i] = w;
  }
  final v = List<int>.filled(16, 0);
  for (var i = 0; i < 8; i++) {
    v[i] = s.h[i];
    v[i + 8] = _b2iv[i];
  }
  v[12] = _u64(v[12] ^ s.t0);
  v[13] = _u64(v[13] ^ s.t1);
  // f[0] is set only on the last block. Caller xors it in via a flag on s.
  v[14] = _u64(v[14] ^ s.f0);
  void g(int r, int i, int a, int b, int c, int d) {
    final si = r * 16 + 2 * i;
    v[a] = _u64(v[a] + v[b] + m[_b2sigma[si]]);
    v[d] = _rotr(_u64(v[d] ^ v[a]), 32);
    v[c] = _u64(v[c] + v[d]);
    v[b] = _rotr(_u64(v[b] ^ v[c]), 24);
    v[a] = _u64(v[a] + v[b] + m[_b2sigma[si + 1]]);
    v[d] = _rotr(_u64(v[d] ^ v[a]), 16);
    v[c] = _u64(v[c] + v[d]);
    v[b] = _rotr(_u64(v[b] ^ v[c]), 63);
  }
  for (var r = 0; r < 12; r++) {
    g(r, 0, 0, 4, 8, 12);
    g(r, 1, 1, 5, 9, 13);
    g(r, 2, 2, 6, 10, 14);
    g(r, 3, 3, 7, 11, 15);
    g(r, 4, 0, 5, 10, 15);
    g(r, 5, 1, 6, 11, 12);
    g(r, 6, 2, 7, 8, 13);
    g(r, 7, 3, 4, 9, 14);
  }
  for (var i = 0; i < 8; i++) {
    s.h[i] = _u64(s.h[i] ^ v[i] ^ v[i + 8]);
  }
}

void _b2add(_B2 s, int n) {
  final lo = _u64(s.t0 + n);
  if (lo < s.t0) s.t1 = _u64(s.t1 + 1);
  s.t0 = lo;
}

Uint8List blake2bBytes(Uint8List input, int outlen) {
  final s = _B2(outlen);
  var off = 0;
  var len = input.length;
  if (s.buflen + len > 128) {
    final fill = 128 - s.buflen;
    s.buf.setRange(s.buflen, 128, input, off);
    _b2add(s, 128);
    _b2compress(s, s.buf, 0);
    s.buflen = 0;
    off += fill;
    len -= fill;
    while (len > 128) {
      _b2add(s, 128);
      _b2compress(s, input, off);
      off += 128;
      len -= 128;
    }
  }
  s.buf.setRange(s.buflen, s.buflen + len, input, off);
  s.buflen += len;
  _b2add(s, s.buflen);
  s.f0 = _m64;
  for (var i = s.buflen; i < 128; i++) {
    s.buf[i] = 0;
  }
  _b2compress(s, s.buf, 0);
  final out = Uint8List(outlen);
  for (var i = 0; i < outlen; i++) {
    out[i] = (s.h[i >> 3] >> (8 * (i & 7))) & 0xff;
  }
  return out;
}

Uint8List blake2bLong(Uint8List input, int outlen) {
  final prefix = Uint8List(4 + input.length);
  prefix[0] = outlen & 0xff;
  prefix[1] = (outlen >> 8) & 0xff;
  prefix[2] = (outlen >> 16) & 0xff;
  prefix[3] = (outlen >> 24) & 0xff;
  prefix.setRange(4, prefix.length, input);
  if (outlen <= 64) return blake2bBytes(prefix, outlen);
  var outBuf = blake2bBytes(prefix, 64);
  final out = Uint8List(outlen);
  out.setRange(0, 32, outBuf);
  var produced = 32;
  var left = outlen - 32;
  while (left > 64) {
    outBuf = blake2bBytes(outBuf, 64);
    out.setRange(produced, produced + 32, outBuf);
    produced += 32;
    left -= 32;
  }
  final tail = blake2bBytes(outBuf, left);
  out.setRange(produced, produced + left, tail);
  return out;
}

// --- Argon2d ---------------------------------------------------------------

void _mka(Uint32List b, int ai, int bi) {
  final ax = ai << 1, bx = bi << 1;
  final x0 = b[ax], x1 = b[ax + 1], y0 = b[bx], y1 = b[bx + 1];
  final xy = x0 * y0;
  final two = xy << 1;
  final sum0 = x0 + y0;
  final sum1 = x1 + y1 + (sum0 >> 32);
  final add0 = (sum0 & _m32) + (two & _m32);
  final add1 = sum1 + _shr(two, 32) + (add0 >> 32);
  b[ax] = add0 & _m32;
  b[ax + 1] = add1 & _m32;
}

void _rotrStore(Uint32List b, int di, int hi, int lo, int n) {
  final x = _rotr((hi << 32) | lo, n);
  final dx = di << 1;
  b[dx] = x & _m32;
  b[dx + 1] = _shr(x, 32);
}

void _g64(Uint32List r, int a, int b, int c, int d) {
  _mka(r, a, b);
  final ax = a << 1, bx = b << 1, cx = c << 1, dx = d << 1;
  _rotrStore(r, d, r[dx + 1] ^ r[ax + 1], r[dx] ^ r[ax], 32);
  _mka(r, c, d);
  _rotrStore(r, b, r[bx + 1] ^ r[cx + 1], r[bx] ^ r[cx], 24);
  _mka(r, a, b);
  _rotrStore(r, d, r[dx + 1] ^ r[ax + 1], r[dx] ^ r[ax], 16);
  _mka(r, c, d);
  _rotrStore(r, b, r[bx + 1] ^ r[cx + 1], r[bx] ^ r[cx], 63);
}

void argon2dInto(Uint8List memory, Uint8List password) {
  final words = Uint32List.view(memory.buffer, memory.offsetInBytes, memory.length >> 2);
  final salt = Uint8List.fromList('ShearHash-v3/rx'.codeUnits);
  final h0in = BytesBuilder(copy: false);
  void u32(int v) {
    h0in.add([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
  }
  u32(1);
  u32(0);
  u32(kRxArgonBlocks);
  u32(kRxArgonPasses);
  u32(0x13);
  u32(0);
  u32(password.length);
  h0in.add(password);
  u32(salt.length);
  h0in.add(salt);
  u32(0);
  u32(0);
  final h0 = blake2bBytes(h0in.toBytes(), 64);
  final seed = Uint8List(72);
  seed.setRange(0, 64, h0);
  for (final which in const [0, 1]) {
    seed[64] = which & 0xff;
    seed[65] = 0;
    seed[66] = 0;
    seed[67] = 0;
    seed[68] = 0;
    seed[69] = 0;
    seed[70] = 0;
    seed[71] = 0;
    final block = blake2bLong(seed, 1024);
    final base = which * 256;
    for (var i = 0; i < 128; i++) {
      var lo = 0, hi = 0;
      final o = i * 8;
      for (var b = 0; b < 4; b++) {
        lo |= block[o + b] << (8 * b);
        hi |= block[o + 4 + b] << (8 * b);
      }
      words[base + i * 2] = lo;
      words[base + i * 2 + 1] = hi;
    }
  }
  _argonFill(words);
}

void _argonFill(Uint32List words) {
  const segment = kRxArgonBlocks ~/ 4;
  final blockR = Uint32List(256);
  final tmp = Uint32List(256);
  for (var pass = 0; pass < kRxArgonPasses; pass++) {
    for (var slice = 0; slice < 4; slice++) {
      final start = (pass == 0 && slice == 0) ? 2 : 0;
      var curr = slice * segment + start;
      var prev = curr == 0 ? kRxArgonBlocks - 1 : curr - 1;
      for (var i = start; i < segment; i++, curr++, prev++) {
        if (curr % kRxArgonBlocks == 1) prev = curr - 1;
        final pseudo = (words[prev * 256 + 1] << 32) | words[prev * 256];
        final refLane = 0;
        final refIndex = _indexAlpha(
          pass: pass,
          slice: slice,
          index: i,
          segment: segment,
          lane: kRxArgonBlocks,
          pseudo: pseudo & _m32,
          sameLane: refLane == 0,
        );
        _fillBlockCorrect(words, prev * 256, refIndex * 256, curr * 256, pass != 0, blockR, tmp);
      }
    }
  }
}

int _indexAlpha({
  required int pass,
  required int slice,
  required int index,
  required int segment,
  required int lane,
  required int pseudo,
  required bool sameLane,
}) {
  int area;
  if (pass == 0) {
    if (slice == 0) {
      area = index - 1;
    } else if (sameLane) {
      area = slice * segment + index - 1;
    } else {
      area = slice * segment + (index == 0 ? -1 : 0);
    }
  } else if (sameLane) {
    area = lane - segment + index - 1;
  } else {
    area = lane - segment + (index == 0 ? -1 : 0);
  }
  area &= _m32;
  var rel = pseudo & _m32;
  rel = _shr(rel * rel, 32);
  rel = area - 1 - _shr(area * rel, 32);
  var start = 0;
  if (pass != 0) {
    start = slice == 3 ? 0 : (slice + 1) * segment;
  }
  final sum = start + rel;
  if (!sum.isNegative) return sum % lane;
  return (BigInt.from(sum).toUnsigned(64) % BigInt.from(lane)).toInt();
}

void _fillBlockCorrect(Uint32List mem, int prev, int ref, int next, bool withXor, Uint32List blockR, Uint32List tmp) {
  for (var i = 0; i < 256; i++) {
    final v = mem[prev + i] ^ mem[ref + i];
    blockR[i] = v;
    tmp[i] = withXor ? (v ^ mem[next + i]) : v;
  }
  for (var col = 0; col < 8; col++) {
    final z = col * 16;
    _blake16(blockR, [
      z, z + 1, z + 2, z + 3, z + 4, z + 5, z + 6, z + 7,
      z + 8, z + 9, z + 10, z + 11, z + 12, z + 13, z + 14, z + 15,
    ]);
  }
  for (var i = 0; i < 8; i++) {
    final o = 2 * i;
    _blake16(blockR, [
      o, o + 1, o + 16, o + 17, o + 32, o + 33, o + 48, o + 49,
      o + 64, o + 65, o + 80, o + 81, o + 96, o + 97, o + 112, o + 113,
    ]);
  }
  for (var i = 0; i < 256; i++) {
    mem[next + i] = tmp[i] ^ blockR[i];
  }
}

void _blake16(Uint32List r, List<int> v) {
  _g64(r, v[0], v[4], v[8], v[12]);
  _g64(r, v[1], v[5], v[9], v[13]);
  _g64(r, v[2], v[6], v[10], v[14]);
  _g64(r, v[3], v[7], v[11], v[15]);
  _g64(r, v[0], v[5], v[10], v[15]);
  _g64(r, v[1], v[6], v[11], v[12]);
  _g64(r, v[2], v[7], v[8], v[13]);
  _g64(r, v[3], v[4], v[9], v[14]);
}

// FIPS 180-4 SHA-512, as sheark-miner/src/sha512.c (R40, 28 Oct: K[53] was
// mistyped there and here until the v12/mainnet genesis). The key must follow the miner.
const List<int> _sha512k = [
  0x428a2f98d728ae22, 0x7137449123ef65cd, 0xb5c0fbcfec4d3b2f, 0xe9b5dba58189dbbc,
  0x3956c25bf348b538, 0x59f111f1b605d019, 0x923f82a4af194f9b, 0xab1c5ed5da6d8118,
  0xd807aa98a3030242, 0x12835b0145706fbe, 0x243185be4ee4b28c, 0x550c7dc3d5ffb4e2,
  0x72be5d74f27b896f, 0x80deb1fe3b1696b1, 0x9bdc06a725c71235, 0xc19bf174cf692694,
  0xe49b69c19ef14ad2, 0xefbe4786384f25e3, 0x0fc19dc68b8cd5b5, 0x240ca1cc77ac9c65,
  0x2de92c6f592b0275, 0x4a7484aa6ea6e483, 0x5cb0a9dcbd41fbd4, 0x76f988da831153b5,
  0x983e5152ee66dfab, 0xa831c66d2db43210, 0xb00327c898fb213f, 0xbf597fc7beef0ee4,
  0xc6e00bf33da88fc2, 0xd5a79147930aa725, 0x06ca6351e003826f, 0x142929670a0e6e70,
  0x27b70a8546d22ffc, 0x2e1b21385c26c926, 0x4d2c6dfc5ac42aed, 0x53380d139d95b3df,
  0x650a73548baf63de, 0x766a0abb3c77b2a8, 0x81c2c92e47edaee6, 0x92722c851482353b,
  0xa2bfe8a14cf10364, 0xa81a664bbc423001, 0xc24b8b70d0f89791, 0xc76c51a30654be30,
  0xd192e819d6ef5218, 0xd69906245565a910, 0xf40e35855771202a, 0x106aa07032bbd1b8,
  0x19a4c116b8d2d0c8, 0x1e376c085141ab53, 0x2748774cdf8eeb99, 0x34b0bcb5e19b48a8,
  0x391c0cb3c5c95a63, 0x4ed8aa4ae3418acb, 0x5b9cca4f7763e373, 0x682e6ff3d6b2b8a3,
  0x748f82ee5defb2fc, 0x78a5636f43172f60, 0x84c87814a1f0ab72, 0x8cc702081a6439ec,
  0x90befffa23631e28, 0xa4506cebde82bde9, 0xbef9a3f7b2c67915, 0xc67178f2e372532b,
  0xca273eceea26619c, 0xd186b8c721c0c207, 0xeada7dd6cde0eb1e, 0xf57d4f7fee6ed178,
  0x06f067aa72176fba, 0x0a637dc5a2c898a6, 0x113f9804bef90dae, 0x1b710b35131c471b,
  0x28db77f523047d84, 0x32caab7b40c72493, 0x3c9ebe0a15c9bebc, 0x431d67c49c100d4c,
  0x4cc5d4becb3e42b6, 0x597f299cfc657e2a, 0x5fcb6fab3ad6faec, 0x6c44198c4a475817,
];

int _loadBe64(Uint8List p, int o) {
  var v = 0;
  for (var i = 0; i < 8; i++) {
    v = (v << 8) | p[o + i];
  }
  return v;
}

void _storeBe64(Uint8List p, int o, int v) {
  for (var i = 7; i >= 0; i--) {
    p[o + i] = v & 0xff;
    v = _shr(v, 8);
  }
}

void _sha512Compress(List<int> s, Uint8List block, int off) {
  final w = List<int>.filled(80, 0);
  for (var i = 0; i < 16; i++) {
    w[i] = _loadBe64(block, off + i * 8);
  }
  for (var i = 16; i < 80; i++) {
    final s0 = _rotr(w[i - 15], 1) ^ _rotr(w[i - 15], 8) ^ _shr(w[i - 15], 7);
    final s1 = _rotr(w[i - 2], 19) ^ _rotr(w[i - 2], 61) ^ _shr(w[i - 2], 6);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  var a = s[0], b = s[1], c = s[2], d = s[3];
  var e = s[4], f = s[5], g = s[6], h = s[7];
  for (var i = 0; i < 80; i++) {
    final s1 = _rotr(e, 14) ^ _rotr(e, 18) ^ _rotr(e, 41);
    final ch = (e & f) ^ (~e & g);
    final t1 = h + s1 + ch + _sha512k[i] + w[i];
    final s0 = _rotr(a, 28) ^ _rotr(a, 34) ^ _rotr(a, 39);
    final maj = (a & b) ^ (a & c) ^ (b & c);
    final t2 = s0 + maj;
    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  s[0] += a;
  s[1] += b;
  s[2] += c;
  s[3] += d;
  s[4] += e;
  s[5] += f;
  s[6] += g;
  s[7] += h;
}

Uint8List _shearSha512(Uint8List msg) {
  final s = <int>[
    0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
    0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179,
  ];
  var n = msg.length;
  var p = 0;
  while (n >= 128) {
    _sha512Compress(s, msg, p);
    p += 128;
    n -= 128;
  }
  final block = Uint8List(128);
  block.setRange(0, n, msg, p);
  block[n] = 0x80;
  if (n >= 112) {
    _sha512Compress(s, block, 0);
    block.fillRange(0, 128, 0);
  }
  _storeBe64(block, 120, msg.length * 8);
  _sha512Compress(s, block, 0);
  final out = Uint8List(64);
  for (var i = 0; i < 8; i++) {
    _storeBe64(out, i * 8, s[i]);
  }
  return out;
}
