import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:ristretto255/ristretto255.dart';

import 'shear_sodium.dart';

export 'package:ristretto255/ristretto255.dart' show Element, Scalar;

ShearSodium? _sodium;
bool _sodiumTried = false;
ShearSodium? _native() {
  if (_sodiumTried) return _sodium;
  _sodiumTried = true;
  _sodium = ShearSodium.tryLoad();
  return _sodium;
}

/// True when prove uses libsodium ristretto (not the Dart BigInt field).
bool ristrettoNativeLoaded() => _native() != null;

final _rng = Random.secure();

Uint8List randomBytes(int n) {
  return Uint8List.fromList(List<int>.generate(n, (_) => _rng.nextInt(256)));
}

Uint8List concatBytes(List<Uint8List> parts) {
  final out = BytesBuilder();
  for (final p in parts) {
    out.add(p);
  }
  return out.toBytes();
}

Uint8List utf8Bytes(String s) => Uint8List.fromList(utf8.encode(s));

Uint8List i2osp(int value, int length) {
  final res = Uint8List(length);
  var v = value;
  for (var i = length - 1; i >= 0; i--) {
    res[i] = v & 0xff;
    v >>= 8;
  }
  return res;
}

Uint8List sha512Bytes(Uint8List msg) =>
    Uint8List.fromList(sha512.convert(msg).bytes);

/// RFC 9380 expand_message_xmd with SHA-512 (block 128, out 64).
Uint8List expandMessageXmd(Uint8List msg, List<int> dst, int lenInBytes) {
  var DST = Uint8List.fromList(dst);
  if (DST.length > 255) {
    DST = sha512Bytes(concatBytes([utf8Bytes('H2C-OVERSIZE-DST-'), DST]));
  }
  const bIn = 64;
  const rIn = 128;
  final ell = (lenInBytes + bIn - 1) ~/ bIn;
  final dstPrime = concatBytes([DST, i2osp(DST.length, 1)]);
  final zPad = Uint8List(rIn);
  final b0 = sha512Bytes(concatBytes([zPad, msg, i2osp(lenInBytes, 2), i2osp(0, 1), dstPrime]));
  final b = <Uint8List>[];
  b.add(sha512Bytes(concatBytes([b0, i2osp(1, 1), dstPrime])));
  for (var i = 1; i < ell; i++) {
    final x = Uint8List(b0.length);
    for (var j = 0; j < b0.length; j++) {
      x[j] = b0[j] ^ b[i - 1][j];
    }
    b.add(sha512Bytes(concatBytes([x, i2osp(i + 1, 1), dstPrime])));
  }
  return concatBytes(b).sublist(0, lenInBytes);
}

Element hashToRistretto(Uint8List msg, List<int> dst) {
  final xmd = expandMessageXmd(msg, dst, 64);
  final n = _native();
  if (n != null) return pointFrom(n.fromHash(xmd));
  final p = Element.newElement();
  p.fromUniformBytes(xmd);
  return p;
}

Element ristrettoG() => Element.base();

Element ristrettoZero() => Element.newIdentityElement();

Element cloneElement(Element p) {
  final o = Element.newElement();
  o.set(p);
  return o;
}

Element addEl(Element a, Element b) {
  final n = _native();
  if (n != null) return pointFrom(n.add(pointBytes(a), pointBytes(b)));
  final o = Element.newElement();
  o.add(a, b);
  return o;
}

Element subEl(Element a, Element b) {
  final n = _native();
  if (n != null) return pointFrom(n.sub(pointBytes(a), pointBytes(b)));
  final o = Element.newElement();
  o.subtract(a, b);
  return o;
}

Element negEl(Element a) {
  final o = Element.newElement();
  o.negate(a);
  return o;
}

Element mulEl(Element p, Scalar s) {
  final n = _native();
  if (n != null) return pointFrom(n.scalarmult(scalarBytes(s), pointBytes(p)));
  final o = Element.newElement();
  o.scalarMult(s, p);
  return o;
}

Element mulG(Scalar s) {
  final n = _native();
  if (n != null) return pointFrom(n.scalarmultBase(scalarBytes(s)));
  final o = Element.newElement();
  o.scalarBaseMult(s);
  return o;
}

/// a·A + b·G. Prove-only (verify stays constant-time).
Element varTimeDoubleBase(Scalar a, Element A, Scalar b) {
  final n = _native();
  if (n != null) {
    return pointFrom(n.add(n.scalarmult(scalarBytes(a), pointBytes(A)), n.scalarmultBase(scalarBytes(b))));
  }
  final o = Element.newElement();
  o.varTimeDoubleScalarBaseMult(a, A, b);
  return o;
}

/// s0·P0 + s1·P1. Prove-only.
Element varTimeMsm2(Scalar s0, Element p0, Scalar s1, Element p1) {
  final n = _native();
  if (n != null) {
    return pointFrom(n.add(
      n.scalarmult(scalarBytes(s0), pointBytes(p0)),
      n.scalarmult(scalarBytes(s1), pointBytes(p1)),
    ));
  }
  final o = Element.newElement();
  o.varTimeMultiScalarMult([s0, s1], [p0, p1]);
  return o;
}

Uint8List pointBytes(Element p) => Uint8List.fromList(p.encode());

/// Byte-in/byte-out group ops. Prefer libsodium; Dart Element is the fallback.
Uint8List mulBytes(Uint8List p, Uint8List s) {
  final n = _native();
  if (n != null) return n.scalarmult(s, p);
  return pointBytes(mulEl(pointFrom(p), scalarFromBytes(s)));
}

Uint8List mulGBytes(Uint8List s) {
  final n = _native();
  if (n != null) return n.scalarmultBase(s);
  return pointBytes(mulG(scalarFromBytes(s)));
}

Uint8List addBytes(Uint8List a, Uint8List b) {
  final n = _native();
  if (n != null) return n.add(a, b);
  return pointBytes(addEl(pointFrom(a), pointFrom(b)));
}

Uint8List subBytes(Uint8List a, Uint8List b) {
  final n = _native();
  if (n != null) return n.sub(a, b);
  return pointBytes(subEl(pointFrom(a), pointFrom(b)));
}

Uint8List fromHashBytes(Uint8List h64) {
  final n = _native();
  if (n != null) return n.fromHash(h64);
  final p = Element.newElement();
  p.fromUniformBytes(h64);
  return pointBytes(p);
}

Element pointFrom(Uint8List buf) {
  final p = Element.newElement();
  p.decode(buf);
  return p;
}

Scalar scalarZero() {
  final s = Scalar();
  s.zero();
  return s;
}

Scalar scalarFromUniform(Uint8List b64) {
  final s = Scalar();
  s.fromUniformBytes(b64);
  return s;
}

Scalar hashToScalar(List<Uint8List> parts) {
  return scalarFromUniform(sha512Bytes(concatBytes(parts)));
}

Scalar randomScalar() => hashToScalar([randomBytes(64)]);

Uint8List scalarBytes(Scalar s) => Uint8List.fromList(s.encode());

Scalar scalarFromBytes(Uint8List buf) {
  if (buf.length == 32) {
    final s = Scalar();
    s.decode(buf);
    return s;
  }
  return hashToScalar([buf]);
}

Scalar scalarAdd(Scalar a, Scalar b) {
  final s = Scalar();
  s.add(a, b);
  return s;
}

Scalar scalarSub(Scalar a, Scalar b) {
  final s = Scalar();
  s.subtract(a, b);
  return s;
}

Scalar scalarMul(Scalar a, Scalar b) {
  final s = Scalar();
  s.multiply(a, b);
  return s;
}

Scalar scalarFromInt(int n) {
  final b = Uint8List(32);
  var v = n;
  for (var i = 0; i < 8; i++) {
    b[i] = v & 0xff;
    v >>= 8;
  }
  return scalarFromBytes(b);
}

Scalar scalarFromBigShift(int bit) {
  final b = Uint8List(32);
  final byte = bit ~/ 8;
  b[byte] = 1 << (bit % 8);
  return scalarFromBytes(b);
}

bool scalarEq(Scalar a, Scalar b) => a.equal(b) == 1;

bool elementEq(Element a, Element b) => a.equal(b) == 1;
