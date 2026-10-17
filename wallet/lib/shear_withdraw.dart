import 'dart:typed_data';

/// A withdraw the wallet can ship. It spends an FS-1 note and carries the
/// retire proof and the principal opening. A plaintext `from` is refused.
/// The proofs are the caller's. This function does not invent them.
Map<String, Object?>? buildFundedWithdraw({
  required String to,
  required int nanos,
  required String id,
  required String portalId,
  required int anchor,
  required List<int> excess,
  required List<int> fs1,
  required List<Map<String, Object?>> vin,
  required List<Map<String, Object?>> admitProofs,
  required Object retireProof,
  required Object principalProof,
  String payoutPortalId = '',
  int fee = 0,
  List<Map<String, Object?>>? vout,
  String ownerPub = '',
  List<int>? rewardSig,
  String from = '',
  String payer = '',
}) {
  if (from.isNotEmpty || payer.isNotEmpty) return null;
  if (to.isEmpty || nanos < 0 || id.isEmpty || portalId.isEmpty) return null;
  if (anchor < 0 || excess.length != 32 || fs1.isEmpty || fs1[0] != 0xf1) return null;
  if (vin.isEmpty || vin.length != admitProofs.length || vin.length > 8) return null;
  for (var i = 0; i < vin.length; i++) {
    if (vin[i]['address'] != null || vin[i]['dest20'] != null) return null;
    final blob = admitProofs[i]['blob'];
    if (blob is! List<int> && blob is! Uint8List) return null;
    final raw = blob is Uint8List ? blob : Uint8List.fromList(blob as List<int>);
    if (raw.isEmpty || raw[0] != 0xf1) return null;
  }
  final pay = payoutPortalId.isEmpty ? portalId : payoutPortalId;
  return {
    'id': id,
    'kind': 'withdraw',
    'to': to,
    'nanos': nanos,
    'portalId': portalId,
    'payoutPortalId': pay,
    'anchor': anchor,
    'fee': fee,
    'vin': [
      for (final row in vin)
        {
          'commit': row['commit'],
        },
    ],
    'vout': vout ?? <Map<String, Object?>>[],
    'fs1': fs1,
    'excess': excess,
    'admit_proofs': admitProofs,
    'retireProof': retireProof,
    'principalProof': principalProof,
    if (ownerPub.isNotEmpty) 'ownerPub': ownerPub,
    if (rewardSig != null) 'rewardSig': rewardSig,
  };
}
