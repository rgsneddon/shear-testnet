import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:shear_wallet/shear_admit_ffi.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_reserve.dart';

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
  stdout.writeln(jsonEncode(posts.single));
  pool.close();
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
