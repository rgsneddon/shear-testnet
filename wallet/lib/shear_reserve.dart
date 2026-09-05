import 'dart:convert';

import 'package:crypto/crypto.dart';

import 'shear_identity.dart';
import 'shear_ledger.dart';

const kReserveProgram = 'shear-reserve-v1';
const kReserveOracleId = 'shear-reserve-oracle-v1';
const kPiSheNanos = 314159265358;
const kPiShe = kPiSheNanos / kUnitsPerShe;
const kReserveEpochDays = 400;
const kReserveJoinCutoffDays = 99;
const kReserveEpochMs = kReserveEpochDays * 86400000;
const kReserveJoinCutoffMs = kReserveJoinCutoffDays * 86400000;
/// Unweighted mean of all observed first-world policy rates (14 banks). 2.636% → 264 bps.
const kReserveOracleDefaultBps = 264;
const kVoteIncrease = 'increase bonus';
const kVoteDecrease = 'decrease bonus';
const kVoteHold = 'leave bonus as-is';
const kReserveCutoffDisclaimer =
    'Fewer than 99 days remain. New deposits still lock and can unlock a vote, even on a first Reserve deposit. They do not earn stake.';
const kReserveAccruedLabel = 'Accrued rewards';

bool extraMintAllowed(String programId) => programId == kReserveProgram;

/// 400-day APR on staked SHE. Idle earns 0. Never `* 400 / 365`.
/// Whole epoch: `floor(stakedNanos * bps / 10000)` i.e.
/// `(p * bps * days) ~/ (10000 * 400)` when [days] is 400.
int reserveInterestNanos(int stakedNanos, int annualBps, [int days = kReserveEpochDays]) {
  if (stakedNanos <= 0 || annualBps < 0 || days <= 0) return 0;
  return (BigInt.from(stakedNanos) * BigInt.from(annualBps) * BigInt.from(days) ~/
          (BigInt.from(10000) * BigInt.from(kReserveEpochDays)))
      .toInt();
}

/// Accrued: `floor(stakedNanos * bps * e / (10000 * EPOCH_MS))`. Caps at 400 days.
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

  void _beginEpoch(int nowMs) {
    epochStartMs = nowMs;
    bonusEnacted = false;
    _recordEpoch(nowMs);
  }

  ReserveRewards rewards(String dest, int nowMs) {
    final p = portal(dest);
    final elapsed = elapsedMs(nowMs);
    return ReserveRewards(
      accrued: p.remoteAccrued ?? accruedNanos(p.staked, oracleBps, elapsed),
      projected: reserveInterestNanos(p.staked, oracleBps),
      staked: p.staked,
      idle: p.idle,
      oracleBps: oracleBps,
      elapsedMs: elapsed,
    );
  }

  /// Node Join/Reserve VAULT read. Not a public vortice.
  void applyRemotePortal(String dest, Map<String, dynamic> json) {
    final p = portal(dest);
    p.staked = (json['staked'] as num?)?.toInt() ?? p.staked;
    p.idle = (json['idle'] as num?)?.toInt() ?? p.idle;
    p.remoteAccrued = (json['accrued'] as num?)?.toInt();
    p.claimableRewards = (json['claimable'] as num?)?.toInt() ?? p.claimableRewards;
    if (p.nanos >= kPiSheNanos) p.joined = true;
    feeBankNanos = (json['feeBankNanos'] as num?)?.toInt() ?? feeBankNanos;
    mintBankNanos = (json['mintBankNanos'] as num?)?.toInt() ?? mintBankNanos;
    totalStakedNanos = (json['totalStakedNanos'] as num?)?.toInt() ?? totalStakedNanos;
    totalIdleNanos = (json['totalIdleNanos'] as num?)?.toInt() ?? totalIdleNanos;
    totalAccruedNanos = (json['totalAccruedNanos'] as num?)?.toInt() ?? totalAccruedNanos;
    totalClaimableNanos = (json['totalClaimableNanos'] as num?)?.toInt() ?? totalClaimableNanos;
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
    if (!first) {
      if (p.vote == kVoteIncrease) votesIncrease--;
      if (p.vote == kVoteDecrease) votesDecrease--;
      if (p.vote == kVoteHold) votesHold--;
    }
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
    }
    final p = portal(dest);
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
        ? (claimable > 0 ? claimable : reserveInterestNanos(staked, oracleBps))
        : claimable;
    if (principal <= 0 && interest <= 0) return null;
    if (!extraMintAllowed(kReserveProgram)) return null;
    if (payout != null && isDestAddress(payout) && !isShearAddress(payout)) {
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
    ledger.creditReserve(to: payout, amount: (out['principal']! + out['interest']!) / kUnitsPerShe);
    return out;
  }

  Map<String, dynamic> publicView(int nowMs) => {
        'epochStartMs': epochStartMs,
        'remainingMs': remainingMs(nowMs),
        'totalLockedNanos': totalLockedNanos,
        'votesIncrease': votesIncrease,
        'votesDecrease': votesDecrease,
        'votesHold': votesHold,
        'oracleBps': oracleBps,
        'liveHashBonusNanos': liveHashBonusNanos,
        'bonusEnacted': bonusEnacted,
        'currentEpoch': currentEpoch,
      };

  String publicJson(int nowMs) => jsonEncode(publicView(nowMs));
}
