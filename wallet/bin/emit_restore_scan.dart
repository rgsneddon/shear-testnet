import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:shear_wallet/shear_admit_ffi.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_session.dart';

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

int _nanos(Map<String, dynamic> note) {
  final raw = note['verifiedNanos'] ?? note['nanos'];
  if (raw is int) return raw;
  if (raw is num) return raw.toInt();
  if (raw is String) return int.parse(raw);
  throw StateError('nanos');
}

/// Import a shewall taken before the vote and the withdraw, then rescan the
/// mined txs. The receipt, the withdraw change, and the vote change openings
/// are returned so each can be posted and mined.
Future<void> main() async {
  final path = Platform.environment['SHEAR_RESTORE_FIXTURE'];
  if (path == null || path.isEmpty) throw StateError('fixture');
  if (AdmitNative.tryLoad() == null) throw StateError('fs1_prover_unavailable');
  final raw = jsonDecode(File(path).readAsStringSync());
  if (raw is! Map) throw StateError('fixture');
  final txs = raw['txs'];
  if (txs is! List || txs.isEmpty) throw StateError('txs');
  final notes = _unhex(raw['notes'].toString());
  if (notes.length < 64 || notes.length % 64 != 0) throw StateError('notes');
  final pubs = <Uint8List>[];
  final commits = <Uint8List>[];
  for (var i = 0; i < notes.length; i += 64) {
    pubs.add(Uint8List.sublistView(notes, i, i + 32));
    commits.add(Uint8List.sublistView(notes, i + 32, i + 64));
  }
  final pool = _ScanPool({
    'pubs': pubs,
    'commits': commits,
    'anchors': [
      {'height': raw['anchor'], 'n': pubs.length},
    ],
    'spendTags': <Object>[],
  });
  final ledger = ShearLedger(pool: pool);
  final id = await importEncryptedShewall(
    src: File(raw['shewall'].toString()),
    password: raw['password'].toString(),
    ledger: ledger,
  );
  ledger.bindIdentity(id);
  ledger.ingestChainTxs(txs, dest: ledger.homeDest(id.address, paymentCode: id.paymentCode));
  Map<String, dynamic>? receipt;
  Map<String, dynamic>? withdrawChange;
  Map<String, dynamic>? voteChange;
  for (final note in ledger.notes) {
    if (note['payoutSeed'] is Uint8List) {
      receipt = note;
    } else if (note['changeSeed'] is Uint8List && note['withdrawNonce'] != null) {
      withdrawChange = note;
    } else if (note['changeSeed'] is Uint8List && note['portalId'] == null) {
      voteChange = note;
    }
  }
  if (receipt == null || withdrawChange == null || voteChange == null) {
    throw StateError('found receipt=${receipt != null} withdraw=${withdrawChange != null} vote=${voteChange != null} notes=${ledger.notes.length}');
  }
  Map<String, Object> opening(Map<String, dynamic> note, String seedKey) {
    final seed = note[seedKey];
    final commit = note['commit'];
    final noteCommit = note['noteCommit'];
    final r = note['r'];
    if (seed is! Uint8List || commit is! List<int> || noteCommit is! List<int> || r is! List<int>) {
      throw StateError('opening');
    }
    return {
      'kind': (note['kind'] ?? 'send').toString(),
      'commit': _hex(commit),
      'noteCommit': _hex(noteCommit),
      'r': _hex(r),
      'nanos': _nanos(note),
      'spendSeed': _hex(seed),
      if (note['payoutSeed'] is Uint8List) 'payoutSeed': _hex(note['payoutSeed'] as List<int>),
      if (note['changeSeed'] is Uint8List) 'changeSeed': _hex(note['changeSeed'] as List<int>),
    };
  }
  stdout.writeln(jsonEncode({
    'ok': true,
    'nextLockIndex': ledger.nextLockIndex,
    'receipt': _hex(receipt['commit'] as List<int>),
    'withdrawChange': _hex(withdrawChange['commit'] as List<int>),
    'voteChange': _hex(voteChange['commit'] as List<int>),
    'openings': {
      'receipt': opening(receipt, 'payoutSeed'),
      'withdrawChange': opening(withdrawChange, 'changeSeed'),
      'voteChange': opening(voteChange, 'changeSeed'),
    },
  }));
  pool.close();
}

class _ScanPool extends ShearPoolClient {
  _ScanPool(this.flux)
      : super(
          baseUrl: 'http://127.0.0.1:9',
          http: HttpClient()..connectionTimeout = const Duration(milliseconds: 50),
        );

  final Map<String, dynamic> flux;

  @override
  Future<Map<String, dynamic>> fluxset() async => flux;
}
