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
const kReserveOracleDefaultBps = 425;
const kVoteIncrease = 'increase bonus';
const kVoteDecrease = 'decrease bonus';
const kVoteHold = 'leave bonus as-is';
const kReserveCutoffDisclaimer =
    'Fewer than 99 days remain. New deposits still lock and can unlock a vote, even on a first Reserve deposit. They do not earn stake.';
const kReserveAccruedLabel = 'Accrued rewards';

bool extraMintAllowed(String programId) => programId == kReserveProgram;

int reserveInterestNanos(int stakedNanos, int annualBps, [int days = kReserveEpochDays]) {
  if (stakedNanos <= 0 || annualBps < 0 || days <= 0) return 0;
  return (BigInt.from(stakedNanos) * BigInt.from(annualBps) * BigInt.from(days) ~/ BigInt.from(3650000))
      .toInt();
}

int accruedNanos(int stakedNanos, int annualBps, int elapsedMs) {
  if (stakedNanos <= 0 || annualBps < 0 || elapsedMs <= 0) return 0;
  final ms = elapsedMs > kReserveEpochMs ? kReserveEpochMs : elapsedMs;
  return (BigInt.from(stakedNanos) *
          BigInt.from(annualBps) *
          BigInt.from(ms) ~/
          (BigInt.from(10000) * BigInt.from(365) * BigInt.from(86400000)))
      .toInt();
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

class ReservePortal {
  ReservePortal({this.staked = 0, this.idle = 0, this.vote, this.joined = false, this.payout, this.voteEpoch = 0});
  int staked;
  int idle;
  String? vote;
  bool joined;
  int voteEpoch;
  String? payout;
  int? remoteAccrued;
  final List<ReserveDepositRow> deposits = [];
  int get nanos => staked + idle;
  bool get canVote => joined && nanos >= kPiSheNanos;
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
  final Map<String, ReservePortal> portals = {};
  int votesIncrease = 0;
  int votesDecrease = 0;
  int votesHold = 0;

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
    if (p.staked >= kPiSheNanos) p.joined = true;
    final epoch = (json['epochStartMs'] as num?)?.toInt();
    if (epoch != null && epoch > 0) epochStartMs = epoch;
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
        epochStartMs = nowMs;
        bonusEnacted = false;
      } else if (bonusEnacted) {
        currentEpoch += 1;
        epochStartMs = nowMs;
        bonusEnacted = false;
        votesIncrease = 0;
        votesDecrease = 0;
        votesHold = 0;
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
    if (epochStartMs == 0 || nowMs < epochStartMs + kReserveEpochMs) return null;
    if (!bonusEnacted) {
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
    final staked = p.staked;
    final idle = p.idle;
    final principal = staked + idle;
    if (principal <= 0) return null;
    if (!extraMintAllowed(kReserveProgram)) return null;
    if (payout != null && isDestAddress(payout) && !isShearAddress(payout)) {
      p.payout = payout;
    }
    final interest = reserveInterestNanos(staked, oracleBps);
    totalLockedNanos -= principal;
    if (p.vote == kVoteIncrease) votesIncrease--;
    if (p.vote == kVoteDecrease) votesDecrease--;
    if (p.vote == kVoteHold) votesHold--;
    p.staked = 0;
    p.idle = 0;
    p.joined = false;
    p.vote = null;
    p.payout = null;
    return {
      'principal': principal,
      'staked': staked,
      'idle': idle,
      'interest': interest,
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
