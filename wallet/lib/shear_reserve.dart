import 'dart:convert';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_admit.dart';
import 'shear_ctf.dart';
import 'shear_identity.dart';
import 'shear_ledger.dart';
import 'shear_levy.dart';

const kReserveProgram = 'shear-reserve-v1';
const kReserveOracleId = 'shear-reserve-oracle-v1';
const kPiSheNanos = 314159265358;
const kPiShe = kPiSheNanos / kUnitsPerShe;
const kReserveEpochDaysTestnet = 4;
const kReserveEpochDaysMainnet = 400;
const kReserveEpochDays = kBookMagic == 'shear-v1' ? kReserveEpochDaysMainnet : kReserveEpochDaysTestnet;
const kReserveJoinCutoffDaysTestnet = 1;
const kReserveJoinCutoffDaysMainnet = 99;
const kReserveJoinCutoffDays = kBookMagic == 'shear-v1' ? kReserveJoinCutoffDaysMainnet : kReserveJoinCutoffDaysTestnet;
const kReserveEpochMs = kReserveEpochDays * 86400000;
const kReserveJoinCutoffMs = kReserveJoinCutoffDays * 86400000;
/// Trimmed mean of the bundled policy rates (14 banks, drop 2 each side). 2.84%.
const kReserveOracleDefaultBps = 284;
const kBpsStepCap = 100;
const kStaleObserveMs = 14 * 86400000;
const kVoteIncrease = 'increase bonus';
const kVoteDecrease = 'decrease bonus';
const kVoteHold = 'leave bonus as-is';
const kReserveCutoffDisclaimer =
    'Fewer than $kReserveJoinCutoffDays days remain. New deposits still lock and can unlock a vote, even on a first Reserve deposit. They do not earn stake.';
const kReserveAccruedLabel = 'Reserve reward';
const kVoteConfirmWait = 'Vote is waiting on 9 confirmations of the reserve lock.';

/// Vote attempt while this portal's own deposits are still under π.
const kVoteBelowPi = 'ineligible, please deposit at least Pi and wait for it to confirm';

/// 1-based epoch day. The first 24h is day 1. Never returns 0.
int reserveDayOfEpoch({
  required int epochStartMs,
  required int nowMs,
  int days = kReserveEpochDays,
}) {
  final span = days < 1 ? 1 : days;
  if (epochStartMs <= 0) return 1;
  final elapsed = nowMs - epochStartMs;
  if (elapsed <= 0) return 1;
  final raw = (elapsed / 86400000).floor() + 1;
  if (raw < 1) return 1;
  if (raw > span) return span;
  return raw;
}

String reserveEpochStillOpenCopy([int days = kReserveEpochDays]) =>
    'The epoch is still open. Withdraw after $days days.';

/// Shown on the withdraw control while this deposit's own lock epoch is open.
const kReserveUnlocksAtEpochEnd = 'unlocks at epoch end';

String reserveWithdrawDialogCopy([int days = kReserveEpochDays]) =>
    'Return principal and the Reserve reward for this $days-day epoch to Continuum.\nThis settles the finished epoch.\nSign is local-only (testnet). Not full custody.';

class VortexSums {
  const VortexSums({
    required this.yourNanos,
    required this.overallNanos,
    required this.flowNanos,
  });

  /// Portal principal. Role label: portal.
  final int yourNanos;
  /// Program locked total. Role label: program.
  final int overallNanos;
  /// Continuum figure the caller already reconstructed. Role label: continuum.
  final int flowNanos;
}

/// One reconstruct for the Vortex Your, Overall, and Flow lines.
VortexSums reconstructVortexSums(ShearReserve reserve, String dest, {int flowNanos = 0}) {
  final your = dest.isEmpty ? 0 : reserve.portal(dest).nanos;
  final overall = reserve.totalLockedNanos < 0 ? 0 : reserve.totalLockedNanos;
  final flow = flowNanos < 0 ? 0 : flowNanos;
  return VortexSums(
    yourNanos: your < 0 ? 0 : your,
    overallNanos: overall,
    flowNanos: flow,
  );
}

/// Payout a withdraw would post, without mutating the reserve.
/// Principal is only the deposits whose own lock epoch has ended.
int reserveWithdrawPayoutNanos(ShearReserve reserve, String dest, int nowMs) {
  final p = reserve.portal(dest);
  final principal = reserve.maturedPrincipalNanos(dest, nowMs);
  if (principal <= 0) return 0;
  final epochOver = reserve.epochIsOver(nowMs);
  final full = p.nanos > 0 && principal == p.nanos;
  final interest = epochOver && full
      ? (p.claimableRewards > 0 ? p.claimableRewards : reserveInterestNanos(p.staked, reserve.epochBps))
      : 0;
  if (!extraMintAllowed(kReserveProgram)) return 0;
  return principal + interest;
}

/// Post kind withdraw, then settle the local portal. A failed send leaves the portal.
Future<({ShearTx tx, Map<String, int> settled})?> postReserveWithdraw(
  ShearLedger ledger, {
  required ShearReserve reserve,
  required String dest,
  required String payout,
  required int nowMs,
  Uint8List? spendSeed,
  bool local = false,
  String? restFrame,
  String? paymentCode,
  bool allowPublicHttp = false,
  bool settleLocal = true,
}) async {
  final nanos = reserveWithdrawPayoutNanos(reserve, dest, nowMs);
  if (nanos <= 0) return null;
  final amount = nanos / kUnitsPerShe;
  final from = (restFrame != null && restFrame.isNotEmpty)
      ? ledger.currentDest(restFrame, paymentCode: paymentCode)
      : payout;
  final tx = await ledger.send(
    from: from.isNotEmpty ? from : payout,
    to: payout,
    amount: amount,
    kind: 'withdraw',
    programId: kReserveProgram,
    local: local,
    spendSeed: spendSeed,
    restFrame: restFrame,
    paymentCode: paymentCode,
    allowPublicHttp: allowPublicHttp || !local,
    nanosWire: nanos.toString(),
  );
  if (tx.kind != 'withdraw') return null;
  if (!settleLocal) return (tx: tx, settled: <String, int>{});
  final settled = reserve.withdraw(dest: dest, nowMs: nowMs, payout: payout);
  if (settled == null) return null;
  return (tx: tx, settled: settled);
}

/// Unsealed oracle observe is advisory. It never mints Spendable.
String vaultObserveLabel({required bool sealed}) => sealed
    ? 'sealed'
    : 'advisory — not book-final';

/// Observe never adds Spendable. Sealed notes are a different path.
int spendableFromVaultObserve({required bool sealed, int oracleNanos = 0}) {
  if (!sealed || oracleNanos != 0) return 0;
  return 0;
}

bool extraMintAllowed(String programId) => programId == kReserveProgram;

/// Full-epoch interest: floor(stakedNanos * epochBps / 10000). Never `* 400 / 365`.
int reserveInterestNanos(int stakedNanos, int epochBps, [int days = kReserveEpochDays]) {
  if (stakedNanos <= 0 || epochBps < 0) return 0;
  days;
  return (BigInt.from(stakedNanos) * BigInt.from(epochBps) ~/ BigInt.from(10000)).toInt();
}

/// Accrued: `floor(stakedNanos * bps * e / (10000 * EPOCH_MS))`. Caps at epoch length (4d testnet / 400d mainnet).
int accruedNanos(int stakedNanos, int annualBps, int elapsedMs) {
  if (stakedNanos <= 0 || annualBps < 0 || elapsedMs <= 0) return 0;
  final ms = elapsedMs > kReserveEpochMs ? kReserveEpochMs : elapsedMs;
  return (BigInt.from(stakedNanos) *
          BigInt.from(annualBps) *
          BigInt.from(ms) ~/
          (BigInt.from(10000) * BigInt.from(kReserveEpochMs)))
      .toInt();
}

String reserveLocalDateTime(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms).toLocal();
  String p(int n) => n.toString().padLeft(2, '0');
  return '${d.year}-${p(d.month)}-${p(d.day)} ${p(d.hour)}:${p(d.minute)}';
}

class ReserveRewards {
  const ReserveRewards({
    required this.accrued,
    required this.projected,
    required this.staked,
    required this.idle,
    required this.oracleBps,
    required this.elapsedMs,
  });
  final int accrued;
  final int projected;
  final int staked;
  final int idle;
  final int oracleBps;
  final int elapsedMs;
}

String portalIdFromDest(String dest) {
  return sha256.convert(utf8.encode('shear-portal-v1') + utf8.encode(dest)).toString();
}

/// Same preimage as `withdrawMintId` in crypto/reserve_vault.js.
String withdrawMintId(String portalId, int epoch) {
  return sha256.convert([
    ...utf8.encode(kReserveProgram),
    ...utf8.encode(portalId),
    ...utf8.encode('$epoch'),
    ...utf8.encode('withdraw'),
  ]).toString();
}

Uint8List _shaParts(List<int> a, [List<int>? b]) {
  final buf = BytesBuilder(copy: false);
  buf.add(a);
  if (b != null) buf.add(b);
  return Uint8List.fromList(sha256.convert(buf.toBytes()).bytes);
}

String _hexBytes(List<int> bytes) {
  final out = StringBuffer();
  for (final b in bytes) {
    out.write(b.toRadixString(16).padLeft(2, '0'));
  }
  return out.toString();
}

Uint8List? _hexTo32(String hex) {
  final s = hex.trim().toLowerCase();
  if (s.length != 64) return null;
  final out = Uint8List(32);
  for (var i = 0; i < 32; i++) {
    final n = int.tryParse(s.substring(i * 2, i * 2 + 2), radix: 16);
    if (n == null) return null;
    out[i] = n;
  }
  return out;
}

/// Leaf over one reward. The preimage is the nullifier and the rho amount.
Uint8List rewardLeafBytes(String nullifierHex, int rho) {
  final id = _hexTo32(nullifierHex);
  if (id == null || rho <= 0) return Uint8List(0);
  final n = ByteData(8)..setUint64(0, rho, Endian.little);
  return _shaParts([
    ...utf8.encode('shear-reward-leaf-v1'),
    ...id,
    ...n.buffer.asUint8List(),
  ]);
}

Uint8List rewardMerkleRoot(List<Uint8List> leaves) {
  if (leaves.isEmpty) {
    return Uint8List.fromList(sha256.convert(utf8.encode('shear-empty-root-v1')).bytes);
  }
  var layer = <Uint8List>[
    for (final leaf in leaves)
      leaf.length == 32 ? leaf : Uint8List.fromList(sha256.convert(leaf).bytes),
  ];
  while (layer.length > 1) {
    final next = <Uint8List>[];
    for (var i = 0; i < layer.length; i += 2) {
      final a = layer[i];
      final b = i + 1 < layer.length ? layer[i + 1] : a;
      next.add(_shaParts(a, b));
    }
    layer = next;
  }
  return layer.first;
}

List<Map<String, String>> rewardMerkleProof(List<Uint8List> leaves, int index) {
  if (leaves.isEmpty || index < 0 || index >= leaves.length) return const [];
  var layer = <Uint8List>[
    for (final leaf in leaves)
      leaf.length == 32 ? leaf : Uint8List.fromList(sha256.convert(leaf).bytes),
  ];
  var idx = index;
  final proof = <Map<String, String>>[];
  while (layer.length > 1) {
    final pair = idx ^ 1;
    final sibling = pair < layer.length ? layer[pair] : layer[idx];
    proof.add({'side': idx.isEven ? 'R' : 'L', 'hash': _hexBytes(sibling)});
    final next = <Uint8List>[];
    for (var i = 0; i < layer.length; i += 2) {
      final a = layer[i];
      final b = i + 1 < layer.length ? layer[i + 1] : a;
      next.add(_shaParts(a, b));
    }
    layer = next;
    idx ~/= 2;
  }
  return proof;
}

/// Root over published `{nullifier, rho}` leaves, in that order.
String rewardSetRoot(List<Map<String, dynamic>> leaves) {
  final bytes = <Uint8List>[];
  for (final leaf in leaves) {
    final rhoRaw = leaf['rho'];
    final rho = rhoRaw is int ? rhoRaw : (rhoRaw is num ? rhoRaw.toInt() : int.tryParse('$rhoRaw') ?? 0);
    final hashed = rewardLeafBytes('${leaf['nullifier']}', rho);
    if (hashed.isEmpty) return '';
    bytes.add(hashed);
  }
  return _hexBytes(rewardMerkleRoot(bytes));
}

/// Scan published reward sets and seal this vault's own claims.
/// Production calls this only from [Isolate.run]. The view key never leaves
/// this map, and the returned rows do not carry it.
Map<String, dynamic> buildRewardClaimsWire(Map<String, dynamic> input) {
  final viewKey = (input['viewKey'] as String?) ?? '';
  final address = (input['address'] as String?) ?? '';
  final payee = (input['payee'] as String?) ?? '';
  final spendSeed = input['spendSeed'] is Uint8List ? input['spendSeed'] as Uint8List : null;
  final epochs = <int>[
    for (final raw in (input['epochs'] as List? ?? const <dynamic>[]))
      if (raw is int) raw else if (raw is num) raw.toInt(),
  ];
  final lock = viewKey.isEmpty ? null : vaultDest(address, viewKey: viewKey);
  if (payee.isEmpty || lock == null || payee == lock || spendSeed == null || spendSeed.length != 32) {
    return {'ok': false, 'reason': 'payee', 'rows': const <Map<String, dynamic>>[], 'isolateStamp': reserveIsolateStamp};
  }
  final portalId = portalIdFromDest(lock);
  final mine = <String>{
    for (final epoch in epochs) withdrawMintId(portalId, epoch),
  };
  final rows = <Map<String, dynamic>>[];
  final sets = input['sets'];
  if (sets is List) {
    for (final raw in sets) {
      if (raw is! Map) continue;
      final root = (raw['root'] ?? '').toString().toLowerCase();
      final leavesRaw = raw['leaves'];
      if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(root) || leavesRaw is! List || leavesRaw.isEmpty) {
        continue;
      }
      final leaves = <Uint8List>[];
      final metas = <Map<String, dynamic>>[];
      var bad = false;
      for (final leaf in leavesRaw) {
        if (leaf is! Map) {
          bad = true;
          break;
        }
        final id = (leaf['nullifier'] ?? '').toString().toLowerCase();
        final rhoRaw = leaf['rho'];
        final rho = rhoRaw is int ? rhoRaw : (rhoRaw is num ? rhoRaw.toInt() : int.tryParse('$rhoRaw') ?? 0);
        final hashed = rewardLeafBytes(id, rho);
        if (hashed.isEmpty) {
          bad = true;
          break;
        }
        leaves.add(hashed);
        metas.add({
          'nullifier': id,
          'rho': rho,
          'spent': leaf['spent'] == true,
        });
      }
      if (bad || leaves.length != leavesRaw.length) continue;
      if (_hexBytes(rewardMerkleRoot(leaves)) != root) continue;
      for (var i = 0; i < metas.length; i++) {
        final meta = metas[i];
        if (meta['spent'] == true) continue;
        if (!mine.contains(meta['nullifier'])) continue;
        final sealed = sealedReserveVout(payee, meta['rho'] as int, 'reward-claim');
        sealed.remove('portalId');
        if (sealed['commit'] is! Uint8List || sealed['address']?.toString() != payee) {
          return {
            'ok': false,
            'reason': 'payee',
            'rows': const <Map<String, dynamic>>[],
            'isolateStamp': reserveIsolateStamp,
          };
        }
        final note = attachAdmitPub(sealed, spendSeed: spendSeed);
        note.remove('portalId');
        if (note['address']?.toString() != payee) {
          return {
            'ok': false,
            'reason': 'payee',
            'rows': const <Map<String, dynamic>>[],
            'isolateStamp': reserveIsolateStamp,
          };
        }
        rows.add({
          'rho': meta['rho'],
          'nullifier': meta['nullifier'],
          'proof': rewardMerkleProof(leaves, i),
          'vout': note,
        });
      }
    }
  }
  return {
    'ok': true,
    'rows': rows,
    'isolateStamp': reserveIsolateStamp,
  };
}

/// Reward scan and seal. Always [Isolate.run], off the UI isolate.
Future<Map<String, dynamic>> scanRewardClaimsOffUi(Map<String, dynamic> input) {
  return Isolate.run(() => buildRewardClaimsWire(input));
}

class ReserveDepositRow {
  ReserveDepositRow({
    required this.nanos,
    required this.atMs,
    this.txid,
    this.noteIsPrincipal = false,
    this.epoch = 0,
    this.unlockAtMs = 0,
  });
  final int nanos;
  final int atMs;
  final String? txid;
  /// The lock output is the principal. A reserve withdraw would pay it again.
  final bool noteIsPrincipal;
  /// Chain epoch that contains [atMs]. 0 until the chain clock assigns one.
  final int epoch;
  /// End of [epoch]. 0 until the chain clock assigns one.
  final int unlockAtMs;
}

class ReserveEpochRow {
  ReserveEpochRow({required this.epoch, required this.startMs, required this.endMs});
  final int epoch;
  final int startMs;
  final int endMs;
}

class ReservePortal {
  ReservePortal({this.staked = 0, this.idle = 0, this.vote, this.joined = false, this.payout, this.voteEpoch = 0});
  int staked;
  int idle;
  String? vote;
  bool joined;
  int voteEpoch;
  String? payout;
  int? remoteAccrued;
  int claimableRewards = 0;
  final List<ReserveDepositRow> deposits = [];
  int get nanos => staked + idle;
  bool get canVote => nanos >= kPiSheNanos;
  int get remainingToVoteNanos => nanos >= kPiSheNanos ? 0 : kPiSheNanos - nanos;
}

class ShearReserve {
  int epochStartMs = 0;
  int currentEpoch = 0;
  bool bonusEnacted = false;
  int liveHashBonusNanos = 1;
  int totalLockedNanos = 0;
  int oracleBps = kReserveOracleDefaultBps;
  int oracleObservedAtMs = 0;
  final List<ReserveEpochRow> epochs = [];
  final Map<String, ReservePortal> portals = {};
  int votesIncrease = 0;
  int votesDecrease = 0;
  int votesHold = 0;
  int epochBps = kReserveOracleDefaultBps;
  int enactedUp = 0;
  int enactedDown = 0;
  int enactedHold = 0;
  int enactedDelta = 0;
  int enactedLiveBonus = 1;
  int enactedAtMs = 0;
  int feeBankNanos = 0;
  int mintBankNanos = 0;
  int totalStakedNanos = 0;
  int totalIdleNanos = 0;
  int totalAccruedNanos = 0;
  int totalClaimableNanos = 0;

  ReservePortal portal(String dest) {
    final id = portalIdFromDest(dest);
    return portals.putIfAbsent(id, ReservePortal.new);
  }

  int remainingMs(int nowMs) {
    if (epochStartMs == 0 || bonusEnacted) return kReserveEpochMs;
    final end = epochStartMs + kReserveEpochMs;
    final left = end - nowMs;
    return left < 0 ? 0 : left;
  }

  bool canJoin(int nowMs) {
    if (epochStartMs == 0) return true;
    return remainingMs(nowMs) >= kReserveJoinCutoffMs;
  }

  bool cutoffDisclaimer(int nowMs) {
    if (epochStartMs == 0) return false;
    return remainingMs(nowMs) < kReserveJoinCutoffMs;
  }

  int elapsedMs(int nowMs) {
    if (epochStartMs == 0) return 0;
    final e = nowMs - epochStartMs;
    if (e <= 0) return 0;
    return e > kReserveEpochMs ? kReserveEpochMs : e;
  }

  bool epochIsOver(int nowMs) =>
      epochStartMs != 0 && nowMs >= epochStartMs + kReserveEpochMs;

  /// End of the chain epoch that contains [d]. Every deposit on a pinned
  /// chain clock belongs to one epoch and unlocks at that epoch's end.
  int depositUnlockAtMs(ReserveDepositRow d) {
    if (d.unlockAtMs > 0) return d.unlockAtMs;
    return chainEpochOf(d.atMs).unlockAtMs;
  }

  /// Earliest chain epoch start this vault has been shown. Later epochs are
  /// this instant plus whole epoch lengths.
  int get chainGenesisMs {
    var g = 0;
    for (final e in epochs) {
      if (e.startMs > 0 && (g == 0 || e.startMs < g)) g = e.startMs;
    }
    if (g == 0 && epochStartMs > 0) return epochStartMs;
    return g;
  }

  int get _genesisEpochNumber {
    ReserveEpochRow? earliest;
    for (final e in epochs) {
      if (e.startMs <= 0) continue;
      if (earliest == null || e.startMs < earliest.startMs) earliest = e;
    }
    if (earliest != null && earliest.epoch >= 1) return earliest.epoch;
    if (epochStartMs > 0 && currentEpoch >= 1) return currentEpoch;
    return 1;
  }

  /// Chain epoch containing [atMs], and the instant that epoch ends.
  /// No pinned clock means no assignment.
  ({int epoch, int unlockAtMs}) chainEpochOf(int atMs) {
    if (atMs <= 0) return (epoch: 0, unlockAtMs: 0);
    for (final e in uniqueEpochs) {
      if (atMs >= e.startMs && atMs < e.endMs) {
        return (epoch: e.epoch, unlockAtMs: e.endMs);
      }
    }
    if (epochStartMs > 0 && atMs >= epochStartMs && atMs < epochStartMs + kReserveEpochMs) {
      final epoch = currentEpoch < 1 ? 1 : currentEpoch;
      return (epoch: epoch, unlockAtMs: epochStartMs + kReserveEpochMs);
    }
    final genesis = chainGenesisMs;
    if (genesis <= 0 || atMs < genesis) return (epoch: 0, unlockAtMs: 0);
    final index = (atMs - genesis) ~/ kReserveEpochMs;
    return (
      epoch: _genesisEpochNumber + index,
      unlockAtMs: genesis + (index + 1) * kReserveEpochMs,
    );
  }

  void _noteEpoch(int epoch, int endMs) {
    if (epoch < 1 || endMs <= kReserveEpochMs) return;
    if (epochs.any((e) => e.epoch == epoch)) return;
    epochs.add(ReserveEpochRow(
      epoch: epoch,
      startMs: endMs - kReserveEpochMs,
      endMs: endMs,
    ));
  }

  /// Stamp each deposit with the chain epoch that contains its time.
  void _assignOpenDeposits() {
    for (final p in portals.values) {
      for (var i = 0; i < p.deposits.length; i++) {
        final d = p.deposits[i];
        if (d.unlockAtMs > 0) continue;
        final hit = chainEpochOf(d.atMs);
        if (hit.unlockAtMs <= 0) continue;
        _noteEpoch(hit.epoch, hit.unlockAtMs);
        p.deposits[i] = ReserveDepositRow(
          nanos: d.nanos,
          atMs: d.atMs,
          txid: d.txid,
          noteIsPrincipal: d.noteIsPrincipal,
          epoch: hit.epoch,
          unlockAtMs: hit.unlockAtMs,
        );
      }
    }
  }

  /// Epochs whose reward nullifiers this vault should try. Epoch 1 is always
  /// included so a first-epoch reward is findable before the clock advances.
  List<int> rewardScanEpochs() {
    final out = <int>[];
    final seen = <int>{};
    void add(int epoch) {
      if (epoch >= 1 && seen.add(epoch)) out.add(epoch);
    }
    final cap = currentEpoch < 1 ? 1 : currentEpoch;
    for (var epoch = 1; epoch <= cap; epoch++) {
      add(epoch);
    }
    for (final row in uniqueEpochs) {
      add(row.epoch);
    }
    if (out.isEmpty) add(1);
    return out;
  }

  /// Legacy principal a reserve withdraw may pay. A deposit with no row list
  /// is the whole balance once the open epoch has ended. Time-lock rows are
  /// the note itself and are not part of this sum. [nowMs] is the chain tip.
  int maturedPrincipalNanos(String dest, int nowMs) {
    if (nowMs <= 0) return 0;
    final p = portal(dest);
    if (p.deposits.isEmpty) return epochIsOver(nowMs) ? p.nanos : 0;
    var sum = 0;
    for (final d in p.deposits) {
      if (d.noteIsPrincipal) continue;
      final unlock = depositUnlockAtMs(d);
      if (unlock > 0 && nowMs >= unlock) sum += d.nanos;
    }
    if (sum < 0) return 0;
    if (sum > p.nanos) return p.nanos;
    return sum;
  }

  /// True when this portal still has a reserve-withdraw (not a time-lock note).
  bool legacyWithdrawVisible(String dest) {
    final p = portal(dest);
    if (p.nanos <= 0) return false;
    if (p.deposits.isEmpty) return true;
    return p.deposits.any((d) => !d.noteIsPrincipal);
  }

  /// Matured deposits whose lock output is the principal note.
  /// [nowMs] is the chain tip. No tip means nothing has matured.
  int maturedTimeLockNanos(String dest, int nowMs) {
    if (nowMs <= 0) return 0;
    final p = portal(dest);
    var sum = 0;
    for (final d in p.deposits) {
      if (!d.noteIsPrincipal) continue;
      final unlock = depositUnlockAtMs(d);
      if (unlock > 0 && nowMs >= unlock) sum += d.nanos;
    }
    if (sum < 0) return 0;
    if (sum > p.nanos) return p.nanos;
    return sum;
  }

  /// Drop matured time-lock rows from the vault mirror. The note is the
  /// principal, so this does not pay interest and does not build a withdraw.
  /// [onlyAtMs] drops that one deposit. Omit it to drop every matured time-lock.
  int releaseTimeLockPrincipal({
    required String dest,
    required int nowMs,
    int? onlyAtMs,
  }) {
    final p = portal(dest);
    if (nowMs <= 0 || p.deposits.isEmpty) return 0;
    var sum = 0;
    var droppedOne = false;
    final keep = <ReserveDepositRow>[];
    for (final d in p.deposits) {
      final unlock = depositUnlockAtMs(d);
      final matured = d.noteIsPrincipal && unlock > 0 && nowMs >= unlock;
      final targeted = onlyAtMs == null || d.atMs == onlyAtMs;
      if (matured && targeted && (onlyAtMs == null || !droppedOne)) {
        sum += d.nanos;
        if (onlyAtMs != null) droppedOne = true;
      } else {
        keep.add(d);
      }
    }
    if (sum <= 0) return 0;
    if (sum > p.nanos) sum = p.nanos;
    var fromStaked = sum > p.staked ? p.staked : sum;
    var fromIdle = sum - fromStaked;
    if (fromIdle > p.idle) fromIdle = p.idle;
    final booked = fromStaked + fromIdle;
    p.staked -= fromStaked;
    p.idle -= fromIdle;
    totalLockedNanos -= booked;
    if (totalLockedNanos < 0) totalLockedNanos = 0;
    p.deposits
      ..clear()
      ..addAll(keep);
    if (p.nanos < kPiSheNanos) {
      p.joined = false;
    }
    return booked;
  }

  void _recordEpoch(int startMs) {
    if (currentEpoch < 1) currentEpoch = 1;
    if (epochs.any((e) => e.epoch == currentEpoch)) return;
    epochs.add(ReserveEpochRow(
      epoch: currentEpoch,
      startMs: startMs,
      endMs: startMs + kReserveEpochMs,
    ));
  }

  List<ReserveEpochRow> get uniqueEpochs {
    final seen = <int>{};
    return [for (final e in epochs) if (seen.add(e.epoch)) e];
  }

  int _freezeEpochBps(int nowMs) {
    final prev = epochBps >= 0 ? epochBps : kReserveOracleDefaultBps;
    if (oracleObservedAtMs <= 0 || (nowMs > 0 && nowMs - oracleObservedAtMs > kStaleObserveMs)) {
      return prev;
    }
    var next = oracleBps;
    if (next > prev + kBpsStepCap) next = prev + kBpsStepCap;
    if (next < prev - kBpsStepCap) next = prev - kBpsStepCap;
    if (next < 0) next = 0;
    return next;
  }

  void _beginEpoch(int nowMs) {
    epochStartMs = nowMs;
    bonusEnacted = false;
    epochBps = _freezeEpochBps(nowMs);
    _recordEpoch(nowMs);
  }

  /// Move a clock-0 epoch onto the first verified header time.
  /// Epoch start, the zero-start epoch row, and every deposit stamped at 0
  /// take that time, then open rows are assigned. A later header does not
  /// move an epoch that already has a positive start, and a later top-up
  /// must not be used as this anchor.
  void reanchorVerifiedClock(int verifiedMs) {
    if (verifiedMs <= 0 || epochStartMs > 0) return;
    final hasZeroEpoch = epochs.any((e) => e.startMs <= 0);
    final hasZeroRow = portals.values.any((p) => p.deposits.any((d) => d.atMs <= 0));
    if (!hasZeroEpoch && !hasZeroRow) return;
    epochStartMs = verifiedMs;
    for (var i = 0; i < epochs.length; i++) {
      final e = epochs[i];
      if (e.startMs > 0) continue;
      epochs[i] = ReserveEpochRow(
        epoch: e.epoch,
        startMs: verifiedMs,
        endMs: verifiedMs + kReserveEpochMs,
      );
    }
    if (epochs.isEmpty && currentEpoch >= 1) {
      _recordEpoch(verifiedMs);
    }
    for (final p in portals.values) {
      for (var i = 0; i < p.deposits.length; i++) {
        final d = p.deposits[i];
        if (d.atMs > 0) continue;
        p.deposits[i] = ReserveDepositRow(
          nanos: d.nanos,
          atMs: verifiedMs,
          txid: d.txid,
          noteIsPrincipal: d.noteIsPrincipal,
          epoch: d.epoch,
          unlockAtMs: d.unlockAtMs,
        );
      }
    }
    _assignOpenDeposits();
  }

  ReserveRewards rewards(String dest, int nowMs) {
    final p = portal(dest);
    final elapsed = elapsedMs(nowMs);
    return ReserveRewards(
      accrued: p.remoteAccrued ?? accruedNanos(p.staked, epochBps, elapsed),
      projected: reserveInterestNanos(p.staked, epochBps),
      staked: p.staked,
      idle: p.idle,
      oracleBps: epochBps,
      elapsedMs: elapsed,
    );
  }

  /// Restore this wallet's portal from shewall.bin / session. Node sync may overlay.
  void applyLocalSnapshot(Map<String, dynamic> json) {
    final dest = json['dest']?.toString() ?? '';
    if (dest.isEmpty) return;
    applyRemotePortal(dest, json);
    final p = portal(dest);
    p.joined = json['joined'] == true || p.nanos >= kPiSheNanos;
    if (json['vote'] != null) p.vote = json['vote'].toString();
    p.voteEpoch = (json['voteEpoch'] as num?)?.toInt() ?? p.voteEpoch;
  }

  /// Cold unlock, shewall import, and the CLI. The selector holds this
  /// portal's principal before a live read. A later portal read replaces it.
  void installRemembered(ShearLedger ledger, Map<String, dynamic> snapshot) {
    applyLocalSnapshot(snapshot);
    final dest = snapshot['dest']?.toString() ?? '';
    final nanos = dest.isEmpty ? 0 : portal(dest).nanos;
    ledger.bindSnapshotHold(dest, nanos);
  }

  /// Absolute principal. A second apply of the same credit does not add.
  void _assignPrincipal(ReservePortal p, int principal) {
    if (principal < 0) principal = 0;
    if (p.nanos == principal) return;
    p.staked = principal;
    p.idle = 0;
  }

  /// Chain lock/withdraw rows for this portal only. Ids are applied once.
  /// A thin remote map must not turn the two 10 SHE locks into a 40 SHE vault:
  /// the replay is their net, and it cannot exceed program [totalLockedNanos].
  int? _replayLockPrincipal(String dest, Map<String, dynamic> json) {
    final raw = json['locks'] ?? json['lockRows'];
    if (raw is! List || raw.isEmpty) return null;
    final pid = portalIdFromDest(dest);
    final seen = <String>{};
    var sum = 0;
    var saw = false;
    for (final item in raw) {
      if (item is! Map) continue;
      final row = Map<String, dynamic>.from(item);
      final kind = (row['kind'] ?? 'lock').toString();
      if (kind != 'lock' && kind != 'withdraw') continue;
      final rowPid = (row['portalId'] ?? '').toString().toLowerCase();
      final rowDest = (row['dest'] ?? row['to'] ?? '').toString();
      final mine = rowPid == pid ||
          rowDest == dest ||
          (rowDest.isNotEmpty && portalIdFromDest(rowDest) == pid);
      if (!mine) continue;
      final id = (row['id'] ?? row['txid'] ?? '').toString();
      if (id.isNotEmpty && !seen.add(id)) continue;
      var n = 0;
      if (row['nanos'] is num) {
        n = (row['nanos'] as num).round();
      } else if (row['amount'] is num) {
        n = ((row['amount'] as num) * kUnitsPerShe).round();
      }
      if (kind == 'withdraw') n = -n;
      if (n == 0) continue;
      saw = true;
      sum += n;
    }
    if (!saw) return null;
    if (sum < 0) sum = 0;
    final locked = (json['totalLockedNanos'] as num?)?.round();
    if (locked != null && locked >= 0 && sum > locked) sum = locked;
    return sum;
  }

  /// Principal the snapshot names for this portal. Network totalLockedNanos
  /// with no portal id is not this wallet's stake.
  int? _attributedPrincipal(String dest, Map<String, dynamic> json) {
    final pid = portalIdFromDest(dest);
    final named = (json['portalId'] ?? '').toString().toLowerCase();
    final namedDest = (json['dest'] ?? '').toString();
    if (named != pid && namedDest != dest) return null;
    final flagged = json['credited'] == true || json['attributed'] == true;
    final explicit = json['attributedNanos'] ?? json['principalNanos'];
    if (explicit is num) {
      final n = explicit.round();
      if (n > 0 && (flagged || json.containsKey('attributedNanos') || json.containsKey('principalNanos'))) {
        return n;
      }
    }
    if (!flagged) return null;
    final locked = (json['totalLockedNanos'] as num?)?.round() ?? 0;
    if (locked > 0) return locked;
    return null;
  }

  /// Node Join/Reserve VAULT read. Not a public vortice.
  ///
  /// A remote staked=0 idle=0 clears a portal that has no credit. It does not
  /// erase principal the snapshot attributes to this vault dest / portalId,
  /// or that this portal's own chain locks replay on a thin map.
  void applyRemotePortal(String dest, Map<String, dynamic> json) {
    final p = portal(dest);
    final hasStaked = json['staked'] is num;
    final hasIdle = json['idle'] is num;
    if (hasStaked || hasIdle) {
      final remoteStaked = hasStaked ? (json['staked'] as num).round() : p.staked;
      final remoteIdle = hasIdle ? (json['idle'] as num).round() : p.idle;
      if (remoteStaked + remoteIdle > 0) {
        p.staked = remoteStaked;
        p.idle = remoteIdle;
      } else {
        final replay = _replayLockPrincipal(dest, json);
        final attributed = _attributedPrincipal(dest, json);
        if (replay != null) {
          if (replay > 0) {
            _assignPrincipal(p, replay);
          } else {
            p.staked = 0;
            p.idle = 0;
          }
        } else if (attributed != null && attributed > 0) {
          _assignPrincipal(p, attributed);
        } else {
          p.staked = 0;
          p.idle = 0;
        }
      }
    }
    p.remoteAccrued = (json['accrued'] as num?)?.toInt();
    p.claimableRewards = (json['claimable'] as num?)?.toInt() ?? p.claimableRewards;
    if (json['joined'] == true || p.nanos >= kPiSheNanos) p.joined = true;
    feeBankNanos = (json['feeBankNanos'] as num?)?.toInt() ?? feeBankNanos;
    mintBankNanos = (json['mintBankNanos'] as num?)?.toInt() ?? mintBankNanos;
    totalStakedNanos = (json['totalStakedNanos'] as num?)?.toInt() ?? totalStakedNanos;
    totalIdleNanos = (json['totalIdleNanos'] as num?)?.toInt() ?? totalIdleNanos;
    totalAccruedNanos = (json['totalAccruedNanos'] as num?)?.toInt() ?? totalAccruedNanos;
    totalClaimableNanos = (json['totalClaimableNanos'] as num?)?.toInt() ?? totalClaimableNanos;
    final locked = (json['totalLockedNanos'] as num?)?.toInt();
    if (locked != null && locked >= 0) totalLockedNanos = locked;
    if (json['vote'] != null && json['vote'].toString().isNotEmpty) {
      p.vote = json['vote'].toString();
      p.voteEpoch = (json['voteEpoch'] as num?)?.toInt() ?? currentEpoch;
    }
    final votes = json['votes'];
    if (votes is Map) {
      votesIncrease = (votes['increase'] as num?)?.toInt() ?? 0;
      votesDecrease = (votes['decrease'] as num?)?.toInt() ?? 0;
      votesHold = (votes['hold'] as num?)?.toInt() ?? 0;
    }
    final freeze = (json['epochBps'] as num?)?.toInt();
    if (freeze != null && freeze >= 0) epochBps = freeze;
    enactedUp = (json['enactedUp'] as num?)?.toInt() ?? enactedUp;
    enactedDown = (json['enactedDown'] as num?)?.toInt() ?? enactedDown;
    enactedHold = (json['enactedHold'] as num?)?.toInt() ?? enactedHold;
    enactedDelta = (json['enactedDelta'] as num?)?.toInt() ?? enactedDelta;
    enactedLiveBonus = (json['enactedLiveBonus'] as num?)?.toInt() ?? enactedLiveBonus;
    enactedAtMs = (json['enactedAtMs'] as num?)?.toInt() ?? enactedAtMs;
    final bonus = (json['liveHashBonusNanos'] as num?)?.toInt();
    if (bonus != null && bonus >= 0) liveHashBonusNanos = bonus;
    if (json['bonusEnacted'] == true) bonusEnacted = true;
    if (json['bonusEnacted'] == false) bonusEnacted = false;
    final epochN = (json['currentEpoch'] as num?)?.toInt();
    if (epochN != null && epochN > 0) currentEpoch = epochN;
    final epoch = (json['epochStartMs'] as num?)?.toInt();
    if (epoch != null && epoch > 0) {
      epochStartMs = epoch;
      if (currentEpoch < 1) currentEpoch = 1;
      _recordEpoch(epoch);
    }
    final bps = (json['oracleBps'] as num?)?.toInt();
    if (bps != null && bps >= 0) oracleBps = bps;
  }

  String? observeRate({required int annualBps, required int nowMs}) {
    if (annualBps < 0 || annualBps > 10000) return 'bad_rate';
    oracleBps = annualBps;
    oracleObservedAtMs = nowMs;
    return null;
  }

  String? deposit({
    required String dest,
    required double she,
    required int nowMs,
    String? payout,
    bool noteIsPrincipal = false,
    int? sealedUnlockAtMs,
  }) {
    if (!isDestAddress(dest) || isShearAddress(dest)) return 'bad_dest';
    final n = (she * kUnitsPerShe).round();
    if (n <= 0) return 'bad_amount';
    final p = portal(dest);
    if (payout != null && isDestAddress(payout) && !isShearAddress(payout)) {
      p.payout = payout;
    }
    if (epochStartMs != 0 && !bonusEnacted && remainingMs(nowMs) == 0) {
      return 'need_enact';
    }
    if (canJoin(nowMs)) {
      p.staked += n;
    } else {
      p.idle += n;
    }
    totalLockedNanos += n;
    final sealed = sealedUnlockAtMs != null && sealedUnlockAtMs > 0 ? sealedUnlockAtMs : 0;
    p.deposits.add(ReserveDepositRow(
      nanos: n,
      atMs: nowMs,
      noteIsPrincipal: noteIsPrincipal,
      unlockAtMs: sealed,
    ));
    if (!p.joined && p.nanos >= kPiSheNanos) {
      p.joined = true;
      if (epochStartMs == 0) {
        currentEpoch = 1;
        _beginEpoch(nowMs);
      } else if (bonusEnacted) {
        currentEpoch += 1;
        votesIncrease = 0;
        votesDecrease = 0;
        votesHold = 0;
        _beginEpoch(nowMs);
      }
    }
    _assignOpenDeposits();
    return null;
  }

  String? vote({required String dest, required String choice, required int nowMs}) {
    nowMs;
    final p = portal(dest);
    if (!p.canVote) return 'not_voter';
    // A verified clock of 0 still begins the epoch (currentEpoch >= 1 and a
    // recorded row) so a π deposit can vote. epochStartMs stays 0, and unlock
    // stays closed, until a verified median time exists.
    final opened = currentEpoch >= 1 &&
        (epochStartMs != 0 || epochs.any((e) => e.epoch == currentEpoch));
    if (!opened || bonusEnacted) return 'not_voter';
    if (choice != kVoteIncrease && choice != kVoteDecrease && choice != kVoteHold) {
      return 'bad_vote';
    }
    final first = p.vote == null || p.voteEpoch != currentEpoch;
    if (!first) return 'vote_locked';
    p.vote = choice;
    p.voteEpoch = currentEpoch;
    if (choice == kVoteIncrease) votesIncrease++;
    if (choice == kVoteDecrease) votesDecrease++;
    if (choice == kVoteHold) votesHold++;
    return null;
  }

  Map<String, int>? withdraw({required String dest, required int nowMs, String? payout}) {
    final matured = maturedPrincipalNanos(dest, nowMs);
    final epochOver = epochStartMs != 0 && nowMs >= epochStartMs + kReserveEpochMs;
    if (matured <= 0) return null;
    if (epochOver && !bonusEnacted) {
      final up = votesIncrease, down = votesDecrease, hold = votesHold;
      final m = [up, down, hold].reduce((a, b) => a > b ? a : b);
      var winners = 0;
      var delta = 0;
      if (m > 0 && up == m) { winners++; delta = 1; }
      if (m > 0 && down == m) { winners++; delta = -1; }
      if (m > 0 && hold == m) { winners++; delta = 0; }
      if (winners == 1 && delta > 0) liveHashBonusNanos += 1;
      if (winners == 1 && delta < 0 && liveHashBonusNanos > 0) liveHashBonusNanos -= 1;
      bonusEnacted = true;
      enactedUp = up;
      enactedDown = down;
      enactedHold = hold;
      enactedDelta = winners == 1 ? delta : 0;
      enactedLiveBonus = liveHashBonusNanos;
      enactedAtMs = nowMs;
    }
    final p = portal(dest);
    if (p.payout != null && payout != null && payout != p.payout) return null;
    final claimable = p.claimableRewards;
    var principal = matured;
    if (principal > p.nanos) principal = p.nanos;
    final full = p.nanos > 0 && principal == p.nanos;
    final staked = principal > p.staked ? p.staked : principal;
    final idle = principal - staked > p.idle ? p.idle : principal - staked;
    final interest = epochOver && full
        ? (claimable > 0 ? claimable : reserveInterestNanos(p.staked, epochBps))
        : 0;
    if (principal <= 0 && interest <= 0) return null;
    if (!extraMintAllowed(kReserveProgram)) return null;
    if (p.payout == null && payout != null && isDestAddress(payout) && !isShearAddress(payout)) {
      p.payout = payout;
    }
    if (principal > 0) {
      totalLockedNanos -= principal;
      if (totalLockedNanos < 0) totalLockedNanos = 0;
      p.staked -= staked;
      p.idle -= idle;
      if (p.deposits.isNotEmpty) {
        p.deposits.removeWhere((d) {
          if (d.noteIsPrincipal) return false;
          final unlock = depositUnlockAtMs(d);
          return unlock > 0 && nowMs >= unlock;
        });
      }
      final stillVoter = p.nanos >= kPiSheNanos;
      if (!stillVoter) {
        if (p.vote == kVoteIncrease) votesIncrease--;
        if (p.vote == kVoteDecrease) votesDecrease--;
        if (p.vote == kVoteHold) votesHold--;
      }
      if (p.nanos <= 0) {
        p.staked = 0;
        p.idle = 0;
        p.joined = false;
        p.vote = null;
        p.payout = null;
      } else if (!stillVoter) {
        p.joined = false;
        p.vote = null;
      }
    }
    if (full) p.claimableRewards = 0;
    return {
      'principal': principal,
      'staked': staked,
      'idle': idle,
      'interest': interest,
      'claimable': claimable,
      'payout': principal + interest,
    };
  }

  /// Settle a finished epoch into Continuum spendable (principal + extra-minted interest).
  Map<String, int>? withdrawTo(
    ShearLedger ledger, {
    required String dest,
    required String payout,
    required int nowMs,
  }) {
    final out = withdraw(dest: dest, nowMs: nowMs, payout: payout);
    if (out == null) return null;
    // Sign does not mint Continuum spendable. The sealed payout is the credit.
    return out;
  }

  Map<String, dynamic> publicView(int nowMs) => {
        'epochStartMs': epochStartMs,
        'remainingMs': remainingMs(nowMs),
        'totalLockedNanos': totalLockedNanos,
        'votesIncrease': bonusEnacted ? enactedUp : votesIncrease,
        'votesDecrease': bonusEnacted ? enactedDown : votesDecrease,
        'votesHold': bonusEnacted ? enactedHold : votesHold,
        'oracleBps': oracleBps,
        'epochBps': epochBps,
        'liveHashBonusNanos': liveHashBonusNanos,
        'bonusEnacted': bonusEnacted,
        'currentEpoch': currentEpoch,
        'enactedUp': enactedUp,
        'enactedDown': enactedDown,
        'enactedHold': enactedHold,
        'enactedDelta': enactedDelta,
        'enactedLiveBonus': enactedLiveBonus,
        'enactedAtMs': enactedAtMs,
      };

  String publicJson(int nowMs) => jsonEncode(publicView(nowMs));
}

/// Unlock on the lock note this deposit's tx created.
/// A later lock on the same address does not match.
bool _lockNoteMatchesTx(
  Map<String, dynamic> note,
  String txId,
  List<Map<String, dynamic>> notes,
) {
  final own = note['txId']?.toString() ?? '';
  if (own.isNotEmpty) return own == txId;
  final id = note['id']?.toString() ?? '';
  if (id.isEmpty || id != txId) return false;
  // A 32-byte hex id is a blind id, not a transaction id.
  if (RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(id)) return false;
  for (final other in notes) {
    if (identical(other, note)) continue;
    final otherTx = (other['txId'] ?? '').toString();
    if (otherTx == txId) return false;
    // This id is already the blind on a note that has a real tx id.
    if (otherTx.isNotEmpty && (other['id'] ?? '').toString() == id) return false;
  }
  return true;
}

/// Unlock on the lock note this deposit's tx created.
/// A later lock on the same address does not match. `id` is used only when
/// `txId` is absent, the id is not a 32-byte blind, no other note already
/// has that tx id, and no note with a real tx id carries this string as its id.
int? sealedUnlockForTx(Iterable<Map<String, dynamic>> notes, String txId) {
  if (txId.isEmpty) return null;
  final list = notes is List<Map<String, dynamic>>
      ? notes
      : notes.toList();
  for (final n in list) {
    if ((n['kind'] ?? '').toString() != 'lock') continue;
    if (!_lockNoteMatchesTx(n, txId, list)) continue;
    final raw = n['unlockAtMs'];
    final at = raw is num ? raw.toInt() : int.tryParse('${raw ?? ''}') ?? 0;
    if (at > 0) return at;
  }
  return null;
}

class ReserveDepositResult {
  const ReserveDepositResult({required this.posted, required this.remark, this.tx});

  final bool posted;
  final String remark;
  final ShearTx? tx;
}

/// Same local flag the vault Deposit button passes. Production attaches a pool
/// and leaves skip-pool and post-reserve-lock off, so the lock is posted.
bool reserveLockPostsLocal({
  required bool hasPool,
  required bool skipPoolSync,
  required bool postReserveLock,
}) {
  return !hasPool || (skipPoolSync && !postReserveLock);
}

/// Reserve deposit the vault control posts. Funded from verified confirmed
/// coins, including the tx fee.
Future<ReserveDepositResult> postReserveDeposit({
  required ShearLedger ledger,
  required ShearReserve reserve,
  required String restFrame,
  String? paymentCode,
  required String dest,
  required double she,
  required int depth,
  Uint8List? spendSeed,
  bool local = true,
}) async {
  if (she <= 0 || !isDestAddress(dest)) {
    return const ReserveDepositResult(posted: false, remark: 'bad_amount');
  }
  final lockNanos = (she * kUnitsPerShe).round();
  final lockL = levyNanos(lockNanos, depth: depth);
  final need = she + lockL / kUnitsPerShe;
  final painted = paintedContinuumSpendable(ledger, restFrame, paymentCode: paymentCode);
  LockFundingPlan shortPlan() => LockFundingPlan(
        sources: const [],
        from: null,
        consolidate: false,
        have: painted,
        need: need,
      );
  if (painted + 1e-12 < need) {
    return ReserveDepositResult(posted: false, remark: lockFundingShortfall(shortPlan()));
  }
  final mark = ledger.markPaintedBook();
  final gap = ledger.fundFromPaintedContinuum(restFrame, paymentCode: paymentCode, needShe: need);
  if (gap == null) {
    ledger.restorePaintedBook(mark);
    return ReserveDepositResult(posted: false, remark: lockFundingShortfall(shortPlan()));
  }
  final plan = planLockFunding(ledger, restFrame: restFrame, paymentCode: paymentCode, needShe: need);
  final miss = lockFundingShortfall(plan);
  if (miss.isNotEmpty) {
    ledger.restorePaintedBook(mark);
    return ReserveDepositResult(posted: false, remark: miss);
  }
  try {
    final from = ledger.consolidateSpendableForLock(
      restFrame,
      paymentCode: paymentCode,
      needShe: need,
      keepHome: true,
    );
    final clock = reserve.epochStartMs > 0 ? reserve.epochStartMs : null;
    final unlockAt = clock == null ? null : clock + kReserveEpochMs;
    final tx = await ledger.send(
      from: from,
      to: dest,
      amount: she,
      local: local,
      kind: 'lock',
      programId: kReserveProgram,
      restFrame: restFrame,
      paymentCode: paymentCode,
      spendSeed: spendSeed,
      allowPublicHttp: true,
      paintedCover: gap > 1e-12,
      currentEpoch: clock == null ? null : reserve.currentEpoch,
      epochStartMs: clock,
      lockEpoch: clock == null ? null : reserve.currentEpoch,
      unlockAtMs: unlockAt,
    );
    final height = tx.height;
    final atHeight = height != null ? ledger.verifiedTimeAtHeight(height) : null;
    final verified = atHeight ?? ledger.verifiedMedianTimeMs;
    // First verified header time, before this row is added, so a top-up
    // does not become the epoch anchor.
    if (verified != null && verified > 0) {
      reserve.reanchorVerifiedClock(verified);
    }
    // The newest lock on this address is a different deposit. This row
    // takes the note stamped with this tx id, or the unlock this send used.
    final sealed = sealedUnlockForTx(ledger.notes, tx.id) ?? unlockAt;
    // A lock with no clock is still the principal note. Leaving the flag
    // false is what paints the legacy Withdraw button.
    final err = reserve.deposit(
      dest: dest,
      she: she,
      nowMs: verified ?? 0,
      payout: from,
      noteIsPrincipal: true,
      sealedUnlockAtMs: sealed,
    );
    if (err != null) {
      return ReserveDepositResult(posted: false, remark: err, tx: tx);
    }
    return ReserveDepositResult(posted: true, remark: '', tx: tx);
  } catch (e) {
    ledger.restorePaintedBook(mark);
    return ReserveDepositResult(posted: false, remark: '$e');
  }
}

int reserveLockConfirmations(ShearLedger ledger, ShearTx tx) {
  final h = tx.height;
  if (h == null || h < 1) return 0;
  return ledger.confirmationsOf(h);
}

/// Null when this dest has no reserve lock, or every lock already has the
/// spendable confirmation floor. Any positive amount counts, including a
/// top-up that is only part of the sum. The least-confirmed lock holds the
/// vote. A sum under π is not this wait.
String? reserveVoteConfirmationWait(ShearLedger ledger, String dest) {
  var worst = 1 << 30;
  var found = false;
  for (final t in ledger.transactions) {
    if (t.kind != 'lock') continue;
    if (t.to.isNotEmpty && t.to != dest) continue;
    if (t.amount <= 0) continue;
    found = true;
    final c = reserveLockConfirmations(ledger, t);
    if (c < worst) worst = c;
  }
  if (!found) return null;
  if (worst < ShearLedger.spendableConfirmations) return kVoteConfirmWait;
  return null;
}

/// Ineligible while this user's own vault sum is under π. Otherwise the
/// confirmation wait, if any lock of any size is still under the floor.
String? reserveVoteGate(ShearLedger ledger, ShearReserve reserve, String dest) {
  if (reserve.portal(dest).nanos < kPiSheNanos) return kVoteBelowPi;
  return reserveVoteConfirmationWait(ledger, dest);
}

class ReserveVoteResult {
  const ReserveVoteResult({required this.enacted, required this.remark});

  final bool enacted;
  final String remark;
}

/// Shipped vote command. Waits on 9 confirmations, then spends the fee once.
Future<ReserveVoteResult> commandReserveVote({
  required ShearLedger ledger,
  required ShearReserve reserve,
  required String restFrame,
  String? paymentCode,
  required String dest,
  required String choice,
  required int depth,
  Uint8List? spendSeed,
  bool local = true,
  bool privacyHopUp = false,
  int? nowMs,
}) async {
  final gate = reserveVoteGate(ledger, reserve, dest);
  if (gate != null) {
    return ReserveVoteResult(enacted: false, remark: gate);
  }
  final portal = reserve.portal(dest);
  if (portal.vote != null && portal.voteEpoch == reserve.currentEpoch) {
    return ReserveVoteResult(
      enacted: false,
      remark: voteFailCopy(StateError('vote_locked')),
    );
  }
  // Consensus weight quote. Amount bps and depth surge are not the vote fee.
  depth;
  final voteL = estimateSendLevyUnits(inputs: 1, outputs: 1);
  final needShe = voteL / kUnitsPerShe;
  if (!spendableCoversLevy(
    ledger.spendableOwned(restFrame, paymentCode: paymentCode),
    voteL,
  )) {
    return ReserveVoteResult(
      enacted: false,
      remark: 'Not enough Continuum spendable for vote tx fee ${formatShe(needShe)} SHE',
    );
  }
  try {
    final from = ledger.consolidateSpendableForLock(
      restFrame,
      paymentCode: paymentCode,
      needShe: needShe,
    );
    await ledger.send(
      from: from,
      to: dest,
      amount: 0,
      local: local,
      kind: 'vote',
      programId: kReserveProgram,
      privacyHopUp: privacyHopUp,
      allowPublicHttp: true,
      restFrame: restFrame,
      paymentCode: paymentCode,
      choice: choice,
      currentEpoch: reserve.currentEpoch,
      epochStartMs: reserve.epochStartMs,
      spendSeed: spendSeed,
    );
  } catch (e) {
    return ReserveVoteResult(enacted: false, remark: voteFailCopy(e));
  }
  final err = reserve.vote(
    dest: dest,
    choice: choice,
    nowMs: nowMs ?? DateTime.now().millisecondsSinceEpoch,
  );
  if (err != null) {
    return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError(err)));
  }
  return ReserveVoteResult(enacted: true, remark: 'Vote submitted — Your vote: $choice');
}

/// One column of the Reserve ballot. Left to right: −1, hold, +1.
class ReserveVoteTower {
  const ReserveVoteTower({
    required this.id,
    required this.label,
    required this.votes,
    required this.share,
    required this.filled,
  });

  final String id;
  final String label;
  final int votes;

  /// Height vs the tallest tower this epoch. 0 until the first vote.
  final double share;

  /// Teal once this choice has a vote. An empty tower stays a gray stub.
  final bool filled;
}

int _voteCount(int votes) => votes < 0 ? 0 : votes;

/// Epoch tally from the first vote onward. Not a single cast, and not reset
/// by painting only the latest choice.
List<ReserveVoteTower> reserveVoteTowers({
  required int decrease,
  required int hold,
  required int increase,
}) {
  final d = _voteCount(decrease);
  final h = _voteCount(hold);
  final i = _voteCount(increase);
  final max = [d, h, i].reduce((a, b) => a > b ? a : b);
  ReserveVoteTower tower(String id, String label, int votes) {
    return ReserveVoteTower(
      id: id,
      label: label,
      votes: votes,
      share: max == 0 ? 0 : votes / max,
      filled: votes > 0,
    );
  }

  return [
    tower('decrease', '−1', d),
    tower('hold', 'hold', h),
    tower('increase', '+1', i),
  ];
}
