/// FS-1 external signer split for Ledger-backed Shear accounts
/// (docs/LEDGER-VORTICE.md §5, ruling D1 of 29 Oct).
///
/// The host proves membership without the admit secret `x`. The device returns
/// each input's spend tag and then its SA+L. [Fs1External.assemble] checks
/// every SA+L and returns the same blob and records as the software prover, so
/// the posted bytes and the verifier are unchanged. Null when the loaded
/// libshear_admit predates these exports.
library;

import 'dart:ffi';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import '../shear_admit_ffi.dart';

/// `m(64) index(1) O~ I~ R tag o i ib` (32 each).
const int kFs1SalRequestBytes = 64 + 1 + 7 * 32;
const int kFs1SalBytes = 160;
const int _kRecordBytes = 321;

typedef _ProveExtC = Pointer<Void> Function(
    Pointer<Void>, Pointer<Uint64>, Pointer<Uint8>, Uint32, Pointer<Uint8>, Uint64, Uint32, Pointer<Uint8>);
typedef _ProveExtDart = Pointer<Void> Function(
    Pointer<Void>, Pointer<Uint64>, Pointer<Uint8>, int, Pointer<Uint8>, int, int, Pointer<Uint8>);
typedef _AssembleC = Int32 Function(
    Pointer<Void>, Pointer<Uint8>, Uint32, Pointer<Uint8>, Size, Pointer<Size>, Pointer<Uint8>, Pointer<Uint8>);
typedef _AssembleDart = int Function(
    Pointer<Void>, Pointer<Uint8>, int, Pointer<Uint8>, int, Pointer<Size>, Pointer<Uint8>, Pointer<Uint8>);

class Fs1External {
  Fs1External._(DynamicLibrary lib)
      : _prove = lib.lookupFunction<_ProveExtC, _ProveExtDart>('shear_fs1_prove_external'),
        _assemble = lib.lookupFunction<_AssembleC, _AssembleDart>('shear_fs1_external_assemble'),
        _free = lib.lookupFunction<Void Function(Pointer<Void>), void Function(Pointer<Void>)>('shear_fs1_external_free'),
        _cap = lib.lookupFunction<Uint32 Function(Uint32), int Function(int)>('shear_fs1_blob_cap'),
        _tag = lib.lookupFunction<Int32 Function(Pointer<Uint8>, Pointer<Uint8>), int Function(Pointer<Uint8>, Pointer<Uint8>)>(
            'shear_fs1_external_tag'),
        _sign = lib.lookupFunction<Int32 Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>),
            int Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>)>('shear_fs1_external_sign');

  final _ProveExtDart _prove;
  final _AssembleDart _assemble;
  final void Function(Pointer<Void>) _free;
  final int Function(int) _cap;
  final int Function(Pointer<Uint8>, Pointer<Uint8>) _tag;
  final int Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>) _sign;

  static Fs1External? tryLoad() {
    final lib = AdmitNative.tryLoad()?.library;
    if (lib == null) return null;
    try {
      return Fs1External._(lib);
    } on ArgumentError {
      return null;
    }
  }

  /// Host half. [tree] is an Fs1Native tree handle address. Returns the
  /// context address and `n` requests, or null.
  ({int ctx, List<Uint8List> requests})? prove(
      int tree, List<int> indices, List<Uint8List> tags, Uint8List digest, int anchor,
      {int threads = 0}) {
    final n = indices.length;
    if (tree == 0 || n < 1 || n > 8 || tags.length != n || digest.length != 32) return null;
    final idx = calloc<Uint64>(n);
    final tp = calloc<Uint8>(32 * n);
    final dp = calloc<Uint8>(32);
    final rq = calloc<Uint8>(kFs1SalRequestBytes * n);
    try {
      for (var i = 0; i < n; i++) {
        if (tags[i].length != 32) return null;
        idx[i] = indices[i];
        tp.asTypedList(32 * n).setAll(32 * i, tags[i]);
      }
      dp.asTypedList(32).setAll(0, digest);
      final ctx = _prove(Pointer<Void>.fromAddress(tree), idx, tp, n, dp, anchor, threads, rq);
      if (ctx.address == 0) return null;
      final v = rq.asTypedList(kFs1SalRequestBytes * n);
      return (
        ctx: ctx.address,
        requests: [
          for (var i = 0; i < n; i++)
            Uint8List.fromList(v.sublist(i * kFs1SalRequestBytes, (i + 1) * kFs1SalRequestBytes)),
        ],
      );
    } finally {
      rq.asTypedList(kFs1SalRequestBytes * n).fillRange(0, kFs1SalRequestBytes * n, 0);
      calloc.free(idx);
      calloc.free(tp);
      calloc.free(dp);
      calloc.free(rq);
    }
  }

  /// Checks the device's SA+L replies; consumes [ctx] either way.
  ({Uint8List fs1, List<Uint8List> records, List<Uint8List> t})? assemble(int ctx, List<Uint8List> sals) {
    final n = sals.length;
    if (ctx == 0) return null;
    if (n < 1 || n > 8 || sals.any((s) => s.length != kFs1SalBytes)) {
      _free(Pointer<Void>.fromAddress(ctx));
      return null;
    }
    final cap = _cap(n);
    final sp = calloc<Uint8>(kFs1SalBytes * n);
    final out = calloc<Uint8>(cap);
    final olen = calloc<Size>();
    final recs = calloc<Uint8>(_kRecordBytes * n);
    final tp = calloc<Uint8>(32 * n);
    try {
      for (var i = 0; i < n; i++) {
        sp.asTypedList(kFs1SalBytes * n).setAll(kFs1SalBytes * i, sals[i]);
      }
      if (_assemble(Pointer<Void>.fromAddress(ctx), sp, n, out, cap, olen, recs, tp) != 1) return null;
      final rv = recs.asTypedList(_kRecordBytes * n);
      final tv = tp.asTypedList(32 * n);
      return (
        fs1: Uint8List.fromList(out.asTypedList(olen.value)),
        records: [for (var i = 0; i < n; i++) Uint8List.fromList(rv.sublist(i * _kRecordBytes, (i + 1) * _kRecordBytes))],
        t: [for (var i = 0; i < n; i++) Uint8List.fromList(tv.sublist(32 * i, 32 * (i + 1)))],
      );
    } finally {
      tp.asTypedList(32 * n).fillRange(0, 32 * n, 0);
      calloc.free(sp);
      calloc.free(out);
      calloc.free(olen);
      calloc.free(recs);
      calloc.free(tp);
    }
  }

  /// Drop a context after a refusal on the device.
  void free(int ctx) {
    if (ctx != 0) _free(Pointer<Void>.fromAddress(ctx));
  }

  /// Reference signer, for tests and device vectors only. A Ledger account
  /// never has `x` on the host.
  Uint8List? referenceTag(Uint8List x) => _one(x, 32, (xp, o) => _tag(xp, o));

  /// Reference signer, for tests and device vectors only.
  Uint8List? referenceSign(Uint8List request, Uint8List x) {
    if (request.length != kFs1SalRequestBytes) return null;
    final rp = calloc<Uint8>(kFs1SalRequestBytes);
    try {
      rp.asTypedList(kFs1SalRequestBytes).setAll(0, request);
      return _one(x, kFs1SalBytes, (xp, o) => _sign(rp, xp, o));
    } finally {
      calloc.free(rp);
    }
  }

  Uint8List? _one(Uint8List x, int outLen, int Function(Pointer<Uint8>, Pointer<Uint8>) f) {
    if (x.length != 32) return null;
    final xp = calloc<Uint8>(32);
    final o = calloc<Uint8>(outLen);
    try {
      xp.asTypedList(32).setAll(0, x);
      if (f(xp, o) != 1) return null;
      return Uint8List.fromList(o.asTypedList(outLen));
    } finally {
      xp.asTypedList(32).fillRange(0, 32, 0);
      calloc.free(xp);
      calloc.free(o);
    }
  }
}
