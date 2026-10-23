import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:shear_wallet/shear_admit_ffi.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_vault_reward.dart';

Uint8List _unhex(String hex) {
  final raw = hex.startsWith('0x') ? hex.substring(2) : hex;
  if (raw.length.isOdd) throw StateError('hex');
  final out = Uint8List(raw.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(raw.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

/// One reward claim through [postReserveVaultClaim] and [proveVaultLockReward].
Future<void> main() async {
  final path = Platform.environment['SHEAR_CLAIM_FIXTURE'];
  if (path == null || path.isEmpty) throw StateError('fixture');
  if (AdmitNative.tryLoad() == null) throw StateError('fs1_prover_unavailable');
  final raw = jsonDecode(File(path).readAsStringSync());
  if (raw is! Map) throw StateError('fixture');
  final lockRaw = raw['locks'];
  if (lockRaw is! List || lockRaw.isEmpty) throw StateError('locks');
  final locks = <Map<String, dynamic>>[];
  for (final row in lockRaw) {
    if (row is! Map) throw StateError('locks');
    locks.add({
      'amount': row['amount'],
      'scalar': _unhex(row['scalar'].toString()),
      'blind': _unhex(row['blind'].toString()),
      'unlockEpoch': row['unlockEpoch'] ?? row['unlock'],
      'index': row['index'] ?? 0,
    });
  }
  final proved = proveVaultLockRewardWire({
    'locks': locks,
    'which': 0,
    'rootEpoch': raw['rootEpoch'],
    'earnEpoch': raw['earnEpoch'],
    'bps': raw['bps'],
    'remainMs': raw['remainMs'],
    'span': raw['span'],
    'dest20': _unhex(raw['dest20'].toString()),
  });
  final posts = <Map<String, dynamic>>[];
  final pool = _ClaimPool(posts);
  final id = createIdentity();
  final dest = raw['dest'].toString();
  final ledger = ShearLedger(pool: pool)..bindIdentity(id);
  final reserve = ShearReserve()..epochStartMs = 0;
  reserve.portal(dest).claimableRewards = 1;
  final posted = await postReserveVaultClaim(
    ledger,
    reserve: reserve,
    dest: dest,
    payout: dest,
    nowMs: 1,
    spendSeed: _unhex(raw['seed'].toString()),
    vaultProof: proved,
    local: false,
    publicIpConsent: true,
  );
  if (posts.isEmpty || posted == null) throw StateError('no claim');
  stdout.writeln(jsonEncode(posts.single));
  pool.close();
}

class _ClaimPool extends ShearPoolClient {
  _ClaimPool(this.posts)
      : super(
          baseUrl: 'http://127.0.0.1:9',
          http: HttpClient()..connectionTimeout = const Duration(milliseconds: 50),
        );

  final List<Map<String, dynamic>> posts;

  @override
  Future<Map<String, dynamic>> postRaw(Map<String, dynamic> body) async {
    posts.add(body);
    return {'ok': true, 'id': body['id'] ?? 'claim'};
  }
}
