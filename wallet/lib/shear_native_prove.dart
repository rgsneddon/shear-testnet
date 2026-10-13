import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'shear_note.dart';

/// Test-only override. Production send fails closed before prove_spend.
typedef NativeSpendProver = Map<String, dynamic>? Function({
  required Uint8List spendSeed,
  required Map<String, dynamic> spentNote,
  required List<Uint8List> pubs,
  List<Uint8List>? commits,
});

NativeSpendProver? debugNativeSpendProver;

/// Tests set this so Flow seal runs on the caller. flutter_tester deadlocks
/// on [Isolate.run] around the native prover.
bool debugFlowCryptoOnCaller = false;

typedef NativeNoteSealer = Map<String, dynamic> Function(int v, {Uint8List? dest20, String kind});
NativeNoteSealer? debugNativeSealNote;

/// Test-only override for a u64 that does not fit in a Dart int.
typedef NativeUnitsSealer = Map<String, dynamic> Function(BigInt v, {Uint8List? dest20, String kind});
NativeUnitsSealer? debugNativeSealUnits;

String _hex(Uint8List b) => b.map((e) => e.toRadixString(16).padLeft(2, '0')).join();

/// One node process. A missing helper or a short row is a reject.
/// Inbox 030: Continuum does not treat a stand-in blob as a range proof.
List<bool> nativeVerifyRanges(List<Uint8List> commits, List<Uint8List> proofs) {
  if (commits.length != proofs.length) return List<bool>.filled(commits.length, false);
  if (commits.isEmpty) return const [];
  final helper = _helperPath();
  if (helper == null) return List<bool>.filled(commits.length, false);
  final tmp = File('${Directory.systemTemp.path}/shear-range-verify-${DateTime.now().microsecondsSinceEpoch}.json');
  tmp.writeAsStringSync(jsonEncode({
    'op': 'verify_ranges',
    'rows': [
      for (var i = 0; i < commits.length; i++) {'commit': _hex(commits[i]), 'proof': _hex(proofs[i])},
    ],
  }), flush: true);
  if (!Platform.isWindows) {
    try { Process.runSync('chmod', ['600', tmp.path]); } catch (_) {}
  }
  try {
    final out = Process.runSync('node', [helper, tmp.path], runInShell: false);
    if (out.exitCode != 0) return List<bool>.filled(commits.length, false);
    final got = jsonDecode(out.stdout as String);
    final verified = got is Map ? got['verified'] : null;
    if (got is! Map || got['ok'] != true || verified is! List || verified.length != commits.length) {
      return List<bool>.filled(commits.length, false);
    }
    return [for (final row in verified) row == true];
  } catch (_) {
    return List<bool>.filled(commits.length, false);
  } finally {
    try { tmp.deleteSync(); } catch (_) {}
  }
}

Uint8List? _unhex(dynamic v) {
  if (v is Uint8List) return v;
  if (v is String && v.length >= 2 && v.length % 2 == 0) {
    final o = Uint8List(v.length ~/ 2);
    for (var i = 0; i < o.length; i++) {
      o[i] = int.parse(v.substring(i * 2, i * 2 + 2), radix: 16);
    }
    return o;
  }
  return null;
}

String? _helperPath() {
  final env = Platform.environment['SHEAR_NATIVE_PROVE'];
  if (env != null && env.isNotEmpty && File(env).existsSync()) return env;
  final candidates = [
    File('${Directory.current.path}/crypto/wallet_native_prove.mjs'),
    File('${Directory.current.path}/../crypto/wallet_native_prove.mjs'),
  ];
  for (final f in candidates) {
    if (f.existsSync()) return f.path;
  }
  return null;
}

Map<String, dynamic>? nativeProveFlowSpend({
  required Uint8List spendSeed,
  required Map<String, dynamic> spentNote,
  required List<Uint8List> pubs,
  List<Uint8List>? commits,
}) {
  final override = debugNativeSpendProver;
  if (override != null) {
    return override(spendSeed: spendSeed, spentNote: spentNote, pubs: pubs, commits: commits);
  }
  // Closed before prove_spend. A test double above is the only remaining return.
  return null;
}

/// Seal any u64. Values that fit in a Dart int use [nativeSealNote].
Map<String, dynamic> nativeSealUnits(BigInt v, {Uint8List? dest20, String kind = 'send'}) {
  if (v < BigInt.zero || v.bitLength > 64) throw ArgumentError('u64');
  final unitsOverride = debugNativeSealUnits;
  if (unitsOverride != null && v.bitLength > 63) {
    return unitsOverride(v, dest20: dest20, kind: kind);
  }
  if (v.bitLength <= 63) return nativeSealNote(v.toInt(), dest20: dest20, kind: kind);
  final note = sealCoinbaseUnits(v, dest20: dest20, kind: kind);
  final helper = _helperPath();
  if (helper == null) throw StateError('admit_native_required');
  final r = note['r'];
  if (r is! Uint8List) throw StateError('admit_native_required');
  final tmp = File('${Directory.systemTemp.path}/shear-range-${DateTime.now().microsecondsSinceEpoch}.json');
  tmp.writeAsStringSync(jsonEncode({'op': 'prove_range', 'v': v.toString(), 'r': _hex(r)}), flush: true);
  if (!Platform.isWindows) {
    try { Process.runSync('chmod', ['600', tmp.path]); } catch (_) {}
  }
  try {
    final out = Process.runSync('node', [helper, tmp.path], runInShell: false);
    if (out.exitCode != 0) throw StateError('admit_native_required');
    final got = jsonDecode(out.stdout as String);
    if (got is! Map || got['ok'] != true || got['v'] != 2) throw StateError('admit_native_required');
    final blob = _unhex(got['proof']);
    if (blob == null || blob.isEmpty || blob[0] != 2) throw StateError('admit_native_required');
    note['rangeProof'] = blob;
    return note;
  } finally {
    try { tmp.deleteSync(); } catch (_) {}
  }
}

Map<String, dynamic> nativeSealNote(int v, {Uint8List? dest20, String kind = 'send'}) {
  final override = debugNativeSealNote;
  if (override != null) return override(v, dest20: dest20, kind: kind);
  final helper = _helperPath();
  // The wire range proof is the node blob. sealNote's pure-Dart proveRange is
  // a different object, and without libsodium it does not return inside a
  // send. The value opening stays here. The helper fills rangeProof.
  final note = sealCoinbaseNote(v, dest20: dest20, kind: kind);
  if (helper == null) {
    throw StateError('admit_native_required');
  }
  final r = note['r'];
  if (r is! Uint8List) throw StateError('admit_native_required');
  final tmp = File('${Directory.systemTemp.path}/shear-range-${DateTime.now().microsecondsSinceEpoch}.json');
  tmp.writeAsStringSync(jsonEncode({ 'op': 'prove_range', 'v': v.toString(), 'r': _hex(r) }), flush: true);
  if (!Platform.isWindows) {
    try { Process.runSync('chmod', ['600', tmp.path]); } catch (_) {}
  }
  try {
    final out = Process.runSync('node', [helper, tmp.path], runInShell: false);
    if (out.exitCode != 0) throw StateError('admit_native_required');
    final got = jsonDecode(out.stdout as String);
    if (got is! Map || got['ok'] != true || got['v'] != 2) throw StateError('admit_native_required');
    final blob = _unhex(got['proof']);
    if (blob == null || blob.isEmpty || blob[0] != 2) throw StateError('admit_native_required');
    note['rangeProof'] = blob;
    return note;
  } finally {
    try { tmp.deleteSync(); } catch (_) {}
  }
}
