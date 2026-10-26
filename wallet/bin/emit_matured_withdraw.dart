import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:shear_wallet/shear_admit_ffi.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_reserve.dart';

import 'emit_heights.dart';

Uint8List _unhex(String hex) {
  final raw = hex.startsWith('0x') ? hex.substring(2) : hex;
  if (raw.length.isOdd) throw StateError('hex');
  final out = Uint8List(raw.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(raw.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

/// Posts one matured withdraw through [postMaturedWithdraws]. The tranche
/// book is the fixture. A per-portal reserve query throws.
Future<void> main() async {
  final path = Platform.environment['SHEAR_WITHDRAW_FIXTURE'];
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
  final hostRaw = raw['host'];
  if (hostRaw is! Map) throw StateError('host');
  final host = <String, dynamic>{
    'kind': (hostRaw['kind'] ?? 'send').toString(),
    'commit': _unhex(hostRaw['commit'].toString()),
    'noteCommit': _unhex(hostRaw['noteCommit'].toString()),
    'r': _unhex(hostRaw['r'].toString()),
    'admitPub': _unhex(hostRaw['admitPub'].toString()),
    'nanos': hostRaw['nanos'],
    if (hostRaw['spendSeed'] != null) 'spendSeed': _unhex(hostRaw['spendSeed'].toString()),
  };
  final leafRaw = raw['leaves'];
  if (leafRaw is! List || leafRaw.isEmpty) throw StateError('leaves');
  final leaves = <Map<String, dynamic>>[];
  for (final row in leafRaw) {
    if (row is! Map) throw StateError('leaves');
    final epochs = row['epochs'];
    if (epochs is! List) throw StateError('epochs');
    leaves.add({
      'kind': 'lock',
      'scalar': _unhex(row['scalar'].toString()),
      'blind': _unhex(row['blind'].toString()),
      'note': _unhex(row['note'].toString()),
      'unlock': row['unlock'],
      'amount': row['amount'],
      'epochs': [for (final e in epochs) e is int ? e : int.parse(e.toString())],
      'withdrawPeriod': row['withdrawPeriod'],
      'portalId': row['portalId'].toString(),
      'lockIndex': row['lockIndex'] ?? 0,
    });
  }
  Uint8List? nonce;
  final nonceRaw = raw['nonce'];
  if (nonceRaw is String && nonceRaw.isNotEmpty) nonce = _unhex(nonceRaw);
  final posts = <Map<String, dynamic>>[];
  final pool = _BookPool(
    posts,
    {
      'pubs': pubs,
      'commits': commits,
      'anchors': [
        {'height': raw['anchor'], 'n': pubs.length},
      ],
      'spendTags': <Object>[],
    },
    raw['tranches'],
  );
  final id = createIdentity();
  final dest = raw['dest'].toString();
  final ledger = ShearLedger(pool: pool)..bindIdentity(id);
  ledger.rememberNote(host);
  for (final leaf in leaves) {
    ledger.rememberNote(leaf);
  }
  final reserve = ShearReserve()
    ..currentEpoch = raw['currentEpoch'] as int
    ..epochStartMs = raw['epochStartMs'] as int;
  reserve.portal(dest)
    ..staked = kPiSheNanos
    ..joined = true;
  // The chain's tip and the host note's mined height, as a chain read gives them.
  applyChainHeights(ledger, raw);
  final posted = await postMaturedWithdraws(
    ledger,
    reserve: reserve,
    dest: dest,
    payout: dest,
    nowMs: raw['nowMs'] as int,
    spendSeed: _unhex(raw['seed'].toString()),
    leaves: reserveLockLeaves(ledger.notes),
    local: false,
    publicIpConsent: true,
    withdrawNonce: nonce,
  );
  if (posts.isEmpty) throw StateError('no post ${posted.length}');
  Map<String, dynamic>? receipt;
  Map<String, dynamic>? change;
  for (final note in ledger.notes) {
    if (note['payoutSeed'] is Uint8List) receipt = note;
    if (note['changeSeed'] is Uint8List && note['payoutSeed'] == null) change = note;
  }
  stdout.writeln(jsonEncode(_json({
    'posted': posts.single,
    if (receipt != null) 'receipt': {
      'r': receipt['r'],
      'commit': receipt['commit'],
      'noteCommit': receipt['noteCommit'],
      'admitPub': receipt['admitPub'],
      'dest20': receipt['dest20'],
      'nanos': bodyNanos(posts.single),
      'payoutSeed': receipt['payoutSeed'],
      'portalId': receipt['portalId'],
      'withdrawNonce': receipt['withdrawNonce'],
    },
    if (change != null) 'changeNote': {
      'r': change['r'],
      'commit': change['commit'],
      'noteCommit': change['noteCommit'],
      'admitPub': change['admitPub'],
      'dest20': change['dest20'],
      'nanos': change['nanos'],
      'changeSeed': change['changeSeed'],
      'portalId': change['portalId'],
      'withdrawNonce': change['withdrawNonce'],
    },
  })));
  pool.close();
}

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Object? _json(Object? v) {
  if (v is Uint8List) return _hex(v);
  if (v is List) return [for (final row in v) _json(row)];
  if (v is Map) {
    return {for (final e in v.entries) e.key.toString(): _json(e.value)};
  }
  return v;
}

int bodyNanos(Map<String, dynamic> body) {
  final raw = body['nanos'];
  if (raw is int) return raw;
  if (raw is String) return int.parse(raw);
  return 0;
}

class _BookPool extends ShearPoolClient {
  _BookPool(this.posts, this.flux, this.book)
      : super(
          baseUrl: 'http://127.0.0.1:9',
          http: HttpClient()..connectionTimeout = const Duration(milliseconds: 50),
        );

  final List<Map<String, dynamic>> posts;
  final Map<String, dynamic> flux;
  final Object? book;

  @override
  Future<Map<String, dynamic>> fluxset() async => flux;

  @override
  Future<Map<String, dynamic>> reserveTrancheBook() async => {
        'ok': true,
        'tranches': book,
      };

  @override
  Future<Map<String, dynamic>> postRaw(Map<String, dynamic> body) async {
    posts.add(body);
    return {'ok': true, 'id': body['id'] ?? 'wd'};
  }
}
