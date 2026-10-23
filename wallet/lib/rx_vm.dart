part of 'shear_hash_v3.dart';

// RandomX light VM (Shear configuration) and ShearHash-v3.

const int _l1Mask = 16376;
const int _l2Mask = 262136;
const int _l3Mask = 2097144;
const int _l3Mask64 = 2097088;
const int _lineAlign = 268435392;
const int _dynMant = (1 << 56) - 1;
const int _fsign = 1 << 63;
const int _fscal = 0x80f0000000000000;

const int _opIaddRs = 0;
const int _opIaddM = 1;
const int _opIsubR = 2;
const int _opIsubM = 3;
const int _opImulR = 4;
const int _opImulM = 5;
const int _opImulhR = 6;
const int _opImulhM = 7;
const int _opIsmulhR = 8;
const int _opIsmulhM = 9;
const int _opRcp = 10;
const int _opIneg = 11;
const int _opIxorR = 12;
const int _opIxorM = 13;
const int _opIror = 14;
const int _opIrol = 15;
const int _opIswap = 16;
const int _opFswap = 17;
const int _opFaddR = 18;
const int _opFaddM = 19;
const int _opFsubR = 20;
const int _opFsubM = 21;
const int _opFscal = 22;
const int _opFmul = 23;
const int _opFdiv = 24;
const int _opFsqrt = 25;
const int _opCbranch = 26;
const int _opCfround = 27;
const int _opIstore = 28;
const int _opNop = 29;

final Uint32List _enc0 = Uint32List.fromList(kLutEnc0);
final Uint32List _enc1 = Uint32List(256);
final Uint32List _enc2 = Uint32List(256);
final Uint32List _enc3 = Uint32List(256);
final Uint32List _dec0 = Uint32List.fromList(kLutDec0);
final Uint32List _dec1 = Uint32List(256);
final Uint32List _dec2 = Uint32List(256);
final Uint32List _dec3 = Uint32List(256);
bool _lutsReady = false;

void _luts() {
  if (_lutsReady) return;
  for (var i = 0; i < 256; i++) {
    _enc1[i] = _rotl32(_enc0[i], 8);
    _enc2[i] = _rotl32(_enc0[i], 16);
    _enc3[i] = _rotl32(_enc0[i], 24);
    _dec1[i] = _rotl32(_dec0[i], 8);
    _dec2[i] = _rotl32(_dec0[i], 16);
    _dec3[i] = _rotl32(_dec0[i], 24);
  }
  _lutsReady = true;
}

int _rotl32(int x, int n) {
  x &= _m32;
  return ((x << n) | (x >> (32 - n))) & _m32;
}

void _aes(Uint32List b, int i, int kx, int ky, int kz, int kw, bool enc) {
  final x = b[i], y = b[i + 1], z = b[i + 2], w = b[i + 3];
  final s0 = w, s1 = z, s2 = y, s3 = x;
  final t0 = enc ? _enc0 : _dec0;
  final t1 = enc ? _enc1 : _dec1;
  final t2 = enc ? _enc2 : _dec2;
  final t3 = enc ? _enc3 : _dec3;
  final int ww, zz, yy, xx;
  if (enc) {
    ww = t0[s0 & 255] ^ t1[(s3 >> 8) & 255] ^ t2[(s2 >> 16) & 255] ^ t3[_u32shr(s1, 24)];
    zz = t0[s1 & 255] ^ t1[(s0 >> 8) & 255] ^ t2[(s3 >> 16) & 255] ^ t3[_u32shr(s2, 24)];
    yy = t0[s2 & 255] ^ t1[(s1 >> 8) & 255] ^ t2[(s0 >> 16) & 255] ^ t3[_u32shr(s3, 24)];
    xx = t0[s3 & 255] ^ t1[(s2 >> 8) & 255] ^ t2[(s1 >> 16) & 255] ^ t3[_u32shr(s0, 24)];
  } else {
    ww = t0[s0 & 255] ^ t1[(s1 >> 8) & 255] ^ t2[(s2 >> 16) & 255] ^ t3[_u32shr(s3, 24)];
    zz = t0[s1 & 255] ^ t1[(s2 >> 8) & 255] ^ t2[(s3 >> 16) & 255] ^ t3[_u32shr(s0, 24)];
    yy = t0[s2 & 255] ^ t1[(s3 >> 8) & 255] ^ t2[(s0 >> 16) & 255] ^ t3[_u32shr(s1, 24)];
    xx = t0[s3 & 255] ^ t1[(s0 >> 8) & 255] ^ t2[(s1 >> 16) & 255] ^ t3[_u32shr(s2, 24)];
  }
  b[i] = xx ^ kx;
  b[i + 1] = yy ^ ky;
  b[i + 2] = zz ^ kz;
  b[i + 3] = ww ^ kw;
}

int _u32shr(int x, int n) => (x >> n) & 255;

// set_epi32(a,b,c,d) memory order d,c,b,a.
class Int32x4Key {
  final int x, y, z, w;
  const Int32x4Key(this.x, this.y, this.z, this.w);
}

const _k1_0 = Int32x4Key(0x6daca553, 0x62716609, 0xdbb5552b, 0xb4f44917);
const _k1_1 = Int32x4Key(0x6d7caf07, 0x846a710d, 0x1725d378, 0x0da1dc4e);
const _k1_2 = Int32x4Key(0x3f1262f1, 0x9f947ec6, 0xf4c0794f, 0x3e20e345);
const _k1_3 = Int32x4Key(0x6aef8135, 0xb1ba317c, 0x16314c88, 0x49169154);

const _k4_0 = Int32x4Key(0x6421aadd, 0xd1833ddb, 0x2f546d2b, 0x99e5d23f);
const _k4_1 = Int32x4Key(0xb20e3450, 0xb6913f55, 0x06f79d53, 0xa5dfcde5);
const _k4_2 = Int32x4Key(0x5c3ed904, 0x515e7baf, 0x0aa4679f, 0x171c02bf);
const _k4_3 = Int32x4Key(0x85623763, 0xe78f5d08, 0xcd673785, 0xd8ded291);
const _k4_4 = Int32x4Key(0xb5826f73, 0xe3d6a7a6, 0x3d518b6d, 0x229effb4);
const _k4_5 = Int32x4Key(0xc7566bf3, 0x9c10b3d9, 0xe9024d4e, 0xb272b7d2);
const _k4_6 = Int32x4Key(0xf273c9e7, 0xf765a38b, 0x2ba9660a, 0xf63befa7);
const _k4_7 = Int32x4Key(0x7a7cd609, 0x915839de, 0x0c06d1fd, 0xc0b0762d);

const _hx0 = Int32x4Key(0xf6fa8389, 0x8b24949f, 0x90dc56bf, 0x06890201);
const _hx1 = Int32x4Key(0x61b263d1, 0x51f4e03c, 0xee1043c6, 0xed18f99b);
const _hs0 = Int32x4Key(0x92b52c0d, 0x9fa856de, 0xcc82db47, 0xd7983aad);
const _hs1 = Int32x4Key(0x338d996e, 0x15c7b798, 0xf59e125a, 0xace78057);
const _hs2 = Int32x4Key(0x6a770017, 0xae62c7d0, 0x5079506b, 0xe8a07ce4);
const _hs3 = Int32x4Key(0x630a240c, 0x07ad828d, 0x79a10005, 0x7e994948);

void _fill1(Uint8List state, Uint8List out) {
  _luts();
  final st = Uint32List.view(state.buffer, state.offsetInBytes, 16);
  final buf = Uint32List.view(out.buffer, out.offsetInBytes, out.length >> 2);
  var o = 0;
  final n = out.length >> 2;
  while (o < n) {
    _aes(st, 0, _k1_0.x, _k1_0.y, _k1_0.z, _k1_0.w, false);
    _aes(st, 4, _k1_1.x, _k1_1.y, _k1_1.z, _k1_1.w, true);
    _aes(st, 8, _k1_2.x, _k1_2.y, _k1_2.z, _k1_2.w, false);
    _aes(st, 12, _k1_3.x, _k1_3.y, _k1_3.z, _k1_3.w, true);
    buf[o] = st[0];
    buf[o + 1] = st[1];
    buf[o + 2] = st[2];
    buf[o + 3] = st[3];
    buf[o + 4] = st[4];
    buf[o + 5] = st[5];
    buf[o + 6] = st[6];
    buf[o + 7] = st[7];
    buf[o + 8] = st[8];
    buf[o + 9] = st[9];
    buf[o + 10] = st[10];
    buf[o + 11] = st[11];
    buf[o + 12] = st[12];
    buf[o + 13] = st[13];
    buf[o + 14] = st[14];
    buf[o + 15] = st[15];
    o += 16;
  }
}

void _fill4(Uint8List state, Uint8List out) {
  _luts();
  final st = Uint32List(16);
  final src = Uint32List.view(state.buffer, state.offsetInBytes, 16);
  for (var i = 0; i < 16; i++) {
    st[i] = src[i];
  }
  final buf = Uint32List.view(out.buffer, out.offsetInBytes, out.length >> 2);
  var o = 0;
  final n = out.length >> 2;
  while (o < n) {
    _aes(st, 0, _k4_0.x, _k4_0.y, _k4_0.z, _k4_0.w, false);
    _aes(st, 4, _k4_0.x, _k4_0.y, _k4_0.z, _k4_0.w, true);
    _aes(st, 8, _k4_4.x, _k4_4.y, _k4_4.z, _k4_4.w, false);
    _aes(st, 12, _k4_4.x, _k4_4.y, _k4_4.z, _k4_4.w, true);
    _aes(st, 0, _k4_1.x, _k4_1.y, _k4_1.z, _k4_1.w, false);
    _aes(st, 4, _k4_1.x, _k4_1.y, _k4_1.z, _k4_1.w, true);
    _aes(st, 8, _k4_5.x, _k4_5.y, _k4_5.z, _k4_5.w, false);
    _aes(st, 12, _k4_5.x, _k4_5.y, _k4_5.z, _k4_5.w, true);
    _aes(st, 0, _k4_2.x, _k4_2.y, _k4_2.z, _k4_2.w, false);
    _aes(st, 4, _k4_2.x, _k4_2.y, _k4_2.z, _k4_2.w, true);
    _aes(st, 8, _k4_6.x, _k4_6.y, _k4_6.z, _k4_6.w, false);
    _aes(st, 12, _k4_6.x, _k4_6.y, _k4_6.z, _k4_6.w, true);
    _aes(st, 0, _k4_3.x, _k4_3.y, _k4_3.z, _k4_3.w, false);
    _aes(st, 4, _k4_3.x, _k4_3.y, _k4_3.z, _k4_3.w, true);
    _aes(st, 8, _k4_7.x, _k4_7.y, _k4_7.z, _k4_7.w, false);
    _aes(st, 12, _k4_7.x, _k4_7.y, _k4_7.z, _k4_7.w, true);
    for (var k = 0; k < 16; k++) {
      buf[o + k] = st[k];
    }
    o += 16;
  }
}

void _hash1(Uint8List input, Uint8List hash) {
  _luts();
  final inp = Uint32List.view(input.buffer, input.offsetInBytes, input.length >> 2);
  final st = Uint32List(16);
  void put(int lane, Int32x4Key k) {
    st[lane] = k.x;
    st[lane + 1] = k.y;
    st[lane + 2] = k.z;
    st[lane + 3] = k.w;
  }
  put(0, _hs0);
  put(4, _hs1);
  put(8, _hs2);
  put(12, _hs3);
  var o = 0;
  final n = input.length >> 2;
  while (o < n) {
    _aes(st, 0, inp[o], inp[o + 1], inp[o + 2], inp[o + 3], true);
    _aes(st, 4, inp[o + 4], inp[o + 5], inp[o + 6], inp[o + 7], false);
    _aes(st, 8, inp[o + 8], inp[o + 9], inp[o + 10], inp[o + 11], true);
    _aes(st, 12, inp[o + 12], inp[o + 13], inp[o + 14], inp[o + 15], false);
    o += 16;
  }
  _aes(st, 0, _hx0.x, _hx0.y, _hx0.z, _hx0.w, true);
  _aes(st, 4, _hx0.x, _hx0.y, _hx0.z, _hx0.w, false);
  _aes(st, 8, _hx0.x, _hx0.y, _hx0.z, _hx0.w, true);
  _aes(st, 12, _hx0.x, _hx0.y, _hx0.z, _hx0.w, false);
  _aes(st, 0, _hx1.x, _hx1.y, _hx1.z, _hx1.w, true);
  _aes(st, 4, _hx1.x, _hx1.y, _hx1.z, _hx1.w, false);
  _aes(st, 8, _hx1.x, _hx1.y, _hx1.z, _hx1.w, true);
  _aes(st, 12, _hx1.x, _hx1.y, _hx1.z, _hx1.w, false);
  for (var i = 0; i < 16; i++) {
    final w = st[i];
    final off = i * 4;
    hash[off] = w & 255;
    hash[off + 1] = (w >> 8) & 255;
    hash[off + 2] = (w >> 16) & 255;
    hash[off + 3] = (w >> 24) & 255;
  }
}

// --- soft float, FTZ+DAZ, mode 0 nearest, 1 down, 2 up, 3 toward zero ---

final Float64List _fscratch = Float64List(1);
final Int64List _iscratch = Int64List.view(_fscratch.buffer);

int _d2b(double d) {
  _fscratch[0] = d;
  return _iscratch[0];
}

double _b2d(int b) {
  _iscratch[0] = b;
  return _fscratch[0];
}

int _daz(int b) {
  if ((_shr(b, 52) & 0x7ff) == 0) return b & _fsign;
  return b;
}

int _ftz(int b) {
  if ((_shr(b, 52) & 0x7ff) == 0) return b & _fsign;
  return b;
}

int _nextUp(int b) {
  final exp = _shr(b, 52) & 0x7ff;
  if (exp == 0x7ff) return b;
  if (!b.isNegative) return b + 1;
  if (b == _fsign) return 0;
  return b - 1;
}

int _nextDown(int b) => _nextUp(b ^ _fsign) ^ _fsign;

int _roundDir(int hi, double lo, int mode) {
  if (lo == 0.0 || mode == 0) return hi;
  final above = lo > 0;
  if (mode == 2) return above ? _nextUp(hi) : hi;
  if (mode == 1) return above ? hi : _nextDown(hi);
  final neg = hi.isNegative;
  if (above) return neg ? _nextUp(hi) : hi;
  return neg ? hi : _nextDown(hi);
}

int _overflow(bool neg, int mode) {
  const maxFinite = 0x7fefffffffffffff;
  final inf = neg ? (_fsign | 0x7ff0000000000000) : 0x7ff0000000000000;
  final finite = neg ? (maxFinite | _fsign) : maxFinite;
  if (mode == 0) return inf;
  if (mode == 2) return neg ? finite : inf;
  if (mode == 1) return neg ? inf : finite;
  return finite;
}

int _sumZero(int a, int b, int mode) {
  final an = a.isNegative;
  final bn = b.isNegative;
  if (an && bn) return _fsign;
  if (mode == 1 && (an || bn)) return _fsign;
  return 0;
}

class _Dec {
  final int sign;
  final int exp;
  final int sig;
  final bool nan;
  final bool inf;
  const _Dec(this.sign, this.exp, this.sig, {this.nan = false, this.inf = false});
}

_Dec _dec(int bits) {
  final sign = bits.isNegative ? 1 : 0;
  final field = _shr(bits, 52) & 0x7ff;
  final frac = bits & ((1 << 52) - 1);
  if (field == 0) return _Dec(sign, 0, 0);
  if (field == 0x7ff) return _Dec(sign, 0, frac, nan: frac != 0, inf: frac == 0);
  return _Dec(sign, field - 1023, (1 << 52) | frac);
}

bool _up(int sign, int mode, bool guard, bool sticky, int lsb) {
  if (!guard && !sticky) return false;
  if (mode == 0) return guard && (sticky || lsb == 1);
  if (mode == 3) return false;
  if (mode == 2) return sign == 0;
  return sign == 1;
}

int _packSigned(int sign, BigInt mag, int lsbExp, int mode, {bool extraSticky = false}) {
  if (mag == BigInt.zero) return sign == 0 ? 0 : _fsign;
  final bits = mag.bitLength;
  var e = lsbExp;
  var sig = mag;
  if (bits > 53) {
    final drop = bits - 53;
    if (e + drop + 1075 < 1) return sign == 0 ? 0 : _fsign;
    final rest = sig & ((BigInt.one << drop) - BigInt.one);
    sig >>= drop;
    e += drop;
    final guard = (rest & (BigInt.one << (drop - 1))) != BigInt.zero;
    final stickyMask = drop <= 1 ? BigInt.zero : ((BigInt.one << (drop - 1)) - BigInt.one);
    final sticky = (rest & stickyMask) != BigInt.zero || extraSticky;
    if (_up(sign, mode, guard, sticky, sig.toInt() & 1)) {
      sig += BigInt.one;
      if (sig.bitLength > 53) {
        sig >>= 1;
        e += 1;
      }
    }
  } else {
    if (bits < 53) {
      final add = 53 - bits;
      sig <<= add;
      e -= add;
    }
    if (e + 1075 < 1) return sign == 0 ? 0 : _fsign;
    if (extraSticky && _up(sign, mode, false, true, sig.toInt() & 1)) {
      sig += BigInt.one;
      if (sig.bitLength > 53) {
        sig >>= 1;
        e += 1;
      }
    }
  }
  final field = e + 1075;
  if (field >= 0x7ff) return _overflow(sign == 1, mode);
  var out = (field << 52) | (sig.toInt() & ((1 << 52) - 1));
  if (sign != 0) out |= _fsign;
  return out;
}

int _faddExact(int a, int b, int mode) {
  final x = _dec(a);
  final y = _dec(b);
  if (x.nan || y.nan || x.inf || y.inf) return _ftz(_d2b(_b2d(a) + _b2d(b)));
  if (x.sig == 0 && y.sig == 0) return _sumZero(a, b, mode);
  var mx = BigInt.from(x.sig);
  var my = BigInt.from(y.sig);
  var ex = x.sig == 0 ? 0 : x.exp - 52;
  var ey = y.sig == 0 ? 0 : y.exp - 52;
  if (x.sig == 0) ex = ey;
  if (y.sig == 0) ey = ex;
  if (ex > ey) {
    mx <<= (ex - ey);
    ex = ey;
  } else if (ey > ex) {
    my <<= (ey - ex);
  }
  final BigInt mag;
  final int sign;
  if (x.sign == y.sign) {
    mag = mx + my;
    sign = x.sign;
  } else if (mx >= my) {
    mag = mx - my;
    sign = x.sign;
  } else {
    mag = my - mx;
    sign = y.sign;
  }
  if (mag == BigInt.zero) return _sumZero(a, b, mode);
  return _packSigned(sign, mag, ex, mode);
}

int _fadd(int a, int b, int mode) {
  a = _daz(a);
  b = _daz(b);
  if (mode == 0) {
    final da = _b2d(a);
    final db = _b2d(b);
    if (da.isNaN || db.isNaN || da.isInfinite || db.isInfinite) return _ftz(_d2b(da + db));
    final hiD = da + db;
    if (!hiD.isInfinite) {
      final hi = _d2b(hiD);
      final exp = _shr(hi, 52) & 0x7ff;
      if (exp >= 2) return hi;
    } else {
      return _overflow(hiD.isNegative, mode);
    }
  }
  return _faddExact(a, b, mode);
}

int _fsub(int a, int b, int mode) => _fadd(a, b ^ _fsign, mode);

int _fmul(int a, int b, int mode) {
  a = _daz(a);
  b = _daz(b);
  final da = _b2d(a);
  final db = _b2d(b);
  if (da.isNaN || db.isNaN || da.isInfinite || db.isInfinite || da == 0.0 || db == 0.0) {
    return _ftz(_d2b(da * db));
  }
  if (mode == 0) {
    final hi = _d2b(da * db);
    final exp = _shr(hi, 52) & 0x7ff;
    if (exp >= 2 && exp < 0x7ff) return hi;
  }
  final x = _dec(a);
  final y = _dec(b);
  final mag = BigInt.from(x.sig) * BigInt.from(y.sig);
  return _packSigned(x.sign ^ y.sign, mag, (x.exp - 52) + (y.exp - 52), mode);
}

int _fdiv(int a, int b, int mode) {
  a = _daz(a);
  b = _daz(b);
  final da = _b2d(a);
  final db = _b2d(b);
  if (da.isNaN || db.isNaN || da.isInfinite || db.isInfinite || db == 0.0 || da == 0.0) {
    return _ftz(_d2b(da / db));
  }
  if (mode == 0) {
    final hiD = da / db;
    if (!hiD.isInfinite) {
      final hi = _d2b(hiD);
      final exp = _shr(hi, 52) & 0x7ff;
      if (exp >= 2) return hi;
    }
  }
  final x = _dec(a);
  final y = _dec(b);
  const extra = 70;
  final num = BigInt.from(x.sig) << extra;
  final den = BigInt.from(y.sig);
  final mag = num ~/ den;
  final sticky = num != mag * den;
  return _packSigned(x.sign ^ y.sign, mag, (x.exp - 52) - (y.exp - 52) - extra, mode, extraSticky: sticky);
}

BigInt _isqrt(BigInt n) {
  if (n <= BigInt.one) return n;
  var x = BigInt.one << ((n.bitLength + 1) >> 1);
  for (;;) {
    final y = (x + n ~/ x) >> 1;
    if (y >= x) return x;
    x = y;
  }
}

int _fsqrt(int a, int mode) {
  a = _daz(a);
  final da = _b2d(a);
  if (da.isNaN || da.isInfinite || da <= 0.0) return _ftz(_d2b(_mathSqrt(da < 0 ? -1.0 : da)));
  if (mode == 0) {
    final hi = _d2b(_mathSqrt(da));
    final exp = _shr(hi, 52) & 0x7ff;
    if (exp >= 2) return hi;
  }
  final x = _dec(a);
  var exp = x.exp - 52;
  var mag = BigInt.from(x.sig);
  if (exp.isOdd) {
    mag <<= 1;
    exp -= 1;
  }
  const extra = 70;
  final scaled = mag << (2 * extra);
  final root = _isqrt(scaled);
  final sticky = scaled != root * root;
  return _packSigned(0, root, exp ~/ 2 - extra, mode, extraSticky: sticky);
}

double _sqrtPos(double d) => _mathSqrt(d);

// Imported at the bottom via a local wrapper so the part stays free of a
// second import. The library import is in shear_hash_v3.dart.
double _mathSqrt(double d) => _sqrtImpl(d);

int _rmode = 0;

int _staticExp(int entropy) {
  var exponent = 0x300;
  exponent |= _shr(entropy, 60) << 4;
  return exponent << 52;
}

int _floatMask(int entropy) => (entropy & ((1 << 22) - 1)) | _staticExp(entropy);

int _smallPos(int entropy) {
  final mantissa = entropy & ((1 << 52) - 1);
  final exponent = (_shr(entropy, 59) + 1023) & 0x7ff;
  return (exponent << 52) | mantissa;
}

class _Ibc {
  int type = _opNop;
  int dst = 0;
  int src = 0;
  bool zero = false;
  bool immSrc = false;
  int imm = 0;
  int mem = 0;
  int shift = 0;
  int target = 0;
  bool onE = false;
}

class _VmRegs {
  final List<int> r = List<int>.filled(8, 0);
  final List<int> f = List<int>.filled(8, 0);
  final List<int> e = List<int>.filled(8, 0);
  final List<int> a = List<int>.filled(8, 0);
  Uint8List bytes() {
    final out = Uint8List(256);
    var o = 0;
    for (final lane in [r, f, e, a]) {
      for (final w in lane) {
        _store64(out, o, w);
        o += 8;
      }
    }
    return out;
  }
}

int _ceilOp(int opcode) {
  const cuts = <int>[
    16, 23, 39, 46, 62, 66, 70, 71, 75, 76, 84, 86, 101, 106, 114, 116, 120,
    124, 140, 145, 161, 166, 172, 204, 208, 214, 239, 240, 256,
  ];
  for (var i = 0; i < cuts.length; i++) {
    if (opcode < cuts[i]) return i;
  }
  return _opNop;
}

List<_Ibc> _compile(Uint8List prog) {
  final code = List.generate(256, (_) => _Ibc());
  final used = List<int>.filled(8, -1);
  for (var i = 0; i < 256; i++) {
    final o = 128 + i * 8;
    final opcode = prog[o];
    final dstB = prog[o + 1];
    final srcB = prog[o + 2];
    final mod = prog[o + 3];
    final imm32 = prog[o + 4] | (prog[o + 5] << 8) | (prog[o + 6] << 16) | (prog[o + 7] << 24);
    final kind = _ceilOp(opcode);
    final ib = code[i];
    final dst = dstB & 7;
    final src = srcB & 7;
    final mem = (mod & 3) != 0 ? _l1Mask : _l2Mask;
    switch (kind) {
      case _opIaddRs:
        ib.type = _opIaddRs;
        ib.dst = dst;
        ib.src = src;
        ib.shift = (mod >> 2) & 3;
        ib.imm = dst == 5 ? _sign32(imm32) : 0;
        used[dst] = i;
      case _opIaddM:
      case _opIsubM:
      case _opImulM:
      case _opImulhM:
      case _opIsmulhM:
      case _opIxorM:
        ib.type = kind;
        ib.dst = dst;
        ib.imm = _sign32(imm32);
        if (src != dst) {
          ib.src = src;
          ib.mem = mem;
        } else {
          ib.zero = true;
          ib.mem = _l3Mask;
        }
        used[dst] = i;
      case _opIsubR:
      case _opImulR:
      case _opIxorR:
        ib.type = kind;
        ib.dst = dst;
        if (src != dst) {
          ib.src = src;
        } else {
          ib.immSrc = true;
          ib.imm = _sign32(imm32);
        }
        used[dst] = i;
      case _opImulhR:
      case _opIsmulhR:
        ib.type = kind;
        ib.dst = dst;
        ib.src = src;
        used[dst] = i;
      case _opRcp:
        if (!_pow2(imm32)) {
          ib.type = _opImulR;
          ib.dst = dst;
          ib.immSrc = true;
          ib.imm = reciprocal32(imm32);
          used[dst] = i;
        }
      case _opIneg:
        ib.type = _opIneg;
        ib.dst = dst;
        used[dst] = i;
      case _opIror:
      case _opIrol:
        ib.type = kind;
        ib.dst = dst;
        if (src != dst) {
          ib.src = src;
        } else {
          ib.immSrc = true;
          ib.imm = imm32;
        }
        used[dst] = i;
      case _opIswap:
        if (src != dst) {
          ib.type = _opIswap;
          ib.dst = dst;
          ib.src = src;
          used[dst] = i;
          used[src] = i;
        }
      case _opFswap:
        ib.type = _opFswap;
        ib.dst = dstB & 7;
        ib.onE = ib.dst >= 4;
        if (ib.onE) ib.dst -= 4;
      case _opFaddR:
      case _opFsubR:
        ib.type = kind;
        ib.dst = dstB & 3;
        ib.src = srcB & 3;
      case _opFaddM:
      case _opFsubM:
        ib.type = kind;
        ib.dst = dstB & 3;
        ib.src = src;
        ib.mem = mem;
        ib.imm = _sign32(imm32);
      case _opFscal:
        ib.type = _opFscal;
        ib.dst = dstB & 3;
      case _opFmul:
        ib.type = _opFmul;
        ib.dst = dstB & 3;
        ib.src = srcB & 3;
      case _opFdiv:
        ib.type = _opFdiv;
        ib.dst = dstB & 3;
        ib.src = src;
        ib.mem = mem;
        ib.imm = _sign32(imm32);
      case _opFsqrt:
        ib.type = _opFsqrt;
        ib.dst = dstB & 3;
      case _opCbranch:
        ib.type = _opCbranch;
        ib.dst = dst;
        ib.target = used[dst];
        final shift = (mod >> 4) + 8;
        var imm = _sign32(imm32) | (1 << shift);
        imm &= ~(1 << (shift - 1));
        ib.imm = imm;
        ib.mem = 255 << shift;
        for (var j = 0; j < 8; j++) {
          used[j] = i;
        }
      case _opCfround:
        ib.type = _opCfround;
        ib.src = src;
        ib.imm = imm32 & 63;
      case _opIstore:
        ib.type = _opIstore;
        ib.dst = dst;
        ib.src = src;
        ib.imm = _sign32(imm32);
        ib.mem = (mod >> 4) < 14 ? mem : _l3Mask;
      default:
        break;
    }
  }
  return code;
}

int _srcVal(_Ibc ib, List<int> r) {
  if (ib.immSrc) return ib.imm;
  if (ib.zero) return 0;
  return r[ib.src];
}

int _addr(_Ibc ib, List<int> r) => (_srcVal(ib, r) + ib.imm) & ib.mem;

int _cvtLo(Uint8List sp, int addr) => _d2b(_sign32(_load32(sp, addr)).toDouble());
int _cvtHi(Uint8List sp, int addr) => _d2b(_sign32(_load32(sp, addr + 4)).toDouble());

int _load32(Uint8List m, int off) =>
    m[off] | (m[off + 1] << 8) | (m[off + 2] << 16) | (m[off + 3] << 24);

void _exec(List<_Ibc> code, _VmRegs reg, Uint8List sp, int e0, int e1) {
  final r = reg.r;
  final f = reg.f;
  final e = reg.e;
  final a = reg.a;
  for (var pc = 0; pc < 256; pc++) {
    final ib = code[pc];
    switch (ib.type) {
      case _opIaddRs:
        r[ib.dst] += (r[ib.src] << ib.shift) + ib.imm;
      case _opIaddM:
        r[ib.dst] += _load64(sp, _addr(ib, r));
      case _opIsubR:
        r[ib.dst] -= _srcVal(ib, r);
      case _opIsubM:
        r[ib.dst] -= _load64(sp, _addr(ib, r));
      case _opImulR:
        r[ib.dst] *= _srcVal(ib, r);
      case _opImulM:
        r[ib.dst] *= _load64(sp, _addr(ib, r));
      case _opImulhR:
        r[ib.dst] = _mulh(r[ib.dst], r[ib.src]);
      case _opImulhM:
        r[ib.dst] = _mulh(r[ib.dst], _load64(sp, _addr(ib, r)));
      case _opIsmulhR:
        r[ib.dst] = _smulh(r[ib.dst], r[ib.src]);
      case _opIsmulhM:
        r[ib.dst] = _smulh(r[ib.dst], _load64(sp, _addr(ib, r)));
      case _opIneg:
        r[ib.dst] = ~r[ib.dst] + 1;
      case _opIxorR:
        r[ib.dst] ^= _srcVal(ib, r);
      case _opIxorM:
        r[ib.dst] ^= _load64(sp, _addr(ib, r));
      case _opIror:
        r[ib.dst] = _rotr(r[ib.dst], _srcVal(ib, r));
      case _opIrol:
        r[ib.dst] = _rotl(r[ib.dst], _srcVal(ib, r));
      case _opIswap:
        final tmp = r[ib.src];
        r[ib.src] = r[ib.dst];
        r[ib.dst] = tmp;
      case _opFswap:
        final lane = ib.onE ? e : f;
        final lo = lane[ib.dst * 2];
        lane[ib.dst * 2] = lane[ib.dst * 2 + 1];
        lane[ib.dst * 2 + 1] = lo;
      case _opFaddR:
        f[ib.dst * 2] = _fadd(f[ib.dst * 2], a[ib.src * 2], _rmode);
        f[ib.dst * 2 + 1] = _fadd(f[ib.dst * 2 + 1], a[ib.src * 2 + 1], _rmode);
      case _opFaddM:
        final am = _addr(ib, r);
        f[ib.dst * 2] = _fadd(f[ib.dst * 2], _cvtLo(sp, am), _rmode);
        f[ib.dst * 2 + 1] = _fadd(f[ib.dst * 2 + 1], _cvtHi(sp, am), _rmode);
      case _opFsubR:
        f[ib.dst * 2] = _fsub(f[ib.dst * 2], a[ib.src * 2], _rmode);
        f[ib.dst * 2 + 1] = _fsub(f[ib.dst * 2 + 1], a[ib.src * 2 + 1], _rmode);
      case _opFsubM:
        final sm = _addr(ib, r);
        f[ib.dst * 2] = _fsub(f[ib.dst * 2], _cvtLo(sp, sm), _rmode);
        f[ib.dst * 2 + 1] = _fsub(f[ib.dst * 2 + 1], _cvtHi(sp, sm), _rmode);
      case _opFscal:
        f[ib.dst * 2] ^= _fscal;
        f[ib.dst * 2 + 1] ^= _fscal;
      case _opFmul:
        e[ib.dst * 2] = _fmul(e[ib.dst * 2], a[ib.src * 2], _rmode);
        e[ib.dst * 2 + 1] = _fmul(e[ib.dst * 2 + 1], a[ib.src * 2 + 1], _rmode);
      case _opFdiv:
        final dm = _addr(ib, r);
        var lo = _cvtLo(sp, dm) & _dynMant | e0;
        var hi = _cvtHi(sp, dm) & _dynMant | e1;
        e[ib.dst * 2] = _fdiv(e[ib.dst * 2], lo, _rmode);
        e[ib.dst * 2 + 1] = _fdiv(e[ib.dst * 2 + 1], hi, _rmode);
      case _opFsqrt:
        e[ib.dst * 2] = _fsqrt(e[ib.dst * 2], _rmode);
        e[ib.dst * 2 + 1] = _fsqrt(e[ib.dst * 2 + 1], _rmode);
      case _opCbranch:
        r[ib.dst] += ib.imm;
        if ((r[ib.dst] & ib.mem) == 0) pc = ib.target;
      case _opCfround:
        _rmode = _rotr(r[ib.src], ib.imm) & 3;
      case _opIstore:
        _store64(sp, (r[ib.dst] + ib.imm) & ib.mem, r[ib.src]);
      default:
        break;
    }
  }
}

void _run(Uint8List seed, Uint8List scratch, RxLight light, _VmRegs reg) {
  final prog = Uint8List(2176);
  _fill4(seed, prog);
  final ent = List<int>.generate(16, (i) => _load64(prog, i * 8));
  for (var i = 0; i < 4; i++) {
    reg.a[i * 2] = _smallPos(ent[i * 2]);
    reg.a[i * 2 + 1] = _smallPos(ent[i * 2 + 1]);
  }
  var ma = ent[8] & _lineAlign;
  var mx = ent[10] & _m32;
  final ar = ent[12];
  final read0 = ar & 1;
  final read1 = 2 + (_shr(ar, 1) & 1);
  final read2 = 4 + (_shr(ar, 2) & 1);
  final read3 = 6 + (_shr(ar, 3) & 1);
  final datasetOffset = _umod(ent[13], 65537) * 64;
  final e0 = _floatMask(ent[14]);
  final e1 = _floatMask(ent[15]);
  final code = _compile(prog);
  for (var i = 0; i < 8; i++) {
    reg.r[i] = 0;
  }
  var sp0 = mx;
  var sp1 = ma;
  for (var ic = 0; ic < 2048; ic++) {
    final mix = reg.r[read0] ^ reg.r[read1];
    sp0 = (sp0 ^ mix) & _l3Mask64;
    sp1 = (sp1 ^ _shr(mix, 32)) & _l3Mask64;
    for (var i = 0; i < 8; i++) {
      reg.r[i] ^= _load64(scratch, sp0 + 8 * i);
    }
    for (var i = 0; i < 4; i++) {
      final a0 = sp1 + 8 * i;
      reg.f[i * 2] = _cvtLo(scratch, a0);
      reg.f[i * 2 + 1] = _cvtHi(scratch, a0);
      final a1 = sp1 + 8 * (4 + i);
      reg.e[i * 2] = _cvtLo(scratch, a1) & _dynMant | e0;
      reg.e[i * 2 + 1] = _cvtHi(scratch, a1) & _dynMant | e1;
    }
    _exec(code, reg, scratch, e0, e1);
    mx = (mx ^ reg.r[read2] ^ reg.r[read3]) & _lineAlign;
    light.xorItem(reg.r, (datasetOffset + ma) ~/ 64);
    final swap = mx;
    mx = ma;
    ma = swap;
    for (var i = 0; i < 8; i++) {
      _store64(scratch, sp1 + 8 * i, reg.r[i]);
    }
    for (var i = 0; i < 4; i++) {
      final lo = reg.f[i * 2] ^ reg.e[i * 2];
      final hi = reg.f[i * 2 + 1] ^ reg.e[i * 2 + 1];
      reg.f[i * 2] = lo;
      reg.f[i * 2 + 1] = hi;
      _store64(scratch, sp0 + 16 * i, lo);
      _store64(scratch, sp0 + 16 * i + 8, hi);
    }
    sp0 = 0;
    sp1 = 0;
  }
}

int _umod(int a, int m) {
  if (!a.isNegative) return a % m;
  return (BigInt.from(a).toUnsigned(64) % BigInt.from(m)).toInt();
}

Uint8List? _keyCache;
RxLight? _lightCache;

RxLight _lightFor(Uint8List key) {
  if (_keyCache != null && _lightCache != null && _eq(_keyCache!, key)) return _lightCache!;
  final mem = Uint8List(kRxCacheBytes);
  argon2dInto(mem, key);
  final light = RxLight(mem);
  light.initPrograms(key);
  _keyCache = Uint8List.fromList(key);
  _lightCache = light;
  return light;
}

bool _eq(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

Uint8List _shearKey(Uint8List header) {
  final buf = Uint8List(116);
  const personal = 'ShearHash-v3/key';
  for (var i = 0; i < 16; i++) {
    buf[i] = personal.codeUnitAt(i);
  }
  buf.setRange(16, 48, header.sublist(4, 36));
  buf.setRange(48, 80, header.sublist(68, 100));
  buf.setRange(80, 112, header.sublist(36, 68));
  buf.setRange(112, 116, header.sublist(108, 112));
  return Uint8List.sublistView(_shearSha512(buf), 0, 32);
}

/// RandomX key for a 128-byte header. First 32 bytes of the miner SHA-512.
Uint8List shearKeyV3(Uint8List header) => _shearKey(header);

/// ShearHash-v3 of a 128-byte block header. Pure Dart, no process.
Uint8List shearHashV3(Uint8List header) {
  final key = _shearKey(header);
  final light = _lightFor(key);
  final state = Uint8List.fromList(blake2bBytes(header, 64));
  final scratch = Uint8List(1 << 21);
  _fill1(state, scratch);
  _rmode = 0;
  final reg = _VmRegs();
  for (var chain = 0; chain < 7; chain++) {
    _run(state, scratch, light, reg);
    state.setRange(0, 64, blake2bBytes(reg.bytes(), 64));
  }
  _run(state, scratch, light, reg);
  final hashed = Uint8List(64);
  _hash1(scratch, hashed);
  for (var i = 0; i < 8; i++) {
    reg.a[i] = _load64(hashed, i * 8);
  }
  return blake2bBytes(reg.bytes(), 32);
}

// Placeholder so a missing sqrt import fails at the call site below.
double _sqrtImpl(double d) => math.sqrt(d);
