import 'dart:typed_data';

import 'shear_admit_ffi.dart';
import 'shear_note.dart';

export 'shear_admit_ffi.dart' show debugFlowCryptoOnCaller, requireRangeOffUi, zeroize;

typedef NativeNoteSealer = Map<String, dynamic> Function(int v, {Uint8List? dest20, String kind});
NativeNoteSealer? debugNativeSealNote;

/// Test-only override for a u64 that does not fit in a signed Dart int.
typedef NativeUnitsSealer = Map<String, dynamic> Function(BigInt v, {Uint8List? dest20, String kind});
NativeUnitsSealer? debugNativeSealUnits;

/// In-process range check. A missing library or a short row is a reject.
/// Inbox 030: Continuum does not treat a stand-in blob as a range proof.
List<bool> nativeVerifyRanges(List<Uint8List> commits, List<Uint8List> proofs) {
  requireRangeOffUi();
  if (commits.length != proofs.length) return List<bool>.filled(commits.length, false);
  if (commits.isEmpty) return const [];
  final lib = AdmitNative.tryLoad();
  if (lib == null) return List<bool>.filled(commits.length, false);
  return [for (var i = 0; i < commits.length; i++) lib.verifyRange(commits[i], proofs[i])];
}

/// Seal any u64. Values that fit in a signed Dart int use [nativeSealNote].
Map<String, dynamic> nativeSealUnits(BigInt v, {Uint8List? dest20, String kind = 'send'}) {
  if (v < BigInt.zero || v.bitLength > 64) throw ArgumentError('u64');
  final unitsOverride = debugNativeSealUnits;
  if (unitsOverride != null && v.bitLength > 63) {
    return unitsOverride(v, dest20: dest20, kind: kind);
  }
  if (v.bitLength <= 63) return nativeSealNote(v.toInt(), dest20: dest20, kind: kind);
  final note = sealCoinbaseUnits(v, dest20: dest20, kind: kind);
  note['rangeProof'] = _fillRange(v, note);
  return note;
}

Map<String, dynamic> nativeSealNote(int v, {Uint8List? dest20, String kind = 'send'}) {
  final override = debugNativeSealNote;
  if (override != null) return override(v, dest20: dest20, kind: kind);
  // The wire range proof is the native BP+ blob. sealNote's pure-Dart
  // proveRange is a different object, and without libsodium it does not
  // return inside a send. The value opening stays here.
  final note = sealCoinbaseNote(v, dest20: dest20, kind: kind);
  note['rangeProof'] = _fillRange(BigInt.from(v), note);
  return note;
}

Uint8List _fillRange(BigInt v, Map<String, dynamic> note) {
  requireRangeOffUi();
  final lib = AdmitNative.tryLoad();
  if (lib == null) throw StateError('admit_native_required');
  final r = note['r'];
  if (r is! Uint8List || r.length != 32) throw StateError('admit_native_required');
  final blob = lib.proveRange(v, r);
  if (blob == null || blob.isEmpty || blob[0] != 2) {
    throw StateError('admit_native_required');
  }
  return blob;
}
