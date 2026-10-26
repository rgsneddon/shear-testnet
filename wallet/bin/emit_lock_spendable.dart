import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:shear_wallet/shear_admit_ffi.dart';
import 'package:shear_wallet/shear_identity.dart';
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

/// The wallet's Spendable in protocol units, as the shell paints it: read
/// from the notes and the header depth, never set.
int _spendableUnits(ShearLedger ledger, ShearIdentity id) {
  ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
  return (ledger.spendableOwned(id.address, paymentCode: id.paymentCode) * kUnitsPerShe).round();
}

int _pendingUnits(ShearLedger ledger, ShearIdentity id) =>
    (ledger.pending(id.address, paymentCode: id.paymentCode) * kUnitsPerShe).round();

/// SHEAR_LOCK_PHASE=lock: one confirmed note, Spendable, the real lock
/// (ledger.send, the GUI path), Spendable and Pending after it, and the
/// session notes the wallet would save.
/// SHEAR_LOCK_PHASE=confirm: those session notes restored as a restarted
/// wallet restores them, with the lock block's height on the lock and its
/// change, and Spendable read again at the new tip.
Future<void> main() async {
  final path = Platform.environment['SHEAR_LOCK_FIXTURE'];
  final phase = Platform.environment['SHEAR_LOCK_PHASE'] ?? 'lock';
  if (path == null || path.isEmpty) throw StateError('fixture');
  final raw = jsonDecode(File(path).readAsStringSync());
  if (raw is! Map) throw StateError('fixture');
  final seed = _unhex(raw['seed'].toString());
  final id = createIdentity(seed);
  final tip = raw['tip'] as int;
  if (phase == 'confirm') {
    final ledger = ShearLedger()..bindIdentity(id);
    final height = raw['lockHeight'] as int;
    final rows = <Map<String, dynamic>>[];
    for (final row in (raw['session'] as List)) {
      final r = Map<String, dynamic>.from(row as Map);
      if (r['height'] == null && r['spent'] != true) r['height'] = height;
      rows.add(r);
    }
    ledger.restoreSessionNotes(rows);
    ledger.noteLiveHeight(tip);
    ledger.settleTo(tip);
    stdout.writeln(jsonEncode({
      'spendable': _spendableUnits(ledger, id),
      'pending': _pendingUnits(ledger, id),
    }));
    return;
  }
  if (AdmitNative.tryLoad() == null) throw StateError('fs1_prover_unavailable');
  final notes = _unhex(raw['notes'].toString());
  if (notes.length < 64 || notes.length % 64 != 0) throw StateError('notes');
  final pubs = <Uint8List>[];
  final commits = <Uint8List>[];
  for (var i = 0; i < notes.length; i += 64) {
    pubs.add(Uint8List.sublistView(notes, i, i + 32));
    commits.add(Uint8List.sublistView(notes, i + 32, i + 64));
  }
  final posts = <Map<String, dynamic>>[];
  final pool = _LockPool(posts, {
    'pubs': pubs,
    'commits': commits,
    'anchors': [
      {'height': raw['anchor'], 'n': pubs.length},
    ],
    'spendTags': <Object>[],
  });
  final ledger = ShearLedger(pool: pool)..bindIdentity(id);
  ledger.spendSeed = seed;
  final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
  final input = raw['input'] as Map;
  final nanos = input['nanos'] as int;
  ledger.rememberNote({
    'address': home,
    'dest': home,
    'kind': 'send',
    'commit': _unhex(input['commit'].toString()),
    'noteCommit': _unhex(input['noteCommit'].toString()),
    'r': _unhex(input['r'].toString()),
    'admitPub': _unhex(input['admitPub'].toString()),
    'nanos': nanos,
    'amount': nanos / kUnitsPerShe,
    'height': input['height'] as int,
    'spendSeed': seed,
    'verified': true,
  });
  ledger.noteLiveHeight(tip);
  ledger.settleTo(tip);
  final before = _spendableUnits(ledger, id);
  await ledger.send(
    from: home,
    to: home,
    amount: kPiSheNanos / kUnitsPerShe,
    kind: 'lock',
    spendSeed: seed,
    restFrame: id.address,
    paymentCode: id.paymentCode,
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
    'before': before,
    'after': _spendableUnits(ledger, id),
    'pendingAfter': _pendingUnits(ledger, id),
    'fee': built['fee'],
    'changeNanos': built['changeNanos'],
    'change': {
      'r': change['r'],
      'commit': change['commit'],
      'noteCommit': change['noteCommit'],
      'admitPub': change['admitPub'],
      'kind': 'send',
    },
    'changeSeed': built['changeSeed'],
    'session': ledger.exportNotesForSession(),
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
