import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:shear_wallet/shear_admit_ffi.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Object? _json(Object? v) {
  if (v is Uint8List) return _hex(v);
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

/// Spend a withdraw receipt through [ShearLedger.send]. The note's key is payoutSeed.
Future<void> main() async {
  final path = Platform.environment['SHEAR_SPEND_FIXTURE'];
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
  final note = raw['note'];
  if (note is! Map) throw StateError('note');
  final posts = <Map<String, dynamic>>[];
  final pool = _SpendPool(posts, {
    'pubs': pubs,
    'commits': commits,
    'anchors': [
      {'height': raw['anchor'], 'n': pubs.length},
    ],
    'spendTags': <Object>[],
  });
  final id = createIdentity(_unhex(raw['seed'].toString()));
  final ledger = ShearLedger(pool: pool)..bindIdentity(id);
  final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
  final nanos = note['nanos'] as int;
  final payNanos = raw['payNanos'] as int;
  ledger.rememberNote({
    'address': home,
    'dest': home,
    'kind': (note['kind'] ?? 'withdraw').toString(),
    'commit': _unhex(note['commit'].toString()),
    'noteCommit': _unhex(note['noteCommit'].toString()),
    'r': _unhex(note['r'].toString()),
    'admitPub': _unhex(note['admitPub'].toString()),
    'nanos': nanos,
    'amount': nanos / kUnitsPerShe,
    'payoutSeed': _unhex(note['payoutSeed'].toString()),
    'spendSeed': _unhex(note['payoutSeed'].toString()),
    'verified': true,
  });
  ledger.replaceFromBackup(
    address: home,
    spendable: nanos / kUnitsPerShe,
    pending: 0,
    txs: const [],
  );
  final to = raw['to'].toString();
  await ledger.send(
    from: home,
    to: to,
    amount: payNanos / kUnitsPerShe,
    kind: 'send',
    spendSeed: _unhex(raw['seed'].toString()),
    restFrame: id.address,
    paymentCode: id.paymentCode,
    local: false,
    allowPublicHttp: true,
    nanosWire: '$payNanos',
  );
  if (posts.isEmpty) throw StateError('no spend');
  stdout.writeln(jsonEncode(_json(posts.single)));
  pool.close();
}

class _SpendPool extends ShearPoolClient {
  _SpendPool(this.posts, this.flux)
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
    posts.add(body);
    return {'ok': true, 'id': body['id'] ?? 'spend'};
  }

  @override
  Future<Map<String, dynamic>> send({
    required String from,
    required String to,
    required double amount,
    Map<String, dynamic>? memoCt,
    String? open,
    String? sig,
    String? portalOpen,
    String? kind,
    String? programId,
    String? choice,
    int? currentEpoch,
    int? epochStartMs,
    String? change,
    String? spendPub,
    String? ephPub,
    List<dynamic>? vin,
    List<dynamic>? vout,
    dynamic excess,
    Map<String, dynamic>? admitProof,
    List<Map<String, dynamic>>? admitProofs,
    String? spendTag,
    int? fee,
    int paintedOwedNanos = 0,
    bool legacyPoolSend = false,
    bool publicConsent = false,
    String? nanosWire,
    String? id,
    String? withdrawNonce,
    String? portalId,
    String? payoutPortalId,
    String? fs1,
    int? anchor,
    String? lockAuth,
    String? ownerPub,
    String? vaultLockNote,
  }) async {
    final body = walletSendBody(
      from: from,
      to: to,
      amount: amount,
      memoCt: memoCt,
      open: open,
      sig: sig,
      portalOpen: portalOpen,
      kind: kind,
      programId: programId,
      choice: choice,
      currentEpoch: currentEpoch,
      epochStartMs: epochStartMs,
      change: change,
      spendPub: spendPub,
      ephPub: ephPub,
      vin: vin,
      vout: vout,
      excess: excess,
      admitProof: admitProof,
      admitProofs: admitProofs,
      spendTag: spendTag,
      fee: fee,
      paintedOwedNanos: paintedOwedNanos,
      nanosWire: nanosWire,
      id: id,
      withdrawNonce: withdrawNonce,
      portalId: portalId,
      payoutPortalId: payoutPortalId,
      fs1: fs1,
      anchor: anchor,
      lockAuth: lockAuth,
      ownerPub: ownerPub,
      vaultLockNote: vaultLockNote,
    );
    posts.add(body);
    return {'ok': true, 'id': body['id'] ?? 'spend', 'tx': body};
  }
}
