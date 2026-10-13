import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

/// Native prove for the interim testnet membership statement pending FS-1.
/// Android 64-bit has no node binary and no temp file. This loads
/// libshear_admit and calls the C entry. FS-1 replaces the statement bytes;
/// the call keeps taking those bytes.
const int kNativeMembershipProofCap = 43490;
const int kNativeRangeProofCap = 16384;

final class MembershipNative {
  MembershipNative._(DynamicLibrary lib)
      : _prove = lib.lookupFunction<
            Int32 Function(
              Pointer<Uint8>,
              Pointer<Uint8>,
              Pointer<Uint8>,
              Pointer<Uint8>,
              Uint32,
              Pointer<Uint8>,
              Pointer<Uint8>,
              Uint32,
              Pointer<Uint8>,
              Uint32,
              Pointer<Uint8>,
              Pointer<Uint8>,
              Pointer<Uint32>,
            ),
            int Function(
              Pointer<Uint8>,
              Pointer<Uint8>,
              Pointer<Uint8>,
              Pointer<Uint8>,
              int,
              Pointer<Uint8>,
              Pointer<Uint8>,
              int,
              Pointer<Uint8>,
              int,
              Pointer<Uint8>,
              Pointer<Uint8>,
              Pointer<Uint32>,
            )>('shear_admit_prove_v3'),
        _root = lib.lookupFunction<
            Int32 Function(Pointer<Uint8>, Pointer<Uint8>, Uint32, Pointer<Uint8>),
            int Function(Pointer<Uint8>, Pointer<Uint8>, int, Pointer<Uint8>)>(
          'shear_admit_jroot_point',
        ),
        _range = lib.lookupFunction<
            Int32 Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint32>),
            int Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint32>)>(
          'shear_range_prove_le',
        ),
        _bind = lib.lookupFunction<
            Int32 Function(
              Pointer<Uint8>,
              Pointer<Uint8>,
              Pointer<Uint8>,
              Pointer<Uint8>,
              Pointer<Uint8>,
              Pointer<Uint8>,
            ),
            int Function(
              Pointer<Uint8>,
              Pointer<Uint8>,
              Pointer<Uint8>,
              Pointer<Uint8>,
              Pointer<Uint8>,
              Pointer<Uint8>,
            )>('shear_admit_bind_input');

  final int Function(
    Pointer<Uint8>,
    Pointer<Uint8>,
    Pointer<Uint8>,
    Pointer<Uint8>,
    int,
    Pointer<Uint8>,
    Pointer<Uint8>,
    int,
    Pointer<Uint8>,
    int,
    Pointer<Uint8>,
    Pointer<Uint8>,
    Pointer<Uint32>,
  ) _prove;
  final int Function(Pointer<Uint8>, Pointer<Uint8>, int, Pointer<Uint8>) _root;
  final int Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint32>) _range;
  final int Function(
    Pointer<Uint8>,
    Pointer<Uint8>,
    Pointer<Uint8>,
    Pointer<Uint8>,
    Pointer<Uint8>,
    Pointer<Uint8>,
  ) _bind;

  static MembershipNative? _cached;
  static bool _tried = false;

  static MembershipNative? tryLoad() {
    if (_tried) return _cached;
    _tried = true;
    for (final name in _libNames()) {
      try {
        final lib = DynamicLibrary.open(name);
        final native = MembershipNative._(lib);
        _cached = native;
        return native;
      } catch (_) {
        continue;
      }
    }
    return null;
  }

  static List<String> _libNames() {
    final out = <String>[];
    final env = Platform.environment['SHEAR_MEMBERSHIP_LIB'];
    if (env != null && env.isNotEmpty) out.add(env);
    // The packaged Android library. No node binary and no temp file on this path.
    if (Platform.isAndroid) {
      out.add('libshear_admit.so');
      return out;
    }
    try {
      final exe = File(Platform.resolvedExecutable).parent.path;
      out.add('$exe/libshear_admit.so');
      out.add('$exe/lib/libshear_admit.so');
    } catch (_) {}
    final cwd = Directory.current.path;
    out.addAll([
      '$cwd/crypto/native/admit/target/release/libshear_admit.so',
      '$cwd/../crypto/native/admit/target/release/libshear_admit.so',
      '$cwd/crypto/native/libshear_admit.so',
      '$cwd/../crypto/native/libshear_admit.so',
      'libshear_admit.so',
    ]);
    if (Platform.isMacOS) {
      out.add('$cwd/crypto/native/admit/target/release/libshear_admit.dylib');
      out.add('$cwd/../crypto/native/admit/target/release/libshear_admit.dylib');
    } else if (Platform.isWindows) {
      out.add('$cwd/crypto/native/admit/target/release/shear_admit.dll');
      out.add('$cwd/../crypto/native/admit/target/release/shear_admit.dll');
    }
    return out;
  }

  Uint8List? pointRoot(List<Uint8List> pubs, List<Uint8List> commits) {
    if (pubs.isEmpty || pubs.length != commits.length) return null;
    final n = pubs.length;
    final dest = _pack(pubs);
    final cs = _pack(commits);
    if (dest == null || cs == null) return null;
    final destP = calloc<Uint8>(dest.length);
    final csP = calloc<Uint8>(cs.length);
    final out = calloc<Uint8>(32);
    try {
      destP.asTypedList(dest.length).setAll(0, dest);
      csP.asTypedList(cs.length).setAll(0, cs);
      final rc = _root(destP, csP, n, out);
      if (rc != 1) return null;
      return Uint8List.fromList(out.asTypedList(32));
    } finally {
      calloc.free(destP);
      calloc.free(csP);
      calloc.free(out);
    }
  }

  /// Native C̃ and spend tag. The membership proof is not built.
  ({Uint8List spendTag, Uint8List cTilde})? bindInput({
    required Uint8List x,
    required Uint8List p,
    required Uint8List c,
    required Uint8List t,
  }) {
    if (x.length != 32 || p.length != 32 || c.length != 32 || t.length != 32) return null;
    final xP = calloc<Uint8>(32);
    final pP = calloc<Uint8>(32);
    final cP = calloc<Uint8>(32);
    final tP = calloc<Uint8>(32);
    final ctP = calloc<Uint8>(32);
    final tagP = calloc<Uint8>(32);
    try {
      xP.asTypedList(32).setAll(0, x);
      pP.asTypedList(32).setAll(0, p);
      cP.asTypedList(32).setAll(0, c);
      tP.asTypedList(32).setAll(0, t);
      final rc = _bind(xP, pP, cP, tP, ctP, tagP);
      if (rc != 1) return null;
      return (
        spendTag: Uint8List.fromList(tagP.asTypedList(32)),
        cTilde: Uint8List.fromList(ctP.asTypedList(32)),
      );
    } finally {
      calloc.free(xP);
      calloc.free(pP);
      calloc.free(cP);
      calloc.free(tP);
      calloc.free(ctP);
      calloc.free(tagP);
    }
  }

  /// One input under [statement]. Today the statement is 64 bytes.
  Map<String, dynamic>? prove({
    required Uint8List x,
    required Uint8List p,
    required Uint8List c,
    required Uint8List t,
    required int index,
    required List<Uint8List> pubs,
    required List<Uint8List> commits,
    required Uint8List statement,
  }) {
    if (statement.length != 64) return null;
    if (x.length != 32 || p.length != 32 || c.length != 32 || t.length != 32) return null;
    final dest = _pack(pubs);
    final cs = _pack(commits);
    if (dest == null || cs == null) return null;
    final xP = calloc<Uint8>(32);
    final pP = calloc<Uint8>(32);
    final cP = calloc<Uint8>(32);
    final tP = calloc<Uint8>(32);
    final destP = calloc<Uint8>(dest.length);
    final csP = calloc<Uint8>(cs.length);
    final ctxP = calloc<Uint8>(statement.length);
    final ctP = calloc<Uint8>(32);
    final proofP = calloc<Uint8>(kNativeMembershipProofCap);
    final lenP = calloc<Uint32>();
    try {
      xP.asTypedList(32).setAll(0, x);
      pP.asTypedList(32).setAll(0, p);
      cP.asTypedList(32).setAll(0, c);
      tP.asTypedList(32).setAll(0, t);
      destP.asTypedList(dest.length).setAll(0, dest);
      csP.asTypedList(cs.length).setAll(0, cs);
      ctxP.asTypedList(statement.length).setAll(0, statement);
      final rc = _prove(
        xP,
        pP,
        cP,
        tP,
        index,
        destP,
        csP,
        pubs.length,
        ctxP,
        statement.length,
        ctP,
        proofP,
        lenP,
      );
      if (rc != 1) return null;
      final n = lenP.value;
      if (n < 33 || n > kNativeMembershipProofCap) return null;
      final blob = Uint8List.fromList(proofP.asTypedList(n));
      if (blob[0] != 3) return null;
      return {
        'cTilde': Uint8List.fromList(ctP.asTypedList(32)),
        'blob': blob,
        'spendTag': Uint8List.fromList(blob.sublist(1, 33)),
      };
    } finally {
      calloc.free(xP);
      calloc.free(pP);
      calloc.free(cP);
      calloc.free(tP);
      calloc.free(destP);
      calloc.free(csP);
      calloc.free(ctxP);
      calloc.free(ctP);
      calloc.free(proofP);
      calloc.free(lenP);
    }
  }

  /// BP+ range blob. The first byte stays 2. That is the range marker, not
  /// the membership statement.
  Uint8List? proveRange(BigInt units, Uint8List r) {
    if (r.length != 32) return null;
    if (units < BigInt.zero || units.bitLength > 64) return null;
    final le = Uint8List(8);
    var v = units;
    for (var i = 0; i < 8; i++) {
      le[i] = (v & BigInt.from(0xff)).toInt();
      v >>= 8;
    }
    final vP = calloc<Uint8>(8);
    final rP = calloc<Uint8>(32);
    final out = calloc<Uint8>(kNativeRangeProofCap);
    final lenP = calloc<Uint32>();
    try {
      vP.asTypedList(8).setAll(0, le);
      rP.asTypedList(32).setAll(0, r);
      final rc = _range(vP, rP, out, lenP);
      if (rc != 1) return null;
      final n = lenP.value;
      if (n < 2 || n > kNativeRangeProofCap) return null;
      final blob = Uint8List.fromList(out.asTypedList(n));
      if (blob[0] != 2) return null;
      return blob;
    } finally {
      calloc.free(vP);
      calloc.free(rP);
      calloc.free(out);
      calloc.free(lenP);
    }
  }

  static Uint8List? _pack(List<Uint8List> rows) {
    final out = Uint8List(rows.length * 32);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].length != 32) return null;
      out.setRange(i * 32, i * 32 + 32, rows[i]);
    }
    return out;
  }
}
