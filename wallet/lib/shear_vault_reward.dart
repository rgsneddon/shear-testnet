import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_admit.dart';
import 'shear_admit_ffi.dart';
import 'shear_fs1.dart';
import 'shear_identity.dart' show kBookMagic;
import 'shear_note.dart';
import 'shear_ristretto.dart';

const String kVaultRewardDst = 'shear-vault-reward-fs1-v1';
const String kVaultNullKeyDst = 'shear-vault-null-key-v1';
const String kVaultNullEpochDst = 'shear-vault-null-epoch-v1';
const String kVaultNullPrf = 'shear-vault-null-prf-v1';
const String kVaultRelDst = 'shear-vault-reward-rel-v1';
const String kVaultBalDst = 'shear-vault-reward-bal-v1';
const String kVaultLockBlindDst = 'shear-vault-lock-blind-v1';
const String kVaultLockOwnerDst = 'shear-vault-lock-owner-v1';
const int kVaultProofVer = 0xa4;

bool _bytesEq(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

/// Little-endian scalar. The relation's product is wider than a u64 and
/// still under 2^110, which is under the subgroup order.
Scalar scalarFromBigInt(BigInt n) {
  if (n < BigInt.zero || n.bitLength > 252) throw ArgumentError('scalar');
  final b = Uint8List(32);
  var v = n;
  final mask = BigInt.from(0xff);
  for (var i = 0; i < 32; i++) {
    b[i] = (v & mask).toInt();
    v >>= 8;
  }
  return scalarFromBytes(b);
}

Uint8List _u32(int n) {
  final b = Uint8List(4);
  ByteData.sublistView(b).setUint32(0, n, Endian.little);
  return b;
}

Uint8List _u64(int n) {
  final b = Uint8List(8);
  var x = n < 0 ? 0 : n;
  for (var i = 0; i < 8; i++) {
    b[i] = x & 0xff;
    x >>= 8;
  }
  return b;
}

Uint8List _u64big(BigInt n) {
  final b = Uint8List(8);
  var x = n < BigInt.zero ? BigInt.zero : n;
  final mask = BigInt.from(0xff);
  for (var i = 0; i < 8; i++) {
    b[i] = (x & mask).toInt();
    x >>= 8;
  }
  return b;
}

Uint8List _concat(List<Uint8List> parts) => concatBytes(parts);

Uint8List _sha256(Uint8List msg) => Uint8List.fromList(sha256.convert(msg).bytes);

String _hex(List<int> b) {
  const d = '0123456789abcdef';
  final s = StringBuffer();
  for (final x in b) {
    s
      ..write(d[x >> 4])
      ..write(d[x & 15]);
  }
  return s.toString();
}

Uint8List _asBytes(Object? v) {
  if (v is Uint8List) return v;
  if (v is List<int>) return Uint8List.fromList(v);
  return Uint8List(0);
}

/// Same seed, index, amount, and lock time rebuild the lock blind.
Uint8List vaultLockBlindBytes(Uint8List seed, int index, int amount, int lockMs) {
  final s = hashToScalar([
    utf8Bytes(kVaultLockBlindDst),
    seed,
    _u64(index),
    _u64(amount),
    _u64(lockMs),
  ]);
  return scalarBytes(s);
}

/// Owner scalar for that lock. Not the wallet spend key.
Uint8List vaultLockOwnerBytes(Uint8List seed, int index) {
  return scalarBytes(hashToScalar([
    utf8Bytes(kVaultLockOwnerDst),
    seed,
    _u64(index),
  ]));
}

/// Vault key for the nullifier. Separate from the spend key and the owner scalar.
Uint8List vaultNullBytes(Uint8List seed, int index) {
  return scalarBytes(hashToScalar([
    utf8Bytes(kVaultNullKeyDst),
    seed,
    _u64(index),
  ]));
}

Element _commitUnits(BigInt v, Scalar r) {
  final vg = v == BigInt.zero ? ristrettoZero() : mulG(scalarFromBigInt(v));
  return addEl(vg, mulEl(noteH, r));
}

Uint8List _lockNote(int amount, Uint8List owner, Uint8List blind) {
  final pub = pointBytes(admitPub(scalarFromBytes(owner)));
  final c = commitBytes(amount, blind);
  return _concat([pub, c]);
}

/// One claim or roll proof. The tree is the vault-lock set the caller
/// passes, never the chain admit set. A missing native library fails closed.
Map<String, dynamic> proveVaultLockReward({
  required List<Map<String, dynamic>> locks,
  int which = 0,
  required int rootEpoch,
  required int earnEpoch,
  required int bps,
  required int remainMs,
  required int span,
  required Uint8List dest20,
  String magic = kBookMagic,
}) {
  final fs1 = Fs1Native.tryLoad();
  if (fs1 == null) throw StateError('fs1_prover_unavailable');
  if (rootEpoch != earnEpoch) throw StateError('stake_reward');
  if (locks.isEmpty || which < 0 || which >= locks.length) throw StateError('unsigned');
  if (dest20.length != 20) throw StateError('unsigned');
  final notes = <Uint8List>[];
  final blinds = <Uint8List>[];
  final owners = <Uint8List>[];
  final amounts = <int>[];
  for (final lock in locks) {
    final amount = (lock['amount'] as num).toInt();
    if (amount <= 0) throw StateError('unsigned');
    final index = (lock['index'] as num?)?.toInt() ?? 0;
    final lockMs = (lock['lockMs'] as num?)?.toInt() ?? 0;
    final seed = _asBytes(lock['seed']);
    var owner = _asBytes(lock['scalar']);
    var blind = _asBytes(lock['blind']);
    if (owner.length != 32) {
      if (seed.length == 0) owner = scalarBytes(randomScalar());
      else owner = vaultNullBytes(seed, index);
    }
    if (blind.length != 32) {
      if (seed.length == 0) blind = scalarBytes(randomScalar());
      else blind = vaultLockBlindBytes(seed, index, amount, lockMs);
    }
    notes.add(_lockNote(amount, owner, blind));
    blinds.add(blind);
    owners.add(owner);
    amounts.add(amount);
  }
  final handle = fs1.treeNew();
  if (handle == 0) throw StateError('fs1_prover_unavailable');
  try {
    final packed = _concat(notes);
    if (!fs1.treeAppend(handle, packed)) throw StateError('fs1_prover_unavailable');
    final root = fs1.treeRoot(handle);
    if (root == null || root.length != 32) throw StateError('fs1_prover_unavailable');
    final amount = BigInt.from(amounts[which]);
    final prod = amount * BigInt.from(bps) * BigInt.from(remainMs);
    final denom = BigInt.from(span) * BigInt.from(10000);
    final bound = BigInt.one << 110;
    if (denom <= BigInt.one || prod < BigInt.zero) throw StateError('stake_reward');
    final nanos = prod ~/ denom;
    final rem = prod % denom;
    final gExp = denom * nanos + rem;
    final factorN = BigInt.from(bps) * BigInt.from(remainMs);
    if (prod >= bound || denom >= bound || gExp >= bound || factorN >= bound) {
      throw StateError('stake_reward');
    }
    if (nanos <= BigInt.zero || nanos.bitLength > 53) throw StateError('stake_reward');
    final slack = denom - BigInt.one - rem;
    if (slack < BigInt.zero) throw StateError('stake_reward');
    final reward = nanos.toInt();
    final admit = AdmitNative.tryLoad();
    if (admit == null) throw StateError('admit_native_required');
    final r = randomScalar();
    final rb = scalarBytes(r);
    final nc = noteCommitOfDest20(dest20);
    final commitB = commitBytes(reward, rb);
    final range = admit.proveRange(nanos, rb);
    if (range == null || range.isEmpty || range[0] != 2) throw StateError('admit_native_required');
    final wrap = wrapBlind(rb, admitPub(randomScalar()), _concat([nc, commitB]), v: nanos);
    final amtCt = wrap['amtCt'];
    if (amtCt == null || amtCt.length != 8) throw StateError('stake_reward');
    final rRem = randomScalar();
    final rSlack = randomScalar();
    final remCommit = pointBytes(_commitUnits(rem, rRem));
    final slackCommit = pointBytes(_commitUnits(slack, rSlack));
    final remRange = admit.proveRange(rem, scalarBytes(rRem));
    final slackRange = admit.proveRange(slack, scalarBytes(rSlack));
    if (remRange == null || remRange.isEmpty || slackRange == null || slackRange.isEmpty) {
      throw StateError('admit_native_required');
    }
    final epoch = earnEpoch;
    final full = remainMs == span ? 1 : 0;
    final timeSlack = BigInt.from(span) - BigInt.from(remainMs);
    if (timeSlack < BigInt.zero) throw StateError('stake_reward');
    final rTime = randomScalar();
    final rTimeSlack = randomScalar();
    final remainCommit = pointBytes(_commitUnits(BigInt.from(remainMs), rTime));
    final timeSlackCommit = pointBytes(_commitUnits(timeSlack, rTimeSlack));
    final timeRange = admit.proveRange(BigInt.from(remainMs), scalarBytes(rTime));
    final timeSlackRange = admit.proveRange(timeSlack, scalarBytes(rTimeSlack));
    if (timeRange == null || timeRange.isEmpty || timeSlackRange == null || timeSlackRange.isEmpty) {
      throw StateError('admit_native_required');
    }
    final digest = _sha256(_concat([
      utf8Bytes(kVaultRewardDst),
      utf8Bytes(magic),
      root,
      _u64(epoch),
      _u32(bps),
      _u64(span),
      Uint8List.fromList([full]),
      remainCommit,
      timeSlackCommit,
      commitB,
      amtCt,
      dest20,
      nc,
      _sha256(range),
      remCommit,
      _sha256(remRange),
      slackCommit,
      _sha256(slackRange),
    ]));
    final epochBase = pointBytes(hashToRistretto(_u64(epoch), utf8Bytes(kVaultNullEpochDst)));
    final proved = fs1.proveUnlinked(handle, [which], [owners[which]], digest, epoch, epochBase);
    if (proved == null || proved.records.isEmpty || proved.link.length < 96) throw StateError('fs1_prover_unavailable');
    final record = proved.records.first;
    if (record.length != kFs1RecordBytes || record[0] != kFs1Wire) throw StateError('fs1_prover_unavailable');
    final cTilde = Uint8List.sublistView(record, 33, 65);
    final kSig = randomScalar();
    final kBlind = randomScalar();
    final sigA1 = addEl(mulG(kSig), mulEl(noteH, kBlind));
    final sigA2 = mulEl(pointFrom(cTilde), kSig);
    final qPoint = mulEl(pointFrom(cTilde), scalarFromBigInt(BigInt.from(remainMs)));
    final sigE = hashToScalar([
      pointBytes(sigA1),
      pointBytes(sigA2),
      remainCommit,
      pointBytes(qPoint),
      cTilde,
    ]);
    final sigS = scalarAdd(kSig, scalarMul(sigE, scalarFromBigInt(BigInt.from(remainMs))));
    final sigSr = scalarAdd(kBlind, scalarMul(sigE, rTime));
    final denomS = scalarFromBigInt(denom);
    final p = subEl(
      subEl(mulEl(qPoint, scalarFromBigInt(BigInt.from(bps))), mulEl(pointFrom(commitB), denomS)),
      pointFrom(remCommit),
    );
    final factor = scalarFromBigInt(factorN);
    final t = proved.t.first;
    final s = scalarSub(
      scalarMul(factor, scalarAdd(scalarFromBytes(blinds[which]), scalarFromBytes(t))),
      scalarAdd(scalarMul(denomS, r), rRem),
    );
    if (!elementEq(p, mulEl(noteH, s))) throw StateError('stake_reward');
    final extra = _sha256(_concat([
      utf8Bytes(kVaultRelDst),
      pointBytes(qPoint),
      _u32(bps),
      _u64(span),
      commitB,
      amtCt,
      dest20,
      nc,
      _sha256(range),
      remCommit,
      slackCommit,
    ]));
    final rel = schnorrProveH(p, s, extra);
    final balP = subEl(
      addEl(pointFrom(remCommit), pointFrom(slackCommit)),
      mulG(scalarFromBigInt(denom - BigInt.one)),
    );
    final balS = scalarAdd(rRem, rSlack);
    if (!elementEq(balP, mulEl(noteH, balS))) throw StateError('stake_reward');
    final bal = schnorrProveH(balP, balS, utf8Bytes(kVaultBalDst));
    final timeP = subEl(
      addEl(pointFrom(remainCommit), pointFrom(timeSlackCommit)),
      mulG(scalarFromBigInt(BigInt.from(span))),
    );
    final timeS = scalarAdd(rTime, rTimeSlack);
    if (!elementEq(timeP, mulEl(noteH, timeS))) throw StateError('stake_reward');
    final timeBal = schnorrProveH(timeP, timeS, utf8Bytes(kVaultBalDst));
    final linkAnn = Uint8List.sublistView(proved.link, 0, 32);
    final linkSr = Uint8List.sublistView(proved.link, 32, 64);
    final linkN = Uint8List.sublistView(proved.link, 64, 96);
    final stable = pointBytes(mulEl(
      hashToRistretto(pointBytes(admitPub(scalarFromBytes(owners[which]))), utf8Bytes('shear-admit-Hp')),
      scalarFromBytes(owners[which]),
    ));
    final tag = Uint8List.sublistView(record, 1, 33);
    if (_bytesEq(stable, tag)) throw StateError('stake_reward');
    final nullifier = _sha256(_concat([utf8Bytes(kVaultNullPrf), linkN]));
    final blob = _concat([
      Uint8List.fromList([kVaultProofVer]),
      _u32(proved.fs1.length),
      proved.fs1,
      record,
      _u32(bps),
      _u64(span),
      _u64(epoch),
      Uint8List.fromList([full]),
      pointBytes(qPoint),
      remainCommit,
      timeSlackCommit,
      pointBytes(sigA1),
      pointBytes(sigA2),
      scalarBytes(sigS),
      scalarBytes(sigSr),
      linkAnn,
      linkN,
      linkSr,
      Uint8List(32),
      Uint8List(32),
      _u32(timeRange.length),
      timeRange,
      _u32(timeSlackRange.length),
      timeSlackRange,
      timeBal['R']!,
      timeBal['z']!,
      rel['R']!,
      rel['z']!,
      commitB,
      amtCt,
      dest20,
      nc,
      _u32(range.length),
      range,
      remCommit,
      _u32(remRange.length),
      remRange,
      slackCommit,
      _u32(slackRange.length),
      slackRange,
      bal['R']!,
      bal['z']!,
    ]);
    return {
      'ok': true,
      'blob': blob,
      'blobHex': _hex(blob),
      'root': root,
      'rootHex': _hex(root),
      'nullifier': _hex(nullifier),
      'nanos': reward,
      'remainCommit': _hex(remainCommit),
      'full': full == 1,
      'rootEpoch': epoch,
      'earnEpoch': epoch,
      'note': {
        'kind': 'reward-claim',
        'noteCommit': nc,
        'commit': commitB,
        'rangeProof': range,
        'dest20': dest20,
        'amtCt': amtCt,
        'rEph': wrap['rEph'],
        'rCt': wrap['rCt'],
      },
    };
  } finally {
    fs1.treeFree(handle);
  }
}

/// Isolate entry. The UI button sends this through `compute`.
Map<String, dynamic> proveVaultLockRewardWire(Map<String, dynamic> input) {
  final raw = input['locks'];
  if (raw is! List) throw StateError('unsigned');
  final locks = <Map<String, dynamic>>[
    for (final row in raw) Map<String, dynamic>.from(row as Map),
  ];
  final dest20 = _asBytes(input['dest20']);
  return proveVaultLockReward(
    locks: locks,
    which: (input['which'] as num?)?.toInt() ?? 0,
    rootEpoch: (input['rootEpoch'] as num).toInt(),
    earnEpoch: (input['earnEpoch'] as num).toInt(),
    bps: (input['bps'] as num).toInt(),
    remainMs: (input['remainMs'] as num).toInt(),
    span: (input['span'] as num).toInt(),
    dest20: dest20,
    magic: (input['magic'] as String?) ?? kBookMagic,
  );
}
