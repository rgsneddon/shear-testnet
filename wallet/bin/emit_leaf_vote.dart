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

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Object? _json(Object? v) {
  if (v is Uint8List) return _hex(v);
  if (v is List<int>) return _hex(v);
  if (v is List) return [for (final row in v) _json(row)];
  if (v is Map) return {for (final e in v.entries) e.key.toString(): _json(e.value)};
  return v;
}

/// One leaf vote through [castPlannedLeafVotes]. The census numbers are the
/// chain's. The fee note is a coinbase pot the wallet holds.
Future<void> main() async {
  final path = Platform.environment['SHEAR_VOTE_FIXTURE'];
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
  final feeRaw = raw['fee'];
  final leafRaw = raw['leaf'];
  if (feeRaw is! Map || leafRaw is! Map) throw StateError('fixture');
  final epochs = leafRaw['epochs'];
  if (epochs is! List || epochs.isEmpty) throw StateError('epochs');
  final seed = _unhex(raw['seed'].toString());
  final id = createIdentity(seed);
  final dest = id.address;
  final open = raw['openHeight'] as int;
  final epoch = raw['epoch'] as int;
  final leaves = raw['leafCount'] as int;
  final posts = <Map<String, dynamic>>[];
  final pool = _VotePool(posts, {
    'pubs': pubs,
    'commits': commits,
    'anchors': [
      {'height': raw['anchor'], 'n': pubs.length},
    ],
    'spendTags': <Object>[],
  });
  final ledger = ShearLedger(pool: pool)..bindIdentity(id);
  final home = ledger.homeDest(dest, paymentCode: id.paymentCode);
  ledger.replaceFromBackup(address: dest, spendable: 10, pending: 0, txs: const []);
  ledger.rememberNodeChain(bodies: [
    {
      'height': open,
      'txs': [
        {
          'coinbase': true,
          'epochCensusCommit': [
            {'epoch': epoch, 'leafCount': leaves, 'openHeight': open},
          ],
        },
      ],
    },
  ]);
  ledger.rememberNote({
    'kind': 'pot',
    'commit': _unhex(feeRaw['commit'].toString()),
    'noteCommit': _unhex(feeRaw['noteCommit'].toString()),
    'r': _unhex(feeRaw['r'].toString()),
    'admitPub': _unhex(feeRaw['admitPub'].toString()),
    'nanos': feeRaw['nanos'],
    'address': home,
    'dest': home,
    'verified': true,
  });
  ledger.rememberNote({
    'kind': 'lock',
    'scalar': _unhex(leafRaw['scalar'].toString()),
    'blind': _unhex(leafRaw['blind'].toString()),
    'note': _unhex(leafRaw['note'].toString()),
    'unlock': leafRaw['unlock'],
    'amount': leafRaw['amount'],
    'epochs': [for (final e in epochs) e is int ? e : int.parse(e.toString())],
    'portalId': leafRaw['portalId'].toString(),
    'lockIndex': leafRaw['lockIndex'] ?? 0,
  });
  final reserve = ShearReserve()..currentEpoch = epoch;
  reserve.portal(dest).staked = kPiSheNanos;
  final dir = Directory.systemTemp.createTempSync('shear-e2e-vote-');
  // The plan writer accepts only a 0700 folder. createTempSync is 0755.
  if (Process.runSync('chmod', ['700', dir.path]).exitCode != 0) {
    throw StateError('vote_plan_mode');
  }
  final result = await castPlannedLeafVotes(
    ledger: ledger,
    reserve: reserve,
    planDir: dir.path,
    dest: dest,
    choice: kVoteIncrease,
    restFrame: dest,
    spendSeed: seed,
    local: false,
    publicIpConsent: true,
  );
  if (!result.enacted || posts.isEmpty) {
    throw StateError('vote ${result.remark}');
  }
  Map<String, dynamic>? change;
  for (final note in ledger.notes) {
    if (note['changeSeed'] is Uint8List && note['payoutSeed'] == null) change = note;
  }
  stdout.writeln(jsonEncode(_json({
    'posted': posts.single,
    if (change != null) 'change': {
      'commit': change['commit'],
      'noteCommit': change['noteCommit'],
      'r': change['r'],
      'admitPub': change['admitPub'],
      'dest20': change['dest20'],
      'nanos': change['nanos'],
      'changeSeed': change['changeSeed'],
    },
  })));
  pool.close();
  dir.deleteSync(recursive: true);
}

class _VotePool extends ShearPoolClient {
  _VotePool(this.posts, this.flux)
      : super(
          baseUrl: 'http://127.0.0.1:9',
          http: HttpClient()..connectionTimeout = const Duration(milliseconds: 50),
        );

  final List<Map<String, dynamic>> posts;
  final Map<String, dynamic> flux;

  @override
  Future<Map<String, dynamic>> fluxset() async => flux;

  @override
  Future<Map<String, dynamic>> postRaw(Map<String, dynamic> body) async {
    posts.add(Map<String, dynamic>.from(body));
    return {'ok': true, 'id': body['id'] ?? 'leaf-vote'};
  }
}
