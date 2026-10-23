import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_admit.dart';
import 'shear_admit_ffi.dart';
import 'shear_ed25519.dart';
import 'shear_eip712.dart';
import 'shear_fs1.dart';
import 'shear_identity.dart' show kBookMagic;
import 'shear_levy.dart' show kLevyCapNanos;
import 'shear_note.dart';
import 'shear_pack.dart';
import 'shear_ristretto.dart';
import 'shear_vault_reward.dart';

/// A withdraw the wallet can ship. It spends an FS-1 note and carries the
/// retire proof and the principal opening. A plaintext `from` is refused.
/// The payout is a one-time dest20. `to` and `payoutPortalId` are not on
/// the body. The proofs are the caller's. This function does not invent them.
Map<String, Object?>? buildFundedWithdraw({
  required List<int> dest20,
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
  int fee = 0,
  List<Map<String, Object?>>? vout,
  String ownerPub = '',
  List<int>? rewardSig,
  String from = '',
  String payer = '',
}) {
  if (from.isNotEmpty || payer.isNotEmpty) return null;
  if (dest20.length != 20 || nanos < 0 || id.isEmpty || portalId.isEmpty) return null;
  if (anchor < 0 || excess.length != 32 || fs1.isEmpty || fs1[0] != 0xf1) return null;
  if (vin.isEmpty || vin.length != admitProofs.length || vin.length > 8) return null;
  for (var i = 0; i < vin.length; i++) {
    if (vin[i]['address'] != null || vin[i]['dest20'] != null) return null;
    final blob = admitProofs[i]['blob'];
    if (blob is! List<int> && blob is! Uint8List) return null;
    final raw = blob is Uint8List ? blob : Uint8List.fromList(blob as List<int>);
    if (raw.isEmpty || raw[0] != 0xf1) return null;
  }
  return {
    'id': id,
    'kind': 'withdraw',
    'nanos': nanos,
    'portalId': portalId,
    'dest20': Uint8List.fromList(dest20),
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

Uint8List _u64(int n) {
  final b = Uint8List(8);
  final data = ByteData.sublistView(b);
  data.setUint64(0, n < 0 ? 0 : n, Endian.little);
  return b;
}

Uint8List _u32(int n) {
  final b = Uint8List(4);
  final data = ByteData.sublistView(b);
  data.setUint32(0, n < 0 ? 0 : n, Endian.little);
  return b;
}

Uint8List _i64(int n) {
  final b = Uint8List(8);
  final data = ByteData.sublistView(b);
  data.setInt64(0, n, Endian.little);
  return b;
}

Uint8List _cat(List<List<int>> parts) {
  var n = 0;
  for (final p in parts) {
    n += p.length;
  }
  final out = Uint8List(n);
  var o = 0;
  for (final p in parts) {
    out.setRange(o, o + p.length, p);
    o += p.length;
  }
  return out;
}

Uint8List _sha(List<int> msg) => Uint8List.fromList(sha256.convert(msg).bytes);

Uint8List _lenPref(List<int> body) => _cat([_u32(body.length), body]);

Uint8List _hex32(String hex) {
  final raw = hex.startsWith('0x') ? hex.substring(2) : hex;
  final out = Uint8List(32);
  for (var i = 0; i < 32; i++) {
    out[i] = int.parse(raw.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

List<int> _asBytes(Object? v) {
  if (v is Uint8List) return v;
  if (v is List<int>) return v;
  if (v is String && v.length % 2 == 0) {
    final hex = v.startsWith('0x') ? v.substring(2) : v;
    final out = Uint8List(hex.length ~/ 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16);
    }
    return out;
  }
  return const [];
}

/// JS `reserveDigestSuffix` for a withdraw. A withdraw output is not a lock,
/// so the bound unlock is 0 and the bound lock epoch is -1.
Uint8List jsReserveSuffix({
  required String portalId,
  required String payoutPortalId,
  required String programId,
  required int nanos,
  required String id,
  required List<int> nonce,
  List<int> commit = const [],
}) {
  final word = commit.length == 32 ? commit : const <int>[];
  return _cat([
    utf8Bytes('reserveact1'),
    _lenPref(utf8Bytes('withdraw')),
    _lenPref(utf8Bytes(portalId.toLowerCase())),
    _lenPref(utf8Bytes(payoutPortalId.toLowerCase())),
    _lenPref(utf8Bytes(programId)),
    _lenPref(utf8Bytes('')),
    _i64(nanos),
    word,
    _i64(0),
    _i64(-1),
    _lenPref(utf8Bytes(id)),
    nonce.length == 32 ? nonce : Uint8List(32),
  ]);
}

/// JS `txDigestV3` for the withdraw body this builder posts.
Uint8List withdrawTxDigest({
  required Map<String, Object?> tx,
  required String magic,
}) {
  final anchor = (tx['anchor'] as int?) ?? 0;
  final fee = (tx['fee'] as int?) ?? 0;
  final vins = (tx['vin'] as List?) ?? const [];
  final proofs = (tx['admit_proofs'] as List?) ?? const [];
  final outs = (tx['vout'] as List?) ?? const [];
  final parts = <List<int>>[
    utf8Bytes('shear-admit-v3-txd'),
    [0x03],
    utf8Bytes(magic),
    _lenPref(utf8Bytes('withdraw')),
    _u64(anchor),
    _u64(fee),
    _u64(0),
    Uint8List(32),
    _u32(vins.length),
  ];
  for (var i = 0; i < vins.length; i++) {
    final proof = i < proofs.length && proofs[i] is Map ? proofs[i] as Map : const {};
    final tag = _asBytes(proof['spendTag']);
    final tilde = _asBytes(proof['cTilde']);
    final vin = vins[i] is Map ? vins[i] as Map : const {};
    final commit = tilde.length == 32 ? tilde : _asBytes(vin['commit']);
    parts.add(tag.length == 32 ? tag : Uint8List(32));
    parts.add(commit.length == 32 ? commit : Uint8List(32));
  }
  parts.add(_u32(outs.length));
  for (final row in outs) {
    final o = row is Map ? row : const {};
    final kind = (o['kind'] ?? 'withdraw').toString();
    final rp = _asBytes(o['rangeProof']);
    final view = _asBytes(o['viewTag']);
    final publicNanos = kind == 'lock' || kind == 'vote' || kind == 'withdraw'
        ? ((o['nanos'] as int?) ?? (tx['nanos'] as int?) ?? 0)
        : 0;
    final d20 = _asBytes(o['dest20']);
    parts.add(_lenPref(utf8Bytes(kind)));
    parts.add(_asBytes(o['commit']).length == 32 ? _asBytes(o['commit']) : Uint8List(32));
    parts.add(_asBytes(o['admitPub']).length == 32 ? _asBytes(o['admitPub']) : Uint8List(32));
    parts.add(_asBytes(o['noteCommit']).length == 32 ? _asBytes(o['noteCommit']) : Uint8List(32));
    parts.add(_asBytes(o['rEph']).length == 32 ? _asBytes(o['rEph']) : Uint8List(32));
    parts.add(_lenPref(_asBytes(o['rCt'])));
    parts.add(_lenPref(_asBytes(o['memoCt'])));
    parts.add(view.isEmpty ? [0] : [view[0]]);
    parts.add(_sha(rp));
    parts.add(_u64(publicNanos));
    parts.add(_lenPref(d20.length >= 20 ? d20.sublist(0, 20) : const []));
    parts.add([0xa7]);
    parts.add(_lenPref(_asBytes(o['amtCt'])));
  }
  parts.add(_lenPref(utf8Bytes((tx['portalId'] ?? '').toString().toLowerCase())));
  parts.add(_lenPref(utf8Bytes((tx['programId'] ?? '').toString())));
  parts.add(_lenPref(utf8Bytes((tx['payoutPortalId'] ?? '').toString().toLowerCase())));
  final nonce = _asBytes(tx['withdrawNonce']);
  List<int> boundCommit = const [];
  for (final row in outs) {
    final o = row is Map ? row : const {};
    final kind = (o['kind'] ?? '').toString();
    if (kind != 'withdraw' && kind != 'lock' && kind != 'vote') continue;
    final commit = _asBytes(o['commit']);
    if (commit.length == 32) {
      boundCommit = commit;
      break;
    }
  }
  parts.add(jsReserveSuffix(
    portalId: (tx['portalId'] ?? '').toString(),
    payoutPortalId: (tx['payoutPortalId'] ?? '').toString(),
    programId: (tx['programId'] ?? '').toString(),
    nanos: (tx['nanos'] as int?) ?? 0,
    id: (tx['id'] ?? '').toString(),
    nonce: nonce,
    commit: boundCommit,
  ));
  return _sha(_cat(parts));
}

Element _unlockBase() =>
    pointFrom(fromHashBytes(sha512Bytes(utf8Bytes('shear-vault-unlock-base-v1'))));

/// Owner point || commit(amount) + unlock·U. The same leaf JS `vaultLockNote` builds.
Uint8List vaultLeafNote({
  required int amount,
  required List<int> scalar,
  required List<int> blind,
  required int unlock,
}) {
  final pub = mulGBytes(Uint8List.fromList(scalar));
  var commit = commitBytes(amount, Uint8List.fromList(blind));
  if (unlock != 0) {
    commit = addBytes(
      commit,
      mulBytes(pointBytes(_unlockBase()), scalarBytes(scalarFromU64(BigInt.from(unlock)))),
    );
  }
  return _cat([pub, commit]);
}

Uint8List _nullBase(int epoch) =>
    pointBytes(hashToRistretto(_u64(epoch), utf8Bytes('shear-vault-null-epoch-v1')));

/// One retire proof. Layout matches `proveLeafRetire`.
Uint8List? proveLeafRetireBytes({
  required List<int> scalar,
  required List<int> epochs,
  required List<int> leaf,
  required List<int> txBind,
  required int unlockEpoch,
  required String magic,
}) {
  if (scalar.length != 32 || leaf.length != 64 || txBind.length != 32 || epochs.isEmpty) {
    return null;
  }
  final seen = <int>{};
  final rows = <Uint8List>[];
  final p1 = leaf.sublist(0, 32);
  for (final epoch in epochs) {
    if (epoch < 0 || !seen.add(epoch)) return null;
    final k = scalarBytes(randomScalar());
    final x = Uint8List.fromList(scalar);
    final owner = Uint8List.fromList(p1);
    final bind = Uint8List.fromList(txBind);
    final a1 = mulGBytes(k);
    final base = _nullBase(epoch);
    final a2 = mulBytes(base, k);
    final p2 = mulBytes(base, x);
    final claim = _sha([...utf8Bytes('shear-vault-null-prf-v1'), ...p2]);
    final retire = _sha([...utf8Bytes('shear-vault-retire-null-v1'), ...p2, ..._u64(epoch)]);
    final e = hashToScalar([
      utf8Bytes('shear-vault-retire-dleq-v1'),
      _u64(epoch),
      a1,
      a2,
      owner,
      claim,
      retire,
      utf8Bytes(magic),
      bind,
    ]);
    final s = scalarBytes(scalarAdd(scalarFromBytes(k), scalarMul(e, scalarFromBytes(x))));
    rows.add(_cat([_u64(epoch), a1, a2, s, claim, retire]));
  }
  return _cat([_u64(unlockEpoch), _u32(rows.length), ...rows, leaf, txBind]);
}

Map<String, Object?>? provePrincipalOpenBytes({
  required List<int> commit,
  required int amount,
  required List<int> blind,
  required List<int> digest,
  required String portalId,
  int unlock = 0,
}) {
  if (commit.length != 32 || blind.length != 32 || digest.length != 32) return null;
  final portal = _hex32(portalId);
  final extra = _cat([utf8Bytes('shear-withdraw-principal-v1'), digest, portal]);
  final funded = subBytes(Uint8List.fromList(commit), mulGBytes(scalarBytes(scalarFromU64(BigInt.from(amount)))));
  final p = unlock == 0
      ? funded
      : subBytes(funded, mulBytes(pointBytes(_unlockBase()), scalarBytes(scalarFromU64(BigInt.from(unlock)))));
  final sig = schnorrProveHBytes(p, Uint8List.fromList(blind), extra);
  return {
    'R': sig['R'],
    'z': sig['z'],
    'opened': amount,
    if (unlock != 0) 'unlock': unlock.toString(),
  };
}

/// JS spend message: packed body, portal, payout, fee, admit blobs, and the
/// JS reserve suffix. The extra unlock and lock-epoch words are not hashed.
Uint8List jsWithdrawSpendMessage(Map<String, Object?> tx) {
  final vout = <Map<String, dynamic>>[
    for (final row in (tx['vout'] as List? ?? const []))
      if (row is Map) Map<String, dynamic>.from(row),
  ];
  final vin = <Map<String, dynamic>>[
    for (final row in (tx['vin'] as List? ?? const []))
      if (row is Map) Map<String, dynamic>.from(row),
  ];
  final packed = spendPackDigest(from: '', vout: vout, kind: 'withdraw', vin: vin);
  final portal = (tx['portalId'] ?? '').toString().toLowerCase();
  final payout = (tx['payoutPortalId'] ?? '').toString().toLowerCase();
  final fee = (tx['fee'] as int?) ?? 0;
  final proofs = (tx['admit_proofs'] as List?) ?? const [];
  final blobs = <List<int>>[
    for (final proof in proofs)
      if (proof is Map) _asBytes(proof['blob'] ?? proof['proof']),
  ];
  final suffix = jsReserveSuffix(
    portalId: portal,
    payoutPortalId: payout,
    programId: (tx['programId'] ?? '').toString(),
    nanos: (tx['nanos'] as int?) ?? 0,
    id: (tx['id'] ?? '').toString(),
    nonce: _asBytes(tx['withdrawNonce']),
  );
  final chunks = <List<int>>[
    packed,
    utf8Bytes(portal),
    utf8Bytes(payout),
    _u64(fee),
    _u32(blobs.length),
    for (final blob in blobs) _lenPref(blob),
    suffix,
  ];
  return _sha([...utf8Bytes('shear-spend-v1'), ..._sha(_cat(chunks))]);
}

const _kWithdrawOwnerTag = 'shear-withdraw-owner-v1';
const _kPortalOwnerTag = 'shear-portal-owner-v1';
const _kTrancheSetTag = 'shear-tranche-set-v1';
const _kWithdrawChainId = 2701;

/// Same chain as JS `trancheSetHash`. Matured plain tranches only.
Uint8List trancheSetHash(List<Map<String, Object?>> tranches, int chain) {
  var h = _sha(utf8Bytes(_kTrancheSetTag));
  final at = chain < 0 ? 0 : chain;
  for (final tranche in tranches) {
    final epoch = tranche['epoch'] is int ? tranche['epoch'] as int : 0;
    if (at <= epoch) continue;
    if (tranche['noteIsPrincipal'] == true || tranche['notePrincipal'] == true) continue;
    final commit = _asBytes(tranche['commit']);
    final raw = commit.length == 32 ? Uint8List.fromList(commit) : Uint8List(32);
    final remainRaw = tranche['remainMs'];
    final remain = remainRaw is int && remainRaw > 0 ? remainRaw : 0;
    h = _sha(<int>[...h, ...raw, ..._u256be(epoch < 0 ? 0 : epoch), ..._u256be(remain)]);
  }
  return h;
}

Uint8List _u256be(int n) {
  final b = Uint8List(32);
  var x = BigInt.from(n < 0 ? 0 : n);
  for (var i = 31; i >= 0; i--) {
    b[i] = (x & BigInt.from(0xff)).toInt();
    x >>= 8;
  }
  return b;
}

String _hexOf(List<int> raw) =>
    raw.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

/// The lock's portal spend key when the leaf names its lockIndex.
/// A leaf with no index keeps the portal-owner tag key.
Uint8List? _withdrawOwnerSeed(Uint8List spendSeed, String portalId, List<Map<String, Object?>> leaves) {
  int? index;
  for (final leaf in leaves) {
    final named = leaf['lockIndex'];
    if (named is! int) continue;
    if (index == null) index = named;
    else if (index != named) return null;
  }
  if (index != null) return reservePortalSpendSeed(spendSeed, index);
  return _portalOwnerSeed(spendSeed, portalId);
}

/// sha256(portal-owner tag || spend seed || portal id). One key per portal.
Uint8List? _portalOwnerSeed(Uint8List spendSeed, String portalId) {
  final hex = portalId.startsWith('0x') ? portalId.substring(2) : portalId;
  if (spendSeed.length != 32 || hex.length != 64) return null;
  return _sha(_cat([
    utf8Bytes(_kPortalOwnerTag),
    spendSeed,
    _hex32(hex),
  ]));
}

/// JS `withdrawOwnerMessage`. The destination is the dest20 hex, not an address.
Uint8List? _withdrawOwnerMessage({
  required String portalId,
  required int nanos,
  required String dest,
  required Uint8List magic,
  required int chainId,
  required int epoch,
  required Uint8List trancheSet,
  required Uint8List txBind,
}) {
  final hex = portalId.startsWith('0x') ? portalId.substring(2) : portalId;
  if (hex.length != 64 || nanos < 0 || magic.length != 32 || trancheSet.length != 32) {
    return null;
  }
  if (chainId < 0 || epoch < 0 || txBind.length != 32) return null;
  final destBuf = utf8Bytes(dest);
  return _cat([
    utf8Bytes(_kWithdrawOwnerTag),
    _hex32(hex),
    _u64(nanos),
    magic,
    _u64(chainId),
    _u64(epoch),
    trancheSet,
    txBind,
    _u32(destBuf.length),
    destBuf,
  ]);
}

/// A withdraw that generates one retire proof and one principal opening per
/// leaf, the portal-owner signature over the one-time dest20, and the spend
/// signature. [leaves] each carry `scalar`, `blind`, `note` (64 bytes),
/// `unlock` (the epoch inside the note), and `epochs`. [dest20] is the payout.
/// It is not derived from the spend key. `to` and `payoutPortalId` stay off.
Map<String, Object?>? buildProvedWithdraw({
  required List<int> dest20,
  required int nanos,
  required String id,
  required String portalId,
  required int anchor,
  required List<int> excess,
  required List<int> fs1,
  required List<Map<String, Object?>> vin,
  required List<Map<String, Object?>> admitProofs,
  required List<Map<String, Object?>> leaves,
  required List<int> spendSeed,
  required int releaseEpoch,
  int fee = 0,
  List<Map<String, Object?>>? vout,
  String programId = 'shear-reserve-v1',
  String magic = 'shear-testnet-v12',
  List<int>? withdrawNonce,
  String from = '',
  String payer = '',
  List<Map<String, Object?>>? tranches,
}) {
  if (from.isNotEmpty || payer.isNotEmpty) return null;
  if (leaves.isEmpty || leaves.length > 16 || spendSeed.length != 32) return null;
  if (dest20.length != 20 || releaseEpoch < 0) return null;
  final nonce = withdrawNonce != null && withdrawNonce.length == 32
      ? Uint8List.fromList(withdrawNonce)
      : Uint8List.fromList(List<int>.generate(32, (i) => (i * 17 + 3) & 0xff));
  final seed = Uint8List.fromList(spendSeed);
  final payout = Uint8List.fromList(dest20);
  final body = buildFundedWithdraw(
    dest20: payout,
    nanos: nanos,
    id: id,
    portalId: portalId,
    anchor: anchor,
    excess: excess,
    fs1: fs1,
    vin: vin,
    admitProofs: admitProofs,
    retireProof: const [0],
    principalProof: const {'R': <int>[], 'z': <int>[]},
    fee: fee,
    vout: vout,
  );
  if (body == null) return null;
  body['programId'] = programId;
  body['withdrawNonce'] = nonce;
  body.remove('retireProof');
  body.remove('principalProof');
  final digest = withdrawTxDigest(tx: body, magic: magic);
  final retires = <Uint8List>[];
  final opens = <Map<String, Object?>>[];
  var principal = 0;
  for (final leaf in leaves) {
    final scalar = _asBytes(leaf['scalar']);
    final blind = _asBytes(leaf['blind']);
    final note = _asBytes(leaf['note']);
    final unlock = leaf['unlock'] is int ? leaf['unlock'] as int : 0;
    final epochs = leaf['epochs'];
    if (epochs is! List || epochs.isEmpty) return null;
    final burned = [for (final e in epochs) e is int ? e : 0];
    final period = leaf['withdrawPeriod'] is int ? leaf['withdrawPeriod'] as int : burned.first;
    final each = leaf['amount'] is int ? leaf['amount'] as int : 0;
    if (each <= 0) return null;
    principal += each;
    final proof = proveLeafRetireBytes(
      scalar: scalar,
      epochs: burned,
      leaf: note,
      txBind: digest,
      unlockEpoch: period,
      magic: magic,
    );
    final open = provePrincipalOpenBytes(
      commit: note.length == 64 ? note.sublist(32, 64) : const [],
      amount: each,
      blind: blind,
      digest: digest,
      portalId: portalId,
      unlock: unlock,
    );
    if (proof == null || open == null) return null;
    retires.add(proof);
    opens.add(open);
  }
  if (retires.length == 1) {
    body['retireProof'] = retires.first;
    body['principalProof'] = opens.first;
  } else {
    body['retireProofs'] = retires;
    body['principalProofs'] = opens;
  }
  final ownerSeed = _withdrawOwnerSeed(seed, portalId, leaves);
  if (ownerSeed == null) return null;
  final message = _withdrawOwnerMessage(
    portalId: portalId,
    nanos: principal,
    dest: _hexOf(payout),
    magic: keccak256(utf8Bytes(magic)),
    chainId: _kWithdrawChainId,
    epoch: releaseEpoch,
    trancheSet: tranches == null ? _sha(utf8Bytes(_kTrancheSetTag)) : trancheSetHash(tranches, releaseEpoch),
    txBind: digest,
  );
  if (message == null) return null;
  body['ownerPub'] = _hexOf(ed25519PublicFromSeed(ownerSeed));
  body['rewardSig'] = ed25519Sign(ownerSeed, message);
  body.remove('spendPub');
  body.remove('sig');
  if (body.containsKey('from') || body.containsKey('to') || body.containsKey('payoutPortalId') || body.containsKey('spendPub')) {
    return null;
  }
  return body;
}

/// SHA-256 of the lock body JS `txDigestV3` binds. The fund proof is not in it.
Uint8List lockTxDigest({
  required Map<String, Object?> tx,
  required String magic,
}) {
  final kind = (tx['kind'] ?? 'lock').toString();
  final anchor = (tx['anchor'] as int?) ?? 0;
  final fee = (tx['fee'] as int?) ?? 0;
  final vins = (tx['vin'] as List?) ?? const [];
  final proofs = (tx['admit_proofs'] as List?) ?? const [];
  final outs = (tx['vout'] as List?) ?? const [];
  final parts = <List<int>>[
    utf8Bytes('shear-admit-v3-txd'),
    [0x03],
    utf8Bytes(magic),
    _lenPref(utf8Bytes(kind)),
    _u64(anchor),
    _u64(fee),
    _u64(0),
    Uint8List(32),
    _u32(vins.length),
  ];
  for (var i = 0; i < vins.length; i++) {
    final proof = i < proofs.length && proofs[i] is Map ? proofs[i] as Map : const {};
    final tag = _asBytes(proof['spendTag']);
    final tilde = _asBytes(proof['cTilde']);
    final vin = vins[i] is Map ? vins[i] as Map : const {};
    final commit = tilde.length == 32 ? tilde : _asBytes(vin['commit']);
    parts.add(tag.length == 32 ? tag : Uint8List(32));
    parts.add(commit.length == 32 ? commit : Uint8List(32));
  }
  parts.add(_u32(outs.length));
  List<int> boundCommit = const [];
  final postedVout = <Map<String, dynamic>>[];
  for (final row in outs) {
    final o = row is Map ? Map<String, dynamic>.from(row) : <String, dynamic>{};
    postedVout.add(o);
    final outKind = (o['kind'] ?? kind).toString();
    final rp = _asBytes(o['rangeProof']);
    final view = _asBytes(o['viewTag']);
    final vp = o['valueProof'];
    final publicKind = outKind == 'lock' || outKind == 'vote' || outKind == 'withdraw';
    final publicNanos = publicKind
        ? (vp is Map && vp['v'] is int
            ? vp['v'] as int
            : ((o['nanos'] as int?) ?? (tx['nanos'] as int?) ?? 0))
        : 0;
    final d20 = _asBytes(o['dest20']);
    final commit = _asBytes(o['commit']);
    if (boundCommit.isEmpty && (outKind == 'withdraw' || outKind == 'lock' || outKind == 'vote') && commit.length == 32) {
      boundCommit = commit;
    }
    parts.add(_lenPref(utf8Bytes(outKind)));
    parts.add(commit.length == 32 ? commit : Uint8List(32));
    parts.add(_asBytes(o['admitPub']).length == 32 ? _asBytes(o['admitPub']) : Uint8List(32));
    parts.add(_asBytes(o['noteCommit']).length == 32 ? _asBytes(o['noteCommit']) : Uint8List(32));
    parts.add(_asBytes(o['rEph']).length == 32 ? _asBytes(o['rEph']) : Uint8List(32));
    parts.add(_lenPref(_asBytes(o['rCt'])));
    parts.add(_lenPref(_asBytes(o['memoCt'])));
    parts.add(view.isEmpty ? [0] : [view[0]]);
    parts.add(_sha(rp));
    parts.add(_u64(publicNanos));
    parts.add(_lenPref(d20.length >= 20 ? d20.sublist(0, 20) : const []));
    parts.add([0xa7]);
    parts.add(_lenPref(_asBytes(o['amtCt'])));
  }
  parts.add(_lenPref(utf8Bytes((tx['portalId'] ?? '').toString().toLowerCase())));
  parts.add(_lenPref(utf8Bytes((tx['programId'] ?? '').toString())));
  parts.add(_lenPref(utf8Bytes((tx['payoutPortalId'] ?? '').toString().toLowerCase())));
  final suffixNanos = (tx['nanos'] as int?) ?? 0;
  parts.add(reserveDigestSuffixBytes(
    kind: kind,
    portalId: (tx['portalId'] ?? '').toString(),
    payoutPortalId: (tx['payoutPortalId'] ?? '').toString(),
    programId: (tx['programId'] ?? '').toString(),
    choice: '',
    suffixNanos: suffixNanos,
    commit: boundCommit.length == 32 ? Uint8List.fromList(boundCommit) : null,
    vout: postedVout,
    oneTimePub: (tx['ownerPub'] ?? '').toString(),
  ));
  return _sha(_cat(parts));
}

/// Opening of [amount] under [blind] for this lock commitment, bound to the tx and height.
Map<String, Object>? proveLockFundEquality({
  required List<int> commit,
  required int amount,
  required List<int> blind,
  required Map<String, Object?> tx,
  required int height,
  String magic = kBookMagic,
}) {
  if (commit.length != 32 || blind.length != 32 || height < 0 || amount < 0) return null;
  final digest = lockTxDigest(tx: tx, magic: magic);
  final at = Uint8List(8);
  ByteData.sublistView(at).setUint64(0, height, Endian.little);
  final extra = Uint8List.fromList([
    ...utf8Bytes('shear-lock-fund-v1'),
    ...digest,
    ...at,
  ]);
  final word = Uint8List.fromList(commit);
  final blindB = Uint8List.fromList(blind);
  final vg = amount == 0
      ? pointBytes(ristrettoZero())
      : mulGBytes(scalarBytes(scalarFromU64(BigInt.from(amount))));
  final p = subBytes(word, vg);
  final sch = schnorrProveHBytes(p, blindB, extra);
  return {'R': sch['R']!, 'z': sch['z']!, 'height': height};
}

Map<String, dynamic> _postedLockRow(Map<String, dynamic> row) {
  return <String, dynamic>{
    'kind': row['kind'],
    'commit': row['commit'],
    if (row['noteCommit'] != null) 'noteCommit': row['noteCommit'],
    if (row['admitPub'] != null) 'admitPub': row['admitPub'],
    if (row['rEph'] != null) 'rEph': row['rEph'],
    if (row['rCt'] != null) 'rCt': row['rCt'],
    if (row['amtCt'] != null) 'amtCt': row['amtCt'],
    if (row['rangeProof'] != null) 'rangeProof': row['rangeProof'],
    if (row['dest20'] != null) 'dest20': row['dest20'],
    if (row['viewTag'] != null) 'viewTag': row['viewTag'],
    if (row['portalId'] != null) 'portalId': row['portalId'],
  };
}

/// One compact FS-1 lock. The leaf is admitPub(x) || commit(π, s) + unlock·U.
/// The funding proof opens the output commitment to π under s, bound to this tx.
Map<String, Object?>? buildQueuedLockTx({
  required Uint8List spendSeed,
  required int lockIndex,
  required int lockEpoch,
  required int proveHeight,
  required int anchor,
  required Uint8List fluxNotes,
  required List<Map<String, dynamic>> inputs,
  required int inputNanos,
  required Uint8List changeDest20,
  required String id,
  String magic = kBookMagic,
  int? fee,
}) {
  if (spendSeed.length != 32 || inputs.isEmpty || inputs.length > 8) return null;
  if (changeDest20.length != 20 || id.isEmpty || proveHeight < 0 || anchor < 0) return null;
  final ownerSeed = reservePortalSpendSeed(spendSeed, lockIndex);
  final dest20 = reservePortalDest20FromSeed(spendSeed, lockIndex);
  if (ownerSeed == null || dest20 == null) return null;
  final portalId = reservePortalIdFromDest20(dest20);
  if (portalId == null) return null;
  final unlock = consensusUnlockPeriod(lockEpoch);
  if (unlock <= 0 || unlock == kVaultUnlockOpen) return null;
  final scalar = vaultLockOwnerBytes(ownerSeed, lockIndex);
  final blind = vaultLockBlindBytes(ownerSeed, lockIndex, kPiSheNanos, 0);
  final note = vaultLeafNote(amount: kPiSheNanos, scalar: scalar, blind: blind, unlock: unlock);
  if (note.length != 64) return null;
  final admit = AdmitNative.tryLoad();
  if (admit == null) return null;
  final range = admit.proveRange(BigInt.from(kPiSheNanos), blind);
  if (range == null || range.isEmpty || range[0] != 2) return null;
  final paid = fee ?? kLevyCapNanos;
  final changeN = inputNanos - paid - kPiSheNanos;
  if (paid <= 0 || changeN <= 0) return null;
  final funded = commitBytes(kPiSheNanos, blind);
  final change = hiddenChangeNote(
    changeN,
    changeDest20,
    spendSeed: spendSeed,
    admitBase: admitPub(admitBaseScalar(spendSeed)),
  );
  if (change == null) return null;
  final lockRow = <String, dynamic>{
    'kind': 'lock',
    'commit': funded,
    'rangeProof': range,
    'r': blind,
    'dest20': dest20,
    'portalId': portalId,
  };
  final withBlind = <Map<String, dynamic>>[lockRow, change];
  final posted = <Map<String, dynamic>>[
    _postedLockRow(lockRow),
    _postedLockRow(change),
  ];
  final ownerHex = _hexOf(ed25519PublicFromSeed(ownerSeed));
  final digest = fs1BodyDigest(
    magic: magic,
    kind: 'lock',
    anchor: anchor,
    fee: paid,
    nIn: inputs.length,
    vout: posted,
    portalId: portalId,
    programId: 'shear-reserve-v1',
    reserveNanos: 0,
    oneTimePub: ownerHex,
  );
  final indices = <int>[];
  final spent = <Map<String, dynamic>>[];
  for (final row in inputs) {
    final index = row['index'];
    final commit = row['commit'];
    final nc = row['noteCommit'];
    final r = row['r'];
    if (index is! int || commit is! Uint8List || nc is! Uint8List || r is! Uint8List) return null;
    indices.add(index);
    spent.add({
      'kind': (row['kind'] ?? 'pot').toString(),
      'commit': commit,
      'noteCommit': nc,
      'r': r,
    });
  }
  final proved = proveFs1SpendWire({
    'notes': fluxNotes,
    'indices': indices,
    'spent': spent,
    'spendSeed': spendSeed,
    'vout': withBlind,
    'digest': digest,
    'anchor': anchor,
    'tree': const Fs1TreeState().toWire(),
    'keepT': true,
  });
  final tree = Fs1TreeState.fromWire(proved['tree']);
  try {
    final records = [for (final rec in (proved['records'] as List)) rec as Uint8List];
    final proofs = [for (final rec in records) fs1PostedProof(rec)];
    if (proofs.length != inputs.length) return null;
    final leafCommit = Uint8List.sublistView(note, 32, 64);
    final auth = reserveLockAuth(ownerSeed, portalId, leafCommit);
    if (auth == null || auth.length != 96) return null;
    final body = <String, Object?>{
      'id': id,
      'kind': 'lock',
      'nanos': 0,
      'portalId': portalId,
      'programId': 'shear-reserve-v1',
      'ownerPub': ownerHex,
      'vaultLockNote': note,
      'lockAuth': auth,
      'anchor': anchor,
      'fee': paid,
      'vin': [
        for (final proof in proofs) {'commit': proof['cTilde']},
      ],
      'vout': posted,
      'fs1': proved['fs1'],
      'excess': proved['excess'],
      'admit_proofs': proofs,
    };
    final fund = proveLockFundEquality(
      commit: funded,
      amount: kPiSheNanos,
      blind: blind,
      tx: body,
      height: proveHeight,
      magic: magic,
    );
    if (fund == null) return null;
    posted[0]['fundProof'] = fund;
    return {
      'tx': body,
      'scalar': scalar,
      'blind': blind,
      'note': note,
      'unlock': unlock,
      'commit': funded,
      'portalId': portalId,
      'ownerPub': ownerHex,
      'fee': paid,
      'changeNanos': changeN,
      'change': change,
    };
  } finally {
    Fs1Native.tryLoad()?.treeFree(tree.handle);
  }
}
