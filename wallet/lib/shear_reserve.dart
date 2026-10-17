import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_identity.dart';
import 'shear_leaf_vote.dart';
import 'shear_ledger.dart';
import 'shear_levy.dart';
import 'shear_vault_reward.dart';
import 'shear_vote_plan.dart';
import 'shear_withdraw.dart';

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
/// Plain average of the bundled policy rates (all 14 banks).
/// Canonical integer: `GENESIS_BPS` in crypto/reserve_oracle.js. 2.81%.
const kReserveOracleDefaultBps = 281;
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

String reserveWithdrawDialogCopy([int days = kReserveEpochDays]) =>
    'Return principal and the Reserve reward for this $days-day epoch to Continuum.\nThis settles the finished epoch.\nSign is local-only (testnet). Not full custody.';

const kReserveWithdrawAction =
    'Withdraw: move your funds back to your balance. A network levy applies.';

const kReserveRollAction =
    'Roll over: lock your full amount for the next epoch to keep earning.';

const kReserveUnlockedIdle = 'Unlocked, not earning';

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
int reserveWithdrawPayoutNanos(ShearReserve reserve, String dest, int nowMs) {
  final epochOver = reserve.epochIsOver(nowMs);
  final p = reserve.portal(dest);
  if (!epochOver && p.claimableRewards <= 0) return 0;
  final principal = (epochOver || reserve.bonusEnacted) ? p.nanos : 0;
  final interest = epochOver
      ? (p.claimableRewards > 0 ? p.claimableRewards : reserveInterestNanos(p.staked, reserve.epochBps))
      : p.claimableRewards;
  if (principal <= 0 && interest <= 0) return 0;
  if (!extraMintAllowed(kReserveProgram)) return 0;
  return principal + interest;
}

/// Inputs for [proveVaultLockReward]. Null when this portal has no seed lock.
Map<String, dynamic>? vaultRewardProveInput({
  required ShearReserve reserve,
  required String dest,
  required String payout,
  required Uint8List seed,
}) {
  final p = reserve.portal(dest);
  if (p.lockAmount <= 0 || p.lockRemainMs <= 0 || seed.length != 32) return null;
  final d20 = oneTimeClaimDest20(secret: seed, epoch: p.lockEpoch, leaf: seed);
  if (d20.length != 20) return null;
  // `payout` is the wallet's stable address. It is not posted.
  return {
    'locks': [
      {
        'amount': p.lockAmount,
        'seed': seed,
        'index': p.lockIndex,
        'lockMs': p.lockRemainMs,
      },
    ],
    'which': 0,
    'rootEpoch': p.lockEpoch,
    'earnEpoch': p.lockEpoch,
    'bps': reserve.epochBps,
    // Full span, shared by every lock. A unique remain would time-link the claim.
    'remainMs': kReserveEpochMs,
    'span': kReserveEpochMs,
    'dest20': d20,
    'magic': kBookMagic,
  };
}

String _byteHex(Object? v) {
  if (v is! List<int> || v.isEmpty) return '';
  const d = '0123456789abcdef';
  final s = StringBuffer();
  for (final x in v) {
    s
      ..write(d[(x >> 4) & 15])
      ..write(d[x & 15]);
  }
  return s.toString();
}

/// One dest20 per claim. The salt is fresh, so two claims of one leaf do not share an address.
Uint8List oneTimeClaimDest20({
  required Uint8List secret,
  required int epoch,
  required Uint8List leaf,
}) {
  final salt = Uint8List(16);
  final rnd = Random.secure();
  for (var i = 0; i < salt.length; i++) salt[i] = rnd.nextInt(256);
  final epochBytes = Uint8List(8);
  var x = epoch < 0 ? 0 : epoch;
  for (var i = 0; i < 8; i++) {
    epochBytes[i] = x & 0xff;
    x >>= 8;
  }
  final digest = sha256.convert(<int>[
    ...utf8.encode('shear-claim-payout-v1'),
    ...secret,
    ...epochBytes,
    ...leaf,
    ...salt,
  ]).bytes;
  return Uint8List.fromList(digest.take(20).toList());
}

Map<String, dynamic> _vaultPostBody({
  required String kind,
  required Map<String, dynamic> proof,
  required int nanos,
}) {
  final note = proof['note'];
  final vout = note is Map
      ? [
          {
            'kind': 'reward-claim',
            'commit': _byteHex(note['commit']),
            'noteCommit': _byteHex(note['noteCommit']),
            'amtCt': _byteHex(note['amtCt']),
            'dest20': _byteHex(note['dest20']),
            'rangeProof': _byteHex(note['rangeProof']),
            if (note['rEph'] != null) 'rEph': _byteHex(note['rEph']),
            if (note['rCt'] != null) 'rCt': _byteHex(note['rCt']),
          },
        ]
      : const <Map<String, dynamic>>[];
  return {
    'kind': kind,
    'programId': kReserveProgram,
    'nanos': nanos.toString(),
    'nullifier': proof['nullifier'],
    'vaultProof': proof['blobHex'] ?? _byteHex(proof['blob']),
    'rootEpoch': proof['rootEpoch'],
    'earnEpoch': proof['earnEpoch'],
    'vout': vout,
    'fee': rewardClaimFee(),
  };
}

/// Blocks after epoch close that share one claim slot. Matches VAULT_MINT_DELAY_BLOCKS.
const int kVaultMintDelayBlocks = 4;

/// Target block interval used only to place the shared claim slot.
const int kVaultBatchBlockMs = 90000;

/// One claim of one leaf in one period. The slot is a Random.secure delay
/// inside the two-epoch window after the period can be claimed. Sibling
/// leaves are separate transactions; this function posts one.
/// A withdraw publishes the lock height and the hold: the arrival stub is
/// paid from those public numbers.
int vaultClaimSlotMs(ShearReserve reserve, int epoch, {String dest = ''}) {
  if (reserve.epochStartMs <= 0) return 0;
  final close = reserve.epochStartMs + (epoch + 1) * kReserveEpochMs;
  final windowBlocks = (2 * kReserveEpochMs) ~/ kVaultBatchBlockMs;
  final pick = Random.secure().nextInt(windowBlocks > 0 ? windowBlocks : 1);
  return close + pick * kVaultBatchBlockMs;
}

/// Previous-epoch reward. Builds the vault-lock proof, then posts a claim.
/// The default slot is epoch close + N, so a claim time is not unique.
/// A missing native prover fails closed and does not post a withdraw.
Future<({ShearTx tx, Map<String, int> settled})?> postReserveVaultClaim(
  ShearLedger ledger, {
  required ShearReserve reserve,
  required String dest,
  required String payout,
  required int nowMs,
  required Uint8List spendSeed,
  Map<String, dynamic>? vaultProof,
  bool local = false,
}) async {
  final due = reserve.portal(dest).claimableRewards;
  if (due <= 0) return null;
  final slot = vaultClaimSlotMs(reserve, reserve.portal(dest).lockEpoch, dest: dest);
  if (slot > 0 && nowMs < slot) return null;
  var proof = vaultProof;
  if (proof == null) {
    final input = vaultRewardProveInput(
      reserve: reserve,
      dest: dest,
      payout: payout,
      seed: spendSeed,
    );
    if (input == null) throw StateError('unsigned');
    proof = proveVaultLockRewardWire(input);
  }
  final body = _vaultPostBody(
    kind: 'reward-claim',
    proof: proof,
    nanos: (proof['nanos'] as num?)?.toInt() ?? 0,
  );
  if (!local && ledger.pool != null) {
    await ledger.pool!.postRaw(body);
  }
  final settled = reserve.withdraw(dest: dest, nowMs: nowMs, payout: payout);
  if (settled == null) return null;
  return (
    tx: ShearTx(
      id: 'vault-claim-${proof['nullifier']}',
      from: dest,
      to: payout,
      amount: due / kUnitsPerShe,
      kind: 'reward-claim',
    ),
    settled: settled,
  );
}

/// Lock leaves the wallet can prove. A note without its scalar, blind, and
/// leaf is not one of them.
List<Map<String, Object?>>? reserveLockLeaves(List<Map<String, dynamic>> notes) {
  final out = <Map<String, Object?>>[];
  for (final row in notes) {
    if (row['scalar'] == null || row['blind'] == null || row['note'] == null) continue;
    final kind = (row['kind'] ?? '').toString();
    if (kind.isNotEmpty && kind != 'lock') continue;
    final epochs = row['epochs'];
    if (epochs is! List || epochs.isEmpty) continue;
    out.add({
      'scalar': row['scalar'],
      'blind': row['blind'],
      'note': row['note'],
      'unlock': row['unlock'] is int ? row['unlock'] as int : 0,
      'epochs': epochs,
      if (row['amount'] is int) 'amount': row['amount'],
      if (row['withdrawPeriod'] is int) 'withdrawPeriod': row['withdrawPeriod'],
    });
  }
  return out.isEmpty ? null : out;
}

List<int>? _noteBytes(Object? raw) {
  if (raw is Uint8List && raw.isNotEmpty) return raw;
  if (raw is List<int> && raw.isNotEmpty) return raw;
  return null;
}

/// FS-1 spend that belongs to these leaves. Null unless every field is present.
({
  List<int> fs1,
  List<Map<String, Object?>> vin,
  List<Map<String, Object?>> admitProofs,
  List<int> excess,
  int anchor,
})? reserveWithdrawSpend(List<Map<String, dynamic>> notes) {
  Map<String, dynamic>? host;
  for (final row in notes) {
    if (_noteBytes(row['fs1']) != null && row['vin'] is List && row['admitProofs'] is List) {
      host = row;
      break;
    }
    if (_noteBytes(row['fs1']) != null && row['vin'] is List && row['admit_proofs'] is List) {
      host = row;
      break;
    }
  }
  if (host == null) return null;
  final fs1 = _noteBytes(host['fs1']);
  final excess = _noteBytes(host['excess']);
  final vinRaw = host['vin'];
  final proofRaw = host['admitProofs'] ?? host['admit_proofs'];
  if (fs1 == null || fs1[0] != 0xf1 || excess == null || excess.length != 32) return null;
  if (vinRaw is! List || proofRaw is! List || vinRaw.isEmpty || vinRaw.length != proofRaw.length) {
    return null;
  }
  final vin = <Map<String, Object?>>[];
  final proofs = <Map<String, Object?>>[];
  for (var i = 0; i < vinRaw.length; i++) {
    if (vinRaw[i] is! Map || proofRaw[i] is! Map) return null;
    vin.add(Map<String, Object?>.from(vinRaw[i] as Map));
    proofs.add(Map<String, Object?>.from(proofRaw[i] as Map));
  }
  final anchor = host['anchor'] is int ? host['anchor'] as int : 0;
  return (fs1: fs1, vin: vin, admitProofs: proofs, excess: excess, anchor: anchor);
}

Map<String, dynamic> _wireBody(Map<String, Object?> body) {
  Object? walk(Object? v) {
    if (v is Uint8List) return v.toList();
    if (v is List) return [for (final row in v) walk(row)];
    if (v is Map) {
      return {for (final e in v.entries) e.key.toString(): walk(e.value)};
    }
    return v;
  }
  return Map<String, dynamic>.from(walk(body) as Map);
}

/// Post kind withdraw, then settle the local portal. A failed send leaves the portal.
/// When the wallet has the lock leaves and the FS-1 spend, the posted body is
/// the proved withdraw: retire proofs, principal openings, nonce, dest20, and
/// the spend signature. Otherwise the ledger send is unchanged.
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
  List<Map<String, Object?>>? leaves,
  List<int>? fs1,
  List<Map<String, Object?>>? vin,
  List<Map<String, Object?>>? admitProofs,
  List<int>? excess,
  int anchor = 0,
  String? withdrawId,
  List<int>? withdrawNonce,
}) async {
  final nanos = reserveWithdrawPayoutNanos(reserve, dest, nowMs);
  if (nanos <= 0) return null;
  if (leaves != null &&
      leaves.isNotEmpty &&
      spendSeed != null &&
      fs1 != null &&
      vin != null &&
      admitProofs != null &&
      excess != null) {
    final built = buildProvedWithdraw(
      to: payout,
      nanos: nanos,
      id: withdrawId ?? 'wd-$nowMs',
      portalId: portalIdFromDest(dest),
      anchor: anchor,
      excess: excess,
      fs1: fs1,
      vin: vin,
      admitProofs: admitProofs,
      leaves: leaves,
      spendSeed: spendSeed,
      withdrawNonce: withdrawNonce,
    );
    if (built == null) return null;
    if (!local && ledger.pool != null) {
      await ledger.pool!.postRaw(_wireBody(built));
    }
    final settled = reserve.withdraw(dest: dest, nowMs: nowMs, payout: payout);
    if (settled == null) return null;
    return (
      tx: ShearTx(
        id: (built['id'] ?? '').toString(),
        from: dest,
        to: payout,
        amount: nanos / kUnitsPerShe,
        kind: 'withdraw',
      ),
      settled: settled,
    );
  }
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
  final settled = reserve.withdraw(dest: dest, nowMs: nowMs, payout: payout);
  if (settled == null) return null;
  return (tx: tx, settled: settled);
}

/// Post kind roll. The vault sum stays locked. Continuum pays the levy only.
Future<({ShearTx tx, Map<String, int> settled})?> postReserveRoll(
  ShearLedger ledger, {
  required ShearReserve reserve,
  required String dest,
  required int nowMs,
  Uint8List? spendSeed,
  bool local = false,
  String? restFrame,
  String? paymentCode,
  bool allowPublicHttp = false,
  Map<String, dynamic>? vaultProof,
}) async {
  if (!reserve.epochIsOver(nowMs)) return null;
  if (reserve.portal(dest).nanos <= 0) return null;
  final portal = reserve.portal(dest);
  final interest = portal.claimableRewards > 0
      ? portal.claimableRewards
      : reserveInterestNanos(portal.staked, reserve.epochBps);
  var proof = vaultProof;
  if (interest > 0 && proof == null) {
    if (spendSeed == null || spendSeed.length != 32) throw StateError('fs1_prover_unavailable');
    final input = vaultRewardProveInput(
      reserve: reserve,
      dest: dest,
      payout: dest,
      seed: spendSeed,
    );
    if (input == null) throw StateError('unsigned');
    proof = proveVaultLockRewardWire(input);
  }
  if (proof != null) {
    final body = _vaultPostBody(
      kind: 'roll',
      proof: proof,
      nanos: 0,
    );
    if (!local && ledger.pool != null) {
      await ledger.pool!.postRaw(body);
    }
    final settled = reserve.roll(dest: dest, nowMs: nowMs);
    if (settled == null) return null;
    return (
      tx: ShearTx(
        id: 'vault-roll-${proof['nullifier']}',
        from: dest,
        to: dest,
        amount: 0,
        kind: 'roll',
      ),
      settled: settled,
    );
  }
  final tx = await ledger.send(
    from: dest,
    to: dest,
    amount: 0,
    kind: 'roll',
    programId: kReserveProgram,
    local: local,
    spendSeed: spendSeed,
    restFrame: restFrame,
    paymentCode: paymentCode,
    allowPublicHttp: allowPublicHttp || !local,
    nanosWire: '0',
  );
  if (tx.kind != 'roll') return null;
  final settled = reserve.roll(dest: dest, nowMs: nowMs);
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
  /// Seed-derived lock. A restored wallet rebuilds the blind from these.
  int lockIndex = 0;
  int lockRemainMs = 0;
  int lockAmount = 0;
  int lockEpoch = 0;
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
    if (p.lockAmount == 0) {
      p.lockAmount = n;
      p.lockEpoch = epochStartMs == 0 ? 0 : currentEpoch;
      final remain = epochStartMs == 0 ? kReserveEpochMs : remainingMs(nowMs);
      p.lockRemainMs = remain > 0 ? remain : kReserveEpochMs;
      p.lockIndex = 0;
    }
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

  /// Re-lock the finished sum plus its unclaimed reward. A second call in the
  /// new epoch does nothing. The coins stay out of Continuum spendable.
  Map<String, int>? roll({required String dest, required int nowMs}) {
    final epochOver = epochStartMs != 0 && nowMs >= epochStartMs + kReserveEpochMs;
    if (!epochOver) return null;
    final p = portal(dest);
    final principal = p.nanos;
    if (principal <= 0) return null;
    final interest = p.claimableRewards > 0
        ? p.claimableRewards
        : reserveInterestNanos(p.staked, epochBps);
    p.idle = 0;
    p.staked = principal + interest;
    p.claimableRewards = 0;
    totalLockedNanos += interest;
    epochStartMs = nowMs;
    bonusEnacted = false;
    currentEpoch += 1;
    return {
      'principal': principal,
      'interest': interest,
      'locked': principal + interest,
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
      unlockAtMs: clock == null ? null : clock + kReserveEpochMs,
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

/// Epoch-keyed leaf votes for the Reserve dapp. The plan is loaded for this
/// epoch, or replaced when the file belongs to another epoch. A wallet with
/// no fee note, or no proof for the note it picked, returns null so the
/// caller can post the portal vote.
Future<ReserveVoteResult?> castPlannedLeafVotes({
  required ShearLedger ledger,
  required ShearReserve reserve,
  required String planDir,
  required String dest,
  required String choice,
  bool local = true,
  int? nowMs,
}) async {
  final count = reserve.portal(dest).nanos ~/ kPiSheNanos;
  if (count < 1 || planDir.isEmpty) return null;
  Map<String, Object?>? plan;
  try {
    plan = plannedLeafVotes(
      dir: planDir,
      leaves: count,
      notes: ledger.notes,
      openHeight: 0,
      closeHeight: 4000,
      epoch: reserve.currentEpoch,
    );
  } catch (_) {
    return null;
  }
  if (plan == null) return null;
  final built = buildLeafVote(
    vote: {'choice': choice},
    notes: ledger.notes,
    fee: 1,
    anchor: 0,
    epoch: reserve.currentEpoch,
    prove: (note) {
      final fs1 = note['fs1'];
      final excess = note['excess'];
      final admit = note['admitProof'] ?? note['admit_proof'];
      if (fs1 is! List<int> || fs1.isEmpty || fs1[0] != 0xf1) return null;
      if (excess is! List<int> || excess.length != 32) return null;
      if (admit is! Map || admit['cTilde'] is! List<int>) return null;
      return {
        'fs1': fs1,
        'excess': excess,
        'admitProof': Map<String, Object?>.from(admit),
      };
    },
  );
  if (built == null || built['voteProof'] == null) return null;
  if (built.containsKey('feeInput') || built.containsKey('parentTx') || built.containsKey('parent')) {
    return null;
  }
  if (!local && ledger.pool != null) {
    await ledger.pool!.postRaw(_wireBody(built));
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
