import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:shear_wallet/shear_admit_ffi.dart';
import 'package:shear_wallet/shear_withdraw.dart';

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Object? _json(Object? v) {
  if (v is Uint8List) return _hex(v);
  if (v is List<int>) return _hex(v);
  if (v is List) return [for (final row in v) _json(row)];
  if (v is Map) {
    return {for (final e in v.entries) e.key.toString(): _json(e.value)};
  }
  return v;
}

Uint8List _unhex(String hex) {
  final raw = hex.startsWith('0x') ? hex.substring(2) : hex;
  if (raw.length.isOdd) throw StateError('hex');
  final out = Uint8List(raw.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(raw.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

/// One compact lock from a chain fixture. The node queues the printed body.
void main() {
  final path = Platform.environment['SHEAR_LOCK_FIXTURE'];
  if (path == null || path.isEmpty) throw StateError('fixture');
  if (AdmitNative.tryLoad() == null) throw StateError('fs1_prover_unavailable');
  final raw = jsonDecode(File(path).readAsStringSync());
  if (raw is! Map) throw StateError('fixture');
  final inputs = <Map<String, dynamic>>[];
  final rows = raw['inputs'];
  if (rows is! List || rows.isEmpty) throw StateError('inputs');
  for (final row in rows) {
    if (row is! Map) throw StateError('inputs');
    inputs.add({
      'index': row['index'],
      'kind': (row['kind'] ?? 'pot').toString(),
      'commit': _unhex(row['commit'].toString()),
      'noteCommit': _unhex(row['noteCommit'].toString()),
      'r': _unhex(row['r'].toString()),
    });
  }
  final built = buildQueuedLockTx(
    spendSeed: _unhex(raw['seed'].toString()),
    lockIndex: (raw['lockIndex'] as int?) ?? 0,
    lockEpoch: (raw['lockEpoch'] as int?) ?? 0,
    proveHeight: (raw['proveHeight'] as int?) ?? 0,
    anchor: raw['anchor'] as int,
    fluxNotes: _unhex(raw['notes'].toString()),
    inputs: inputs,
    inputNanos: raw['inputNanos'] as int,
    changeDest20: _unhex(raw['changeDest20'].toString()),
    id: raw['id'].toString(),
  );
  if (built == null) throw StateError('lock');
  final change = built['change'];
  if (change is! Map) throw StateError('change');
  stdout.writeln(jsonEncode(_json({
    'tx': built['tx'],
    'scalar': built['scalar'],
    'blind': built['blind'],
    'note': built['note'],
    'unlock': built['unlock'],
    'commit': built['commit'],
    'portalId': built['portalId'],
    'fee': built['fee'],
    'changeNanos': built['changeNanos'],
    'change': {
      'r': change['r'],
      'commit': change['commit'],
      'noteCommit': change['noteCommit'],
      'admitPub': change['admitPub'],
      'kind': 'send',
    },
  })));
}
