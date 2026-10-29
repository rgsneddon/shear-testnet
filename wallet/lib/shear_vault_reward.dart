import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_admit.dart';
import 'shear_pack.dart' show reservePortalSpendSeed;
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

/// Periods a lock must outlast. The same word as JS `consensusUnlockPeriod`.
int consensusUnlockPeriod(int lockEpoch) {
  final epoch = lockEpoch < 0 ? 0 : lockEpoch;
  return (epoch + 1) * 16;
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

/// The 64-byte lock note the node appends. Same bytes as [_lockNote].
Uint8List vaultLockNoteBytes(int amount, Uint8List owner, Uint8List blind, int unlock) =>
    _lockNote(amount, owner, blind, unlock);

int vaultLockNoteIndex(List<Uint8List> notes, Uint8List mine) {
  if (mine.length != 64) return -1;
  for (var i = 0; i < notes.length; i++) {
    final note = notes[i];
    if (note.length != mine.length) continue;
    if (_bytesEq(note, mine)) return i;
  }
  return -1;
}

/// One FS-1 tree of ordered 64-byte lock notes. Same append as the node builder.
({int handle, Uint8List root})? vaultLockTree(Fs1Native fs1, List<Uint8List> notes) {
  final handle = fs1.treeNew();
  if (handle == 0) return null;
  for (final note in notes) {
    if (note.length != 64) {
      fs1.treeFree(handle);
      return null;
    }
  }
  if (notes.isNotEmpty && !fs1.treeAppend(handle, _concat(notes))) {
    fs1.treeFree(handle);
    return null;
  }
  if (notes.isEmpty) return (handle: handle, root: Uint8List(0));
  final root = fs1.treeRoot(handle);
  if (root == null || root.length != 32) {
    fs1.treeFree(handle);
    return null;
  }
  return (handle: handle, root: root);
}

class _RewardLeaf {
  const _RewardLeaf(this.note, this.blind, this.owner, this.amount, this.unlock);
  final Uint8List note;
  final Uint8List blind;
  final Uint8List owner;
  final int amount;
  final int unlock;
}

_RewardLeaf _rewardLeaf(Map<String, dynamic> lock) {
  final amount = (lock['amount'] as num).toInt();
  if (amount != kPiSheNanos) throw StateError('stake_reward');
  final index = (lock['index'] as num?)?.toInt() ?? 0;
  final seed = _asBytes(lock['seed']);
  var owner = _asBytes(lock['scalar']);
  var blind = _asBytes(lock['blind']);
  var unlock = kVaultUnlockOpen;
  if (lock['unlockEpoch'] != null) unlock = (lock['unlockEpoch'] as num).toInt();
  final ownerSeed = seed.length == 32 ? (reservePortalSpendSeed(seed, index) ?? seed) : null;
  if (owner.length != 32) {
    if (ownerSeed == null) owner = scalarBytes(randomScalar());
    else owner = vaultLockOwnerBytes(ownerSeed, index);
  }
  if (blind.length != 32) {
    if (ownerSeed == null) blind = scalarBytes(randomScalar());
    else blind = vaultLockBlindBytes(ownerSeed, index, amount, 0);
  }
  if (lock['unlockEpoch'] == null && ownerSeed != null) {
    final epoch = (lock['lockEpoch'] as num?)?.toInt() ?? 0;
    unlock = consensusUnlockPeriod(epoch);
  }
  return _RewardLeaf(_lockNote(amount, owner, blind, unlock), blind, owner, amount, unlock);
}

/// Note bytes a claim opening derives. Used to find that leaf in the live list.
Uint8List vaultLockOpeningNote(Map<String, dynamic> lock) => _rewardLeaf(lock).note;

bool _sameRoot(Uint8List root, Uint8List chain) {
  if (root.length != 32 || chain.length != 32) return false;
  for (var i = 0; i < 32; i++) {
    if (root[i] != chain[i]) return false;
  }
  return true;
}

Map<String, dynamic>? _openingLock(List<Map<String, dynamic>> locks, int index) {
  if (locks.isEmpty) return null;
  if (index >= 0 && index < locks.length) {
    final at = locks[index];
    if (at['scalar'] != null || at['seed'] != null || at['blind'] != null) return at;
  }
  if (locks.length == 1) return locks[0];
  return null;
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
  required String magic,
  required Uint8List digest,
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
    utf8Bytes(magic),
    digest,
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
  List<Uint8List>? notes,
  Uint8List? chainRoot,
  required int rootEpoch,
  required int earnEpoch,
  required int bps,
  required int remainMs,
  required int span,
  required Uint8List dest20,
  String magic = kBookMagic,
}) {
  requireRangeOffUi();
  final fs1 = Fs1Native.tryLoad();
  if (fs1 == null) throw StateError('fs1_prover_unavailable');
  if (rootEpoch != earnEpoch) throw StateError('stake_reward');
  if (locks.isEmpty) throw StateError('unsigned');
  if (dest20.length != 20) throw StateError('unsigned');
  final listed = notes != null;
  late final List<Uint8List> treeNotes;
  late final Uint8List leafOwner;
  late final Uint8List leafBlind;
  late final int leafAmount;
  late final int leafUnlock;
  late final int proveAt;
  if (listed) {
    if (chainRoot == null || chainRoot.length != 32) throw StateError('vault_root');
    proveAt = which;
    if (proveAt < 0 || proveAt >= notes.length) throw StateError('unsigned');
    final lock = _openingLock(locks, proveAt);
    if (lock == null) throw StateError('unsigned');
    final row = _rewardLeaf(lock);
    if (!_bytesEq(row.note, notes[proveAt])) throw StateError('vault_root');
    treeNotes = notes;
    leafOwner = row.owner;
    leafBlind = row.blind;
    leafAmount = row.amount;
    leafUnlock = row.unlock;
  } else {
    if (which < 0 || which >= locks.length) throw StateError('unsigned');
    final rows = <_RewardLeaf>[];
    for (final lock in locks) {
      rows.add(_rewardLeaf(lock));
    }
    treeNotes = [for (final row in rows) row.note];
    final row = rows[which];
    leafOwner = row.owner;
    leafBlind = row.blind;
    leafAmount = row.amount;
    leafUnlock = row.unlock;
    proveAt = which;
  }
  final built = vaultLockTree(fs1, treeNotes);
  if (built == null || built.root.length != 32) throw StateError('fs1_prover_unavailable');
  final handle = built.handle;
  try {
    final root = built.root;
    if (listed || chainRoot != null) {
      if (chainRoot == null || !_sameRoot(root, chainRoot)) throw StateError('vault_root');
    }
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
    final unlock = leafUnlock;
    final epoch = earnEpoch;
    if (epoch >= unlock) throw StateError('stake_reward');
    final amount = BigInt.from(leafAmount);
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
    final nullP = pointBytes(mulEl(epochEl, scalarFromBytes(leafOwner)));
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
    final proved = fs1.proveUnlinked(handle, [proveAt], [leafOwner], digest, epoch, epochBase);
    if (proved == null || proved.records.isEmpty || proved.link.length < 96) throw StateError('fs1_prover_unavailable');
    final record = proved.records.first;
    if (record.length != kFs1RecordBytes || record[0] != kFs1Wire) throw StateError('fs1_prover_unavailable');
    final cTilde = Uint8List.sublistView(record, 33, 65);
    final t = proved.t.first;
    final openS = scalarAdd(scalarFromBytes(leafBlind), scalarFromBytes(t));
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
      magic: magic,
      digest: digest,
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
      hashToRistretto(pointBytes(admitPub(scalarFromBytes(leafOwner))), utf8Bytes('shear-admit-Hp')),
      scalarFromBytes(leafOwner),
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
        'r': scalarBytes(noteR),
        if (wrapped['rEph'] != null) 'rEph': wrapped['rEph'],
        if (wrapped['rCt'] != null) 'rCt': wrapped['rCt'],
      },
    };
  } finally {
    fs1.treeFree(handle);
  }
}

/// Isolate entry. Notes and the chain root are the one live-list read.
Map<String, dynamic> proveVaultLockRewardWire(Map<String, dynamic> input) {
  final raw = input['locks'];
  if (raw is! List) throw StateError('unsigned');
  final locks = <Map<String, dynamic>>[
    for (final row in raw) Map<String, dynamic>.from(row as Map),
  ];
  final dest20 = _asBytes(input['dest20']);
  final notes = input.containsKey('notes') ? _noteList(input['notes']) : null;
  if (input.containsKey('notes') && notes == null) throw StateError('vault_root');
  Uint8List? chainRoot;
  if (input.containsKey('chainRoot')) {
    chainRoot = _b32(input['chainRoot']);
    if (chainRoot == null) throw StateError('vault_root');
  }
  return proveVaultLockReward(
    locks: locks,
    which: (input['which'] as num?)?.toInt() ?? 0,
    notes: notes,
    chainRoot: chainRoot,
    rootEpoch: (input['rootEpoch'] as num).toInt(),
    earnEpoch: (input['earnEpoch'] as num).toInt(),
    bps: (input['bps'] as num).toInt(),
    remainMs: (input['remainMs'] as num).toInt(),
    span: (input['span'] as num).toInt(),
    dest20: dest20,
    magic: (input['magic'] as String?) ?? kBookMagic,
  );
}

/// How many vault proves [Isolate.run] has returned to this isolate.
int debugVaultProveIsolateRuns = 0;

/// How many vault proves the flutter_tester shortcut ran on the caller.
int debugVaultProveOnCaller = 0;

/// Isolate stamp of the last vault prove.
String debugVaultProveStamp = '';

/// flutter_tester does not finish [Isolate.run] inside one pumped frame, so
/// tests prove on the caller. Production leaves FLUTTER_TEST unset and proves
/// off the UI isolate. [SHEAR_VAULT_PROVE_OFF_UI] forces that path.
bool vaultProveOnCaller() =>
    Platform.environment['SHEAR_VAULT_PROVE_OFF_UI'] != '1' &&
    Platform.environment['FLUTTER_TEST'] == 'true';

Map<String, dynamic> proveVaultLockRewardStamped(Map<String, dynamic> input) {
  final stamp = identityHashCode(Isolate.current).toString();
  try {
    final out = proveVaultLockRewardWire(input);
    out['isolateStamp'] = stamp;
    return out;
  } on StateError catch (e) {
    return {'ok': false, 'error': e.message, 'isolateStamp': stamp};
  }
}

Map<String, dynamic> _vaultProveTaken(Map<String, dynamic> out) {
  debugVaultProveStamp = out['isolateStamp']?.toString() ?? '';
  final err = out['error'];
  if (out['ok'] != true && err != null) throw StateError(err.toString());
  return out;
}

/// Claim or roll prove. Production runs in [Isolate.run].
Future<Map<String, dynamic>> proveVaultLockOffUi(Map<String, dynamic> input) {
  if (vaultProveOnCaller()) {
    debugVaultProveOnCaller += 1;
    try {
      return Future<Map<String, dynamic>>.value(
        _vaultProveTaken(proveVaultLockRewardStamped(input)),
      );
    } on StateError catch (e) {
      return Future<Map<String, dynamic>>.error(e);
    }
  }
  return Isolate.run(() => proveVaultLockRewardStamped(input)).then((out) {
    debugVaultProveIsolateRuns += 1;
    return _vaultProveTaken(out);
  });
}

const String kVoteNullDst = 'shear-vote-null-v1';
const String kVoteStmtDst = 'shear-vote-stmt-v1';
const String kVoteFs1Mask = 'shear-vote-fs1-v1';
const String kVoteProposalDst = 'shear-vote-proposal-v1';
const String kVoteTagDst = 'shear-vote-v1';
const int kVoteVer = 0x56;

Uint8List? _b32(Object? v) {
  if (v is Uint8List && v.length == 32) return v;
  if (v is List<int> && v.length == 32) return Uint8List.fromList(v);
  if (v is String) {
    final hex = v.startsWith('0x') || v.startsWith('0X') ? v.substring(2) : v;
    if (hex.length != 64) return null;
    final out = Uint8List(32);
    for (var i = 0; i < 32; i++) {
      final byte = int.tryParse(hex.substring(i * 2, i * 2 + 2), radix: 16);
      if (byte == null) return null;
      out[i] = byte;
    }
    return out;
  }
  return null;
}

/// 64-byte notes, or 128 hex chars. Null when any leaf is not a note.
List<Uint8List>? _noteList(Object? raw) {
  if (raw is! List) return null;
  final out = <Uint8List>[];
  for (final row in raw) {
    if (row is Uint8List && row.length == 64) {
      out.add(row);
      continue;
    }
    if (row is List<int> && row.length == 64) {
      out.add(Uint8List.fromList(row));
      continue;
    }
    if (row is String) {
      final hex = row.startsWith('0x') || row.startsWith('0X') ? row.substring(2) : row;
      if (hex.length != 128) return null;
      final note = Uint8List(64);
      var ok = true;
      for (var i = 0; i < 64; i++) {
        final byte = int.tryParse(hex.substring(i * 2, i * 2 + 2), radix: 16);
        if (byte == null) {
          ok = false;
          break;
        }
        note[i] = byte;
      }
      if (!ok) return null;
      out.add(note);
      continue;
    }
    return null;
  }
  return out;
}

Uint8List _maskVoteFs1(Uint8List fs1, Uint8List linkN) {
  final out = Uint8List.fromList(fs1);
  var block = Uint8List(0);
  var used = 0;
  var n = 0;
  for (var i = 0; i < out.length; i++) {
    if (used >= block.length) {
      block = _sha256(_concat([utf8Bytes(kVoteFs1Mask), linkN, _u32(n)]));
      n += 1;
      used = 0;
    }
    out[i] ^= block[used];
    used += 1;
  }
  return out;
}

bool _contains(Uint8List hay, Uint8List needle) {
  if (needle.isEmpty || hay.length < needle.length) return false;
  for (var i = 0; i + needle.length <= hay.length; i++) {
    var same = true;
    for (var j = 0; j < needle.length; j++) {
      if (hay[i + j] != needle[j]) {
        same = false;
        break;
      }
    }
    if (same) return true;
  }
  return false;
}

class _VoteLeaf {
  const _VoteLeaf(this.note, this.owner);
  final Uint8List note;
  final Uint8List owner;
}

/// Same note the vote prover derives. Seed locks are a claim opening, not this.
_VoteLeaf? _voteLeaf(Map<String, dynamic> lock) {
  final amount = (lock['amount'] as num?)?.toInt() ?? 0;
  if (amount != kPiSheNanos) return null;
  final owner = _b32(lock['scalar']);
  final blind = _b32(lock['blind']);
  if (owner == null || blind == null) return null;
  var unlock = kVaultUnlockOpen;
  if (lock['unlockEpoch'] != null) {
    unlock = (lock['unlockEpoch'] as num).toInt();
  } else if (lock['unlock'] != null) {
    unlock = (lock['unlock'] as num).toInt();
  }
  if (unlock < 0) return null;
  try {
    return _VoteLeaf(_lockNote(amount, owner, blind, unlock), owner);
  } catch (_) {
    return null;
  }
}

/// Note bytes a vote opening derives. Used to find that leaf in the live list.
Uint8List? vaultVoteLeafNote(Map<String, dynamic> lock) => _voteLeaf(lock)?.note;

/// One private read of the live lock notes and the chain root.
class VaultLockCensus {
  VaultLockCensus(this.notes, this.root);
  final List<Uint8List> notes;
  final Uint8List root;
}

/// Calls [read] once. Extra fields, including spendable, are ignored.
Future<VaultLockCensus> readVaultLockCensus(
  Future<Map<String, dynamic>> Function() read,
) async {
  final body = await read();
  if (body['ok'] == false) throw StateError('vault_root');
  final notes = _noteList(body['notes']);
  final root = _b32(body['root']);
  if (notes == null || root == null) throw StateError('vault_root');
  return VaultLockCensus(notes, root);
}

/// Point a one-lock claim at that lock's index in [census]. The opening stays one lock.
Map<String, dynamic> attachVaultLockCensus(
  Map<String, dynamic> input,
  VaultLockCensus census,
) {
  final raw = input['locks'];
  if (raw is! List || raw.length != 1 || raw.single is! Map) {
    throw StateError('vault_root');
  }
  final lock = Map<String, dynamic>.from(raw.single as Map);
  final index = vaultLockNoteIndex(census.notes, vaultLockOpeningNote(lock));
  if (index < 0) throw StateError('vault_root');
  return {
    ...input,
    'locks': [lock],
    'which': index,
    'notes': census.notes,
    'chainRoot': census.root,
  };
}

/// Vote-only proof. Same layout as `proveLeafVote` in crypto/vault_reward_fs1.js:
/// 0x56 || u64 epoch || N || linkAnn || linkSr || u32 fs1Len || masked fs1 || record || dest20.
/// A missing native library returns null. The raw leaf commit is not in the blob.
/// [notes] is the node's full ordered live list. A chain root that is not that
/// tree's root returns null and does not emit a proof.
Map<String, Object?>? proveLeafVote({
  required List<Map<String, dynamic>> locks,
  int which = 0,
  List<Uint8List>? notes,
  Uint8List? chainRoot,
  required int epoch,
  required int choice,
  required int seq,
  required Uint8List proposalId,
  Uint8List? dest20,
  String magic = kBookMagic,
}) {
  requireRangeOffUi();
  final fs1 = Fs1Native.tryLoad();
  if (fs1 == null) return null;
  if (epoch < 0 || proposalId.length != 32) return null;
  if (choice != -1 && choice != 0 && choice != 1) return null;
  if (seq < 1 || seq > 8) return null;
  final listed = notes != null;
  late final List<Uint8List> treeNotes;
  late final Uint8List leafOwner;
  late final Uint8List leafNote;
  late final int proveAt;
  if (listed) {
    if (chainRoot == null || chainRoot.length != 32) return null;
    proveAt = which;
    if (proveAt < 0 || proveAt >= notes.length) return null;
    final lock = _openingLock(locks, proveAt);
    if (lock == null) return null;
    final row = _voteLeaf(lock);
    if (row == null || !_bytesEq(row.note, notes[proveAt])) return null;
    treeNotes = notes;
    leafOwner = row.owner;
    leafNote = row.note;
  } else {
    if (locks.isEmpty || which < 0 || which >= locks.length) return null;
    final builtNotes = <Uint8List>[];
    Uint8List? owner;
    Uint8List? note;
    for (var i = 0; i < locks.length; i++) {
      final row = _voteLeaf(locks[i]);
      if (row == null) return null;
      builtNotes.add(row.note);
      if (i == which) {
        owner = row.owner;
        note = row.note;
      }
    }
    if (owner == null || note == null) return null;
    treeNotes = builtNotes;
    leafOwner = owner;
    leafNote = note;
    proveAt = which;
  }
  final built = vaultLockTree(fs1, treeNotes);
  if (built == null || built.root.length != 32) return null;
  final handle = built.handle;
  try {
    final root = built.root;
    if (listed || chainRoot != null) {
      if (chainRoot == null || !_sameRoot(root, chainRoot)) return null;
    }
    final dest = dest20 != null && dest20.length == 20 ? Uint8List.fromList(dest20) : randomBytes(20);
    final choiceByte = choice < 0 ? 0xff : choice;
    final digest = _sha256(_concat([
      utf8Bytes(kVoteStmtDst),
      root,
      _u64(epoch),
      proposalId,
      Uint8List.fromList([choiceByte]),
      _u32(seq),
      utf8Bytes(magic),
      dest,
    ]));
    final epochBase = pointBytes(hashToRistretto(_concat([_u64(epoch), proposalId]), utf8Bytes(kVoteNullDst)));
    final proved = fs1.proveUnlinked(handle, [proveAt], [leafOwner], digest, epoch, epochBase);
    if (proved == null || proved.records.isEmpty || proved.link.length < 96) return null;
    final record = proved.records.first;
    if (record.length != kFs1RecordBytes || record[0] != kFs1Wire) return null;
    final linkAnn = Uint8List.sublistView(proved.link, 0, 32);
    final linkSr = Uint8List.sublistView(proved.link, 32, 64);
    final linkN = Uint8List.sublistView(proved.link, 64, 96);
    final expectN = pointBytes(mulEl(pointFrom(epochBase), scalarFromBytes(leafOwner)));
    if (!_bytesEq(expectN, linkN)) return null;
    final stable = pointBytes(mulEl(hp(admitPub(scalarFromBytes(leafOwner))), scalarFromBytes(leafOwner)));
    if (_bytesEq(stable, Uint8List.sublistView(record, 1, 33))) return null;
    final masked = _maskVoteFs1(proved.fs1, linkN);
    final blob = _concat([
      Uint8List.fromList([kVoteVer]),
      _u64(epoch),
      linkN,
      linkAnn,
      linkSr,
      _u32(masked.length),
      masked,
      record,
      dest,
    ]);
    final leaf = leafNote;
    final commit = Uint8List.sublistView(leaf, 32, 64);
    if (_contains(blob, leaf) || _contains(blob, commit)) return null;
    final admit = AdmitNative.tryLoad();
    if (admit == null) return null;
    final r = randomScalar();
    final range = admit.proveRange(BigInt.one, scalarBytes(r));
    if (range == null || range.isEmpty) return null;
    final note = wrapNoteBlind({
      'kind': 'leaf-vote',
      'noteCommit': noteCommitOfDest20(dest),
      'commit': commitBytes(1, scalarBytes(r)),
      'r': scalarBytes(r),
      'rangeProof': range,
      'dest20': dest,
    }, admitPub(randomScalar()), v: BigInt.one);
    final tag = _sha256(_concat([utf8Bytes(kVoteTagDst), linkN, _u64(epoch), proposalId]));
    return {
      'ok': true,
      'blob': blob,
      'root': root,
      'voteTag': tag,
      'note': note,
      'dest20': dest,
      'epoch': epoch,
      'choice': choice,
      'voteSeq': seq,
    };
  } finally {
    fs1.treeFree(handle);
  }
}

Map<String, dynamic> proveLeafVoteWire(Map<String, dynamic> input) {
  final stamp = identityHashCode(Isolate.current).toString();
  try {
    final raw = input['locks'];
    if (raw is! List) throw StateError('unsigned');
    final locks = <Map<String, dynamic>>[
      for (final row in raw) Map<String, dynamic>.from(row as Map),
    ];
    final notes = input.containsKey('notes') ? _noteList(input['notes']) : null;
    if (input.containsKey('notes') && notes == null) throw StateError('vault_root');
    Uint8List? chainRoot;
    if (input.containsKey('chainRoot')) {
      chainRoot = _b32(input['chainRoot']);
      if (chainRoot == null) throw StateError('vault_root');
    }
    final proposal = _b32(input['proposalId']);
    if (proposal == null) throw StateError('unsigned');
    final dest = input['dest20'];
    final proved = proveLeafVote(
      locks: locks,
      which: (input['which'] as num?)?.toInt() ?? 0,
      notes: notes,
      chainRoot: chainRoot,
      epoch: (input['epoch'] as num).toInt(),
      choice: (input['choice'] as num).toInt(),
      seq: (input['seq'] as num).toInt(),
      proposalId: proposal,
      dest20: dest is Uint8List
          ? dest
          : (dest is List<int> ? Uint8List.fromList(dest) : null),
      magic: (input['magic'] as String?) ?? kBookMagic,
    );
    if (proved == null) return {'ok': false, 'isolateStamp': stamp};
    return {...proved, 'isolateStamp': stamp};
  } on StateError catch (e) {
    return {'ok': false, 'error': e.message, 'isolateStamp': stamp};
  }
}

Map<String, dynamic> proveLeafVoteStamped(Map<String, dynamic> input) =>
    proveLeafVoteWire(input);

/// Vote prove. Production runs in [Isolate.run]. Null when the proof is refused.
Future<Map<String, Object?>?> proveLeafVoteOffUi(Map<String, dynamic> input) async {
  final Map<String, dynamic> out;
  if (vaultProveOnCaller()) {
    debugVaultProveOnCaller += 1;
    out = proveLeafVoteStamped(input);
  } else {
    out = await Isolate.run(() => proveLeafVoteStamped(input));
    debugVaultProveIsolateRuns += 1;
  }
  debugVaultProveStamp = out['isolateStamp']?.toString() ?? '';
  if (out['ok'] != true) return null;
  return out;
}

/// sha256('shear-vote-proposal-v1' || epoch || param). `hb` or `rr` only.
Uint8List? voteProposalId(int epoch, String param) {
  if (epoch < 0 || (param != 'hb' && param != 'rr')) return null;
  return _sha256(_concat([utf8Bytes(kVoteProposalDst), _u64(epoch), utf8Bytes(param)]));
}

/// Hidden change for a vote fee. No value opening. The range proof stays.
/// [spendSeed] is the one-time key the note will be spent under. [admitBase]
/// is the wallet base that opens the blind. A call with neither keeps the
/// discarded random base the older emitter used.
Map<String, dynamic>? hiddenChangeNote(
  int nanos,
  Uint8List dest20, {
  Uint8List? spendSeed,
  Element? admitBase,
}) {
  if (nanos <= 0 || dest20.length != 20) return null;
  final admit = AdmitNative.tryLoad();
  if (admit == null) return null;
  final r = randomScalar();
  final range = admit.proveRange(BigInt.from(nanos), scalarBytes(r));
  if (range == null || range.isEmpty) return null;
  final note = <String, dynamic>{
    'kind': 'send',
    'noteCommit': noteCommitOfDest20(dest20),
    'commit': commitBytes(nanos, scalarBytes(r)),
    'r': scalarBytes(r),
    'rangeProof': range,
    'dest20': dest20,
  };
  if (spendSeed != null && spendSeed.length == 32) {
    return attachAdmitPub(note, spendSeed: spendSeed, admitBase: admitBase, v: BigInt.from(nanos));
  }
  return wrapNoteBlind(note, admitPub(randomScalar()), v: BigInt.from(nanos));
}
