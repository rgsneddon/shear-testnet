import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:shear_wallet/shear_admit_ffi.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_vault_reward.dart' show kPiSheNanos;

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

/// One lock through [ShearLedger.send], which calls [sealSignReserveWire].
Future<void> main() async {
  final path = Platform.environment['SHEAR_LOCK_FIXTURE'];
  if (path == null || path.isEmpty) throw StateError('fixture');
  if (AdmitNative.tryLoad() == null) throw StateError('fs1_prover_unavailable');
  final raw = jsonDecode(File(path).readAsStringSync());
  if (raw is! Map) throw StateError('fixture');
  final notes = _unhex(raw['notes'].toString());
  if (notes.length < 64 || notes.length % 64 != 0) throw StateError('notes');
  final pubs = <Uint8List>[];
  final commits = <Uint8List>[];
  for (var i = 0; i < notes.length; i += 64) {
    pubs.add(Uint8List.sublistView(notes, i, i + 32));
    commits.add(Uint8List.sublistView(notes, i + 32, i + 64));
  }
  final rows = raw['inputs'];
  if (rows is! List || rows.isEmpty) throw StateError('inputs');
  final dest = raw['dest'].toString();
  if (dest.isEmpty) throw StateError('dest');
  final posts = <Map<String, dynamic>>[];
  final pool = _LockPool(posts, {
    'pubs': pubs,
    'commits': commits,
    'anchors': [
      {'height': raw['anchor'], 'n': pubs.length},
    ],
    'spendTags': <Object>[],
  });
  final ledger = ShearLedger(pool: pool);
  final seed = _unhex(raw['seed'].toString());
  ledger.spendSeed = seed;
  for (final row in rows) {
    if (row is! Map) throw StateError('inputs');
    ledger.rememberNote({
      'address': dest,
      'dest': dest,
      'kind': (row['kind'] ?? 'pot').toString(),
      'commit': _unhex(row['commit'].toString()),
      'noteCommit': _unhex(row['noteCommit'].toString()),
      'r': _unhex(row['r'].toString()),
      'nanos': row['nanos'],
      'verified': true,
    });
  }
  await ledger.send(
    from: dest,
    to: dest,
    amount: kPiSheNanos / kUnitsPerShe,
    kind: 'lock',
    spendSeed: seed,
    lockEpoch: (raw['lockEpoch'] as int?) ?? 0,
    local: false,
    allowPublicHttp: true,
  );
  final built = ledger.lastSealedLock;
  if (posts.isEmpty || built == null) throw StateError('lock');
  final change = built['change'];
  if (change is! Map) throw StateError('change');
  stdout.writeln(jsonEncode(_json({
    'tx': posts.single,
    'scalar': built['scalar'],
    'blind': built['blind'],
    'note': built['note'],
    'unlock': built['unlock'],
    'commit': built['commit'],
    'portalId': built['portalId'],
    'fee': built['fee'],
    'changeNanos': built['changeNanos'],
    'changeSeed': built['changeSeed'],
    'change': {
      'r': change['r'],
      'commit': change['commit'],
      'noteCommit': change['noteCommit'],
      'admitPub': change['admitPub'],
      'kind': 'send',
    },
  })));
  pool.close();
}

class _LockPool extends ShearPoolClient {
  _LockPool(this.posts, this.flux)
      : super(
          baseUrl: 'http://127.0.0.1:9',
          http: HttpClient()..connectionTimeout = const Duration(milliseconds: 50),
        );

  final List<Map<String, dynamic>> posts;
  final Map<String, dynamic> flux;

  @override
  Future<Map<String, dynamic>> fluxset() async => flux;

  @override
  Future<Map<String, dynamic>> reserveTrancheBook() async => {'ok': true, 'tranches': const []};

  @override
  Future<Map<String, dynamic>> postRaw(Map<String, dynamic> body) async {
    posts.add(body);
    return {'ok': true, 'id': body['id'] ?? 'lock'};
  }
}
