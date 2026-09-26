import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'shear_note.dart';

/// Test-only override. Production send uses the native node helper.
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

String _hex(Uint8List b) => b.map((e) => e.toRadixString(16).padLeft(2, '0')).join();

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
    return override(spendSeed: spendSeed, spentNote: spentNote, pubs: pubs);
  }
  final helper = _helperPath();
  if (helper == null) return null;
  final tmp = File('${Directory.systemTemp.path}/shear-admit-${DateTime.now().microsecondsSinceEpoch}.json');
  tmp.writeAsStringSync(jsonEncode({
    'op': 'prove_spend',
    'spendSeed': _hex(spendSeed),
    'spentNote': {
      'kind': spentNote['kind'],
      'commit': spentNote['commit'] is Uint8List ? _hex(spentNote['commit'] as Uint8List) : spentNote['commit'],
      'noteCommit': spentNote['noteCommit'] is Uint8List
          ? _hex(spentNote['noteCommit'] as Uint8List)
          : spentNote['noteCommit'],
    },
    'pubs': pubs.map(_hex).toList(),
    'commits': (commits ?? const <Uint8List>[]).map(_hex).toList(),
  }), flush: true);
  if (!Platform.isWindows) {
    try { Process.runSync('chmod', ['600', tmp.path]); } catch (_) {}
  }
  try {
    final r = Process.runSync('node', [helper, tmp.path], runInShell: false);
    if (r.exitCode != 0) return null;
    final got = jsonDecode(r.stdout as String);
    if (got is! Map || got['ok'] != true || got['v'] != 2) return null;
    if (got['r'] != null) return null;
    return {
      'admit_proof': true,
      'v': 2,
      'spendTag': _unhex(got['spendTag']),
      'blob': _unhex(got['blob']),
      'cTilde': _unhex(got['cTilde']),
    };
  } catch (_) {
    return null;
  } finally {
    try {
      tmp.deleteSync();
    } catch (_) {}
  }
}

Map<String, dynamic> nativeSealNote(int v, {Uint8List? dest20, String kind = 'send'}) {
  final override = debugNativeSealNote;
  if (override != null) return override(v, dest20: dest20, kind: kind);
  final helper = _helperPath();
  final note = sealNote(v, dest20: dest20, kind: kind);
  if (helper == null) {
    throw StateError('admit_native_required');
  }
  final r = note['r'];
  if (r is! Uint8List) throw StateError('admit_native_required');
  final tmp = File('${Directory.systemTemp.path}/shear-range-${DateTime.now().microsecondsSinceEpoch}.json');
  tmp.writeAsStringSync(jsonEncode({ 'op': 'prove_range', 'v': v, 'r': _hex(r) }), flush: true);
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
