import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

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
/// Unweighted mean of all observed first-world policy rates (14 banks). 2.636% → 264 bps.
const kReserveOracleDefaultBps = 264;
const kBpsStepCap = 100;
const kStaleObserveMs = 14 * 86400000;
const kVoteIncrease = 'increase bonus';
const kVoteDecrease = 'decrease bonus';
const kVoteHold = 'leave bonus as-is';
const kReserveCutoffDisclaimer =
    'Fewer than $kReserveJoinCutoffDays days remain. New deposits still lock and can unlock a vote, even on a first Reserve deposit. They do not earn stake.';
const kReserveAccruedLabel = 'Accrued rewards';

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

String reserveWithdrawDialogCopy([int days = kReserveEpochDays]) =>
    'Return principal and $days-day APR interest to Continuum.\nThis settles the finished epoch.';

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

class ReserveDepositRow {
  ReserveDepositRow({required this.nanos, required this.atMs, this.txid});
  final int nanos;
  final int atMs;
  final String? txid;
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

  String? deposit({required String dest, required double she, required int nowMs, String? payout}) {
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
    p.deposits.add(ReserveDepositRow(nanos: n, atMs: nowMs));
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
    return null;
  }

  String? vote({required String dest, required String choice, required int nowMs}) {
    nowMs;
    final p = portal(dest);
    if (!p.canVote) return 'not_voter';
    if (epochStartMs == 0 || bonusEnacted) return 'not_voter';
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
    final epochOver = epochStartMs != 0 && nowMs >= epochStartMs + kReserveEpochMs;
    final p0 = portal(dest);
    if (!epochOver && p0.claimableRewards <= 0) return null;
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
    var staked = 0;
    var idle = 0;
    var principal = 0;
    if (epochOver || bonusEnacted) {
      staked = p.staked;
      idle = p.idle;
      principal = staked + idle;
    }
    final interest = epochOver
        ? (claimable > 0 ? claimable : reserveInterestNanos(staked, epochBps))
        : claimable;
    if (principal <= 0 && interest <= 0) return null;
    if (!extraMintAllowed(kReserveProgram)) return null;
    if (p.payout == null && payout != null && isDestAddress(payout) && !isShearAddress(payout)) {
      p.payout = payout;
    }
    if (principal > 0) totalLockedNanos -= principal;
    if (principal > 0) {
      if (p.vote == kVoteIncrease) votesIncrease--;
      if (p.vote == kVoteDecrease) votesDecrease--;
      if (p.vote == kVoteHold) votesHold--;
      p.staked = 0;
      p.idle = 0;
      p.joined = false;
      p.vote = null;
      p.payout = null;
    }
    p.claimableRewards = 0;
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

class ReserveDepositResult {
  const ReserveDepositResult({required this.posted, required this.remark, this.tx});

  final bool posted;
  final String remark;
  final ShearTx? tx;
}

/// Reserve deposit the vault control posts. Funded from the painted Continuum
/// figure (chain spendable plus owed-toward-π), including the tx fee.
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
  if (!ledger.fundFromPaintedContinuum(restFrame, paymentCode: paymentCode, needShe: need)) {
    return ReserveDepositResult(posted: false, remark: lockFundingShortfall(shortPlan()));
  }
  final plan = planLockFunding(ledger, restFrame: restFrame, paymentCode: paymentCode, needShe: need);
  final miss = lockFundingShortfall(plan);
  if (miss.isNotEmpty) {
    return ReserveDepositResult(posted: false, remark: miss);
  }
  try {
    final from = ledger.consolidateSpendableForLock(
      restFrame,
      paymentCode: paymentCode,
      needShe: need,
    );
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
    );
    final err = reserve.deposit(
      dest: dest,
      she: she,
      nowMs: DateTime.now().millisecondsSinceEpoch,
      payout: from,
    );
    if (err != null) {
      return ReserveDepositResult(posted: false, remark: err, tx: tx);
    }
    return ReserveDepositResult(posted: true, remark: '', tx: tx);
  } catch (e) {
    return ReserveDepositResult(posted: false, remark: '$e');
  }
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
