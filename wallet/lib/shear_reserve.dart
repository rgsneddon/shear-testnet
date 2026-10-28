import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_admit.dart';
import 'shear_ed25519.dart';
import 'shear_identity.dart';
import 'shear_leaf_vote.dart';
import 'shear_ledger.dart';
import 'shear_levy.dart';
import 'shear_native_prove.dart';
import 'shear_note.dart';
import 'shear_pack.dart' show voteChangeSeedOf, withdrawChangeSeedOf, withdrawPayoutSeedOf;
import 'shear_public_confirm.dart';
import 'shear_ristretto.dart';
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
/// Vote window day. The arrival stub uses a shorter testnet day. This does not.
const kVaultDayBlocks = 960;
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

/// Why a withdraw or claim did not post. A future slot names local time.
String reservePostWaitCopy({String remark = '', int? waitMs}) {
  if (waitMs != null && waitMs > 0) {
    return 'Scheduled for ${reserveLocalDateTime(waitMs)}.';
  }
  if (remark.isNotEmpty) return remark;
  return reserveEpochStillOpenCopy();
}

/// A lock leaf whose latest epoch is already over. A rolled leaf is still
/// open while currentEpoch is that leaf's newest epoch. An older epoch on
/// the same leaf does not finish it.
bool reserveLeafEpochEnded(List<Map<String, dynamic>> notes, int currentEpoch) {
  if (currentEpoch <= 0) return false;
  final leaves = reserveLockLeaves(notes);
  if (leaves == null) return false;
  for (final leaf in leaves) {
    final epochs = leaf['epochs'];
    if (epochs is! List) continue;
    int? latest;
    for (final raw in epochs) {
      final epoch = raw is int ? raw : (raw is num ? raw.toInt() : null);
      if (epoch == null) continue;
      if (latest == null || epoch > latest) latest = epoch;
    }
    if (latest != null && currentEpoch > latest) return true;
  }
  return false;
}

/// Period length the screen may say. Testnet is about 6 hours, not 25 days.
String reservePeriodCopy() => kBookMagic == 'shear-v1'
    ? 'Rewards are claimable each period, about 25 days.'
    : 'Rewards are claimable each period, about 6 hours.';

/// Vote window the screen may say. Testnet does not use days 0-301.
String reserveVoteWindowCopy() => kBookMagic == 'shear-v1'
    ? 'Votes equal your locked π. Cast them on days 0-301. Two ballots: the hash-bonus rate and the reserve rate.'
    : 'Votes equal your locked π. On this testnet an epoch is 4 days. Two ballots: the hash-bonus rate and the reserve rate.';

/// Projected-reward label. Testnet epoch is 4 days.
String reserveEpochLengthCopy() => kBookMagic == 'shear-v1' ? 'full 400-day epoch' : 'full 4-day epoch';

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
  final vout = <Map<String, dynamic>>[];
  if (note is Map) {
    final row = <String, dynamic>{
      'kind': kind == 'roll' ? 'roll' : 'reward-claim',
      'commit': note['commit'],
      'noteCommit': note['noteCommit'],
      'amtCt': note['amtCt'],
      'dest20': note['dest20'],
      'rangeProof': note['rangeProof'],
      if (note['rEph'] != null) 'rEph': note['rEph'],
      if (note['rCt'] != null) 'rCt': note['rCt'],
      if (note['admitPub'] != null) 'admitPub': note['admitPub'],
    };
    final stamped = attachAdmitPub(Map<String, dynamic>.from(row));
    final r = note['r'];
    if (kind != 'roll' && nanos > 0 && r is Uint8List && r.length == 32 && stamped['commit'] is Uint8List) {
      final opened = proveValueUnits(BigInt.from(nanos), scalarFromBytes(r));
      stamped['valueProof'] = {'R': opened['R'], 'z': opened['z'], 'v': nanos};
    }
    vout.add(Map<String, dynamic>.from(_hexPost(stamped)));
  }
  final nullifier = proof['nullifier']?.toString() ?? '';
  final body = <String, dynamic>{
    'id': kind == 'roll' ? 'roll-$nullifier' : 'claim-$nullifier',
    'kind': kind,
    'programId': kReserveProgram,
    'nanos': nanos,
    'nullifier': nullifier,
    'vaultProof': proof['blobHex'] ?? _byteHex(proof['blob']),
    'rootEpoch': proof['rootEpoch'],
    'earnEpoch': proof['earnEpoch'],
    'vout': vout,
  };
  body['fee'] = rewardClaimFee(body: body);
  return body;
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

/// One withdraw of one portal. The slot is a hash of the portal id inside
/// the same two-epoch window a claim uses. Two portals do not share a clock.
int vaultWithdrawSlotMs(ShearReserve reserve, int epoch, String portalId) {
  if (reserve.epochStartMs <= 0) return 0;
  final close = reserve.epochStartMs + (epoch + 1) * kReserveEpochMs;
  final windowBlocks = (2 * kReserveEpochMs) ~/ kVaultBatchBlockMs;
  final span = windowBlocks > 0 ? windowBlocks : 1;
  final digest = sha256.convert(<int>[
    ...utf8.encode('shear-withdraw-slot-v1'),
    ...utf8.encode(portalId.toLowerCase()),
  ]).bytes;
  final pick = (digest[0] | (digest[1] << 8) | (digest[2] << 16) | (digest[3] << 24)) % span;
  return close + pick * kVaultBatchBlockMs;
}

/// `wd-` plus 16 random bytes. No clock, no portal, no counter.
String freshWithdrawId() {
  final b = randomBytes(16);
  final hex = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return 'wd-$hex';
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
  bool publicIpConsent = false,
}) async {
  if (!local && !publicNodePostAllowed(consent: publicIpConsent)) {
    throw StateError(kPublicIpWaitCopy);
  }
  final due = reserve.portal(dest).claimableRewards;
  if (due <= 0) {
    ledger.clearReserveNotice();
    return null;
  }
  final slot = vaultClaimSlotMs(reserve, reserve.portal(dest).lockEpoch, dest: dest);
  if (slot > 0 && nowMs < slot) {
    ledger.noteReserveWait(slot);
    return null;
  }
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
    final ack = await ledger.pool!.postRaw(body);
    if (!_votePostOk(ack)) {
      _notePostRefusal(ledger, ack);
      return null;
    }
  }
  ledger.clearReserveNotice();
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
      if (row['portalId'] != null) 'portalId': row['portalId'],
      if (row['dest20'] != null) 'dest20': row['dest20'],
      if (row['lockIndex'] is int) 'lockIndex': row['lockIndex'],
    });
  }
  return out.isEmpty ? null : out;
}

List<int>? _noteBytes(Object? raw) {
  if (raw is Uint8List && raw.isNotEmpty) return raw;
  if (raw is List<int> && raw.isNotEmpty) return raw;
  return null;
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

String _postHex(List<int> raw) =>
    raw.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

/// Hex bytes the node verifies as signatures and proofs. A number array is
/// not a reward signature.
Map<String, dynamic> _hexPost(Map<String, Object?> body) {
  Object? walk(Object? v) {
    if (v is Uint8List) return _postHex(v);
    if (v is List) return [for (final row in v) walk(row)];
    if (v is Map) {
      return {for (final e in v.entries) e.key.toString(): walk(e.value)};
    }
    return v;
  }
  return Map<String, dynamic>.from(walk(body) as Map);
}

Map<String, dynamic>? _freshWithdrawNote(List<Map<String, dynamic>> notes) {
  for (final row in notes) {
    if (row['spent'] == true || row['locked'] == true) continue;
    final kind = (row['kind'] ?? '').toString();
    if (kind == 'lock' || kind == 'reward-claim' || kind == 'leaf-vote') continue;
    if (row['commit'] == null || row['r'] == null || row['noteCommit'] == null) continue;
    return row;
  }
  return null;
}

bool _same20(List<int> a, List<int> b) {
  if (a.length < 20 || b.length < 20) return false;
  for (var i = 0; i < 20; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

/// The leaf's portal, then its lock index, then the dest20 scan.
/// A bounded scan: a wallet does not open an unbounded index.
String? _leafPortal(Map<String, Object?> leaf, Uint8List spendSeed) {
  final pid = leaf['portalId'];
  if (pid is String && RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(pid)) return pid.toLowerCase();
  final known = portalsFromSeed(spendSeed, 64);
  final idx = leaf['lockIndex'];
  if (idx is int) {
    for (final row in known) {
      if (row['lockIndex'] == idx && row['portalId'] is String) {
        return (row['portalId'] as String).toLowerCase();
      }
    }
  }
  final raw = leaf['dest20'];
  if (raw is List<int> && raw.length >= 20) {
    for (final row in known) {
      final d20 = row['dest20'];
      final id = row['portalId'];
      if (d20 is List<int> && id is String && _same20(d20, raw)) return id.toLowerCase();
    }
  }
  return null;
}

String? _commitHex(Object? raw) {
  if (raw is String) {
    final hex = raw.startsWith('0x') || raw.startsWith('0X') ? raw.substring(2) : raw;
    if (RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(hex)) return hex.toLowerCase();
  }
  if (raw is List<int> && raw.length >= 32) return _postHex(raw.sublist(0, 32));
  return null;
}

String? _leafCommitHex(Map<String, Object?> leaf) {
  final note = leaf['note'];
  if (note is List<int> && note.length >= 64) return _postHex(note.sublist(32, 64));
  return _commitHex(leaf['commit']);
}

/// What the Reserve pane shows when the portal read fails.
String vaultReadErrorCopy(String why) =>
    'Vault read failed ($why). Reserve figures are not shown until the vault answers.';

String _readWhy(Object e) {
  final why = e.toString();
  return why.startsWith('Bad state: ') ? why.substring('Bad state: '.length) : why;
}

/// The portal the Reserve pane paints. A pool serves GET /api/vault/reserve;
/// an own node has no such route (it answers 400), so the wallet reads the
/// node's own GET /reserve?address= instead and gives the pane the same
/// shape: the public vault view with this portal's figures. A refused or
/// failed read is not an empty portal: it returns no portal and the error
/// the pane shows (ruling 6).
Future<({Map<String, dynamic>? portal, String error})> readVaultPortal(
  ShearPoolClient pool,
  String dest,
) async {
  var why = '';
  var noRoute = pool.usesOwnNode;
  if (!noRoute) {
    try {
      final json = Map<String, dynamic>.from(await pool.reservePortal(dest));
      if (json['ok'] != false) return (portal: json, error: '');
      why = json['reason']?.toString() ?? 'refused';
    } catch (e) {
      why = _readWhy(e);
      noRoute = why.contains('http_400') || why.contains('http_404');
    }
  }
  if (noRoute) {
    try {
      final json = Map<String, dynamic>.from(await pool.nodeReserve(dest));
      if (json['ok'] == false) {
        why = 'node reserve: ${json['reason'] ?? 'refused'}';
      } else {
        final portal = json['portal'];
        final vault = json['vault'];
        if (portal is Map && vault is Map) {
          return (
            portal: <String, dynamic>{
              ...Map<String, dynamic>.from(vault),
              ...Map<String, dynamic>.from(portal),
              'ok': true,
              'public': false,
            },
            error: '',
          );
        }
        why = 'node reserve: no portal view';
      }
    } catch (e) {
      why = 'node reserve: ${_readWhy(e)}';
    }
  }
  return (portal: null, error: vaultReadErrorCopy(why.isEmpty ? 'refused' : why));
}

/// Rows from GET /api/vault/reserve?view=tranches, or from a portal object.
List<Map<String, Object?>> tranchesFromNode(Object? raw) {
  Object? source = raw;
  if (raw is Map) {
    if (raw['tranches'] != null) {
      source = raw['tranches'];
    } else if (raw['portal'] is Map) {
      source = (raw['portal'] as Map)['tranches'];
    }
  }
  if (source is! List) return const [];
  final out = <Map<String, Object?>>[];
  for (final row in source) {
    if (row is! Map) continue;
    final commit = _commitHex(row['commit']);
    if (commit == null) continue;
    final epochRaw = row['epoch'];
    final remainRaw = row['remainMs'];
    final epoch = epochRaw is int ? epochRaw : int.tryParse('${epochRaw ?? 0}') ?? 0;
    final remain = remainRaw is int ? remainRaw : int.tryParse('${remainRaw ?? 0}') ?? 0;
    final principal = row['noteIsPrincipal'] == true || row['notePrincipal'] == true;
    final stubRaw = row['stubNanos'];
    final stub = stubRaw is int ? stubRaw : int.tryParse('${stubRaw ?? 0}') ?? 0;
    final pid = row['portalId'];
    final portal = pid is String && RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(pid) ? pid.toLowerCase() : null;
    out.add({
      'commit': commit,
      'epoch': epoch,
      'remainMs': remain < 0 ? 0 : remain,
      if (principal) 'noteIsPrincipal': true,
      if (portal != null) 'portalId': portal,
      if (stub > 0) 'stubNanos': stub,
    });
  }
  return out;
}

bool _trancheMatured(Map<String, Object?> tranche, int releaseEpoch) {
  final epoch = tranche['epoch'] is int ? tranche['epoch'] as int : 0;
  if (releaseEpoch <= epoch) return false;
  if (tranche['noteIsPrincipal'] == true) return false;
  return true;
}

/// One withdraw per matured portal. Leaves that have not matured stay put.
/// The amount is the sum of the matured leaves. A refused post adds no note.
Future<List<({ShearTx tx, Map<String, int> settled})>> postMaturedWithdraws(
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
  bool publicIpConsent = false,
  List<Map<String, Object?>>? leaves,
  String? withdrawId,
  List<int>? withdrawNonce,
}) async {
  restFrame;
  paymentCode;
  withdrawId;
  if (leaves == null || leaves.isEmpty || spendSeed == null || spendSeed.length != 32) return const [];
  if (local || ledger.pool == null) return const [];
  final publicHttp = allowPublicHttp || !local;
  if (publicHttp && !publicNodePostAllowed(consent: publicIpConsent)) {
    throw StateError(kPublicIpWaitCopy);
  }
  final groups = <String, List<Map<String, Object?>>>{};
  for (final leaf in leaves) {
    final id = _leafPortal(leaf, spendSeed);
    if (id == null) continue;
    (groups[id] ??= <Map<String, Object?>>[]).add(leaf);
  }
  List<Map<String, Object?>> book;
  try {
    book = tranchesFromNode(await ledger.pool!.reserveTrancheBook());
  } catch (_) {
    ledger.noteReserveRemark('Could not read the vault. Try again once the node answers.');
    return const [];
  }
  final byPortal = <String, List<Map<String, Object?>>>{};
  for (final row in book) {
    final id = row['portalId'];
    if (id is! String) continue;
    (byPortal[id] ??= <Map<String, Object?>>[]).add(row);
  }
  ledger.noteChainPortals(byPortal.keys);
  ledger.spendSeed ??= spendSeed;
  ledger.rememberDerivedLockLeaves(book);
  ledger.clearReserveNotice();
  final out = <({ShearTx tx, Map<String, int> settled})>[];
  var n = 0;
  for (final entry in groups.entries) {
    var slotEpoch = reserve.currentEpoch > 0 ? reserve.currentEpoch - 1 : 0;
    for (final row in byPortal[entry.key] ?? const <Map<String, Object?>>[]) {
      final epoch = row['epoch'];
      if (epoch is int && epoch >= 0 && epoch < slotEpoch) slotEpoch = epoch;
    }
    final slot = vaultWithdrawSlotMs(reserve, slotEpoch, entry.key);
    if (slot > 0 && nowMs < slot) {
      ledger.noteReserveWait(slot);
      continue;
    }
    ledger.pool?.openFreshConnection();
    final one = await _postPortalWithdraw(
      ledger,
      reserve: reserve,
      dest: dest,
      payout: payout,
      nowMs: nowMs,
      spendSeed: spendSeed,
      portalId: entry.key,
      leaves: entry.value,
      tranches: byPortal[entry.key] ?? const <Map<String, Object?>>[],
      withdrawId: freshWithdrawId(),
      withdrawNonce: n == 0 ? withdrawNonce : null,
    );
    n += 1;
    if (one != null) {
      out.add(one);
      ledger.clearReserveNotice();
    }
    // One matured portal per run. A later portal waits for the next run.
    break;
  }
  return out;
}

/// Post a proved withdraw. The spend is a fresh FS-1 proof. The payout is a
/// one-time dest20. `from`, `to`, and `payoutPortalId` are not on the body.
/// A failed post does not settle the local portal. There is no `from` send.
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
  bool publicIpConsent = false,
  List<Map<String, Object?>>? leaves,
  String? withdrawId,
  List<int>? withdrawNonce,
}) async {
  final posted = await postMaturedWithdraws(
    ledger,
    reserve: reserve,
    dest: dest,
    payout: payout,
    nowMs: nowMs,
    spendSeed: spendSeed,
    local: local,
    restFrame: restFrame,
    paymentCode: paymentCode,
    allowPublicHttp: allowPublicHttp,
    publicIpConsent: publicIpConsent,
    leaves: leaves,
    withdrawId: withdrawId,
    withdrawNonce: withdrawNonce,
  );
  if (posted.isEmpty) return null;
  return posted.last;
}

Future<({ShearTx tx, Map<String, int> settled})?> _postPortalWithdraw(
  ShearLedger ledger, {
  required ShearReserve reserve,
  required String dest,
  required String payout,
  required int nowMs,
  required Uint8List spendSeed,
  required String portalId,
  required List<Map<String, Object?>> leaves,
  required List<Map<String, Object?>> tranches,
  String? withdrawId,
  List<int>? withdrawNonce,
}) async {
  final maturedCommits = <String>{};
  final stubOf = <String, int>{};
  for (final tranche in tranches) {
    if (!_trancheMatured(tranche, reserve.currentEpoch)) continue;
    final commit = _commitHex(tranche['commit']);
    if (commit == null) continue;
    maturedCommits.add(commit);
    final stub = tranche['stubNanos'];
    if (stub is int && stub > 0) stubOf[commit] = stub;
  }
  final matured = <Map<String, Object?>>[];
  var principal = 0;
  var stubNanos = 0;
  for (final leaf in leaves) {
    final hex = _leafCommitHex(leaf);
    final each = leaf['amount'];
    if (hex == null || !maturedCommits.contains(hex) || each is! int || each <= 0) continue;
    matured.add(leaf);
    principal += each;
    stubNanos += stubOf[hex] ?? 0;
  }
  final nanos = principal + stubNanos;
  if (matured.isEmpty || nanos <= 0) return null;
  final host = _freshWithdrawNote(ledger.pickableNotes);
  if (host == null) return null;
  final hostNanos = _rowNanos(host);
  if (hostNanos == null || hostNanos <= kLevyFloorUnits) return null;
  final fee = hostNanos > kLevyCapNanos ? kLevyCapNanos : kLevyFloorUnits;
  final changeN = hostNanos - fee;
  if (changeN <= 0) return null;
  final wdId = withdrawId ?? freshWithdrawId();
  final nonce = withdrawNonce != null && withdrawNonce.length == 32
      ? Uint8List.fromList(withdrawNonce)
      : randomBytes(32);
  final payout20 = withdrawPayoutDest20(spendSeed, portalId, nonce);
  final payoutSeed = withdrawPayoutSeed(spendSeed, portalId, nonce);
  if (payout20 == null || payoutSeed == null) return null;
  final sealedReceipt = attachAdmitPub(
    nativeSealNote(nanos, dest20: payout20, kind: 'withdraw'),
    spendSeed: payoutSeed,
    admitBase: admitPub(admitBaseScalar(spendSeed)),
    v: BigInt.from(nanos),
  );
  sealedReceipt['kind'] = 'withdraw';
  sealedReceipt['dest20'] = payout20;
  final changeSeedBytes = withdrawChangeSeedOf(spendSeed, portalId, nonce);
  final changeDest = changeSeedBytes == null
      ? null
      : destCommitFromSpendPub(ed25519PublicFromSeed(changeSeedBytes));
  if (changeSeedBytes == null || changeDest == null || _same20(changeDest, payout20)) return null;
  final change = hiddenChangeNote(
    changeN,
    changeDest,
    spendSeed: changeSeedBytes,
    admitBase: admitPub(admitBaseScalar(spendSeed)),
  );
  if (change == null) return null;
  late final ({
    List<Map<String, dynamic>> vin,
    List<Map<String, dynamic>> proofs,
    Uint8List fs1,
    int anchor,
    Uint8List excess,
    List<Uint8List> t,
  }) spent;
  try {
    spent = await ledger.spendFs1Notes(
      notes: [host],
      sealed: <Map<String, dynamic>>[sealedReceipt, change],
      fee: fee,
      spendSeed: spendSeed,
      kind: 'withdraw',
      portalId: portalId,
      programId: kReserveProgram,
      id: wdId,
      withdrawNonce: nonce,
      reserveNanos: nanos,
    );
  } catch (_) {
    return null;
  }
  if (spent.proofs.isEmpty) return null;
  final proofs = <Map<String, Object?>>[];
  for (final proof in spent.proofs) {
    final blob = proof['blob'];
    final tilde = proof['cTilde'];
    final tag = proof['spendTag'];
    if (blob is! List<int> || tilde is! List<int> || tag is! List<int>) return null;
    proofs.add({'blob': blob, 'cTilde': tilde, 'spendTag': tag});
  }
  final built = buildProvedWithdraw(
    dest20: payout20,
    nanos: nanos,
    id: wdId,
    portalId: portalId,
    anchor: spent.anchor,
    excess: spent.excess,
    fs1: spent.fs1,
    vin: [
      for (final row in spent.vin) Map<String, Object?>.from(row),
    ],
    admitProofs: proofs,
    leaves: matured,
    spendSeed: spendSeed,
    withdrawNonce: nonce,
    releaseEpoch: reserve.currentEpoch,
    fee: fee,
    vout: <Map<String, Object?>>[
      Map<String, Object?>.from(compactSealedVout(sealedReceipt)),
      Map<String, Object?>.from(compactSealedVout(change)),
    ],
    tranches: tranches,
  );
  if (built == null) return null;
  if (built.containsKey('from') || built.containsKey('to') || built.containsKey('payoutPortalId') || built.containsKey('spendPub')) {
    return null;
  }
  if (built['rewardSig'] is! List<int> || (built['rewardSig'] as List).length != 64) return null;
  final ack = await ledger.pool!.postRaw(_hexPost(built));
  if (!_votePostOk(ack)) {
    _notePostRefusal(ledger, ack);
    return null;
  }
  host['spent'] = true;
  ledger.rememberNote(<String, dynamic>{
    'kind': 'withdraw',
    'dest20': Uint8List.fromList(payout20),
    'commit': sealedReceipt['commit'],
    'noteCommit': sealedReceipt['noteCommit'],
    'r': sealedReceipt['r'],
    'admitPub': sealedReceipt['admitPub'],
    if (sealedReceipt['rEph'] != null) 'rEph': sealedReceipt['rEph'],
    if (sealedReceipt['rCt'] != null) 'rCt': sealedReceipt['rCt'],
    if (sealedReceipt['amtCt'] != null) 'amtCt': sealedReceipt['amtCt'],
    'portalId': portalId,
    'withdrawNonce': nonce,
    'payoutSeed': payoutSeed,
    'spendSeed': payoutSeed,
  });
  ledger.rememberNote(<String, dynamic>{
    'kind': 'send',
    'dest20': Uint8List.fromList(changeDest),
    'commit': change['commit'],
    'noteCommit': change['noteCommit'],
    'r': change['r'],
    'admitPub': change['admitPub'],
    'rEph': change['rEph'],
    'rCt': change['rCt'],
    'amtCt': change['amtCt'],
    'nanos': changeN,
    'portalId': portalId,
    'withdrawNonce': nonce,
    'spendSeed': changeSeedBytes,
    'changeSeed': changeSeedBytes,
  });
  final settled = reserve.withdraw(dest: dest, nowMs: nowMs, payout: payout);
  if (settled == null) return null;
  return (
    tx: ShearTx(
      id: (built['id'] ?? '').toString(),
      from: '',
      to: '',
      amount: nanos / kUnitsPerShe,
      kind: 'withdraw',
    ),
    settled: settled,
  );
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
  bool publicIpConsent = false,
  Map<String, dynamic>? vaultProof,
}) async {
  if (!reserve.epochIsOver(nowMs)) return null;
  if (reserve.portal(dest).nanos <= 0) return null;
  if (!local && !publicNodePostAllowed(consent: publicIpConsent)) {
    throw StateError(kPublicIpWaitCopy);
  }
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
    publicConsent: publicIpConsent,
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

const String kPortalBlindTag = 'shear-portal-r-v1';
const String kPortalIdTag = 'shear-portal-id-v1';
const String kPortalSpendTag = 'shear-portal-spend-v1';

Uint8List portalIndexBytes(int lockIndex) {
  final b = Uint8List(4);
  final n = lockIndex < 0 ? 0 : lockIndex;
  b[0] = n & 0xff;
  b[1] = (n >> 8) & 0xff;
  b[2] = (n >> 16) & 0xff;
  b[3] = (n >> 24) & 0xff;
  return b;
}

/// r = H(tag, spendSeed, lockIndex). One portal per lock.
Uint8List? portalBlindFromSeed(Uint8List spendSeed, [int lockIndex = 0]) {
  if (spendSeed.length != 32) return null;
  return Uint8List.fromList(sha256.convert(<int>[
    ...utf8.encode(kPortalBlindTag),
    ...spendSeed,
    ...portalIndexBytes(lockIndex),
  ]).bytes);
}

/// One-time spend seed for this lock. Recovery scans the index.
Uint8List? portalSpendSeed(Uint8List spendSeed, [int lockIndex = 0]) {
  if (spendSeed.length != 32) return null;
  return Uint8List.fromList(sha256.convert(<int>[
    ...utf8.encode(kPortalSpendTag),
    ...spendSeed,
    ...portalIndexBytes(lockIndex),
  ]).bytes);
}

/// One-time payout key. The identity spend key is not the payout.
Uint8List? withdrawPayoutSeed(Uint8List spendSeed, String portalId, List<int> nonce) {
  return withdrawPayoutSeedOf(spendSeed, portalId, nonce);
}

/// One-time key for withdraw change. Domain-separated from the payout seed.
Uint8List? withdrawChangeSeed(Uint8List spendSeed, String portalId, List<int> nonce) {
  return withdrawChangeSeedOf(spendSeed, portalId, nonce);
}

/// dest20 the wallet can spend. Re-derived from the seed, the portal, and the nonce.
Uint8List? withdrawPayoutDest20(Uint8List spendSeed, String portalId, List<int> nonce) {
  final one = withdrawPayoutSeed(spendSeed, portalId, nonce);
  if (one == null) return null;
  return destCommitFromSpendPub(ed25519PublicFromSeed(one));
}

/// True when this note pays the one-time dest the seed can spend.
bool recognisesWithdrawPayout(Map<String, dynamic> note, Uint8List spendSeed, String portalId, List<int> nonce) {
  final want = withdrawPayoutDest20(spendSeed, portalId, nonce);
  final got = note['dest20'];
  if (want == null || got is! List<int> || got.length < 20) return false;
  for (var i = 0; i < 20; i++) {
    if (got[i] != want[i]) return false;
  }
  return true;
}

/// Fresh subaddress dest20. Not the identity address and not the height-0 vault dest.
Uint8List? portalDest20FromSeed(Uint8List spendSeed, [int lockIndex = 0]) {
  final one = portalSpendSeed(spendSeed, lockIndex);
  if (one == null) return null;
  return destCommitFromSpendPub(ed25519PublicFromSeed(one));
}

/// Every portal this seed opens, in lock-index order.
List<Map<String, Object>> portalsFromSeed(Uint8List spendSeed, int count) {
  final out = <Map<String, Object>>[];
  for (var i = 0; i < count; i++) {
    final dest20 = portalDest20FromSeed(spendSeed, i);
    final blind = portalBlindFromSeed(spendSeed, i);
    if (dest20 == null || blind == null) break;
    final id = portalIdFromDest20(dest20, blind);
    if (id == null) break;
    out.add(<String, Object>{'lockIndex': i, 'dest20': dest20, 'portalId': id});
  }
  return out;
}

/// portalId = H(tag, dest20). r is not an input. A peer recomputes this.
String? portalIdFromDest20(List<int> dest20, [List<int>? r]) {
  r;
  if (dest20.length < 20) return null;
  final d20 = dest20.length == 20 ? dest20 : dest20.sublist(0, 20);
  return sha256.convert(<int>[...utf8.encode(kPortalIdTag), ...d20]).toString();
}

/// Address hash. Not the consensus portal id. A compact lock carries [portalIdFromDest20].
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

  String? deposit({required String dest, required double she, required int nowMs, String? payout, int? lockIndex}) {
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
    }
    if (lockIndex != null && lockIndex >= 0) p.lockIndex = lockIndex;
    else if (p.lockAmount == n) p.lockIndex = 0;
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
  bool publicIpConsent = false,
}) async {
  if (she <= 0 || !isDestAddress(dest)) {
    return const ReserveDepositResult(posted: false, remark: 'Enter an amount of at least one π.');
  }
  final lockNanos = (she * kUnitsPerShe).round();
  if (lockNanos < kPiSheNanos) {
    return const ReserveDepositResult(
      posted: false,
      remark: 'A lock is one π. Amounts below π stay spendable.',
    );
  }
  // A lock is exactly one π leaf (ruling 25 Oct): a larger amount is refused
  // here, with the wallet's own sentence, before any note is planned or posted.
  if (lockNanos != kPiSheNanos) {
    return const ReserveDepositResult(posted: false, remark: kErrLockAmount);
  }
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
    if (!local && !publicNodePostAllowed(consent: publicIpConsent)) {
      ledger.restorePaintedBook(mark);
      return const ReserveDepositResult(posted: false, remark: kPublicIpWaitCopy);
    }
    final tx = await ledger.send(
      publicConsent: publicIpConsent,
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
    int? lockedAt;
    for (final note in ledger.notes.reversed) {
      if ((note['kind'] ?? '').toString() != 'lock') continue;
      if (note['lockIndex'] is int) {
        lockedAt = note['lockIndex'] as int;
        break;
      }
    }
    final err = reserve.deposit(
      dest: dest,
      she: kPiSheNanos / kUnitsPerShe,
      nowMs: DateTime.now().millisecondsSinceEpoch,
      payout: from,
      lockIndex: lockedAt,
    );
    if (err != null) {
      // The lock is already on the wire. A local book remark is not a failed post.
      return ReserveDepositResult(posted: true, remark: reserveReasonCopy(err), tx: tx);
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

/// Close height for a census open. The day is [kVaultDayBlocks], not the stub day.
int? voteCloseHeightOf(int openHeight) {
  if (openHeight < 0) return null;
  final day = kReserveEpochDays - kReserveJoinCutoffDays;
  if (day < 0) return null;
  return openHeight + day * kVaultDayBlocks;
}

int? _leafChoice(String choice) {
  if (choice == kVoteIncrease) return 1;
  if (choice == kVoteDecrease) return -1;
  if (choice == kVoteHold) return 0;
  return null;
}

Map<String, dynamic>? _noteByCommit(List<dynamic> notes, String commit) {
  final want = commit.toLowerCase();
  for (final row in notes) {
    if (row is! Map) continue;
    final hex = _commitHex(row['commit']);
    if (hex != null && hex == want) return Map<String, dynamic>.from(row);
  }
  return null;
}

int? _rowNanos(Map<String, dynamic> note) {
  final raw = note['nanos'] ?? note['verifiedNanos'];
  if (raw is int && raw > 0) return raw;
  if (raw is num && raw > 0) return raw.toInt();
  if (raw is String) {
    final n = int.tryParse(raw);
    if (n != null && n > 0) return n;
  }
  return null;
}

Uint8List? _commitHexBytes(String hex) {
  final raw = hex.startsWith('0x') || hex.startsWith('0X') ? hex.substring(2) : hex;
  if (raw.length < 64) return null;
  final out = Uint8List(32);
  for (var i = 0; i < 32; i++) {
    final byte = int.tryParse(raw.substring(i * 2, i * 2 + 2), radix: 16);
    if (byte == null) return null;
    out[i] = byte;
  }
  return out;
}

/// One-time seed for a vote-fee change. The dest20 is this key's commit.
Uint8List? voteChangeSeed(Uint8List spendSeed, List<int> feeCommit) {
  return voteChangeSeedOf(spendSeed, feeCommit);
}

/// Change for a vote fee. A fresh one-time address, not the fee note's dest20.
Uint8List? voteChangeDest20(Uint8List spendSeed, List<int> feeCommit) {
  final one = voteChangeSeed(spendSeed, feeCommit);
  if (one == null) return null;
  return destCommitFromSpendPub(ed25519PublicFromSeed(one));
}

void _markCommitSpent(List<dynamic> notes, String commit) {
  final want = commit.toLowerCase();
  for (final row in notes) {
    if (row is! Map) continue;
    final hex = _commitHex(row['commit']);
    if (hex != null && hex == want) row['spent'] = true;
  }
}

Uint8List? _rowDest20(Map<String, dynamic> note) {
  final raw = note['dest20'];
  if (raw is Uint8List && raw.length == 20) return raw;
  if (raw is List<int> && raw.length == 20) return Uint8List.fromList(raw);
  final addr = note['address'] ?? note['dest'];
  if (addr is String && addr.isNotEmpty) return hash20FromAddress(addr);
  return null;
}

bool _votePostOk(Map<String, dynamic> ack) {
  if (ack['ok'] == false) return false;
  final reason = ack['reason'];
  if (reason != null && reason.toString().isNotEmpty) return false;
  return ack['ok'] == true || ack['id'] != null || ack['txid'] != null;
}

void _notePostRefusal(ShearLedger ledger, Map<String, dynamic> ack) {
  final reason = (ack['reason'] ?? '').toString().trim();
  ledger.noteReserveRemark(
    reason.isEmpty ? 'The node refused that post.' : reserveReasonCopy(reason),
  );
}

/// One leaf vote per planned height. The open and close come from the census
/// the wallet already synced. A missing census fails closed. Each vote carries
/// a real vote proof, a fresh fee-note spend, and the allowlisted admit fields.
/// There is no portal vote.
Future<ReserveVoteResult> castPlannedLeafVotes({
  required ShearLedger ledger,
  required ShearReserve reserve,
  required String planDir,
  required String dest,
  required String choice,
  required String restFrame,
  String? paymentCode,
  Uint8List? spendSeed,
  bool local = true,
  bool publicIpConsent = false,
  int? nowMs,
}) async {
  nowMs;
  if (!local && !publicNodePostAllowed(consent: publicIpConsent)) {
    return const ReserveVoteResult(enacted: false, remark: kPublicIpWaitCopy);
  }
  final gate = reserveVoteGate(ledger, reserve, dest);
  if (gate != null) return ReserveVoteResult(enacted: false, remark: gate);
  final count = reserve.portal(dest).nanos ~/ kPiSheNanos;
  if (count < 1) return ReserveVoteResult(enacted: false, remark: kVoteBelowPi);
  final picked = _leafChoice(choice);
  if (picked == null) {
    return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError('bad_amount')));
  }
  final voteL = estimateSendLevyUnits(inputs: 1, outputs: 1);
  final needShe = voteL / kUnitsPerShe;
  if (!spendableCoversLevy(
    ledger.spendableOwned(restFrame, paymentCode: paymentCode),
    voteL * count,
  )) {
    return ReserveVoteResult(
      enacted: false,
      remark: 'Not enough Continuum spendable for vote tx fee ${formatShe(needShe)} SHE',
    );
  }
  final census = ledger.epochCensus(reserve.currentEpoch);
  if (census == null || planDir.isEmpty) {
    return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError('not_voter')));
  }
  final close = voteCloseHeightOf(census.openHeight);
  if (close == null) {
    return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError('epoch_closed')));
  }
  Map<String, Object?>? plan;
  try {
    plan = plannedLeafVotes(
      dir: planDir,
      leaves: count,
      notes: ledger.pickableNotes,
      openHeight: census.openHeight,
      closeHeight: close,
      epoch: reserve.currentEpoch,
    );
  } catch (e) {
    return ReserveVoteResult(enacted: false, remark: voteFailCopy(e));
  }
  final txs = plan?['txs'];
  if (plan == null || txs is! List || txs.length != count) {
    return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError('not_voter')));
  }
  final locks = reserveLockLeaves(ledger.pickableNotes);
  if (locks == null || spendSeed == null || spendSeed.length != 32) {
    return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError('unsigned')));
  }
  final proposal = voteProposalId(reserve.currentEpoch, 'hb');
  if (proposal == null) {
    return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError('unsigned')));
  }
  final used = <String>{};
  for (final row in txs) {
    if (row is! Map) {
      return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError('not_voter')));
    }
    final height = row['height'];
    final leaf = row['leaf'];
    final feeCommit = row['feeInput'];
    if (height is! int || leaf is! int || feeCommit is! String || !used.add(feeCommit)) {
      return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError('not_voter')));
    }
    final seq = leaf + 1;
    if (seq > 8 || leaf < 0 || leaf >= locks.length) {
      return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError('unsigned')));
    }
    final voteProof = proveLeafVote(
      locks: locks,
      which: leaf,
      epoch: reserve.currentEpoch,
      choice: picked,
      seq: seq,
      proposalId: proposal,
    );
    final blob = voteProof?['blob'];
    if (voteProof == null || blob is! Uint8List || blob.isEmpty || blob[0] != kVoteVer) {
      return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError('unsigned')));
    }
    final feeNote = _noteByCommit(ledger.notes, feeCommit);
    final noteNanos = feeNote == null ? null : _rowNanos(feeNote);
    final feeDest = feeNote == null ? null : _rowDest20(feeNote);
    final feeCommitBytes = _commitHexBytes(feeCommit);
    final changeSeedBytes = feeCommitBytes == null ? null : voteChangeSeed(spendSeed, feeCommitBytes);
    final changeDest = changeSeedBytes == null ? null : destCommitFromSpendPub(ed25519PublicFromSeed(changeSeedBytes));
    if (feeNote == null || noteNanos == null || noteNanos < voteL || changeDest == null || changeSeedBytes == null) {
      return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError('unsigned')));
    }
    if (feeDest != null && _same20(changeDest, feeDest)) {
      return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError('unsigned')));
    }
    // The plan stores the commit as hex. A scanned note keeps those 32 bytes.
    // The leaf-vote builder only selects a string commit.
    final feeRow = Map<String, dynamic>.from(feeNote);
    feeRow['commit'] = feeCommit;
    Map<String, dynamic>? change;
    if (noteNanos > voteL) {
      change = hiddenChangeNote(
        noteNanos - voteL,
        changeDest,
        spendSeed: changeSeedBytes,
        admitBase: admitPub(admitBaseScalar(spendSeed)),
      );
      if (change == null) {
        return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError('unsigned')));
      }
    }
    late final ({
      List<Map<String, dynamic>> vin,
      List<Map<String, dynamic>> proofs,
      Uint8List fs1,
      int anchor,
      Uint8List excess,
      List<Uint8List> t,
    }) spent;
    try {
      spent = await ledger.spendFs1Notes(
        notes: [feeRow],
        sealed: change == null ? const <Map<String, dynamic>>[] : [change],
        fee: voteL,
        spendSeed: spendSeed,
        kind: 'leaf-vote',
        programId: kReserveProgram,
      );
    } catch (e) {
      return ReserveVoteResult(enacted: false, remark: voteFailCopy(e));
    }
    if (spent.proofs.length != 1 || spent.t.length != 1) {
      return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError('unsigned')));
    }
    final proof = spent.proofs.first;
    final postedChange = change == null ? null : Map<String, Object?>.from(compactSealedVout(change));
    final built = buildLeafVote(
      vote: {
        'choice': picked,
        'voteProof': blob,
        'voteOutput': voteProof['note'],
        'voteSeq': seq,
        'voteParam': 'hb',
        'earnEpoch': reserve.currentEpoch,
        'height': height,
      },
      notes: [feeRow],
      fee: voteL,
      anchor: spent.anchor,
      change: postedChange,
      prove: (note) {
        if (note['commit']?.toString() != feeCommit) return null;
        final rawBlob = proof['blob'];
        final tilde = proof['cTilde'];
        final tag = proof['spendTag'];
        if (rawBlob is! List<int> || tilde is! List<int> || tag is! List<int>) return null;
        return {
          'fs1': spent.fs1,
          'excess': spent.excess,
          't': spent.t.first,
          'admitProof': {
            'blob': rawBlob,
            'cTilde': tilde,
            'spendTag': tag,
          },
        };
      },
    );
    if (built == null || built['voteProof'] == null) {
      return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError('unsigned')));
    }
    if (built.containsKey('from') || built.containsKey('to') || built.containsKey('portalId') ||
        built.containsKey('payoutPortalId') || built.containsKey('feeInput') ||
        built.containsKey('parentTx') || built.containsKey('parent')) {
      return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError('vote_leak')));
    }
    built['programId'] = kReserveProgram;
    built['kind'] = 'leaf-vote';
    if (local || ledger.pool == null) {
      return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError('unsigned')));
    }
    final ack = await ledger.pool!.postRaw(_wireBody(built));
    if (!_votePostOk(ack)) {
      final reason = (ack['reason'] ?? 'unsigned').toString();
      return ReserveVoteResult(enacted: false, remark: voteFailCopy(StateError(reason)));
    }
    _markCommitSpent(ledger.notes, feeCommit);
    if (change != null) {
      ledger.rememberNote(<String, dynamic>{
        'kind': 'send',
        'dest20': Uint8List.fromList(changeDest),
        'commit': change['commit'],
        'noteCommit': change['noteCommit'],
        'r': change['r'],
        'admitPub': change['admitPub'],
        'rEph': change['rEph'],
        'rCt': change['rCt'],
        'amtCt': change['amtCt'],
        'nanos': noteNanos - voteL,
        'spendSeed': changeSeedBytes,
        'changeSeed': changeSeedBytes,
      });
    }
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
