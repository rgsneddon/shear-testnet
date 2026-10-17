import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_admit.dart';
import 'shear_vault_blob.dart';

export 'shear_vault_blob.dart' show packVaultRewardProof, kVaultBlobVer;
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
const int kVaultProofVer = 0xab;
const int kPiSheNanos = 314159265358;
const int kVaultUnlockOpen = 0xffffffff;
const String kVaultUnlockDst = 'shear-vault-unlock-base-v1';
const String kVaultGapDst = 'shear-vault-unlock-gap-v1';
const String kVaultGapEqDst = 'shear-vault-gap-eq-v1';
const String kVaultRetireDleqDst = 'shear-vault-retire-dleq-v1';
const String kMagicMainnet = 'shear-v1';

/// Testnet is 4 days. Mainnet (`shear-v1`) is 400. A day is 960 blocks of 90s.
int vaultEpochBlocksFor(String magic) => (magic == kMagicMainnet ? 400 : 4) * 960;

int vaultPeriodBlocksFor(String magic) {
  final blocks = vaultEpochBlocksFor(magic);
  if (blocks % 16 != 0) throw StateError('stake_reward');
  return blocks ~/ 16;
}

Element vaultUnlockBase() =>
    pointFrom(fromHashBytes(sha512Bytes(utf8Bytes(kVaultUnlockDst))));

const String kClaimTxidDst = 'shear-claim-txid-v1';
const String kClaimPortalDst = 'shear-claim-portal-v1';
const String kVaultCapDst = 'shear-epoch-cap-v1';
const String kVaultLeafDst = 'shear-vault-leaf-v1';

/// Author-built full-epoch cap. Fresh blinds. The claim blob version is kVaultProofVer.
Map<String, Uint8List> _lockCap({
  required int amount,
  required Uint8List lockBlind,
  required int bps,
  required int reward,
  required Uint8List rewardBlind,
  required AdmitNative admit,
}) {
  final product = BigInt.from(amount) * BigInt.from(bps);
  final capValue = product ~/ BigInt.from(10000);
  final rem = product - capValue * BigInt.from(10000);
  final slack = BigInt.from(9999) - rem;
  if (slack < BigInt.zero || capValue < BigInt.zero) throw StateError('stake_reward');
  final rCap = scalarBytes(randomScalar());
  final rRem = scalarBytes(randomScalar());
  final rSlack = scalarBytes(randomScalar());
  final capCommit = commitBytes(capValue.toInt(), rCap);
  final remCommit = commitBytes(rem.toInt(), rRem);
  final slackCommit = commitBytes(slack.toInt(), rSlack);
  final remP = pointFrom(remCommit);
  final slackP = pointFrom(slackCommit);
  final balP = subEl(addEl(remP, slackP), mulG(scalarFromInt(9999)));
  final balS = scalarAdd(scalarFromBytes(rRem), scalarFromBytes(rSlack));
  final bal = schnorrProveH(balP, balS, utf8Bytes(kVaultCapDst));
  final capRange = admit.proveRange(capValue, rCap);
  final remRange = admit.proveRange(rem, rRem);
  final slackRange = admit.proveRange(slack, rSlack);
  if (capRange == null || remRange == null || slackRange == null) {
    throw StateError('admit_native_required');
  }
  final diff = capValue - BigInt.from(reward);
  if (diff < BigInt.zero) throw StateError('stake_reward');
  final det = scalarBytes(hashToScalar([
    utf8Bytes('shear-epoch-cap-blind-v1'),
    lockBlind,
    _u32(bps),
  ]));
  final under = admit.proveRange(diff, scalarBytes(scalarSub(scalarFromBytes(rCap), scalarFromBytes(rewardBlind))));
  final pool = admit.proveRange(diff, scalarBytes(scalarSub(scalarFromBytes(det), scalarFromBytes(rewardBlind))));
  if (under == null || under.isEmpty || pool == null || pool.isEmpty) throw StateError('admit_native_required');
  return {
    'cap': capCommit,
    'capRange': capRange,
    'rem': remCommit,
    'remRange': remRange,
    'slack': slackCommit,
    'slackRange': slackRange,
    'balR': bal['R']!,
    'balZ': bal['z']!,
    'under': under,
    'pool': pool,
    'rCap': rCap,
    'rRem': rRem,
  };
}

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

Uint8List _lockNote(int amount, Uint8List owner, Uint8List blind, int unlock) {
  if (amount != kPiSheNanos) throw StateError('stake_reward');
  final pub = pointBytes(admitPub(scalarFromBytes(owner)));
  final bare = commitBytes(amount, blind);
  if (unlock == 0) return _concat([pub, bare]);
  final mixed = addBytes(
    bare,
    mulBytes(pointBytes(vaultUnlockBase()), scalarBytes(scalarFromU64(BigInt.from(unlock)))),
  );
  return _concat([pub, mixed]);
}

/// gap = unlock − period − 1, hidden in a commitment. gap·G and gap·U stay off the blob.
Map<String, dynamic> _proveGapCommit(int unlock, int epoch, AdmitNative admit) {
  final gap = unlock - epoch - 1;
  if (gap < 0 || gap > 0xffffffff) throw StateError('stake_reward');
  final r = randomScalar();
  final gapC = commitBytes(gap, scalarBytes(r));
  final range = admit.proveRange(BigInt.from(gap), scalarBytes(r));
  if (range == null || range.isEmpty) throw StateError('admit_native_required');
  return {'gap': gap, 'r': r, 'gapC': gapC, 'range': range};
}

/// openP = U·gap + H·openS and gapC = G·gap + H·r. Neither gap point is published.
Map<String, Uint8List> _proveGapEq({
  required int gap,
  required Scalar r,
  required Scalar openS,
  required Element openP,
  required int epoch,
  required Uint8List gapC,
}) {
  final kGap = randomScalar();
  final kR = randomScalar();
  final kS = randomScalar();
  final g = ristrettoG();
  final u = vaultUnlockBase();
  final a1 = addEl(mulEl(g, kGap), mulEl(noteH, kR));
  final a2 = addEl(mulEl(u, kGap), mulEl(noteH, kS));
  final a1b = pointBytes(a1);
  final a2b = pointBytes(a2);
  final openPb = pointBytes(openP);
  final e = hashToScalar([
    utf8Bytes(kVaultGapEqDst),
    _u64(epoch),
    a1b,
    a2b,
    gapC,
    openPb,
  ]);
  final x = scalarFromU64(BigInt.from(gap));
  return {
    'A1': a1b,
    'A2': a2b,
    'zGap': scalarBytes(scalarAdd(kGap, scalarMul(e, x))),
    'zR': scalarBytes(scalarAdd(kR, scalarMul(e, r))),
    'zS': scalarBytes(scalarAdd(kS, scalarMul(e, openS))),
  };
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
  final unlocks = <int>[];
  for (final lock in locks) {
    final amount = (lock['amount'] as num).toInt();
    if (amount != kPiSheNanos) throw StateError('stake_reward');
    final index = (lock['index'] as num?)?.toInt() ?? 0;
    final lockMs = (lock['lockMs'] as num?)?.toInt() ?? 0;
    final seed = _asBytes(lock['seed']);
    var owner = _asBytes(lock['scalar']);
    var blind = _asBytes(lock['blind']);
    var unlock = kVaultUnlockOpen;
    if (lock['unlockEpoch'] != null) unlock = (lock['unlockEpoch'] as num).toInt();
    if (owner.length != 32) {
      if (seed.length == 0) owner = scalarBytes(randomScalar());
      else owner = vaultNullBytes(seed, index);
    }
    if (blind.length != 32) {
      if (seed.length == 0) blind = scalarBytes(randomScalar());
      else blind = vaultLockBlindBytes(seed, index, amount, lockMs);
    }
    notes.add(_lockNote(amount, owner, blind, unlock));
    blinds.add(blind);
    owners.add(owner);
    amounts.add(amount);
    unlocks.add(unlock);
  }
  final handle = fs1.treeNew();
  if (handle == 0) throw StateError('fs1_prover_unavailable');
  try {
    final packed = _concat(notes);
    if (!fs1.treeAppend(handle, packed)) throw StateError('fs1_prover_unavailable');
    final root = fs1.treeRoot(handle);
    if (root == null || root.length != 32) throw StateError('fs1_prover_unavailable');
    // Callers that pass the epoch length twice ask for one period.
    // An explicit hold that is not that length is one interval, in blocks.
    // rate_e is the whole-epoch total. The packed span is epoch blocks.
    if (remainMs <= 0 || span <= 0) throw StateError('stake_reward');
    final blocks = vaultEpochBlocksFor(magic);
    final period = vaultPeriodBlocksFor(magic);
    var covered = period;
    if (remainMs != span) {
      if (remainMs > blocks) throw StateError('stake_reward');
      covered = remainMs;
    }
    final unlock = unlocks[which];
    final epoch = earnEpoch;
    if (epoch >= unlock) throw StateError('stake_reward');
    final amount = BigInt.from(amounts[which]);
    final rate = BigInt.from(bps);
    final bound = BigInt.one << 110;
    final product = amount * rate * BigInt.from(covered);
    final denom = BigInt.from(blocks) * BigInt.from(10000);
    if (product <= BigInt.zero || product >= bound || denom <= BigInt.zero || denom >= bound) {
      throw StateError('stake_reward');
    }
    final nanos = product ~/ denom;
    if (nanos <= BigInt.zero || nanos.bitLength > 53) throw StateError('stake_reward');
    final reward = nanos.toInt();
    final admit = AdmitNative.tryLoad();
    if (admit == null) throw StateError('admit_native_required');
    final epochEl = hashToRistretto(_u64(epoch), utf8Bytes(kVaultNullEpochDst));
    final nullP = pointBytes(mulEl(epochEl, scalarFromBytes(owners[which])));
    final nullifierPre = _sha256(_concat([utf8Bytes(kVaultNullPrf), nullP]));
    final noteR = randomScalar();
    final noteCommit = noteCommitOfDest20(dest20);
    final noteC = pointBytes(_commitUnits(nanos, noteR));
    final noteRange = admit.proveRange(nanos, scalarBytes(noteR));
    if (noteRange == null || noteRange.isEmpty) throw StateError('admit_native_required');
    final wrapped = wrapNoteBlind({
      'r': scalarBytes(noteR),
      'noteCommit': noteCommit,
      'commit': noteC,
    }, admitPub(randomScalar()), v: nanos);
    final amtCt = wrapped['amtCt'];
    if (amtCt is! Uint8List || amtCt.length != 8) throw StateError('unsigned');
    final gap = _proveGapCommit(unlock, epoch, admit);
    final preimage = _sha256(_concat([
      utf8Bytes(kClaimTxidDst),
      noteC,
      noteCommit,
      dest20,
      amtCt,
      nullifierPre,
      _u64(epoch),
      _u64(reward),
    ]));
    final digest = _sha256(_concat([
      utf8Bytes(kVaultRewardDst),
      utf8Bytes(magic),
      root,
      _u64(epoch),
      _u32(bps),
      _u64(blocks),
      _u64(reward),
      _u64(covered),
      gap['gapC'] as Uint8List,
      noteC,
      noteCommit,
      dest20,
      amtCt,
      preimage,
    ]));
    final epochBase = pointBytes(hashToRistretto(_u64(epoch), utf8Bytes(kVaultNullEpochDst)));
    final proved = fs1.proveUnlinked(handle, [which], [owners[which]], digest, epoch, epochBase);
    if (proved == null || proved.records.isEmpty || proved.link.length < 96) throw StateError('fs1_prover_unavailable');
    final record = proved.records.first;
    if (record.length != kFs1RecordBytes || record[0] != kFs1Wire) throw StateError('fs1_prover_unavailable');
    final cTilde = Uint8List.sublistView(record, 33, 65);
    final t = proved.t.first;
    final openS = scalarAdd(scalarFromBytes(blinds[which]), scalarFromBytes(t));
    final openP = subEl(
      subEl(pointFrom(cTilde), mulG(scalarFromBigInt(BigInt.from(kPiSheNanos)))),
      mulEl(vaultUnlockBase(), scalarFromU64(BigInt.from(epoch + 1))),
    );
    final gapN = gap['gap'] as int;
    final hidden = addEl(
      mulEl(vaultUnlockBase(), scalarFromU64(BigInt.from(gapN))),
      mulEl(noteH, openS),
    );
    if (!elementEq(openP, hidden)) throw StateError('stake_reward');
    final eq = _proveGapEq(
      gap: gapN,
      r: gap['r'] as Scalar,
      openS: openS,
      openP: openP,
      epoch: epoch,
      gapC: gap['gapC'] as Uint8List,
    );
    final portalWord = _sha256(_concat([utf8Bytes(kClaimPortalDst), dest20]));
    final noteExtra = _sha256(_concat([utf8Bytes(kVaultBalDst), preimage, portalWord]));
    final noteP = subEl(pointFrom(noteC), mulG(scalarFromBigInt(nanos)));
    if (!elementEq(noteP, mulEl(noteH, noteR))) throw StateError('stake_reward');
    final noteOpen = schnorrProveH(noteP, noteR, noteExtra);
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
    if (!_bytesEq(nullifier, nullifierPre)) throw StateError('stake_reward');
    final header = packVaultRewardProof(
      fs1: proved.fs1,
      record: record,
      bps: bps,
      span: blocks,
      epoch: epoch,
      reward: reward,
      covered: covered,
      nullBase: Uint8List.fromList(linkAnn),
      nullP: Uint8List.fromList(linkN),
      nullA1: Uint8List.fromList(linkSr),
      openR: eq['A1']!,
      openZ: eq['zGap']!,
      noteR: noteOpen['R']!,
      noteZ: noteOpen['z']!,
    );
    final range = gap['range'] as Uint8List;
    final blob = _concat([
      header,
      _u32(range.length),
      range,
      gap['gapC'] as Uint8List,
      eq['A1']!,
      eq['A2']!,
      eq['zGap']!,
      eq['zR']!,
      eq['zS']!,
    ]);
    return {
      'ok': true,
      'blob': blob,
      'blobHex': _hex(blob),
      'root': root,
      'rootHex': _hex(root),
      'nullifier': _hex(nullifier),
      'nanos': reward,
      'full': covered == period,
      'rootEpoch': epoch,
      'earnEpoch': epoch,
      'note': {
        'commit': noteC,
        'noteCommit': noteCommit,
        'amtCt': amtCt,
        'dest20': dest20,
        'rangeProof': noteRange,
        if (wrapped['rEph'] != null) 'rEph': wrapped['rEph'],
        if (wrapped['rCt'] != null) 'rCt': wrapped['rCt'],
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
