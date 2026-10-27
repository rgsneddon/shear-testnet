import 'dart:convert';
import 'dart:ffi';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:ffi/ffi.dart';

import 'shear_admit.dart';
import 'shear_admit_ffi.dart';
import 'shear_eip712.dart' show hexToBytes;
import 'shear_note.dart' show kernelExcess;
import 'shear_pack.dart' show reserveCommitOf, reserveDigestSuffixBytes, reserveOpenedNanos;
import 'shear_ristretto.dart';

/// FS-1 full-set spend (ADMITv3). One spend covers every input of a send:
/// the aggregate blob `0xF1 || layers || n || root || FCMP` rides as `fs1`
/// and input i's 321-byte record `0xF1 || spendTag || C̃ || O~ || I~ || R || SA+L`
/// is `admit_proofs[i].blob`. The prover is shear-fs1 (vendored monero-oxide
/// FCMP++, MIT) inside libshear_admit, called in-process on every platform.
/// Same wire as crypto/fs1_spend.js.
const int kFs1Wire = 0xf1;
const int kFs1RecordBytes = 321;
const int kFs1InputMax = 8;
const int kFs1NoteBytes = 64;
const String kFs1DigestDst = 'shear-admit-fs1-txd';

/// Tags the signed top-level memo envelope (FS1_MEMO=bound).
const String kFs1MemoDst = 'shear-fs1-memo-v1';

/// The canonical encoding JS `canonicalEncode` gives a JSON value: keys
/// sorted, no spaces. A memo envelope is a map of strings and an int.
String _canonicalJson(Object? v) {
  if (v is Map) {
    // JSON has no undefined, so every key is kept, as canonicalEncode keeps a null.
    final keys = v.keys.map((k) => k.toString()).toList()..sort();
    return '{${keys.map((k) => '${jsonEncode(k)}:${_canonicalJson(v[k])}').join(',')}}';
  }
  if (v is List) return '[${v.map(_canonicalJson).join(',')}]';
  return jsonEncode(v);
}

/// sha256 of a memo envelope's canonical encoding: the bytes the spend signs.
Uint8List fs1MemoDigest(Map<String, dynamic> memoCt) =>
    Uint8List.fromList(sha256.convert(utf8Bytes(_canonicalJson(memoCt))).bytes);

/// No FS-1 prover in the loaded library.
const String kErrFs1Prover = 'fs1_prover_unavailable';

/// No anchor row covers every input yet (a note is younger than the anchor).
const String kErrFs1Anchor = 'fs1_anchor';

Uint8List _raw(Object? v) {
  if (v == null) return Uint8List(0);
  if (v is Uint8List) return v;
  if (v is String) {
    if (v.isEmpty) return Uint8List(0);
    try {
      return hexToBytes(v);
    } catch (_) {
      return Uint8List(0);
    }
  }
  if (v is List<int>) return Uint8List.fromList(v);
  return Uint8List(0);
}

Uint8List _b32(Object? v) {
  final b = _raw(v);
  return b.length == 32 ? b : Uint8List(32);
}

Uint8List _lenPref(List<int> b) {
  final out = Uint8List(4 + b.length);
  ByteData.sublistView(out).setUint32(0, b.length, Endian.little);
  out.setRange(4, out.length, b);
  return out;
}

Uint8List _u32(int v) {
  final out = Uint8List(4);
  ByteData.sublistView(out).setUint32(0, v, Endian.little);
  return out;
}

Uint8List _u64(int v) {
  final out = Uint8List(8);
  var x = BigInt.from(v < 0 ? 0 : v);
  for (var i = 0; i < 8; i++) {
    out[i] = (x & BigInt.from(0xff)).toInt();
    x >>= 8;
  }
  return out;
}

/// SHA-256 body digest an FS-1 spend binds. Port of `txBodyDigestFs1` in
/// crypto/fs1_spend.js over the posted vout rows (bytes or hex). A send has
/// no portal, program, payout portal, or reserve suffix. A lock, vote, or
/// withdraw appends `reserveDigestSuffix`, including unlock time and lock epoch.
/// A lock also binds sha256([piProof]). Pass the proof that will be posted.
Uint8List fs1BodyDigest({
  required String magic,
  required String kind,
  required int anchor,
  required int fee,
  required int nIn,
  required List<Map<String, dynamic>> vout,
  String portalId = '',
  String programId = '',
  String payoutPortalId = '',
  String choice = '',
  int? reserveNanos,
  String id = '',
  Uint8List? withdrawNonce,
  String oneTimePub = '',
  Uint8List? piProof,
  Map<String, dynamic>? memoCt,
}) {
  final b = BytesBuilder(copy: false)
    ..add(utf8Bytes(kFs1DigestDst))
    ..addByte(kFs1Wire)
    ..add(_lenPref(utf8Bytes(magic)))
    ..add(_lenPref(utf8Bytes(kind)))
    ..add(_u64(anchor))
    ..add(_u64(fee))
    ..add(_u32(nIn))
    ..add(_u32(vout.length));
  for (final o in vout) {
    final posted = o['kind'];
    final outKind = (posted == null || posted == '') ? 'pot' : posted.toString();
    final view = _raw(o['viewTag']);
    final d20 = _raw(o['dest20']);
    b
      ..add(_lenPref(utf8Bytes(outKind)))
      ..add(_b32(o['commit']))
      ..add(_b32(o['admitPub']))
      ..add(_b32(o['noteCommit']))
      ..add(_b32(o['rEph']))
      ..add(_lenPref(_raw(o['rCt'])))
      ..add(_lenPref(_raw(o['amtCt'])))
      ..addByte(view.isNotEmpty ? view[0] : 0)
      ..add(sha256.convert(_raw(o['rangeProof'])).bytes)
      ..add(_lenPref(d20.length >= 20 ? d20.sublist(0, 20) : Uint8List(0)));
  }
  b
    ..add(_lenPref(utf8Bytes(portalId.toLowerCase())))
    ..add(_lenPref(utf8Bytes(programId)))
    ..add(_lenPref(utf8Bytes(payoutPortalId.toLowerCase())));
  if (kind == 'lock' || kind == 'vote' || kind == 'withdraw') {
    b.add(reserveDigestSuffixBytes(
      kind: kind,
      portalId: portalId,
      payoutPortalId: payoutPortalId,
      programId: programId,
      choice: choice,
      suffixNanos: reserveNanos ?? reserveOpenedNanos(vout, kind),
      commit: reserveCommitOf(vout, kind),
      vout: vout,
      id: id,
      withdrawNonce: withdrawNonce,
      oneTimePub: oneTimePub,
      piProof: piProof,
    ));
  }
  // The top-level memo envelope is signed (FS1_MEMO=bound): stripped,
  // swapped or added after, the spend fails.
  if (memoCt != null) {
    b
      ..add(utf8Bytes(kFs1MemoDst))
      ..add(fs1MemoDigest(memoCt));
  }
  return Uint8List.fromList(sha256.convert(b.takeBytes()).bytes);
}

/// One fluxset anchor row: the admit set's first [n] notes at [height].
class Fs1Anchor {
  const Fs1Anchor(this.height, this.n);
  final int height;
  final int n;
}

/// Rows from `/fluxset` `anchors` (newest first). Malformed rows are dropped.
List<Fs1Anchor> fs1AnchorsOf(Object? raw) {
  if (raw is! List) return const [];
  final out = <Fs1Anchor>[];
  for (final row in raw) {
    if (row is! Map) continue;
    final h = row['height'];
    final n = row['n'];
    if (h is int && n is int && h > 0 && n > 0) out.add(Fs1Anchor(h, n));
  }
  return out;
}

/// Newest anchor whose row holds leaf [maxIndex]. Null when every input is
/// younger than the anchor window allows.
Fs1Anchor? pickFs1Anchor(List<Fs1Anchor> rows, int maxIndex) {
  for (final r in rows) {
    if (r.n > maxIndex) return r;
  }
  return null;
}

/// shear_fs1_* in libshear_admit. Handles cross isolates as raw addresses.
class Fs1Native {
  Fs1Native._(DynamicLibrary lib)
      : _cap = lib.lookupFunction<Uint32 Function(Uint32), int Function(int)>('shear_fs1_blob_cap'),
        _new = lib.lookupFunction<Pointer<Void> Function(), Pointer<Void> Function()>('shear_fs1_tree_new'),
        _free = lib.lookupFunction<Void Function(Pointer<Void>), void Function(Pointer<Void>)>('shear_fs1_tree_free'),
        _len = lib.lookupFunction<Uint64 Function(Pointer<Void>), int Function(Pointer<Void>)>('shear_fs1_tree_len'),
        _append = lib.lookupFunction<Int32 Function(Pointer<Void>, Pointer<Uint8>, Uint64),
            int Function(Pointer<Void>, Pointer<Uint8>, int)>('shear_fs1_tree_append'),
        _truncate = lib.lookupFunction<Int32 Function(Pointer<Void>, Uint64), int Function(Pointer<Void>, int)>(
            'shear_fs1_tree_truncate'),
        _root = lib.lookupFunction<Int32 Function(Pointer<Void>, Pointer<Uint8>), int Function(Pointer<Void>, Pointer<Uint8>)>(
            'shear_fs1_tree_root'),
        _prove = lib.lookupFunction<_ProveC, _ProveDart>('shear_fs1_prove'),
        _proveUnlinked = lib.lookupFunction<_ProveUnlinkedC, _ProveUnlinkedDart>('shear_fs1_prove_unlinked'),
        _verify = lib.lookupFunction<_Fs1VerifyC, _Fs1VerifyDart>('shear_fs1_verify');

  final int Function(int) _cap;
  final Pointer<Void> Function() _new;
  final void Function(Pointer<Void>) _free;
  final int Function(Pointer<Void>) _len;
  final int Function(Pointer<Void>, Pointer<Uint8>, int) _append;
  final int Function(Pointer<Void>, int) _truncate;
  final int Function(Pointer<Void>, Pointer<Uint8>) _root;
  final _ProveDart _prove;
  final _ProveUnlinkedDart _proveUnlinked;
  final _Fs1VerifyDart _verify;

  static Fs1Native? tryLoad() {
    final lib = AdmitNative.tryLoad()?.library;
    if (lib == null) return null;
    try {
      return Fs1Native._(lib);
    } catch (_) {
      return null;
    }
  }

  int blobCap(int n) => _cap(n);

  int treeNew() => _new().address;

  void treeFree(int h) {
    if (h != 0) _free(Pointer<Void>.fromAddress(h));
  }

  int treeLen(int h) => h == 0 ? 0 : _len(Pointer<Void>.fromAddress(h));

  bool treeAppend(int h, Uint8List notes) {
    if (h == 0 || notes.isEmpty || notes.length % kFs1NoteBytes != 0) return false;
    final p = calloc<Uint8>(notes.length);
    try {
      p.asTypedList(notes.length).setAll(0, notes);
      return _append(Pointer<Void>.fromAddress(h), p, notes.length ~/ kFs1NoteBytes) == 1;
    } finally {
      calloc.free(p);
    }
  }

  bool treeTruncate(int h, int len) => h != 0 && _truncate(Pointer<Void>.fromAddress(h), len) == 1;

  Uint8List? treeRoot(int h) {
    if (h == 0) return null;
    final out = calloc<Uint8>(32);
    try {
      if (_root(Pointer<Void>.fromAddress(h), out) != 1) return null;
      return Uint8List.fromList(out.asTypedList(32));
    } finally {
      calloc.free(out);
    }
  }

  /// Aggregate blob, records, and each input's secret `t`. Null on failure.
  ({Uint8List fs1, List<Uint8List> records, List<Uint8List> t})? prove(
    int h,
    List<int> indices,
    List<Uint8List> xs,
    Uint8List digest,
    int anchor, {
    int threads = 0,
  }) {
    final n = indices.length;
    if (h == 0 || n < 1 || n > kFs1InputMax || xs.length != n || digest.length != 32) return null;
    final cap = blobCap(n);
    if (cap <= 0) return null;
    final idx = calloc<Uint64>(n);
    final xp = calloc<Uint8>(32 * n);
    final dp = calloc<Uint8>(32);
    final out = calloc<Uint8>(cap);
    final olen = calloc<Size>();
    final recs = calloc<Uint8>(kFs1RecordBytes * n);
    final tp = calloc<Uint8>(32 * n);
    try {
      for (var i = 0; i < n; i++) {
        idx[i] = indices[i];
        if (xs[i].length != 32) return null;
        xp.asTypedList(32 * n).setAll(32 * i, xs[i]);
      }
      dp.asTypedList(32).setAll(0, digest);
      final rc = _prove(Pointer<Void>.fromAddress(h), idx, xp, n, dp, anchor, threads, out, cap, olen, recs, tp);
      if (rc != 1) return null;
      final len = olen.value;
      if (len <= 0 || len > cap) return null;
      final rv = recs.asTypedList(kFs1RecordBytes * n);
      final tv = tp.asTypedList(32 * n);
      return (
        fs1: Uint8List.fromList(out.asTypedList(len)),
        records: [
          for (var i = 0; i < n; i++) Uint8List.fromList(rv.sublist(i * kFs1RecordBytes, (i + 1) * kFs1RecordBytes)),
        ],
        t: [for (var i = 0; i < n; i++) Uint8List.fromList(tv.sublist(32 * i, 32 * (i + 1)))],
      );
    } finally {
      _wipe(xp, 32 * n);
      _wipe(tp, 32 * n);
      calloc.free(idx);
      calloc.free(dp);
      calloc.free(out);
      calloc.free(olen);
      calloc.free(recs);
    }
  }

  /// Claim spend. `link` is 96 bytes per input: announcement || blind response || N.
  /// The record tag is one-time, not the stable spend tag.
  ({Uint8List fs1, List<Uint8List> records, List<Uint8List> t, Uint8List link})? proveUnlinked(
    int h,
    List<int> indices,
    List<Uint8List> xs,
    Uint8List digest,
    int anchor,
    Uint8List nullBases, {
    int threads = 0,
  }) {
    final n = indices.length;
    if (h == 0 || n < 1 || n > kFs1InputMax || xs.length != n || digest.length != 32 || nullBases.length != 32 * n) {
      return null;
    }
    final cap = blobCap(n);
    if (cap <= 0) return null;
    final idx = calloc<Uint64>(n);
    final xp = calloc<Uint8>(32 * n);
    final dp = calloc<Uint8>(32);
    final bp = calloc<Uint8>(32 * n);
    final out = calloc<Uint8>(cap);
    final olen = calloc<Size>();
    final recs = calloc<Uint8>(kFs1RecordBytes * n);
    final tp = calloc<Uint8>(32 * n);
    final lp = calloc<Uint8>(96 * n);
    try {
      for (var i = 0; i < n; i++) {
        idx[i] = indices[i];
        if (xs[i].length != 32) return null;
        xp.asTypedList(32 * n).setAll(32 * i, xs[i]);
      }
      dp.asTypedList(32).setAll(0, digest);
      bp.asTypedList(32 * n).setAll(0, nullBases);
      final rc = _proveUnlinked(
        Pointer<Void>.fromAddress(h), idx, xp, n, dp, anchor, threads, bp, out, cap, olen, recs, tp, lp,
      );
      if (rc != 1) return null;
      final len = olen.value;
      if (len <= 0 || len > cap) return null;
      final rv = recs.asTypedList(kFs1RecordBytes * n);
      final tv = tp.asTypedList(32 * n);
      return (
        fs1: Uint8List.fromList(out.asTypedList(len)),
        records: [
          for (var i = 0; i < n; i++) Uint8List.fromList(rv.sublist(i * kFs1RecordBytes, (i + 1) * kFs1RecordBytes)),
        ],
        t: [for (var i = 0; i < n; i++) Uint8List.fromList(tv.sublist(32 * i, 32 * (i + 1)))],
        link: Uint8List.fromList(lp.asTypedList(96 * n)),
      );
    } finally {
      _wipe(xp, 32 * n);
      _wipe(tp, 32 * n);
      calloc.free(idx);
      calloc.free(dp);
      calloc.free(bp);
      calloc.free(out);
      calloc.free(olen);
      calloc.free(recs);
      calloc.free(lp);
    }
  }

  bool verify(Uint8List fs1, List<Uint8List> records, Uint8List root, Uint8List digest, int anchor) {
    final n = records.length;
    if (n < 1 || n > kFs1InputMax || root.length != 32 || digest.length != 32) return false;
    final fp = calloc<Uint8>(fs1.length);
    final rp = calloc<Uint8>(kFs1RecordBytes * n);
    final op = calloc<Uint8>(32);
    final dp = calloc<Uint8>(32);
    try {
      fp.asTypedList(fs1.length).setAll(0, fs1);
      for (var i = 0; i < n; i++) {
        if (records[i].length != kFs1RecordBytes) return false;
        rp.asTypedList(kFs1RecordBytes * n).setAll(i * kFs1RecordBytes, records[i]);
      }
      op.asTypedList(32).setAll(0, root);
      dp.asTypedList(32).setAll(0, digest);
      return _verify(fp, fs1.length, rp, n, op, dp, anchor) == 1;
    } finally {
      calloc.free(fp);
      calloc.free(rp);
      calloc.free(op);
      calloc.free(dp);
    }
  }
}

void _wipe(Pointer<Uint8> p, int n) {
  p.asTypedList(n).fillRange(0, n, 0);
  calloc.free(p);
}

typedef _ProveC = Int32 Function(Pointer<Void>, Pointer<Uint64>, Pointer<Uint8>, Uint32, Pointer<Uint8>, Uint64, Uint32,
    Pointer<Uint8>, Size, Pointer<Size>, Pointer<Uint8>, Pointer<Uint8>);
typedef _ProveDart = int Function(Pointer<Void>, Pointer<Uint64>, Pointer<Uint8>, int, Pointer<Uint8>, int, int,
    Pointer<Uint8>, int, Pointer<Size>, Pointer<Uint8>, Pointer<Uint8>);
typedef _ProveUnlinkedC = Int32 Function(Pointer<Void>, Pointer<Uint64>, Pointer<Uint8>, Uint32, Pointer<Uint8>, Uint64,
    Uint32, Pointer<Uint8>, Pointer<Uint8>, Size, Pointer<Size>, Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>);
typedef _ProveUnlinkedDart = int Function(Pointer<Void>, Pointer<Uint64>, Pointer<Uint8>, int, Pointer<Uint8>, int, int,
    Pointer<Uint8>, Pointer<Uint8>, int, Pointer<Size>, Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>);
typedef _Fs1VerifyC = Int32 Function(Pointer<Uint8>, Size, Pointer<Uint8>, Uint32, Pointer<Uint8>, Pointer<Uint8>, Uint64);
typedef _Fs1VerifyDart = int Function(Pointer<Uint8>, int, Pointer<Uint8>, int, Pointer<Uint8>, Pointer<Uint8>, int);

/// `pub || commit` for each of the first [n] admit-set notes.
Uint8List fs1NotesBytes(List<Uint8List> pubs, List<Uint8List> commits, int n) {
  if (n < 1 || pubs.length < n || commits.length < n) throw StateError('fluxset');
  final out = Uint8List(n * kFs1NoteBytes);
  for (var i = 0; i < n; i++) {
    if (pubs[i].length != 32 || commits[i].length != 32) throw StateError('fluxset');
    out.setRange(i * kFs1NoteBytes, i * kFs1NoteBytes + 32, pubs[i]);
    out.setRange(i * kFs1NoteBytes + 32, (i + 1) * kFs1NoteBytes, commits[i]);
  }
  return out;
}

String _hex(List<int> b) {
  const d = '0123456789abcdef';
  final s = StringBuffer();
  for (final x in b) {
    s
      ..write(d[x >> 4])
      ..write(d[x & 15]);
  }
  return s.toString();
}

/// The tree a wallet keeps between sends: its native address, how many
/// notes it holds, and a hash of those notes. A send whose admit set still
/// starts with the same notes only appends the new ones.
class Fs1TreeState {
  const Fs1TreeState({this.handle = 0, this.len = 0, this.prefix = ''});
  final int handle;
  final int len;
  final String prefix;

  Map<String, dynamic> toWire() => {'handle': handle, 'len': len, 'prefix': prefix};

  static Fs1TreeState fromWire(Object? raw) {
    if (raw is! Map) return const Fs1TreeState();
    final h = raw['handle'];
    final l = raw['len'];
    final p = raw['prefix'];
    return Fs1TreeState(handle: h is int ? h : 0, len: l is int ? l : 0, prefix: p is String ? p : '');
  }
}

/// Bring [state]'s tree to exactly the notes in [notes]. Returns the handle
/// and new state. A changed prefix (reorg) rebuilds from empty.
({int handle, Fs1TreeState state}) fs1SyncTree(Fs1Native lib, Fs1TreeState state, Uint8List notes) {
  final n = notes.length ~/ kFs1NoteBytes;
  var h = state.handle;
  if (h == 0) h = lib.treeNew();
  if (h == 0) throw StateError(kErrFs1Prover);
  var keep = 0;
  if (state.len > 0 && state.len <= n && lib.treeLen(h) == state.len) {
    final head = _hex(sha256.convert(Uint8List.sublistView(notes, 0, state.len * kFs1NoteBytes)).bytes);
    if (head == state.prefix) keep = state.len;
  }
  if (lib.treeLen(h) != keep && !lib.treeTruncate(h, keep)) {
    lib.treeFree(h);
    h = lib.treeNew();
    keep = 0;
    if (h == 0) throw StateError(kErrFs1Prover);
  }
  if (keep < n && !lib.treeAppend(h, Uint8List.sublistView(notes, keep * kFs1NoteBytes))) {
    lib.treeFree(h);
    throw StateError('fs1_leaf');
  }
  return (
    handle: h,
    state: Fs1TreeState(handle: h, len: n, prefix: _hex(sha256.convert(notes).bytes)),
  );
}

/// Worker body for one FS-1 send. Runs off the UI isolate.
///
/// Input: `notes` (anchor row bytes), `indices`, `spent` ({kind, commit,
/// noteCommit, r} per input), `spendSeed`, `vout` (sealed rows with `r`),
/// `digest`, `anchor`, `tree` ([Fs1TreeState.toWire]), optional `threads`.
/// Output: `fs1`, `records`, `excess`, `tree`, and `ms`. The blinds `t` stay
/// in this isolate: the kernel excess is formed here.
Map<String, dynamic> proveFs1SpendWire(Map<String, dynamic> input) {
  final lib = Fs1Native.tryLoad();
  if (lib == null) throw StateError(kErrFs1Prover);
  final notes = input['notes'] as Uint8List;
  final indices = List<int>.from(input['indices'] as List);
  final spendSeed = input['spendSeed'] as Uint8List;
  final spent = [for (final s in (input['spent'] as List)) Map<String, dynamic>.from(s as Map)];
  final vout = [for (final o in (input['vout'] as List)) Map<String, dynamic>.from(o as Map)];
  final digest = input['digest'] as Uint8List;
  final anchor = input['anchor'] as int;
  final threads = (input['threads'] as int?) ?? 0;
  if (spent.length != indices.length || indices.isEmpty || indices.length > kFs1InputMax) {
    throw StateError('fs1_inputs');
  }
  final sw = Stopwatch()..start();
  final synced = fs1SyncTree(lib, Fs1TreeState.fromWire(input['tree']), notes);
  final treeMs = sw.elapsedMilliseconds;
  final xs = <Uint8List>[];
  try {
    for (var i = 0; i < spent.length; i++) {
      final rowSeed = spent[i]['spendSeed'];
      final seed = rowSeed is Uint8List && rowSeed.length == 32 ? rowSeed : spendSeed;
      final x = admitScalarFromSeed(seed, spent[i]);
      final at = indices[i] * kFs1NoteBytes;
      final want = pointBytes(admitPub(x));
      for (var k = 0; k < 32; k++) {
        if (notes[at + k] != want[k]) throw StateError('fs1_not_owner');
      }
      xs.add(scalarBytes(x));
    }
    final out = lib.prove(synced.handle, indices, xs, digest, anchor, threads: threads);
    if (out == null) throw StateError('fs1_prove');
    final vins = <Map<String, dynamic>>[
      for (var i = 0; i < spent.length; i++) {'r': spent[i]['r'], 't': out.t[i]},
    ];
    final excess = kernelExcess(vout, vins);
    // t stays off a send. A leaf-vote fee checks cTilde = commit + t·H locally
    // and still does not post t.
    final keepT = input['keepT'] == true
        ? <Uint8List>[for (final t in out.t) Uint8List.fromList(t)]
        : null;
    for (final t in out.t) {
      t.fillRange(0, t.length, 0);
    }
    return {
      'fs1': out.fs1,
      'records': out.records,
      'excess': excess,
      'tree': synced.state.toWire(),
      'treeMs': treeMs,
      'ms': sw.elapsedMilliseconds,
      if (keepT != null) 't': keepT,
    };
  } finally {
    for (final x in xs) {
      x.fillRange(0, x.length, 0);
    }
  }
}

/// The posted proof object for one record. `cTilde` is the input's vin commit.
Map<String, dynamic> fs1PostedProof(Uint8List record) {
  if (record.length != kFs1RecordBytes || record[0] != kFs1Wire) throw StateError('fs1_record');
  return {
    'blob': record,
    'cTilde': Uint8List.fromList(record.sublist(33, 65)),
    'spendTag': Uint8List.fromList(record.sublist(1, 33)),
  };
}
