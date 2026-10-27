import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_ctf.dart';
import 'shear_identity.dart';
import 'shear_eip712.dart';
import 'shear_levy.dart';
import 'shear_read_open.dart';
import 'shear_read_sync.dart';
import 'shear_session.dart';
import 'shear_ed25519.dart';
import 'shear_pack.dart';
import 'shear_public_confirm.dart';
import 'shear_admit.dart';
import 'shear_admit_ffi.dart';
import 'shear_blunote.dart';
import 'shear_fs1.dart';
import 'shear_native_prove.dart';
import 'shear_note.dart';
import 'shear_ristretto.dart';
import 'shear_vault_reward.dart' show consensusUnlockPeriod, hiddenChangeNote, kPiSheNanos, kVaultUnlockOpen, vaultLockBlindBytes, vaultLockOwnerBytes;
import 'shear_withdraw.dart' show proveLockFundEquality, vaultLeafNote;
import 'shear_checkpoint.dart';
import 'shear_hash.dart';
import 'shear_tip_tick.dart';

const kSheDecimals = 11;
const kShePublicDigits = 9;
const kUnitsPerShe = 100000000000; // 10^11
/// Fingerprint pot (BLOCK_SUBSIDY_NANOS / NANOS_PER_SHE). Continuum display only; do not mint from this.
const kBlockPotShe = 1.0;

/// Sealed pool fee is 1% of that pot. Compact drops `v` on a pool-fee note.
/// The commitment still opens at this rate, any fee up to 2% of the subsidy, or the pot.
/// Same candidates as `openedCoinbaseNanos`. A node balance is not a candidate.
const kPoolFeeBps = 100;
const kPoolFeeMaxBps = 200;

/// Fingerprint target interval (TARGET_BLOCK_INTERVAL_MS). Continuum display only.
const kTargetBlockIntervalMs = 90000;

/// Next owed-toward-π sum becomes spendable after this long.
const kNextOwedMatureMs = 6000;

/// Milliseconds until [owedShe] matures. A new sum restarts the 6 second clock.
int owedMatureLeftMs({
  required double owedShe,
  required double anchoredShe,
  required int anchorMs,
  required int nowMs,
}) {
  if (owedShe <= 0) return 0;
  if (anchorMs <= 0 || owedShe != anchoredShe) return kNextOwedMatureMs;
  final left = kNextOwedMatureMs - (nowMs - anchorMs);
  if (left <= 0) return 0;
  return left;
}

/// 0.00000000001 SHE per valid hash.
const kHashBonusShe = 0.00000000001;
const kHashBonusVoteDeltaShe = 0.00000000001;

/// Pending receive / pool-withdraw (height < 1) must not drive full history+notes+memoOpen.
bool pendingReceiveThinPoll(Iterable<ShearTx> txs) => txs.any(
  (t) =>
      (t.kind == 'pool-withdraw' || t.kind == 'receive') && (t.height ?? 0) < 1,
);

/// A tip ahead of the last ingest must walk every seal up to that tip.
/// A height-less pending row does not hide those seals. Once the book is
/// caught up, the poll stays on the thin balance read.
/// A pending receive by itself does not force the full pull. A tip that
/// moved without a landing does.
bool shouldFullSyncCredits({
  required bool hasPendingReceive,
  required bool historyBehindTip,
  bool openCollatePending = false,
  bool tipMovedWithoutLanding = false,
}) {
  if (openCollatePending) return true;
  if (historyBehindTip) return true;
  if (tipMovedWithoutLanding) return true;
  return hasPendingReceive && tipMovedWithoutLanding;
}

/// The notes open is separate from the desktop node sidecar. Android, and any
/// wallet that is not running a local node, still retries it until a list
/// comes back. A failed read, a book that has never collated, or spendable
/// with no opened note all stay due. A finished empty list is not due.
bool notesCollateDue({
  required bool openCollated,
  required bool readFailed,
  required bool notesLag,
  bool notesBehindTip = false,
}) {
  if (readFailed) return true;
  if (!openCollated) return true;
  if (notesBehindTip) return true;
  return notesLag;
}

/// Heights strictly after [before] through [tip], inclusive.
List<int> tipGapHeights(int before, int tip) {
  if (tip < 1 || tip <= before) return const [];
  final start = before < 0 ? 1 : before + 1;
  return [for (var h = start; h <= tip; h++) h];
}

/// One owner mined land already present on a node body, history row, or note.
class NodeOwnerLand {
  const NodeOwnerLand({
    required this.height,
    required this.dest,
    required this.amount,
    required this.kind,
  });

  final int height;
  final String dest;
  final double amount;
  final String kind;
}

class TipGapPlan {
  const TipGapPlan({required this.lands, required this.misses});

  final List<NodeOwnerLand> lands;
  final List<int> misses;
}

const _minedKinds = {'blockfound', 'coinbase', 'mine', 'block', 'pot'};

bool _isMinedKind(String kind) => _minedKinds.contains(kind);

String? _rowDest(Map row) {
  for (final key in const ['dest', 'address', 'to', 'miner']) {
    final v = row[key]?.toString() ?? '';
    if (v.isNotEmpty) return v;
  }
  return null;
}

double _rowShe(Map row) {
  final amount = row['amount'];
  if (amount is num && amount > 0) return amount.toDouble();
  final nanos = row['nanos'];
  if (nanos is num && nanos > 0) return nanos / kUnitsPerShe;
  return _proofOpenedShe(row);
}

/// She from a value proof that opened. A bare `{v}`, a pool balance, an
/// owed-π figure, or a history amount with no R and z is not a coin.
double _proofOpenedShe(Map row) {
  final opened = _verifiedClaimNanos(row);
  if (opened == null || opened <= 0) return 0;
  return opened / kUnitsPerShe;
}

int _rowHeight(Map row) {
  final h = row['height'];
  if (h is num) return h.toInt();
  return int.tryParse('${h ?? ''}') ?? 0;
}

/// Owner mined lands in node material. Pool balance and owed-π are ignored.
List<NodeOwnerLand> ownerLandsFromNode({
  required Iterable<Map> bodies,
  required Iterable<Map> history,
  required Iterable<Map> notes,
  required Set<String> moneyDests,
}) {
  if (moneyDests.isEmpty) return const [];
  final out = <NodeOwnerLand>[];
  final seen = <String>{};

  void add(int height, String dest, double amount, String kind) {
    if (height < 1 || dest.isEmpty || amount <= 0) return;
    if (!moneyDests.contains(dest)) return;
    if (!_isMinedKind(kind)) return;
    final id = '$height|$dest|$kind';
    if (!seen.add(id)) return;
    out.add(
      NodeOwnerLand(
        height: height,
        dest: dest,
        amount: amount,
        kind: kind == 'pot' || kind == 'block' || kind == 'coinbase'
            ? 'blockfound'
            : kind,
      ),
    );
  }

  for (final row in history) {
    final kind = row['kind']?.toString() ?? '';
    final dest = _rowDest(row);
    if (dest == null) continue;
    add(
      _rowHeight(row),
      dest,
      _proofOpenedShe(row),
      kind.isEmpty ? 'blockfound' : kind,
    );
  }
  for (final row in notes) {
    final kind =
        row['kind']?.toString() ?? (row['coinbase'] == true ? 'coinbase' : '');
    final dest = _rowDest(row);
    if (dest == null) continue;
    if (kind == 'hash' || kind == 'dummy' || kind == 'send') continue;
    add(
      _rowHeight(row),
      dest,
      _proofOpenedShe(row),
      kind.isEmpty ? 'coinbase' : kind,
    );
  }
  for (final block in bodies) {
    final h = _rowHeight(block);
    if (h < 1) continue;
    final miner = block['miner']?.toString() ?? '';
    final txs = block['txs'];
    if (txs is List) {
      for (final tx in txs) {
        if (tx is! Map) continue;
        final coinbase = tx['coinbase'] == true;
        for (final key in const ['vout', 'vouts', 'notes']) {
          final list = tx[key];
          if (list is! List) continue;
          for (final item in list) {
            if (item is! Map) continue;
            final kind =
                item['kind']?.toString() ?? (coinbase ? 'coinbase' : '');
            if (kind == 'hash' || kind == 'dummy') continue;
            final dest = _rowDest(item) ?? (coinbase ? miner : null);
            if (dest == null) continue;
            if (!coinbase && !_isMinedKind(kind)) continue;
            add(h, dest, _rowShe(item), kind.isEmpty ? 'coinbase' : kind);
          }
        }
      }
    }
    for (final key in const ['notes', 'vouts', 'vout']) {
      final list = block[key];
      if (list is! List) continue;
      for (final item in list) {
        if (item is! Map) continue;
        final kind = item['kind']?.toString() ?? 'coinbase';
        if (kind == 'hash' || kind == 'dummy' || kind == 'send') continue;
        final dest = _rowDest(item) ?? miner;
        if (dest.isEmpty) continue;
        add(h, dest, _rowShe(item), kind);
      }
    }
  }
  return out;
}

/// One row per height in (before, tip] that the node material names.
/// A height with no node land is an honest miss. Pool figures are not a fill.
TipGapPlan planTipGap({
  required int before,
  required int tip,
  required List<NodeOwnerLand> opened,
}) {
  final byHeight = <int, List<NodeOwnerLand>>{};
  for (final land in opened) {
    (byHeight[land.height] ??= <NodeOwnerLand>[]).add(land);
  }
  final lands = <NodeOwnerLand>[];
  final misses = <int>[];
  for (final h in tipGapHeights(before, tip)) {
    final rows = byHeight[h];
    if (rows == null || rows.isEmpty) {
      misses.add(h);
    } else {
      lands.addAll(rows);
    }
  }
  return TipGapPlan(lands: lands, misses: misses);
}

/// The header tip and the notes host are different reads. A header can move
/// first. Stamp only a host height this notes response actually reported.
/// A missing host height is not the header: that would mature a coin the
/// list has not covered yet.
int notesHostStamp({required int sealed, required int hostHeight}) {
  if (hostHeight < 1) return 0;
  if (sealed < 1) return hostHeight;
  return hostHeight < sealed ? hostHeight : sealed;
}

/// History and notes may be marked caught-up only when no immature owner
/// land from node material is still absent. [misses] is the empty-pull count.
bool mayStampIngestCaughtUp({
  required bool landsMissing,
  required int misses,
  int budget = 2,
}) {
  if (!landsMissing) return true;
  return misses >= budget;
}

String _bytesHex(Uint8List b) =>
    b.map((e) => e.toRadixString(16).padLeft(2, '0')).join();

bool noteBytesEq(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

/// Plate tests set this. flutter_tester deadlocks inside [Isolate.run]
/// before the native prover starts, so seal runs on the caller instead.
bool sealFlowOnCaller = false;

/// Last exception from [submitContinuumSend], for plate tests.
/// [flowSendAdvisoryOf] still collapses the remark the user sees.
Object? debugLastContinuumSendError;

/// Inputs on one Flow spend. The count is [kMaxInputsPerSend]: the tighter
/// of the prove-time budget and the hex-body budget recorded below.

/// UI progress for a send. [cancel] is checked between proofs, not inside one.
class SendProgress {
  int done = 0;
  int total = 1;
  String phase = 'select';
  bool cancelRequested = false;
  void cancel() => cancelRequested = true;
  void Function()? onChange;
  void bump({int? done, int? total, String? phase}) {
    if (done != null) this.done = done;
    if (total != null) this.total = total;
    if (phase != null) this.phase = phase;
    onChange?.call();
  }
}

/// Isolate stamp of the last [selectSpendNotesWire]. Differs from the UI isolate.
String debugSendSelectStamp = '';

/// Change output of the last send, in nanos. The held part of a note.
BigInt? debugLastChangeNanos;

/// Recipient nanos of the last send, after a hold kept the fee off the stake.
BigInt? debugLastPayNanos;

/// Fee nanos reserved by the last send.
BigInt? debugLastFeeNanos;

/// Nanos strings the last selection put in a batch. Digit strings, not doubles.
List<String> debugSendSelectNanos = <String>[];

List<String> _selectedNanos(Map raw) {
  final found = <String>[];
  final batches = raw['batches'];
  if (batches is! List) return found;
  for (final batch in batches) {
    if (batch is! Map) continue;
    final notes = batch['notes'];
    if (notes is! List) continue;
    for (final note in notes) {
      if (note is! Map) continue;
      final nanos = note['nanos'];
      if (nanos == null) continue;
      found.add(nanos.toString());
    }
  }
  return found;
}

/// Isolate stamps of the last Flow seal, prove, and sign.
/// Production [Isolate.run] stamps differ from the UI isolate.
String debugSendSealStamp = '';
String debugSendProveStamp = '';
String debugSendSignStamp = '';

const String kErrSendCancelled = 'Send cancelled';
const String kErrSendTimeout = 'Send did not reach the node — try again';
const String kErrFeeShort =
    'Not enough spendable to cover this amount and the fee';

/// Hex-JSON sizes and one prove, padded so the posted fee is not under the
/// sealed body. Wallet quote only. `levy.js` is not modified.
///
/// 2026-10-14 node/tests/test_fs1_spend_v12.js, 4-core x86_64 desktop: an
/// FS-1 spend proves in about 1250 ms per input (1 input 1281 ms, 8 inputs
/// 9936 ms). The aggregate blob is 5347 + 896 bytes per input and each input
/// adds a 321-byte record, so an input is 2434 hex bytes (pad 2600) on a
/// 10694 hex byte base (pad 11000). A sealed vout is a 14433-byte range
/// proof, about 29420 hex bytes; the pad is 30000. Consensus levy is
/// unchanged: `levyFromWeight` is max(100, ceil(jsonBytes/2048)).
const int kMeasuredProveMs = 1250;
const int kMeasuredProofHexBytes = 2600;
const int kMeasuredFs1BaseHexBytes = 11000;
const int kMeasuredOutputHexBytes = 30000;
const int kMeasuredTxBaseBytes = 512;
const int kMeasuredMemoHexBytes = 512;

/// Background prove budget for one send on a desktop. 1250 ms times 8 is
/// 10000 ms, inside this budget. A phone is slower; [kFs1ProveTimeout] is
/// the hard ceiling.
const int kSendProveBudgetMs = 10000;

/// Ceiling for one FS-1 prove off the UI isolate, tree sync included.
/// A phone proving eight inputs over a long chain stays well inside it.
const Duration kFs1ProveTimeout = Duration(minutes: 10);

bool _sameBytes32(Uint8List a, Uint8List b) {
  if (a.length != 32 || b.length != 32) return false;
  for (var i = 0; i < 32; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

/// Posted hex body budget. A send's measured body stays under 0.5 MB.
const int kSendHexBudgetBytes = 500000;

/// Inputs that fit [kSendProveBudgetMs] at [kMeasuredProveMs] each.
const int kSendTimeCap = kSendProveBudgetMs ~/ kMeasuredProveMs;

/// Inputs that fit [kSendHexBudgetBytes] with pay, change, and a dummy.
const int kSendSizeCap =
    (kSendHexBudgetBytes -
        kMeasuredTxBaseBytes -
        kMeasuredFs1BaseHexBytes -
        3 * kMeasuredOutputHexBytes) ~/
    kMeasuredProofHexBytes;

// dart format off
const int _kSendMeasuredCap = kSendTimeCap < kSendSizeCap ? kSendTimeCap : kSendSizeCap;
// dart format on

/// Tighter of prove time, tx size, and the consensus input limit of one
/// FS-1 spend. Not a hand-picked count.
const int kMaxInputsPerSend = _kSendMeasuredCap < kFs1InputMax
    ? _kSendMeasuredCap
    : kFs1InputMax;

/// Sweep while more spendable notes than [kMaxInputsPerSend] remain.
/// The marginal consensus levy of one extra proof is dust next to the
/// prove time and the hex body, so a SHE cutoff would not track the cost.
const int kConsolidateAboveCount = kMaxInputsPerSend;

/// Cap for this output count and memo. Time and size both apply. A memo or
/// an extra output can only shrink the count.
int measuredInputCap({int outputs = 3, bool memo = false}) {
  final nOut = outputs < 1 ? 1 : outputs;
  final fixed =
      kMeasuredTxBaseBytes +
      kMeasuredFs1BaseHexBytes +
      nOut * kMeasuredOutputHexBytes +
      (memo ? kMeasuredMemoHexBytes : 0);
  final room = kSendHexBudgetBytes - fixed;
  final sizeCap = room < kMeasuredProofHexBytes
      ? 1
      : room ~/ kMeasuredProofHexBytes;
  var cap = kSendTimeCap < sizeCap ? kSendTimeCap : sizeCap;
  if (cap > kFs1InputMax) cap = kFs1InputMax;
  return cap < 1 ? 1 : cap;
}

/// SHE text as an exact nanos decimal. A non-integer or an extra non-zero
/// digit past 11 places is refused. The result is never a JS-style round.
String? parseSheDecimalToNanos(String raw) {
  final s = raw.trim();
  if (!RegExp(r'^\d+(\.\d+)?$').hasMatch(s)) return null;
  final parts = s.split('.');
  final whole = parts[0];
  final frac = parts.length > 1 ? parts[1] : '';
  if (frac.length > 11 && RegExp(r'[^0]').hasMatch(frac.substring(11)))
    return null;
  final frac11 = (frac.length >= 11
      ? frac.substring(0, 11)
      : frac.padRight(11, '0'));
  final scale = BigInt.from(kUnitsPerShe);
  final nanos =
      BigInt.parse(whole) * scale + BigInt.parse(frac11.isEmpty ? '0' : frac11);
  if (nanos < BigInt.zero) return null;
  return nanos.toString();
}

int estimateSendLevyUnits({
  required int inputs,
  int outputs = 3,
  bool memo = false,
}) {
  final nIn = inputs < 1 ? 1 : inputs;
  final nOut = outputs < 1 ? 1 : outputs;
  final weight =
      kMeasuredTxBaseBytes +
      kMeasuredFs1BaseHexBytes +
      nIn * kMeasuredProofHexBytes +
      nOut * kMeasuredOutputHexBytes +
      (memo ? kMeasuredMemoHexBytes : 0);
  final padded = (weight * 5) ~/ 4 + 8192;
  final raw = (padded + 2047) ~/ 2048;
  final fee = raw < kLevyFloorUnits ? kLevyFloorUnits : raw;
  return fee > kLevyCapNanos ? kLevyCapNanos : fee;
}

/// [spendableShe] covers a consensus levy of [levyUnits].
/// Equality passes. A gap of 1e-12 SHE is float dust under one nano (1e-11 SHE).
/// Any levy size. A negative levy does not pass.
bool spendableCoversLevy(double spendableShe, int levyUnits) {
  if (levyUnits < 0) return false;
  if (!spendableShe.isFinite) return false;
  final needShe = levyUnits / kUnitsPerShe;
  return spendableShe + 1e-12 >= needShe;
}

/// A second submit while one is [held] must not start another post.
bool claimSingleSubmit({required bool held}) => !held;

double? _storedNoteShe(Map<dynamic, dynamic> n) {
  final amt = n['amount'];
  if (amt is num && amt > 0) return amt.toDouble();
  final nanos = n['nanos'];
  if (nanos is num && nanos > 0) return nanos.toDouble() / kUnitsPerShe;
  final verified = n['verifiedNanos'];
  if (verified is num && verified > 0)
    return verified.toDouble() / kUnitsPerShe;
  return null;
}

final BigInt _nanosPerShe = BigInt.from(kUnitsPerShe);

/// A double past this is not an amount. 2^53 - 1.
const int _kSafeDoubleNanos = 9007199254740991;

/// Int view of a send amount. Dart's [BigInt.toInt] clamps 2^63 through
/// 2^64-1, so this is not the pay path. [sendUnitsFromWire] is.
int sendNanosFromWire(String? nanosWire) {
  if (nanosWire == null || !RegExp(r'^\d+$').hasMatch(nanosWire)) return 0;
  final big = BigInt.parse(nanosWire);
  if (big < BigInt.zero || big.bitLength > 64) return 0;
  return big.toInt();
}

/// Exact send nanos. Any u64, including values a Dart int cannot name.
BigInt sendUnitsFromWire(String? nanosWire) {
  final units = tryU64Units(nanosWire);
  if (units == null || units <= BigInt.zero) return BigInt.zero;
  return units;
}

/// One hold for the selector. A pending lock and the portal principal are the
/// same coins, so the larger one is the hold. Any size, as a decimal string.
String selectionHoldNanos({
  required Iterable<BigInt> lockDebits,
  required Iterable<BigInt> reservePrincipals,
}) {
  var lock = BigInt.zero;
  for (final v in lockDebits) {
    if (v > BigInt.zero) lock += v;
  }
  var reserve = BigInt.zero;
  for (final v in reservePrincipals) {
    if (v > reserve) reserve = v;
  }
  final hold = lock > reserve ? lock : reserve;
  return hold.toString();
}

BigInt? _positiveDigitNanos(Object? v) {
  if (v is String && RegExp(r'^\d+$').hasMatch(v)) {
    final b = BigInt.parse(v);
    return b > BigInt.zero ? b : null;
  }
  if (v is int && v > 0) return BigInt.from(v);
  if (v is BigInt && v > BigInt.zero) return v;
  return null;
}

/// Exact nanos behind a send. A note digit string or int wins.
/// A double balance is used only while it is an exact integer at or below 2^53-1.
BigInt? fundedSendUnits(Map<dynamic, dynamic>? note, double fundedShe) {
  if (note != null) {
    final exact = noteNanosExact(note);
    if (exact != null) return exact;
  }
  if (!fundedShe.isFinite || fundedShe <= 0) return BigInt.zero;
  final scaled = fundedShe * kUnitsPerShe;
  if (!scaled.isFinite) return null;
  final rounded = scaled.round();
  if (rounded <= 0 || rounded > _kSafeDoubleNanos) return null;
  if ((rounded.toDouble() - scaled).abs() > 1e-4) return null;
  return BigInt.from(rounded);
}

/// Exact note nanos. A digit string or an int wins over a double amount.
/// A double is used only while it is an exact integer at or below 2^53-1.
BigInt? noteNanosExact(Map<dynamic, dynamic> n) {
  final direct =
      _positiveDigitNanos(n['nanos']) ??
      _positiveDigitNanos(n['verifiedNanos']);
  if (direct != null) return direct;
  final amt = n['amount'];
  if (amt is String) {
    final parsed = parseSheDecimalToNanos(amt);
    if (parsed != null) return _positiveDigitNanos(parsed);
  }
  if (amt is num && amt > 0 && amt.isFinite) {
    final scaled = amt.toDouble() * kUnitsPerShe;
    if (!scaled.isFinite) return null;
    final rounded = scaled.round();
    if (rounded <= 0 || rounded > _kSafeDoubleNanos) return null;
    if ((rounded.toDouble() - scaled).abs() > 1e-4) return null;
    return BigInt.from(rounded);
  }
  return null;
}

BigInt _nanosFromAmountField(Object? raw) {
  final direct = _positiveDigitNanos(raw);
  if (direct != null) return direct;
  if (raw is String) {
    final parsed = parseSheDecimalToNanos(raw);
    if (parsed != null) {
      final b = BigInt.parse(parsed);
      return b > BigInt.zero ? b : BigInt.zero;
    }
  }
  if (raw is num && raw > 0 && raw.isFinite) {
    final scaled = raw.toDouble() * kUnitsPerShe;
    if (!scaled.isFinite) return BigInt.zero;
    final rounded = scaled.round();
    if (rounded <= 0 || rounded > _kSafeDoubleNanos) return BigInt.zero;
    if ((rounded.toDouble() - scaled).abs() > 1e-4) return BigInt.zero;
    return BigInt.from(rounded);
  }
  return BigInt.zero;
}

/// A SHE field. An int is a whole SHE count, not a nanos count.
BigInt _sheToNanos(Object? raw) {
  if (raw is String) {
    final parsed = parseSheDecimalToNanos(raw);
    if (parsed == null) return BigInt.zero;
    final b = BigInt.parse(parsed);
    return b > BigInt.zero ? b : BigInt.zero;
  }
  if (raw is int) {
    if (raw <= 0) return BigInt.zero;
    return BigInt.from(raw) * _nanosPerShe;
  }
  return _nanosFromAmountField(raw);
}

double _sheOfNanos(BigInt nanos) {
  if (nanos <= BigInt.zero) return 0;
  final whole = nanos ~/ _nanosPerShe;
  final frac = nanos.remainder(_nanosPerShe);
  return whole.toDouble() + frac.toDouble() / kUnitsPerShe;
}

/// Spend material is the sealed commit, the note commit, and the opening.
/// An amount without those bytes is not a coin, at any size.
bool noteHasSealedSpendBytes(Map<dynamic, dynamic> n) {
  final commit = _noteBytes(n['commit']);
  final noteCommit = _noteBytes(n['noteCommit']);
  final blind = _noteBytes(n['r']);
  return commit != null &&
      commit.isNotEmpty &&
      noteCommit != null &&
      noteCommit.isNotEmpty &&
      blind != null &&
      blind.isNotEmpty;
}

/// Spend-tag point, off the UI isolate. The predicate reads the stamp only.
String? spendTagHexOf(Uint8List spendSeed, Map<String, dynamic> note) {
  try {
    final spentNote = {
      'kind': (note['kind'] as String?) ?? 'pot',
      'commit': _noteBytes(note['commit'])!,
      'noteCommit': _noteBytes(note['noteCommit'])!,
    };
    final x = admitScalarFromSeed(spendSeed, spentNote);
    return _bytesHex(pointBytes(spendTagPoint(x, admitPub(x))));
  } catch (_) {
    return null;
  }
}

/// A Vault lock is withdraw-only. Time does not open it.
/// A portal id, a lock index, a lock epoch, or an explicit vault flag is enough.
bool isVaultLockNote(Object? raw) {
  if (raw is! Map) return false;
  final note = raw;
  if ((note['kind'] ?? '').toString() != 'lock') return false;
  if (note['vaultLock'] == true) return true;
  final portal = (note['portalId'] ?? '').toString().toLowerCase();
  if (RegExp(r'^[0-9a-f]{64}$').hasMatch(portal)) return true;
  if (note['lockIndex'] is int) return true;
  final epoch = note['lockEpoch'];
  return epoch is int && epoch >= 0;
}

/// A Vault lock stays locked. Withdraw is the only exit.
/// Any other lock note stays locked until the tip time reaches its unlock.
/// No unlock on the note stays locked. Any other kind keeps its own flag.
bool lockNoteIsLocked(Map<String, dynamic> note, int? tipMs) {
  if (isVaultLockNote(note)) return true;
  final kind = (note['kind'] ?? '').toString();
  if (kind != 'lock') return note['locked'] == true;
  final raw = note['unlockAtMs'];
  final at = raw is num ? raw.toInt() : int.tryParse('${raw ?? ''}') ?? 0;
  if (at <= 0) return true;
  if (tipMs == null || tipMs < at) return true;
  return false;
}

/// One note a send can draw. The on-screen Spendable sum, [selectSpendNotesWire],
/// consolidate, and [ShearLedger]'s note pick all use this.
///
/// Spent, a chain spend tag, a lock (including [unlockAtMs]), maturity against
/// [tip], a verified open, exact nanos, and sealed spend bytes. [tip] is the
/// verified tip, not the notes scan cursor.
///
/// Spend bytes a send can build. A planner row stores that decision in
/// `sealed` after [noteHasSealedSpendBytes]. A book row needs the commit,
/// the note commit, and the opening. Commit and opening without noteCommit
/// throw `no_note` at send build, so they are not spendable.
bool spendBytesOk(Map<dynamic, dynamic> note) {
  if (note.containsKey('sealed') && note['sealed'] != true) return false;
  final hasCommit = note.containsKey('commit');
  final hasNote = note.containsKey('noteCommit');
  final hasBlind = note.containsKey('r');
  if (!hasCommit && !hasNote && !hasBlind) {
    return !note.containsKey('sealed') || note['sealed'] == true;
  }
  return noteHasSealedSpendBytes(note);
}

/// An amount-only quote omits `verified` and `sealed`. A book row does not:
/// it needs `verified == true` and [noteHasSealedSpendBytes].
bool spendableNote(
  Map<dynamic, dynamic> note, {
  required int tip,
  int confirmations = 9,
  int? tipMs,
  Set<String> spentTags = const <String>{},
  String? spendTag,
  bool ignoreConfs = false,
  bool allowBare = false,
}) {
  if (note['spent'] == true || note['reorged'] == true) return false;
  final tag =
      (spendTag ?? note['spendTag'] ?? note['spendTagHex'])
          ?.toString()
          .toLowerCase() ??
      '';
  if (tag.isNotEmpty && spentTags.contains(tag)) return false;
  if (lockNoteIsLocked(Map<String, dynamic>.from(note), tipMs)) return false;
  // Spendable is only what a send can use now: a note mined at a known
  // height with the required confirmations. A note with no height (fresh
  // change, a remembered session row) is Pending until a chain read gives it
  // one. [ignoreConfs] skips only the confirmation count, never the height:
  // no header sync gives an unmined note a height.
  final h = note['height'];
  if (h is! num || h < 1) return false;
  if (!ignoreConfs) {
    final height = h.toInt();
    if (tip < height || (tip - height + 1) < confirmations) return false;
  }
  final nanos = noteNanosExact(note);
  if (nanos == null || nanos <= BigInt.zero) return false;
  final bare =
      !note.containsKey('sealed') &&
      !note.containsKey('commit') &&
      !note.containsKey('noteCommit') &&
      !note.containsKey('r');
  if (bare) {
    if (!allowBare) return false;
  } else {
    if (note['verified'] != true) return false;
    if (!spendBytesOk(note)) return false;
  }
  return true;
}

/// Notes a max send can draw, after the same exact hold as the batches.
class SpendablePool {
  const SpendablePool(this.free, this.freeSum, this.noPlain);
  final List<Map<String, dynamic>> free;
  final BigInt freeSum;
  final bool noPlain;
}

SpendablePool poolSpendableNotes(Map<String, dynamic> input) {
  final notes = input['notes'] as List? ?? const [];
  final tip = (input['tip'] as num?)?.toInt() ?? 0;
  final floor = (input['confs'] as num?)?.toInt() ?? 9;
  final tipMs = (input['tipMs'] as num?)?.toInt();
  final spentTags = <String>{
    for (final t in (input['spentTags'] as List? ?? const <dynamic>[]))
      t.toString().toLowerCase(),
  };
  final hold = input['holdNanos'] != null
      ? _nanosFromAmountField(input['holdNanos'])
      : _sheToNanos(input['holdShe']);
  final dests = <String>{
    for (final d in (input['dests'] as List? ?? const [])) d.toString(),
  };
  final allowBare = input['allowBare'] == true;
  final rows = <Map<String, dynamic>>[];
  final openedLocks = <Map<String, dynamic>>[];
  for (var i = 0; i < notes.length; i++) {
    final n = notes[i];
    if (n is! Map) continue;
    if (!spendableNote(
      n,
      tip: tip,
      confirmations: floor,
      tipMs: tipMs,
      spentTags: spentTags,
      allowBare: allowBare,
    )) {
      continue;
    }
    final addr = (n['address'] ?? n['dest'])?.toString() ?? '';
    if (addr.isEmpty) continue;
    if (dests.isNotEmpty && !dests.contains(addr)) continue;
    final nanos = noteNanosExact(n);
    if (nanos == null || nanos <= BigInt.zero) continue;
    // A Vault lock is withdraw-only. It never joins the send pool, including
    // the opened-lock list, and the note index of every other row stays put.
    if (isVaultLockNote(n)) continue;
    final row = {'i': i, 'nanos': nanos, 'addr': addr};
    if ((n['kind'] ?? '').toString() == 'lock') {
      final raw = n['unlockAtMs'];
      final at = raw is num ? raw.toInt() : int.tryParse('${raw ?? ''}') ?? 0;
      if (at > 0) {
        openedLocks.add(row);
        continue;
      }
    }
    rows.add(row);
  }
  rows.sort((a, b) => (a['nanos'] as BigInt).compareTo(b['nanos'] as BigInt));
  // Exact hold: peel the stake off the smallest notes. A partly held note
  // stays spendable for the free slice, and a send returns the held part
  // as change. `nanos` is that slice. `gross` is the whole note.
  var left = hold;
  final free = <Map<String, dynamic>>[];
  for (final row in rows) {
    final nanos = row['nanos'] as BigInt;
    if (left <= BigInt.zero) {
      free.add(row);
      continue;
    }
    if (nanos <= left) {
      left -= nanos;
      continue;
    }
    free.add({
      'i': row['i'],
      'nanos': nanos - left,
      'gross': nanos,
      'held': left,
      'addr': row['addr'],
    });
    left = BigInt.zero;
  }
  free.addAll(openedLocks);
  free.sort((a, b) => (b['nanos'] as BigInt).compareTo(a['nanos'] as BigInt));
  final freeSum = free.fold<BigInt>(
    BigInt.zero,
    (s, r) => s + (r['nanos'] as BigInt),
  );
  return SpendablePool(free, freeSum, rows.isEmpty);
}

BigInt _heldOfRow(Map<String, dynamic> row) {
  final held = row['held'];
  if (held is BigInt && held > BigInt.zero) return held;
  final gross = row['gross'];
  final nanos = row['nanos'];
  if (gross is BigInt && nanos is BigInt && gross > nanos) return gross - nanos;
  return BigInt.zero;
}

/// Pay and change for one note. A positive hold returns whole as change.
/// A max pay that leaves the levy no room takes the levy out of the pay.
({BigInt pay, BigInt change}) holdProtectedPay({
  required BigInt noteNanos,
  required BigInt payNanos,
  required BigInt feeNanos,
  required BigInt heldNanos,
}) {
  var held = heldNanos;
  if (held < BigInt.zero) held = BigInt.zero;
  if (held > noteNanos) held = noteNanos;
  final room = noteNanos - held;
  final fee = feeNanos < BigInt.zero ? BigInt.zero : feeNanos;
  var pay = payNanos < BigInt.zero ? BigInt.zero : payNanos;
  if (pay > room) pay = room;
  if (held > BigInt.zero && pay + fee > room) {
    final over = pay + fee - room;
    pay = over >= pay ? BigInt.zero : pay - over;
  }
  var change = noteNanos - pay - fee;
  if (change < BigInt.zero) change = BigInt.zero;
  return (pay: pay, change: change);
}

/// Genesis-anchored aserti3-2d. Same numbers as crypto/asert.js.
const int kAsertTargetMs = 90000;
const int kAsertHalflifeMs = 2 * 60 * 60 * 1000;
const int kAsertBitsScale = 65536;
const int kAsertLiveMinBits = 4;
const int kAsertMaxBits = 256;
const int kGenesisBits = 17;
const int kGenesisBitsPacked = kGenesisBits * kAsertBitsScale;

class AsertQuote {
  const AsertQuote({
    required this.ok,
    required this.packed,
    this.eased = 0,
    this.easeBits = 0,
  });
  final bool ok;
  final int packed;
  final int eased;
  final double easeBits;
}

/// chain.js isPackedBits. A wire word below the Q16.16 scale is not packed.
bool isPackedBits(int bits) => bits >= kAsertBitsScale;

/// chain.js unpackBits. The live floor and ceiling clamp the unpacked value.
double unpackBits(int packed) {
  if (packed <= 0) return kGenesisBits.toDouble();
  if (packed <= kAsertMaxBits) {
    final n = packed.toDouble();
    if (n < kAsertLiveMinBits) return kAsertLiveMinBits.toDouble();
    if (n > kAsertMaxBits) return kAsertMaxBits.toDouble();
    return n;
  }
  if (packed < kAsertBitsScale) return kAsertMaxBits.toDouble();
  final fp = packed / kAsertBitsScale;
  if (fp < kAsertLiveMinBits) return kAsertLiveMinBits.toDouble();
  if (fp > kAsertMaxBits) return kAsertMaxBits.toDouble();
  return fp;
}

/// chain.js headerLinkReason bits gate: packed word, ASERT quote, then the
/// unpacked live range.
bool consensusBitsOk(int bits, AsertQuote quote) {
  if (!isPackedBits(bits) || !bitsAcceptAsert(bits, quote)) return false;
  final fp = unpackBits(bits);
  return fp >= kAsertLiveMinBits && fp <= kAsertMaxBits;
}

/// Consensus block work. Same quantity as crypto/asert.js blockWorkBig:
/// 2 raised to the unpacked bit difficulty.
BigInt blockWork(int bits) {
  final fp = unpackBits(bits);
  if (!fp.isFinite || fp <= 0) return BigInt.one;
  final whole = fp.floor();
  final frac = fp - whole;
  final scale = BigInt.from((math.pow(2, frac) * math.pow(2, 48)).round());
  return ((BigInt.one << whole) * scale) >> 48;
}

/// Same window as crypto/asert.js bitsAcceptAsert. Exact packed bits, or any
/// packed word in [eased, packed] when own-timestamp emergency ease applies.
bool bitsAcceptAsert(int got, AsertQuote quote) {
  if (!quote.ok) return false;
  if (quote.easeBits > 0) return got <= quote.packed && got >= quote.eased;
  return got == quote.packed;
}

BigInt _divRoundNearest(BigInt numer, BigInt denom) {
  final neg = numer.isNegative;
  final abs = neg ? -numer : numer;
  final q = (abs + (denom ~/ BigInt.two)) ~/ denom;
  return neg ? -q : q;
}

/// Exact packed quote. [parentTimeMs] opens the same emergency ease window
/// as crypto/asert.js asertNextBits.
AsertQuote asertQuoteForHeight({
  required int anchorTimeMs,
  required int blockTimeMs,
  required int blockHeight,
  int anchorHeight = 1,
  int anchorBits = kGenesisBitsPacked,
  int? parentTimeMs,
}) {
  if (anchorTimeMs <= 0 || blockTimeMs <= 0 || blockHeight <= anchorHeight) {
    return const AsertQuote(ok: false, packed: 0);
  }
  final numer =
      BigInt.from(blockHeight - anchorHeight) * BigInt.from(kAsertTargetMs) -
      BigInt.from(blockTimeMs - anchorTimeMs);
  final deltaQ = _divRoundNearest(
    numer * BigInt.from(kAsertBitsScale),
    BigInt.from(kAsertHalflifeMs),
  );
  final minQ = BigInt.from(kAsertLiveMinBits * kAsertBitsScale);
  final maxQ = BigInt.from(kAsertMaxBits * kAsertBitsScale);
  var next = BigInt.from(anchorBits) + deltaQ;
  if (next < minQ) next = minQ;
  if (next > maxQ) next = maxQ;
  var eased = next;
  var easeBits = 0.0;
  if (parentTimeMs != null) {
    final gap = blockTimeMs - parentTimeMs;
    final trigger = 8 * kAsertTargetMs;
    if (gap > trigger) {
      final raw = math.log(gap / trigger) / math.ln2;
      easeBits = raw < 0 ? 0 : (raw > 2 ? 2 : raw);
      var easedQ = next - BigInt.from((easeBits * kAsertBitsScale).round());
      if (easedQ < minQ) easedQ = minQ;
      eased = easedQ;
    }
  }
  return AsertQuote(
    ok: true,
    packed: next.toInt(),
    eased: eased.toInt(),
    easeBits: easeBits,
  );
}

/// Largest-first, then batches of [kMaxInputsPerSend]. Stored amounts only.
/// Same note gate as the Spendable figure. Production calls this from [Isolate.run].
Map<String, dynamic> selectSpendNotesWire(Map<String, dynamic> input) {
  final stamp = identityHashCode(Isolate.current).toString();
  final need = input['needNanos'] != null
      ? _nanosFromAmountField(input['needNanos'])
      : _sheToNanos(input['needShe']);
  final memo = input['memo'] == true;
  final outputs = (input['outputs'] as num?)?.toInt() ?? 3;
  final measured = measuredInputCap(
    outputs: outputs < 1 ? 1 : outputs,
    memo: memo,
  );
  final asked = (input['cap'] as num?)?.toInt();
  final cap = (asked == null || asked < 1 || asked > measured)
      ? measured
      : asked;
  final pool = poolSpendableNotes(input);
  final free = pool.free;
  final freeSum = pool.freeSum;
  final batches = <Map<String, dynamic>>[];
  var remaining = need;
  var cursor = 0;
  var feeSum = BigInt.zero;
  while (remaining > BigInt.zero && cursor < free.length) {
    final taken = <Map<String, dynamic>>[];
    var sum = BigInt.zero;
    while (cursor < free.length && taken.length < cap) {
      final row = free[cursor];
      taken.add(row);
      sum += row['nanos'] as BigInt;
      cursor++;
      final fee = BigInt.from(
        estimateSendLevyUnits(
          inputs: taken.length,
          outputs: outputs,
          memo: memo,
        ),
      );
      final heldBack = taken.fold<BigInt>(
        BigInt.zero,
        (s, r) => s + _heldOfRow(r),
      );
      if (sum >= remaining + fee) break;
      // The stake stays change. A max send of the free slice is still covered.
      if (heldBack > BigInt.zero && sum >= remaining && fee < sum) break;
    }
    final fee = BigInt.from(
      estimateSendLevyUnits(inputs: taken.length, outputs: outputs, memo: memo),
    );
    final heldBack = taken.fold<BigInt>(
      BigInt.zero,
      (s, r) => s + _heldOfRow(r),
    );
    final BigInt pay;
    if (heldBack > BigInt.zero) {
      final split = holdProtectedPay(
        noteNanos: sum + heldBack,
        payNanos: remaining,
        feeNanos: fee,
        heldNanos: heldBack,
      );
      if (split.pay <= BigInt.zero) {
        return {
          'stamp': stamp,
          'covered': false,
          'empty': false,
          'shortFee': true,
          'batches': batches,
          'feeShe': _sheOfNanos(feeSum + fee),
          'spendableNanos': freeSum.toString(),
        };
      }
      pay = split.pay;
    } else {
      final room = sum - fee;
      if (room <= BigInt.zero) {
        return {
          'stamp': stamp,
          'covered': false,
          'empty': false,
          'shortFee': true,
          'batches': batches,
          'feeShe': _sheOfNanos(feeSum + fee),
          'spendableNanos': freeSum.toString(),
        };
      }
      pay = room < remaining ? room : remaining;
    }
    batches.add({
      'pay': _sheOfNanos(pay),
      'payNanos': pay.toString(),
      'feeShe': _sheOfNanos(fee),
      'notes': [
        for (final r in taken)
          {
            'index': r['i'],
            'dest': r['addr'],
            'she': _sheOfNanos(r['nanos'] as BigInt),
            'nanos': (r['nanos'] as BigInt).toString(),
          },
      ],
    });
    feeSum += fee;
    // The fee came out of the requested pay so the stake stays whole.
    // That reduced payment is the whole send.
    if (heldBack > BigInt.zero && pay < remaining) {
      remaining = BigInt.zero;
    } else {
      remaining -= pay;
    }
  }
  final covered = remaining <= BigInt.zero && batches.isNotEmpty;
  // Notes can cover the payment and still miss the weight levy. That is a
  // fee failure, not an empty book.
  final shortFee = !covered && free.isNotEmpty && freeSum >= need;
  return {
    'stamp': stamp,
    'covered': covered,
    'empty': pool.noPlain,
    'shortFee': shortFee,
    'batches': batches,
    'feeShe': _sheOfNanos(feeSum),
    'spendableNanos': freeSum.toString(),
  };
}

/// The frame-timing child sets this. flutter test injects FLUTTER_TEST into
/// every process it spawns, which would take the caller shortcut. Production
/// never sets the flag.
bool _flowOffUiForced() => Platform.environment['SHEAR_FLOW_OFF_UI'] == '1';

bool _flowCryptoOnCaller() =>
    !_flowOffUiForced() &&
    (sealFlowOnCaller ||
        debugFlowCryptoOnCaller ||
        debugNativeSealNote != null ||
        Platform.environment['FLUTTER_TEST'] == 'true');

/// Counts ledger, sync, and proof work that still runs on the UI isolate.
int debugUiHeavyCount = 0;

/// Isolate that last ran [ShearLedger.followOffUi]'s body. Differs from the UI isolate.
String debugCreditFollowStamp = '';

/// Isolate that last ran [scanSealedWire] inside that follow. Copied back
/// onto the caller so a widget test can see it. Differs from the UI isolate.
String debugScanIsolateStamp = '';

/// `balances` or `credits`, from the worker that ran the real sync method.
String debugCreditFollowKind = '';

/// Kinds returned to this isolate, in order. Tests read the Apply entry.
final List<String> debugCreditFollowKinds = <String>[];

/// Worker stamps paired with [debugCreditFollowKinds].
final List<String> debugCreditFollowStamps = <String>[];

/// Keys of the last [followOffUi] payload. A session follow must not carry
/// `notes` — encoding that book on the UI isolate is the Verifying hang.
List<String> debugLastFollowSpecKeys = <String>[];

/// Keys the worker returned. Unlock Verifying must not bring the book back.
List<String> debugLastFollowResultKeys = <String>[];

/// How many credit follows have returned to this isolate.
int debugCreditFollowRuns = 0;

/// Last notes-read failure from the worker, empty when the list came back.
String debugCollateError = '';

Object? _followEncode(Object? v) {
  if (v == null || v is num || v is String || v is bool) return v;
  if (v is Uint8List) return <String, String>{'__b64': base64Encode(v)};
  if (v is Map) {
    return <String, Object?>{
      for (final e in v.entries) e.key.toString(): _followEncode(e.value),
    };
  }
  if (v is Iterable) {
    return <Object?>[for (final item in v) _followEncode(item)];
  }
  return v.toString();
}

Object? _followRevive(Object? v) {
  if (v is Map && v.length == 1 && v['__b64'] is String) {
    return base64Decode(v['__b64'] as String);
  }
  if (v is Map) {
    return <String, dynamic>{
      for (final e in v.entries) e.key.toString(): _followRevive(e.value),
    };
  }
  if (v is List) return <Object?>[for (final item in v) _followRevive(item)];
  return v;
}

Map<String, double> _followDoubles(Object? raw) {
  final out = <String, double>{};
  if (raw is! Map) return out;
  for (final e in raw.entries) {
    final n = e.value;
    if (n is num) out[e.key.toString()] = n.toDouble();
  }
  return out;
}

Map<String, int> _followInts(Object? raw) {
  final out = <String, int>{};
  if (raw is! Map) return out;
  for (final e in raw.entries) {
    final n = e.value;
    if (n is num) out[e.key.toString()] = n.toInt();
  }
  return out;
}

/// Tip, balance, notes, and history run here. The UI isolate only adopts the
/// book the worker already collated.
Future<Map<String, dynamic>> _bookFromSession(Map<String, dynamic> spec) async {
  final path = spec['sessionPath']?.toString() ?? '';
  final password = spec['sessionPassword']?.toString() ?? '';
  if (path.isEmpty || password.isEmpty) return spec;
  final file = File(path);
  if (!file.existsSync()) return spec;
  final raw = jsonDecode(file.readAsStringSync());
  if (raw is! Map) return spec;
  final opened = await openSessionEnvelope(
    Map<String, dynamic>.from(raw),
    password,
  );
  final plain = opened['plain'];
  if (plain is! Map) return spec;
  final j = scrubStaleBookCache(Map<String, dynamic>.from(plain));
  return <String, dynamic>{
    ...spec,
    if (j['seedHex'] != null) 'seedHex': j['seedHex'],
    if (j['address'] != null) 'address': j['address'],
    if (j['viewKey'] != null) 'viewKey': j['viewKey'],
    if (j['paymentCode'] != null) 'paymentCode': j['paymentCode'],
    'dests': j['dests'] ?? spec['dests'],
    'txs': j['txs'] ?? const <dynamic>[],
    // A session that has not remembered a tip stores 0. That is not a rewind
    // of the live book the UI already sealed.
    'sealed': () {
      final sessionSealed = (j['sealedHeight'] as num?)?.toInt() ?? 0;
      final specSealed = (spec['sealed'] as num?)?.toInt() ?? 0;
      return sessionSealed > specSealed ? sessionSealed : specSealed;
    }(),
    'destCount': j['destCount'] ?? spec['destCount'],
    'destIndex': j['destIndex'] ?? spec['destIndex'],
    'openedProofs': () {
      final merged = <String, String>{
        ...proofCacheMap(j['openedProofs']),
        ...proofCacheMap(spec['openedProofs']),
      };
      return <Map<String, dynamic>>[
        for (final e in merged.entries) {'k': e.key, 'n': e.value},
      ];
    }(),
    if (j['notes'] is List && (j['notes'] as List).isNotEmpty)
      'notes': j['notes'],
    'notesCovered': () {
      final sessionCovered = (j['notesCovered'] as num?)?.toInt() ?? 0;
      final specCovered = (spec['notesCovered'] as num?)?.toInt() ?? 0;
      return sessionCovered > specCovered ? sessionCovered : specCovered;
    }(),
  };
}

/// Tip, balance, notes, and history run here. The UI isolate only adopts the
/// book the worker already collated.
Future<void> creditFollowEntry(List<dynamic> args) async {
  armWalletConnect();
  var specJson = args.isEmpty ? '' : args[0]?.toString() ?? '';
  final port = args.length > 1 ? args[1] : null;
  if (port is! SendPort) return;
  try {
    final decoded = jsonDecode(specJson);
    if (decoded is Map) {
      final spec = Map<String, dynamic>.from(decoded);
      armLocalRpcFromSpec(spec);
      specJson = jsonEncode(spec);
    } else {
      localRpcToken = null;
      localRpcPort = null;
    }
    final out = await creditFollowWorker(specJson, port);
    port.send(<String, dynamic>{
      'event': 'done',
      'out': out,
      'connectPinned': walletConnect != null,
    });
  } catch (e) {
    port.send(<String, dynamic>{
      'event': 'error',
      'message': e.toString(),
      'connectPinned': walletConnect != null,
    });
  }
}

Future<Map<String, dynamic>> creditFollowWorker(
  String specJson, [
  SendPort? partials,
]) async {
  var spec = jsonDecode(specJson) as Map<String, dynamic>;
  spec = await _bookFromSession(spec);
  spec.remove('sessionPassword');
  var base = spec['baseUrl']?.toString() ?? '';
  final spendableFirst = spec['spendableFirst'] == true;
  // Unlock often runs before the UI has a live base. Android has no local
  // node, so the worker asks the public book itself. The UI isolate stays free.
  final ownNode = spec['ownNode'] == true;
  final publicConsent = spec['publicConsent'] == true;
  if (ownNode && base.isNotEmpty) {
    final accepted = await acceptOwnNodeUrl(base);
    base = accepted ?? '';
  }
  if (spendableFirst &&
      creditFollowProbesPublic(
        ownNode: ownNode,
        base: base,
        publicConsent: publicConsent,
      )) {
    final seeds = <String>[
      for (final s in (spec['nodeSeeds'] as List?) ?? const <dynamic>[])
        s.toString(),
    ];
    base = await firstLiveNodeSeed(
      seeds.isEmpty ? kPublicNodeSeeds : seeds,
      publicConsent: true,
    );
  }
  // A dead port must not hold the lock screen. A real TLS notes read still
  // has to finish; 400ms dropped every phone handshake and left spendable at 0.
  final workerHttp = spendableFirst
      ? (HttpClient()
          ..connectionTimeout = const Duration(seconds: 4)
          ..idleTimeout = const Duration(seconds: 8))
      : null;
  if (workerHttp != null) {
    pinWalletHttp(workerHttp, allowPublic: () => publicConsent);
  }
  final pool = base.isEmpty
      ? null
      : ShearPoolClient(baseUrl: base, http: workerHttp);
  if (pool != null && ownNode) {
    pool.useOwnNode(base);
  }
  if (pool != null && publicConsent) pool.publicConsent = true;
  final ledger = ShearLedger(pool: pool);
  ledger._stampSpendTagsInline = true;
  ledger.bluScanInline = true;
  ledger._v3HashInline = true;
  final sessionPath = spec['sessionPath']?.toString() ?? '';
  final headerStore = verifiedHeaderStorePath(sessionPath);
  if (headerStore.isNotEmpty) ledger.bindHeaderStore(headerStore);
  try {
    ledger.installCreditFollow(spec);
    final rest = spec['restFrame']?.toString() ?? '';
    final code = spec['paymentCode']?.toString();
    if (rest.isNotEmpty) {
      ledger.recheckRestFrameSpendable(rest, paymentCode: code);
    }
    final full = spec['full'] == true;
    final chain = spec['chain'] != false;
    // Login's first population. One stats read for the confirmation height,
    // then notes whose proofs open. The node's /balance is not a coin and is
    // not copied into the sum. No history and no block body.
    final opened = spendableFirst
        ? await ledger.populateSpendableFromNode(
            rest,
            paymentCode: (code == null || code.isEmpty) ? null : code,
            partials: partials,
          )
        : !chain
        ? ledger.recheckRestFrameSpendable(
            rest,
            paymentCode: (code == null || code.isEmpty) ? null : code,
          )
        : full
        ? await ledger.syncCredits(rest, paymentCode: code, partials: partials)
        : await ledger.syncBalancesOnly(
            rest,
            paymentCode: code,
            also: [
              for (final d in (spec['uiDests'] as List?) ?? const <dynamic>[])
                d.toString(),
            ],
          );
    final out = ledger.exportCreditFollow(
      restFrame: rest,
      paymentCode: code,
      full: spendableFirst || (full && chain),
    );
    if (spendableFirst) {
      // Notes whose proofs opened come back. The worker did not sync history
      // or block bodies. An empty tx list must not wipe the UI book.
      out.remove('txs');
      out.remove('nodeBodies');
      out.remove('nodeHistory');
      out.remove('nodeNotes');
    } else if (!chain || !full) {
      // Verify only rechecks coins already on the UI book. A balance follow
      // never loaded history. The session tx list is not that book, and
      // installing it wiped locks the Reserve portal still replays.
      out.remove('txs');
      out.remove('notes');
      out.remove('nodeBodies');
      out.remove('nodeHistory');
      out.remove('nodeNotes');
    }
    out['stamp'] = identityHashCode(Isolate.current).toString();
    out['scanStamp'] = debugScanIsolateStamp;
    out['kind'] = spendableFirst
        ? 'spendable'
        : !chain
        ? 'verify'
        : (full ? 'credits' : 'balances');
    out['opened'] = opened;
    return out;
  } finally {
    pool?.close();
  }
}

void noteUiHeavy(String label) {
  debugUiHeavyCount += 1;
}

/// Stamp of this isolate. [sealSignReserveWire] returns the worker's stamp.
final String reserveIsolateStamp =
    '${identityHashCode(Isolate.current)}-${DateTime.now().microsecondsSinceEpoch}';

/// How many reserve seals [Isolate.run] has returned to this isolate.
int debugReserveIsolateRuns = 0;

/// Stamp from the last reserve seal. Differs from [reserveIsolateStamp]
/// when the seal ran in [Isolate.run].
String debugReserveOffIsolateStamp = '';

/// Seal Flow vouts (range proof + admit pub). Production sends call this
/// via [Isolate.run] so the UI isolate can keep pumping frames.
Map<String, dynamic> sealFlowSpendVouts(Map<String, dynamic> input) {
  final spendSeed = input['spendSeed'] as Uint8List;
  final destTo = (input['destTo'] as String?) ?? '';
  final src = (input['src'] as String?) ?? '';
  final changeDest = input['changeDest'] as String?;
  final fallbackBase = input['admitBase'] as Uint8List?;
  final spec = <Map<String, dynamic>>[
    for (final raw in (input['vouts'] as List? ?? const []))
      if (raw is Map) Map<String, dynamic>.from(raw),
  ];
  final sealed = <Map<String, dynamic>>[];
  for (final o in spec) {
    final kind = (o['kind'] as String?) ?? 'send';
    if (kind == 'dummy') {
      var note = nativeSealNote(0, dest20: randomBytes(20), kind: 'dummy');
      note = attachAdmitPub(note);
      sealed.add(note);
      continue;
    }
    final addr = (o['address'] as String?) ?? destTo;
    final self =
        addr.isNotEmpty &&
        (addr == src || (changeDest != null && addr == changeDest));
    if (!self && !isPayableDest(addr)) {
      throw StateError(kErrShortSsa1);
    }
    final units = tryU64Units(o['nanos']) ?? BigInt.zero;
    final d20 = hash20FromAddress(addr);
    var note = nativeSealUnits(units, dest20: d20, kind: kind);
    if (addr.isNotEmpty) note['address'] = addr;
    final opened = admitBaseFromAddress(addr);
    final baseOk = opened != null && opened.length == 32 && isPayableDest(addr);
    // Consensus needs rEph/rCt/amtCt on every hidden output, change included.
    final B = baseOk
        ? opened
        : (self ? (fallbackBase ?? admitBaseBytes(spendSeed)) : null);
    if (B == null) throw StateError(kErrShortSsa1);
    note = attachAdmitPub(note, admitBase: pointFrom(B), v: units);
    sealed.add(note);
  }
  return {'vouts': sealed};
}

/// One FS-1 spend of every input of a send ([proveFs1SpendWire]). Same
/// off-isolate rule as [sealFlowSpendVouts].
// dart format off
Map<String, dynamic> reproveFlowSpendWire(Map<String, dynamic> input) => proveFs1SpendWire(input);
// dart format on

/// Stamp from the worker, including when [sealFlowSpendVouts] throws.
Map<String, dynamic> _sealFlowStamped(Map<String, dynamic> input) {
  final stamp = identityHashCode(Isolate.current).toString();
  try {
    final out = sealFlowSpendVouts(input);
    out['stamp'] = stamp;
    return out;
  } catch (e) {
    return {
      'stamp': stamp,
      'error': e is StateError ? e.message : e.toString(),
    };
  }
}

/// Stamp from the worker, including when [reproveFlowSpendWire] throws.
Map<String, dynamic> _proveFlowStamped(Map<String, dynamic> input) {
  final stamp = identityHashCode(Isolate.current).toString();
  try {
    final out = reproveFlowSpendWire(input);
    out['stamp'] = stamp;
    return out;
  } catch (e) {
    return {
      'stamp': stamp,
      'error': e is StateError ? e.message : e.toString(),
    };
  }
}

Map<String, dynamic> _takeOffUi(
  Map<String, dynamic> out,
  void Function(String) stamp,
) {
  stamp(out['stamp']?.toString() ?? '');
  final err = out['error'];
  if (err != null) throw StateError(err.toString());
  return out;
}

Future<Map<String, dynamic>> _sealFlowOffUi(Map<String, dynamic> input) {
  if (_flowCryptoOnCaller()) {
    noteUiHeavy('seal');
    debugSendSealStamp = identityHashCode(Isolate.current).toString();
    return Future<Map<String, dynamic>>.value(sealFlowSpendVouts(input));
  }
  // dart format off
  return Isolate.run(() => _sealFlowStamped(input))
      .then((out) => _takeOffUi(out, (s) => debugSendSealStamp = s));
  // dart format on
}

Future<Map<String, dynamic>> _proveFlowOffUi(Map<String, dynamic> input) {
  if (_flowCryptoOnCaller()) {
    noteUiHeavy('prove');
    debugSendProveStamp = identityHashCode(Isolate.current).toString();
    return Future<Map<String, dynamic>>.value(reproveFlowSpendWire(input));
  }
  // dart format off
  return Isolate.run(() => _proveFlowStamped(input))
      .then((out) => _takeOffUi(out, (s) => debugSendProveStamp = s));
  // dart format on
}

/// Same hops [_sendManyNotes] uses. A caller-side seal or prove is the test shortcut.
Future<Map<String, dynamic>> sealFlowOffUi(Map<String, dynamic> input) =>
    _sealFlowOffUi(input);

Future<Map<String, dynamic>> proveFlowOffUi(Map<String, dynamic> input) =>
    _proveFlowOffUi(input);

/// Ed25519 or stealth sign of a spend message. Pure. No native prover.
Map<String, dynamic> signSpendWire(Map<String, dynamic> input) {
  final stamp = identityHashCode(Isolate.current).toString();
  final spendSeed = input['spendSeed'] as Uint8List;
  final msg = input['message'] as Uint8List;
  final shared = input['shared'] is Uint8List
      ? input['shared'] as Uint8List
      : null;
  final Uint8List sig;
  final Uint8List pub;
  if (shared != null) {
    sig = stealthSign(spendSeed, shared, msg);
    pub = stealthTweakPub(ed25519PublicFromSeed(spendSeed), shared);
  } else {
    sig = ed25519Sign(spendSeed, msg);
    pub = ed25519PublicFromSeed(spendSeed);
  }
  return {'sig': sig, 'pub': pub, 'stamp': stamp};
}

/// flutter_tester does not finish [Isolate.run] inside one pumped frame, so
/// plate tests sign on the caller. Production leaves FLUTTER_TEST unset and
/// signs off the UI isolate. [SHEAR_FLOW_OFF_UI] forces that off-UI path.
/// Signing does not start the native prover.
bool _signOnCaller() =>
    !_flowOffUiForced() && Platform.environment['FLUTTER_TEST'] == 'true';

Future<Map<String, dynamic>> signSpendOffUi(Map<String, dynamic> input) {
  if (_signOnCaller()) {
    noteUiHeavy('sign');
    final out = signSpendWire(input);
    debugSendSignStamp = out['stamp']?.toString() ?? '';
    return Future<Map<String, dynamic>>.value(out);
  }
  final savedSeal = debugNativeSealNote;
  return Isolate.run(() => signSpendWire(input)).then((out) {
    debugSendSignStamp = out['stamp']?.toString() ?? '';
    if (debugNativeSealNote == null && savedSeal != null)
      debugNativeSealNote = savedSeal;
    return out;
  });
}

/// Hexify a Flow post body inside the worker. Vin, vout, and the admit proof
/// are byte-heavy; the UI isolate only sends them and posts the result.
List<Map<String, dynamic>> _flowRows(dynamic raw) {
  if (raw is! List) return const [];
  return [
    for (final row in raw)
      if (row is Map) Map<String, dynamic>.from(row),
  ];
}

Map<String, dynamic> flowPostHex(Map<String, dynamic> raw) {
  final proofs = raw['admitProofs'];
  final listed = proofs is List
      ? _flowRows(proofs)
      : <Map<String, dynamic>>[
          if (raw['admitProof'] is Map)
            Map<String, dynamic>.from(raw['admitProof'] as Map),
        ];
  final body = postedFlowBody(
    vin: _flowRows(raw['vin']),
    vout: _flowRows(raw['vout']),
    proofs: listed,
  );
  return <String, dynamic>{
    'vin': List<dynamic>.from(_hexify(body['vin']) as List? ?? const []),
    'vout': List<dynamic>.from(_hexify(body['vout']) as List? ?? const []),
    'admitProof': body['admitProof'] is Map
        ? _hexify(body['admitProof'])
        : null,
    if (proofs is List)
      'admitProofs': _hexify(
        body['admitProofs'] ?? const <Map<String, dynamic>>[],
      ),
  };
}

Future<Map<String, dynamic>> flowPostHexOffUi(Map<String, dynamic> raw) {
  // flutter_tester's second Isolate.run nulls these closure hooks on the
  // caller. A neighbouring int static stays, so the library is not reloaded.
  // The next seal would then run the real range proof on this isolate.
  // Production leaves the hooks null and still hexes off the UI isolate.
  if (debugNativeSealNote != null) {
    return Future<Map<String, dynamic>>.value(flowPostHex(raw));
  }
  return Isolate.run(() => flowPostHex(raw));
}

/// commit|R|z. A swapped proof does not reuse another note's nanos.
String? proofCacheKey(Map o) {
  final commit = _noteBytes(o['commit']);
  final vp = o['valueProof'];
  if (commit == null || vp is! Map) return null;
  final r = _noteBytes(vp['R']);
  final z = _noteBytes(vp['Z'] ?? vp['z']);
  if (r == null || z == null) return null;
  return '${_bytesHex(commit)}|${_bytesHex(r)}|${_bytesHex(z)}';
}

/// Exact opened nanos, as digits. A digit string stays exact through 2^64-1.
/// A double is kept only while it is an integer at or below 2^53-1.
/// Dart's int cannot name every u64, so this does not return an int.
String? sessionProofNanos(Object? n) {
  if (n is String && RegExp(r'^\d+$').hasMatch(n)) {
    final b = BigInt.tryParse(n);
    if (b == null || b <= BigInt.zero || b.bitLength > 64) return null;
    return b.toString();
  }
  if (n is int) {
    if (n <= 0) return null;
    return n.toString();
  }
  if (n is double) {
    if (!n.isFinite || n <= 0 || n > _kSafeDoubleNanos) return null;
    final rounded = n.round();
    if (rounded.toDouble() != n) return null;
    return rounded.toString();
  }
  return null;
}

/// SHE for a proof nanos string. Absent when the count is not an exact double.
double? _sheOfExactNanos(String digits) {
  final b = BigInt.parse(digits);
  if (b > BigInt.from(_kSafeDoubleNanos)) return null;
  final scaled = b.toDouble() / kUnitsPerShe;
  if (!scaled.isFinite || scaled <= 0) return null;
  return scaled;
}

/// Opened-proof rows kept in the session. `n` is a digit string so a later
/// JSON load does not round a u64 through a double.
List<Map<String, dynamic>> sessionOpenedProofRows(Object? raw) {
  if (raw is! List) return const [];
  final out = <Map<String, dynamic>>[];
  for (final row in raw) {
    if (row is! Map) continue;
    final k = row['k']?.toString() ?? '';
    final n = sessionProofNanos(row['n'] ?? row['nanos']);
    if (k.isEmpty || n == null) continue;
    out.add({'k': k, 'n': n.toString()});
  }
  return out;
}

/// Session rows `{k, n}` or a map of key to nanos. `{v}`-only has no key.
Map<String, String> proofCacheMap(Object? raw) {
  final out = <String, String>{};
  if (raw is Map) {
    for (final e in raw.entries) {
      final v = e.value;
      final n = sessionProofNanos(v is Map ? (v['n'] ?? v['nanos']) : v);
      if (n != null) out[e.key.toString()] = n;
    }
  } else if (raw is List) {
    for (final row in sessionOpenedProofRows(raw)) {
      final n = sessionProofNanos(row['n']);
      if (n != null) out[row['k'] as String] = n;
    }
  }
  return out;
}

/// Rows whose commit this wallet has already accepted. A new block opens only
/// the rest. [known] is commit hex.
List<dynamic> notesNotYetAccepted(List<dynamic> rows, Set<String> known) {
  if (known.isEmpty) return rows;
  final fresh = <dynamic>[];
  for (final row in rows) {
    if (row is! Map) {
      fresh.add(row);
      continue;
    }
    final commit = _noteBytes(row['commit']);
    if (commit != null &&
        commit.isNotEmpty &&
        known.contains(_bytesHex(commit))) {
      continue;
    }
    fresh.add(row);
  }
  return fresh;
}

/// How many note rows the last progressive scan actually opened. Accepted
/// commits stay at 0.
int debugNotesOpenedThisScan = 0;

/// Hexify the scan snapshot inside the worker, then scan. The caller sends
/// the raw snapshot; the JSON clone does not run on the UI isolate.
/// [openedProofs] stays on the snapshot so an already opened proof is not
/// opened again.
Map<String, dynamic> scanSealedWire(Map<String, dynamic> raw) {
  debugScanIsolateStamp = identityHashCode(Isolate.current).toString();
  return scanSealedVouts(<String, dynamic>{
    'vouts': _hexify(raw['vouts']),
    'dests': List<String>.from(raw['dests'] as List? ?? const []),
    'dest': raw['dest'],
    'spendSeed': raw['spendSeed'],
    'seenCommitHex': List<String>.from(
      raw['seenCommitHex'] as List? ?? const [],
    ),
    'txHints': _hexify(raw['txHints']),
    'prev': raw['prev'],
    'startIndex': raw['startIndex'],
    if (raw.containsKey('openedProofs')) 'openedProofs': raw['openedProofs'],
  });
}

Future<Map<String, dynamic>> scanSealedWireOffUi(Map<String, dynamic> raw) {
  return Isolate.run(() => scanSealedWire(raw));
}

/// Pure CPU scan of compacted vouts. Full-sync calls this via [Isolate.run].
/// Returns `{notes, hashFolds}` maps — no ledger mutation.
/// Copy tx-level portalId and withdrawNonce onto each output. A mined
/// withdraw keeps those on the tx. A leaf-vote is marked so the scan can
/// try fee-note commits. Nothing here is written back to the chain.
List<Map<String, dynamic>> stampChainScanVouts(List<dynamic> txs) {
  final out = <Map<String, dynamic>>[];
  for (final raw in txs) {
    if (raw is! Map) continue;
    final kind = (raw['kind'] ?? '').toString();
    final portal = raw['portalId'];
    final nonce = raw['withdrawNonce'];
    for (final key in const ['vout', 'vouts', 'notes']) {
      final list = raw[key];
      if (list is! List) continue;
      for (final item in list) {
        if (item is! Map) continue;
        final row = Map<String, dynamic>.from(item);
        final havePortal = (row['portalId'] ?? '').toString();
        if (havePortal.isEmpty && portal != null && portal.toString().isNotEmpty) {
          row['portalId'] = portal;
        }
        if (_noteBytes(row['withdrawNonce']) == null && nonce != null) {
          row['withdrawNonce'] = nonce;
        }
        if (kind.isNotEmpty) row['scanTxKind'] = kind;
        out.add(row);
      }
    }
  }
  return out;
}

List<Uint8List> _feeCandidates(Map<String, dynamic> input, List<dynamic> vouts) {
  final out = <Uint8List>[];
  final seen = <String>{};
  void add(dynamic raw) {
    final b = _noteBytes(raw);
    if (b == null || b.length < 32) return;
    final one = Uint8List.fromList(b.sublist(0, 32));
    if (!seen.add(_bytesHex(one))) return;
    out.add(one);
  }
  final extra = input['feeCommits'];
  if (extra is List) {
    for (final row in extra) {
      add(row);
    }
  }
  for (final raw in vouts) {
    if (raw is Map) add(raw['commit']);
  }
  return out;
}

/// Floor of the lock-change index scan. Indices 0 through this one are always tried.
const kLockIndexFloor = 63;

/// Consecutive unused indices after the highest used lock index. The scan
/// stops once it is past the floor and this many indices past that high-water mark.
const kLockIndexGap = 8;

/// Last lock-change index to try, inclusive. Always at least [kLockIndexFloor].
/// Walks upward because indices are allocated in order. A hit resets the gap.
int lockChangeIndexEnd({
  Uint8List? spendSeed,
  Iterable<int> noteIndices = const [],
  Set<String> portalIds = const {},
}) {
  final used = <int>{for (final i in noteIndices) if (i >= 0) i};
  final known = <String>{for (final id in portalIds) id.toLowerCase()};
  var knownHigh = -1;
  for (final n in used) {
    if (n > knownHigh) knownHigh = n;
  }
  var highest = -1;
  var misses = 0;
  var i = 0;
  while (true) {
    var hit = used.contains(i);
    if (!hit && spendSeed != null && spendSeed.length == 32) {
      final id = reservePortalIdFromSeed('', spendSeed, i);
      hit = id != null && known.contains(id.toLowerCase());
    }
    if (hit) {
      highest = i;
      misses = 0;
    } else {
      misses++;
    }
    // A saved note index past the floor is a hit we already know. The gap
    // is counted after that index, not before the walk reaches it.
    if (i >= kLockIndexFloor &&
        i >= knownHigh &&
        misses >= kLockIndexGap &&
        (highest < 0 || i >= highest + kLockIndexGap)) {
      return i;
    }
    i++;
    if (i > 1000000) return highest < 0 ? kLockIndexFloor : highest + kLockIndexGap;
  }
}

/// One-time key for a vout the wallet did not address to a known dest.
/// Payout and withdraw-change need the portal id and the withdraw nonce,
/// which the scan copies off the parent tx. A vote-change is tried against
/// output commits from the same scan. A lock change uses a fresh index key.
(Uint8List, String)? _oneTimeSeedFor(
  Map<String, dynamic> o,
  Uint8List spendSeed, {
  List<Uint8List> feeCommits = const [],
  int lockChangeEnd = kLockIndexFloor,
}) {
  if (spendSeed.length != 32) return null;
  final row20 = _noteBytes(o['dest20']);
  if (row20 == null || row20.length < 20) return null;
  final want = Uint8List.fromList(row20.sublist(0, 20));
  bool hits(Uint8List seed) {
    final d20 = destCommitFromSpendPub(ed25519PublicFromSeed(seed));
    return d20.length >= 20 && noteBytesEq(Uint8List.sublistView(d20, 0, 20), want);
  }
  final portal = (o['portalId'] ?? '').toString();
  final nonce = _noteBytes(o['withdrawNonce']);
  if (portal.isNotEmpty && nonce != null && nonce.length == 32) {
    final pay = withdrawPayoutSeedOf(spendSeed, portal, nonce);
    if (pay != null && hits(pay)) return (pay, 'payout');
    final change = withdrawChangeSeedOf(spendSeed, portal, nonce);
    if (change != null && hits(change)) return (change, 'change');
  }
  final ownFee = _noteBytes(o['feeCommit']);
  if (ownFee != null && ownFee.length >= 32) {
    final vote = voteChangeSeedOf(spendSeed, Uint8List.sublistView(ownFee, 0, 32));
    if (vote != null && hits(vote)) return (vote, 'vote');
  }
  final txKind = (o['scanTxKind'] ?? '').toString();
  if (txKind == 'leaf-vote' || txKind == 'vote') {
    for (final fee in feeCommits) {
      if (fee.length < 32) continue;
      final vote = voteChangeSeedOf(spendSeed, Uint8List.sublistView(fee, 0, 32));
      if (vote != null && hits(vote)) return (vote, 'vote');
    }
  }
  if (txKind == 'lock' && (o['kind'] ?? '').toString() != 'lock') {
    final last = lockChangeEnd < kLockIndexFloor ? kLockIndexFloor : lockChangeEnd;
    for (var i = 0; i <= last; i++) {
      final seed = lockChangeSeedOf(spendSeed, i);
      if (seed != null && hits(seed)) return (seed, 'change');
    }
  }
  if ((o['kind'] ?? '').toString() == 'lock') {
    // Indices 0 through the floor are always tried. A known portal past
    // that floor extends the walk through lockChangeEnd.
    final last = lockChangeEnd < kLockIndexFloor ? kLockIndexFloor : lockChangeEnd;
    for (var i = 0; i <= last; i++) {
      final seed = reservePortalSpendSeed(spendSeed, i);
      if (seed != null && hits(seed)) return (seed, 'lock');
    }
  }
  return null;
}

Map<String, dynamic> scanSealedVouts(Map<String, dynamic> input) {
  final vouts = List<dynamic>.from(input['vouts'] as List? ?? const []);
  final dests = <String>{
    ...List<String>.from(input['dests'] as List? ?? const []),
    if ((input['dest'] as String?)?.isNotEmpty == true) input['dest'] as String,
  };
  final seedRaw = input['spendSeed'];
  final spendSeed = seedRaw is Uint8List
      ? seedRaw
      : Uint8List.fromList(List<int>.from(seedRaw as List));
  final seenHex = <String>{
    ...List<String>.from(input['seenCommitHex'] as List? ?? const []),
  };
  final dest = input['dest'] as String?;
  final prevIn = input['prev'];
  final prev = prevIn == null
      ? null
      : (prevIn is Uint8List
            ? prevIn
            : Uint8List.fromList(List<int>.from(prevIn as List)));
  final startIndex = (input['startIndex'] as num?)?.toInt() ?? 0;
  var voteHere = false;
  for (final raw in vouts) {
    if (raw is! Map) continue;
    final tagged = (raw['scanTxKind'] ?? '').toString();
    if (tagged == 'leaf-vote' || tagged == 'vote') {
      voteHere = true;
      break;
    }
  }
  final feeCommits = voteHere ? _feeCandidates(input, vouts) : const <Uint8List>[];
  final lockChangeEnd = (input['lockChangeEnd'] as num?)?.toInt() ?? kLockIndexFloor;
  final xBase = admitBaseScalar(spendSeed);
  final proofCache = proofCacheMap(input['openedProofs']);
  final notes = <Map<String, dynamic>>[];
  final hashFolds = <Map<String, dynamic>>[];
  final payoutRangeAt = <int, Uint8List?>{};
  final hashFoldAt = <int, Map<String, dynamic>>{};
  var unopenedProofs = 0;
  for (var i = 0; i < vouts.length; i++) {
    final raw = vouts[i];
    if (raw is! Map) continue;
    final o = Map<String, dynamic>.from(raw);
    final nc = _noteBytes(o['noteCommit']);
    final commit = _noteBytes(o['commit']);
    if (nc == null || commit == null) continue;
    String? matched;
    for (final d in dests) {
      final d20 = hash20FromAddress(d);
      if (d20 != null && noteBytesEq(nc, noteCommitOfDest20(d20))) {
        matched = d;
        break;
      }
    }
    if (matched == null && dest != null) {
      final d20 = hash20FromAddress(dest);
      if (d20 != null && noteBytesEq(nc, noteCommitOfDest20(d20)))
        matched = dest;
    }
    if (matched == null) {
      final row20 = _noteBytes(o['dest20']);
      if (row20 != null && row20.length >= 20) {
        final want = Uint8List.fromList(row20.sublist(0, 20));
        for (final d in dests) {
          final d20 = hash20FromAddress(d);
          if (d20 != null && noteBytesEq(d20, want)) {
            matched = d;
            break;
          }
        }
      }
    }
    Uint8List? trialSeed;
    String? trialRole;
    if (matched == null) {
      final trial = _oneTimeSeedFor(
        o,
        spendSeed,
        feeCommits: feeCommits,
        lockChangeEnd: lockChangeEnd,
      );
      if (trial != null) {
        trialSeed = trial.$1;
        trialRole = trial.$2;
        matched = dest ?? (dests.isEmpty ? null : dests.first);
      }
    }
    if (matched == null) continue;
    final commitHex = _bytesHex(commit);
    final admitSeed = trialSeed ?? spendSeed;
    final seenCommit = seenHex.contains(commitHex);
    Uint8List? r = _noteBytes(o['r']);
    final rEph = _noteBytes(o['rEph']);
    final rCt = _noteBytes(o['rCt']);
    if (r == null && rEph != null && rCt != null) {
      try {
        r = unwrapBlind(rEph, rCt, xBase, concatBytes([nc, commit]));
      } catch (_) {
        continue;
      }
    }
    if (r == null) continue;
    var kindName = o['kind'] as String?;
    final proofKeyEarly = proofCacheKey(o);
    final cachedEarly = proofKeyEarly == null
        ? null
        : proofCache[proofKeyEarly];
    // This proof already opened on a previous read. Do not derive admit or
    // open the value again. The wire kind is the one that was sealed.
    if (cachedEarly != null &&
        kindName != null &&
        kindName.isNotEmpty &&
        kindName != 'pot') {
      if (!noteIsFs1Leaf(_noteBytes(o['admitPub']), commit)) continue;
      final amtEarly = _sheOfExactNanos(cachedEarly);
      notes.add({
        'address': matched,
        'dest': matched,
        'kind': kindName,
        'commit': commit,
        'noteCommit': nc,
        'r': r,
        'rEph': rEph,
        'rCt': rCt,
        'admitPub': _noteBytes(o['admitPub']),
        'prev': _noteBytes(o['prev']) ?? prev ?? Uint8List(32),
        'index': (o['index'] as num?)?.toInt() ?? (startIndex + i),
        if (o['height'] != null) 'height': o['height'],
        'nanos': cachedEarly,
        if (amtEarly != null) 'amount': amtEarly,
        'proofKey': proofKeyEarly,
        'verifiedNanos': cachedEarly,
        'proofChecked': true,
        'verified': true,
        if (trialSeed != null && trialRole == 'payout') 'payoutSeed': trialSeed,
        if (trialSeed != null && trialRole == 'payout') 'spendSeed': trialSeed,
        if (trialSeed != null && (trialRole == 'change' || trialRole == 'vote')) 'changeSeed': trialSeed,
        if (trialSeed != null && (trialRole == 'change' || trialRole == 'vote')) 'spendSeed': trialSeed,
        if (trialSeed != null && o['portalId'] != null) 'portalId': o['portalId'],
        if (trialSeed != null && _noteBytes(o['withdrawNonce']) != null) 'withdrawNonce': _noteBytes(o['withdrawNonce']),
      });
      _rememberPayoutRange(payoutRangeAt, notes.length - 1, kindName, o);
      seenHex.add(commitHex);
      continue;
    }
    final admit = _noteBytes(o['admitPub']);
    if (admit != null) {
      // Compact fee notes are sometimes labeled pot, or the label is omitted.
      // The admit was sealed under the real kind. Try that label, then the
      // fee labels. A hash or send admit does not match those, so it is skipped.
      final tries = <String>[
        if (kindName != null && kindName.isNotEmpty) kindName else 'pot',
        'pool-fee',
        'pot',
        'coinbase',
      ];
      final seenKind = <String>{};
      String? matchedKind;
      for (final kindTry in tries) {
        if (!seenKind.add(kindTry)) continue;
        try {
          final want = pointBytes(
            admitPub(
              admitScalarFromSeed(admitSeed, {
                'kind': kindTry,
                'noteCommit': nc,
                'commit': commit,
              }),
            ),
          );
          if (noteBytesEq(want, admit)) {
            matchedKind = kindTry;
            break;
          }
        } catch (_) {}
      }
      if (matchedKind == null) continue;
      kindName = matchedKind;
    }
    final kind = (kindName == null || kindName.isEmpty) ? 'pot' : kindName;
    final proofKey = proofCacheKey(o);
    final cachedNanos = proofKey == null ? null : proofCache[proofKey];
    // A remembered opening is this proof's nanos. A new proof still has to open.
    final openRow = Map<String, dynamic>.from(o)..['kind'] = kind;
    final verifiedNanos =
        cachedNanos ?? openedSpendDigits(openRow) ?? _amtCtDigits(o, xBase);
    final proofChecked = verifiedNanos != null;
    final amt = verifiedNanos == null ? null : _sheOfExactNanos(verifiedNanos);
    if (!noteIsFs1Leaf(admit, commit)) continue;
    notes.add({
      'address': matched,
      'dest': matched,
      'kind': kind,
      'commit': commit,
      'noteCommit': nc,
      'r': r,
      'rEph': rEph,
      'rCt': rCt,
      'admitPub': admit,
      'prev': _noteBytes(o['prev']) ?? prev ?? Uint8List(32),
      'index': (o['index'] as num?)?.toInt() ?? (startIndex + i),
      if (o['height'] != null) 'height': o['height'],
      if (amt != null) 'amount': amt,
      if (proofKey != null) 'proofKey': proofKey,
      if (verifiedNanos != null) 'verifiedNanos': verifiedNanos,
      if (proofChecked) 'proofChecked': true,
      if (verifiedNanos != null) 'verified': true,
      if (trialSeed != null && trialRole == 'payout') 'payoutSeed': trialSeed,
      if (trialSeed != null && trialRole == 'payout') 'spendSeed': trialSeed,
      if (trialSeed != null && (trialRole == 'change' || trialRole == 'vote')) 'changeSeed': trialSeed,
      if (trialSeed != null && (trialRole == 'change' || trialRole == 'vote')) 'spendSeed': trialSeed,
      if (trialSeed != null && o['portalId'] != null) 'portalId': o['portalId'],
      if (trialSeed != null && _noteBytes(o['withdrawNonce']) != null) 'withdrawNonce': _noteBytes(o['withdrawNonce']),
    });
    seenHex.add(commitHex);
    _rememberPayoutRange(payoutRangeAt, notes.length - 1, kind, o);
    if (kind == 'hash' && amt != null && !seenCommit) {
      hashFoldAt[notes.length - 1] = {
        'matched': matched,
        'she': amt.toDouble(),
        'height': (o['height'] as num?)?.toInt() ?? 0,
      };
    }
    // R and z were present (proofKey) but the commitment did not open.
    // That is not a verified zero.
    if (proofKey != null && verifiedNanos == null) unopenedProofs++;
  }
  unopenedProofs += _gatePayoutRanges(notes, payoutRangeAt);
  for (final e in hashFoldAt.entries) {
    if (notes[e.key]['verified'] == true) hashFolds.add(e.value);
  }
  return {
    'notes': notes,
    'hashFolds': hashFolds,
    'unopenedProofs': unopenedProofs,
  };
}

const _payoutRangeKinds = {
  'pot',
  'hash',
  'finder-fee',
  'reserve-fee',
  'pool-fee',
};

void _rememberPayoutRange(
  Map<int, Uint8List?> at,
  int index,
  String? kind,
  Map o,
) {
  if (kind == null || !_payoutRangeKinds.contains(kind)) return;
  at[index] = _noteBytes(o['rangeProof']);
}

int _gatePayoutRanges(
  List<Map<String, dynamic>> notes,
  Map<int, Uint8List?> at,
) {
  final jobs = <int>[];
  final commits = <Uint8List>[];
  final proofs = <Uint8List>[];
  var dropped = 0;
  for (final e in at.entries) {
    final note = notes[e.key];
    if (note['verified'] != true) continue;
    final commit = note['commit'];
    final proof = e.value;
    if (commit is! Uint8List ||
        commit.length != 32 ||
        proof == null ||
        proof.isEmpty) {
      _dropOpenedPayout(note);
      dropped++;
      continue;
    }
    jobs.add(e.key);
    commits.add(commit);
    proofs.add(proof);
  }
  final oks = nativeVerifyRanges(commits, proofs);
  for (var i = 0; i < jobs.length; i++) {
    if (i >= oks.length || !oks[i]) {
      _dropOpenedPayout(notes[jobs[i]]);
      dropped++;
    }
  }
  return dropped;
}

void _dropOpenedPayout(Map<String, dynamic> note) {
  note.remove('verified');
  note.remove('verifiedNanos');
  note.remove('proofChecked');
  note.remove('amount');
  note.remove('nanos');
}

/// Pure history-row parse + optional memoOpen. Full-sync via [Isolate.run].
Future<Map<String, dynamic>> parseHistoryPayload(
  Map<String, dynamic> input,
) async {
  final amountsOnly =
      input['amountsOnly'] == true && input['destProof'] != true;
  if (amountsOnly) {
    return {
      'amountsOnly': true,
      'txs': <Map<String, dynamic>>[],
      'dests': <String>[],
      'named': false,
    };
  }
  final key = input['key']?.toString() ?? '';
  final openMemos = input['openMemos'] == true;
  final existingPlain = <String, String>{
    for (final e in (input['existingPlain'] as Map? ?? {}).entries)
      e.key.toString(): e.value.toString(),
  };
  final vaults = <String>{
    ...List<String>.from(input['vaultDests'] as List? ?? const []),
  };
  final rows = input['rows'] as List? ?? const [];
  final txs = <Map<String, dynamic>>[];
  final dests = <String>[];
  var named = false;
  for (final row in rows) {
    if (row is! Map) continue;
    var tx = ShearTx.fromJson(Map<String, dynamic>.from(row));
    if (tx.to.isEmpty && tx.from.isEmpty) continue;
    if (tx.amount <= 0 && (tx.hashAmount == null || tx.hashAmount! <= 0)) {
      continue;
    }
    named = named || tx.to.isNotEmpty || tx.from.isNotEmpty;
    var plain = existingPlain[tx.id] ?? tx.memoPlain;
    if (openMemos && plain == null && tx.memoCt != null) {
      plain = await memoOpen(tx.to, tx.memoCt);
    }
    if (plain != null) {
      tx = ShearTx(
        id: tx.id,
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
        kind: tx.kind,
        height: tx.height,
        confirmed: tx.confirmed,
        memo: true,
        memoPlain: plain,
        memoCt: tx.memoCt,
        hashAmount: tx.hashAmount,
        threads: tx.threads,
        pot: tx.pot,
        change: tx.change,
        atMs: tx.atMs,
        rounds: tx.rounds,
      );
    }
    if (tx.to == key && tx.to.isNotEmpty && !vaults.contains(tx.to)) {
      dests.add(tx.to);
    }
    txs.add(tx.toJson());
  }
  return {'amountsOnly': false, 'txs': txs, 'dests': dests, 'named': named};
}

/// R and z present. A bare `{v}` claim is not a proof.
bool _completeValueProof(Map o) {
  final vp = o['valueProof'];
  if (vp is! Map) return false;
  if (_noteBytes(o['commit']) == null) return false;
  if (_noteBytes(vp['R']) == null || _noteBytes(vp['z']) == null) return false;
  return vp['v'] is num;
}

/// Nanos the sealed commitment actually opens.
///
/// Claimed `v` first, when it opens. Compact drops `v` on a pool-fee note, and
/// producers sometimes label that same note `pot`, `coinbase`, or omit kind.
/// Those still open at the sealed 1 percent, then any fee up to 3 percent,
/// then the pot. Hash, send, finder-fee, and reserve-fee do not take that hunt.
/// A `{v}`-only row has no R and z, so it stays closed. A node balance is not an input.
bool _feeValueHunt(String? kind) {
  if (kind == null || kind.isEmpty) return true;
  return kind == 'pool-fee' || kind == 'pot' || kind == 'coinbase';
}

/// Digits the sealed commitment opens, through 2^64-1.
String? openedSpendDigits(Map o) {
  final commit = _noteBytes(o['commit']);
  final vp = o['valueProof'];
  if (commit != null && vp is Map) {
    final claimed = tryU64Units(vp['v'] ?? o['nanos']);
    if (claimed != null &&
        claimed > BigInt.zero &&
        verifyValueUnits(commit, claimed, vp)) {
      return claimed.toString();
    }
  }
  final hunted = _openedSpendNanos(o);
  if (hunted == null || hunted <= 0) return null;
  return hunted.toString();
}

String? _amtCtDigits(Map o, Scalar xBase) {
  final v = openNoteAmount(o, xBase)?['v'];
  if (v is! BigInt || v <= BigInt.zero) return null;
  return v.toString();
}

int? _openedSpendNanos(Map o) {
  final commit = _noteBytes(o['commit']);
  final vp = o['valueProof'];
  if (commit == null || vp is! Map) return null;
  final r = _noteBytes(vp['R']);
  final z = _noteBytes(vp['z']);
  if (r == null || z == null) return null;
  bool opens(int v) {
    if (v <= 0) return false;
    return verifySealedNote({
      'commit': commit,
      'valueProof': {'R': r, 'z': z, 'v': v},
    }, v);
  }

  final raw = vp['v'];
  if (raw is num) {
    final claimed = raw.round();
    if (claimed > 0 && opens(claimed)) return claimed;
  }
  if (!_feeValueHunt(o['kind'] as String?)) return null;
  final potRaw = o['blockSubsidyNanos'] ?? o['potNanos'];
  final pot = potRaw is num && potRaw > 0
      ? potRaw.round()
      : (kBlockPotShe * kUnitsPerShe).round();
  if (pot <= 0) return null;
  final nanos = o['nanos'];
  if (nanos is num) {
    final n = nanos.round();
    if (n > 0 && opens(n)) return n;
  }
  final prefer = pot * kPoolFeeBps ~/ 10000;
  if (opens(prefer)) return prefer;
  final maxFee = pot * kPoolFeeMaxBps ~/ 10000;
  for (var bps = 1; bps <= kPoolFeeMaxBps; bps++) {
    final n = pot * bps ~/ 10000;
    if (n > 0 && n <= maxFee && n != prefer && opens(n)) return n;
  }
  if (opens(pot)) return pot;
  return null;
}

/// Nanos only when the value proof opens that exact claim.
int? _verifiedClaimNanos(Map o) {
  final commit = _noteBytes(o['commit']);
  final vp = o['valueProof'];
  if (commit == null || vp is! Map) return null;
  final r = _noteBytes(vp['R']);
  final z = _noteBytes(vp['z']);
  final raw = vp['v'];
  if (r == null || z == null || raw is! num) return null;
  final v = raw.round();
  if (v <= 0) return null;
  if (!verifySealedNote({
    'commit': commit,
    'valueProof': {'R': r, 'z': z, 'v': v},
  }, v)) {
    return null;
  }
  return v;
}

Uint8List? _noteBytes(dynamic v) {
  if (v is Uint8List) return v;
  if (v is List) {
    try {
      return Uint8List.fromList(List<int>.from(v));
    } catch (_) {
      return null;
    }
  }
  if (v is String && v.length >= 2 && v.length % 2 == 0) {
    try {
      return hexToBytes(v);
    } catch (_) {
      return null;
    }
  }
  return null;
}

dynamic _hexify(dynamic v) {
  if (v is Uint8List) return _bytesHex(v);
  if (v is List) return v.map(_hexify).toList();
  if (v is Map) {
    return v.map((k, val) => MapEntry(k, _hexify(val)));
  }
  return v;
}

/// Posted Flow vin is C̃-only. Tip `vin_link` rejects prev/index/noteCommit.
List<Map<String, dynamic>> _postedVin(List<Map<String, dynamic>> vin) {
  return vin.map((v) {
    final row = <String, dynamic>{};
    final commit = _allowChild('commit', v['commit']);
    if (commit is! _Omit && v.containsKey('commit')) row['commit'] = commit;
    return row;
  }).toList();
}

/// Public wire fields. Same set as crypto/spend.js PROOF_KEYS.
const postedAdmitProofKeys = <String>{
  'admit_proof',
  'v',
  'version',
  'spendTag',
  'blob',
  'cTilde',
  'c0',
  'proof',
  'members',
  'anchor',
  'root',
  'n',
  'pseudo',
  'commit',
  'tag',
};

/// crypto/spend.js VALUE_PROOF_KEYS. `R` is public.
const postedValueProofKeys = <String>{'v', 'R', 'z'};

/// One FS-1 membership row. The same set as crypto/member_keys.js MEMBER_KEYS.
const postedMemberKeys = <String>{'commit', 'hash', 'side', 'anchor', 'root'};

/// crypto/spend.js MERKLE_PROOF_KEYS.
const postedMerkleKeys = <String>{'side', 'hash'};

/// crypto/spend.js VOUT_KEYS.
const postedVoutKeys = <String>{
  'kind',
  'address',
  'nanos',
  'dest20',
  'noteCommit',
  'commit',
  'valueProof',
  'rangeProof',
  'viewTag',
  'admitPub',
  'rEph',
  'rCt',
  'amtCt',
  'portalId',
  'memo',
  'memoCt',
  'unlockAtMs',
  'lockEpoch',
};

/// Sentinel for a nested value the allow-list refuses.
class _Omit {
  const _Omit();
}

const _omit = _Omit();

Map<String, dynamic> _allowMap(Map<dynamic, dynamic> raw, Set<String> keys) {
  final out = <String, dynamic>{};
  for (final key in keys) {
    if (!raw.containsKey(key)) continue;
    final taken = _allowChild(key, raw[key]);
    if (taken is _Omit) continue;
    out[key] = taken;
  }
  return out;
}

dynamic _allowChild(String key, dynamic v) {
  switch (key) {
    case 'admit_proof':
      if (v is Map) return _allowMap(v, postedAdmitProofKeys);
      return _publicLeaf(v);
    case 'proof':
      if (v is Map) return _allowMap(v, postedMerkleKeys);
      if (v is List && v is! Uint8List && v.any((item) => item is Map)) {
        return <dynamic>[
          for (final item in v)
            if (item is Map) _allowMap(item, postedMerkleKeys) else item,
        ];
      }
      return _publicLeaf(v);
    case 'members':
      if (v is List && v is! Uint8List) {
        return <dynamic>[
          for (final item in v)
            if (item is Map)
              _allowMap(item, postedMemberKeys)
            else if (_publicLeaf(item) is! _Omit)
              item,
        ];
      }
      if (v is Map) return _allowMap(v, postedMemberKeys);
      return _publicLeaf(v);
    case 'valueProof':
      if (v is Map) return _allowMap(v, postedValueProofKeys);
      return _publicLeaf(v);
    default:
      return _publicLeaf(v);
  }
}

/// Byte lists and scalars stay. A map under a leaf key is dropped so an
/// unknown name such as `blind` cannot ride inside `anchor` or `commit`.
dynamic _publicLeaf(dynamic v) {
  if (v is Map) return _omit;
  if (v is List && v is! Uint8List) {
    for (final item in v) {
      if (item is Map) return _omit;
    }
  }
  return v;
}

/// Posted admit proof. Copies allow-listed fields and does not mutate [raw].
Map<String, dynamic> postedAdmitProof(Map<String, dynamic> raw) {
  return _allowMap(raw, postedAdmitProofKeys);
}

/// Drop `t` from the map that [Isolate.run] will copy back. Wipes that blind
/// only when the buffer is the worker's own and not the caller's spend seed.
Map<String, dynamic> workerAdmitProof(Map<String, dynamic> raw) {
  final copied = _dropBlind(raw, raw['spendSeed']);
  return Map<String, dynamic>.from(copied as Map);
}

dynamic _dropBlind(dynamic v, Object? seed) {
  if (v is Map) {
    final out = <String, dynamic>{};
    for (final e in v.entries) {
      if (e.key.toString() == 't') {
        final t = e.value;
        if (t is Uint8List && !identical(t, seed)) {
          for (var i = 0; i < t.length; i++) {
            t[i] = 0;
          }
        }
        continue;
      }
      out[e.key.toString()] = _dropBlind(e.value, seed);
    }
    return out;
  }
  if (v is List && v is! Uint8List) {
    return <dynamic>[for (final item in v) _dropBlind(item, seed)];
  }
  return v;
}

/// The body [flowPostHex] sends. Vin is C̃-only, vout is the sealed compact
/// row, and every proof has been through [postedAdmitProof].
Map<String, dynamic> postedFlowBody({
  required List<Map<String, dynamic>> vin,
  required List<Map<String, dynamic>> vout,
  required List<Map<String, dynamic>> proofs,
}) {
  final posted = <Map<String, dynamic>>[
    for (final proof in proofs) postedAdmitProof(proof),
  ];
  return <String, dynamic>{
    'vin': _postedVin(vin),
    'vout': _postedVout(vout),
    if (posted.isNotEmpty) 'admitProof': posted.first,
    if (posted.isNotEmpty) 'admitProofs': posted,
  };
}

List<Map<String, dynamic>> _postedVout(List<Map<String, dynamic>> vouts) {
  return [
    for (final row in vouts.map(compactSealedVout))
      _allowMap(row, postedVoutKeys),
  ];
}

/// KT-10. Same bytes as `kt10WithdrawBlind` in crypto/reserve_vault.js.
/// `nonce` is 32 bytes. The same (to, nanos, id, nonce) is the same scalar.
Scalar kt10WithdrawBlind(String to, BigInt nanos, String id, Uint8List nonce) {
  if (nonce.length != 32) throw StateError('kt10_nonce');
  final dst = utf8Bytes('shear-kt10-withdraw-r-v1');
  final n = Uint8List(8);
  var v = nanos;
  final mask = BigInt.from(0xff);
  for (var i = 0; i < 8; i++) {
    n[i] = (v & mask).toInt();
    v >>= 8;
  }
  final dest = utf8Bytes(to);
  final ident = utf8Bytes(id);
  for (var i = 0; i < 8; i++) {
    final r = hashToScalar([
      dst,
      Uint8List.fromList([i]),
      dest,
      n,
      ident,
      nonce,
    ]);
    if (!scalarEq(r, scalarZero())) return r;
  }
  throw StateError('kt10_blind');
}

String _freshWithdrawId() {
  final b = randomBytes(16);
  final hex = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return 'wd-$hex';
}

Uint8List _withdrawNonce(Uint8List? nonce) {
  if (nonce == null) return randomBytes(32);
  if (nonce.length != 32) throw StateError('kt10_nonce');
  return nonce;
}

/// Reserve lock/vote/withdraw out, same seal as pool `sealedReserveVout`.
/// Public nanos + dest20 + noteCommitOfDest20, with `commit` so wallet_api
/// keeps this body instead of minting a fresh seal after the spend sig.
/// A withdraw uses a hash-derived non-zero r. Value 0 is not a withdrawal.
Map<String, dynamic> sealedReserveVout(
  String to,
  Object nanos,
  String kind, {
  String id = '',
  Uint8List? nonce,
  Uint8List? spendSeed,
  int lockIndex = 0,
}) {
  final units = tryU64Units(nanos) ?? BigInt.zero;
  final shown = u64OnWire(units);
  // A lock pays a fresh subaddress. A withdraw or a seed-less lock keeps the address hash.
  final oneTime = kind == 'lock' && spendSeed != null && spendSeed.length == 32
      ? reservePortalDest20FromSeed(spendSeed, lockIndex)
      : null;
  final d20 = oneTime ?? hash20FromAddress(to);
  if (d20 == null) return {'address': to, 'nanos': shown, 'kind': kind};
  if (kind == 'withdraw' && units <= BigInt.zero) {
    return {'address': to, 'nanos': shown, 'kind': kind};
  }
  final blindId = kind == 'withdraw'
      ? (id.isEmpty ? _freshWithdrawId() : id)
      : '';
  final blindNonce = kind == 'withdraw' ? _withdrawNonce(nonce) : null;
  final blind = kind == 'withdraw'
      ? kt10WithdrawBlind(to, units, blindId, blindNonce!)
      : null;
  final note = sealCoinbaseUnits(units, dest20: d20, kind: kind, r: blind);
  if (kind == 'withdraw') {
    note['id'] = blindId;
    note['withdrawNonce'] = blindNonce;
  }
  note['address'] = to;
  final vp = note['valueProof'];
  if (vp is Map) {
    note['valueProof'] = {...Map<String, dynamic>.from(vp), 'v': shown};
  }
  return note;
}

/// One lock output. The leaf is vaultLockNote(π, owner scalar, blind, unlock).
/// The output commit is commit(π, blind) with no unlock point. nanos stay 0
/// and the coinbase value proof is not posted. lockAuth signs the leaf commit.
void _fundLockOutput(List<Map<String, dynamic>> sealed, {required Uint8List blind}) {
  var locks = 0;
  for (final note in sealed) {
    if ((note['kind'] ?? 'lock').toString() == 'lock') locks += 1;
  }
  if (locks != 1) throw StateError('stake_reward');
  final funded = commitBytes(kPiSheNanos, blind);
  final range = AdmitNative.tryLoad()?.proveRange(BigInt.from(kPiSheNanos), blind);
  if (range == null || range.length < 2 || range[0] != 2) {
    throw StateError('admit_native_required');
  }
  for (final note in sealed) {
    if ((note['kind'] ?? 'lock').toString() != 'lock') continue;
    note['commit'] = funded;
    note['nanos'] = 0;
    note.remove('valueProof');
    note.remove('r');
    note['rangeProof'] = range;
  }
}

/// A lock note carries the epoch end and the user's admit pub.
/// No clock leaves the older receipt. A random pub would not be the user's key.
void _stampLockNote(
  List<Map<String, dynamic>> sealed,
  Map<String, dynamic> input,
) {
  final epoch = input['lockEpoch'];
  final unlock = input['unlockAtMs'];
  final spendSeed = input['spendSeed'] is Uint8List
      ? input['spendSeed'] as Uint8List
      : null;
  final hasClock = epoch is int && epoch >= 0 && unlock is int && unlock > 0;
  if (!hasClock) return;
  for (var i = 0; i < sealed.length; i++) {
    final note = sealed[i];
    if ((note['kind'] ?? '').toString() != 'lock') continue;
    note['lockEpoch'] = epoch;
    note['unlockAtMs'] = unlock;
    final lockIndex = input['lockIndex'] is int ? input['lockIndex'] as int : 0;
    final ownerSeed = spendSeed == null ? null : reservePortalSpendSeed(spendSeed, lockIndex);
    if (ownerSeed != null && note['commit'] is Uint8List) {
      sealed[i] = attachAdmitPub(note, spendSeed: ownerSeed);
    }
  }
}

/// Seal and sign one reserve lock, vote, or withdraw.
/// Production calls this only from [Isolate.run].
Map<String, dynamic> sealSignReserveWire(Map<String, dynamic> input) {
  final to = (input['to'] as String?) ?? '';
  final from = (input['from'] as String?) ?? '';
  final kind = (input['kind'] as String?) ?? 'lock';
  final nanosUnits = tryU64Units(input['nanos']) ?? BigInt.zero;
  final spendSeed = input['spendSeed'] is Uint8List
      ? input['spendSeed'] as Uint8List
      : null;
  final shared = input['shared'] is Uint8List
      ? input['shared'] as Uint8List
      : null;
  final lockIndex = input['lockIndex'] is int ? input['lockIndex'] as int : 0;
  final spec = <Map<String, dynamic>>[
    for (final raw in (input['vouts'] as List? ?? const []))
      if (raw is Map) Map<String, dynamic>.from(raw),
  ];
  final sealed = <Map<String, dynamic>>[
    for (final o in spec)
      sealedReserveVout(
        (o['address'] as String?) ?? to,
        tryU64Units(o['nanos']) ?? (kind == 'vote' ? BigInt.zero : nanosUnits),
        (o['kind'] as String?) ?? kind,
        id: (input['id'] as String?) ?? '',
        nonce: input['withdrawNonce'] is Uint8List
            ? input['withdrawNonce'] as Uint8List
            : null,
        spendSeed: kind == 'lock' ? spendSeed : null,
        lockIndex: lockIndex,
      ),
  ];
  String? withdrawId;
  String? withdrawNonceHex;
  Uint8List? withdrawNonceRaw;
  if (kind == 'withdraw') {
    for (final o in sealed) {
      final ident = o.remove('id');
      final rawNonce = o.remove('withdrawNonce');
      if (ident is String && ident.isNotEmpty) withdrawId = ident;
      if (rawNonce is Uint8List && rawNonce.length == 32) {
        withdrawNonceRaw = rawNonce;
        withdrawNonceHex = rawNonce
            .map((b) => b.toRadixString(16).padLeft(2, '0'))
            .join();
      }
    }
  }
  String idFor(String dest, {bool lockPortal = false}) {
    if (spendSeed != null && spendSeed.length == 32) {
      final hidden = lockPortal
          ? reservePortalIdFromSeed(dest, spendSeed, lockIndex)
          : reserveAddressPortalId(dest, spendSeed);
      if (hidden != null) return hidden;
    }
    return reservePortalId(dest);
  }
  final portalId = kind == 'lock' ? idFor(to, lockPortal: true) : idFor(kind == 'withdraw' ? from : to);
  final payoutPortalId = kind == 'withdraw' ? idFor(to) : idFor(from);
  if (kind == 'lock') {
    for (final note in sealed) {
      if ((note['kind'] ?? kind).toString() == 'lock') {
        note['portalId'] = portalId;
        note['lockIndex'] = lockIndex;
      }
    }
  } else if (kind == 'withdraw') {
    for (final note in sealed) {
      note['portalId'] = payoutPortalId;
    }
  }
  String? lockAuthHex;
  String? ownerPubHex;
  String? vaultLockNoteHex;
  Uint8List? lockScalar;
  Uint8List? lockBlind;
  var lockUnlock = 0;
  if (kind == 'lock' && spendSeed != null && spendSeed.length == 32) {
    final ownerSeed = reservePortalSpendSeed(spendSeed, lockIndex);
    final epoch = input['lockEpoch'];
    lockUnlock = consensusUnlockPeriod(epoch is int ? epoch : 0);
    if (ownerSeed == null || lockUnlock <= 0 || lockUnlock == kVaultUnlockOpen) {
      throw StateError('stake_reward');
    }
    lockScalar = vaultLockOwnerBytes(ownerSeed, lockIndex);
    lockBlind = vaultLockBlindBytes(ownerSeed, lockIndex, kPiSheNanos, 0);
    final note = vaultLeafNote(
      amount: kPiSheNanos,
      scalar: lockScalar,
      blind: lockBlind,
      unlock: lockUnlock,
    );
    if (note.length != 64) throw StateError('stake_reward');
    // The funded commit is bound before the clock stamp, so admitPub opens it.
    _fundLockOutput(sealed, blind: lockBlind);
    final leafCommit = Uint8List.sublistView(note, 32, 64);
    final auth = reserveLockAuth(ownerSeed, portalId, leafCommit);
    if (auth == null || auth.length != 96) throw StateError('stake_reward');
    lockAuthHex = _bytesHex(auth);
    ownerPubHex = _bytesHex(auth.sublist(0, 32));
    vaultLockNoteHex = _bytesHex(note);
    _stampLockNote(sealed, input);
  } else if (kind == 'lock') {
    _stampLockNote(sealed, input);
  }
  final postedVout = _postedVout(sealed);
  final wire = flowPostHex(<String, dynamic>{
    'vin': const <Map<String, dynamic>>[],
    'vout': postedVout,
  });
  final hexVout = List<dynamic>.from(wire['vout'] as List? ?? const []);
  final choice = (input['choice'] as String?) ?? '';
  // A vote moves no value. A nonzero fee would pay miners with no debit.
  // Roll re-locks vault principal. The levy is the only Continuum debit.
  final taxed = kind == 'lock' || kind == 'roll';
  final maxLevy = false;
  final d20 = hash20FromAddress(from) ?? Uint8List(20);
  final signVin = kind == 'withdraw'
      ? <Map<String, dynamic>>[
          {'dest20': Uint8List(20)},
        ]
      : <Map<String, dynamic>>[
          {'address': from, 'dest20': d20},
        ];
  final shownNanos = sealed.isNotEmpty ? sealed.first['nanos'] : 0;
  final draft = _reservePoolDraft(
    kind: kind,
    from: from,
    to: to,
    choice: choice,
    vout: hexVout,
    nanos: shownNanos is int ? shownNanos : jsSafeInt(shownNanos),
    id: withdrawId,
    withdrawNonce: withdrawNonceHex,
    portalTo: kind == 'withdraw' ? payoutPortalId : portalId,
    portalFrom: kind == 'withdraw' ? portalId : payoutPortalId,
  );
  final fee = taxed ? bindStableWeightFee(draft, maxLevy: maxLevy) : 0;
  if (taxed && !weightFeeCovers(fee, draft, maxLevy: maxLevy)) {
    throw StateError('fee_short');
  }
  final commit = sealed.isNotEmpty ? _noteBytes(sealed.first['commit']) : null;
  final vp = sealed.isNotEmpty ? sealed.first['valueProof'] : null;
  final suffixNanos = jsSafeInt(vp is Map ? vp['v'] : shownNanos);
  Uint8List? sig;
  Uint8List? pub;
  if (spendSeed != null && spendSeed.length == 32) {
    final msg = reserveSpendMessage(
      from: from,
      vout: postedVout,
      vin: signVin,
      kind: kind,
      portalId: portalId,
      payoutPortalId: payoutPortalId,
      programId: 'shear-reserve-v1',
      choice: choice,
      fee: fee,
      suffixNanos: suffixNanos,
      commit: commit,
      id: withdrawId ?? '',
      withdrawNonce: withdrawNonceRaw,
    );
    if (shared != null) {
      sig = stealthSign(spendSeed, shared, msg);
      pub = stealthTweakPub(ed25519PublicFromSeed(spendSeed), shared);
    } else {
      sig = ed25519Sign(spendSeed, msg);
      pub = ed25519PublicFromSeed(spendSeed);
    }
  }
  final postedVin = List<dynamic>.from(_hexify(signVin) as List? ?? const []);
  return {
    'vouts': sealed,
    'postedVin': postedVin,
    'postedVout': hexVout,
    'sig': sig,
    'pub': pub,
    'fee': taxed ? fee : 0,
    'portalId': portalId,
    if (kind != 'lock') 'payoutPortalId': payoutPortalId,
    'isolateStamp': reserveIsolateStamp,
    if (withdrawId != null) 'id': withdrawId,
    if (withdrawNonceHex != null) 'withdrawNonce': withdrawNonceHex,
    if (lockAuthHex != null) 'lockAuth': lockAuthHex,
    if (ownerPubHex != null) 'ownerPub': ownerPubHex,
    if (vaultLockNoteHex != null) 'vaultLockNote': vaultLockNoteHex,
    if (lockScalar != null) 'lockScalar': lockScalar,
    if (lockBlind != null) 'lockBlind': lockBlind,
    if (kind == 'lock') 'lockUnlock': lockUnlock,
  };
}

Uint8List? _hexToBytes(Object? raw) {
  if (raw is Uint8List) return raw;
  if (raw is! String || raw.isEmpty) return null;
  try {
    return hexToBytes(raw.startsWith('0x') ? raw.substring(2) : raw);
  } catch (_) {
    return null;
  }
}

Map<String, dynamic> _lockWireRow(Map<String, dynamic> row) {
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

/// Production lock body. [send] posts this. The leaf comes from
/// [sealSignReserveWire], the input spend is the wallet FS-1 prover, and the
/// fund proof is bound to that finished body.
Map<String, Object?>? sealWalletLockTx({
  required Uint8List spendSeed,
  required String address,
  required int lockIndex,
  required int lockEpoch,
  required int proveHeight,
  required int anchor,
  required Uint8List fluxNotes,
  required List<Map<String, dynamic>> inputs,
  required int inputNanos,
  required Uint8List changeDest20,
  required String id,
  required Uint8List changeSpendSeed,
  String magic = kBookMagic,
  int? fee,
}) {
  if (spendSeed.length != 32 || changeSpendSeed.length != 32) return null;
  if (inputs.isEmpty || inputs.length > kFs1InputMax) return null;
  if (changeDest20.length != 20 || id.isEmpty || proveHeight < 0 || anchor < 0) return null;
  Map<String, dynamic> sealed;
  try {
    sealed = sealSignReserveWire(<String, dynamic>{
      'to': address,
      'from': address,
      'kind': 'lock',
      'nanos': kPiSheNanos,
      'spendSeed': spendSeed,
      'lockIndex': lockIndex,
      'lockEpoch': lockEpoch,
      'vouts': <Map<String, dynamic>>[
        {'address': address, 'nanos': kPiSheNanos, 'kind': 'lock'},
      ],
    });
  } catch (_) {
    return null;
  }
  final scalar = sealed['lockScalar'];
  final blind = sealed['lockBlind'];
  final note = _hexToBytes(sealed['vaultLockNote']);
  final auth = _hexToBytes(sealed['lockAuth']);
  final ownerHex = sealed['ownerPub'];
  final portalId = sealed['portalId'];
  if (scalar is! Uint8List || blind is! Uint8List || note == null || note.length != 64) return null;
  if (auth == null || auth.length != 96 || ownerHex is! String || ownerHex.length != 64) return null;
  if (portalId is! String || portalId.isEmpty) return null;
  Map<String, dynamic>? lockSealed;
  final sealedOuts = sealed['vouts'];
  if (sealedOuts is List) {
    for (final row in sealedOuts) {
      if (row is Map && (row['kind'] ?? 'lock').toString() == 'lock') {
        lockSealed = Map<String, dynamic>.from(row);
        break;
      }
    }
  }
  final funded = lockSealed?['commit'];
  final range = lockSealed?['rangeProof'];
  if (funded is! Uint8List || funded.length != 32 || range is! Uint8List || range.isEmpty) return null;
  if (lockSealed?['nanos'] != 0 || lockSealed?.containsKey('valueProof') == true) return null;
  final paid = fee ?? kLevyCapNanos;
  final changeN = inputNanos - paid - kPiSheNanos;
  if (paid <= 0 || changeN <= 0) return null;
  final lockDest = lockSealed?['dest20'];
  if (lockDest is Uint8List && lockDest.length >= 20) {
    var same = true;
    for (var i = 0; i < 20; i++) {
      if (lockDest[i] != changeDest20[i]) {
        same = false;
        break;
      }
    }
    if (same) return null;
  }
  final changeKey = changeSpendSeed;
  final change = hiddenChangeNote(
    changeN,
    changeDest20,
    spendSeed: changeKey,
    admitBase: admitPub(admitBaseScalar(spendSeed)),
  );
  if (change == null) return null;
  final lockRow = <String, dynamic>{
    'kind': 'lock',
    'commit': funded,
    'rangeProof': range,
    'r': blind,
    'dest20': lockDest ?? reservePortalDest20FromSeed(spendSeed, lockIndex),
    'portalId': portalId,
  };
  final withBlind = <Map<String, dynamic>>[lockRow, change];
  final posted = <Map<String, dynamic>>[
    _lockWireRow(lockRow),
    _lockWireRow(change),
  ];
  // H(piProof) is in the reserve suffix. The proof is bound before the
  // FS-1 digest and the fund proof, so stripping it fails verification.
  final pi = AdmitNative.tryLoad()?.proveRange(BigInt.zero, blind);
  if (pi == null || pi.length < 2 || pi[0] != 2) return null;
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
    piProof: pi,
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
    final noteSeed = row['spendSeed'] ?? row['changeSeed'] ?? row['payoutSeed'];
    spent.add({
      'kind': (row['kind'] ?? 'pot').toString(),
      'commit': commit,
      'noteCommit': nc,
      'r': r,
      if (noteSeed is Uint8List && noteSeed.length == 32) 'spendSeed': noteSeed,
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
  });
  final tree = Fs1TreeState.fromWire(proved['tree']);
  try {
    final records = [for (final rec in (proved['records'] as List)) rec as Uint8List];
    final proofs = [for (final rec in records) fs1PostedProof(rec)];
    if (proofs.length != inputs.length) return null;
    final body = <String, Object?>{
      'id': id,
      'kind': 'lock',
      // No top-level nanos: the amount is hidden in the lock commit, and the
      // node refuses a plaintext copy beside it (reserveNanosRejected).
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
      'piProof': pi,
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
      'unlock': sealed['lockUnlock'] is int ? sealed['lockUnlock'] as int : consensusUnlockPeriod(lockEpoch),
      'commit': funded,
      'portalId': portalId,
      'ownerPub': ownerHex,
      'fee': paid,
      'changeNanos': changeN,
      'change': change,
      'changeSeed': changeKey,
      'dest20': lockRow['dest20'],
      'lockIndex': lockIndex,
    };
  } finally {
    Fs1Native.tryLoad()?.treeFree(tree.handle);
  }
}

/// JSON the pool's vote/lock/withdraw draft stringifies for [levyNeed].
/// `id` is the same width as `vote-${Date.now()}`. Buffer fields use Node's
/// `{"type":"Buffer","data":[...]}` form. The signature is not in this map.
Map<String, dynamic> _reservePoolDraft({
  required String kind,
  required String from,
  required String to,
  required String choice,
  required List<dynamic> vout,
  required int nanos,
  String? id,
  String? withdrawNonce,
  String? portalTo,
  String? portalFrom,
}) {
  final stamp = DateTime.now().millisecondsSinceEpoch.toString();
  final portalToId = portalTo ?? reservePortalId(to);
  final portalFromId = portalFrom ?? reservePortalId(from);
  final d20 = hash20FromAddress(from) ?? Uint8List(20);
  final vinBuf = <String, dynamic>{
    'address': from,
    'dest20': <String, dynamic>{
      'type': 'Buffer',
      'data': [for (final b in d20) b],
    },
  };
  if (kind == 'vote') {
    return <String, dynamic>{
      'id': 'vote-$stamp',
      'programId': 'shear-reserve-v1',
      'kind': 'vote',
      'from': from,
      'to': to,
      'choice': choice,
      'portalId': portalToId,
      'payoutPortalId': portalFromId,
      'vin': [vinBuf],
      'vout': vout,
      'payer': from,
    };
  }
  if (kind == 'withdraw') {
    return <String, dynamic>{
      'id': (id != null && id.isNotEmpty) ? id : 'withdraw-$stamp',
      'programId': 'shear-reserve-v1',
      'mint': true,
      'kind': 'withdraw',
      'from': from,
      'to': to,
      'nanos': nanos,
      if (withdrawNonce != null && withdrawNonce.isNotEmpty)
        'withdrawNonce': withdrawNonce,
      'portalId': portalFromId,
      'payoutPortalId': portalToId,
      'vin': <Map<String, dynamic>>[],
      'vout': vout,
      'amount': _jsSheAmount(nanos),
    };
  }
  if (kind == 'roll') {
    return <String, dynamic>{
      'id': 'roll-$stamp',
      'programId': 'shear-reserve-v1',
      'kind': 'roll',
      'from': from,
      'to': to,
      'nanos': 0,
      'portalId': portalToId,
      'payoutPortalId': portalToId,
      'vin': [vinBuf],
      'vout': const <Map<String, dynamic>>[],
      'amount': 0,
    };
  }
  return <String, dynamic>{
    'id': 'lock-$stamp',
    'programId': 'shear-reserve-v1',
    'kind': 'lock',
    'from': from,
    'to': to,
    'nanos': nanos,
    'portalId': portalToId,
    'payoutPortalId': portalFromId,
    'vin': [vinBuf],
    'vout': vout,
    'memoCt': null,
    'amount': _jsSheAmount(nanos),
  };
}

/// Whole SHE stays an int so the JSON length matches `JSON.stringify(n / 1e11)`.
Object _jsSheAmount(int nanos) {
  const scale = 100000000000;
  if (scale == 0) return 0;
  if (nanos % scale == 0) return nanos ~/ scale;
  return nanos / scale;
}

/// Reserve lock, vote, and withdraw seal. Always [Isolate.run]. A caller-side
/// bypass would put [sealSignReserveWire] on the UI isolate.
Future<Map<String, dynamic>> _reserveSealOffUi(Map<String, dynamic> input) {
  return Isolate.run(() => sealSignReserveWire(input)).then((out) {
    debugReserveIsolateRuns += 1;
    debugReserveOffIsolateStamp = (out['isolateStamp'] as String?) ?? '';
    return out;
  });
}

/// Painted Continuum send has no flux-set note, so it cannot run native
/// range/ADMIT prove (`admit_native_required`). Commit each out, including
/// one dummy, the way the pool's spend-sig path keeps the body. No admit proof.
List<Map<String, dynamic>> sealPaintedSpendVouts(
  List<Map<String, dynamic>> spec,
) {
  final out = <Map<String, dynamic>>[];
  for (final o in spec) {
    final kind = (o['kind'] as String?) ?? 'send';
    final units = tryU64Units(o['nanos']) ?? BigInt.zero;
    final Uint8List d20;
    if (kind == 'dummy') {
      d20 = randomBytes(20);
    } else {
      final addr = (o['address'] as String?) ?? '';
      final hashed = hash20FromAddress(addr);
      if (hashed == null) continue;
      d20 = hashed;
    }
    final note = sealCoinbaseUnits(units, dest20: d20, kind: kind);
    final addr = o['address'];
    if (addr is String && addr.isNotEmpty) note['address'] = addr;
    out.add(note);
  }
  if (!out.any((o) => (o['kind'] as String?) == 'dummy')) {
    out.add(sealCoinbaseNote(0, dest20: randomBytes(20), kind: 'dummy'));
  }
  return out;
}

/// Gross sealed average: (potEmitted + hashBonusEmitted) / height. No fee subtract, no 1.0 clamp.
double? sealedAvgBlockRewardShe({
  required int potEmittedNanos,
  required int hashBonusEmittedNanos,
  required int height,
}) {
  if (height <= 0) return null;
  if (potEmittedNanos < 0 || hashBonusEmittedNanos < 0) return null;
  return (potEmittedNanos + hashBonusEmittedNanos) / height / kUnitsPerShe;
}

String avgBlockRewardLabel({
  required int? potEmittedNanos,
  required int? hashBonusEmittedNanos,
  required int height,
}) {
  if (potEmittedNanos == null || hashBonusEmittedNanos == null) return '—';
  final she = sealedAvgBlockRewardShe(
    potEmittedNanos: potEmittedNanos,
    hashBonusEmittedNanos: hashBonusEmittedNanos,
    height: height,
  );
  if (she == null) return '—';
  return '${formatShe(she)} SHE';
}

/// Circulation row. Wallet-local pots are not a stand-in for network supply.
String integralQCirculationLabel(int? circulatingNanos) {
  if (circulatingNanos == null || circulatingNanos <= 0) return '—';
  return '${formatShe(circulatingNanos / kUnitsPerShe)} SHE (circulation)';
}

/// Explorer "Average block time (sealed, all blocks)": the sealed mean, then
/// the pool EWMA. A last-header gap is not this figure.
int? sealedMeanBlockMsFromStats(Map<String, dynamic> json) {
  final raw = json.containsKey('networkAvgBlockTimeMs')
      ? json['networkAvgBlockTimeMs']
      : json['avgBlockTimeMs'];
  if (raw is! num || raw <= 0) return null;
  return raw.round();
}

/// Same seconds text as the explorer box. Empty when the stat was not served.
String observedIntervalLabel(int? ms) {
  if (ms == null || ms <= 0) return '';
  return '${(ms / 1000).toStringAsFixed(1)} s';
}

/// Unpacked work bits. A packed integer (blockBits) is not this row.
String resistanceBitsLabel(double? bits) {
  if (bits == null || bits <= 0 || bits >= 1000) return '';
  var s = bits.toStringAsFixed(4);
  s = s.replaceFirst(RegExp(r'0+$'), '').replaceFirst(RegExp(r'\.$'), '');
  return s;
}

class LockFundingPlan {
  const LockFundingPlan({
    required this.sources,
    required this.from,
    required this.consolidate,
    required this.have,
    required this.need,
  });
  final List<String> sources;
  final String? from;
  final bool consolidate;
  final double have;
  final double need;
}

LockFundingPlan planLockFunding(
  ShearLedger ledger, {
  required String restFrame,
  String? paymentCode,
  required double needShe,
}) {
  final dests = ledger.moneyDests(restFrame, paymentCode: paymentCode).toList();
  var have = 0.0;
  String? cover;
  final holding = <String>[];
  for (final d in dests) {
    // Same coins Continuum shows. A settled land or pool figure is not added.
    final s = ledger.usableSpendable(d);
    if (s <= 0) continue;
    have += s;
    holding.add(d);
    if (cover == null && s + 1e-12 >= needShe) cover = d;
  }
  if (cover != null) {
    return LockFundingPlan(
      sources: [cover],
      from: cover,
      consolidate: false,
      have: have,
      need: needShe,
    );
  }
  if (have + 1e-12 >= needShe && holding.isNotEmpty) {
    return LockFundingPlan(
      sources: holding,
      from: null,
      consolidate: true,
      have: have,
      need: needShe,
    );
  }
  return LockFundingPlan(
    sources: const [],
    from: null,
    consolidate: false,
    have: have,
    need: needShe,
  );
}

/// Pool balance/status text for a gateway timeout. Other errors are not this.
bool poolHttp504(Object error) {
  final msg = error.toString();
  return msg.contains('http_504') || msg.contains('status 504');
}

String lockFundingShortfall(LockFundingPlan plan) {
  if (plan.have + 1e-12 >= plan.need) return '';
  return 'Not enough Continuum spendable for lock + tx fee — need ${formatShe(plan.need)} SHE, have ${formatShe(plan.have)} SHE';
}

/// Verified confirmed coins only. A pool balance, owed-toward-π, and
/// unconfirmed arrivals stay out of this figure.
double paintedContinuumSpendable(
  ShearLedger ledger,
  String restFrame, {
  String? paymentCode,
}) {
  return ledger.spendableOwned(restFrame, paymentCode: paymentCode);
}

/// Sum of sealed notes on money dests. Not the painted Continuum figure.
double chainNoteSum(
  ShearLedger ledger,
  String restFrame, {
  String? paymentCode,
}) {
  var n = 0.0;
  for (final d in ledger.moneyDests(restFrame, paymentCode: paymentCode)) {
    n += ledger.inventoriedNoteShe(d, sum: true);
  }
  return n;
}

class ContinuumSendResult {
  const ContinuumSendResult({
    required this.posted,
    required this.to,
    required this.remark,
    this.tx,
  });

  final bool posted;
  final String to;
  final String remark;
  final ShearTx? tx;
}

/// Spendable map plus owed already counted inside it, so a failed post can
/// put the painted figure back.
class PaintedBookMark {
  const PaintedBookMark(this.spendable, this.owedSpent);

  final Map<String, double> spendable;
  final double owedSpent;
}

bool continuumPayable(String raw) {
  final s = raw.trim();
  return isFullPaymentCode(s) || isPayableDest(s);
}

/// Flow send from its start state. A fingerprint or other short address is
/// rejected and [startTo] is left unchanged. A full she1 or ssa1 within the
/// painted Continuum figure posts.
Future<ContinuumSendResult> submitContinuumSend({
  required ShearLedger ledger,
  required String restFrame,
  String? paymentCode,
  required String startTo,
  required String enteredTo,
  required double amount,
  String? memo,
  Uint8List? spendSeed,
  bool local = false,
  bool allowPublicHttp = false,
  bool publicNode = true,
  bool publicIpConsent = false,
  int depth = 0,
  SendProgress? progress,
  String? nanosWire,
}) async {
  final candidate = enteredTo.trim();
  if (!continuumPayable(candidate)) {
    final remark = isUnpayableSsa1(candidate) ? kErrShortSsa1 : kErrShortShe1;
    return ContinuumSendResult(posted: false, to: startTo, remark: remark);
  }
  if (amount <= 0 && (nanosWire == null || nanosWire.isEmpty)) {
    return ContinuumSendResult(
      posted: false,
      to: candidate,
      remark: kErrSendGeneric,
    );
  }
  if (publicNode &&
      !local &&
      !publicNodePostAllowed(consent: publicIpConsent)) {
    return ContinuumSendResult(
      posted: false,
      to: candidate,
      remark: kPublicIpWaitCopy,
    );
  }
  if (!ledger.beginSend()) {
    return ContinuumSendResult(
      posted: false,
      to: candidate,
      remark: 'send_in_flight',
    );
  }
  try {
    // The levy is quoted when the send is built. It is not taken off this figure.
    depth;
    final exactWire = nanosWire != null && RegExp(r'^\d+$').hasMatch(nanosWire);
    final fromDouble = BigInt.from((amount * kUnitsPerShe).round());
    final lossyAmount = exactWire && fromDouble != BigInt.parse(nanosWire!);
    // The figure is gross. The levy is taken at send time, not off the figure.
    final need = amount;
    if (!lossyAmount) {
      final painted = paintedContinuumSpendable(
        ledger,
        restFrame,
        paymentCode: paymentCode,
      );
      if (painted + 1e-12 < need) {
        return ContinuumSendResult(
          posted: false,
          to: candidate,
          remark: kErrSendGeneric,
        );
      }
    }
    debugLastContinuumSendError = null;
    final mark = ledger.markPaintedBook();
    final gap = ledger.fundFromPaintedContinuum(
      restFrame,
      paymentCode: paymentCode,
      needShe: need,
    );
    if (gap == null) {
      ledger.restorePaintedBook(mark);
      return ContinuumSendResult(
        posted: false,
        to: candidate,
        remark: kErrSendGeneric,
      );
    }
    try {
      final paintedFrom = ledger.paintedFundDest;
      final from = gap > 1e-12 && isDestAddress(paintedFrom)
          ? paintedFrom
          : flowSpendFrom(
              ledger,
              restFrame: restFrame,
              paymentCode: paymentCode,
              amount: need,
            );
      final tx = await ledger.sendSpendableSum(
        from: from,
        to: candidate,
        amount: amount,
        publicConsent: publicIpConsent,
        memo: memo,
        local: local,
        restFrame: restFrame,
        paymentCode: paymentCode,
        spendSeed: spendSeed,
        allowPublicHttp: allowPublicHttp,
        paintedCover: gap > 1e-12,
        progress: progress,
        nanosWire: nanosWire,
      );
      return ContinuumSendResult(
        posted: true,
        to: candidate,
        remark: '',
        tx: tx,
      );
    } catch (e) {
      debugLastContinuumSendError = e;
      ledger.restorePaintedBook(mark);
      return ContinuumSendResult(
        posted: false,
        to: candidate,
        remark: flowSendAdvisoryOf(e),
      );
    }
  } finally {
    ledger.endSend();
  }
}

bool spendableExceedsCirculating({
  required double spendableShe,
  required int? circulatingNanos,
}) {
  if (circulatingNanos == null || circulatingNanos <= 0) return false;
  return (spendableShe * kUnitsPerShe).round() > circulatingNanos;
}

/// Shown on Continuum when the painted Spendable cannot be the real balance.
const kFundsNotCorrectlyShown = 'Your funds are not correctly shown.';

bool fundsNotCorrectlyShown({
  required double spendableShe,
  required int? circulatingNanos,
}) {
  return spendableExceedsCirculating(
    spendableShe: spendableShe,
    circulatingNanos: circulatingNanos,
  );
}

String formatShe(num she) {
  if (!she.isFinite) return '0.000000000';
  final trunc = (she * 1e9).truncateToDouble() / 1e9;
  if (trunc == 0 && she != 0) {
    final s = formatHashBonusShe((she.abs() * kUnitsPerShe).round());
    return she < 0 ? '-$s' : s;
  }
  final s = trunc.toStringAsFixed(kShePublicDigits);
  if (RegExp(r'^-?\d+\.000000000$').hasMatch(s))
    return trunc.truncate().toString();
  return s;
}

/// SHE text from an integer nanos count. Values that fit in a safe double
/// use [formatShe]. A larger count stays the exact decimal.
String formatSheFromNanos(int nanos) {
  if (nanos == 0) return '0';
  if (nanos > -_kSafeDoubleNanos && nanos < _kSafeDoubleNanos) {
    return formatShe(nanos / kUnitsPerShe);
  }
  final neg = nanos < 0;
  final v = neg ? -nanos : nanos;
  final whole = v ~/ kUnitsPerShe;
  final frac = v % kUnitsPerShe;
  if (frac == 0) return neg ? '-$whole' : '$whole';
  var digits = frac.toString().padLeft(11, '0');
  while (digits.endsWith('0')) {
    digits = digits.substring(0, digits.length - 1);
  }
  final body = '$whole.$digits';
  return neg ? '-$body' : body;
}

/// Flow nanos for the Vortex line. A spendable double inside 2^53 is that
/// book. Above it, the exact note nanos are the figure. The double is not
/// rounded back into a nanos count.
int vortexFlowNanos({
  required double spendableShe,
  required Iterable<BigInt> exactNotes,
}) {
  if (!spendableShe.isFinite || spendableShe <= 0) return 0;
  final scaled = spendableShe * kUnitsPerShe;
  if (scaled.isFinite && scaled >= 0 && scaled <= _kSafeDoubleNanos) {
    return scaled.round();
  }
  var sum = BigInt.zero;
  for (final n in exactNotes) {
    if (n > BigInt.zero) sum += n;
  }
  if (sum.bitLength > 63) return 0;
  return sum.toInt();
}

/// Full nano SHE (`*.***********`). Do not use [formatShe] for the hashbonus banner.
const kErrNoteSpent = 'that note was already spent';
const kErrRangeProof = 'range proof failed';
const kErrPublicHttp =
    'node not running — sends would use the public node and show your IP';
const kErrSyncTip = 'node not at tip — wait for sync';
const kErrSendGeneric = 'not sent - try again';
const kErrShortShe1 = 'paste full she1 from Receive (not fingerprint)';
const kErrPayIdentity = 'pay this identity with their full she1 or ssa1 dest';
const kErrLockUnsigned = 'lock signature rejected';

/// User copy for a reserve reason. Raw consensus codes stay off the screen.
String reserveReasonCopy(String reason) {
  switch (reason.trim()) {
    case 'stake_reward':
      return 'That lock was not accepted. A lock is one π, funded to the leaf.';
    case 'portal_exists':
      return 'This lock is already on the chain. Sync, then the next lock uses a new index.';
    case 'mint_amount':
      return 'The withdraw amount does not match the matured lock.';
    case 'vote_retired':
      return 'Portal votes are retired. Cast a leaf vote.';
    case 'bad_amount':
      return 'Enter an amount of at least one π.';
    case 'epoch_open':
      return 'The epoch is still open.';
    case 'proof_reuse':
      return 'That leaf was already claimed.';
    case 'double_mint':
      return 'That reward was already minted.';
    case 'claim_cap':
      return 'This block is full of claims. Try the next block.';
    case 'vote_cap':
      return 'This block is full of votes. Try the next block.';
    case 'retire_cap':
      return 'This block is full of withdrawals. Try the next block.';
    case 'admit_mismatch':
    case 'fs1_not_owner':
      return 'That note cannot be spent with this key.';
    case 'need_enact':
      return 'The lock was posted. The local vault book is waiting for the next epoch.';
    default:
      return reason;
  }
}

String voteFailCopy(Object error) {
  final raw = error.toString();
  final msg = raw.toLowerCase();
  if (msg.contains('not_voter') || msg.contains('not eligible')) {
    return 'You’re not eligible to vote from this portal this epoch';
  }
  if (msg.contains('vote_locked') || msg.contains('sealed')) {
    return 'Vote already sealed for this epoch';
  }
  if (msg.contains('unsigned') ||
      msg.contains('lock signature') ||
      msg.contains('bad_vote')) {
    return 'Vote could not be signed — check Continuum fee and portal, then try again';
  }
  for (final code in const [
    'stake_reward',
    'portal_exists',
    'mint_amount',
    'vote_retired',
    'bad_amount',
    'epoch_open',
    'proof_reuse',
    'double_mint',
    'claim_cap',
    'vote_cap',
    'retire_cap',
    'admit_mismatch',
    'fs1_not_owner',
  ]) {
    if (msg.contains(code)) return reserveReasonCopy(code);
  }
  if (raw.startsWith('Bad state: ')) return reserveReasonCopy(raw.substring('Bad state: '.length));
  return raw;
}

/// The picker had no sealed note, and the rest-frame sum could not cover the send.
/// One Flow input spends one note. A user send of the sum posts one transaction per note.
const kErrNoSealedNote =
    'No sealed Continuum note ready — wait for sync/confirms';

/// Header depth is still unknown. Not a balance shortfall.
const kErrHeaderSync = 'waiting for header sync';

/// The send needs this wallet's own change, which is not mined yet. Pending,
/// not a balance shortfall: it becomes spendable once it has a height.
const kErrChangePending = 'waiting for your change to be mined';

/// A Vault lock is one π leaf. Any other amount is refused before anything is posted.
const kErrLockAmount = 'A Vault lock is exactly 3.14159265358 SHE (one π leaf)';

/// True when [amountShe] is exactly one π leaf in protocol units.
bool isOnePiLeaf(double amountShe) => (amountShe * kUnitsPerShe).round() == kPiSheNanos;

/// Pool answered with an HTML error page (or other non-JSON). Never surface FormatException.
const kErrPoolHtml = 'pool returned HTML';

const kFlowMiningRefuse =
    'Can’t spend from your mining mailbox — Continuum will use a spend note instead.';

/// Flow vin. A covering dest other than the mining mailbox.
/// Throws [kFlowMiningRefuse] when the only covering dest is that mailbox.
String flowSpendFrom(
  ShearLedger ledger, {
  required String restFrame,
  String? paymentCode,
  required double amount,
}) {
  final home = ledger.homeDest(restFrame, paymentCode: paymentCode);
  final cover = ledger.spendFrom(
    restFrame,
    paymentCode: paymentCode,
    amount: amount,
    requireCover: true,
  );
  if (cover.isNotEmpty && cover != home) return cover;
  String? best;
  var bestShe = -1.0;
  for (final d in ledger.moneyDests(restFrame, paymentCode: paymentCode)) {
    if (d == home) continue;
    final she = ledger.spendable(d);
    if (she + 1e-12 < amount) continue;
    if (she > bestShe) {
      best = d;
      bestShe = she;
    }
  }
  if (best != null) return best;
  if (cover == home || ledger.spendable(home) + 1e-12 >= amount) return home;
  if (ledger.spendableOwned(restFrame, paymentCode: paymentCode) + 1e-12 >=
      amount) {
    var richest = home;
    var richestShe = ledger.spendable(home);
    for (final d in ledger.moneyDests(restFrame, paymentCode: paymentCode)) {
      final she = ledger.spendable(d);
      if (she > richestShe) {
        richest = d;
        richestShe = she;
      }
    }
    if (richest.isNotEmpty) return richest;
  }
  throw ledger.fundsRefusal(amount);
}

/// Flow send catch: map known failures; keep generic for unknown.
String flowSendAdvisoryOf(Object error) {
  final msg = error.toString();
  if (msg.contains(kFlowMiningRefuse) || msg.contains('mining mailbox')) {
    return kFlowMiningRefuse;
  }
  if (msg.contains(kErrPayIdentity) || msg.contains('pay this identity')) {
    return kErrPayIdentity;
  }
  if (msg.contains(kErrShortSsa1) || msg.contains('old short form')) {
    return kErrShortSsa1;
  }
  if (msg.contains(kErrShortShe1) ||
      msg.contains('not fingerprint') ||
      msg.contains('payment fingerprint')) {
    return kErrShortShe1;
  }
  if (msg.contains(kErrPublicHttp) || msg.contains('public node')) {
    return kErrPublicHttp;
  }
  if (msg.contains(kErrSyncTip) ||
      msg.contains('sync-tip') ||
      msg.contains('syncTip') ||
      msg.contains('sync tip')) {
    return kErrSyncTip;
  }
  if (msg.contains('send_cancelled') || msg.contains(kErrSendCancelled)) {
    return kErrSendCancelled;
  }
  if (msg.contains('send_timeout') || msg.contains(kErrSendTimeout)) {
    return kErrSendTimeout;
  }
  if (msg.contains('fee_short') || msg.contains(kErrFeeShort)) {
    return kErrFeeShort;
  }
  if (msg.contains(kErrSendUnavailable)) return kErrSendUnavailable;
  return kErrSendGeneric;
}

/// Public alias of [_sendHumanError] for unit tests.
StateError sendHumanError(
  String? reason,
  String? baseUrl, {
  bool allowPublicHttp = false,
  String? kind,
}) => _sendHumanError(
  reason,
  baseUrl,
  allowPublicHttp: allowPublicHttp,
  kind: kind,
);

StateError _sendHumanError(
  String? reason,
  String? baseUrl, {
  bool allowPublicHttp = false,
  String? kind,
}) {
  final why = (reason == null || reason.trim().isEmpty)
      ? 'send failed'
      : reason.trim();
  if (why == 'no_note') return StateError(kErrNoSealedNote);
  final whyLow = why.toLowerCase();
  if (why == kErrPoolHtml ||
      whyLow.contains('<html') ||
      whyLow.contains('<!doctype') ||
      whyLow.contains('formatexception') ||
      whyLow.contains('unexpected character')) {
    return StateError(kErrPoolHtml);
  }
  if (why == 'admit_link_tag' || why == 'admit') {
    return StateError(kErrNoteSpent);
  }
  if (why == 'admit_mismatch' || why == 'fs1_not_owner') {
    return StateError(reserveReasonCopy(why));
  }
  const named = {
    'stake_reward',
    'portal_exists',
    'mint_amount',
    'vote_retired',
    'bad_amount',
    'epoch_open',
    'proof_reuse',
    'double_mint',
    'claim_cap',
    'vote_cap',
    'retire_cap',
  };
  if (named.contains(why)) return StateError(reserveReasonCopy(why));
  if (why == 'range_proof' || why == 'commit_sum') return StateError(kErrRangeProof);
  if (why == 'unsigned' &&
      (kind == 'lock' || kind == 'vote' || kind == 'withdraw' || kind == 'roll')) {
    return StateError(kErrLockUnsigned);
  }
  final url = baseUrl ?? '';
  // An explicit public-HTTP allow keeps the server reason.
  if (url.contains('pool.shear.digital') && !allowPublicHttp) {
    return StateError(kErrPublicHttp);
  }
  return StateError(why);
}

String formatHashBonusShe(int nanos) {
  final n = nanos < 0 ? 0 : nanos;
  return (n / kUnitsPerShe).toStringAsFixed(11);
}

/// Continuum hash-bonus meter: earned confirmed hash, never "unit(s)".
String continuumHashBonusLabel({int? emittedNanos}) =>
    '${formatHashBonusShe(emittedNanos ?? 0)} SHE earned';

/// Amounts-only / no destProof: keep local owner notes and hash landings.
bool keepLocalOwnerHistory({
  required bool amountsOnly,
  required bool destProof,
}) => amountsOnly && destProof != true;

class ShearTx {
  const ShearTx({
    required this.id,
    required this.from,
    required this.to,
    required this.amount,
    required this.kind,
    this.height,
    this.confirmed = true,
    this.memo = false,
    this.memoPlain,
    this.memoCt,
    this.rounds,
    this.hashAmount,
    this.threads,
    this.pot,
    this.change,
    this.atMs,
  });

  final String id;
  final String from;
  final String to;
  final double amount;
  final String kind;
  final int? height;
  final bool confirmed;
  final bool memo;
  final String? memoPlain;
  final Map<String, dynamic>? memoCt;
  final int? rounds;
  final double? hashAmount;
  final int? threads;

  /// Sealed Path 1 pot SHE when this row is a coinbase bundle. Null if none.
  final double? pot;

  /// Newly derived dest that received leftover. Never [from] or the portal.
  final String? change;

  /// Sealed header timestamp (ms) when known. ShearView date column.
  final int? atMs;

  Map<String, dynamic> toJson() => {
    'id': id,
    'from': from,
    'to': to,
    'amount': amount,
    'kind': kind,
    'height': height,
    'confirmed': confirmed,
    'memo': memo,
    if (memoPlain != null) 'memoPlain': memoPlain,
    if (memoCt != null) 'memoCt': memoCt,
    if (rounds != null) 'rounds': rounds,
    if (hashAmount != null) 'hashAmount': hashAmount,
    if (threads != null) 'threads': threads,
    if (pot != null) 'pot': pot,
    if (change != null) 'change': change,
    if (atMs != null) 'atMs': atMs,
  };

  ShearTx copyWith({bool? confirmed, int? height}) => ShearTx(
    id: id,
    from: from,
    to: to,
    amount: amount,
    kind: kind,
    height: height ?? this.height,
    confirmed: confirmed ?? this.confirmed,
    memo: memo,
    memoPlain: memoPlain,
    memoCt: memoCt,
    rounds: rounds,
    hashAmount: hashAmount,
    threads: threads,
    pot: pot,
    change: change,
    atMs: atMs,
  );

  bool get isHashReward => kind == 'hash';

  bool get isBlockBundle =>
      kind == 'coinbase' ||
      kind == 'blockfound' ||
      kind == 'block' ||
      kind == 'pot' ||
      kind == 'mine';

  factory ShearTx.fromJson(Map<String, dynamic> j) {
    final kind = j['kind']?.toString() ?? '';
    final amount = shearTxAmountFromJson(j);
    var from = j['from']?.toString() ?? '';
    if (from.isEmpty &&
        (kind == 'coinbase' ||
            kind == 'blockfound' ||
            kind == 'block' ||
            kind == 'pot' ||
            kind == 'hash')) {
      from = 'coinbase';
    }
    return ShearTx(
      id: j['id']?.toString() ?? '',
      from: from,
      to: j['to']?.toString() ?? '',
      amount: amount,
      kind: kind,
      height: (j['height'] as num?)?.toInt(),
      confirmed: j['confirmed'] is bool ? j['confirmed'] as bool : true,
      memo: j['memo'] == true,
      memoPlain: j['memoPlain']?.toString(),
      memoCt: j['memoCt'] is Map
          ? Map<String, dynamic>.from(j['memoCt'] as Map)
          : null,
      rounds: (j['rounds'] as num?)?.toInt(),
      hashAmount:
          (j['hashAmount'] as num?)?.toDouble() ??
          (j['hashNanos'] is num && (j['hashNanos'] as num) > 0
              ? (j['hashNanos'] as num).toDouble() / kUnitsPerShe
              : null) ??
          (kind == 'hash' && amount > 0 ? amount : null),
      threads: (j['threads'] as num?)?.toInt(),
      pot:
          (j['pot'] as num?)?.toDouble() ??
          (j['potNanos'] is num && (j['potNanos'] as num) > 0
              ? (j['potNanos'] as num).toDouble() / kUnitsPerShe
              : null),
      change: j['change']?.toString(),
      atMs:
          (j['atMs'] as num?)?.toInt() ??
          (j['ms'] as num?)?.toInt() ??
          (j['timestamp'] as num?)?.toInt(),
    );
  }
}

/// Owner history may ship `amount` (SHE) or `nanos`. Never treat a nanos-only
/// dest-opened row as a zero ShearView sum.
double shearTxAmountFromJson(Map<String, dynamic> j) {
  final amount = (j['amount'] as num?)?.toDouble();
  if (amount != null && amount > 0) return amount;
  final nanos = j['nanos'];
  if (nanos is num && nanos > 0) return nanos / kUnitsPerShe;
  return amount ?? 0;
}

bool isWalletBlockKind(String kind) =>
    kind == 'blockfound' ||
    kind == 'coinbase' ||
    kind == 'block' ||
    kind == 'pot' ||
    kind == 'mine';

/// Read-only Path 1 observation: sealed pots only. Does not mint.
class Path1Observation {
  const Path1Observation({
    required this.quantumShe,
    required this.targetIntervalMs,
    required this.integralQShe,
    this.observedIntervalMs,
  });

  final double quantumShe;
  final int targetIntervalMs;
  final double integralQShe;
  final int? observedIntervalMs;

  double get targetFluxShePerMs =>
      targetIntervalMs <= 0 ? 0 : quantumShe / targetIntervalMs;
}

/// verified-headers.json beside the session file. Both slash styles.
String verifiedHeaderStorePath(String sessionPath) {
  if (sessionPath.isEmpty) return '';
  final slash = sessionPath.lastIndexOf('/');
  final back = sessionPath.lastIndexOf('\\');
  final cut = slash > back ? slash : back;
  if (cut <= 0) return '';
  return '${sessionPath.substring(0, cut)}${sessionPath[cut]}verified-headers.json';
}

int? headerTimestampMs(Uint8List header) {
  if (header.length < 108) return null;
  var v = 0;
  for (var i = 7; i >= 0; i--) {
    v = (v << 8) | header[100 + i];
  }
  if (v <= 0) return null;
  return v;
}

/// Sealed coinbase pot SHE from one already-listed explorer/history row.
/// Hash bonus and bundled receive-settlement coinbase are not the pot.
double? sealedPotShe(ShearTx t) {
  final h = t.height ?? 0;
  if (h < 1) return null;
  final kind = t.kind;
  if (kind == 'hash' ||
      kind == 'send' ||
      kind == 'receive' ||
      kind == 'claim') {
    return null;
  }
  if (t.pot != null) return t.pot! > 0 ? t.pot : null;
  if (kind == 'pot') return t.amount;
  if (kind == 'blockfound' || kind == 'mine' || kind == 'block') {
    final pot = t.amount - (t.hashAmount ?? 0);
    if (pot <= 0) return null;
    return pot;
  }
  if (kind == 'coinbase' && t.hashAmount != null) {
    final pot = t.amount - t.hashAmount!;
    if (pot <= 0) return null;
    return pot;
  }
  return null;
}

/// Fold sealed pot vouts the wallet already lists. Pending/unconfirmed templates
/// (no sealed height) are excluded. Q is the sum of those pots, not a mint.
Path1Observation foldSealedPots(
  Iterable<ShearTx> txs, {
  double quantumShe = kBlockPotShe,
  int targetIntervalMs = kTargetBlockIntervalMs,
  int? observedIntervalMs,
}) {
  var q = 0.0;
  for (final t in txs) {
    final p = sealedPotShe(t);
    if (p == null) continue;
    q += p;
  }
  return Path1Observation(
    quantumShe: quantumShe,
    targetIntervalMs: targetIntervalMs,
    integralQShe: q,
    observedIntervalMs: observedIntervalMs,
  );
}

/// Wallet lists: full blocks only. Hash rewards live inside the block row.
String walletTxLabel(ShearTx t) => isWalletBlockKind(t.kind) ? 'block' : t.kind;

bool isFlowTransfer(ShearTx t) => t.kind == 'send' || t.kind == 'receive';

/// Owner ShearView landings: Flow + π auto-pay + dest-owned hash folded into the block.
bool isOwnerLanding(ShearTx t) =>
    isFlowTransfer(t) ||
    t.kind == 'pool-withdraw' ||
    t.kind == 'blockfound' ||
    t.kind == 'coinbase';

bool isReservePendingKind(ShearTx t) => t.kind == 'lock' || t.kind == 'vote';

/// Continuum pending vortex remark. Sender: sending. Recipient: receive.
String continuumPendingRemark(ShearTx t, {required bool outgoing}) {
  if (t.kind == 'send') return 'sending';
  if (t.kind == 'pool-withdraw') return outgoing ? 'sending' : 'receiving';
  if (t.kind == 'receive') return outgoing ? 'sending' : 'receive';
  return walletTxLabel(t);
}

/// Shearview kind after 1 conf. Pending remarks drop at 6: sent / received.
String shearviewKindLabel(
  ShearTx t, {
  required bool outgoing,
  required int confs,
}) {
  if (t.kind == 'pool-withdraw') {
    if (confs >= ShearLedger.continuumConfirmations)
      return outgoing ? 'sent' : 'received';
    return outgoing ? 'sending' : 'receiving';
  }
  if (!isFlowTransfer(t)) return walletTxLabel(t);
  if (confs >= ShearLedger.continuumConfirmations)
    return outgoing ? 'sent' : 'received';
  return outgoing ? 'sending' : 'receiving';
}

/// Owner ShearView list: height, status, sums. Never blank amount for the owner.
String shearviewListTitle(
  ShearTx t, {
  required int confs,
  required bool outgoing,
  bool depthPending = false,
}) {
  final kind = shearviewKindLabel(t, outgoing: outgoing, confs: confs);
  final h = t.height ?? 0;
  // Depth still catching the host: incoming stays pending, with no count.
  if (depthPending &&
      !outgoing &&
      confs < ShearLedger.continuumConfirmations) {
    return 'pending  $kind  ${formatShe(t.amount)} SHE';
  }
  // No verified tip yet: pending, and no confirmation count.
  if (h < 1 || confs < 1) return 'pending  $kind  ${formatShe(t.amount)} SHE';
  final pending = confs >= 1 && confs < ShearLedger.continuumConfirmations;
  final status = pending ? 'pending  $kind' : kind;
  return 'h=$h  $status  ${formatShe(t.amount)} SHE';
}

/// Owner ShearView list: from/to, date, snippet. Never blank dest for the owner.
String shearviewListSubtitle(
  ShearTx t, {
  int? tipMs,
  int? tipHeight,
  required int confs,
}) {
  final from = t.from.isEmpty ? '—' : t.from;
  final to = t.to.isEmpty ? '—' : t.to;
  return '$from → $to  ${shearviewDate(t, tipMs: tipMs, tipHeight: tipHeight)}  ${shearviewSnippet(t)}';
}

String shearviewDate(ShearTx t, {int? tipMs, int? tipHeight}) {
  final ms = t.atMs;
  if (ms != null && ms > 0) {
    return DateTime.fromMillisecondsSinceEpoch(
      ms,
      isUtc: true,
    ).toIso8601String();
  }
  final h = t.height ?? 0;
  if (tipMs != null && tipHeight != null && h > 0 && tipHeight >= h) {
    final est = tipMs - (tipHeight - h) * kTargetBlockIntervalMs;
    if (est > 0)
      return DateTime.fromMillisecondsSinceEpoch(
        est,
        isUtc: true,
      ).toIso8601String();
  }
  return h > 0 ? 'block $h' : 'pending';
}

String shearviewSnippet(ShearTx t) {
  final memo = t.memoPlain?.trim() ?? '';
  if (memo.isNotEmpty) return memo;
  if ((t.hashAmount ?? 0) > 0) {
    return 'hashbonus ${formatShe(t.hashAmount!)} SHE';
  }
  if (t.kind == 'pool-withdraw') return 'π auto-pay landing';
  if (t.kind == 'blockfound' || t.kind == 'coinbase' || t.kind == 'block')
    return 'block landing';
  return t.kind;
}

/// A block row that only repeats a pool-fee already listed for this dest and
/// height. Hash inside a real found block is not this mirror.
bool isFeeBlockMirror(ShearTx block, Iterable<ShearTx> rows) {
  if (!isWalletBlockKind(block.kind)) return false;
  if ((block.hashAmount ?? 0) > 1e-12) return false;
  if (block.amount <= 1e-12) return false;
  final h = block.height ?? 0;
  for (final row in rows) {
    if (row.kind != 'pool-fee' || row.to != block.to) continue;
    if ((row.height ?? 0) != h) continue;
    if ((row.amount - block.amount).abs() <= 1e-9) return true;
  }
  return false;
}

/// Fold per-hash / pot / mine rows into one block row per dest+height.
/// Open-round hashes (no height) are not a block yet and are omitted.
/// Two views of one coinbase keep the larger pot. They do not add.
/// Hash notes still sum: each one is its own bonus inside that block.
/// A coinbase whose amount is only the pool-fee is left off the list.
List<ShearTx> rollupExplorerTxs(Iterable<ShearTx> txs) {
  final rest = <ShearTx>[];
  final blocks =
      <
        String,
        ({String dest, int height, double pot, double hash, int threads})
      >{};
  for (final t in txs) {
    final kind = t.kind;
    if (kind == 'hash' && (t.height ?? 0) < 1) continue;
    if (kind == 'hash' ||
        kind == 'coinbase' ||
        kind == 'pot' ||
        kind == 'mine' ||
        kind == 'blockfound' ||
        kind == 'block') {
      final dest = t.to;
      final height = t.height ?? 0;
      final key = '$dest|$height';
      final prev =
          blocks[key] ??
          (dest: dest, height: height, pot: 0.0, hash: 0.0, threads: 0);
      var pot = prev.pot;
      var hash = prev.hash;
      var threads = prev.threads;
      final amt = t.amount;
      if (kind == 'hash') {
        hash += amt;
        threads += t.threads ?? 0;
      } else if (kind == 'mine' || kind == 'blockfound' || kind == 'block') {
        final rowPot = amt - (t.hashAmount ?? 0);
        if (rowPot > pot) pot = rowPot;
        final rowHash = t.hashAmount ?? 0;
        if (rowHash > hash) hash = rowHash;
        final n = t.threads ?? t.rounds ?? 0;
        if (n > threads) threads = n;
      } else if (amt > pot) {
        pot = amt;
      }
      blocks[key] = (
        dest: dest,
        height: height,
        pot: pot,
        hash: hash,
        threads: threads,
      );
      continue;
    }
    rest.add(t);
  }
  for (final b in blocks.values) {
    if (b.hash <= 1e-12 &&
        rest.any(
          (t) =>
              t.kind == 'pool-fee' &&
              t.to == b.dest &&
              (t.height ?? 0) == b.height &&
              (t.amount - b.pot).abs() <= 1e-9,
        )) {
      continue;
    }
    rest.add(
      ShearTx(
        id: b.dest.isEmpty
            ? 'blockfound:${b.height}'
            : 'blockfound:${b.height}:${b.dest}',
        from: 'coinbase',
        to: b.dest,
        amount: b.pot + b.hash,
        kind: 'blockfound',
        height: b.height,
        confirmed: true,
        hashAmount: b.hash,
        threads: b.threads > 0 ? b.threads : null,
        pot: b.pot > 0 ? b.pot : null,
      ),
    );
  }
  return rest;
}

/// One Shearview line. A hash bonus paid inside a block is [child] of that pot.
class ShearviewTreeRow {
  const ShearviewTreeRow({required this.tx, this.child = false});

  final ShearTx tx;
  final bool child;
}

/// Block pot share is the parent. Hash bonuses sealed in that block are children.
/// The parent amount is the pot alone. Parent plus children equal the sealed sum.
List<ShearviewTreeRow> shearviewTree(Iterable<ShearTx> rows) {
  final out = <ShearviewTreeRow>[];
  for (final t in rows) {
    final hash = t.hashAmount ?? 0;
    final block =
        t.kind == 'blockfound' || t.kind == 'coinbase' || t.kind == 'block';
    if (!block || hash <= 0) {
      out.add(ShearviewTreeRow(tx: t));
      continue;
    }
    final potRaw = (t.pot != null && t.pot! > 0) ? t.pot! : t.amount - hash;
    final pot = potRaw > 1e-15 ? potRaw : 0.0;
    out.add(
      ShearviewTreeRow(
        tx: ShearTx(
          id: t.id,
          from: t.from,
          to: t.to,
          amount: pot,
          kind: t.kind,
          height: t.height,
          confirmed: t.confirmed,
          memo: t.memo,
          memoPlain: t.memoPlain,
          memoCt: t.memoCt,
          pot: pot,
          atMs: t.atMs,
          rounds: t.rounds,
          threads: t.threads,
          change: t.change,
        ),
      ),
    );
    out.add(
      ShearviewTreeRow(
        child: true,
        tx: ShearTx(
          id: '${t.id}:hashbonus',
          from: 'coinbase',
          to: t.to,
          amount: hash,
          kind: 'hash',
          height: t.height,
          confirmed: t.confirmed,
          atMs: t.atMs,
        ),
      ),
    );
  }
  return out;
}

/// Shearview query over id, dest, kind, amount, height, and memo.
bool shearviewMatches(ShearTx t, String query) {
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return true;
  final hay = <String>[
    t.id,
    t.from,
    t.to,
    t.kind,
    formatShe(t.amount),
    '${t.amount}',
    '${t.height ?? ''}',
    t.memoPlain ?? '',
  ].join(' ').toLowerCase();
  return hay.contains(q);
}

/// Spendable at block-found only. Per-hash credit sits in [pending] until confirm.
/// Cheap header verdict. [wait] means MTP samples are still below the walk.
enum _WalkCheap { ok, reject, wait, later }

/// Result of proving a competing branch. A lighter honest fork is not a failure.
/// [partial] keeps the branch for a later pass. Nothing is written yet.
enum _ForkProof { switched, lighter, invalid, partial }

class ShearLedger implements ReadProofSink {
  ShearLedger({this.pool}) {
    pool?.sync?.proofSink = this;
  }

  final ShearPoolClient? pool;
  bool _sendInFlight = false;

  /// One in-flight Continuum send. A second call returns false until [endSend].
  bool beginSend() {
    if (_sendInFlight) return false;
    _sendInFlight = true;
    return true;
  }

  void endSend() {
    _sendInFlight = false;
  }

  final Map<String, double> _spendable = {};

  /// Session header nanos. Never copied into [_spendable].
  final Map<String, double> _advisorySpendable = {};

  /// Accepted Reserve locks still sitting in the verified note sum.
  final Map<String, double> _lockDebitShe = {};
  final Map<String, BigInt> _lockDebitNanos = {};
  final Map<String, double> _reserveHeldShe = {};
  final Map<String, BigInt> _reserveHeldNanos = {};
  Future<int>? _payoutConsolidate;
  int _payoutConsolidateRounds = 0;

  /// Owned sealed notes (commit, noteCommit, r, prev, index, admit x). Reserve vault excepted.
  final List<Map<String, dynamic>> _notes = [];

  /// Opened proofs for this wallet only, keyed by commit|R|z. Digit strings.
  final Map<String, String> _openedProofs = {};

  /// Commit hex already accepted on this device. A follow skips those rows.
  final Set<String> _acceptedCommits = {};

  /// True after a saved book was restored. Spendable can paint before the network.
  bool restoredBook = false;

  /// Commits the node listed on the last complete notes read. Empty if that read failed.
  final List<String> _listedCommits = [];

  /// Dests whose notes carried a complete value proof this session.
  final Set<String> _proofCheckedDests = {};

  /// External balances written before any value proof opened. Not spendable.
  final Set<String> _unverifiedExternal = {};

  /// SHE a pool snapshot wrote while no value proof had opened. Subtracted
  /// from the book so a null cap cannot paint that figure.
  final Map<String, double> _externalShe = {};

  /// One address that receives coins and that change returns to.
  String? _coinLedger;
  List<Map<String, dynamic>> get notes => List.unmodifiable(_notes);

  List<Map<String, dynamic>> exportOpenedProofs() => [
    for (final e in _openedProofs.entries)
      {'k': e.key, 'n': e.value.toString()},
  ];

  /// Verified notes for the encrypted session. The follow spec does not carry
  /// this list. The worker reads it from the session file.
  List<Map<String, dynamic>> exportNotesForSession() {
    final out = <Map<String, dynamic>>[];
    for (final n in _notes) {
      if (n['verified'] != true) continue;
      final encoded = _followEncode(n);
      if (encoded is Map) {
        final row = Map<String, dynamic>.from(encoded);
        for (final key in const ['nanos', 'verifiedNanos']) {
          final v = row[key];
          if (v is int) row[key] = v.toString();
        }
        out.add(row);
      }
    }
    return out;
  }

  int get notesCovered => _notesCovered;

  /// Paint spendable and pending from notes this device already accepted.
  /// Does not open a proof and does not talk to the network.
  void restoreSessionNotes(
    Object? raw, {
    int covered = 0,
    String? paymentCode,
  }) {
    final revived = _followRevive(raw);
    if (revived is List) {
      for (final item in revived) {
        if (item is! Map) continue;
        final row = Map<String, dynamic>.from(item);
        if (row['verified'] != true) continue;
        rememberNote(row);
        _rememberProofRow(row);
        final dest = (row['dest'] ?? row['address'])?.toString() ?? '';
        if (dest.isNotEmpty) {
          _proofCheckedDests.add(payKey(dest));
          rememberDest(dest);
        }
        final commit = _noteBytes(row['commit']);
        if (commit != null && commit.isNotEmpty)
          _acceptedCommits.add(_bytesHex(commit));
      }
    }
    if (covered > _notesCovered) _notesCovered = covered;
    if (_notes.isEmpty) return;
    restoredBook = true;
    _openCollated = true;
    // A saved book is not a notes read in this process. Spendable stays hidden
    // until the selected source answers.
    _replayOpenedNotes();
    final rest = _restFrame;
    if (rest != null && rest.isNotEmpty) {
      recheckRestFrameSpendable(rest, paymentCode: paymentCode);
    }
  }

  void restoreOpenedProofs(Object? raw) {
    _openedProofs
      ..clear()
      ..addAll(proofCacheMap(raw));
  }

  bool get spendableReadFailed => _spendableReadFailed == true;

  void _rememberProofRow(Map<String, dynamic> row) {
    final key = row['proofKey']?.toString() ?? '';
    final nanos = sessionProofNanos(row['verifiedNanos'] ?? row['nanos']);
    if (key.isEmpty || nanos == null) return;
    _openedProofs[key] = nanos;
  }

  /// Portal ids seen on the chain. A restored wallet has no lock notes, so the
  /// next index is the first seed-derived portal that is not in this set.
  final Set<String> _chainPortalIds = {};

  void noteChainPortals(Iterable<String> ids) {
    for (final id in ids) {
      final hex = id.toLowerCase();
      if (RegExp(r'^[0-9a-f]{64}$').hasMatch(hex)) _chainPortalIds.add(hex);
    }
  }

  /// Inclusive end of the lock-change restore scan. Notes and chain portal ids
  /// set the high-water mark. The floor stays 0 through 63.
  int _lockChangeScanEnd() {
    final indices = <int>[];
    for (final note in _notes) {
      final idx = note['lockIndex'];
      if (idx is int && idx >= 0) indices.add(idx);
    }
    return lockChangeIndexEnd(
      spendSeed: spendSeed,
      noteIndices: indices,
      portalIds: _chainPortalIds,
    );
  }

  /// Next unused lock index. Recovery scans the seed; a new lock must not reuse one.
  int _nextLockIndex() {
    var max = -1;
    var bare = 0;
    for (final note in _notes) {
      if ((note['kind'] ?? '').toString() != 'lock') continue;
      final idx = note['lockIndex'];
      if (idx is int) {
        if (idx > max) max = idx;
      } else {
        bare++;
      }
    }
    if (bare - 1 > max) max = bare - 1;
    final seed = spendSeed;
    if (seed != null && seed.length == 32) {
      final last = _lockChangeScanEnd();
      for (var i = 0; i <= last; i++) {
        final id = reservePortalIdFromSeed('', seed, i);
        if (id != null && _chainPortalIds.contains(id.toLowerCase()) && i > max) max = i;
      }
    }
    return max + 1;
  }

  /// Next lock index a restored wallet would use. Chain portal ids count.
  int get nextLockIndex => _nextLockIndex();

  /// Rebuild lock leaves from the master secret and the public tranche book.
  /// A portal the wallet already stored is left as it is.
  void rememberDerivedLockLeaves(Iterable<dynamic> tranches) {
    final seed = spendSeed;
    if (seed == null || seed.length != 32) return;
    final epochsOf = <String, List<int>>{};
    final commitOf = <String, List<Uint8List>>{};
    for (final raw in tranches) {
      if (raw is! Map) continue;
      final id = raw['portalId']?.toString().toLowerCase() ?? '';
      if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(id)) continue;
      final epoch = raw['epoch'];
      if (epoch is int && epoch >= 0) (epochsOf[id] ??= <int>[]).add(epoch);
      final commit = _hexToBytes(raw['commit']);
      if (commit != null && commit.length == 32) (commitOf[id] ??= <Uint8List>[]).add(commit);
    }
    noteChainPortals(epochsOf.keys);
    final end = lockChangeIndexEnd(
      spendSeed: seed,
      portalIds: epochsOf.keys.toSet(),
    );
    for (var i = 0; i <= end; i++) {
      final id = reservePortalIdFromSeed('', seed, i);
      if (id == null) continue;
      final key = id.toLowerCase();
      if (!epochsOf.containsKey(key)) continue;
      var known = false;
      for (final note in _notes) {
        if ((note['kind'] ?? '').toString() != 'lock') continue;
        if (note['scalar'] == null || note['blind'] == null || note['note'] == null) continue;
        if ((note['portalId'] ?? '').toString().toLowerCase() == key) known = true;
      }
      if (known) continue;
      final ownerSeed = reservePortalSpendSeed(seed, i);
      if (ownerSeed == null) continue;
      final scalar = vaultLockOwnerBytes(ownerSeed, i);
      final blind = vaultLockBlindBytes(ownerSeed, i, kPiSheNanos, 0);
      final want = commitOf[key] ?? const <Uint8List>[];
      Uint8List? leaf;
      var unlock = 0;
      var lockEpoch = epochsOf[key]!.first;
      for (var epoch = 0; epoch < 8; epoch++) {
        final period = consensusUnlockPeriod(epoch);
        final note = vaultLeafNote(amount: kPiSheNanos, scalar: scalar, blind: blind, unlock: period);
        if (note.length != 64) continue;
        final commit = Uint8List.sublistView(note, 32, 64);
        final hit = want.isEmpty || want.any((row) => _bytesEq(row, commit));
        if (!hit) continue;
        leaf = note;
        unlock = period;
        lockEpoch = epoch;
        break;
      }
      if (leaf == null) continue;
      rememberNote({
        'kind': 'lock',
        'scalar': scalar,
        'blind': blind,
        'note': leaf,
        'unlock': unlock,
        'amount': kPiSheNanos,
        'nanos': kPiSheNanos,
        'epochs': epochsOf[key],
        'lockEpoch': lockEpoch,
        'lockIndex': i,
        'portalId': id,
        'dest20': reservePortalDest20FromSeed(seed, i),
        'vaultLock': true,
        'verified': true,
      });
    }
  }

  /// Keep the lock note's blind. The chain drops it, and the spend needs it
  /// once the epoch ends.
  void _rememberTimeLock(List<Map<String, dynamic>> sealed, String dest) {
    if (!isDestAddress(dest)) return;
    for (final o in sealed) {
      if ((o['kind'] ?? '').toString() != 'lock') continue;
      final unlock = o['unlockAtMs'];
      if (unlock is! int || unlock <= 0) continue;
      if (!noteIsFs1Leaf(_noteBytes(o['admitPub']), _noteBytes(o['commit'])))
        continue;
      final row = <String, dynamic>{
        'address': dest,
        'dest': dest,
        'kind': 'lock',
        'commit': o['commit'],
        'noteCommit': o['noteCommit'],
        'r': o['r'],
        'admitPub': o['admitPub'],
        'unlockAtMs': unlock,
        if (o['lockEpoch'] != null) 'lockEpoch': o['lockEpoch'],
        if (o['lockIndex'] is int) 'lockIndex': o['lockIndex'],
        if (o['portalId'] != null) 'portalId': o['portalId'],
        if (o['portalId'] != null || o['lockIndex'] is int) 'vaultLock': true,
        if (o['dest20'] != null) 'dest20': o['dest20'],
        if (o['valueProof'] != null) 'valueProof': o['valueProof'],
        if (o['rangeProof'] != null) 'rangeProof': o['rangeProof'],
        if (o['nanos'] != null) 'nanos': o['nanos'],
        'verified': true,
      };
      final units = tryU64Units(o['nanos']);
      if (units != null) {
        final she = _sheOfExactNanos(units.toString());
        if (she != null) row['amount'] = she;
      }
      row['locked'] = lockNoteIsLocked(row, tipTimestampMs);
      rememberNote(row);
      rememberDest(dest);
      _proofCheckedDests.add(payKey(dest));
    }
  }

  /// R28 "This wallet mines" (Russell D4). Off by default. Only when on are
  /// block records scanned for this wallet's winner and fee notes.
  final BluMiningScanner blu = BluMiningScanner();

  /// Scan in place. The credit worker is already off the UI isolate, and
  /// tests read the result at once.
  bool bluScanInline = false;

  /// The scan still running off the UI isolate, if any.
  Future<void>? bluScanInFlight;

  bool get bluMining => blu.enabled;

  /// Turn the mining scan on or off. On forgets what was scanned and rescans
  /// the blocks already read, from [birthHeight] (0 is the whole chain).
  /// Off stops new scans; notes already found are real coins and stay.
  void setBluMining(bool on, {int? birthHeight}) {
    if (birthHeight != null && birthHeight >= 0) blu.birthHeight = birthHeight;
    final was = blu.enabled;
    blu.enabled = on;
    if (!on || was) return;
    blu.reset();
    // The blocks the last read handed this book (all read blocks on the
    // node sync path). Later reads scan the rest.
    if (_nodeBodies.isNotEmpty) ingestBluRecords(List<Map<String, dynamic>>.from(_nodeBodies));
  }

  /// Record notes of [blocks] that belong to this wallet join the book as
  /// FS-1 notes on the home dest. A note at a height whose record changed
  /// (a reorg) is marked reorged and leaves Spendable.
  void ingestBluRecords(List blocks) {
    final keys = bluRecordKeysByHeight(blocks);
    if (keys.isNotEmpty) {
      for (final n in _notes) {
        if (!isBluNoteKind(n['kind'] as String?)) continue;
        final h = (n['height'] as num?)?.toInt() ?? 0;
        final now = keys[h];
        if (now == null) continue;
        n['reorged'] = now != n['bluRecord'];
      }
    }
    final seed = spendSeed;
    if (!blu.enabled || seed == null || seed.length != 32) return;
    final todo = blu.pending(blocks);
    if (todo.isEmpty) return;
    blu.markScanned(todo);
    final input = <String, dynamic>{
      'seed': Uint8List.fromList(seed),
      'records': [
        for (final t in todo) {'height': t['height'], 'record': t['record']},
      ],
    };
    if (bluScanInline) {
      _applyBluRows(scanBluRecordsWire(input));
      return;
    }
    final prior = bluScanInFlight ?? Future<void>.value();
    bluScanInFlight = prior.then((_) async {
      final rows = await Isolate.run(() => scanBluRecordsWire(input));
      _applyBluRows(rows);
    }).catchError((Object _) {
      // The scan did not finish: scan these records again on the next read.
      blu.reset();
    });
  }

  void _applyBluRows(List<Map<String, dynamic>> rows) {
    final frame = _restFrame;
    if (rows.isEmpty || frame == null || frame.isEmpty) return;
    final dest = homeDest(frame);
    if (!isDestAddress(dest)) return;
    for (final w in rows) {
      final v = BigInt.parse(w['v'] as String);
      final kind = w['kind'] as String;
      final row = <String, dynamic>{
        'kind': kind,
        'address': dest,
        'dest': dest,
        'height': w['height'],
        'commit': w['C'],
        'admitPub': w['P'],
        'noteCommit': w['R'],
        'r': w['rho'],
        'nanos': v.bitLength < 63 ? v.toInt() : v.toString(),
        'amount': v.toDouble() / kUnitsPerShe,
        'verified': true,
        'bluRecord': w['recordKey'],
        'reorged': false,
        if ((w['m'] as int? ?? 0) > 0) 'bluM': w['m'],
      };
      final have = _notes.any((n) {
        final c = _noteBytes(n['commit']);
        return c != null && _bytesEq(c, w['C'] as Uint8List);
      });
      // A note this book already holds keeps its spent flag.
      if (!have) row['spent'] = false;
      rememberNote(row);
      _creditNoteToShearview(row);
    }
    rememberDest(dest);
    _proofCheckedDests.add(payKey(dest));
    recheckRestFrameSpendable(frame);
  }

  void rememberNote(Map<String, dynamic> note) {
    final incoming = Map<String, dynamic>.from(note);
    final commit = _noteBytes(incoming['commit']);
    if (commit != null) {
      for (var i = 0; i < _notes.length; i++) {
        final have = _noteBytes(_notes[i]['commit']);
        if (have != null && _bytesEq(have, commit)) {
          _notes[i] = {..._notes[i], ...incoming};
          return;
        }
      }
    }
    _notes.add(incoming);
  }

  /// Put opened proofs on this book. A note is spendable only after its proof
  /// opens and it has [spendableConfirmations] against the known live tip.
  /// A failed proof and a bare `{v}` stay unverified. An unread height is skipped.
  @override
  void ingestReadOpen(
    ReadBlockOpen open, {
    required List blocks,
    String? dest,
  }) {
    rememberNodeChain(
      bodies: [
        for (final b in blocks)
          if (b is Map) Map<String, dynamic>.from(b),
      ],
    );
    if (open.liveTip >= 1) noteLiveHeight(open.liveTip);
    creditKnownNodeLands();
    ingestChainTxs([
      for (final block in blocks)
        if (block is Map && block['txs'] is List)
          for (final tx in block['txs'] as List) tx,
    ], dest: dest);
    ingestBluRecords(blocks);
    final frame = (dest != null && dest.isNotEmpty) ? dest : (_restFrame ?? '');
    if (frame.isEmpty && open.opened.every((n) => n.dest.isEmpty)) return;
    final fallback = frame.isEmpty
        ? ''
        : (isDestAddress(frame) ? frame : homeDest(frame));
    final used = <Map>[];
    var credited = false;
    for (final opened in open.opened) {
      if (!opened.verified || opened.nanos <= 0 || opened.commit.isEmpty)
        continue;
      final raw = _takeReadNote(blocks, opened, used);
      if (raw == null) continue;
      final tagged = opened.dest.isNotEmpty
          ? opened.dest
          : (_rowDest(raw) ?? fallback);
      if (tagged.isEmpty || !isDestAddress(tagged)) continue;
      final row = <String, dynamic>{
        ...raw,
        'address': tagged,
        'dest': tagged,
        'height': opened.height,
        'nanos': opened.nanos,
        'verified': true,
        'spent': false,
      };
      if ((row['kind'] ?? '').toString() == 'lock') {
        row['locked'] = lockNoteIsLocked(row, tipTimestampMs);
      }
      if (!noteIsFs1Leaf(
        _noteBytes(row['admitPub']),
        _noteBytes(row['commit']),
      ))
        continue;
      rememberNote(row);
      _creditNoteToShearview(row);
      rememberDest(tagged);
      _proofCheckedDests.add(payKey(tagged));
      credited = true;
    }
    if (fallback.isNotEmpty) _unverifyFailedRead(open, fallback);
    if (credited && frame.isNotEmpty) recheckRestFrameSpendable(frame);
  }

  /// The vout whose commit is the one [opened] verified. A failed or foreign
  /// output with the same value is a different note.
  Map<String, dynamic>? _takeReadNote(
    List blocks,
    OpenedReadNote opened,
    List<Map> used,
  ) {
    if (opened.commit.isEmpty) return null;
    for (final block in blocks) {
      if (block is! Map || readBlockHeight(block) != opened.height) continue;
      for (final note in _readVouts(block)) {
        if (used.any((u) => identical(u, note))) continue;
        final commit = _noteBytes(note['commit']);
        if (commit == null || !_bytesEq(commit, opened.commit)) continue;
        final claim = _verifiedClaimNanos(note);
        if (claim == null || claim != opened.nanos) continue;
        used.add(note);
        return Map<String, dynamic>.from(note);
      }
    }
    return null;
  }

  List<Map> _readVouts(Map block) {
    final out = <Map>[];
    void take(dynamic list) {
      if (list is! List) return;
      for (final item in list) {
        if (item is Map) out.add(item);
      }
    }

    final txs = block['txs'];
    if (txs is List) {
      for (final tx in txs) {
        if (tx is! Map) continue;
        for (final key in const ['vout', 'vouts', 'notes']) {
          take(tx[key]);
        }
      }
    }
    if (out.isNotEmpty) return out;
    for (final key in const ['notes', 'vouts', 'vout']) {
      take(block[key]);
    }
    return out;
  }

  /// A failed proof at a height stays unverified even when its value equals
  /// an opened note at that same height. The opened commit is left alone.
  void _unverifyFailedRead(ReadBlockOpen open, String money) {
    if (open.unspendable.isEmpty) return;
    final openedByHeight = <int, List<Uint8List>>{};
    for (final n in open.opened) {
      if (n.commit.isEmpty) continue;
      (openedByHeight[n.height] ??= <Uint8List>[]).add(n.commit);
    }
    final badHeights = <int>{for (final u in open.unspendable) u.height};
    for (final row in _notes) {
      final h = (row['height'] as num?)?.toInt() ?? 0;
      if (!badHeights.contains(h) || !_noteOnDest(row, money)) continue;
      final commit = _noteBytes(row['commit']);
      final openedHere = openedByHeight[h] ?? const <Uint8List>[];
      if (commit != null && openedHere.any((c) => _bytesEq(c, commit)))
        continue;
      row['verified'] = false;
    }
  }

  bool _bytesEq(Uint8List a, Uint8List b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  String? _restFrame;

  /// Bind spend seed so Copy dest carries B and sealed vouts can be unwrapped.
  /// Public she1 is a fingerprint (no spendPub in the payload). Derive the
  /// long-term spend pub from the seed so homeDest is destCommit, not destForLogin.
  void bindIdentity(ShearIdentity ident) {
    _openCollated = false;
    _restFrame = ident.address;
    viewSecret = ident.viewKey;
    spendPub = decodePaymentCode(ident.paymentCode)?['spendPub'];
    admitBase = decodePaymentCode(ident.paymentCode)?['admitBase'];
    final seed = hexToBytes(ident.seedHex);
    if (seed.length == 32) {
      spendSeed = seed;
      spendPub ??= ed25519PublicFromSeed(seed);
      admitBase ??= admitBaseBytes(seed);
    }
    if (!_headerMacReady &&
        _pin != null &&
        (_headerStorePath ?? '').isNotEmpty) {
      _chainLoaded = false;
      _loadVerifiedChain();
    }
  }

  Map<String, dynamic> _sealedScanInput(
    List<dynamic> vouts, {
    required Uint8List spendSeed,
    String? dest,
    Uint8List? prev,
    int startIndex = 0,
  }) =>
      {
        'vouts': vouts,
        'dests': _dests.toList(),
        'dest': dest,
        'spendSeed': spendSeed,
        'seenCommitHex': [
          for (final n in _notes)
            if (_noteBytes(n['commit']) != null) _bytesHex(_noteBytes(n['commit'])!),
        ],
        'txHints': [
          for (final t in _txs)
            {'to': t.to, 'kind': t.kind, 'height': t.height, 'amount': t.amount},
        ],
        'prev': prev,
        'startIndex': startIndex,
        'openedProofs': exportOpenedProofs(),
        'lockChangeEnd': _lockChangeScanEnd(),
      };

  void _applySealedScan(Map<String, dynamic> out) {
    final notes = out['notes'];
    if (notes is List) {
      for (final n in notes) {
        if (n is Map) {
          final row = Map<String, dynamic>.from(n);
          if (!noteIsFs1Leaf(
            _noteBytes(row['admitPub']),
            _noteBytes(row['commit']),
          ))
            continue;
          rememberNote(row);
          _rememberProofRow(row);
          if (row['proofChecked'] == true) {
            final dest = (row['dest'] ?? row['address'])?.toString() ?? '';
            if (dest.isNotEmpty) _proofCheckedDests.add(payKey(dest));
          }
          _creditNoteToShearview(row);
        }
      }
    }
    final unopened = out['unopenedProofs'];
    if (unopened is num && unopened > 0) {
      _unopenedListedProofs += unopened.toInt();
    }
    final folds = out['hashFolds'];
    final frame = _restFrame;
    if (frame != null && frame.isNotEmpty) consolidateIncomingRewards(frame);
    if (folds is! List) return;
    for (final raw in folds) {
      if (raw is! Map) continue;
      final matched = raw['matched']?.toString() ?? '';
      final she = (raw['she'] as num?)?.toDouble() ?? 0;
      final h = (raw['height'] as num?)?.toInt() ?? 0;
      if (matched.isEmpty || she <= 0) continue;
      rememberDest(matched);
      final id = 'blockfound:$h:$matched';
      final iTx = _txs.indexWhere((t) => t.id == id);
      if (iTx >= 0) {
        final t = _txs[iTx];
        _txs[iTx] = ShearTx(
          id: t.id,
          from: t.from.isNotEmpty ? t.from : 'coinbase',
          to: t.to.isNotEmpty ? t.to : matched,
          amount: t.amount + she,
          kind: t.kind,
          height: t.height ?? (h > 0 ? h : t.height),
          confirmed: t.confirmed,
          memo: t.memo,
          memoPlain: t.memoPlain,
          memoCt: t.memoCt,
          rounds: t.rounds,
          hashAmount: (t.hashAmount ?? 0) + she,
          threads: t.threads,
          pot: t.pot,
          change: t.change,
        );
      } else {
        _txs.add(
          ShearTx(
            id: id,
            from: 'coinbase',
            to: matched,
            amount: she,
            kind: 'blockfound',
            height: h,
            confirmed: h > 0 && confirmationsOf(h) >= spendableConfirmations,
            hashAmount: she,
          ),
        );
      }
      if (h > 0) {
        _immature.add((dest: matched, amount: she, height: h));
      }
    }
    final again = _restFrame;
    if (again != null && again.isNotEmpty) consolidateIncomingRewards(again);
  }

  /// Turn an unwrapped dest-owned note into a ShearView row so open collate
  /// does not wait for a later history/incoming delta. Hash folds stay in
  /// [_applySealedScan]. Existing dest+height rows are filled, not duplicated.
  void _creditNoteToShearview(Map<String, dynamic> note) {
    if (!noteIsFs1Leaf(
      _noteBytes(note['admitPub']),
      _noteBytes(note['commit']),
    ))
      return;
    final dest = (note['dest'] ?? note['address'])?.toString() ?? '';
    if (dest.isEmpty) return;
    final kind = (note['kind'] as String?) ?? 'receive';
    if (kind == 'hash' || kind == 'dummy') return;
    num? amt = note['amount'] as num?;
    if (amt == null && note['nanos'] is num) {
      amt = (note['nanos'] as num) / kUnitsPerShe;
    }
    if (amt == null || amt <= 0) return;
    final h = (note['height'] as num?)?.toInt();
    final isBlock = isWalletBlockKind(kind);
    final commit = _noteBytes(note['commit']);
    final tag = commit != null && commit.isNotEmpty
        ? _bytesHex(
            commit,
          ).substring(0, commit.length < 8 ? commit.length * 2 : 16)
        : '${dest.hashCode}';
    final existing = _txs.indexWhere((t) {
      if (t.to != dest) return false;
      if ((t.height ?? 0) != (h ?? 0)) return false;
      if (isBlock) return isWalletBlockKind(t.kind);
      // Two record notes at one height are two coins: match by id only.
      if (isBluNoteKind(kind)) return t.id == 'note:$h:$dest:$tag';
      return t.kind == 'receive' || t.kind == kind || t.kind == 'send';
    });
    final id = existing >= 0
        ? _txs[existing].id
        : (isBlock && h != null && h > 0
              ? 'blockfound:$h:$dest'
              : (h != null && h > 0
                    ? 'note:$h:$dest:$tag'
                    : 'note-pending:$dest:$tag'));
    var atMs = _headerTimestampMs;
    if (atMs != null && h != null && h > 0 && _sealedHeight >= h) {
      atMs = atMs - (_sealedHeight - h) * kTargetBlockIntervalMs;
    } else if (h == null || h < 1) {
      atMs = null;
    }
    mergeChainTx(
      ShearTx(
        id: id,
        from: isBlock ? 'coinbase' : (note['from']?.toString() ?? 'pending'),
        to: dest,
        amount: amt.toDouble(),
        kind: isBlock ? 'blockfound' : (kind == 'send' ? 'receive' : kind),
        height: h,
        confirmed:
            h != null && h > 0 && confirmationsOf(h) >= spendableConfirmations,
        atMs: atMs,
      ),
    );
  }

  /// Opened notes are the pending rows. A follow that shipped spendable
  /// without the tx list must not leave those coins off the list.
  void _replayOpenedNotes() {
    for (final n in _notes) {
      if (n['verified'] != true && n['proofChecked'] != true) continue;
      final amt = n['amount'];
      if (amt is! num || amt <= 0) continue;
      _creditNoteToShearview(Map<String, dynamic>.from(n));
    }
  }

  /// Scan compacted vouts (chain persist drops r). Match noteCommit to dest20, unwrap rEph/rCt.
  /// Tests call this synchronously; the 1 Hz/full-sync path uses [Isolate.run] on [scanSealedVouts].
  void ingestSealedVouts(
    List<dynamic> vouts, {
    required Uint8List spendSeed,
    String? dest,
    Uint8List? prev,
    int startIndex = 0,
    List<Uint8List>? feeCommits,
  }) {
    _applySealedScan(scanSealedVouts({
      ..._sealedScanInput(
        vouts,
        spendSeed: spendSeed,
        dest: dest,
        prev: prev,
        startIndex: startIndex,
      ),
      if (feeCommits != null) 'feeCommits': feeCommits,
    }));
  }

  final List<Uint8List> _chainOutputCommits = [];
  final Set<String> _chainOutputCommitHex = {};

  void _rememberOutputCommit(dynamic raw) {
    final b = _noteBytes(raw);
    if (b == null || b.length < 32) return;
    final one = Uint8List.fromList(b.sublist(0, 32));
    if (!_chainOutputCommitHex.add(_bytesHex(one))) return;
    _chainOutputCommits.add(one);
  }

  /// Vote-change fee candidates. Chain outputs seen so far, plus commits of
  /// notes this wallet already holds. A fee note from before the rescan, or
  /// one restored with the book, is still a candidate.
  List<Uint8List> _voteFeeCommits() {
    final out = <Uint8List>[];
    final seen = <String>{};
    void add(Uint8List? raw) {
      if (raw == null || raw.length < 32) return;
      final one = Uint8List.fromList(raw.sublist(0, 32));
      if (!seen.add(_bytesHex(one))) return;
      out.add(one);
    }
    for (final c in _chainOutputCommits) {
      add(c);
    }
    for (final n in _notes) {
      add(_noteBytes(n['commit']));
    }
    return out;
  }

  /// Scan chain txs. portalId and withdrawNonce come from the tx. A vote
  /// change is recovered from output commits already seen, not from a new
  /// wire field. Lock portal ids stay noted after the tranche book drops them.
  void ingestChainTxs(List<dynamic> txs, {String? dest}) {
    final seed = spendSeed;
    if (seed == null || seed.length != 32 || txs.isEmpty) return;
    final portals = <String>[];
    var vote = false;
    final interesting = <Map<String, dynamic>>[];
    for (final raw in txs) {
      if (raw is! Map) continue;
      final kind = (raw['kind'] ?? '').toString();
      if (kind == 'leaf-vote' || kind == 'vote') vote = true;
      final pid = (raw['portalId'] ?? '').toString().toLowerCase();
      if (RegExp(r'^[0-9a-f]{64}$').hasMatch(pid)) portals.add(pid);
      for (final key in const ['vout', 'vouts', 'notes']) {
        final list = raw[key];
        if (list is! List) continue;
        for (final item in list) {
          if (item is! Map) continue;
          _rememberOutputCommit(item['commit']);
          final outPid = (item['portalId'] ?? '').toString().toLowerCase();
          if (RegExp(r'^[0-9a-f]{64}$').hasMatch(outPid)) portals.add(outPid);
        }
      }
      if (kind == 'lock' || kind == 'leaf-vote' || kind == 'vote' || kind == 'withdraw' || pid.isNotEmpty) {
        interesting.add(Map<String, dynamic>.from(raw));
      }
    }
    if (portals.isNotEmpty) noteChainPortals(portals);
    if (interesting.isEmpty) return;
    final home = (dest != null && dest.isNotEmpty) ? dest : _restFrame;
    ingestSealedVouts(
      stampChainScanVouts(interesting),
      spendSeed: seed,
      dest: home,
      feeCommits: vote ? _voteFeeCommits() : null,
    );
  }

  final Map<String, double> _pending = {};
  final List<ShearTx> _txs = [];
  final Set<String> _dests = {};
  final Map<String, Uint8List> _stealthShared = {};
  final Set<String> _vaultDests = {};
  final Set<String> _spentHistory = {};

  /// Next dest height (tip sealed height + 1).
  int tipHeight = 1;

  /// continuity_root of the sealed tip (lag-1 for the next dest).
  Uint8List? lag1Root;

  /// How many indexed she1 dests this wallet has minted (always ≥ 1).
  int destCount = 1;

  /// Selected dest index (0 .. destCount-1).
  int destIndex = 0;
  int _sealedHeight = 0;

  /// Height whose header this wallet checked. Zero means depth is unknown.
  int _verifiedTip = 0;

  /// Last height whose open-round pending was settled. Display [sealedHeight]
  /// can run ahead (1s tip poll); settlement uses this so confirmRound still
  /// fires after syncTip.
  int _settledHeight = 0;
  final Map<String, int> _historyAt = {};
  final Map<String, int> _notesAt = {};

  /// Highest height a notes response has covered. The header may sit above it.
  /// Spendable and Pending use this until the next response catches up.
  int _notesCovered = 0;

  /// Empty history/notes pulls while an immature owner land is still absent.
  final Map<String, int> _ingestMisses = {};
  static const ingestMissBudget = 2;
  final List<Map<String, dynamic>> _nodeBodies = [];
  final List<Map<String, dynamic>> _nodeHistoryRows = [];
  final List<Map<String, dynamic>> _nodeNoteRows = [];

  /// Heights in the latest tip gap with no owner land in node material.
  final List<int> honestLandMisses = [];
  bool tipAdvancedWithoutLanding = false;

  /// Node compact bodies, history rows, and notes already opened. Replaces
  /// each list that is passed. Pool balance is not stored here.
  void rememberNodeChain({
    List<Map<String, dynamic>>? bodies,
    List<Map<String, dynamic>>? history,
    List<Map<String, dynamic>>? notes,
  }) {
    if (bodies != null) {
      _nodeBodies
        ..clear()
        ..addAll(bodies);
    }
    if (history != null) {
      _nodeHistoryRows
        ..clear()
        ..addAll(history);
    }
    if (notes != null) {
      _nodeNoteRows
        ..clear()
        ..addAll(notes);
    }
  }

  /// Census the wallet already stored from a compact coinbase.
  /// A missing epoch is not epoch 0 and is not open height 0.
  ({int epoch, int leafCount, int openHeight})? epochCensus(int epoch) {
    if (epoch < 0) return null;
    final heights = <int, Map<String, dynamic>>{};
    for (final block in _nodeBodies) {
      final h = (block['height'] as num?)?.toInt() ?? 0;
      if (h < 1) continue;
      heights[h] = block;
    }
    final order = heights.keys.toList()..sort();
    for (final h in order) {
      final txs = heights[h]!['txs'];
      if (txs is! List) continue;
      for (final tx in txs) {
        if (tx is! Map || tx['coinbase'] != true) continue;
        final rows = tx['epochCensusCommit'];
        if (rows is! List) continue;
        for (final row in rows) {
          if (row is! Map) continue;
          final at = (row['epoch'] as num?)?.toInt();
          final leaves = (row['leafCount'] as num?)?.toInt();
          final open = (row['openHeight'] as num?)?.toInt();
          if (at == null || at != epoch || leaves == null || open == null) continue;
          if (leaves < 1 || open < 0) continue;
          return (epoch: at, leafCount: leaves, openHeight: open);
        }
      }
    }
    return null;
  }

  bool historyStamped(String address) {
    final key = payKey(address);
    return _sealedHeight >= 1 && _historyAt[key] == _sealedHeight;
  }

  bool notesStamped(String address) {
    final key = payKey(address);
    return _sealedHeight >= 1 && _notesAt[key] == _sealedHeight;
  }

  /// The tip moved after the last notes pull. Pending stays empty unless
  /// that pull runs again and credits the new pool-fee and receive rows.
  bool get notesBehindSealedTip {
    if (_sealedHeight < 1 || !_openCollated) return false;
    if (_notesAt.isEmpty) return true;
    return _notesAt.values.any((h) => h != _sealedHeight);
  }

  /// Closure Apply. The same book keeps the opened-note cursor and the tip.
  /// A genesis or magic change drops the cursor so the next read starts clean.
  /// Verified coins stay until that new book replaces them.
  void onClosureApply({bool bookChanged = false}) {
    if (!bookChanged) return;
    _historyAt.clear();
    _notesAt.clear();
    _notesCovered = 0;
    _acceptedCommits.clear();
    restoredBook = false;
    _ingestMisses.clear();
  }

  Set<String> _landDests({String? extraDest}) {
    final dests = <String>{..._dests};
    final frame = _restFrame;
    if (frame != null && frame.isNotEmpty) {
      final home = homeDest(frame);
      if (home.isNotEmpty) dests.add(home);
    }
    if (extraDest != null && extraDest.isNotEmpty) dests.add(extraDest);
    dests.removeWhere((d) => d.isEmpty || _isProgramVaultDest(d));
    return dests;
  }

  List<NodeOwnerLand> _openedOwnerLands({String? extraDest}) {
    return ownerLandsFromNode(
      bodies: _nodeBodies,
      history: _nodeHistoryRows,
      notes: _nodeNoteRows,
      moneyDests: _landDests(extraDest: extraDest),
    );
  }

  bool immatureOwnerLandsMissing(String address) {
    final key = payKey(address);
    for (final land in _openedOwnerLands(extraDest: address)) {
      if (land.dest != key && payKey(land.dest) != key && land.dest != address)
        continue;
      if (confirmationsOf(land.height) >= spendableConfirmations) continue;
      final have = _txs.any(
        (t) =>
            isWalletBlockKind(t.kind) &&
            (t.height ?? 0) == land.height &&
            (t.to == land.dest || payKey(t.to) == key),
      );
      if (!have) return true;
    }
    return false;
  }

  bool _stampIngest(String key, {bool count = true}) {
    final missing = immatureOwnerLandsMissing(key);
    final misses = _ingestMisses[key] ?? 0;
    final ok = mayStampIngestCaughtUp(
      landsMissing: missing,
      misses: misses,
      budget: ingestMissBudget,
    );
    if (!count) return ok;
    if (!missing || ok) {
      if (!missing) _ingestMisses.remove(key);
    } else {
      _ingestMisses[key] = misses + 1;
    }
    return ok;
  }

  String _ownerLandKey(String dest, int height) => '${payKey(dest)}|$height';

  /// One immature row per node/history land. A tx inserted by history must
  /// still enroll, or [settleTo] never moves it into spendable.
  void _enrollOwnerLand({
    required String dest,
    required double amount,
    required int height,
  }) {
    if (height < 1 || amount <= 0 || dest.isEmpty) return;
    final pk = payKey(dest);
    final key = _ownerLandKey(pk, height);
    if (_landSettled.contains(key) || _landEnrolled.contains(key)) return;
    _landEnrolled.add(key);
    final already = _immature.any(
      (r) => r.height == height && payKey(r.dest) == pk,
    );
    if (!already) {
      _immature.add((dest: pk, amount: amount, height: height));
    }
  }

  void _ensureOwnerLandRow(NodeOwnerLand land) {
    final id = 'blockfound:${land.height}:${land.dest}';
    final candidate = ShearTx(
      id: id,
      from: 'coinbase',
      to: land.dest,
      amount: land.amount,
      kind: land.kind == 'mine' ? 'mine' : 'blockfound',
      height: land.height,
      confirmed: false,
    );
    if (isFeeBlockMirror(candidate, _txs)) return;
    final have = _txs.any(
      (t) =>
          t.id == id ||
          (isWalletBlockKind(t.kind) &&
              (t.height ?? 0) == land.height &&
              (t.to == land.dest || payKey(t.to) == payKey(land.dest))),
    );
    if (!have) {
      _txs.add(
        ShearTx(
          id: id,
          from: 'coinbase',
          to: land.dest,
          amount: land.amount,
          kind: land.kind == 'mine' ? 'mine' : 'blockfound',
          height: land.height,
          confirmed: false,
        ),
      );
      rememberDest(land.dest);
    }
    _enrollOwnerLand(dest: land.dest, amount: land.amount, height: land.height);
  }

  /// Credit every node land in (before, tip]. A height with none is a miss.
  void creditNodeLandsInGap({
    required int before,
    required int tip,
    String? extraDest,
  }) {
    final plan = planTipGap(
      before: before,
      tip: tip,
      opened: _openedOwnerLands(extraDest: extraDest),
    );
    honestLandMisses
      ..clear()
      ..addAll(plan.misses);
    for (final land in plan.lands) {
      _ensureOwnerLandRow(land);
    }
  }

  /// Lands already in node material, including heights outside the latest gap.
  void creditKnownNodeLands() {
    for (final land in _openedOwnerLands()) {
      _ensureOwnerLandRow(land);
    }
  }

  int _bookedLandCount() => _txs.where((t) => isWalletBlockKind(t.kind)).length;

  /// A pool-fee or a real receive at [height] is a landing. The 0.01 block
  /// mirror of a pool-fee is not, so the notes pull keeps going.
  bool _realCreditAt(int height) {
    if (height < 1) return false;
    for (final t in _txs) {
      if ((t.height ?? 0) != height) continue;
      if (t.kind == 'hash' || t.kind == 'sample') continue;
      if (isFeeBlockMirror(t, _txs)) continue;
      if (t.kind == 'pool-fee' ||
          t.kind == 'receive' ||
          t.kind == 'send' ||
          isWalletBlockKind(t.kind)) {
        return true;
      }
    }
    return false;
  }

  /// Failed note pulls while spendable is ahead of the sealed book.
  /// Stop the background retry after two misses at this height; Pay still forces one.
  final Map<String, int> _noteMisses = {};

  /// First unlock notes-then-history collate finished. Thin pending-receive
  /// ticks must not skip that first full pull.
  bool _openCollated = false;

  /// Null until login's notes read finishes. True when that read did not
  /// return a note list. A failed read is not a verified zero.
  bool? _spendableReadFailed;

  /// Complete proofs (commit, R, z) this scan matched and did not open.
  /// A `{v}`-only row is not counted. While this is above zero and no coin
  /// opened, the screen stays on "…" instead of a confident 0 SHE.
  int _unopenedListedProofs = 0;

  /// This follow received a notes list, including an empty one.
  bool _scannedNotesThisFollow = false;

  /// The credit follow threw or the notes list never arrived.
  void noteSpendableReadFailed() {
    _spendableReadFailed = true;
  }

  String _collateError = '';
  bool get openCollated => _openCollated;

  /// Height-1 header hex of the book this ledger is bound to.
  String? _chainGenesis;

  String? get chainGenesis => _chainGenesis;

  /// Restore a previously persisted genesis without wiping the book.
  void restoreChainGenesis(String genesis) {
    final g = genesis.trim().toLowerCase();
    if (g.isEmpty) return;
    _chainGenesis = g;
  }

  /// Set after shewall import. Sync must pull notes at and below this tip.
  bool _rescanBelowSealed = false;

  bool get rescanBelowSealed => _rescanBelowSealed;

  /// Last known sealed tip from shewall. Never apply 0 over a remembered height.
  /// The notes cursor is cleared so the next sync reads below this height.
  void restoreSealedTip(int height, {String? genesis}) {
    if (genesis != null && genesis.trim().isNotEmpty)
      restoreChainGenesis(genesis);
    final h = height;
    if (h < 1) return;
    if (h > _sealedHeight) _sealedHeight = h;
    if (h + 1 > tipHeight) tipHeight = h + 1;
    _notesAt.clear();
    _rescanBelowSealed = true;
  }

  /// Bind to the live book's genesis. A different genesis (testnet reset or
  /// testnet→mainnet) drops leftover txs/credits so Continuum cannot keep
  /// painting the prior chain. An old session archive has no genesis: the
  /// first live bind still wipes leftover rows.
  void bindChainGenesis(String genesis) {
    final g = genesis.trim().toLowerCase();
    if (g.isEmpty) return;
    if (_chainGenesis == g) return;
    if (_chainGenesis != null || _txs.isNotEmpty) {
      _resetChainBook();
    }
    _chainGenesis = g;
  }

  void _resetChainBook() {
    _txs.clear();
    _spendable.clear();
    _advisorySpendable.clear();
    _notes.clear();
    _proofCheckedDests.clear();
    _unverifiedExternal.clear();
    _externalShe.clear();
    _pending.clear();
    _immature.clear();
    _landEnrolled.clear();
    _landSettled.clear();
    _settledNodeShe.clear();
    _owedPiDisplay = 0;
    _historyAt.clear();
    _notesAt.clear();
    _notesCovered = 0;
    _acceptedCommits.clear();
    restoredBook = false;
    _noteMisses.clear();
    _ingestMisses.clear();
    _nodeBodies.clear();
    _nodeHistoryRows.clear();
    _nodeNoteRows.clear();
    honestLandMisses.clear();
    tipAdvancedWithoutLanding = false;
    _openCollated = false;
    _openedProofs.clear();
    _sealedHeight = 0;
    _verifiedTip = 0;
    _headerHostTip = 0;
    _settledHeight = 0;
    _checkedHeaders.clear();
    _chainLoaded = false;
    _sealedPending = null;
    _sealedPriors = const [];
    _sealedWork = null;
    _resumePriorTimes = const [];
    _resumePriorOrigin = null;
    _prunedWork = BigInt.zero;
    _reorgHintFrom = null;
    _seedCheckpoint();
    lag1Root = null;
    tipHeight = 1;
  }

  int? _headerTimestampMs;
  int? _prevHeaderTimestampMs;

  /// Network circulating supply from pool /api/stats. Continuum Integral Q.
  int? circulatingNanos;

  /// Positive supply only. A 0 from a thin stats body must not wipe a live figure.
  void applyCirculatingNanos(Object? raw) {
    if (raw is! num) return;
    final n = raw.round();
    if (n > 0) circulatingNanos = n;
  }

  /// Network-wide stats from /api/stats (Continuum right-hand box).
  int? networkHashrate;

  /// Unpacked work bits from pool stats. Not the packed blockBits integer.
  double? networkWorkBits;

  /// Height that [potEmittedNanos] was counted through. Same stats body.
  int? emittedAtHeight;

  /// Sealed-chain mean block time, the explorer average. Not the last gap.
  int? sealedMeanBlockMs;
  int? liveHashBonusNanos;
  int? extraMintedNanos;
  int? vaultLockedNanos;
  int? potEmittedNanos;
  int? hashBonusEmittedNanos;
  int? networkBits;
  int? networkMiners;

  /// Mean interval of every sealed block on the book (from pool /api/stats).
  int? _avgBlockTimeMs;

  /// Last found/sealed block height (Continuum header).
  int get sealedHeight => _sealedHeight;

  /// One height for the user: live tip if the node is ahead of last paint.
  int get displayHeight {
    if (pool != null && isPoolLedgerHost(pool!.baseUrl)) return _sealedHeight;
    final live = pool?.liveTip ?? 0;
    return live > _sealedHeight ? live : _sealedHeight;
  }

  /// Confirmation depth for Spendable and the planner. A host `/stats`
  /// height is not this. Zero means the depth is unknown, so a note that
  /// carries a height is not spendable.
  int get bookTip => _verifiedTip;

  /// Why a send cannot be funded. Unknown header depth is not a short note.
  /// A pin makes [bookTip] non-zero while backfill is still behind the host.
  /// A sealed note excluded only by that gap is still [kErrHeaderSync].
  /// Spendable coins that cannot cover [amount], while depth-pending notes
  /// would, are the same wait — not a short balance.
  StateError fundsRefusal([double amount = 0]) {
    if (bookTip < 1) return StateError(kErrHeaderSync);
    var spendableSum = 0.0;
    var depthSum = 0.0;
    var anySpendable = false;
    for (final n in _notes) {
      final she = _noteSheOf(n, 0);
      if (_noteIsSpendable(n)) {
        anySpendable = true;
        spendableSum += she;
      } else if (headerDepthPending && _noteIsSpendable(n, ignoreConfs: true)) {
        depthSum += she;
      }
    }
    final withDepth = spendableSum + depthSum;
    if (headerDepthPending &&
        spendableSum + 1e-12 < amount &&
        withDepth + 1e-12 >= amount) {
      return StateError(kErrHeaderSync);
    }
    // This wallet's own unmined change would cover it: Pending, not short.
    final changePending = _unminedNoteShe({
      for (final n in _notes) ...{
        (n['address'] ?? n['dest'])?.toString() ?? '',
      },
    }..remove(''));
    if (changePending > 0 &&
        spendableSum + 1e-12 < amount &&
        withDepth + changePending + 1e-12 >= amount) {
      return StateError(kErrChangePending);
    }
    if (anySpendable) return StateError('insufficient');
    if (headerDepthPending &&
        depthSum > 0 &&
        withDepth + 1e-12 >= amount) {
      return StateError(kErrHeaderSync);
    }
    return StateError(kErrNoSealedNote);
  }

  /// A settled round is not a note. Drop it from the painted book once a
  /// Flow send has refused it, so Spendable stops claiming that cover.
  void _releaseUnbackedSpendable(
    String src, {
    String? restFrame,
    String? paymentCode,
  }) {
    final keys = <String>{payKey(src)};
    if (restFrame != null) {
      for (final d in moneyDests(restFrame, paymentCode: paymentCode)) {
        if (isDestAddress(d)) keys.add(payKey(d));
      }
    }
    for (final key in keys) {
      if (!isDestAddress(key)) continue;
      _spendable[key] = inventoriedNoteShe(key, sum: true);
    }
  }

  /// Header depth is still short of the host, so a confirmation count would
  /// describe an unverified tip. Incoming rows stay pending with no count.
  bool confirmationCountHidden(int height) {
    if (bookTip < 1) return true;
    if (!headerDepthPending) return false;
    return confirmationsOf(height) < continuumConfirmations;
  }

  /// The checked chain is behind the host tip, or the verify line is up.
  /// A sealed note waiting only on that gap is not a short balance.
  bool get headerDepthPending {
    if (headerVerifyLine != null) return true;
    final pin = _pin;
    return pin != null && _headerHostTip > bookTip && _headerHostTip > pin.height;
  }

  /// First-run catch-up. Null once the checked chain has reached the host.
  /// A missing native hasher is its own line, not a stuck `0/N`.
  String? get headerVerifyLine {
    final pin = _pin;
    final host = _headerHostTip;
    final behind = pin != null && host > bookTip && host > pin.height;
    if (_hasherMissing && behind) return 'ShearHash unavailable';
    if (!behind) return null;
    final done = bookTip - pin.height;
    final total = host - pin.height;
    if (done < 0 || total < 1 || done >= total) return null;
    return 'Verifying headers $done/$total';
  }

  /// The host has stopped moving this fork. The shell can say so.
  String? get headerStallLine => _forkStallPasses >= _kForkStallPasses
      ? 'host not serving headers'
      : null;

  /// The native library did not hash a header. Tests set [hostTip] to show
  /// the line without waiting on a host.
  void reportHeaderHasherMissing({int? hostTip}) {
    _hasherMissing = true;
    if (hostTip != null && hostTip > _headerHostTip) _headerHostTip = hostTip;
    final paint = onHeaderProgress;
    if (paint != null) paint();
  }

  /// Paints [headerVerifyLine] on the shell. The line is the only chrome.
  void Function()? onHeaderProgress;

  /// Desktop P2P, Solo, or own-node. [height] is that node's own checked tip.
  /// Connect bare does not call this.
  void noteNodeCheckedTip(int height) {
    if (height < 1) return;
    if (height > _verifiedTip) _verifiedTip = height;
  }

  /// Release checkpoint. Empty until [installCheckpoint]. A host header cannot fill it.
  CheckpointPin? _pin;
  String? _headerStorePath;
  bool _chainLoaded = false;

  /// Verifier clock for the future-time bound. Tests pin it. Production uses
  /// the wall clock.
  int? _headerNowMs;

  final List<({int height, Uint8List hash, int timeMs, String headerHex})>
  _checkedHeaders = [];
  final Map<String, Uint8List> _v3Ready = {};

  /// The credit worker is already off the UI isolate.
  bool _v3HashInline = false;

  /// Host height the current catch-up is walking toward.
  int _headerHostTip = 0;

  /// Native ShearHash-v3 did not load. The progress line says so.
  bool _hasherMissing = false;

  /// True once a vault key has been used to read the header file.
  bool _headerMacReady = false;

  /// Host reorg list: refetch this height. Not a depth change.
  int? _reorgHintFrom;

  /// Sealed rows waiting for an off-UI recheck before the tip may rise.
  List<({int height, int timeMs, Uint8List header})>? _sealedPending;

  /// Priors and cumulative work that belong to [_sealedPending].
  List<int> _sealedPriors = const [];
  String? _sealedWork;

  /// Ten header times immediately before the oldest saved row, oldest first.
  /// The MAC covers them. MTP for the resumed tail reads them.
  List<int> _resumePriorTimes = const [];
  int? _resumePriorOrigin;

  /// Work of headers pruned out of the retained window. The tail's work is
  /// added on top. A fork from the pin is weighed against the sum.
  BigInt _prunedWork = BigInt.zero;

  /// One header read. A stalled host must release the catch-up pass.
  Duration headerReadTimeout = const Duration(seconds: 5);

  /// One fork walk. Past this, the pass returns and the next one continues.
  Duration headerWalkDeadline = const Duration(seconds: 8);

  /// First wait after a host's fork proof fails. Later failures double it.
  Duration forkProofBackoff = const Duration(seconds: 1);

  /// Headers one fork attempt may fetch and hash. The rest wait for the next.
  int forkWalkCap = 64;

  /// Native ShearHash calls on this ledger. A trivial-bits fork stays at zero.
  int headerHashCount = 0;

  /// Fork walks that got past the per-host backoff. Tests watch the replay stop.
  int forkProofAttempts = 0;

  int? _forkClockMs;
  final Map<String, ({int untilMs, int step})> _forkBackoff = {};
  String? _forkResumeHost;

  /// Hash of the lowest header still on this walk. A new tip does not change it.
  String? _forkResumeBottom;
  List<({int height, Uint8List header})>? _forkResumeBranch;

  /// Branch headers already proved, from the bottom. Digests stay in memory.
  int _forkResumeProved = 0;

  /// ShearHash results for headers that proved. A reject does not drop them.
  final Map<String, Uint8List> _forkDigests = {};

  /// Branch ids this host already failed. The same header bytes are not walked again.
  final Map<String, List<String>> _forkBanned = {};

  /// Host tip at which those ids were banned. A higher tip clears them.
  final Map<String, int> _forkBannedAtTip = {};

  /// Header hashes on the branch being proved. Eviction skips these.
  final Set<String> _forkPinnedDigests = {};

  int _forkStallPasses = 0;
  int? _forkStallBottom;
  int? _forkStallTop;
  int _forkStallProved = 0;
  int _forkStallLen = 0;
  int _forkStallHashes = 0;
  int _forkHostTipSeen = 0;

  /// Test clock for fork backoff and the walk deadline. Header time is separate.
  void bindForkClock(int nowMs) {
    _forkClockMs = nowMs;
  }

  int _forkNowMs() => _forkClockMs ?? DateTime.now().millisecondsSinceEpoch;

  /// One catch-up per ledger. A second caller waits for this pass.
  Future<int>? _catchUpFlight;

  /// One Isolate.run hash at a time on this ledger.
  Future<void>? _hashTail;

  static const int _kHeaderAheadMs = 15000;
  static const int _kMtpFutureMs = 2 * 60 * 60 * 1000;
  static const int _kMtpWindow = 11;
  static const int _kHeaderBackfillCap = 32;

  /// Resume anchor: the pin plus at least an 11-header MTP window.
  static const int _kHeaderKeep = 16;

  /// Digests kept for headers that are not on the open branch.
  /// The branch being proved is exempt, so a fork longer than this still
  /// finishes. The pin is the only floor.
  static const int _kForkDigestCap = 8192;

  /// Rejected branch ids remembered per host.
  static const int _kBannedForks = 64;

  /// Empty passes with the same bottom before the shell says the host stalled.
  static const int _kForkStallPasses = 4;

  /// Tests shrink this. The open branch is not limited by it.
  int forkDigestCap = _kForkDigestCap;

  int get _chainTip {
    var tip = 0;
    for (final row in _checkedHeaders) {
      if (row.height > tip) tip = row.height;
    }
    return tip;
  }

  /// Install a release checkpoint. This block is the anchor. Later headers
  /// still have to link, pass MTP and the future-time bound, and meet ASERT.
  void installCheckpoint(CheckpointPin pin, {String? storePath}) {
    if (!checkpointPinWellFormed(pin)) return;
    _pin = pin;
    if (storePath != null && storePath.isNotEmpty) _headerStorePath = storePath;
    _checkedHeaders.clear();
    _chainLoaded = false;
    _resumePriorTimes = const [];
    _resumePriorOrigin = null;
    _prunedWork = BigInt.zero;
    _sealedPending = null;
    _sealedPriors = const [];
    _sealedWork = null;
    _seedCheckpoint();
    _loadVerifiedChain();
  }

  /// Where the verified header chain is stored. Loaded once a pin is installed.
  void bindHeaderStore(String path) {
    if (path.isEmpty) return;
    _headerStorePath = path;
    _chainLoaded = false;
    if (_pin != null) _loadVerifiedChain();
  }

  void _installReleaseCheckpoint() {
    if (_pin != null || kCheckpointIsPlaceholder) return;
    if (!checkpointPinWellFormed(kReleaseCheckpoint)) return;
    installCheckpoint(kReleaseCheckpoint);
  }

  void _seedCheckpoint() {
    final pin = _pin;
    if (pin == null) return;
    final hash = _hexToBytes(pin.hashHex);
    if (hash == null) return;
    _rememberChecked(pin.height, hash, pin.timeMs, headerHex: '');
    if (pin.height > _verifiedTip) _verifiedTip = pin.height;
  }

  /// Test clock for the header future-time bound.
  void bindHeaderClock(int nowMs) {
    if (nowMs > 0) _headerNowMs = nowMs;
  }

  /// FlyClient does not move spendable depth. A sample counts only when
  /// [catchUpVerifiedChain] accepts the header onto the linked chain.
  void noteVerifiedHeight(int height) {
    if (height < 1) return;
  }

  int _headerVersion(Uint8List header) =>
      header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24);

  int _headerBits(Uint8List header) {
    var bits = 0;
    for (var i = 0; i < 4; i++) {
      bits |= header[108 + i] << (8 * i);
    }
    return bits;
  }

  bool _prevEquals(Uint8List header, Uint8List hash) {
    if (hash.length != 32) return false;
    for (var i = 0; i < 32; i++) {
      if (header[4 + i] != hash[i]) return false;
    }
    return true;
  }

  ({int height, Uint8List hash, int timeMs, String headerHex})? _checkedAt(
    int height,
  ) {
    for (final row in _checkedHeaders) {
      if (row.height == height) return row;
    }
    return null;
  }

  int? _timeAt(int height) {
    final row = _checkedAt(height);
    if (row != null) return row.timeMs;
    final pin = _pin;
    if (pin != null) {
      final age = pin.height - height;
      if (age >= 1 && age <= pin.priorTimesMs.length) {
        return pin.priorTimesMs[pin.priorTimesMs.length - age];
      }
    }
    final origin = _resumePriorOrigin;
    if (origin != null && _resumePriorTimes.length == 10) {
      final idx = height - origin;
      if (idx >= 0 && idx < _resumePriorTimes.length) {
        return _resumePriorTimes[idx];
      }
    }
    return null;
  }

  int _medianTimes(List<int> times) {
    if (times.isEmpty) return 0;
    final sorted = List<int>.from(times)..sort();
    return sorted[(sorted.length - 1) ~/ 2];
  }

  /// Prev link, 11-header MTP, and the future-time bound. No hash yet.
  bool _headerCandidate(Uint8List header, int sealedHeight) {
    if (_pin == null || sealedHeight < 1 || header.length != shearHeaderLen) {
      return false;
    }
    if (_headerVersion(header) != 1) return false;
    final ts = headerTimestampMs(header);
    if (ts == null || ts <= 0) return false;
    if (_headerBits(header) < kAsertBitsScale) return false;
    if (sealedHeight != _chainTip + 1) return false;
    final parent = _checkedAt(sealedHeight - 1);
    if (parent == null || !_prevEquals(header, parent.hash)) return false;
    if (ts <= parent.timeMs) return false;
    final window = <int>[];
    for (var h = sealedHeight - _kMtpWindow; h < sealedHeight; h++) {
      final t = _timeAt(h);
      if (t == null) return false;
      window.add(t);
    }
    if (window.length < _kMtpWindow) return false;
    if (ts > _medianTimes(window) + _kMtpFutureMs) return false;
    final now = _headerNowMs ?? DateTime.now().millisecondsSinceEpoch;
    if (ts > now + _kHeaderAheadMs || ts > now + _kMtpFutureMs) return false;
    return true;
  }

  void _rememberChecked(
    int height,
    Uint8List hash,
    int timeMs, {
    String headerHex = '',
  }) {
    _checkedHeaders.removeWhere((row) => row.height == height);
    _checkedHeaders.add((
      height: height,
      hash: Uint8List.fromList(hash),
      timeMs: timeMs,
      headerHex: headerHex,
    ));
    _pruneChecked();
  }

  /// Pin row stays. The saved tail is the latest [_kHeaderKeep] headers.
  /// Times just below that tail stay for MTP, and their work stays in
  /// [_prunedWork] so a later fork is weighed against the whole chain.
  void _pruneChecked() {
    if (_checkedHeaders.length <= _kHeaderKeep + 1) return;
    _checkedHeaders.sort((a, b) => a.height.compareTo(b.height));
    final tip = _checkedHeaders.last.height;
    final floor = tip - _kHeaderKeep + 1;
    final pinH = _pin?.height;
    final priors = <int>[];
    for (var h = floor - 10; h < floor; h++) {
      final t = _timeAt(h);
      if (t == null) {
        priors.clear();
        break;
      }
      priors.add(t);
    }
    var dropWork = BigInt.zero;
    for (final row in _checkedHeaders) {
      if (row.height >= floor || row.height == pinH) continue;
      if (row.headerHex.isEmpty) continue;
      final raw = headerFromHex(row.headerHex);
      if (raw == null) continue;
      dropWork += blockWork(_headerBits(raw));
    }
    _prunedWork += dropWork;
    if (priors.length == 10) {
      _resumePriorTimes = priors;
      _resumePriorOrigin = floor - 10;
    }
    _checkedHeaders.removeWhere(
      (row) => row.height < floor && row.height != pinH,
    );
  }

  bool _same32(Uint8List a, Uint8List b) {
    if (a.length != 32 || b.length != 32) return false;
    for (var i = 0; i < 32; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  ({int height, Uint8List hash, int timeMs, String headerHex})? _checkedParent(
    Uint8List header,
  ) {
    for (final row in _checkedHeaders) {
      if (_prevEquals(header, row.hash)) return row;
    }
    return null;
  }

  void _paintHeaderProgress(int host) {
    _headerHostTip = host;
    final paint = onHeaderProgress;
    if (paint != null) paint();
  }

  /// Drop checked rows above [height]. The pin is never dropped.
  /// Disk is updated only when [save] is set, after the replacement header
  /// has already passed.
  void _rollBackTo(int height, {bool save = true}) {
    final pinH = _pin?.height ?? 0;
    final floor = height < pinH ? pinH : height;
    if (floor <= pinH) _prunedWork = BigInt.zero;
    _checkedHeaders.removeWhere((row) => row.height > floor);
    if (_verifiedTip > floor) _verifiedTip = floor;
    if (_verifiedTip < pinH) _verifiedTip = pinH;
    _chainLoaded = true;
    if (save) _saveVerifiedChain();
  }

  /// A header already checked must be the same bytes. A different header at
  /// that height is a competing branch, not a repeat.
  bool _knownHeader(Uint8List header, int sealedHeight) {
    final known = _checkedAt(sealedHeight);
    if (known == null) return false;
    final hex = _bytesHex(header);
    if (known.headerHex.isNotEmpty && known.headerHex == hex) return true;
    final digest = _digestOf(header);
    return digest != null && _same32(digest, known.hash);
  }

  void _rememberDigest(String hex, Uint8List digest) {
    if (_v3Ready.length > 8) _v3Ready.remove(_v3Ready.keys.first);
    _v3Ready[hex] = digest;
  }

  /// A digest already computed. Does not hash.
  Uint8List? _cachedForkDigest(Uint8List header) {
    final hex = _bytesHex(header);
    return _forkDigests[hex] ?? _v3Ready[hex];
  }

  Uint8List? _digestOf(Uint8List header) {
    final hex = _bytesHex(header);
    final kept = _forkDigests[hex];
    if (kept != null) return kept;
    final ready = _v3Ready[hex];
    if (ready != null) return ready;
    if (_v3HashInline || Platform.environment['FLUTTER_TEST'] == 'true') {
      headerHashCount += 1;
      final digest = shearHashV3(header);
      if (digest != null) {
        _rememberDigest(hex, digest);
      } else if (header.length == shearHeaderLen) {
        reportHeaderHasherMissing();
      }
      return digest;
    }
    return null;
  }

  /// One native hash at a time on this ledger. The library lock covers the
  /// other isolate.
  Future<Uint8List?> _hashOffUi(Uint8List header) {
    headerHashCount += 1;
    if (_v3HashInline || Platform.environment['FLUTTER_TEST'] == 'true') {
      return Future<Uint8List?>.value(shearHashV3(header));
    }
    final copy = Uint8List.fromList(header);
    final previous = _hashTail ?? Future<void>.value();
    final gate = Completer<void>();
    _hashTail = gate.future;
    return previous.then((_) async {
      try {
        final digest = await Isolate.run(() => shearHashV3(copy));
        if (digest == null && copy.length == shearHeaderLen) {
          reportHeaderHasherMissing();
        }
        return digest;
      } finally {
        if (!gate.isCompleted) gate.complete();
      }
    });
  }

  /// Hash a header off the UI isolate, then [applyTipHex] can use it.
  Future<void> _prepareTipHash(String headerHex, int sealedHeight) async {
    final raw = headerFromHex(headerHex);
    if (raw == null) return;
    final extendsTip = _headerCandidate(raw, sealedHeight);
    final competes = _checkedParent(raw) != null;
    if (!extendsTip && !competes) return;
    final hex = _bytesHex(raw);
    if (_v3Ready.containsKey(hex)) return;
    final digest = await _hashOffUi(raw);
    if (digest != null) _rememberDigest(hex, digest);
  }

  /// Native ShearHash-v3, prev link, MTP, the future-time bound, and ASERT
  /// from the consensus anchor (height 1, genesis bits, the pin's genesis ms).
  /// Does not switch branches. A competing header is weighed in
  /// [_maybeSwitchBranch] only after this same proof has passed.
  bool _headerPowOk(Uint8List header, {required int sealedHeight}) {
    final pin = _pin;
    if (pin == null) return false;
    if (_knownHeader(header, sealedHeight)) return true;
    if (_checkedAt(sealedHeight) != null) return false;
    if (sealedHeight != _chainTip + 1) return false;
    final parent = _checkedAt(sealedHeight - 1);
    if (parent == null) return false;
    final digest = _proveHeader(
      header,
      height: sealedHeight,
      parentHash: parent.hash,
      parentTimeMs: parent.timeMs,
      timeAt: _timeAt,
    );
    if (digest == null) return false;
    final ts = headerTimestampMs(header);
    if (ts == null) return false;
    _rememberChecked(sealedHeight, digest, ts, headerHex: _bytesHex(header));
    if (sealedHeight > _verifiedTip) _verifiedTip = sealedHeight;
    return true;
  }

  /// Timestamp order, ASERT, MTP, and the future bound. No ShearHash.
  /// Null MTP means the eleven samples are not in hand yet.
  _WalkCheap _headerLinkCheap(
    Uint8List header, {
    required int height,
    required int parentTimeMs,
    required int? Function(int height) timeAt,
    Uint8List? parentHash,
  }) {
    final pin = _pin;
    if (pin == null || height < 1 || header.length != shearHeaderLen) {
      return _WalkCheap.reject;
    }
    if (_headerVersion(header) != 1) return _WalkCheap.reject;
    final ts = headerTimestampMs(header);
    final bits = _headerBits(header);
    if (ts == null || ts <= 0 || ts <= parentTimeMs) return _WalkCheap.reject;
    if (bits < kAsertBitsScale) return _WalkCheap.reject;
    if (parentHash != null && !_prevEquals(header, parentHash)) {
      return _WalkCheap.reject;
    }
    final now = _headerNowMs ?? DateTime.now().millisecondsSinceEpoch;
    // Clock bounds are not a bad header. A step backward must not ban it.
    if (ts > now + _kHeaderAheadMs || ts > now + _kMtpFutureMs) {
      return _WalkCheap.later;
    }
    if (pin.anchorHeight != kConsensusAnchorHeight) return _WalkCheap.reject;
    if (pin.anchorBits != kConsensusAnchorBits) return _WalkCheap.reject;
    if (kV12GenesisMs > 0 && pin.anchorTimeMs != kV12GenesisMs) {
      return _WalkCheap.reject;
    }
    final quote = asertQuoteForHeight(
      anchorTimeMs: pin.anchorTimeMs,
      blockTimeMs: ts,
      blockHeight: height,
      anchorHeight: kConsensusAnchorHeight,
      anchorBits: kConsensusAnchorBits,
      parentTimeMs: parentTimeMs,
    );
    if (!consensusBitsOk(bits, quote)) return _WalkCheap.reject;
    final window = <int>[];
    for (var h = height - _kMtpWindow; h < height; h++) {
      final t = timeAt(h);
      if (t == null) return _WalkCheap.wait;
      window.add(t);
    }
    if (ts > _medianTimes(window) + _kMtpFutureMs) return _WalkCheap.later;
    return _WalkCheap.ok;
  }

  /// PoW, prev link, MTP, future bound, and the ASERT quote. No ledger writes.
  /// Cheap checks run before ShearHash. Null when any check fails.
  /// [timeAt] supplies the eleven MTP samples.
  Uint8List? _proveHeader(
    Uint8List header, {
    required int height,
    required Uint8List parentHash,
    required int parentTimeMs,
    required int? Function(int height) timeAt,
  }) {
    final cheap = _headerLinkCheap(
      header,
      height: height,
      parentTimeMs: parentTimeMs,
      timeAt: timeAt,
      parentHash: parentHash,
    );
    if (cheap != _WalkCheap.ok) return null;
    final digest = _digestOf(header);
    final bits = _headerBits(header);
    if (digest == null || !shearMeetsTarget(digest, bits)) return null;
    return digest;
  }

  /// Extend the checked tip. A competing header returns false and changes
  /// nothing: fork choice fetches the whole branch and runs only after every
  /// header on it has passed [_proveHeader].
  bool _acceptHeader(Uint8List header, int height) {
    final ok =
        _headerPowOk(header, sealedHeight: height) ||
        _knownHeader(header, height);
    if (ok) _expireForkBans(_forkHostKey, height);
    return ok;
  }

  Future<Uint8List?> _hashHeader(Uint8List header) async {
    final ready = _digestOf(header);
    if (ready != null) return ready;
    final digest = await _hashOffUi(header);
    if (digest != null) _rememberDigest(_bytesHex(header), digest);
    return digest;
  }

  BigInt _workAbove(int height) {
    var sum = BigInt.zero;
    for (final row in _checkedHeaders) {
      if (row.height <= height || row.headerHex.isEmpty) continue;
      final raw = headerFromHex(row.headerHex);
      if (raw == null) continue;
      sum += blockWork(_headerBits(raw));
    }
    return sum;
  }

  /// Work a fork from [ancestorHeight] would replace. The pin's fork drops
  /// the pruned prefix as well as the retained tail.
  BigInt _droppedWork(int ancestorHeight) {
    final pinH = _pin?.height ?? 0;
    if (ancestorHeight <= pinH) return _prunedWork + _workAbove(pinH);
    return _workAbove(ancestorHeight);
  }

  /// The heavier fork sits below the stored window. Drop back to the pin and
  /// let the next fetch walk up from there. Called only after that fork's
  /// headers have already passed [_proveHeader].
  void _rebackfillFromPin() {
    final pinH = _pin?.height ?? 0;
    _checkedHeaders.removeWhere((row) => row.height != pinH);
    _verifiedTip = pinH;
    _prunedWork = BigInt.zero;
    _resumePriorTimes = const [];
    _resumePriorOrigin = null;
    _chainLoaded = true;
    _sealedPending = null;
    _sealedPriors = const [];
    _sealedWork = null;
    _saveVerifiedChain();
  }

  String get _forkHostKey {
    final raw = pool?.baseUrl ?? '';
    return raw.isEmpty ? 'direct' : raw;
  }

  bool _forkBackedOff(String host) {
    final row = _forkBackoff[host];
    if (row == null) return false;
    return _forkNowMs() < row.untilMs;
  }

  void _armForkBackoff(String host) {
    final prev = _forkBackoff[host];
    final step = prev == null ? 0 : (prev.step + 1).clamp(0, 8);
    final base = forkProofBackoff.inMilliseconds;
    final delay = base <= 0 ? 0 : base * (1 << step);
    _forkBackoff[host] = (untilMs: _forkNowMs() + delay, step: step);
  }

  void _clearForkBackoff(String host) => _forkBackoff.remove(host);

  void _clearForkResume({bool resetStall = true}) {
    _forkResumeHost = null;
    _forkResumeBottom = null;
    _forkResumeBranch = null;
    _forkResumeProved = 0;
    _forkPinnedDigests.clear();
    if (!resetStall) return;
    _forkStallPasses = 0;
    _forkStallBottom = null;
    _forkStallTop = null;
    _forkStallProved = 0;
    _forkStallLen = 0;
    _forkStallHashes = headerHashCount;
  }

  /// The open branch keeps every digest it still needs. Other entries
  /// leave first. Past the cap, the branch itself is the bound.
  void _protectForkDigests(List<({int height, Uint8List header})> branch) {
    _forkPinnedDigests
      ..clear()
      ..addAll([for (final row in branch) _bytesHex(row.header)]);
  }

  void _evictUnpinnedForkDigest() {
    String? drop;
    for (final key in _forkDigests.keys) {
      if (_forkPinnedDigests.contains(key)) continue;
      drop = key;
      break;
    }
    if (drop != null) _forkDigests.remove(drop);
  }

  void _keepForkDigest(Uint8List header, Uint8List digest) {
    final hex = _bytesHex(header);
    final cap = forkDigestCap < 1 ? 1 : forkDigestCap;
    if (_forkDigests.length >= cap && !_forkDigests.containsKey(hex)) {
      _evictUnpinnedForkDigest();
    }
    _forkDigests[hex] = Uint8List.fromList(digest);
    _rememberDigest(hex, digest);
  }

  /// [tip] is set only when that header's link down to [failed] checked out.
  void _banFork(
    String host,
    Uint8List failed, {
    Uint8List? tip,
  }) {
    final ids = _forkBanned.putIfAbsent(host, () => <String>[]);
    void add(String hex) {
      ids.remove(hex);
      ids.add(hex);
    }

    add(_bytesHex(failed));
    if (tip != null) add(_bytesHex(tip));
    while (ids.length > _kBannedForks) {
      ids.removeAt(0);
    }
    final seen = _forkBannedAtTip[host];
    if (seen == null || _forkHostTipSeen > seen) {
      _forkBannedAtTip[host] = _forkHostTipSeen;
    }
  }

  void _expireForkBans(String host, int hostTip) {
    final at = _forkBannedAtTip[host];
    if (at == null || hostTip <= at) return;
    _forkBanned.remove(host);
    _forkBannedAtTip.remove(host);
  }

  /// A higher host tip clears bans only after a header at that height has
  /// passed the cheap checks. A bare tip number does not.
  void _maybeExpireForkBans(
    String host,
    int hostTip,
    List<({int height, Uint8List header})> ordered,
  ) {
    final at = _forkBannedAtTip[host];
    if (at == null || hostTip <= at) return;
    ({int height, Uint8List header})? tip;
    for (final row in ordered) {
      if (row.height == hostTip) tip = row;
    }
    if (tip == null) return;
    int? parentTime;
    for (final row in ordered) {
      if (row.height != hostTip - 1) continue;
      parentTime = headerTimestampMs(row.header);
      break;
    }
    parentTime ??= _timeAt(hostTip - 1);
    if (parentTime == null) return;
    final times = <int, int>{};
    for (final row in ordered) {
      final ts = headerTimestampMs(row.header);
      if (ts != null) times[row.height] = ts;
    }
    int? timeAt(int height) => times[height] ?? _timeAt(height);
    if (_headerLinkCheap(
          tip.header,
          height: hostTip,
          parentTimeMs: parentTime,
          timeAt: timeAt,
        ) !=
        _WalkCheap.ok) {
      return;
    }
    _expireForkBans(host, hostTip);
  }

  /// True when every link from the branch tip down to [target] is cached.
  bool _forkLinksTo(
    List<({int height, Uint8List header})> branch,
    Uint8List target,
  ) {
    if (branch.isEmpty) return false;
    final targetHex = _bytesHex(target);
    if (_bytesHex(branch.last.header) == targetHex) return true;
    for (var i = branch.length - 1; i > 0; i--) {
      final parent = _cachedForkDigest(branch[i - 1].header);
      if (parent == null || !_prevEquals(branch[i].header, parent)) {
        return false;
      }
      if (_bytesHex(branch[i - 1].header) == targetHex) return true;
    }
    return false;
  }

  bool _forkIsBanned(
    String host,
    List<({int height, Uint8List header})> rows,
  ) {
    final ids = _forkBanned[host];
    if (ids == null || ids.isEmpty) return false;
    for (final row in rows) {
      if (ids.contains(_bytesHex(row.header))) return true;
    }
    return false;
  }

  /// Honest catch-up passed the saved fork. That walk is not this chain.
  void _dropForkResumeIfBehind() {
    final saved = _forkResumeBranch;
    if (saved == null || saved.isEmpty) return;
    if (_chainTip > saved.last.height) _clearForkResume();
  }

  int? _forkConflictHeight(
    List<({int height, Uint8List header})> saved,
    List<({int height, Uint8List header})> have,
  ) {
    final at = <int, String>{};
    for (final row in saved) {
      at[row.height] = _bytesHex(row.header);
    }
    int? low;
    for (final row in have) {
      final hex = at[row.height];
      if (hex == null || hex == _bytesHex(row.header)) continue;
      if (low == null || row.height < low) low = row.height;
    }
    return low;
  }

  List<({int height, Uint8List header})> _freshForkBranch(
    List<({int height, Uint8List header})> ordered,
  ) {
    _clearForkResume();
    return [
      (
        height: ordered.first.height,
        header: Uint8List.fromList(ordered.first.header),
      ),
    ];
  }

  /// Same host and a have that still meets this bottom. A one-block tip
  /// reorg keeps every row below the conflict. A have that starts above the
  /// saved top is a different fork.
  List<({int height, Uint8List header})> _takeForkBranch(
    String host,
    List<({int height, Uint8List header})> ordered,
  ) {
    final saved = _forkResumeBranch;
    if (saved == null ||
        saved.isEmpty ||
        _forkResumeHost != host ||
        _forkResumeBottom != _bytesHex(saved.first.header)) {
      return _freshForkBranch(ordered);
    }
    final conflictAt = _forkConflictHeight(saved, ordered);
    if (conflictAt != null) {
      final kept = [
        for (final row in saved)
          if (row.height < conflictAt)
            (height: row.height, header: Uint8List.fromList(row.header)),
      ];
      if (kept.isEmpty) return _freshForkBranch(ordered);
      _forkResumeBranch = [
        for (final row in kept)
          (height: row.height, header: Uint8List.fromList(row.header)),
      ];
      _forkResumeBottom = _bytesHex(kept.first.header);
      if (_forkResumeProved > kept.length) _forkResumeProved = kept.length;
      return kept;
    }
    final low = ordered.first.height;
    final bottom = saved.first.height;
    final top = saved.last.height;
    if (low < bottom || low > top + 1) return _freshForkBranch(ordered);
    return [
      for (final row in saved)
        (height: row.height, header: Uint8List.fromList(row.header)),
    ];
  }

  void _saveForkResume(
    String host,
    List<({int height, Uint8List header})> branch, {
    int? proved,
    bool countStall = true,
  }) {
    if (branch.isEmpty) {
      _clearForkResume();
      return;
    }
    _forkResumeHost = host;
    _forkResumeBottom = _bytesHex(branch.first.header);
    _forkResumeBranch = [
      for (final row in branch)
        (height: row.height, header: Uint8List.fromList(row.header)),
    ];
    _protectForkDigests(_forkResumeBranch!);
    if (proved != null) _forkResumeProved = proved;
    _noteForkStall(count: countStall);
  }

  /// Progress is a new header, a new proof, or a real hash. A full digest
  /// map is not progress. Wallet-side waits pass [count] false.
  void _noteForkStall({bool count = true}) {
    final branch = _forkResumeBranch;
    final bottom = (branch == null || branch.isEmpty)
        ? null
        : branch.first.height;
    final top = (branch == null || branch.isEmpty)
        ? null
        : branch.last.height;
    final len = branch?.length ?? 0;
    final proved = _forkResumeProved;
    final hashes = headerHashCount;
    final grew =
        (bottom != null &&
            (_forkStallBottom == null || bottom < _forkStallBottom!)) ||
        (top != null && (_forkStallTop == null || top > _forkStallTop!)) ||
        (branch != null && len > _forkStallLen);
    final moreProof = proved > _forkStallProved;
    final moreHashes = hashes > _forkStallHashes;
    if (grew || moreProof || moreHashes) {
      _forkStallPasses = 0;
    } else if (count) {
      _forkStallPasses += 1;
    }
    if (bottom != null) _forkStallBottom = bottom;
    if (top != null) _forkStallTop = top;
    if (branch != null) _forkStallLen = len;
    _forkStallProved = proved;
    _forkStallHashes = hashes;
  }

  /// Claimed ASERT work, plus the heaviest remaining quote down to the pin,
  /// still cannot beat the chain this fork would replace.
  bool _forkClaimCannotWin(List<({int height, Uint8List header})> branch) {
    final pin = _pin;
    if (pin == null || branch.isEmpty) return false;
    var claimed = BigInt.zero;
    for (final row in branch) {
      claimed += blockWork(_headerBits(row.header));
    }
    final lowest = branch.first.height;
    var remain = lowest - 1 - pin.height;
    if (remain < 0) remain = 0;
    final ceiling =
        claimed +
        blockWork(kAsertMaxBits * kAsertBitsScale) * BigInt.from(remain);
    return ceiling <= _droppedWork(pin.height);
  }

  void _rejectFork(String host) {
    _clearForkResume();
    _armForkBackoff(host);
  }

  Future<bool> _finishFork(
    String host,
    ({int height, Uint8List hash, int timeMs, String headerHex}) ancestor,
    List<({int height, Uint8List header})> branch, {
    required int budget,
    required bool Function() expired,
  }) async {
    if (budget < 1 || expired()) {
      _saveForkResume(host, branch);
      return false;
    }
    final result = await _switchIfHeavier(
      ancestor,
      branch,
      alreadyProved: _forkResumeProved,
      budget: budget,
      expired: expired,
    );
    if (result.kind == _ForkProof.partial) {
      _saveForkResume(
        host,
        branch,
        proved: result.proved,
        countStall: result.countStall,
      );
      return false;
    }
    if (result.kind == _ForkProof.invalid) {
      if (result.failed != null) {
        _banFork(
          host,
          result.failed!,
          tip: result.banTip && branch.isNotEmpty
              ? branch.last.header
              : null,
        );
      }
      _rejectFork(host);
      return false;
    }
    _clearForkResume();
    _clearForkBackoff(host);
    return result.kind == _ForkProof.switched;
  }

  /// Fetch the competing branch back to a retained ancestor, verify every
  /// header, and switch only when its total work is strictly greater.
  /// Equal work stays, so the next honest block (one more header of work)
  /// can still win and the wallet is not stuck. No fixed depth cap: a
  /// verified heavier fork may roll back to the pin. One attempt is bounded
  /// by [forkWalkCap], [headerWalkDeadline], and claimed work.
  ///
  /// The resume key is the host plus the branch bottom. A newer tip extends
  /// that branch upward. An empty or timed-out read keeps the resume and
  /// does not back off. Only a proved-bad header does.
  Future<bool> _maybeSwitchBranch({
    required int hostTip,
    required List<({int height, Uint8List header})> have,
    required Future<List<({int height, Uint8List header})>> Function(
      int from,
      int to,
    )?
    fetch,
  }) async {
    final pin = _pin;
    if (pin == null || have.isEmpty || hostTip < pin.height) return false;
    final host = _forkHostKey;
    if (_forkBackedOff(host)) return false;
    final ordered = List<({int height, Uint8List header})>.from(have)
      ..sort((a, b) => a.height.compareTo(b.height));
    _forkHostTipSeen = hostTip;
    _maybeExpireForkBans(host, hostTip, ordered);
    _dropForkResumeIfBehind();
    if (_forkIsBanned(host, ordered)) {
      _noteForkStall();
      return false;
    }
    forkProofAttempts += 1;
    final pinHash = _hexToBytes(pin.hashHex);
    if (pinHash == null) return false;
    final started = _forkNowMs();
    bool expired() =>
        _forkNowMs() - started >= headerWalkDeadline.inMilliseconds;
    final branch = _takeForkBranch(host, ordered);
    _protectForkDigests(branch);
    final cap = forkWalkCap < 1 ? 1 : forkWalkCap;
    var steps = 0;
    Future<bool> atAncestor(
      ({int height, Uint8List hash, int timeMs, String headerHex}) ancestor,
    ) async {
      if (_forkClaimCannotWin(branch)) {
        // Not a proved-bad header. A light branch must not clear the
        // backoff a fake already armed.
        _clearForkResume();
        return false;
      }
      if (steps < cap && !expired()) {
        steps += await _extendBranchUp(
          branch,
          ordered,
          budget: cap - steps,
          expired: expired,
        );
      }
      return _finishFork(
        host,
        ancestor,
        branch,
        budget: cap - steps,
        expired: expired,
      );
    }

    while (steps < cap) {
      if (expired()) {
        _saveForkResume(host, branch);
        return false;
      }
      steps += await _extendBranchUp(
        branch,
        ordered,
        budget: cap - steps,
        expired: expired,
      );
      if (expired() || steps >= cap) {
        _saveForkResume(host, branch);
        return false;
      }
      final bottom = branch.first;
      final linked = _checkedParent(bottom.header);
      if (linked != null && linked.height + 1 == bottom.height) {
        return atAncestor(linked);
      }
      if (bottom.height - 1 == pin.height &&
          _prevEquals(bottom.header, pinHash)) {
        final pinRow = _checkedAt(pin.height);
        if (pinRow == null) {
          _rejectFork(host);
          return false;
        }
        return atAncestor(pinRow);
      }
      if (bottom.height - 1 <= pin.height) {
        _rejectFork(host);
        return false;
      }
      steps += 1;
      final rows = await _readHeaders(
        bottom.height - 1,
        bottom.height - 1,
        fetch,
      );
      if (expired()) {
        _saveForkResume(host, branch);
        return false;
      }
      // A stall or a short page is the host, not a bad header.
      if (rows.isEmpty || rows.first.height != bottom.height - 1) {
        _saveForkResume(host, branch);
        return false;
      }
      final lower = rows.first;
      if (_forkIsBanned(host, [(height: lower.height, header: lower.header)])) {
        _clearForkResume(resetStall: false);
        _noteForkStall();
        return false;
      }
      final parentTs = headerTimestampMs(lower.header);
      if (parentTs == null) {
        _rejectFork(host);
        return false;
      }
      final times = <int, int>{lower.height: parentTs};
      for (final row in branch) {
        final ts = headerTimestampMs(row.header);
        if (ts != null) times[row.height] = ts;
      }
      int? timeAt(int height) => times[height] ?? _timeAt(height);
      final cheap = _headerLinkCheap(
        bottom.header,
        height: bottom.height,
        parentTimeMs: parentTs,
        timeAt: timeAt,
      );
      if (cheap == _WalkCheap.later) {
        _saveForkResume(host, branch, countStall: false);
        return false;
      }
      if (cheap == _WalkCheap.reject) {
        _rejectFork(host);
        return false;
      }
      branch.insert(
        0,
        (height: lower.height, header: Uint8List.fromList(lower.header)),
      );
      _forkPinnedDigests.add(_bytesHex(lower.header));
      if (cheap == _WalkCheap.wait) continue;
      final lowerDigest = await _hashHeader(lower.header);
      final bottomDigest = await _hashHeader(bottom.header);
      if (expired()) {
        _saveForkResume(host, branch);
        return false;
      }
      if (lowerDigest == null || bottomDigest == null) {
        _saveForkResume(host, branch, countStall: false);
        return false;
      }
      final lowerOk = shearMeetsTarget(lowerDigest, _headerBits(lower.header));
      final bottomOk = shearMeetsTarget(
        bottomDigest,
        _headerBits(bottom.header),
      );
      final linkedOk = _prevEquals(bottom.header, lowerDigest);
      if (!lowerOk || !bottomOk || !linkedOk) {
        final Uint8List failed;
        var banTip = false;
        if (!lowerOk) {
          failed = lower.header;
          banTip = linkedOk && _forkLinksTo(branch, bottom.header);
        } else if (!bottomOk) {
          failed = bottom.header;
          banTip = _forkLinksTo(branch, bottom.header);
        } else {
          failed = bottom.header;
        }
        _banFork(host, failed, tip: banTip ? branch.last.header : null);
        _rejectFork(host);
        return false;
      }
      _keepForkDigest(lower.header, lowerDigest);
      _keepForkDigest(bottom.header, bottomDigest);
    }
    _saveForkResume(host, branch);
    return false;
  }

  /// Headers already fetched above [branch]. Stops at the deadline or [budget].
  /// A header that does not link is left for a later pass, not a failed proof.
  Future<int> _extendBranchUp(
    List<({int height, Uint8List header})> branch,
    List<({int height, Uint8List header})> have, {
    required int budget,
    required bool Function() expired,
  }) async {
    if (budget < 1 || branch.isEmpty || expired()) return 0;
    var used = 0;
    final extra = List<({int height, Uint8List header})>.from(have)
      ..sort((a, b) => a.height.compareTo(b.height));
    final taken = <int>{for (final row in branch) row.height};
    for (final row in extra) {
      if (expired() || used >= budget) break;
      if (!taken.add(row.height)) continue;
      if (row.height != branch.last.height + 1) continue;
      final parentTs = headerTimestampMs(branch.last.header);
      if (parentTs == null) break;
      final times = <int, int>{};
      for (final haveRow in branch) {
        final ts = headerTimestampMs(haveRow.header);
        if (ts != null) times[haveRow.height] = ts;
      }
      int? timeAt(int height) => times[height] ?? _timeAt(height);
      final cheap = _headerLinkCheap(
        row.header,
        height: row.height,
        parentTimeMs: parentTs,
        timeAt: timeAt,
      );
      if (cheap != _WalkCheap.ok) break;
      final prev = await _hashHeader(branch.last.header);
      if (prev == null || !_prevEquals(row.header, prev)) break;
      if (expired() || used >= budget) break;
      used += 1;
      final digest = await _hashHeader(row.header);
      if (digest == null ||
          !shearMeetsTarget(digest, _headerBits(row.header))) {
        break;
      }
      branch.add((
        height: row.height,
        header: Uint8List.fromList(row.header),
      ));
      _forkPinnedDigests.add(_bytesHex(row.header));
      _keepForkDigest(row.header, digest);
    }
    return used;
  }

  ({
    _ForkProof kind,
    int proved,
    Uint8List? failed,
    bool banTip,
    bool countStall,
  })
  _forkResult(
    _ForkProof kind,
    int proved, {
    Uint8List? failed,
    bool banTip = false,
    bool countStall = true,
  }) {
    return (
      kind: kind,
      proved: proved,
      failed: failed,
      banTip: banTip,
      countStall: countStall,
    );
  }

  /// [ancestor] is already checked. [branch] is the competing headers above
  /// it, lowest height first. Work is compared only after every header proves.
  /// Timestamp, ASERT, MTP, and the future bound run before ShearHash.
  /// Screening walks from the tip down, so a bad header fails before the
  /// prefix under it is hashed. One pass hashes at most [budget] new headers.
  /// A cached digest is free. The chain is not rolled back until the whole
  /// branch proves. [failed] is the header that did not prove. [banTip] is
  /// set only when the tip's link down to that header checked out.
  Future<
    ({
      _ForkProof kind,
      int proved,
      Uint8List? failed,
      bool banTip,
      bool countStall,
    })
  >
  _switchIfHeavier(
    ({int height, Uint8List hash, int timeMs, String headerHex}) ancestor,
    List<({int height, Uint8List header})> branch, {
    required int alreadyProved,
    required int budget,
    required bool Function() expired,
  }) async {
    if (branch.isEmpty) {
      return _forkResult(_ForkProof.invalid, 0);
    }
    _protectForkDigests(branch);
    for (var i = 0; i < branch.length; i++) {
      if (branch[i].height != ancestor.height + i + 1) {
        return _forkResult(
          _ForkProof.invalid,
          0,
          failed: branch[i].header,
        );
      }
    }
    final times = <int, int>{ancestor.height: ancestor.timeMs};
    for (final row in branch) {
      final ts = headerTimestampMs(row.header);
      if (ts != null) times[row.height] = ts;
    }
    int? timeAt(int height) => times[height] ?? _timeAt(height);
    var fresh = 0;
    for (var i = branch.length - 1; i >= 0; i--) {
      final row = branch[i];
      final parentTime = i == 0
          ? ancestor.timeMs
          : headerTimestampMs(branch[i - 1].header);
      if (parentTime == null) {
        return _forkResult(_ForkProof.invalid, 0, failed: row.header);
      }
      final cached = _cachedForkDigest(row.header);
      if (cached == null && (fresh >= budget || expired())) break;
      final cheap = _headerLinkCheap(
        row.header,
        height: row.height,
        parentTimeMs: parentTime,
        timeAt: timeAt,
      );
      if (cheap == _WalkCheap.wait || cheap == _WalkCheap.later) {
        return _forkResult(_ForkProof.partial, 0, countStall: false);
      }
      if (cheap != _WalkCheap.ok) {
        return _forkResult(_ForkProof.invalid, 0, failed: row.header);
      }
      var digest = cached;
      if (digest == null) {
        fresh += 1;
        digest = await _hashHeader(row.header);
      }
      if (digest == null) {
        return _forkResult(_ForkProof.partial, 0, countStall: false);
      }
      if (!shearMeetsTarget(digest, _headerBits(row.header))) {
        final above = i + 1 < branch.length;
        final childLinks =
            above && _prevEquals(branch[i + 1].header, digest);
        return _forkResult(
          _ForkProof.invalid,
          0,
          failed: row.header,
          banTip: !above || childLinks,
        );
      }
      _keepForkDigest(row.header, digest);
      if (i + 1 < branch.length &&
          !_prevEquals(branch[i + 1].header, digest)) {
        return _forkResult(
          _ForkProof.invalid,
          0,
          failed: branch[i + 1].header,
        );
      }
      if (i == 0 && !_prevEquals(row.header, ancestor.hash)) {
        return _forkResult(_ForkProof.invalid, 0, failed: row.header);
      }
    }
    var parentHash = ancestor.hash;
    var parentTime = ancestor.timeMs;
    var work = BigInt.zero;
    final proved = <({int height, Uint8List header})>[];
    for (final row in branch) {
      if (row.height != ancestor.height + proved.length + 1) {
        return _forkResult(
          _ForkProof.invalid,
          proved.length,
          failed: row.header,
        );
      }
      final cached = _cachedForkDigest(row.header);
      final counting = proved.length >= alreadyProved;
      if (cached == null && counting && (fresh >= budget || expired())) {
        return _forkResult(_ForkProof.partial, proved.length);
      }
      final cheap = _headerLinkCheap(
        row.header,
        height: row.height,
        parentTimeMs: parentTime,
        timeAt: timeAt,
        parentHash: parentHash,
      );
      if (cheap == _WalkCheap.wait || cheap == _WalkCheap.later) {
        return _forkResult(
          _ForkProof.partial,
          proved.length,
          countStall: false,
        );
      }
      if (cheap != _WalkCheap.ok) {
        return _forkResult(
          _ForkProof.invalid,
          proved.length,
          failed: row.header,
        );
      }
      if (cached == null && counting) fresh += 1;
      final digest = cached ?? await _hashHeader(row.header);
      if (digest == null) {
        return _forkResult(
          _ForkProof.partial,
          proved.length,
          countStall: false,
        );
      }
      final provedDigest = _proveHeader(
        row.header,
        height: row.height,
        parentHash: parentHash,
        parentTimeMs: parentTime,
        timeAt: timeAt,
      );
      if (provedDigest == null) {
        return _forkResult(
          _ForkProof.invalid,
          proved.length,
          failed: row.header,
        );
      }
      _keepForkDigest(row.header, provedDigest);
      final ts = headerTimestampMs(row.header);
      if (ts == null) {
        return _forkResult(
          _ForkProof.invalid,
          proved.length,
          failed: row.header,
        );
      }
      times[row.height] = ts;
      parentHash = provedDigest;
      parentTime = ts;
      work += blockWork(_headerBits(row.header));
      proved.add((height: row.height, header: row.header));
    }
    if (work <= _droppedWork(ancestor.height)) {
      return _forkResult(_ForkProof.lighter, proved.length);
    }
    final saved =
        List<({int height, Uint8List hash, int timeMs, String headerHex})>.from(
          _checkedHeaders,
        );
    final savedTip = _verifiedTip;
    final savedWork = _prunedWork;
    _rollBackTo(ancestor.height, save: false);
    var applied = true;
    for (final row in proved) {
      if (!_headerPowOk(row.header, sealedHeight: row.height)) {
        applied = false;
        break;
      }
    }
    if (applied) {
      _saveVerifiedChain();
      return _forkResult(_ForkProof.switched, proved.length);
    }
    _checkedHeaders
      ..clear()
      ..addAll(saved);
    _verifiedTip = savedTip;
    _prunedWork = savedWork;
    // The branch proved, but the retained window cannot take the fork.
    // Rebuild from the pin on the next pass. The proof already happened.
    if (ancestor.height <= (_pin?.height ?? 0)) _rebackfillFromPin();
    return _forkResult(_ForkProof.lighter, proved.length);
  }

  /// Headers from the checkpoint toward [hostTip]. At most 32 per call.
  /// One pass at a time: a second caller waits for the pass already running.
  /// The credit worker calls this off the UI isolate. A bare wallet stays at
  /// depth 0 until this chain reaches the note.
  Future<int> catchUpVerifiedChain(
    int hostTip, {
    Future<List<({int height, Uint8List header})>> Function(int from, int to)?
    fetch,
  }) {
    final inflight = _catchUpFlight;
    if (inflight != null) return inflight;
    final run = _catchUpPass(hostTip, fetch: fetch);
    _catchUpFlight = run;
    return run.whenComplete(() {
      if (identical(_catchUpFlight, run)) _catchUpFlight = null;
    });
  }

  Future<int> _catchUpPass(
    int hostTip, {
    Future<List<({int height, Uint8List header})>> Function(int from, int to)?
    fetch,
  }) async {
    _installReleaseCheckpoint();
    if (_pin == null || hostTip < 1) return bookTip;
    _loadVerifiedChain();
    await _adoptSealedPending();
    _paintHeaderProgress(hostTip);
    await _refetchReorgHint(hostTip, fetch);
    var next = _chainTip + 1;
    if (hostTip < next) {
      final floor = _pin?.height ?? 0;
      // A shorter host tip can be a heavier branch. The same height is
      // already checked, so a resumed wallet does not fetch again.
      if (hostTip > floor && hostTip < _chainTip) {
        final rows = await _readHeaders(hostTip, hostTip, fetch);
        for (final row in rows) {
          await _prepareTipHash(_bytesHex(row.header), row.height);
          if (_acceptHeader(row.header, row.height)) {
            _dropForkResumeIfBehind();
            _paintHeaderProgress(hostTip);
            continue;
          }
          if (await _maybeSwitchBranch(
            hostTip: hostTip,
            have: rows,
            fetch: fetch,
          )) {
            _paintHeaderProgress(hostTip);
          }
        }
        _saveVerifiedChain();
      }
      _paintHeaderProgress(hostTip);
      return bookTip;
    }
    final cap = next + _kHeaderBackfillCap - 1;
    final to = hostTip < cap ? hostTip : cap;
    final rows = List<({int height, Uint8List header})>.from(
      await _readHeaders(next, to, fetch),
    );
    rows.sort((a, b) => a.height.compareTo(b.height));
    for (final row in rows) {
      if (row.height > next) break;
      await _prepareTipHash(_bytesHex(row.header), row.height);
      if (_acceptHeader(row.header, row.height)) {
        _dropForkResumeIfBehind();
        next = _chainTip + 1;
        _paintHeaderProgress(hostTip);
        continue;
      }
      final switched = await _maybeSwitchBranch(
        hostTip: hostTip,
        have: rows.where((r) => r.height >= row.height).toList(),
        fetch: fetch,
      );
      if (!switched) break;
      next = _chainTip + 1;
      _paintHeaderProgress(hostTip);
      break;
    }
    _saveVerifiedChain();
    _paintHeaderProgress(hostTip);
    return bookTip;
  }

  Future<List<({int height, Uint8List header})>> _readHeaders(
    int from,
    int to,
    Future<List<({int height, Uint8List header})>> Function(int from, int to)?
    fetch,
  ) {
    if (fetch != null) {
      return fetch(from, to).timeout(
        headerReadTimeout,
        onTimeout: () => <({int height, Uint8List header})>[],
      );
    }
    return _fetchHeaderPage(from, to);
  }

  Future<void> _refetchReorgHint(
    int hostTip,
    Future<List<({int height, Uint8List header})>> Function(int from, int to)?
    fetch,
  ) async {
    final hint = _reorgHintFrom;
    if (hint == null) return;
    _reorgHintFrom = null;
    final rows = await _readHeaders(hint, hint, fetch);
    for (final row in rows) {
      await _prepareTipHash(_bytesHex(row.header), row.height);
      if (_acceptHeader(row.header, row.height)) {
        _dropForkResumeIfBehind();
        _paintHeaderProgress(hostTip);
        continue;
      }
      if (await _maybeSwitchBranch(
        hostTip: hostTip,
        have: rows,
        fetch: fetch,
      )) {
        _paintHeaderProgress(hostTip);
      }
    }
  }

  Future<List<({int height, Uint8List header})>> _fetchHeaderPage(
    int from,
    int to,
  ) async {
    final client = pool;
    if (client == null) return const [];
    final out = <({int height, Uint8List header})>[];
    for (var h = from; h <= to; h++) {
      try {
        final json = await client.headerAt(h, timeout: headerReadTimeout);
        final raw = headerFromHex(json['header']?.toString() ?? '');
        if (raw == null) break;
        final height = (json['height'] as num?)?.toInt() ?? h;
        out.add((height: height, header: raw));
      } catch (_) {
        break;
      }
    }
    return out;
  }

  /// MAC over the sealed header file. The key is derived from the spend
  /// seed, the wallet vault secret. A bad MAC deletes the file.
  Uint8List? _headerMacKey() {
    final seed = spendSeed;
    if (seed == null || seed.length != 32) return null;
    final raw = Hmac(
      sha256,
      utf8.encode('shear-verified-headers-v1'),
    ).convert(seed);
    return Uint8List.fromList(raw.bytes);
  }

  String _headerMacHex(Uint8List key, String body) =>
      Hmac(sha256, key).convert(utf8.encode(body)).toString();

  String _canonicalHeaderBody(
    String pinHex,
    List<int> priors,
    String work,
    List<Map<String, Object>> rows,
  ) => jsonEncode({
    'v': 2,
    'pin': pinHex.toLowerCase(),
    'priors': priors,
    'work': work,
    'rows': rows,
  });

  bool _macMatch(String got, String want) {
    if (got.length != want.length || got.isEmpty) return false;
    var diff = 0;
    for (var i = 0; i < got.length; i++) {
      diff |= got.codeUnitAt(i) ^ want.codeUnitAt(i);
    }
    return diff == 0;
  }

  void _discardHeaderFile() {
    final path = _headerStorePath;
    if (path == null || path.isEmpty) return;
    final file = File(path);
    if (!file.existsSync()) return;
    try {
      file.deleteSync();
    } catch (_) {}
  }

  void _loadVerifiedChain() {
    if (_chainLoaded || _pin == null) return;
    final path = _headerStorePath;
    if (path == null || path.isEmpty) return;
    _chainLoaded = true;
    final key = _headerMacKey();
    if (key == null) {
      _headerMacReady = false;
      return;
    }
    _headerMacReady = true;
    final sealed = _readSealedHeaderRows(key);
    if (sealed == null || sealed.rows.isEmpty) return;
    if (_v3HashInline || Platform.environment['FLUTTER_TEST'] == 'true') {
      _adoptSealedSync(sealed.rows, priors: sealed.priors, work: sealed.work);
      return;
    }
    _sealedPending = sealed.rows;
    _sealedPriors = sealed.priors;
    _sealedWork = sealed.work;
  }

  /// Parsed sealed rows. Null discards the file. Empty rows means nothing to adopt.
  ({
    List<({int height, int timeMs, Uint8List header})> rows,
    List<int> priors,
    String? work,
  })?
  _readSealedHeaderRows(Uint8List key) {
    final path = _headerStorePath;
    final pin = _pin;
    if (path == null || pin == null) {
      return (
        rows: <({int height, int timeMs, Uint8List header})>[],
        priors: <int>[],
        work: null,
      );
    }
    final file = File(path);
    if (!file.existsSync()) {
      return (
        rows: <({int height, int timeMs, Uint8List header})>[],
        priors: <int>[],
        work: null,
      );
    }
    Object? decoded;
    try {
      decoded = jsonDecode(file.readAsStringSync());
    } catch (_) {
      _discardHeaderFile();
      return null;
    }
    if (decoded is! Map || decoded['v'] != 2) {
      _discardHeaderFile();
      return null;
    }
    final pinHex = decoded['pin']?.toString().toLowerCase() ?? '';
    if (pinHex != pin.hashHex.toLowerCase()) {
      _discardHeaderFile();
      return null;
    }
    // A file from before cumulative work was sealed cannot price a fork.
    // Refuse it and backfill from the pin rather than treating work as zero.
    final workRaw = decoded['work']?.toString() ?? '';
    if (!decoded.containsKey('work') ||
        workRaw.isEmpty ||
        (BigInt.tryParse(workRaw)?.isNegative ?? true)) {
      _discardHeaderFile();
      return null;
    }
    final rawRows = decoded['rows'];
    if (rawRows is! List) {
      _discardHeaderFile();
      return null;
    }
    final canon = <Map<String, Object>>[];
    final sealed = <({int height, int timeMs, Uint8List header})>[];
    for (final row in rawRows) {
      if (row is! Map) {
        _discardHeaderFile();
        return null;
      }
      final height = (row['h'] as num?)?.toInt() ?? 0;
      final timeMs = (row['t'] as num?)?.toInt() ?? 0;
      final hex = row['hdr']?.toString() ?? '';
      final id = row['id']?.toString().toLowerCase() ?? '';
      final header = headerFromHex(hex);
      if (height <= pin.height || header == null || timeMs <= 0) {
        _discardHeaderFile();
        return null;
      }
      canon.add({'h': height, 't': timeMs, 'hdr': hex, 'id': id});
      sealed.add((height: height, timeMs: timeMs, header: header));
    }
    canon.sort((a, b) => (a['h'] as int).compareTo(b['h'] as int));
    sealed.sort((a, b) => a.height.compareTo(b.height));
    final parsedPriors = _parseHeaderPriors(decoded['priors']);
    if (parsedPriors == null) {
      _discardHeaderFile();
      return null;
    }
    final mac = decoded['mac']?.toString().toLowerCase() ?? '';
    final want = _headerMacHex(
      key,
      _canonicalHeaderBody(pinHex, parsedPriors, workRaw, canon),
    );
    if (!_macMatch(mac, want)) {
      _discardHeaderFile();
      return null;
    }
    return (rows: sealed, priors: parsedPriors, work: workRaw);
  }

  /// Ten increasing times, or an empty list when the key is absent.
  /// Any other shape discards the file.
  List<int>? _parseHeaderPriors(Object? raw) {
    if (raw == null) return const [];
    if (raw is! List) return null;
    if (raw.isEmpty) return const [];
    if (raw.length != 10) return null;
    final out = <int>[];
    var prev = 0;
    for (final item in raw) {
      final t = item is num ? item.toInt() : int.tryParse('$item') ?? 0;
      if (t <= prev) return null;
      prev = t;
      out.add(t);
    }
    return out;
  }

  void _installResumePriors(
    List<({int height, int timeMs, Uint8List header})> rows,
    List<int> priors,
  ) {
    if (rows.isEmpty || priors.length != 10) return;
    _resumePriorTimes = List<int>.from(priors);
    _resumePriorOrigin = rows.first.height - 10;
  }

  void _applyStoredWork(String? work) {
    if (work == null) return;
    final total = BigInt.tryParse(work);
    if (total == null || total.isNegative) return;
    final tail = _workAbove(_pin?.height ?? 0);
    final pruned = total - tail;
    _prunedWork = pruned.isNegative ? BigInt.zero : pruned;
  }

  /// The MAC already proved this wallet checked [row]. When it is not the
  /// header after the pin, seed it as the resume anchor and re-check the rest.
  bool _seedResumeAnchor(({int height, int timeMs, Uint8List header}) row) {
    final ts = headerTimestampMs(row.header);
    if (ts == null || ts != row.timeMs) return false;
    if (row.height == _chainTip + 1) {
      return _headerPowOk(row.header, sealedHeight: row.height);
    }
    final digest = _digestOf(row.header);
    final bits = _headerBits(row.header);
    if (digest == null || !shearMeetsTarget(digest, bits)) return false;
    final parentTime = _timeAt(row.height - 1);
    final pin = _pin;
    if (parentTime != null && pin != null) {
      if (ts <= parentTime) return false;
      final quote = asertQuoteForHeight(
        anchorTimeMs: pin.anchorTimeMs,
        blockTimeMs: ts,
        blockHeight: row.height,
        anchorHeight: kConsensusAnchorHeight,
        anchorBits: kConsensusAnchorBits,
        parentTimeMs: parentTime,
      );
      if (!consensusBitsOk(bits, quote)) return false;
    }
    _rememberChecked(row.height, digest, ts, headerHex: _bytesHex(row.header));
    if (row.height > _verifiedTip) _verifiedTip = row.height;
    return true;
  }

  /// The first sealed row is the resume anchor. Rows after it are re-linked
  /// and re-checked. The tip rises only for a row that passes.
  void _adoptSealedSync(
    List<({int height, int timeMs, Uint8List header})> rows, {
    List<int> priors = const [],
    String? work,
  }) {
    if (rows.isEmpty) return;
    _installResumePriors(rows, priors);
    if (!_seedResumeAnchor(rows.first)) return;
    for (final row in rows.skip(1)) {
      final ts = headerTimestampMs(row.header);
      if (ts == null || ts != row.timeMs) return;
      if (!_headerPowOk(row.header, sealedHeight: row.height)) return;
    }
    _applyStoredWork(work);
  }

  Future<void> _adoptSealedPending() async {
    final rows = _sealedPending;
    if (rows == null) return;
    final priors = _sealedPriors;
    final work = _sealedWork;
    _sealedPending = null;
    _sealedPriors = const [];
    _sealedWork = null;
    if (rows.isEmpty) return;
    _installResumePriors(rows, priors);
    final anchor = rows.first;
    await _hashHeader(anchor.header);
    if (!_seedResumeAnchor(anchor)) return;
    for (final row in rows.skip(1)) {
      final ts = headerTimestampMs(row.header);
      if (ts == null || ts != row.timeMs) return;
      await _hashHeader(row.header);
      if (!_headerPowOk(row.header, sealedHeight: row.height)) return;
    }
    _applyStoredWork(work);
  }

  List<int> _priorsForSave(int firstHeight) {
    final origin = _resumePriorOrigin;
    if (origin != null &&
        origin == firstHeight - 10 &&
        _resumePriorTimes.length == 10) {
      return List<int>.from(_resumePriorTimes);
    }
    final priors = <int>[];
    for (var h = firstHeight - 10; h < firstHeight; h++) {
      final t = _timeAt(h);
      if (t == null) return const [];
      priors.add(t);
    }
    return priors;
  }

  void _saveVerifiedChain() {
    final path = _headerStorePath;
    final pin = _pin;
    final key = _headerMacKey();
    if (path == null || path.isEmpty || pin == null || key == null) return;
    final rows = <Map<String, Object>>[
      for (final row in _checkedHeaders)
        if (row.height > pin.height && row.headerHex.isNotEmpty)
          {
            'h': row.height,
            't': row.timeMs,
            'hdr': row.headerHex,
            'id': _bytesHex(row.hash),
          },
    ];
    rows.sort((a, b) => (a['h'] as int).compareTo(b['h'] as int));
    final first = rows.isEmpty ? pin.height + 1 : rows.first['h'] as int;
    final priors = rows.isEmpty ? const <int>[] : _priorsForSave(first);
    final work = (_prunedWork + _workAbove(pin.height)).toString();
    final pinHex = pin.hashHex.toLowerCase();
    final text = jsonEncode({
      'v': 2,
      'pin': pinHex,
      'priors': priors,
      'work': work,
      'rows': rows,
      'mac': _headerMacHex(
        key,
        _canonicalHeaderBody(pinHex, priors, work, rows),
      ),
    });
    final file = File(path);
    file.parent.createSync(recursive: true);
    final tmp = File('$path.tmp');
    tmp.writeAsStringSync(text);
    if (file.existsSync()) file.deleteSync();
    tmp.renameSync(file.path);
  }

  Uint8List? _hexToBytes(String hex) {
    if (hex.length != 64) return null;
    final out = Uint8List(32);
    for (var i = 0; i < 32; i++) {
      final byte = int.tryParse(hex.substring(i * 2, i * 2 + 2), radix: 16);
      if (byte == null) return null;
      out[i] = byte;
    }
    return out;
  }

  /// Record how far a notes response reached. Never moves backward.
  void noteCovered(int height) {
    if (height > _notesCovered) _notesCovered = height;
  }

  /// Display-only last sealed header dt (ms). Not a mint input.
  int? get lastSealedHeaderDtMs {
    final a = _prevHeaderTimestampMs;
    final b = _headerTimestampMs;
    if (a == null || b == null || b <= a) return null;
    return b - a;
  }

  /// Continuum observed interval: average of all sealed blocks when the pool
  /// sent one; otherwise the last pair of headers.
  int? get observedIntervalMs => _avgBlockTimeMs ?? lastSealedHeaderDtMs;

  /// Sealed tip header wall-clock (ms). ShearView date column. Not an interval.
  int? get tipTimestampMs => _headerTimestampMs;

  void applyAvgBlockTimeMs(int? ms) {
    if (ms == null || ms < 0) return;
    _avgBlockTimeMs = ms;
  }

  Path1Observation path1Observation() =>
      foldSealedPots(_txs, observedIntervalMs: observedIntervalMs);

  /// Last height Continuum already settled into spendable.
  int get settledHeight => _settledHeight;

  /// Consensus floor: 9 confirmations. Operator lock — do not change; flag them.
  static const spendableConfirmations = 9;

  /// Continuum vortex lifetime matches consensus spendable.
  static const continuumConfirmations = 9;

  /// Third-party/merchant policy (~18 min). Not consensus.
  static const minConfirms = 12;

  /// Pool/merchant "confirmed" band. Policy, not consensus. From getpolicy.
  int confirmedNeed = 30;

  /// Policy freeze: Continuum spendable stays pending even past 6.
  bool creditsFrozen = false;

  /// Policy freeze_reason from getpolicy (h_ratio / d_max / side_lead).
  String freezeReason = '';

  /// One-line Continuum banner when frozen. Empty when not frozen.
  String freezeBanner = '';

  /// True when the connected tip includes the Reserve vault seal (or no seal yet).
  bool vaultSealAncestry = true;

  /// Divergent pre-seal fork: Continuum paints a blank pot.
  bool blankFork = false;

  /// One-line Continuum banner when the tip lacks vault-seal ancestry. Empty otherwise.
  String vaultSealBanner = '';
  final List<({String dest, double amount, int height})> _immature = [];

  /// Node/history lands enrolled into [_immature], keyed `dest|height`.
  final Set<String> _landEnrolled = {};

  /// Those lands already moved into [_spendable] by [settleTo].
  final Set<String> _landSettled = {};

  /// Matured node-land SHE by dest. A balance snapshot must not erase this.
  final Map<String, double> _settledNodeShe = {};

  /// Read lag-1 continuity from a 128-byte tip header. Next dest uses sealedHeight+1.
  void applyTipHeader(Uint8List header, {required int sealedHeight}) {
    lag1Root = lag1ContinuityFromHeader(header);
    final ts = headerTimestampMs(header);
    if (ts != null) {
      if (_headerTimestampMs != null && ts != _headerTimestampMs) {
        _prevHeaderTimestampMs = _headerTimestampMs;
      }
      _headerTimestampMs = ts;
    }
    if (_acceptHeader(header, sealedHeight) && sealedHeight > _verifiedTip) {
      _verifiedTip = sealedHeight;
    }
    _advanceSealed(sealedHeight);
  }

  /// The tab already shows this live tip. Move the sealed cursor with it so
  /// the note scan is not skipped while Shearview sits on an older height.
  /// A failed read of 0 does not wipe a remembered tip.
  void noteLiveHeight(int height) {
    if (height < 1 || height <= _sealedHeight) return;
    applyTipHex('', sealedHeight: height);
  }

  void applyTipHex(String headerHex, {required int sealedHeight}) {
    if (sealedHeight < 1) {
      // Height 0 / empty fake tip must not overwrite a remembered header.
      _advanceSealed(sealedHeight);
      return;
    }
    final raw = headerFromHex(headerHex);
    if (raw == null) {
      tipHeight = sealedHeight + 1;
      _advanceSealed(sealedHeight);
      return;
    }
    applyTipHeader(raw, sealedHeight: sealedHeight);
  }

  /// Painted tip can run ahead of credit sync. Bundle the closed open-round
  /// when height actually moves so pending does not freeze.
  void _advanceSealed(int sealedHeight) {
    final prev = _sealedHeight;
    if (sealedHeight < 1) {
      // Unreachable/failed RPC must not paint 0 over a remembered tip.
      settleTo(bookTip);
      return;
    }
    tipHeight = sealedHeight + 1;
    if (sealedHeight > _sealedHeight) _sealedHeight = sealedHeight;
    if (sealedHeight > prev) {
      if (prev > 0) {
        _historyAt.clear();
        _notesAt.clear();
        _bundleOpenRounds(height: prev + 1);
      }
      creditNodeLandsInGap(before: prev, tip: sealedHeight);
      // A coinbase row that only repeats the pool fee is not a landing.
      tipAdvancedWithoutLanding = !_realCreditAt(sealedHeight);
    }
    settleTo(bookTip);
  }

  void _bundleOpenRounds({required int height}) {
    // Only the still-open hash round becomes a block. Height-stamped
    // receive/send rows keep their id so the Continuum pie does not
    // remount (flash) on every new header.
    final dests = <String>{..._pending.keys};
    for (final t in _txs) {
      if (t.confirmed) continue;
      if (t.kind == 'hash' && (t.height ?? 0) < 1 && t.to.isNotEmpty) {
        dests.add(payKey(t.to));
      }
    }
    for (final d in dests) {
      if (d.isEmpty) continue;
      final openAmt = _pending[d] ?? 0;
      final openHash = hashPendingOf(d) > 0;
      if (openAmt <= 0 && !openHash) continue;
      confirmRound(address: d, pot: 0, height: height);
    }
  }

  Iterable<ShearTx> get transactions => List.unmodifiable(_txs);

  String payKey(String address) {
    if (isDestAddress(address)) return address;
    return currentDest(address);
  }

  bool _isProgramVaultDest(String address) {
    if (address.isEmpty) return false;
    if (_vaultDests.contains(address)) return true;
    final key = isDestAddress(address) ? address : '';
    if (key.isNotEmpty && _vaultDests.contains(key)) return true;
    final vk = viewSecret;
    if (vk == null || vk.isEmpty) return false;
    for (final rest in _restFrames()) {
      final v = vaultDest(rest, viewKey: vk);
      if (v != null && (v == address || v == key)) {
        _vaultDests.add(v);
        return true;
      }
    }
    return false;
  }

  Iterable<String> _restFrames() sync* {
    for (final d in _dests) {
      yield d;
    }
  }

  void rememberVaultDest(String dest) {
    if (dest.isEmpty) return;
    _vaultDests.add(dest);
    _spendable.remove(dest);
    _pending.remove(dest);
    _dests.remove(dest);
  }

  void bindVaultDest({required String restFrame, required String viewKey}) {
    final v = vaultDest(restFrame, viewKey: viewKey);
    if (v != null) rememberVaultDest(v);
  }

  /// Track a Continuum dest without crediting spendable.
  void rememberDest(String address) {
    if (address.isEmpty) return;
    final key = payKey(address);
    if (_isProgramVaultDest(address) || _isProgramVaultDest(key)) return;
    _dests.add(key);
  }

  void _dropProgramVaults() {
    final drop = <String>[];
    for (final d in _dests) {
      if (_isProgramVaultDest(d)) drop.add(d);
    }
    for (final d in [..._spendable.keys]) {
      if (_isProgramVaultDest(d)) drop.add(d);
    }
    for (final d in drop) {
      _dests.remove(d);
      _spendable.remove(d);
      _pending.remove(d);
    }
  }

  double spendable(String address) {
    if (_isProgramVaultDest(address) || _isProgramVaultDest(payKey(address)))
      return 0;
    return _spendable[payKey(address)] ?? _spendable[address] ?? 0;
  }

  /// Per-dest pending, or the wallet total when [address] is a rest-frame / she1.
  /// Money dests are destCommit(spendPub) and stealth dests in [_stealthShared].
  double pending(String address, {String? paymentCode}) {
    if (isDestAddress(address)) return (_pending[address] ?? 0) + _unminedNoteShe({payKey(address), address});
    var n = 0.0;
    final seen = <String>{};
    void add(String k) {
      if (k.isEmpty || !seen.add(k)) return;
      n += _pending[k] ?? 0;
    }

    add(address);
    add(currentDest(address, paymentCode: paymentCode));
    for (final d in moneyDests(address, paymentCode: paymentCode)) {
      add(d);
    }
    return n + _unminedNoteShe({for (final d in seen) ...{d, payKey(d)}});
  }

  /// This wallet's own change not yet mined, over every money dest it owns:
  /// the home screen shows it as Pending (gate 3). It is never Spendable and
  /// becomes Spendable once a chain read gives it a height with its
  /// confirmations.
  double unminedChangeShe(String restFrame, {String? paymentCode}) {
    final dests = <String>{};
    for (final d in moneyDests(restFrame, paymentCode: paymentCode)) {
      if (d.isEmpty) continue;
      dests
        ..add(d)
        ..add(payKey(d));
    }
    return _unminedNoteShe(dests);
  }

  /// This wallet's own notes not yet mined (no block height): change from a
  /// posted lock or send. Never Spendable (spendableNote needs a height);
  /// shown as Pending until a chain read gives them one.
  double _unminedNoteShe(Set<String> dests) {
    var total = BigInt.zero;
    for (final n in _notes) {
      if (n['spent'] == true || n['reorged'] == true || n['verified'] != true) continue;
      if (isVaultLockNote(n) || (n['kind'] ?? '').toString() == 'lock') continue;
      final h = n['height'];
      if (h is num && h >= 1) continue;
      final addr = (n['address'] ?? n['dest'])?.toString() ?? '';
      if (addr.isEmpty || !(dests.contains(addr) || dests.contains(payKey(addr)))) continue;
      final nanos = noteNanosExact(n);
      if (nanos == null || nanos <= BigInt.zero) continue;
      total += nanos;
    }
    return _sheOfNanos(total);
  }

  /// Accrue 0.00000000001 SHE per hash this open round. Live pending row (lean: one
  /// row per dest, count in [ShearTx.amount]), not spendable, not an explorer row.
  void creditHash(String address, {int hashes = 1}) {
    final add = hashes * kHashBonusShe;
    if (add <= 0) return;
    final key = payKey(address);
    _pending[key] = (_pending[key] ?? 0) + add;
    _dests.add(key);
    _upsertHashPending(key, hashPendingOf(key) + add);
  }

  double hashPendingOf(String address) {
    final key = payKey(address);
    final id = _hashPendingId(key);
    for (final t in _txs) {
      if (t.id == id) return t.amount;
    }
    return 0;
  }

  String _hashPendingId(String dest) => 'hash-pending-$dest';

  void _upsertHashPending(String dest, double amount) {
    final id = _hashPendingId(dest);
    _txs.removeWhere((t) => t.id == id);
    if (amount <= 0) return;
    _txs.add(
      ShearTx(
        id: id,
        from: 'hash',
        to: dest,
        amount: amount,
        kind: 'hash',
        confirmed: false,
      ),
    );
  }

  /// Incoming transfer this open round. Live pending until [confirmRound].
  ShearTx creditReceive({
    required String to,
    required double amount,
    String? from,
    String? id,
    Uint8List? ephPub,
    String? paymentCode,
  }) {
    if (amount <= 0) throw ArgumentError('amount');
    var dest = to;
    if (ephPub != null &&
        paymentCode != null &&
        (viewSecret ?? '').isNotEmpty) {
      final parsed = decodePaymentCode(paymentCode);
      final spend = parsed?['spendPub'];
      if (spend != null) {
        final rec = recognizeSilentDest(
          viewKey: viewSecret!,
          spendPub: spend,
          dest: to,
          ephPub: ephPub,
        );
        if (rec != null) {
          dest = rec['dest'] as String;
          _stealthShared[dest] = rec['shared'] as Uint8List;
        }
      }
    }
    final key = payKey(dest);
    _dests.add(key);
    final tx = ShearTx(
      id: id ?? 'recv-pending-$key-${_txs.length}',
      from: from ?? 'pending',
      to: key,
      amount: amount,
      kind: 'receive',
      confirmed: false,
    );
    final have = _txs.indexWhere((t) => _sameReceiptMoney(t, tx));
    if (have >= 0 &&
        (_standInReceipt(tx.id) ||
            _standInReceipt(_txs[have].id) ||
            !_anchorReceipt(tx) ||
            !_anchorReceipt(_txs[have]) ||
            (tx.height ?? 0) == (_txs[have].height ?? 0))) {
      _txs[have] = _preferReceipt([_txs[have], tx]);
      _collapseDuplicateReceipts();
      return _txs[have];
    }
    _pending[key] = (_pending[key] ?? 0) + amount;
    _txs.add(tx);
    _collapseDuplicateReceipts();
    return tx;
  }

  void _applyPoolHashPending(String address, double hashAmount) {
    final key = payKey(address);
    // Only the still-open round. Height-stamped receives are Continuum pie
    // rows, not live pending — recounting them refilled pending() after tip.
    final recv = _txs
        .where(
          (t) =>
              !t.confirmed &&
              t.kind == 'receive' &&
              (t.height ?? 0) < 1 &&
              (t.to == key || t.from == key || t.to == address),
        )
        .fold<double>(0, (n, t) => n + t.amount);
    _pending[key] = recv + hashAmount;
    if (key != address) _pending[address] = 0;
    _upsertHashPending(key, hashAmount);
  }

  /// A pool send and the wallet's echo of it. Not a block reward.
  bool _receiptKind(String kind) =>
      kind == 'receive' || kind == 'pool-withdraw';

  bool _standInReceipt(String id) =>
      id.startsWith('recv-pending-') ||
      id.startsWith('note:') ||
      id.startsWith('note-pending:') ||
      id.startsWith('round-');

  int _receiptNanos(double she) => (she * kUnitsPerShe).round();

  /// One payment. A withdraw echo can sit a few hundred nanos off the chain send.
  bool _sameReceiptMoney(ShearTx a, ShearTx b) {
    if (a.to.isEmpty || b.to.isEmpty) return false;
    if (payKey(a.to) != payKey(b.to)) return false;
    if (!_receiptKind(a.kind) || !_receiptKind(b.kind)) return false;
    return (_receiptNanos(a.amount) - _receiptNanos(b.amount)).abs() <= 1000;
  }

  bool _anchorReceipt(ShearTx t) =>
      t.kind == 'receive' && (t.height ?? 0) >= 1 && !_standInReceipt(t.id);

  ShearTx _preferReceipt(List<ShearTx> rows) {
    final anchors = rows.where(_anchorReceipt).toList();
    final base = anchors.isNotEmpty
        ? anchors.reduce((a, b) => (a.height ?? 0) >= (b.height ?? 0) ? a : b)
        : rows.reduce((a, b) {
            final ha = a.height ?? 0;
            final hb = b.height ?? 0;
            if (ha >= 1 && hb >= 1) return ha <= hb ? a : b;
            if (ha >= 1) return a;
            if (hb >= 1) return b;
            return a;
          });
    var height = base.height;
    if ((height ?? 0) < 1) {
      for (final t in rows) {
        final h = t.height ?? 0;
        if (h >= 1 && (height == null || h < height)) height = h;
      }
    }
    var from = base.from;
    if (from.isEmpty || from == 'pool' || from == 'pending') {
      for (final t in rows) {
        if (t.from.startsWith('ssa1')) {
          from = t.from;
          break;
        }
      }
    }
    return ShearTx(
      id: base.id,
      from: from,
      to: base.to,
      amount: base.amount,
      kind: base.kind,
      height: height,
      confirmed: rows.any((t) => t.confirmed),
      memo: rows.any((t) => t.memo),
      memoPlain: base.memoPlain,
      memoCt: base.memoCt,
      rounds: base.rounds,
      hashAmount: base.hashAmount,
      threads: base.threads,
      pot: base.pot,
      change: base.change,
      atMs: base.atMs,
    );
  }

  /// One row per incoming payment. Two chain receives at different heights stay.
  void _collapseDuplicateReceipts() {
    final drop = <int>[];
    final used = <int>{};
    for (var i = 0; i < _txs.length; i++) {
      if (used.contains(i) || !_receiptKind(_txs[i].kind)) continue;
      final group = <int>[i];
      for (var j = i + 1; j < _txs.length; j++) {
        if (_sameReceiptMoney(_txs[i], _txs[j])) group.add(j);
      }
      for (final j in group) {
        used.add(j);
      }
      if (group.length < 2) continue;
      final anchors = group.where((k) => _anchorReceipt(_txs[k])).toList();
      final anchorHeights = <int>{
        for (final k in anchors)
          if ((_txs[k].height ?? 0) >= 1) _txs[k].height!,
      };
      if (anchorHeights.length > 1) {
        final extras = group.where((k) => !_anchorReceipt(_txs[k])).toList();
        for (final k in extras) {
          var best = anchors.first;
          var bestDist = 1 << 30;
          final h = _txs[k].height ?? 0;
          for (final a in anchors) {
            final dist = h < 1 ? 0 : (h - (_txs[a].height ?? 0)).abs();
            if (dist < bestDist) {
              bestDist = dist;
              best = a;
            }
          }
          _txs[best] = _preferReceipt([_txs[best], _txs[k]]);
          drop.add(k);
        }
        continue;
      }
      final keep = group.first;
      _txs[keep] = _preferReceipt([for (final k in group) _txs[k]]);
      for (final k in group.skip(1)) {
        drop.add(k);
      }
    }
    drop.sort((a, b) => b.compareTo(a));
    for (final k in drop) {
      _txs.removeAt(k);
    }
  }

  /// Merge a chain/history row onto a local tx (same id, or a height-less
  /// pool-withdraw to the same dest and amount). Height and kind come from
  /// the node — never invented.
  void _dropFeeBlockMirror(ShearTx fee) {
    if (fee.kind != 'pool-fee') return;
    _txs.removeWhere((t) => isFeeBlockMirror(t, [fee]));
    final h = fee.height ?? 0;
    _immature.removeWhere(
      (r) =>
          r.height == h &&
          payKey(r.dest) == payKey(fee.to) &&
          (r.amount - fee.amount).abs() <= 1e-9,
    );
  }

  void mergeChainTx(ShearTx tx) {
    if (tx.kind == 'pool-fee') _dropFeeBlockMirror(tx);
    if (isFeeBlockMirror(tx, _txs)) return;
    if (tx.kind == 'hash' && tx.to.isNotEmpty) {
      final h = tx.height ?? 0;
      final she = tx.amount;
      if (she > 0 && h > 0) {
        final id = 'blockfound:$h:${tx.to}';
        final iTx = _txs.indexWhere((t) => t.id == id || t.id == tx.id);
        if (iTx >= 0) {
          final t = _txs[iTx];
          if ((t.hashAmount ?? 0) > 0) return;
          _txs[iTx] = ShearTx(
            id: id,
            from: t.from.isNotEmpty ? t.from : 'coinbase',
            to: t.to.isNotEmpty ? t.to : tx.to,
            amount: t.amount + she,
            kind: t.kind == 'hash' ? 'blockfound' : t.kind,
            height: t.height ?? h,
            confirmed: t.confirmed,
            hashAmount: (t.hashAmount ?? 0) + she,
            pot: t.pot,
            atMs: t.atMs ?? tx.atMs,
          );
        } else {
          _txs.add(
            ShearTx(
              id: id,
              from: 'coinbase',
              to: tx.to,
              amount: she,
              kind: 'blockfound',
              height: h,
              confirmed: confirmationsOf(h) >= spendableConfirmations,
              hashAmount: she,
              atMs: tx.atMs,
            ),
          );
        }
        rememberDest(tx.to);
      }
      return;
    }
    var i = _txs.indexWhere((t) => t.id == tx.id);
    if (i < 0 && tx.kind == 'pool-withdraw') {
      i = _txs.indexWhere(
        (t) =>
            t.kind == 'pool-withdraw' &&
            (t.height ?? 0) < 1 &&
            t.to == tx.to &&
            (t.amount - tx.amount).abs() < 1e-9,
      );
    }
    if (i >= 0) {
      final prev = _txs[i];
      final nextHeight = (tx.height ?? 0) > (prev.height ?? 0)
          ? tx.height
          : prev.height;
      _txs[i] = ShearTx(
        id: tx.id.isNotEmpty ? tx.id : prev.id,
        from: tx.from.isNotEmpty ? tx.from : prev.from,
        to: prev.to.isNotEmpty ? prev.to : tx.to,
        amount: tx.amount > 0 ? tx.amount : prev.amount,
        kind: tx.kind.isNotEmpty ? tx.kind : prev.kind,
        height: nextHeight,
        confirmed: tx.confirmed,
        memo: prev.memo || tx.memo,
        memoPlain: prev.memoPlain ?? tx.memoPlain,
        memoCt: prev.memoCt ?? tx.memoCt,
        rounds: prev.rounds ?? tx.rounds,
        hashAmount: prev.hashAmount ?? tx.hashAmount,
        threads: prev.threads ?? tx.threads,
        pot: prev.pot ?? tx.pot,
        change: prev.change ?? tx.change,
        atMs: tx.atMs ?? prev.atMs,
      );
      if (isWalletBlockKind(tx.kind) || isWalletBlockKind(prev.kind)) {
        final h = (nextHeight ?? 0);
        final amt = tx.amount > 0 ? tx.amount : prev.amount;
        final dest = prev.to.isNotEmpty ? prev.to : tx.to;
        _enrollOwnerLand(dest: dest, amount: amt, height: h);
      }
      return;
    }
    if (_receiptKind(tx.kind)) {
      final have = _txs.indexWhere((t) => _sameReceiptMoney(t, tx));
      final sameSlot =
          have >= 0 &&
          (_standInReceipt(tx.id) ||
              _standInReceipt(_txs[have].id) ||
              !_anchorReceipt(tx) ||
              !_anchorReceipt(_txs[have]) ||
              (tx.height ?? 0) == (_txs[have].height ?? 0) ||
              (tx.height ?? 0) < 1 ||
              (_txs[have].height ?? 0) < 1);
      if (sameSlot) {
        _txs[have] = _preferReceipt([_txs[have], tx]);
        _collapseDuplicateReceipts();
        if (tx.to.isNotEmpty && !_isProgramVaultDest(tx.to))
          rememberDest(tx.to);
        return;
      }
    }
    if (tx.kind == 'receive' && (tx.height ?? 0) < 1 && !tx.confirmed) {
      creditReceive(to: tx.to, amount: tx.amount, from: tx.from, id: tx.id);
      return;
    }
    if (tx.isBlockBundle && (tx.height ?? 0) >= 1 && tx.to.isNotEmpty) {
      final slot = _txs.indexWhere(
        (t) => t.isBlockBundle && t.to == tx.to && (t.height ?? 0) == tx.height,
      );
      if (slot >= 0) {
        final prev = _txs[slot];
        _txs[slot] = ShearTx(
          id: prev.id.isNotEmpty ? prev.id : tx.id,
          from: prev.from.isNotEmpty ? prev.from : tx.from,
          to: prev.to,
          amount: prev.amount > 0 ? prev.amount : tx.amount,
          kind: prev.kind.isNotEmpty ? prev.kind : tx.kind,
          height: prev.height,
          confirmed: prev.confirmed,
          memo: prev.memo || tx.memo,
          memoPlain: prev.memoPlain ?? tx.memoPlain,
          memoCt: prev.memoCt ?? tx.memoCt,
          rounds: prev.rounds ?? tx.rounds,
          hashAmount: prev.hashAmount ?? tx.hashAmount,
          threads: prev.threads ?? tx.threads,
          pot: prev.pot ?? tx.pot,
          change: prev.change ?? tx.change,
          atMs: prev.atMs ?? tx.atMs,
        );
        _enrollOwnerLand(
          dest: prev.to,
          amount: prev.amount > 0 ? prev.amount : tx.amount,
          height: prev.height ?? 0,
        );
        return;
      }
    }
    _txs.add(tx);
    if (isWalletBlockKind(tx.kind)) {
      _enrollOwnerLand(dest: tx.to, amount: tx.amount, height: tx.height ?? 0);
    }
    if (_receiptKind(tx.kind)) _collapseDuplicateReceipts();
    if (tx.to.isNotEmpty && !_isProgramVaultDest(tx.to)) rememberDest(tx.to);
  }

  bool get needsHistoryRefresh => pendingReceiveThinPoll(_txs);

  bool get hasPendingReceive => pendingReceiveThinPoll(_txs);

  bool get historyBehindTip {
    if (_sealedHeight < 1) return false;
    if (_historyAt.isEmpty) return true;
    return _historyAt.values.any((h) => h != _sealedHeight);
  }

  void applyMemoPlain(String id, String? plain) {
    if (plain == null || plain.isEmpty) return;
    ShearTx? found;
    for (final t in _txs) {
      if (t.id == id) {
        found = t;
        break;
      }
    }
    if (found == null) return;
    mergeChainTx(
      ShearTx(
        id: found.id,
        from: found.from,
        to: found.to,
        amount: found.amount,
        kind: found.kind,
        height: found.height,
        confirmed: found.confirmed,
        memo: true,
        memoPlain: plain,
        memoCt: found.memoCt,
        hashAmount: found.hashAmount,
        threads: found.threads,
        pot: found.pot,
      ),
    );
  }

  /// Live mempool pays. Same row as [creditReceive]; merge height when the
  /// node already sealed the pay.
  void _ingestIncoming(Map<String, dynamic> json) {
    final rows = json['incoming'];
    if (rows is! List) return;
    for (final row in rows) {
      if (row is! Map) continue;
      final id = row['id']?.toString() ?? '';
      final to = row['to']?.toString() ?? '';
      var amount = (row['amount'] as num?)?.toDouble() ?? 0;
      if (amount <= 0 && row['nanos'] is num) {
        amount = (row['nanos'] as num).toDouble() / kUnitsPerShe;
      }
      if (id.isEmpty || to.isEmpty || amount <= 0) continue;
      final kind = row['kind']?.toString() ?? 'receive';
      final height = (row['height'] as num?)?.toInt();
      mergeChainTx(
        ShearTx(
          id: id,
          from:
              row['from']?.toString() ??
              (kind == 'pool-withdraw' ? 'pool' : 'pending'),
          to: to,
          amount: amount,
          kind: kind == 'pool-withdraw' ? 'pool-withdraw' : 'receive',
          height: height,
          confirmed: row['confirmed'] == true,
        ),
      );
    }
  }

  /// Block found: pending hash bonus + pending receives + pot become spendable.
  /// Individual hash rows are bundled into one coinbase and pruned.
  ShearTx confirmRound({
    required String address,
    double pot = 0,
    int height = 0,
  }) {
    final dest = payKey(address);
    final roundId = 'round-$height-$dest';
    final existing = _txs.cast<ShearTx?>().firstWhere(
      (t) => t!.id == roundId,
      orElse: () => null,
    );
    if (existing != null) {
      if (height > _sealedHeight) _sealedHeight = height;
      settleTo(bookTip);
      prune();
      _collapseDuplicateReceipts();
      return _txs.firstWhere((t) => t.id == roundId, orElse: () => existing);
    }
    final bonus = dest == address
        ? (_pending[address] ?? 0)
        : (_pending[dest] ?? 0) + (_pending[address] ?? 0);
    final total = bonus + pot;
    _pending[dest] = 0;
    if (dest != address) _pending[address] = 0;
    if (total > 0) {
      _immature.add((dest: dest, amount: total, height: height));
    }
    _dests.add(dest);
    final hashBonus =
        hashPendingOf(dest) + (dest == address ? 0 : hashPendingOf(address));
    final coinbaseAmt = pot + hashBonus;
    final tx = ShearTx(
      id: roundId,
      from: 'coinbase',
      to: dest,
      amount: coinbaseAmt > 0 ? coinbaseAmt : total,
      kind: 'coinbase',
      height: height,
      confirmed: false,
      hashAmount: hashBonus > 0 ? hashBonus : null,
      pot: pot > 0 ? pot : null,
    );
    if ((coinbaseAmt > 0 ? coinbaseAmt : total) > 0) _txs.add(tx);
    if (height > _sealedHeight) _sealedHeight = height;
    for (var i = 0; i < _txs.length; i++) {
      if (_txs[i].confirmed) continue;
      _txs[i] = _txs[i].copyWith(height: _txs[i].height ?? height);
    }
    settleTo(bookTip);
    prune();
    _collapseDuplicateReceipts();
    final kept = _txs.cast<ShearTx?>().firstWhere(
      (t) => t!.id == roundId,
      orElse: () => null,
    );
    return kept ?? tx;
  }

  /// Confirmations of a sealed height, counting the including block as 1.
  /// Depth is [bookTip], the verified tip, not the notes scan cursor.
  int confirmationsOf(int height, [int? tip]) {
    final t = tip ?? bookTip;
    if (height < 1 || t < height) return 0;
    return t - height + 1;
  }

  /// Hash bonus on verified dests at ≥ 9 confirmations. Display only; no claim.
  double confirmedHashBonus(String restFrame, {String? paymentCode}) {
    final keys = ownedAddresses(restFrame, paymentCode: paymentCode);
    var n = 0.0;
    for (final t in _txs) {
      final bonus = t.hashAmount ?? 0;
      if (bonus <= 0) continue;
      if (!keys.contains(t.to) && t.to != restFrame) continue;
      final h = t.height ?? 0;
      if (h < 1) continue;
      if (confirmationsOf(h) < spendableConfirmations) continue;
      n += bonus;
    }
    return n;
  }

  /// Policy available (default 12 confs). Consensus spendable is 6 confs.
  double policyAvailable(String address, {int? confirms, String? paymentCode}) {
    final need = confirms ?? minConfirms;
    final keys = ownedAddresses(address, paymentCode: paymentCode);
    var n = 0.0;
    for (final t in _txs) {
      if (!t.confirmed) continue;
      if (!keys.contains(t.to) && t.to != address) continue;
      final h = t.height ?? 0;
      if (confirmationsOf(h) >= need) n += t.amount;
    }
    return n;
  }

  void applyPolicy(Map<String, dynamic> json) {
    final rawReason = json['freeze_reason']?.toString() ?? '';
    final creditHold = rawReason == 'h_ratio';
    creditsFrozen = json['frozen'] == true && !creditHold;
    final op = json['operational'];
    if (!creditHold && op is Map && op['pool_merchant'] is num) {
      confirmedNeed = (op['pool_merchant'] as num).toInt();
    }
    freezeReason = creditHold ? '' : rawReason;
    freezeBanner = creditHold ? '' : (json['freeze_banner']?.toString() ?? '');
    if (freezeBanner.contains('h_ratio')) {
      creditsFrozen = false;
      freezeReason = '';
      freezeBanner = '';
    }
    if (!creditsFrozen) {
      freezeReason = '';
      freezeBanner = '';
    } else if (freezeBanner.isEmpty) {
      final reason = freezeReason.isEmpty ? 'policy' : freezeReason;
      freezeBanner =
          'Credits frozen ($reason): confirmations elevated to $confirmedNeed.';
    }
    applyVaultSeal(json);
  }

  /// Blank-fork Reserve view. Independent of credits freeze.
  void applyVaultSeal(Map<String, dynamic> json) {
    if (json.containsKey('vault_seal_ancestry')) {
      vaultSealAncestry = json['vault_seal_ancestry'] == true;
    }
    if (json.containsKey('blank_fork')) {
      blankFork = json['blank_fork'] == true;
    } else if (json.containsKey('vault_seal_ancestry')) {
      blankFork = json['vault_seal_ancestry'] != true;
    }
    if (json.containsKey('vault_seal_banner')) {
      vaultSealBanner = json['vault_seal_banner']?.toString() ?? '';
    }
    if (vaultSealAncestry && !blankFork) {
      vaultSealBanner = '';
    }
    if (blankFork) _clearReserveHold();
  }

  /// Disconnect orphaned heights; rows bounce to pending.
  /// Does not delete notes. A host height list is not a reason to drop coins.
  void bounceHeights(Iterable<int> heights) {
    final drop = heights.toSet();
    if (drop.isEmpty) return;
    for (var i = 0; i < _txs.length; i++) {
      final h = _txs[i].height ?? 0;
      if (!drop.contains(h)) continue;
      final t = _txs[i];
      if (t.confirmed) {
        _spendable[t.to] = (_spendable[t.to] ?? 0) - t.amount;
      }
      _txs[i] = t.copyWith(confirmed: false);
      _immature.add((dest: t.to, amount: t.amount, height: h));
      if (isWalletBlockKind(t.kind) && h >= 1) {
        final pk = payKey(t.to);
        final key = _ownerLandKey(pk, h);
        if (_landSettled.remove(key)) {
          final left = (_settledNodeShe[pk] ?? 0) - t.amount;
          if (left <= 1e-12) {
            _settledNodeShe.remove(pk);
          } else {
            _settledNodeShe[pk] = left;
          }
          _landEnrolled.add(key);
        }
      }
    }
    prune();
  }

  /// Move immature credits into spendable once the committing block is accepted.
  /// Six confirmations is the fingerprint floor. A freeze banner does not hold them.
  void settleTo(int tip) {
    if (tip > _verifiedTip) _verifiedTip = tip;
    if (tip > _sealedHeight) _sealedHeight = tip;
    final keep = <({String dest, double amount, int height})>[];
    for (final row in _immature) {
      if (confirmationsOf(row.height, tip) >= spendableConfirmations) {
        _spendable[row.dest] = (_spendable[row.dest] ?? 0) + row.amount;
        final pk = payKey(row.dest);
        final key = _ownerLandKey(pk, row.height);
        if (_landEnrolled.contains(key) && _landSettled.add(key)) {
          _settledNodeShe[pk] = (_settledNodeShe[pk] ?? 0) + row.amount;
        }
        if (row.height > _settledHeight) _settledHeight = row.height;
      } else {
        keep.add(row);
      }
    }
    _immature
      ..clear()
      ..addAll(keep);
    for (var i = 0; i < _txs.length; i++) {
      final h = _txs[i].height ?? 0;
      if (confirmationsOf(h, tip) >= spendableConfirmations) {
        _txs[i] = _txs[i].copyWith(confirmed: true);
      }
    }
    prune();
  }

  /// Drop per-hash sample noise. Keep sealed txs + in-flight send/hash/receive
  /// and unsigned-then-signed pool-withdraw. Hash rows with a height are
  /// already bundled into the block and dropped.
  void prune() {
    final seen = <String>{};
    final next = <ShearTx>[];
    for (final t in _txs) {
      if (t.kind == 'sample') continue;
      if (t.kind == 'hash' && (t.confirmed || (t.height ?? 0) > 0)) continue;
      if (!t.confirmed &&
          t.kind != 'send' &&
          t.kind != 'hash' &&
          t.kind != 'receive' &&
          t.kind != 'coinbase' &&
          t.kind != 'blockfound' &&
          t.kind != 'mine' &&
          t.kind != 'pool-fee' &&
          t.kind != 'pool-withdraw' &&
          t.kind != 'lock' &&
          t.kind != 'withdraw')
        continue;
      if (!seen.add(t.id)) continue;
      next.add(t);
    }
    _txs
      ..clear()
      ..addAll(next);
  }

  /// Header figure from an old session. Advisory only: it never raises
  /// Spendable above notes this wallet has already reconstructed.
  void rememberSpendable(String address, double amount) {
    if (_isProgramVaultDest(address) || _isProgramVaultDest(payKey(address)))
      return;
    final key = isDestAddress(address) ? address : payKey(address);
    if (!isDestAddress(key)) return;
    _advisorySpendable[key] = amount;
    final owned = inventoriedNoteShe(key, sum: true);
    final shown = spendable(key);
    if (shown > owned + 1e-12) _spendable[key] = owned;
  }

  Future<void> _applyStatsTip(
    Map<String, dynamic> json, {
    bool walkGenesis = true,
  }) async {
    if (pool != null && isPoolLedgerHost(pool!.baseUrl)) return;
    final paint = chainPaintFromNodeStats(json);
    if (!paint.usable) {
      applyTipHex('', sealedHeight: 0);
      return;
    }
    if (json['policy'] is Map) {
      applyPolicy(Map<String, dynamic>.from(json['policy'] as Map));
    } else if (json['frozen'] is bool) {
      applyPolicy({
        'frozen': json['frozen'],
        'freeze_reason': json['freeze_reason'],
        'freeze_banner': json['freeze_banner'],
      });
    }
    applyVaultSeal(json);
    final sealed = paint.tip;
    final hex = paint.headerHex;
    if (walkGenesis) {
      final genesis = pool!.genesisHex ?? await pool!.fetchGenesisHex();
      if (genesis != null && genesis.isNotEmpty) bindChainGenesis(genesis);
    } else {
      final named = json['genesis']?.toString() ?? '';
      if (named.isNotEmpty) bindChainGenesis(named);
    }
    await catchUpVerifiedChain(sealed);
    await _prepareTipHash(hex, sealed);
    applyTipHex(hex, sealedHeight: sealed);
    _applyReorgList(json['orphans'] ?? json['reorgHeights']);
    if (json.containsKey('hashrate')) networkHashrate = paint.hashrate;
    if (json.containsKey('circulatingNanos'))
      circulatingNanos = paint.circulatingNanos;
    if (json.containsKey('bits') || json.containsKey('blockBits')) {
      networkBits = paint.bits;
    }
    final raw = json['networkAvgBlockTimeMs'] ?? json['avgBlockTimeMs'];
    final avg = raw is num ? raw.round() : int.tryParse('$raw');
    if (avg != null && avg >= 0) applyAvgBlockTimeMs(avg);
    applyCirculatingNanos(json['circulatingNanos']);
    void take(String k, void Function(int) set) {
      final v = json[k];
      if (v is num && v >= 0) set(v.round());
    }

    take('hashBonusNanos', (n) => liveHashBonusNanos = n);
    take('extraMintedNanos', (n) => extraMintedNanos = n);
    take('mintBankNanos', (n) => extraMintedNanos = n);
    if (blankFork) {
      _clearReserveHold();
    } else {
      take('lockedNanos', (n) => vaultLockedNanos = n);
      if (json['reserveVaultNanos'] is num) {
        vaultLockedNanos = (json['reserveVaultNanos'] as num).round();
      }
    }
    take('potEmittedNanos', (n) => potEmittedNanos = n);
    take('hashBonusEmittedNanos', (n) => hashBonusEmittedNanos = n);
    if (json.containsKey('potEmittedNanos') ||
        json.containsKey('hashBonusEmittedNanos')) {
      final at = (json['height'] as num?)?.toInt() ?? 0;
      if (at > 0) emittedAtHeight = at;
    }
    final work = json['bits'];
    if (work is num && work > 0 && work < 1000)
      networkWorkBits = work.toDouble();
    final mean = sealedMeanBlockMsFromStats(json);
    if (mean != null) sealedMeanBlockMs = mean;
    take('miners', (n) => networkMiners = n);
  }

  /// Display fields from a public `/api/stats` body. Does not move the tip
  /// and does not change spendable. Pool height is not a chain tip.
  void applyContinuityStats(Map<String, dynamic> json) {
    int? takeInt(String key) {
      final v = json[key];
      if (v is num && v >= 0) return v.round();
      return null;
    }

    final hr = takeInt('hashrate');
    if (hr != null) networkHashrate = hr;
    final circ = takeInt('circulatingNanos');
    if (circ != null && circ > 0) circulatingNanos = circ;
    final pot = takeInt('potEmittedNanos');
    if (pot != null) potEmittedNanos = pot;
    final bonus = takeInt('hashBonusEmittedNanos');
    if (bonus != null) hashBonusEmittedNanos = bonus;
    if (pot != null || bonus != null) {
      final at = takeInt('height');
      if (at != null && at > 0) emittedAtHeight = at;
    }
    final work = json['bits'];
    if (work is num && work > 0 && work < 1000)
      networkWorkBits = work.toDouble();
    final mean = sealedMeanBlockMsFromStats(json);
    if (mean != null) sealedMeanBlockMs = mean;
  }

  /// The public node `/stats` body has no hashrate, supply, bits, or sealed
  /// mean. The explorer reads those from the pool stats feed. A loopback book
  /// (tests) does not call the public pool. Phone wallets do not call this.
  /// Returns true when a displayed figure changed.
  Future<bool> readContinuityFigures({
    ShearPoolClient Function(String baseUrl)? open,
  }) async {
    if (pool?.usesOwnNode == true) return false;
    if (pool?.publicConsent != true) return false;
    final host = Uri.tryParse(pool?.baseUrl ?? '')?.host ?? '';
    if (host == '127.0.0.1' || host == 'localhost' || host == '::1')
      return false;
    final client = open != null
        ? open(kPublicPoolHttp)
        : ShearPoolClient(baseUrl: kPublicPoolHttp);
    try {
      final json = await client.stats().timeout(const Duration(seconds: 6));
      final before =
          '$networkHashrate|$sealedMeanBlockMs|$circulatingNanos|$potEmittedNanos|$networkWorkBits|$emittedAtHeight';
      applyContinuityStats(json);
      final after =
          '$networkHashrate|$sealedMeanBlockMs|$circulatingNanos|$potEmittedNanos|$networkWorkBits|$emittedAtHeight';
      return before != after;
    } catch (_) {
      return false;
    } finally {
      client.close();
    }
  }

  /// [proveChain] walks every header and compact block. That walk on the UI
  /// isolate is the Android "isn't responding" dialog. Login and the accrual
  /// tick pass false and only take a live base plus `/stats`.
  Future<void> syncTip({bool proveChain = true}) async {
    if (pool == null) return;
    final frame = _restFrame;
    if (frame != null && frame.isNotEmpty) {
      final dests = moneyDests(frame).toList();
      pool!.sync?.proofDests = dests;
      pool!.sync?.proofDest = dests.isEmpty ? homeDest(frame) : dests.first;
    }
    try {
      if (!proveChain) {
        final sync = pool!.sync;
        // findLiveNode waits out the slowest seed. A dead loopback then
        // expires this tick before a public node is adopted, and the bar
        // stays "not connected".
        if (sync != null &&
            !pool!.usesOwnNode &&
            (sync.liveBase == null || sync.liveBase!.isEmpty)) {
          final found = await firstLiveNodeSeed(
            sync.seeds,
            publicConsent: pool!.publicConsent,
          );
          if (found.isNotEmpty) sync.liveBase = found;
        }
      }
      final live = pool!.liveTip;
      if (live > _sealedHeight) noteLiveHeight(live);
      final first = await pool!.stats().timeout(const Duration(seconds: 2));
      await _applyStatsTip(first, walkGenesis: false);
      if (!proveChain) {
        final tip = (first['height'] as num?)?.toInt() ?? 0;
        final sync = pool!.sync;
        if (sync != null && tip > sync.sampledTip) sync.sampledTip = tip;
      }
    } catch (_) {}
    if (!proveChain) return;
    try {
      await pool!.followLive().timeout(kWalletTipTimeout);
      final json = await pool!.stats().timeout(const Duration(seconds: 2));
      await _applyStatsTip(json);
    } catch (_) {}
  }

  Future<double> syncSpendable(String address) async {
    final prev = spendable(address);
    if (pool == null) return prev;
    try {
      final before = _settledHeight;
      await syncTip(proveChain: false);
      final json = await _balanceWithOne504Retry(address);
      applyPoolSnapshot(
        address,
        json,
        beforeHeight: before,
        tipSealed: _sealedHeight,
      );
      _markSettled(_sealedHeight, before);
      await syncHistory(address);
      return spendable(address);
    } catch (e) {
      if (poolHttp504(e)) rethrow;
      return prev;
    }
  }

  /// False when the last notes read failed or none has run in this process.
  /// A saved book and a positive balance do not make this true. A successful
  /// empty list may paint 0. A node balance does not make this true.
  bool spendableFigureReady(String restFrame, {String? paymentCode}) {
    if (_spendableReadFailed == true) return false;
    if (_spendableReadFailed != false) return false;
    if (_unopenedListedProofs > 0 &&
        spendableOwned(restFrame, paymentCode: paymentCode) <= 1e-12) {
      return false;
    }
    return true;
  }

  double spendableOwned(String restFrame, {String? paymentCode}) {
    spendPub ??= decodePaymentCode(paymentCode ?? '')?['spendPub'];
    _dropProgramVaults();
    refreshTimeLockedNotes();
    final pool = poolSpendableNotes(_spendPlanInput(restFrame, paymentCode, 0));
    return _sheOfNanos(pool.freeSum);
  }

  /// Vortex Flow figure. One reconstruct input. Exact note nanos win when the
  /// painted double cannot name the count.
  int continuumFlowNanos(String restFrame, {String? paymentCode}) {
    refreshTimeLockedNotes();
    final owned = <String>{};
    for (final d in moneyDests(restFrame, paymentCode: paymentCode)) {
      if (!isDestAddress(d)) continue;
      owned.add(payKey(d));
    }
    final notes = <BigInt>[];
    for (final n in _notes) {
      if (n['spent'] == true || n['locked'] == true) continue;
      final dest = (n['address'] ?? n['dest'])?.toString() ?? '';
      if (dest.isEmpty || !owned.contains(payKey(dest))) continue;
      final exact = noteNanosExact(n);
      if (exact != null) notes.add(exact);
    }
    return vortexFlowNanos(
      spendableShe: spendableOwned(restFrame, paymentCode: paymentCode),
      exactNotes: notes,
    );
  }

  /// Open-wallet coin control. Notes parked on the shear1 rest frame join the
  /// spendable dest. Every other owned ssa1 stays one note and is counted in
  /// that same sum. A young note stays unspendable. Does not invent coins.
  /// Flip lock notes once the tip time has passed their unlock.
  void refreshTimeLockedNotes() {
    final tip = tipTimestampMs;
    for (final n in _notes) {
      if ((n['kind'] ?? '').toString() != 'lock') continue;
      n['locked'] = lockNoteIsLocked(n, tip);
    }
  }

  double recheckRestFrameSpendable(String restFrame, {String? paymentCode}) {
    refreshTimeLockedNotes();
    _dropProgramVaults();
    _foldFlowDest(restFrame, paymentCode: paymentCode);
    final bound = currentDest(restFrame, paymentCode: paymentCode);
    if (!isDestAddress(bound)) {
      return spendableOwned(restFrame, paymentCode: paymentCode);
    }
    for (final n in _notes) {
      if (n['spent'] == true) continue;
      final addr = (n['address'] ?? n['dest'])?.toString() ?? '';
      if (addr.isEmpty || _isProgramVaultDest(addr)) continue;
      if (isDestAddress(addr)) {
        if (!isBindable(addr, restFrame: restFrame, paymentCode: paymentCode))
          continue;
        rememberDest(addr);
        if (n['verified'] == true) _proofCheckedDests.add(payKey(addr));
        continue;
      }
      n['address'] = bound;
      n['dest'] = bound;
      rememberDest(bound);
      if (n['verified'] == true) _proofCheckedDests.add(payKey(bound));
    }
    for (final d in moneyDests(restFrame, paymentCode: paymentCode)) {
      final key = payKey(d);
      final cap = _verifiedConfirmedShe(key);
      if (cap == null) continue;
      _spendable[key] = cap;
    }
    return spendableOwned(restFrame, paymentCode: paymentCode);
  }

  /// Verified confirmed coins only. An external balance with no opened value
  /// proof is not a coin. Once a proof has opened, Spendable is that confirmed
  /// sum: a 0 book does not hide it, and a larger pool figure does not raise it.
  ///
  /// The stored map is that same sum. Settled history is not a second coin a
  /// send can use, so it does not raise the map or the figure on screen.
  double usableSpendable(String address) => _shownSpendable(address);

  /// Confirmed Reserve principal is not Continuum spendable. A pending lock
  /// debit and that principal are the same hold, so the larger one applies.
  void setReserveHeldNanos(String dest, int nanos) {
    setReserveHeldUnits(dest, BigInt.from(nanos));
  }

  /// Exact portal principal. Any size, including a count a double cannot name.
  /// Public stats `lockedNanos` is the reserve total, not this wallet, so it
  /// does not call this. A blank fork clears the hold instead.
  void setReserveHeldUnits(String dest, BigInt nanos) {
    final pk = payKey(dest);
    if (!isDestAddress(pk)) return;
    if (nanos <= BigInt.zero) {
      _reserveHeldNanos.remove(pk);
      _reserveHeldShe[pk] = 0;
      return;
    }
    _reserveHeldNanos[pk] = nanos;
    final asDouble = nanos.toDouble();
    _reserveHeldShe[pk] = asDouble.isFinite
        ? asDouble / kUnitsPerShe
        : double.infinity;
  }

  /// Snapshot principal for the selector, before a live portal read.
  /// Replaces any previous principal for [dest]. It does not add.
  void bindSnapshotHold(String dest, int nanos) {
    if (blankFork) {
      _clearReserveHold();
      return;
    }
    setReserveHeldNanos(dest, nanos < 0 ? 0 : nanos);
  }

  void _clearReserveHold() {
    vaultLockedNanos = 0;
    _reserveHeldNanos.clear();
    _reserveHeldShe.clear();
  }

  void _installFollowReserveHold(Map<String, dynamic> spec) {
    if (spec.containsKey('reserveHeld')) {
      _reserveHeldNanos.clear();
      _reserveHeldShe.clear();
      final raw = spec['reserveHeld'];
      if (raw is Map) {
        for (final e in raw.entries) {
          final digits = e.value?.toString() ?? '';
          if (!RegExp(r'^\d+$').hasMatch(digits)) continue;
          final big = BigInt.tryParse(digits);
          if (big == null) continue;
          setReserveHeldUnits(e.key.toString(), big);
        }
      }
    }
    if (blankFork) _clearReserveHold();
  }

  double _grossShown(String key) {
    return _sheOfNanos(_spendableNanosOn(payKey(key)));
  }

  /// One reserve principal for the whole wallet. The vault dest is not where the
  /// fee notes sit, so the hold is not stored under that dest's spendable.
  double _reserveHoldShe() {
    var n = 0.0;
    for (final v in _reserveHeldShe.values) {
      if (v > n) n = v;
    }
    return n;
  }

  /// Lock principal on [key]. It is never the unlocked, sendable amount.
  double _timeLockShe(String key, {required bool unlocked}) {
    var n = 0.0;
    for (final note in _notes) {
      if ((note['kind'] ?? '').toString() != 'lock') continue;
      if (note['spent'] == true) continue;
      if (!_noteOnDest(note, key)) continue;
      if (!_noteMature(note)) continue;
      final open = !lockNoteIsLocked(
        Map<String, dynamic>.from(note),
        tipTimestampMs,
      );
      if (open != unlocked) continue;
      final she = _noteSheOf(note, 0);
      if (she > 0) n += she;
    }
    return n;
  }

  Map<String, double> _spendableAfterHold() {
    refreshTimeLockedNotes();
    final keys = <String>{
      ..._spendable.keys,
      ..._lockDebitShe.keys,
      ..._proofCheckedDests,
    };
    final gross = <String, double>{};
    for (final k in keys) {
      if (!isDestAddress(k) || _isProgramVaultDest(k)) continue;
      gross[k] = _grossShown(k);
    }
    // A lock tranche is never spendable. The hold stays on the coins that
    // funded it, and withdraw is the only way the principal leaves.
    final openedLock = <String, double>{};
    for (final k in gross.keys.toList()) {
      final heldNote = _timeLockShe(k, unlocked: false);
      final openNote = _timeLockShe(k, unlocked: true);
      final cut = heldNote + openNote;
      if (cut > 1e-12) {
        final left = (gross[k] ?? 0) - cut;
        gross[k] = left <= 1e-12 ? 0 : left;
      }
      if (openNote > 1e-12) openedLock[k] = openNote;
    }
    var pendingSum = 0.0;
    final pending = <String, double>{};
    for (final k in gross.keys) {
      final d = _lockDebitShe[k] ?? 0;
      if (d > 0) {
        pending[k] = d;
        pendingSum += d;
      }
    }
    final extra = _reserveHoldShe() > pendingSum
        ? _reserveHoldShe() - pendingSum
        : 0.0;
    final left = <String, double>{};
    for (final e in gross.entries) {
      final remain = e.value - (pending[e.key] ?? 0);
      left[e.key] = remain <= 1e-12 ? 0 : remain;
    }
    var owe = extra;
    if (owe > 1e-12) {
      final order = left.keys.toList()
        ..sort((a, b) {
          final cmp = (left[b] ?? 0).compareTo(left[a] ?? 0);
          if (cmp != 0) return cmp;
          return a.compareTo(b);
        });
      for (final k in order) {
        if (owe <= 1e-12) break;
        final have = left[k] ?? 0;
        if (have <= 1e-12) continue;
        final take = have < owe ? have : owe;
        final remain = have - take;
        left[k] = remain <= 1e-12 ? 0 : remain;
        owe -= take;
      }
    }
    for (final e in openedLock.entries) {
      left[e.key] = (left[e.key] ?? 0) + e.value;
    }
    return left;
  }

  double _shownSpendable(String key) {
    final pk = payKey(key);
    final frame = _restFrame ?? '';
    if (frame.isEmpty) return _sheOfNanos(_spendableNanosOn(pk));
    refreshTimeLockedNotes();
    final pool = poolSpendableNotes(_spendPlanInput(frame, null, 0));
    var n = BigInt.zero;
    for (final row in pool.free) {
      final addr = row['addr']?.toString() ?? '';
      if (addr == key || addr == pk || payKey(addr) == pk) {
        n += row['nanos'] as BigInt;
      }
    }
    return _sheOfNanos(n);
  }

  /// Notes minus a vault lock. The pending debit and the confirmed principal
  /// are one hold: a fresh lock and the portal sync must not subtract twice.
  double spendableAfterVaultHold({
    required double notesShe,
    required double pendingDebitShe,
    required double vaultShe,
  }) {
    final cut = pendingDebitShe > vaultShe ? pendingDebitShe : vaultShe;
    final left = notesShe - (cut > 0 ? cut : 0);
    return left <= 1e-12 ? 0 : left;
  }

  void _noteLockDebit(String src, double needShe, {BigInt? nanos}) {
    if (needShe <= 1e-12 && (nanos == null || nanos <= BigInt.zero)) return;
    final pk = payKey(src);
    if (needShe > 1e-12) _lockDebitShe[pk] = (_lockDebitShe[pk] ?? 0) + needShe;
    if (nanos != null && nanos > BigInt.zero) {
      _lockDebitNanos[pk] = (_lockDebitNanos[pk] ?? BigInt.zero) + nanos;
    }
  }

  /// Null when this dest has not presented a complete value proof.
  /// The sum is [spendableNote]: the same notes the planner can select.
  double? _verifiedConfirmedShe(String dest) {
    final key = payKey(dest);
    if (!_proofCheckedDests.contains(key)) return null;
    final nanos = _spendableNanosOn(key);
    return _sheOfNanos(nanos);
  }

  /// Exact nanos on [dest] a max send can draw. Same gate as the planner.
  BigInt _spendableNanosOn(String dest) {
    var total = BigInt.zero;
    for (final n in _notes) {
      if (!_noteOnDest(n, dest)) continue;
      if (isVaultLockNote(n)) continue;
      if (!_noteIsSpendable(n)) continue;
      final nanos = noteNanosExact(n);
      if (nanos == null) continue;
      total += nanos;
    }
    return total;
  }

  bool _noteIsSpendable(Map<String, dynamic> n, {bool ignoreConfs = false}) {
    return spendableNote(
      n,
      tip: bookTip,
      confirmations: spendableConfirmations,
      tipMs: tipTimestampMs,
      spentTags: _spentTagHex,
      spendTag: _spendTagFor(n),
      ignoreConfs: ignoreConfs,
    );
  }

  String? _spendTagFor(Map<String, dynamic> n) {
    final stamped = n['spendTag']?.toString();
    if (stamped == null || stamped.isEmpty) return null;
    return stamped;
  }

  /// Nanos the Spendable figure is naming for [restFrame].
  /// Same exact hold and the same note rows as a max send.
  BigInt displayedSpendableNanos(String restFrame, {String? paymentCode}) {
    refreshTimeLockedNotes();
    final pool = poolSpendableNotes(_spendPlanInput(restFrame, paymentCode, 0));
    return pool.freeSum;
  }

  /// Nanos [selectSpendNotesWire] would treat as free for a max send.
  BigInt plannerSelectableNanos(String restFrame, {String? paymentCode}) {
    refreshTimeLockedNotes();
    final raw = selectSpendNotesWire(
      _spendPlanInput(restFrame, paymentCode, 0),
    );
    return BigInt.parse(raw['spendableNanos']?.toString() ?? '0');
  }

  Set<String> _spendDests(String restFrame, {String? paymentCode}) {
    final dests = <String>{};
    for (final d in moneyDests(restFrame, paymentCode: paymentCode)) {
      if (!isDestAddress(d)) continue;
      dests.add(d);
      dests.add(payKey(d));
    }
    for (final n in _notes) {
      final addr = (n['address'] ?? n['dest'])?.toString() ?? '';
      if (addr.isEmpty) continue;
      if (isBindable(addr, restFrame: restFrame, paymentCode: paymentCode))
        dests.add(addr);
    }
    if (restFrame.isNotEmpty &&
        !isDestAddress(restFrame) &&
        payKey(restFrame) == restFrame) {
      dests.add(restFrame);
    }
    return dests;
  }

  double _noteSheOf(Map<String, dynamic> note, double fallback) {
    final amt = note['amount'];
    if (amt is num && amt > 0) return amt.toDouble();
    final nanos = note['nanos'];
    if (nanos is num && nanos > 0) return nanos.toDouble() / kUnitsPerShe;
    final opened = _proofOpenedShe(note);
    if (opened > 0) return opened;
    return fallback;
  }

  bool _openedNoteAt(String key, int height) {
    if (height < 1) return false;
    for (final n in _notes) {
      if (n['spent'] == true || n['verified'] != true) continue;
      if (!_noteOnDest(n, key)) continue;
      if ((n['height'] as num?)?.toInt() == height) return true;
    }
    return false;
  }

  bool _noteOnDest(Map<String, dynamic> note, String dest) {
    final addr = (note['address'] ?? note['dest'])?.toString() ?? '';
    if (addr.isEmpty) return false;
    return addr == dest || payKey(addr) == payKey(dest);
  }

  /// Confirmed enough to spend. A note with no height is not mature: the
  /// planner counts what Spendable counts (spendableNote needs a height).
  /// Same floor as the Flow picker, counted from [bookTip].
  bool _noteMature(Map<String, dynamic> note, {bool ignoreConfs = false}) {
    final h = (note['height'] as num?)?.toInt();
    if (h == null || h < 1) return false;
    if (ignoreConfs) return true;
    return confirmationsOf(h) >= spendableConfirmations;
  }

  /// One sealed note on [dest] can cover [needShe]. Several smaller notes are
  /// not combined. An amount-less note falls back to the spendable book.
  bool _structuralCover(String dest, double needShe) {
    var largest = 0.0;
    var bare = false;
    for (final n in _notes) {
      if (n['spent'] == true) continue;
      if (!_noteOnDest(n, dest)) continue;
      if (_noteBytes(n['commit']) == null || _noteBytes(n['r']) == null)
        continue;
      if (!_noteMature(n)) continue;
      final amt = n['amount'];
      if (amt is num) {
        if (amt.toDouble() > largest) largest = amt.toDouble();
      } else if (spendable(dest) + 1e-18 >= needShe) {
        bare = true;
      }
    }
    return largest + 1e-18 >= needShe || bare;
  }

  /// Money dest that holds one sealed note covering [needShe], or null.
  String? destCoveringSpend(
    String restFrame, {
    String? paymentCode,
    required double needShe,
  }) {
    for (final d in syncDests(restFrame, paymentCode: paymentCode)) {
      if (_structuralCover(d, needShe)) return d;
    }
    return null;
  }

  /// Largest unspent sealed note on [dest], or the sum when [sum] is set.
  double inventoriedNoteShe(String dest, {bool sum = false}) {
    var total = 0.0;
    var largest = 0.0;
    for (final n in _notes) {
      if (n['spent'] == true) continue;
      if (!_noteOnDest(n, dest)) continue;
      if (_noteBytes(n['commit']) == null || _noteBytes(n['r']) == null)
        continue;
      final she = _noteSheOf(n, 0);
      if (she <= 0) continue;
      total += she;
      if (she > largest) largest = she;
    }
    return sum ? total : largest;
  }

  bool _ownsSealedOn(String dest) {
    for (final n in _notes) {
      if (n['spent'] == true) continue;
      if (!_noteOnDest(n, dest)) continue;
      if (_noteBytes(n['commit']) == null || _noteBytes(n['r']) == null)
        continue;
      return true;
    }
    return false;
  }

  /// Spendable SHE with no local sealed note. The thin poll must full-sync
  /// until a note lands or two pulls miss, so Pay is not the first collate.
  bool get notesLagSpendable {
    for (final e in _spendable.entries) {
      if (e.value <= 1e-12) continue;
      if (_isProgramVaultDest(e.key)) continue;
      if (_ownsSealedOn(e.key)) continue;
      if ((_noteMisses[e.key] ?? 0) >= 2) continue;
      return true;
    }
    return false;
  }

  void _bindSpendableToNotes(Iterable<String> dests) {
    for (final d in dests) {
      if (!isDestAddress(d)) continue;
      final key = payKey(d);
      _spendable[key] = inventoriedNoteShe(key, sum: true);
    }
  }

  final List<String> _noteSnap = [];
  final List<String> _removedThisFollow = [];
  int _followFlight = 0;
  final Set<String> _uiCommitsAtFollow = <String>{};

  String _commitHexOf(Map<dynamic, dynamic> n) {
    final c = _noteBytes(n['commit']);
    if (c == null || c.isEmpty) return '';
    return _bytesHex(c);
  }

  void _armFollowFlight() {
    if (_followFlight == 0) {
      _uiCommitsAtFollow.clear();
      for (final n in _notes) {
        final hex = _commitHexOf(n);
        if (hex.isNotEmpty) _uiCommitsAtFollow.add(hex);
      }
    }
    _followFlight++;
  }

  void _disarmFollowFlight() {
    if (_followFlight > 0) _followFlight--;
    if (_followFlight == 0) _uiCommitsAtFollow.clear();
  }

  bool _bornDuringFollow(Map<dynamic, dynamic> n) {
    if (_followFlight < 1) return false;
    final hex = _commitHexOf(n);
    return hex.isNotEmpty && !_uiCommitsAtFollow.contains(hex);
  }

  void _beginNoteFollow() {
    _noteSnap
      ..clear()
      ..addAll([
        for (final n in _notes)
          if (_noteBytes(n['commit']) case final Uint8List c)
            if (c.isNotEmpty) _bytesHex(c),
      ]);
    _removedThisFollow.clear();
  }

  /// Commits removed during this follow (reorg). Adopt must not put them back.
  void _finishNoteFollow() {
    final now = <String>{
      for (final n in _notes)
        if (_noteBytes(n['commit']) case final Uint8List c)
          if (c.isNotEmpty) _bytesHex(c),
    };
    _removedThisFollow
      ..clear()
      ..addAll(_noteSnap.where((c) => !now.contains(c)));
  }

  /// Login's first read. One `/stats` sets the confirmation height, then this
  /// wallet's notes open and are emitted as soon as a proof verifies. `/balance`
  /// runs after that paint. The balance number is not a coin. A pool balance,
  /// an owed-toward-π figure, and a `{v}`-only row do not enter the sum.
  /// A notes read that does not return a list is not a verified zero.
  Future<double> populateSpendableFromNode(
    String restFrame, {
    String? paymentCode,
    SendPort? partials,
  }) async {
    keepOwnedDests(restFrame, paymentCode: paymentCode);
    _beginNoteFollow();
    var sawNotes = false;
    var hostHeight = 0;
    if (pool != null && !isPoolLedgerHost(pool!.baseUrl)) {
      // One stats read. A header whose ShearHash meets its bits sets the
      // spendable tip. A host height with no checked header does not.
      try {
        final json = await pool!.stats().timeout(const Duration(seconds: 2));
        final h = (json['height'] as num?)?.toInt() ?? 0;
        hostHeight = h;
        if (h > 0) {
          final tipHex = json['header']?.toString() ?? '';
          await catchUpVerifiedChain(h);
          await _prepareTipHash(tipHex, h);
          applyTipHex(tipHex, sealedHeight: h);
        }
        _applyReorgList(json['orphans'] ?? json['reorgHeights']);
      } catch (_) {}
      try {
        // The shell is already up. This open is off the UI isolate. A short
        // timeout discarded a pool-fee book that was still proving.
        // Stamp the host height, not a header tip that already ran ahead.
        sawNotes = await collateSpendNotes(
          restFrame: restFrame,
          paymentCode: paymentCode,
          partials: partials,
          hostHeight: hostHeight,
        );
      } catch (e) {
        _collateError = 'populate:$e';
      }
      try {
        await _readNodeBalance(
          restFrame,
          paymentCode: paymentCode,
        ).timeout(const Duration(seconds: 2));
      } catch (_) {}
    }
    await _applyFollowSpentTags();
    _finishNoteFollow();
    _spendableReadFailed = !sawNotes;
    if (sawNotes) _openCollated = true;
    return recheckRestFrameSpendable(restFrame, paymentCode: paymentCode);
  }

  /// Host `orphans` / `reorgHeights` is a hint to re-fetch those headers.
  /// It does not move depth and it does not write the header file. Notes
  /// and the scan cursor stay.
  void noteHostReorg(Object? raw) => _applyReorgList(raw);

  void _applyReorgList(Object? raw) {
    if (raw is! List || raw.isEmpty || _pin == null) return;
    final pinH = _pin!.height;
    var from = _chainTip;
    var hit = false;
    for (final item in raw) {
      final h = item is num ? item.toInt() : int.tryParse('$item') ?? 0;
      if (h <= pinH || h > _chainTip) continue;
      hit = true;
      if (h < from) from = h;
    }
    if (!hit) return;
    _reorgHintFrom = from;
  }

  void _takeSpendTags(Map<String, dynamic> live) {
    _spentTagHex.clear();
    final tags = live['spendTags'];
    if (tags is! List) return;
    for (final t in tags) {
      if (t is String && t.isNotEmpty) {
        _spentTagHex.add(t.toLowerCase());
      } else {
        final b = _noteBytes(t);
        if (b != null && b.isNotEmpty) _spentTagHex.add(_bytesHex(b));
      }
    }
  }

  void _markNotesSpentByTag() {
    for (final n in _notes) {
      final tag = n['spendTag']?.toString() ?? '';
      if (tag.isEmpty) continue;
      if (_spentTagHex.contains(tag.toLowerCase())) n['spent'] = true;
    }
  }

  Future<void> _applyFollowSpentTags() async {
    final client = pool;
    if (client == null || isPoolLedgerHost(client.baseUrl)) return;
    try {
      final live = await client.fluxset().timeout(const Duration(seconds: 2));
      _takeSpendTags(live);
      await _stampSpendTagsOffUi();
      _markNotesSpentByTag();
    } catch (_) {}
  }

  /// GET `/api/wallet/balance` for this wallet's dests. The returned SHE is
  /// not stored. Spendable stays the opened notes. The fee-dest constant is
  /// not queried unless it is one of those dests.
  Future<void> _readNodeBalance(String restFrame, {String? paymentCode}) async {
    final client = pool;
    if (client == null || isPoolLedgerHost(client.baseUrl)) return;
    for (final d in syncDests(restFrame, paymentCode: paymentCode)) {
      if (!isDestAddress(d)) continue;
      try {
        final json = await client.balance(d, open: destProofOpen(d));
        final raw = json['balance'];
        if (json['ok'] == false && raw is! num) continue;
      } catch (_) {}
    }
  }

  void _takeListedCommits(List rows) {
    for (final row in rows) {
      if (row is! Map) continue;
      final c = _noteBytes(row['commit']);
      if (c != null && c.isNotEmpty) _listedCommits.add(_bytesHex(c));
    }
  }

  void _emitCoins(SendPort? partials, Map<String, dynamic> scanned) {
    if (partials == null) return;
    final notes = scanned['notes'];
    if (notes is! List || notes.isEmpty) return;
    final opened = <Map<String, dynamic>>[
      for (final n in notes)
        if (n is Map && n['verified'] == true) Map<String, dynamic>.from(n),
    ];
    if (opened.isEmpty) return;
    partials.send(<String, dynamic>{
      'event': 'coins',
      'notes': _followEncode(opened),
      'sealed': _sealedHeight,
    });
  }

  /// Cache hits paint first. Each miss opens on this isolate, then the coin
  /// event is sent before the next proof. The credit worker is already off
  /// the UI isolate. A nested [Isolate.run] from that worker never finished
  /// on the phone, so the fee book stayed on the first handful of coins.
  Future<void> _scanNotesProgressive(
    Map<String, dynamic> raw, {
    SendPort? partials,
  }) async {
    final known = <String>{..._acceptedCommits};
    final heightless = <String>{};
    for (final n in _notes) {
      if (n['verified'] != true) continue;
      final commit = _noteBytes(n['commit']);
      if (commit == null || commit.isEmpty) continue;
      known.add(_bytesHex(commit));
      final h = n['height'];
      if (h is! num || h < 1) heightless.add(_bytesHex(commit));
    }
    // A held note with no block height yet (this wallet's own change, posted
    // but not read back mined) is read again: its mined copy is the only one
    // that carries the height Spendable needs (gate 3), and rememberNote
    // merges that height onto the note.
    known.removeAll(heightless);
    final vouts = notesNotYetAccepted(
      List<dynamic>.from(raw['vouts'] as List? ?? const []),
      known,
    );
    debugNotesOpenedThisScan = vouts.length;
    if (vouts.isEmpty) return;
    final cache = proofCacheMap(raw['openedProofs']);
    final hits = <dynamic>[];
    final misses = <dynamic>[];
    for (final row in vouts) {
      if (row is! Map) {
        misses.add(row);
        continue;
      }
      final k = proofCacheKey(Map<String, dynamic>.from(row));
      if (k != null && cache.containsKey(k)) {
        hits.add(row);
      } else {
        misses.add(row);
      }
    }
    Future<void> applySlice(
      List<dynamic> slice, {
      required bool useCache,
    }) async {
      if (slice.isEmpty) return;
      final scanned = scanSealedWire(<String, dynamic>{
        ...raw,
        'vouts': slice,
        if (!useCache) 'openedProofs': const <Map<String, dynamic>>[],
      });
      _applySealedScan(scanned);
      _emitCoins(partials, scanned);
    }

    await applySlice(hits, useCache: true);
    for (final one in misses) {
      await applySlice(<dynamic>[one], useCache: false);
      await Future<void>.delayed(Duration.zero);
    }
  }

  /// Pull sealed notes for the spend dests. Balance snapshots can show SHE
  /// before the note book is filled. Returns true when the pool answered,
  /// including an empty list. A network miss returns false and leaves the book.
  ///
  /// One Flow spend consumes one note. A user send of the sum is sendSpendableSum.
  Future<bool> collateSpendNotes({
    String? dest,
    String? restFrame,
    String? paymentCode,
    bool bindSpendable = false,
    SendPort? partials,
    int hostHeight = 0,
  }) async {
    if (pool == null || isPoolLedgerHost(pool!.baseUrl)) return false;
    final seed = spendSeed;
    if (seed == null || seed.length != 32) return false;
    final dests = <String>{};
    if (dest != null && dest.isNotEmpty) {
      final key = payKey(dest);
      if (isDestAddress(key)) dests.add(key);
    }
    if (restFrame != null) {
      for (final d in syncDests(restFrame, paymentCode: paymentCode)) {
        if (isDestAddress(d)) dests.add(payKey(d));
      }
    }
    if (dests.isEmpty) return false;
    _listedCommits.clear();
    _unopenedListedProofs = 0;
    _scannedNotesThisFollow = false;
    var saw = false;
    var failed = false;
    var lackedOpen = 0;
    for (final key in dests) {
      final open = destProofOpen(key);
      // One dest this wallet cannot prove must not blank a dest it can.
      if (open == null || open.isEmpty) {
        lackedOpen++;
        continue;
      }
      try {
        final json = await pool!.notes(key, open: open);
        final rows = json['notes'];
        if (rows is! List) {
          failed = true;
          continue;
        }
        saw = true;
        _scannedNotesThisFollow = true;
        _takeListedCommits(rows);
        if (rows.isEmpty) continue;
        final raw = _sealedScanInput(rows, spendSeed: seed, dest: key);
        await _scanNotesProgressive(raw, partials: partials);
        final mark = notesHostStamp(
          sealed: _sealedHeight,
          hostHeight: hostHeight,
        );
        if (mark > 0 && _stampIngest(key, count: false)) {
          _notesAt[key] = mark;
          noteCovered(mark);
        }
      } catch (e) {
        failed = true;
        _collateError = 'collate:$e';
      }
    }
    if (failed || !saw) _listedCommits.clear();
    if (!saw && lackedOpen == dests.length) return false;
    if (bindSpendable && saw && !failed) _bindSpendableToNotes(dests);
    return saw && !failed;
  }

  Map<String, dynamic>? _pickSpendNote(
    String dest,
    double needShe,
    Uint8List spendSeed, {
    bool ignoreConfs = false,
    double amountFallback = 0,
  }) {
    Map<String, dynamic>? best;
    var bestShe = -1.0;
    for (final n in _notes) {
      if (!_noteOnDest(n, dest)) continue;
      final tag = (n['spendTag'] ?? '').toString().toLowerCase();
      if (tag.isNotEmpty && _spentTagHex.contains(tag)) n['spent'] = true;
      if (!_noteIsSpendable(n, ignoreConfs: ignoreConfs)) continue;
      final noteShe = _storedNoteShe(n) ?? _noteSheOf(n, amountFallback);
      if (noteShe + 1e-18 < needShe) continue;
      if (best == null || noteShe > bestShe) {
        best = n;
        bestShe = noteShe;
      }
    }
    return best;
  }

  /// Dest that actually holds reconstructed credits for a spend.
  /// Only dests [isBindable] accepts for the signing key. destAtIndex is not a money path.
  String spendFrom(
    String restFrame, {
    String? paymentCode,
    required double amount,
    bool requireCover = false,
  }) {
    final plan = planLockFunding(
      this,
      restFrame: restFrame,
      paymentCode: paymentCode,
      needShe: amount,
    );
    if (plan.from != null) return plan.from!;
    if (requireCover) return '';
    final dests = moneyDests(restFrame, paymentCode: paymentCode).toList();
    return dests.isNotEmpty
        ? dests.first
        : currentDest(restFrame, paymentCode: paymentCode);
  }

  String _hopOffMiningMailbox(
    String home,
    String restFrame, {
    String? paymentCode,
  }) {
    final fresh = newDest(restFrame, paymentCode: paymentCode);
    final amt = _spendable.remove(home) ?? 0;
    if (amt > 0) _spendable[fresh] = (_spendable[fresh] ?? 0) + amt;
    return fresh;
  }

  /// Copy of chain spendable and the owed already folded into it.
  PaintedBookMark markPaintedBook() =>
      PaintedBookMark(Map<String, double>.from(_spendable), _owedSpent);

  void restorePaintedBook(PaintedBookMark mark) {
    _spendable
      ..clear()
      ..addAll(mark.spendable);
    _owedSpent = mark.owedSpent;
    _paintedFundDest = '';
    _paintedFundOwedNanos = 0;
  }

  /// Dest the last painted fold posted from. Empty after a restore.
  String get paintedFundDest => _paintedFundDest;

  /// Undebited pull-book owed, in nanos. queueTx subtracts queued spends once,
  /// so this stays the full figure rather than the remainder after earlier folds.
  int get paintedFundOwedNanos => _paintedFundOwedNanos;

  void _moveSpendableOnto(String dest) {
    if (!isDestAddress(dest)) return;
    var moved = 0.0;
    for (final key in _spendable.keys.toList()) {
      if (key == dest) continue;
      final amt = _spendable.remove(key) ?? 0;
      if (amt > 0) moved += amt;
    }
    if (moved > 0) _spendable[dest] = (_spendable[dest] ?? 0) + moved;
    _dests.add(dest);
  }

  /// Verified confirmed coins only. Owed-toward-π stays at the pool until a
  /// real payment arrives. Returns 0 when those coins already cover [needShe],
  /// or null when they do not.
  double? fundFromPaintedContinuum(
    String restFrame, {
    String? paymentCode,
    required double needShe,
  }) {
    _paintedFundDest = '';
    _paintedFundOwedNanos = 0;
    if (needShe <= 1e-12) return 0;
    var chain = spendableOwned(restFrame, paymentCode: paymentCode);
    if (chain < 0) chain = 0;
    if (chain + 1e-9 >= needShe) return 0;
    return null;
  }

  /// Fold fragmented Continuum dests into one covering dest. Does not invent SHE.
  /// A Flow or vote cover that is the mining mailbox moves to a fresh spend dest.
  /// A Reserve lock stays on the dest that holds the coins, including that mailbox,
  /// so the node debits the same notes Continuum already shows as spendable.
  String consolidateSpendableForLock(
    String restFrame, {
    String? paymentCode,
    required double needShe,
    bool keepHome = false,
  }) {
    final plan = planLockFunding(
      this,
      restFrame: restFrame,
      paymentCode: paymentCode,
      needShe: needShe,
    );
    final home = homeDest(restFrame, paymentCode: paymentCode);
    if (plan.from != null && plan.from != home) return plan.from!;
    final miss = lockFundingShortfall(plan);
    if (miss.isNotEmpty) throw StateError(miss);
    if (plan.from == home) {
      if (keepHome) return home;
      if (_paintedFundDest == home && spendable(home) + 1e-9 >= needShe)
        return home;
      return _hopOffMiningMailbox(home, restFrame, paymentCode: paymentCode);
    }
    var target = plan.sources.first;
    for (final d in plan.sources) {
      if (spendable(d) > spendable(target)) target = d;
    }
    for (final d in plan.sources) {
      if (d == target) continue;
      final amt = _spendable.remove(d) ?? 0;
      if (amt <= 0) continue;
      _spendable[target] = (_spendable[target] ?? 0) + amt;
    }
    if (target == home) {
      if (keepHome) return home;
      if (_paintedFundDest == home && spendable(home) + 1e-9 >= needShe)
        return home;
      return _hopOffMiningMailbox(home, restFrame, paymentCode: paymentCode);
    }
    return target;
  }

  /// Light dests for a pool pull. Bindable money dests only.
  /// she1 / shear1 / destAtIndex are never queried as pay dests.
  Set<String> syncDests(String restFrame, {String? paymentCode}) {
    final keys = moneyDests(restFrame, paymentCode: paymentCode);
    if (isDestAddress(restFrame) &&
        isBindable(restFrame, restFrame: restFrame, paymentCode: paymentCode)) {
      keys.add(restFrame);
    }
    return keys;
  }

  /// Pool snapshot → ledger (unlock / Continuum path).
  ///
  /// Reconstructed [balance] is already-confirmed spendable at the tip, including
  /// first boot when local sealed height was 0. Open-round [pending] + [incoming]
  /// stay pending until sealed height advances by one from a known height.
  void _takeOwed(Map<String, dynamic> json, String address) {
    final owed = json['owedPi'] ?? json['confirmingPot'];
    if (owed is num && owed >= 0) _owedPiDisplay = owed.toDouble();
    if (owed is num &&
        owed > 0 &&
        isDestAddress(address) &&
        !_isProgramVaultDest(address)) {
      _owedPiDest = address;
    }
  }

  /// One pull-book figure for the whole sweep. A later dest that reports 0
  /// must not wipe the mailbox's positive owed-π.
  void _finishOwedSweep(double owedMax, {required bool saw, String dest = ''}) {
    if (saw) _owedPiDisplay = owedMax;
    if (saw &&
        owedMax > 0 &&
        isDestAddress(dest) &&
        !_isProgramVaultDest(dest)) {
      _owedPiDest = dest;
    }
  }

  void applyPoolSnapshot(
    String address,
    Map<String, dynamic> json, {
    required int beforeHeight,
    required int tipSealed,
    bool writeOwed = true,
  }) {
    _ingestIncoming(json);
    if (writeOwed) _takeOwed(json, address);
    if (!isDestAddress(address)) return;
    _applyPoolHashPending(address, (json['pending'] as num?)?.toDouble() ?? 0);
    if (tipSealed > beforeHeight) {
      creditNodeLandsInGap(
        before: beforeHeight,
        tip: tipSealed,
        extraDest: address,
      );
      if (beforeHeight > 0 && tipSealed == beforeHeight + 1) {
        confirmRound(address: address, pot: 0, height: beforeHeight + 1);
      }
      if (beforeHeight > 0) settleTo(bookTip);
    }
    if (_isProgramVaultDest(address)) {
      _dropProgramVaults();
      return;
    }
    final live = (json['balance'] as num?)?.toDouble();
    if (live != null && live >= 0) {
      final key = address;
      if (_isProgramVaultDest(key)) {
        _dropProgramVaults();
        return;
      }
      if (live > 0) rememberDest(key);
      final pk = payKey(key);
      final settled = _settledNodeShe[pk] ?? 0;
      if (_verifiedConfirmedShe(pk) != null) {
        _unverifiedExternal.remove(pk);
        _externalShe.remove(pk);
      } else if (settled > 1e-12) {
        // A node balance number is not the coin. Leave the matured land.
        _externalShe.remove(pk);
        _unverifiedExternal.remove(pk);
      } else {
        _spendable[key] = live;
        _unverifiedExternal.add(pk);
        _externalShe[pk] = live;
      }
    }
  }

  /// One retry when the pool balance route answers HTTP 504. A second 504 throws.
  Future<Map<String, dynamic>> _balanceWithOne504Retry(String address) async {
    try {
      return await pool!.balance(address, open: destProofOpen(address));
    } catch (e) {
      if (!poolHttp504(e)) rethrow;
      return await pool!.balance(address, open: destProofOpen(address));
    }
  }

  /// Balance sweep. Owed-π is the max pull-book figure across dests, applied
  /// after the loop so a change dest's 0 does not clear the mailbox.
  Future<({double max, bool saw, String dest})> _balancesFor(
    Iterable<String> dests, {
    required int before,
  }) async {
    var maxOwed = 0.0;
    var saw = false;
    var maxDest = '';
    for (final d in dests) {
      if (!isDestAddress(d)) continue;
      try {
        final json = await _balanceWithOne504Retry(d);
        final owed = json['owedPi'] ?? json['confirmingPot'];
        if (owed is num && owed >= 0) {
          saw = true;
          if (owed > maxOwed) {
            maxOwed = owed.toDouble();
            maxDest = d;
          }
        }
        applyPoolSnapshot(
          d,
          json,
          beforeHeight: before,
          tipSealed: _sealedHeight,
          writeOwed: false,
        );
      } catch (e) {
        if (poolHttp504(e)) rethrow;
      }
    }
    return (max: maxOwed, saw: saw, dest: maxDest);
  }

  Map<String, dynamic> exportCreditFollow({
    required String restFrame,
    String? paymentCode,
    required bool full,
  }) {
    return <String, dynamic>{
      'full': full,
      'restFrame': restFrame,
      'paymentCode': paymentCode ?? '',
      'baseUrl': creditFollowReadBase(pool),
      'address': _restFrame ?? restFrame,
      'seedHex': spendSeed == null ? '' : _bytesHex(spendSeed!),
      'viewKey': viewSecret ?? '',
      'dests': _dests.toList(),
      'txs': <Object?>[for (final t in _txs) _followEncode(t.toJson())],
      'notes': <Object?>[for (final n in _notes) _followEncode(n)],
      'spendable': _followEncode(_spendable),
      'pending': _followEncode(_pending),
      'advisory': _followEncode(_advisorySpendable),
      'externalShe': _followEncode(_externalShe),
      'lockDebit': _followEncode(_lockDebitShe),
      'reserveHeld': <String, String>{
        for (final e in _reserveHeldNanos.entries) e.key: e.value.toString(),
      },
      'settledNodeShe': _followEncode(_settledNodeShe),
      'proofChecked': _proofCheckedDests.toList(),
      'unverifiedExternal': _unverifiedExternal.toList(),
      'sealed': _sealedHeight,
      'verifiedTip': _verifiedTip,
      'settled': _settledHeight,
      'notesAt': _followEncode(_notesAt),
      'notesCovered': _notesCovered,
      if (networkHashrate != null) 'networkHashrate': networkHashrate,
      if (circulatingNanos != null) 'circulatingNanos': circulatingNanos,
      if (potEmittedNanos != null) 'potEmittedNanos': potEmittedNanos,
      if (hashBonusEmittedNanos != null)
        'hashBonusEmittedNanos': hashBonusEmittedNanos,
      if (emittedAtHeight != null) 'emittedAtHeight': emittedAtHeight,
      if (networkWorkBits != null) 'networkWorkBits': networkWorkBits,
      if (sealedMeanBlockMs != null) 'sealedMeanBlockMs': sealedMeanBlockMs,
      'historyAt': _followEncode(_historyAt),
      'openCollated': _openCollated,
      if (_spendableReadFailed != null)
        'spendableReadFailed': _spendableReadFailed,
      if (_scannedNotesThisFollow)
        'unopenedListedProofs': _unopenedListedProofs,
      if (_collateError.isNotEmpty) 'collateError': _collateError,
      'destCount': destCount,
      'destIndex': destIndex,
      'nodeBodies': <Object?>[for (final b in _nodeBodies) _followEncode(b)],
      'nodeHistory': <Object?>[
        for (final b in _nodeHistoryRows) _followEncode(b),
      ],
      'nodeNotes': <Object?>[for (final b in _nodeNoteRows) _followEncode(b)],
      'openedProofs': exportOpenedProofs(),
      if (_listedCommits.isNotEmpty)
        'listedCommits': List<String>.from(_listedCommits),
      if (_chainOutputCommitHex.isNotEmpty)
        'outputCommits': _chainOutputCommitHex.toList(),
      if (_removedThisFollow.isNotEmpty)
        'removedCommits': List<String>.from(_removedThisFollow),
    };
  }

  /// A later follow must not drop a pool-fee or receive that is still
  /// inside the 9-confirmation window. A block that only repeats the fee does.
  bool _keepImmatureFollowRow(ShearTx t) {
    if (t.kind == 'hash' || t.kind == 'sample') return false;
    if (isFeeBlockMirror(t, _txs)) return false;
    final h = t.height ?? 0;
    final liveKind =
        t.kind == 'pool-fee' ||
        t.kind == 'receive' ||
        t.kind == 'send' ||
        t.kind == 'pool-withdraw' ||
        isWalletBlockKind(t.kind);
    if (!liveKind) return false;
    if (h < 1) return !t.confirmed;
    return confirmationsOf(h) < spendableConfirmations;
  }

  void installCreditFollow(Map<String, dynamic> spec) {
    final seed = spec['seedHex']?.toString() ?? '';
    final address = spec['address']?.toString() ?? '';
    final view = spec['viewKey']?.toString() ?? '';
    final code = spec['paymentCode']?.toString() ?? '';
    if (seed.isNotEmpty &&
        address.isNotEmpty &&
        view.isNotEmpty &&
        code.isNotEmpty) {
      bindIdentity(
        ShearIdentity(
          seedHex: seed,
          address: address,
          viewKey: view,
          paymentCode: code,
        ),
      );
    }
    _dests
      ..clear()
      ..addAll(
        ((spec['dests'] as List?) ?? const <dynamic>[]).map(
          (e) => e.toString(),
        ),
      );
    if (spec.containsKey('txs')) {
      final incoming = <ShearTx>[
        for (final raw in (spec['txs'] as List?) ?? const <dynamic>[])
          if (_followRevive(raw) is Map)
            ShearTx.fromJson(
              Map<String, dynamic>.from(_followRevive(raw) as Map),
            ),
      ];
      final incomingIds = <String>{for (final t in incoming) t.id};
      final keep = <ShearTx>[
        for (final t in _txs)
          if (!incomingIds.contains(t.id) && _keepImmatureFollowRow(t)) t,
      ];
      _txs
        ..clear()
        ..addAll(incoming)
        ..addAll(keep);
    }
    if (spec.containsKey('notes')) {
      _notes
        ..clear()
        ..addAll(<Map<String, dynamic>>[
          for (final raw in (spec['notes'] as List?) ?? const <dynamic>[])
            if (_followRevive(raw) is Map)
              Map<String, dynamic>.from(_followRevive(raw) as Map),
        ]);
    }
    void takeDoubles(Map<String, double> dest, Object? raw) {
      dest
        ..clear()
        ..addAll(_followDoubles(_followRevive(raw)));
    }

    takeDoubles(_spendable, spec['spendable']);
    takeDoubles(_pending, spec['pending']);
    takeDoubles(_advisorySpendable, spec['advisory']);
    takeDoubles(_externalShe, spec['externalShe']);
    takeDoubles(_lockDebitShe, spec['lockDebit']);
    _installFollowReserveHold(spec);
    takeDoubles(_settledNodeShe, spec['settledNodeShe']);
    _proofCheckedDests
      ..clear()
      ..addAll(
        ((spec['proofChecked'] as List?) ?? const <dynamic>[]).map(
          (e) => e.toString(),
        ),
      );
    _unverifiedExternal
      ..clear()
      ..addAll(
        ((spec['unverifiedExternal'] as List?) ?? const <dynamic>[]).map(
          (e) => e.toString(),
        ),
      );
    // A follow that did not see the live tip must not rewind it. Rewinding
    // makes opened coins look short of the confirmation floor, so Spendable
    // stays 0 after every verify.
    final incomingSealed = (spec['sealed'] as num?)?.toInt();
    if (incomingSealed != null && incomingSealed > _sealedHeight) {
      _sealedHeight = incomingSealed;
    }
    final incomingTip = (spec['verifiedTip'] as num?)?.toInt() ?? 0;
    if (incomingTip > _verifiedTip) _verifiedTip = incomingTip;
    _settledHeight = (spec['settled'] as num?)?.toInt() ?? _settledHeight;
    _notesAt
      ..clear()
      ..addAll(_followInts(spec['notesAt']));
    final covered = (spec['notesCovered'] as num?)?.toInt() ?? 0;
    if (covered > _notesCovered) _notesCovered = covered;
    _acceptedCommits
      ..clear()
      ..addAll(
        ((spec['acceptedCommits'] as List?) ?? const <dynamic>[]).map(
          (e) => e.toString(),
        ),
      );
    for (final n in _notes) {
      if (n['verified'] != true) continue;
      final commit = _noteBytes(n['commit']);
      if (commit != null && commit.isNotEmpty)
        _acceptedCommits.add(_bytesHex(commit));
    }
    void takeCont(String key, void Function(int) set) {
      final v = spec[key];
      if (v is num && v >= 0) set(v.round());
    }

    takeCont('networkHashrate', (n) => networkHashrate = n);
    takeCont('circulatingNanos', (n) {
      if (n > 0) circulatingNanos = n;
    });
    takeCont('potEmittedNanos', (n) => potEmittedNanos = n);
    takeCont('hashBonusEmittedNanos', (n) => hashBonusEmittedNanos = n);
    takeCont('emittedAtHeight', (n) {
      if (n > 0) emittedAtHeight = n;
    });
    takeCont('sealedMeanBlockMs', (n) {
      if (n > 0) sealedMeanBlockMs = n;
    });
    final workBits = spec['networkWorkBits'];
    if (workBits is num && workBits > 0 && workBits < 1000) {
      networkWorkBits = workBits.toDouble();
    }
    _historyAt
      ..clear()
      ..addAll(_followInts(spec['historyAt']));
    _openCollated = spec['openCollated'] == true;
    if (spec.containsKey('spendableReadFailed')) {
      _spendableReadFailed = spec['spendableReadFailed'] == true;
    }
    if (spec.containsKey('unopenedListedProofs')) {
      _unopenedListedProofs =
          (spec['unopenedListedProofs'] as num?)?.toInt() ?? 0;
    }
    final collateError = spec['collateError']?.toString() ?? '';
    if (collateError.isNotEmpty) debugCollateError = collateError;
    destCount = (spec['destCount'] as num?)?.toInt() ?? destCount;
    destIndex = (spec['destIndex'] as num?)?.toInt() ?? destIndex;
    List<Map<String, dynamic>> rows(Object? raw) => <Map<String, dynamic>>[
      for (final item in (raw as List?) ?? const <dynamic>[])
        if (_followRevive(item) is Map)
          Map<String, dynamic>.from(_followRevive(item) as Map),
    ];
    if (spec.containsKey('nodeBodies')) {
      _nodeBodies
        ..clear()
        ..addAll(rows(spec['nodeBodies']));
    }
    if (spec.containsKey('nodeHistory')) {
      _nodeHistoryRows
        ..clear()
        ..addAll(rows(spec['nodeHistory']));
    }
    if (spec.containsKey('nodeNotes')) {
      _nodeNoteRows
        ..clear()
        ..addAll(rows(spec['nodeNotes']));
    }
    if (spec.containsKey('openedProofs')) {
      restoreOpenedProofs(spec['openedProofs']);
    }
    if (spec.containsKey('outputCommits')) {
      _chainOutputCommits.clear();
      _chainOutputCommitHex.clear();
      final raw = spec['outputCommits'];
      if (raw is List) {
        for (final item in raw) {
          _rememberOutputCommit(item);
        }
      }
    }
  }

  Future<void> adoptCreditFollow(Map<String, dynamic> spec) async {
    // A balance or verify follow does not carry the note book. Installing its
    // empty spendable map wiped opened coins, so Spendable stayed 0 on every
    // platform. Keep proofs that already opened, then recompute the one sum a
    // send can draw. A pool balance in [spec] does not raise that sum.
    final kept = <Map<String, dynamic>>[
      for (final n in _notes)
        if (n['verified'] == true || _bornDuringFollow(n))
          Map<String, dynamic>.from(n),
    ];
    final keptProofs = Set<String>.from(_proofCheckedDests);
    final rawNotes = spec['notes'];
    if (rawNotes is List && rawNotes.length > 24) {
      final head = Map<String, dynamic>.from(spec)..remove('notes');
      installCreditFollow(head);
      _notes.clear();
      var batch = 0;
      for (final raw in rawNotes) {
        final revived = _followRevive(raw);
        if (revived is Map) {
          _notes.add(Map<String, dynamic>.from(revived));
        }
        batch++;
        if (batch >= 24) {
          batch = 0;
          await Future<void>.delayed(Duration.zero);
        }
      }
    } else {
      installCreditFollow(spec);
    }
    _proofCheckedDests.addAll(keptProofs);
    final rest = spec['restFrame']?.toString() ?? _restFrame ?? '';
    final rawCode = spec['paymentCode']?.toString() ?? '';
    final removed = <String>{
      for (final e in (spec['removedCommits'] as List?) ?? const <dynamic>[])
        e.toString(),
    };
    for (final n in kept) {
      final commit = _noteBytes(n['commit']);
      if (commit != null &&
          commit.isNotEmpty &&
          removed.contains(_bytesHex(commit))) {
        continue;
      }
      if (commit != null) {
        for (final row in _notes) {
          final have = _noteBytes(row['commit']);
          if (have == null || !_bytesEq(have, commit)) continue;
          if (row['spent'] == true) {
            n['spent'] = true;
            if (row['spendTag'] != null) n['spendTag'] = row['spendTag'];
          }
          break;
        }
      }
      rememberNote(n);
      final dest = (n['dest'] ?? n['address'])?.toString() ?? '';
      if (dest.isNotEmpty) _proofCheckedDests.add(payKey(dest));
    }
    final listed = spec['listedCommits'];
    if (listed is List && listed.isNotEmpty) {
      final have = <String>{for (final e in listed) e.toString()};
      final born = <String>{
        for (final n in kept)
          if (_bornDuringFollow(n)) _commitHexOf(n),
      };
      _notes.removeWhere((n) {
        final hex = _commitHexOf(n);
        if (hex.isEmpty || born.contains(hex)) return false;
        return !have.contains(hex);
      });
      _openedProofs.removeWhere((k, _) => !have.contains(k.split('|').first));
    }
    if (rest.isNotEmpty) {
      recheckRestFrameSpendable(
        rest,
        paymentCode: rawCode.isEmpty ? null : rawCode,
      );
    }
  }

  Future<void> _adoptCoinMessage(
    Map<String, dynamic> message,
    void Function()? onCoins,
  ) async {
    final sealed = message['sealed'];
    if (sealed is num && sealed.toInt() > _sealedHeight) {
      noteLiveHeight(sealed.toInt());
    }
    final revived = _followRevive(message['notes']);
    if (revived is! List) return;
    var added = false;
    for (final raw in revived) {
      if (raw is! Map) continue;
      final row = Map<String, dynamic>.from(raw);
      if (row['verified'] != true) continue;
      if (!noteIsFs1Leaf(
        _noteBytes(row['admitPub']),
        _noteBytes(row['commit']),
      ))
        continue;
      rememberNote(row);
      _rememberProofRow(row);
      _creditNoteToShearview(row);
      final dest = (row['dest'] ?? row['address'])?.toString() ?? '';
      if (dest.isNotEmpty) _proofCheckedDests.add(payKey(dest));
      added = true;
    }
    final rest = _restFrame ?? '';
    if (rest.isNotEmpty) recheckRestFrameSpendable(rest);
    if (added && onCoins != null) onCoins();
  }

  /// Balance poll or full credit sync. HTTP and note scan run in [Isolate.run].
  /// This isolate only copies the worker's collated book back.
  Future<double> followOffUi({
    required String restFrame,
    String? paymentCode,
    required bool full,
    bool chain = true,
    bool spendableFirst = false,
    String? sessionPath,
    String? sessionPassword,
    void Function()? onCoins,
  }) async {
    _armFollowFlight();
    try {
      return await _followOffUiBody(
        restFrame: restFrame,
        paymentCode: paymentCode,
        full: full,
        chain: chain,
        spendableFirst: spendableFirst,
        sessionPath: sessionPath,
        sessionPassword: sessionPassword,
        onCoins: onCoins,
      );
    } finally {
      _disarmFollowFlight();
    }
  }

  Future<double> _followOffUiBody({
    required String restFrame,
    String? paymentCode,
    required bool full,
    bool chain = true,
    bool spendableFirst = false,
    String? sessionPath,
    String? sessionPassword,
    void Function()? onCoins,
  }) async {
    final spec = <String, dynamic>{
      'full': full,
      'chain': chain,
      'spendableFirst': spendableFirst,
      'restFrame': restFrame,
      'paymentCode': paymentCode ?? '',
      'baseUrl': creditFollowReadBase(pool),
      'ownNode': pool?.usesOwnNode == true,
      'publicConsent': pool?.publicConsent == true,
      'nodeSeeds': creditFollowReadSeeds(pool),
      'address': _restFrame ?? restFrame,
      'seedHex': spendSeed == null ? '' : _bytesHex(spendSeed!),
      'viewKey': viewSecret ?? '',
      'sealed': _sealedHeight,
      'settled': _settledHeight,
      'notesCovered': _notesCovered,
      'acceptedCommits': <String>[
        for (final n in _notes)
          if (n['verified'] == true)
            if (_noteBytes(n['commit']) != null &&
                _noteBytes(n['commit'])!.isNotEmpty)
              _bytesHex(_noteBytes(n['commit'])!),
      ],
      'destCount': destCount,
      'destIndex': destIndex,
      'dests': _dests.toList(),
      // Money dests the UI already accepts. The session file does not carry
      // stealth shared secrets, and a recomputed set drops the mining mailbox.
      'uiDests': syncDests(restFrame, paymentCode: paymentCode).toList(),
      // The worker installs this before it exports. A follow that omits it
      // would put an empty map back and the selector would spend the vault.
      'reserveHeld': <String, String>{
        for (final e in _reserveHeldNanos.entries) e.key: e.value.toString(),
      },
    };
    // The launch token lives in this isolate. The worker is another isolate,
    // so the spec carries it. armLocalRpcFromSpec removes it before any export.
    final rpcTok = localRpcToken;
    final rpcPort = localRpcPort;
    if (rpcTok != null && rpcTok.isNotEmpty && rpcPort != null) {
      spec['rpcToken'] = rpcTok;
      spec['rpcPort'] = rpcPort;
    }
    // A sealed session is already on disk. The worker opens it. Encoding the
    // in-memory book here is what froze Verifying on 0.68 (Windows and Android).
    if (sessionPath != null && sessionPath.isNotEmpty) {
      spec['sessionPath'] = sessionPath;
      spec['sessionPassword'] = sessionPassword ?? '';
    } else {
      final book = exportCreditFollow(
        restFrame: restFrame,
        paymentCode: paymentCode,
        full: full,
      );
      for (final key in const [
        'txs',
        'notes',
        'spendable',
        'pending',
        'advisory',
        'externalShe',
        'lockDebit',
        'reserveHeld',
        'settledNodeShe',
        'proofChecked',
        'unverifiedExternal',
        'notesAt',
        'historyAt',
        'openCollated',
        'nodeBodies',
        'nodeHistory',
        'nodeNotes',
        'openedProofs',
        'listedCommits',
      ]) {
        spec[key] = book[key];
      }
    }
    // Proof cache only. The note book stays out of this map when a session
    // file is what the worker opens.
    spec['openedProofs'] = exportOpenedProofs();
    debugLastFollowSpecKeys = spec.keys.map((k) => k.toString()).toList();
    final recv = ReceivePort();
    final doneWait = Completer<Map<String, dynamic>>();
    var adoptChain = Future<void>.value();
    final sub = recv.listen((message) {
      if (message is! Map) return;
      final event = message['event']?.toString();
      if (event == 'coins') {
        final msg = Map<String, dynamic>.from(message);
        adoptChain = adoptChain.then((_) => _adoptCoinMessage(msg, onCoins));
        return;
      }
      if ((event == 'done' || event == 'error') && !doneWait.isCompleted) {
        doneWait.complete(Map<String, dynamic>.from(message));
      }
    });
    Map<String, dynamic> result;
    try {
      await Isolate.spawn(creditFollowEntry, <dynamic>[
        jsonEncode(spec),
        recv.sendPort,
      ]);
      final done = await doneWait.future;
      await adoptChain;
      if (done['event'] == 'error') {
        throw StateError(done['message']?.toString() ?? 'credit_follow');
      }
      final rawOut = done['out'];
      if (rawOut is! Map) throw StateError('credit_follow');
      result = Map<String, dynamic>.from(rawOut);
    } finally {
      await sub.cancel();
      recv.close();
    }
    debugLastFollowResultKeys = result.keys.map((k) => k.toString()).toList();
    debugCreditFollowStamp = result['stamp']?.toString() ?? '';
    final scanStamp = result['scanStamp']?.toString() ?? '';
    if (scanStamp.isNotEmpty) debugScanIsolateStamp = scanStamp;
    debugCreditFollowKind = result['kind']?.toString() ?? '';
    debugCreditFollowKinds.add(debugCreditFollowKind);
    debugCreditFollowStamps.add(debugCreditFollowStamp);
    debugCreditFollowRuns += 1;
    await adoptCreditFollow(result);
    final opened = result['opened'];
    return opened is num
        ? opened.toDouble()
        : spendableOwned(restFrame, paymentCode: paymentCode);
  }

  /// Pull Continuum for this wallet's own money dests.
  /// A payment from someone else counts. A mining payout is not required.
  /// Do not query every historical dest.
  Future<double> syncCredits(
    String restFrame, {
    String? paymentCode,
    bool openMemos = false,
    SendPort? partials,
  }) async {
    if (pool == null) {
      final opened = recheckRestFrameSpendable(
        restFrame,
        paymentCode: paymentCode,
      );
      _openCollated = true;
      return opened;
    }
    keepOwnedDests(restFrame, paymentCode: paymentCode);
    _beginNoteFollow();
    final before = _settledHeight;
    try {
      final live = pool?.liveTip ?? 0;
      if (live > _sealedHeight) noteLiveHeight(live);
      await syncTip(proveChain: false);
    } catch (_) {}
    final dests = syncDests(restFrame, paymentCode: paymentCode);
    final reconstructed = <String, double>{};
    final owedSweep = await _balancesFor(dests, before: before);
    _finishOwedSweep(owedSweep.max, saw: owedSweep.saw, dest: owedSweep.dest);
    for (final d in dests) {
      if (!isDestAddress(d) || _isProgramVaultDest(d)) continue;
      reconstructed[payKey(d)] = spendable(d);
    }
    _markSettled(_sealedHeight, before);
    var hostHeight = 0;
    if (pool != null && !isPoolLedgerHost(pool!.baseUrl)) {
      try {
        final json = await pool!.stats().timeout(const Duration(seconds: 2));
        final h = (json['height'] as num?)?.toInt() ?? 0;
        if (h > 0) hostHeight = h;
      } catch (_) {}
    }
    final histSeen = <String>{};
    var rescanned = false;
    var notesTried = false;
    var notesSaw = false;
    var notesFailed = false;
    for (final d in dests) {
      final key = payKey(d);
      if (!histSeen.add(key)) continue;
      if (!_rescanBelowSealed && _notesAt[key] == _sealedHeight) {
        final lag = spendable(key) > 1e-12 && !_ownsSealedOn(key);
        if (!lag || (_noteMisses[key] ?? 0) >= 2) continue;
      }
      final seed = spendSeed;
      if (seed != null &&
          seed.length == 32 &&
          pool != null &&
          !isPoolLedgerHost(pool!.baseUrl)) {
        final open = destProofOpen(key);
        if (open == null || open.isEmpty) continue;
        notesTried = true;
        try {
          final json = await pool!.notes(key, open: open);
          final rows = json['notes'];
          if (rows is! List) {
            notesFailed = true;
            continue;
          }
          notesSaw = true;
          _takeListedCommits(rows);
          if (rows.isNotEmpty) {
            final raw = _sealedScanInput(rows, spendSeed: seed, dest: key);
            await _scanNotesProgressive(raw, partials: partials);
            rescanned = true;
          }
          final mark = notesHostStamp(
            sealed: _sealedHeight,
            hostHeight: hostHeight,
          );
          if (mark > 0 && _stampIngest(key, count: false)) {
            _notesAt[key] = mark;
            noteCovered(mark);
          }
          if (_ownsSealedOn(key)) {
            _noteMisses.remove(key);
          } else if (spendable(key) > 1e-12) {
            _noteMisses[key] = (_noteMisses[key] ?? 0) + 1;
          }
        } catch (_) {
          notesFailed = true;
        }
      }
    }
    if (notesTried) _spendableReadFailed = !notesSaw || notesFailed;
    if (rescanned) _rescanBelowSealed = false;
    histSeen.clear();
    for (final d in dests) {
      final key = payKey(d);
      if (!histSeen.add(key)) continue;
      try {
        await syncHistory(key, openMemos: openMemos);
      } catch (_) {}
    }
    // Node bodies and the history just pulled. A tip that did not move still
    // credits every opened owner land. Pool balance is not in that material.
    creditKnownNodeLands();
    settleTo(bookTip);
    // Opened coins with 9 confirmations are the book. The pre-notes snapshot
    // must not write a 0 or an inflated figure back over that sum. Without a
    // proof, the snapshot still caps a higher local pile. Vault dests stay out.
    for (final e in reconstructed.entries) {
      if (_isProgramVaultDest(e.key)) {
        _spendable.remove(e.key);
        continue;
      }
      final cap = _verifiedConfirmedShe(e.key);
      final floor = _settledNodeShe[e.key] ?? 0;
      if (cap != null) {
        // Opened notes are the usable sum, even when settled history is taller.
        _spendable[e.key] = cap;
        _unverifiedExternal.remove(e.key);
        _externalShe.remove(e.key);
        continue;
      }
      if (floor > 1e-12) {
        final extra = _externalShe[e.key];
        if (extra != null) {
          final without = spendable(e.key) - extra;
          // Settled history must not raise the book above the local coins.
          _spendable[e.key] = without > 1e-12 ? without : 0;
        }
        _externalShe.remove(e.key);
        _unverifiedExternal.remove(e.key);
        continue;
      }
      final piled = spendable(e.key);
      if (piled > e.value + 1e-12) _spendable[e.key] = e.value;
    }
    await _applyFollowSpentTags();
    _finishNoteFollow();
    final opened = recheckRestFrameSpendable(
      restFrame,
      paymentCode: paymentCode,
    );
    _openCollated = true;
    startPayoutConsolidate(restFrame, paymentCode: paymentCode);
    return opened;
  }

  /// Thin poll: tip + dest balances only. No history, notes, or memoOpen.
  Future<double> syncBalancesOnly(
    String restFrame, {
    String? paymentCode,
    Iterable<String> also = const [],
  }) async {
    if (pool == null)
      return spendableOwned(restFrame, paymentCode: paymentCode);
    keepOwnedDests(restFrame, paymentCode: paymentCode);
    final before = _settledHeight;
    try {
      await syncTip(proveChain: false);
    } catch (_) {}
    final dests = <String>{
      ...syncDests(restFrame, paymentCode: paymentCode),
      for (final d in also)
        if (isDestAddress(d) && !_isProgramVaultDest(d)) d,
    };
    final owedSweep = await _balancesFor(dests, before: before);
    _finishOwedSweep(owedSweep.max, saw: owedSweep.saw, dest: owedSweep.dest);
    _markSettled(_sealedHeight, before);
    return spendableOwned(restFrame, paymentCode: paymentCode);
  }

  /// First boot: catch settlement up to the painted tip without treating that
  /// as a confirm of the still-open round. Later polls settle when tip > this.
  void _markSettled(int tipSealed, int beforeHeight) {
    if (tipSealed <= 0) return;
    if (beforeHeight == 0 || tipSealed > beforeHeight) {
      if (tipSealed > _settledHeight) _settledHeight = tipSealed;
    }
  }

  Future<List<ShearTx>> syncHistory(
    String address, {
    bool openMemos = false,
  }) async {
    if (pool == null) return ownerHistory(address);
    if (isPoolLedgerHost(pool!.baseUrl)) return ownerHistory(address);
    final key = payKey(address);
    if (_historyAt[key] == _sealedHeight && !needsHistoryRefresh) {
      return ownerHistory(address);
    }
    try {
      final json = await pool!.history(
        address,
        open: destProofOpen(homeDest(address)),
      );
      final rows = (json['txs'] as List?) ?? const [];
      final existingPlain = <String, String>{
        for (final t in _txs)
          if (t.memoPlain != null && t.memoPlain!.isNotEmpty)
            t.id: t.memoPlain!,
      };
      final amountsOnly = json['amountsOnly'] == true;
      final destProof = json['destProof'] == true;
      final vaultDests = _vaultDests.toList();
      final rowSnapshot = <Object?>[
        for (final row in rows)
          if (row is Map) Map<String, dynamic>.from(row),
      ];
      // dart format off
      final parsed = await Isolate.run(() => parseHistoryPayload(<String, dynamic>{
      // dart format on
          'amountsOnly': amountsOnly,
          'destProof': destProof,
          'key': key,
          'openMemos': openMemos,
          'existingPlain': Map<String, String>.from(existingPlain),
          'vaultDests': vaultDests,
          'rows': jsonDecode(jsonEncode(rowSnapshot)),
        }),
      );
      if (keepLocalOwnerHistory(
        amountsOnly:
            json['amountsOnly'] == true || parsed['amountsOnly'] == true,
        destProof: json['destProof'] == true,
      )) {
        return ownerHistory(address);
      }
      final txs =
          <ShearTx>[
                for (final raw in (parsed['txs'] as List? ?? const []))
                  if (raw is Map)
                    ShearTx.fromJson(Map<String, dynamic>.from(raw)),
              ]
              .where(
                (tx) =>
                    (tx.to.isNotEmpty || tx.from.isNotEmpty) &&
                    (tx.amount > 0 || (tx.hashAmount ?? 0) > 0),
              )
              .toList();
      adoptLiveHistory(key, txs);
      for (final tx in txs) {
        if (payKey(tx.to) == key &&
            tx.to.isNotEmpty &&
            !_isProgramVaultDest(tx.to)) {
          _dests.add(tx.to);
        }
        mergeChainTx(tx);
      }
      // Empty live history with a known credit is a miss (node stall on a
      // new block) — retry next poll instead of freezing Shearview.
      final named = parsed['named'] == true;
      if ((named || spendable(key) <= 0) && _stampIngest(key)) {
        _historyAt[key] = _sealedHeight;
      }
      final histRows = <Map<String, dynamic>>[
        for (final row in rows)
          if (row is Map) Map<String, dynamic>.from(row),
      ];
      if (!isPoolLedgerHost(pool!.baseUrl))
        rememberNodeChain(history: histRows);
    } catch (_) {}
    prune();
    return ownerHistory(address);
  }

  /// Dests this shear1 wallet has seen. Encrypted session stores these locally.
  List<String> exportedDests() => _dests
      .where(isDestAddress)
      .where((d) => !_isProgramVaultDest(d))
      .toList();

  void restoreDests(Iterable<String> dests) {
    for (final d in dests) {
      rememberDest(d);
    }
  }

  /// Drop dests that are not bindable money dests for this wallet.
  void keepOwnedDests(String restFrame, {String? paymentCode}) {
    final allow = moneyDests(restFrame, paymentCode: paymentCode);
    if (isDestAddress(restFrame)) allow.add(restFrame);
    final drop = _dests
        .where(
          (d) =>
              !allow.contains(d) &&
              d != restFrame &&
              !_stealthShared.containsKey(d),
        )
        .toList();
    for (final d in drop) {
      _dests.remove(d);
      _spendable.remove(d);
      _pending.remove(d);
    }
  }

  /// Stable ssa1 mailbox: destCommit(spendPub) when the spend pub is known.
  /// destAtIndex is not a money dest — destMatchesSpendPub fails for it.
  String homeDest(String restFrame, {String? paymentCode}) {
    if (isDestAddress(restFrame)) return restFrame;
    return currentDest(restFrame, paymentCode: paymentCode);
  }

  final Map<int, Uint8List> _continuityAt = {};

  Future<Uint8List?> continuityAtHeight(int height) async {
    if (height < 1) return null;
    final hit = _continuityAt[height];
    if (hit != null) return hit;
    if (pool == null) return lag1Root;
    try {
      final json = await pool!.headerAt(height);
      final raw = _continuityBytes(
        json['continuity']?.toString() ??
            json['continuityRoot']?.toString() ??
            '',
      );
      if (raw != null) {
        _continuityAt[height] = raw;
        return raw;
      }
      final hex = json['header']?.toString() ?? '';
      final hdr = headerFromHex(hex);
      if (hdr != null) {
        final c = lag1ContinuityFromHeader(hdr);
        _continuityAt[height] = c;
        return c;
      }
    } catch (_) {}
    await _warmContinuityFromDag();
    return _continuityAt[height] ?? lag1Root;
  }

  Future<void> _warmContinuityFromDag() async {
    if (pool == null || _continuityAt.length > 1) return;
    try {
      final json = await pool!.explorerDag();
      final blocks = json['blocks'] as List? ?? const [];
      for (final b in blocks) {
        if (b is! Map) continue;
        final h = (b['height'] as num?)?.toInt() ?? 0;
        final c = _continuityBytes(b['continuity']?.toString() ?? '');
        if (h > 0 && c != null) _continuityAt[h] = c;
      }
    } catch (_) {}
  }

  static Uint8List? _continuityBytes(String hex) {
    final s = hex.trim().replaceFirst(RegExp(r'^0x'), '');
    if (s.length != 64) return null;
    try {
      final out = Uint8List(32);
      for (var i = 0; i < 32; i++) {
        out[i] = int.parse(s.substring(i * 2, i * 2 + 2), radix: 16);
      }
      return out;
    } catch (_) {
      return null;
    }
  }

  String? viewSecret;

  /// Long-term Ed25519 spend pub. currentDest is destCommit(spendPub).
  Uint8List? spendPub;

  /// ristretto B = x_base·G. Copy dest payload dest20||B so mining notes wrap r.
  Uint8List? admitBase;

  /// Spend seed for Admit x and rEph unwrap. In-memory after unlock.
  Uint8List? spendSeed;

  /// Last vault wait or refusal the UI can show. Not a chain field.
  String reserveRemark = '';
  int? reserveWaitMs;

  void noteReserveWait(int slotMs) {
    if (slotMs <= 0) {
      reserveWaitMs = null;
      return;
    }
    if (reserveWaitMs == null || slotMs < reserveWaitMs!) reserveWaitMs = slotMs;
    reserveRemark = '';
  }

  void noteReserveRemark(String text) {
    reserveRemark = text;
    if (text.isNotEmpty) reserveWaitMs = null;
  }

  void clearReserveNotice() {
    reserveRemark = '';
    reserveWaitMs = null;
  }

  Uint8List? _spendPubOf(String? paymentCode) {
    final parsed = decodePaymentCode(paymentCode ?? '');
    spendPub ??= parsed?['spendPub'];
    admitBase ??= parsed?['admitBase'];
    if (spendPub == null && spendSeed != null && spendSeed!.length == 32) {
      spendPub = ed25519PublicFromSeed(spendSeed!);
    }
    return spendPub;
  }

  String? _ownPaymentCode(String restFrame, {String? paymentCode}) {
    if (paymentCode != null && isFullPaymentCode(paymentCode))
      return paymentCode;
    final pub = spendPub;
    final v = viewSecret;
    if (pub != null && pub.length == 32 && v != null && v.isNotEmpty) {
      // Change and consolidate pay the wallet's own stealth dest. A fingerprint
      // has no admit base, so the sealed output could not carry amtCt or join
      // the FS-1 set. The full code embeds this wallet's base.
      return paymentCodeAtIndex(v, pub, 0, _admitBaseOf(paymentCode));
    }
    return null;
  }

  /// True when [dest] can be signed with the long-term spend key or a stealth tweak.
  bool isBindable(String dest, {String? restFrame, String? paymentCode}) {
    if (!isDestAddress(dest) || _isProgramVaultDest(dest)) return false;
    if (_stealthShared.containsKey(dest)) return true;
    final pub = _spendPubOf(paymentCode);
    if (pub != null && pub.length == 32) return destMatchesSpendPub(dest, pub);
    if (restFrame != null) {
      return dest == currentDest(restFrame, paymentCode: paymentCode);
    }
    return false;
  }

  /// Spendable dests for this wallet. destAtIndex / destForLogin-without-spendPub
  /// are not money dests — consensus destMatchesSpendPub rejects them.
  Set<String> moneyDests(String restFrame, {String? paymentCode}) {
    spendPub ??= decodePaymentCode(paymentCode ?? '')?['spendPub'];
    _foldFlowDest(restFrame, paymentCode: paymentCode);
    final pub = _spendPubOf(paymentCode);
    final keys = <String>{};
    void add(String? a) {
      if (a == null || a.isEmpty || !isDestAddress(a) || _isProgramVaultDest(a))
        return;
      if (_isIndexedDest(a, restFrame)) return;
      if (pub != null && pub.length == 32) {
        if (isBindable(a, restFrame: restFrame, paymentCode: paymentCode))
          keys.add(a);
      } else {
        keys.add(a);
      }
    }

    add(currentDest(restFrame, paymentCode: paymentCode));
    for (final d in _stealthShared.keys) {
      add(d);
    }
    for (final d in _dests) {
      add(d);
    }
    return keys;
  }

  bool _isIndexedDest(String dest, String restFrame) {
    if (viewSecret == null || viewSecret!.isEmpty) return false;
    for (var i = 0; i < destCount; i++) {
      if (destAt(restFrame, i) == dest) return true;
    }
    return false;
  }

  /// A credit parked on destForLogin, or on the shear1 rest-frame itself,
  /// moves onto destCommit once the spend pub is known. Spendable coins stay
  /// spendable. Coins still under 9 confirmations stay confirming.
  void _foldFlowDest(String restFrame, {String? paymentCode}) {
    final pub = _spendPubOf(paymentCode);
    if (pub == null || pub.length != 32) return;
    final bound = encodeDestAddress(
      destCommitFromSpendPub(pub),
      _admitBaseOf(paymentCode),
    );
    if (!isDestAddress(bound)) return;
    final fromKeys = <String>{};
    if (restFrame.isNotEmpty &&
        !isDestAddress(restFrame) &&
        restFrame != bound) {
      fromKeys.add(restFrame);
    }
    final flow = destForLogin(
      restFrame,
      height: tipHeight,
      continuityRoot: lag1Root,
      viewKey: viewSecret,
    );
    if (flow != null &&
        flow != bound &&
        flow != restFrame &&
        !_stealthShared.containsKey(flow) &&
        !destMatchesSpendPub(flow, pub)) {
      fromKeys.add(flow);
    }
    if (fromKeys.isEmpty) return;
    var s = 0.0;
    var p = 0.0;
    for (final key in fromKeys) {
      s += _spendable.remove(key) ?? 0;
      p += _pending.remove(key) ?? 0;
      _dests.remove(key);
    }
    var moved = s != 0 || p != 0;
    for (var i = 0; i < _txs.length; i++) {
      final t = _txs[i];
      if (!fromKeys.contains(t.to) && !fromKeys.contains(t.from)) continue;
      _txs[i] = ShearTx(
        id: t.id,
        from: fromKeys.contains(t.from) ? bound : t.from,
        to: fromKeys.contains(t.to) ? bound : t.to,
        amount: t.amount,
        kind: t.kind,
        height: t.height,
        confirmed: t.confirmed,
        memo: t.memo,
        memoPlain: t.memoPlain,
        memoCt: t.memoCt,
        rounds: t.rounds,
        hashAmount: t.hashAmount,
        threads: t.threads,
        pot: t.pot,
        change: t.change,
      );
      moved = true;
    }
    if (_immature.isNotEmpty) {
      final next = <({String dest, double amount, int height})>[];
      for (final row in _immature) {
        if (fromKeys.contains(row.dest)) {
          next.add((dest: bound, amount: row.amount, height: row.height));
          moved = true;
        } else {
          next.add(row);
        }
      }
      _immature
        ..clear()
        ..addAll(next);
    }
    if (!moved) return;
    if (s != 0) _spendable[bound] = (_spendable[bound] ?? 0) + s;
    if (p != 0) _pending[bound] = (_pending[bound] ?? 0) + p;
    _dests.add(bound);
  }

  String? destAt(String restFrame, int index) {
    final v = viewSecret;
    if (v == null || v.isEmpty) return null;
    final hit = destAtIndex(restFrame, index: index, viewKey: v);
    if (hit != null) return hit;
    final spend = hash20FromAddress(restFrame);
    if (spend == null) return null;
    return encodeDestAddress(
      indexedDestHash(
        spendHash20: spend,
        closure: closureCommit(v),
        index: index,
      ),
    );
  }

  List<String> listedDests(String restFrame) {
    final out = <String>[];
    for (var i = 0; i < destCount; i++) {
      final d = destAt(restFrame, i);
      if (d != null) out.add(d);
    }
    return out;
  }

  Uint8List? _admitBaseOf(String? paymentCode) {
    admitBase ??= decodePaymentCode(paymentCode ?? '')?['admitBase'];
    if (admitBase == null && spendSeed != null && spendSeed!.length == 32) {
      admitBase = admitBaseBytes(spendSeed!);
    }
    return admitBase;
  }

  String currentDest(String restFrame, {String? paymentCode}) {
    if (isDestAddress(restFrame)) return restFrame;
    final pub = _spendPubOf(paymentCode);
    if (pub != null && pub.length == 32) {
      // Mining mailbox is destCommit(spendPub)||B so coinbase wrap can
      // attach rEph/rCt and ingestSealedVouts can recover r.
      return encodeDestAddress(
        destCommitFromSpendPub(pub),
        _admitBaseOf(paymentCode),
      );
    }
    return destForLogin(
          restFrame,
          height: tipHeight,
          continuityRoot: lag1Root,
          viewKey: viewSecret,
        ) ??
        restFrame;
  }

  /// Fresh stealth dest of this wallet's payment code. destAtIndex is not a money dest.
  String newDest(String restFrame, {String? paymentCode}) {
    destCount += 1;
    destIndex = destCount - 1;
    final d = _freshStealthDest(restFrame, paymentCode: paymentCode);
    _dests.add(d);
    return d;
  }

  String _freshStealthDest(
    String restFrame, {
    String? paymentCode,
    String? from,
    String? portalDest,
  }) {
    final code = _ownPaymentCode(restFrame, paymentCode: paymentCode);
    if (code != null) {
      for (var i = 0; i < 24; i++) {
        final pay = silentPay(code);
        if (pay == null) continue;
        if (pay.dest == from ||
            pay.dest == portalDest ||
            _isProgramVaultDest(pay.dest))
          continue;
        _stealthShared[pay.dest] = pay.shared;
        _dests.add(pay.dest);
        return pay.dest;
      }
    }
    return currentDest(restFrame, paymentCode: paymentCode);
  }

  /// The one address receives add to. Stable until the wallet is reset.
  String coinLedgerDest(String restFrame, {String? paymentCode}) {
    final have = _coinLedger;
    if (have != null &&
        isDestAddress(have) &&
        !_isProgramVaultDest(have) &&
        isBindable(have, restFrame: restFrame, paymentCode: paymentCode)) {
      return have;
    }
    final home = homeDest(restFrame, paymentCode: paymentCode);
    final d = _freshStealthDest(
      restFrame,
      paymentCode: paymentCode,
      from: home,
    );
    _coinLedger = d;
    _dests.add(d);
    return d;
  }

  /// Continuum receive: the one coin-ledger address. A second receive adds to it.
  String allocateReceiveDest(String restFrame, {String? paymentCode}) =>
      coinLedgerDest(restFrame, paymentCode: paymentCode);

  /// Change returns to the coin ledger. Never [from] and never the Reserve portal.
  String allocateChangeDest(
    String restFrame, {
    String? from,
    String? portalDest,
    String? paymentCode,
  }) {
    if (_ownPaymentCode(restFrame, paymentCode: paymentCode) == null) {
      throw ArgumentError('same_dest');
    }
    final ledgerDest = _coinLedger;
    if (ledgerDest != null &&
        ledgerDest != from &&
        ledgerDest != portalDest &&
        isDestAddress(ledgerDest) &&
        !_isProgramVaultDest(ledgerDest)) {
      return ledgerDest;
    }
    for (var i = 0; i < 24; i++) {
      final d = _freshStealthDest(
        restFrame,
        paymentCode: paymentCode,
        from: from,
        portalDest: portalDest,
      );
      if (d != from && d != portalDest && !_isProgramVaultDest(d)) return d;
    }
    throw ArgumentError('same_dest');
  }

  void rememberSpentDest(String dest) {
    if (dest.isEmpty || !isDestAddress(dest)) return;
    _spentHistory.add(dest);
  }

  /// True when the user pastes an ssa1 already in this wallet's spend history.
  bool warnSpentDestPaste(String dest) => _spentHistory.contains(dest);

  /// Official sheet: same-dest change and Reserve portal as Flow change cannot be signed.
  void refuseSheetChange({
    required String from,
    String? to,
    String? change,
    String? portalDest,
  }) {
    if (to != null && to == from) {
      throw ArgumentError('same_dest');
    }
    if (change != null && change == from) {
      throw ArgumentError('same_dest');
    }
    if (portalDest != null && portalDest.isNotEmpty) {
      if (to == portalDest || change == portalDest) {
        throw ArgumentError('portal_change');
      }
    }
  }

  void selectDest(int index) {
    if (index < 0 || index >= destCount) return;
    destIndex = index;
  }

  Set<String> ownedAddresses(String restFrame, {String? paymentCode}) {
    _dropProgramVaults();
    final keys = <String>{
      restFrame,
      ...moneyDests(restFrame, paymentCode: paymentCode),
    };
    keys.removeWhere(_isProgramVaultDest);
    return keys;
  }

  List<ShearTx> ownerHistory(String address) {
    return _ownedRolled(address)
        .where(
          (t) =>
              t.kind != 'sample' &&
              (t.confirmed ||
                  t.kind == 'send' ||
                  t.kind == 'pool-withdraw' ||
                  t.kind == 'blockfound' ||
                  t.kind == 'coinbase'),
        )
        .toList();
  }

  List<ShearTx> _ownedRolled(String address) {
    final keys = ownedAddresses(address);
    final mine = _txs.where((t) {
      if (t.kind == 'sample') return false;
      return keys.contains(t.to) ||
          keys.contains(t.from) ||
          ((t.from == 'hash' ||
                  t.from == 'coinbase' ||
                  t.from == 'pending' ||
                  t.from == 'pool') &&
              keys.contains(t.to));
    });
    return rollupExplorerTxs(mine).where((t) => t.kind != 'hash').toList();
  }

  /// Dest opening for /api/wallet/history so the book returns dests, not public stubs.
  String? destProofOpen(String dest) {
    final view = viewSecret ?? '';
    if (view.isEmpty) return null;
    if (spendPub != null && destMatchesSpendPub(dest, spendPub!)) {
      return destOpeningFromView(view, spendPub!);
    }
    final rest = _restFrame;
    if (rest != null && rest.isNotEmpty) {
      return openingForDest(
        from: dest,
        restFrame: rest,
        viewKey: view,
        destCount: destCount,
      );
    }
    if (spendPub != null) return destOpeningFromView(view, spendPub!);
    return null;
  }

  /// Live owner history is the book. Leftover ids from a prior genesis go.
  /// Empty live is a no-op: same-chain mempool / confirmRound-stamped receives
  /// are not yet in explorer history. Height < 1 always stays. First live
  /// genesis bind already wiped leftover including never-confirmed old-pend.
  /// Amounts-only / dest-stripped rows (no to/from) must not wipe dest-owned txs.
  void adoptLiveHistory(String key, List<ShearTx> live) {
    if (live.isEmpty) return;
    if (live.every((t) => t.to.isEmpty && t.from.isEmpty)) return;
    final liveIds = <String>{for (final t in live) t.id};
    _txs.removeWhere((t) {
      final h = t.height ?? 0;
      if (h < 1) return false;
      // Still on the Continuum pending vortex. A history page that omits this
      // id must not drop it before 9 confirmations.
      if (h <= _sealedHeight + 1 && confirmationsOf(h) < spendableConfirmations)
        return false;
      // Lock/withdraw rows replay portal principal after a thin staked=0 sync.
      // A later history page of payouts must not erase them.
      if (t.kind == 'lock' || t.kind == 'withdraw' || t.kind == 'roll') return false;
      final mine =
          payKey(t.to) == key ||
          t.to == key ||
          payKey(t.from) == key ||
          t.from == key;
      if (!mine) {
        if ((t.from == 'coinbase' ||
                t.from == 'pool' ||
                t.kind == 'block' ||
                t.kind == 'blockfound') &&
            !liveIds.contains(t.id)) {
          return true;
        }
        return false;
      }
      if (liveIds.contains(t.id)) return false;
      if (t.kind == 'send' && !t.confirmed && (t.height ?? 0) < 1) return false;
      // An opened note at this height is the seal. An explorer id that does
      // not match the ShearView id must not erase it after 9 confirmations.
      if (_openedNoteAt(key, h)) return false;
      return true;
    });
    _collapseDuplicateReceipts();
  }

  bool isOutgoingTx(String address, ShearTx t) {
    return ownedAddresses(address).contains(t.from);
  }

  /// Dedicated explorer list. Owner view: every landing (amount, dest, status)
  /// from 1 conf — never explorerRowPublic blanks. Hash sits inside the block row.
  /// Height-less pending owner rows belong here too (open collate + live append).
  List<ShearTx> shearviewTxs(String address) {
    _replayOpenedNotes();
    final rolled = _ownedRolled(address);
    final rows = rolled.where((t) {
      if (t.kind == 'hash' || t.kind == 'sample') return false;
      if (t.to.isEmpty && t.from.isEmpty) return false;
      if (t.amount <= 0 &&
          (t.hashAmount == null || t.hashAmount! <= 0) &&
          !isReservePendingKind(t)) {
        return false;
      }
      final h = t.height ?? 0;
      if (isReservePendingKind(t)) {
        if (h < 1) return !t.confirmed;
        return confirmationsOf(h) >= 1;
      }
      if (h < 1) {
        if (isWalletBlockKind(t.kind)) return true;
        return !t.confirmed &&
            (t.kind == 'receive' ||
                t.kind == 'send' ||
                t.kind == 'pool-fee' ||
                t.kind == 'pool-withdraw' ||
                isOwnerLanding(t));
      }
      final confs = confirmationsOf(h);
      if (t.kind == 'pool-fee') return true;
      if (isWalletBlockKind(t.kind)) return !isFeeBlockMirror(t, rolled);
      // Depth unknown, including a pin that has not caught the host:
      // an incoming row stays, as pending, with no count.
      if (isOwnerLanding(t)) {
        if (!t.confirmed) return true;
        if (confirmationCountHidden(h)) return true;
        return bookTip < 1 || confs >= 1;
      }
      return confs >= continuumConfirmations;
    }).toList();
    rows.sort((a, b) => (b.height ?? 0).compareTo(a.height ?? 0));
    return rows;
  }

  /// Coins still arriving: incoming rows with fewer than 9 confirmations.
  /// Not added into Spendable. A row already counted as immature is not summed twice.
  double unconfirmedIncomingShe(String restFrame, {String? paymentCode}) {
    _replayOpenedNotes();
    _collapseDuplicateReceipts();
    final keys = ownedAddresses(restFrame, paymentCode: paymentCode).toSet();
    const incoming = {
      'receive',
      'coinbase',
      'blockfound',
      'pool-withdraw',
      'withdraw',
      'pool-fee',
      kBluKindWinner,
      kBluKindFee,
    };
    var n = 0.0;
    final covered = <String>{};
    for (final t in _txs) {
      if (isFeeBlockMirror(t, _txs)) continue;
      if (!incoming.contains(t.kind) || t.amount <= 1e-12) continue;
      final dest = payKey(t.to);
      if (!keys.contains(t.to) && !keys.contains(dest)) continue;
      final h = t.height ?? 0;
      if (h >= 1 && confirmationsOf(h) >= spendableConfirmations) continue;
      n += t.amount;
      covered.add('$dest|$h|${t.amount}');
      covered.add('${t.to}|$h|${t.amount}');
    }
    for (final row in _immature) {
      if (!keys.contains(row.dest) || row.amount <= 1e-12) continue;
      if (confirmationsOf(row.height) >= spendableConfirmations) continue;
      final mark = '${row.dest}|${row.height}|${row.amount}';
      if (covered.contains(mark)) continue;
      n += row.amount;
    }
    return n > 1e-12 ? n : 0.0;
  }

  /// Pool-custodial pot still confirming toward π auto-pay.
  /// One source: pull-book owedPi, else in-flight pool-withdraw amounts, else
  /// a pot field. Never their sum. Not part of Spendable.
  /// Miner-page totals are not this.
  double owedTowardPi(String restFrame, {String? paymentCode}) {
    final book = _owedPiDisplay > 0 ? _owedPiDisplay : 0.0;
    var raw = book;
    if (book <= 0) {
      var withdraw = 0.0;
      var pot = 0.0;
      for (final t in pendingTxs(restFrame)) {
        if (t.kind == 'pool-withdraw' && t.amount > 0) {
          withdraw += t.amount;
          continue;
        }
        final rowPot = t.pot ?? 0;
        if (rowPot > 0) pot += rowPot;
      }
      raw = withdraw > 0 ? withdraw : pot;
    }
    final left = raw - _owedSpent;
    return left > 1e-12 ? left : 0.0;
  }

  double _owedPiDisplay = 0;
  double _owedSpent = 0;
  String _owedPiDest = '';
  String _paintedFundDest = '';
  int _paintedFundOwedNanos = 0;

  List<ShearTx> shearviewSearch(String address, String query) {
    return shearviewTxs(
      address,
    ).where((t) => shearviewMatches(t, query)).toList();
  }

  /// Continuum: full blocks still filling the 6-slice pie, plus in-flight
  /// send/receive/pool-withdraw. Hash rewards never list on their own — they sit in the block.
  List<ShearTx> pendingTxs(String address) {
    _replayOpenedNotes();
    _collapseDuplicateReceipts();
    final rolled = _ownedRolled(address);
    final rows = rolled.where((t) {
      if (t.kind == 'hash' || t.kind == 'sample') return false;
      if (!t.confirmed && t.kind == 'pool-withdraw') {
        final h = t.height ?? 0;
        if (h < 1) return true;
        return confirmationsOf(h) < continuumConfirmations;
      }
      if (!t.confirmed &&
          (t.kind == 'send' || t.kind == 'lock' || t.kind == 'vote'))
        return true;
      final h = t.height ?? 0;
      if (h < 1) {
        // Rollup paints block rows confirmed. The book row is still unconfirmed
        // until a height is stamped and the maturity floor is met.
        if (t.kind == 'blockfound' ||
            t.kind == 'coinbase' ||
            t.kind == 'mine') {
          return !isFeeBlockMirror(t, rolled);
        }
        return !t.confirmed && (t.kind == 'receive' || t.kind == 'pool-fee');
      }
      if (isFeeBlockMirror(t, rolled)) return false;
      return confirmationsOf(h) < continuumConfirmations;
    }).toList();
    rows.sort((a, b) => (b.height ?? 0).compareTo(a.height ?? 0));
    return rows;
  }

  /// Local Reserve credit. A Sign click is not a chain payout, so this does
  /// not move Continuum spendable. The sealed reconstruct is the credit.
  ShearTx creditReserve({
    required String to,
    required double amount,
    int? height,
  }) {
    if (amount <= 0) throw ArgumentError('amount');
    if (isShearAddress(to)) throw ArgumentError('rest_frame');
    final key = payKey(to);
    return ShearTx(
      id: 'reserve-${DateTime.now().millisecondsSinceEpoch}',
      from: 'shear-reserve-v1',
      to: key,
      amount: amount,
      kind: 'withdraw',
      height: height,
      confirmed: false,
    );
  }

  final Set<String> _spentTagHex = {};

  /// The credit worker is already off the UI isolate. A nested [Isolate.run]
  /// from it never finishes, so that worker stamps in place.
  bool _stampSpendTagsInline = false;

  /// Held nanos on [note] from the same peel as the Spendable figure.
  BigInt _heldNanosOf(
    Map<String, dynamic> note,
    String? restFrame,
    String? paymentCode,
  ) {
    var index = -1;
    for (var i = 0; i < _notes.length; i++) {
      if (identical(_notes[i], note)) {
        index = i;
        break;
      }
    }
    if (index < 0) {
      final want = _commitHexOf(note);
      if (want.isNotEmpty) {
        for (var i = 0; i < _notes.length; i++) {
          if (_commitHexOf(_notes[i]) == want) {
            index = i;
            break;
          }
        }
      }
    }
    if (index < 0) return BigInt.zero;
    final pool = poolSpendableNotes(
      _spendPlanInput(restFrame ?? _restFrame ?? '', paymentCode, 0),
    );
    for (final row in pool.free) {
      if (row['i'] == index) return _heldOfRow(row);
    }
    return BigInt.zero;
  }

  Future<void> _stampSpendTagsOffUi() async {
    final seed = spendSeed;
    if (seed == null || seed.length != 32) return;
    final index = <int>[];
    final payload = <Map<String, dynamic>>[];
    for (var i = 0; i < _notes.length; i++) {
      final n = _notes[i];
      if ((n['spendTag']?.toString() ?? '').isNotEmpty) continue;
      if (!noteHasSealedSpendBytes(n)) continue;
      index.add(i);
      payload.add({
        'kind': (n['kind'] ?? 'pot').toString(),
        'commit': _noteBytes(n['commit']),
        'noteCommit': _noteBytes(n['noteCommit']),
      });
    }
    if (index.isEmpty) return;
    final tags = _stampSpendTagsInline
        ? <String?>[for (final n in payload) spendTagHexOf(seed, n)]
        : await Isolate.run(
            () => <String?>[for (final n in payload) spendTagHexOf(seed, n)],
          );
    for (var j = 0; j < index.length; j++) {
      final tag = tags[j];
      if (tag != null && tag.isNotEmpty) _notes[index[j]]['spendTag'] = tag;
    }
  }

  /// Anchor rows from the last fluxset read (newest first).
  List<Fs1Anchor> _fs1Anchors = const [];

  /// The native FS-1 tree kept between sends.
  Fs1TreeState _fs1Tree = const Fs1TreeState();

  /// One FS-1 spend of every note in [notes] for the [sealed] outputs at
  /// [fee]. The digest binds the posted outputs, the fee, and the anchor, so
  /// none may change after this. Vin is C̃ only.
  Future<
    ({
      List<Map<String, dynamic>> vin,
      List<Map<String, dynamic>> proofs,
      Uint8List fs1,
      int anchor,
      Uint8List excess,
      List<Uint8List> t,
    })
  >
  _fs1Spend({
    required List<Map<String, dynamic>> notes,
    required List<Map<String, dynamic>> sealed,
    required int fee,
    required Uint8List spendSeed,
    String kind = 'send',
    bool keepT = false,
    String portalId = '',
    String programId = '',
    String id = '',
    Uint8List? withdrawNonce,
    int? reserveNanos,
    Map<String, dynamic>? memoCt,
  }) async {
    if (notes.isEmpty || notes.length > kFs1InputMax)
      throw StateError('fs1_inputs');
    final cols = await _fluxColumns();
    if (cols.pubs.isEmpty || cols.commits.length != cols.pubs.length)
      throw StateError('fluxset');
    final spent = <Map<String, dynamic>>[];
    final indices = <int>[];
    for (final note in notes) {
      final commit = _noteBytes(note['commit']);
      final nc = _noteBytes(note['noteCommit']);
      final r = _noteBytes(note['r']);
      if (commit == null ||
          nc == null ||
          r == null ||
          commit.length != 32 ||
          r.length != 32) {
        throw StateError('no_note');
      }
      final pub = _noteBytes(note['admitPub']);
      var at = -1;
      for (var i = 0; i < cols.commits.length; i++) {
        if (_sameBytes32(cols.commits[i], commit) &&
            (pub == null || _sameBytes32(cols.pubs[i], pub))) {
          at = i;
          break;
        }
      }
      if (at < 0 || indices.contains(at)) throw StateError('no_note');
      indices.add(at);
      final noteSeed = note['spendSeed'] ?? note['changeSeed'] ?? note['payoutSeed'];
      spent.add({
        'kind': (note['kind'] as String?) ?? 'pot',
        'commit': commit,
        'noteCommit': nc,
        'r': r,
        if (noteSeed is Uint8List && noteSeed.length == 32) 'spendSeed': noteSeed,
      });
    }
    final top = indices.reduce((a, b) => a > b ? a : b);
    final anchor = pickFs1Anchor(_fs1Anchors, top);
    if (anchor == null) throw StateError(kErrFs1Anchor);
    // The posted body carries these fields. The proof is useless if they
    // are stamped after the digest.
    final digest = fs1BodyDigest(
      magic: kBookMagic,
      kind: kind,
      anchor: anchor.height,
      fee: fee,
      nIn: notes.length,
      vout: _postedVout(sealed),
      portalId: portalId,
      programId: programId,
      id: id,
      withdrawNonce: withdrawNonce,
      reserveNanos: reserveNanos,
      memoCt: memoCt,
    );
    Map<String, dynamic> proved;
    try {
      proved = await _proveFlowOffUi({
        'notes': fs1NotesBytes(cols.pubs, cols.commits, anchor.n),
        'indices': indices,
        'spent': spent,
        'spendSeed': spendSeed,
        'vout': sealed,
        'digest': digest,
        'anchor': anchor.height,
        'tree': _fs1Tree.toWire(),
        if (keepT) 'keepT': true,
      }).timeout(kFs1ProveTimeout);
    } on TimeoutException {
      throw StateError('send_timeout');
    }
    _fs1Tree = Fs1TreeState.fromWire(proved['tree']);
    final proofs = <Map<String, dynamic>>[
      for (final rec in (proved['records'] as List))
        fs1PostedProof(rec as Uint8List),
    ];
    if (proofs.length != notes.length) throw StateError('fs1_prove');
    return (
      vin: <Map<String, dynamic>>[
        for (final p in proofs) {'commit': p['cTilde']},
      ],
      proofs: proofs,
      fs1: proved['fs1'] as Uint8List,
      anchor: anchor.height,
      excess: proved['excess'] as Uint8List,
      t: keepT && proved['t'] is List
          ? <Uint8List>[
              for (final row in proved['t'] as List)
                if (row is Uint8List) Uint8List.fromList(row),
            ]
          : <Uint8List>[],
    );
  }

  /// One fresh FS-1 spend of [note]. [t] is returned only so the caller can
  /// check cTilde = commit + t·H. It is not a wire field.
  Future<({List<Map<String, dynamic>> vin, List<Map<String, dynamic>> proofs, Uint8List fs1, int anchor, Uint8List excess, List<Uint8List> t})>
      spendFs1Notes({
    required List<Map<String, dynamic>> notes,
    required List<Map<String, dynamic>> sealed,
    required int fee,
    required Uint8List spendSeed,
    String kind = 'leaf-vote',
    String portalId = '',
    String programId = '',
    String id = '',
    Uint8List? withdrawNonce,
    int? reserveNanos,
  }) {
    return _fs1Spend(
      notes: notes,
      sealed: sealed,
      fee: fee,
      spendSeed: spendSeed,
      kind: kind,
      // t is only for the leaf-vote cTilde check. A send or withdraw does not keep it.
      keepT: kind == 'leaf-vote',
      portalId: portalId,
      programId: programId,
      id: id,
      withdrawNonce: withdrawNonce,
      reserveNanos: reserveNanos,
    );
  }

  Future<({List<Uint8List> pubs, List<Uint8List> commits})>
  _fluxColumns() async {
    if (pool == null)
      return (pubs: const <Uint8List>[], commits: const <Uint8List>[]);
    try {
      final live = await pool!.fluxset();
      _takeSpendTags(live);
      final rawPubs = live['pubs'];
      final rawCommits = live['commits'];
      if (rawPubs is! List ||
          rawCommits is! List ||
          rawPubs.length != rawCommits.length) {
        return (pubs: const <Uint8List>[], commits: const <Uint8List>[]);
      }
      final pubs = <Uint8List>[];
      final commits = <Uint8List>[];
      // FS-1 leaf indices are positions in this list. A dropped row would
      // shift every later index, so one bad row refuses the whole set.
      for (var i = 0; i < rawPubs.length; i++) {
        final p = _noteBytes(rawPubs[i]);
        final c = _noteBytes(rawCommits[i]);
        if (p == null || c == null || p.length != 32 || c.length != 32) {
          return (pubs: const <Uint8List>[], commits: const <Uint8List>[]);
        }
        pubs.add(p);
        commits.add(c);
      }
      _fs1Anchors = fs1AnchorsOf(live['anchors']);
      return (pubs: pubs, commits: commits);
    } catch (_) {
      return (pubs: const <Uint8List>[], commits: const <Uint8List>[]);
    }
  }

  /// Non-ssa1 rest-frame rewards join the coin ledger. ssa1 coinbase notes stay
  /// put until [consolidateSpendableNotes] merges them on chain.
  void consolidateIncomingRewards(String restFrame, {String? paymentCode}) {
    final bound = _coinLedger;
    if (bound == null || !isDestAddress(bound) || _isProgramVaultDest(bound))
      return;
    for (final n in _notes) {
      if (n['spent'] == true) continue;
      final addr = (n['address'] ?? n['dest'])?.toString() ?? '';
      if (addr.isEmpty || isDestAddress(addr) || _isProgramVaultDest(addr))
        continue;
      n['address'] = bound;
      n['dest'] = bound;
      rememberDest(bound);
    }
  }

  Map<String, dynamic> _spendPlanInput(
    String restFrame,
    String? paymentCode,
    double amount, {
    bool memo = false,
    String? needNanos,
  }) {
    final snap = <Map<String, dynamic>>[
      for (final n in _notes)
        {
          'spent': n['spent'] == true,
          'reorged': n['reorged'] == true,
          'locked': n['locked'] == true,
          'verified': n['verified'] == true,
          'sealed': noteHasSealedSpendBytes(n),
          'address': (n['address'] ?? n['dest'])?.toString() ?? '',
          'height': n['height'],
          'amount': n['amount'],
          'nanos': n['nanos'],
          'verifiedNanos': n['verifiedNanos'],
          'kind': (n['kind'] ?? '').toString(),
          'unlockAtMs': n['unlockAtMs'],
          if (n['vaultLock'] == true) 'vaultLock': true,
          if ((n['portalId']?.toString() ?? '').isNotEmpty)
            'portalId': n['portalId'].toString(),
          if (n['lockIndex'] is int) 'lockIndex': n['lockIndex'],
          if (n['lockEpoch'] is int) 'lockEpoch': n['lockEpoch'],
          if ((n['spendTag']?.toString() ?? '').isNotEmpty)
            'spendTag': n['spendTag'].toString(),
        },
    ];
    return <String, dynamic>{
      'notes': snap,
      'needShe': amount,
      'allowBare': false,
      if (needNanos != null && needNanos.isNotEmpty) 'needNanos': needNanos,
      'cap': kMaxInputsPerSend,
      'tip': bookTip,
      'tipMs': tipTimestampMs,
      'confs': spendableConfirmations,
      'spentTags': _spentTagHex.toList(),
      'holdNanos': selectionHoldNanos(
        lockDebits: _lockDebitNanos.values,
        reservePrincipals: _reserveHeldNanos.values,
      ),
      'memo': memo,
      'dests': _spendDests(restFrame, paymentCode: paymentCode).toList(),
    };
  }

  Future<Map<String, dynamic>> _planSpendOffUi(
    String restFrame,
    String? paymentCode,
    double amount, {
    bool memo = false,
    String? needNanos,
  }) async {
    await _stampSpendTagsOffUi();
    refreshTimeLockedNotes();
    // flutter_tester's later Isolate.run nulls this closure hook on the
    // caller. The closure captured here survives that, and selection still
    // runs off this isolate. Production leaves the hook null.
    final savedSeal = debugNativeSealNote;
    // The map is built here. The closure must not capture this ledger: a pool
    // that holds a Completer cannot cross to the worker.
    final input = _spendPlanInput(
      restFrame,
      paymentCode,
      amount,
      memo: memo,
      needNanos: needNanos,
    );
    final raw = await Isolate.run(() => selectSpendNotesWire(input));
    debugSendSelectStamp = raw['stamp']?.toString() ?? '';
    debugSendSelectNanos = _selectedNanos(raw);
    if (debugNativeSealNote == null && savedSeal != null)
      debugNativeSealNote = savedSeal;
    return raw;
  }

  /// Recipient SHE the flow screen shows before a send. Same split as the post.
  Future<String?> quoteConfirmRecipientShe({
    required String restFrame,
    String? paymentCode,
    required double amount,
    String? nanosWire,
    bool memo = false,
  }) async {
    final plan = await _planSpendOffUi(
      restFrame,
      paymentCode,
      amount,
      memo: memo,
      needNanos: nanosWire,
    );
    if (plan['covered'] != true) return null;
    final batches = plan['batches'];
    if (batches is! List || batches.isEmpty) return null;
    var pay = BigInt.zero;
    for (final batch in batches) {
      if (batch is! Map) continue;
      final n = BigInt.tryParse('${batch['payNanos'] ?? ''}');
      if (n == null || n <= BigInt.zero) return null;
      pay += n;
    }
    if (pay.bitLength >= 63) return null;
    return formatSheFromNanos(pay.toInt());
  }

  /// Weight-levy quote for [amount]. Selection runs off the UI isolate.
  /// [nanosWire] is the exact nanos digit string. It wins over the SHE double
  /// so an amount above 2^53 is the same integer the selector spends.
  Future<int> quoteSendLevyUnits({
    required String restFrame,
    String? paymentCode,
    required double amount,
    bool memo = false,
    String? nanosWire,
  }) async {
    final exact = nanosWire != null && nanosWire.isNotEmpty;
    if (!exact && amount <= 0)
      return estimateSendLevyUnits(inputs: 1, memo: memo);
    final plan = await _planSpendOffUi(
      restFrame,
      paymentCode,
      amount,
      memo: memo,
      needNanos: exact ? nanosWire : null,
    );
    final fee = plan['feeShe'];
    if (fee is num && fee > 0) return (fee.toDouble() * kUnitsPerShe).round();
    return estimateSendLevyUnits(inputs: 1, memo: memo);
  }

  /// Mature rest-frame notes that a capped merge can spend.
  int _matureOwnedCount(String restFrame, {String? paymentCode}) {
    final owned = <String>{};
    for (final d in moneyDests(restFrame, paymentCode: paymentCode)) {
      if (!isDestAddress(d)) continue;
      owned.add(d);
      owned.add(payKey(d));
    }
    var n = 0;
    for (final note in _notes) {
      final addr = (note['address'] ?? note['dest'])?.toString() ?? '';
      if (addr.isEmpty || !owned.contains(addr)) continue;
      if (!_noteIsSpendable(note)) continue;
      n++;
    }
    return n;
  }

  /// A payout scan starts one capped merge. Ingest does not. A second scan
  /// waits until this run finishes, and a failure stays on the future.
  void startPayoutConsolidate(String restFrame, {String? paymentCode}) {
    if (_payoutConsolidate != null) return;
    final seed = spendSeed;
    if (seed == null || seed.length != 32) return;
    if (_matureOwnedCount(restFrame, paymentCode: paymentCode) <=
        kConsolidateAboveCount)
      return;
    _payoutConsolidate = _runPayoutConsolidate(
      restFrame,
      paymentCode: paymentCode,
      seed: seed,
    );
  }

  Future<int> _runPayoutConsolidate(
    String restFrame, {
    String? paymentCode,
    required Uint8List seed,
  }) async {
    var n = 0;
    try {
      n = await consolidateSpendableNotes(
        restFrame: restFrame,
        paymentCode: paymentCode,
        spendSeed: seed,
        publicNode: false,
      );
      _payoutConsolidateRounds += n;
    } catch (_) {
      n = 0;
    } finally {
      _payoutConsolidate = null;
    }
    return n;
  }

  /// Rounds finished by [startPayoutConsolidate], including a run that already ended.
  Future<int> finishPayoutConsolidate() async {
    final run = _payoutConsolidate;
    if (run != null) await run;
    return _payoutConsolidateRounds;
  }

  /// Merge the smallest mature notes until at most [kMaxInputsPerSend] remain.
  /// Each batch is one Flow tx. The gap is the weight-levy quote.
  Future<int> consolidateSpendableNotes({
    required String restFrame,
    String? paymentCode,
    required Uint8List spendSeed,
    SendProgress? progress,
    bool allowPublicHttp = false,
    bool publicNode = true,
    bool publicIpConsent = false,
  }) async {
    if (publicNode && !publicNodePostAllowed(consent: publicIpConsent)) {
      throw StateError(kPublicIpWaitCopy);
    }
    var rounds = 0;
    for (var guard = 0; guard < 100000; guard++) {
      if (progress?.cancelRequested == true) throw StateError('send_cancelled');
      final owned = <String>{};
      for (final d in moneyDests(restFrame, paymentCode: paymentCode)) {
        if (isDestAddress(d)) {
          owned.add(d);
          owned.add(payKey(d));
        }
      }
      final mature = <Map<String, dynamic>>[];
      for (final n in _notes) {
        final addr = (n['address'] ?? n['dest'])?.toString() ?? '';
        if (addr.isEmpty || !owned.contains(addr)) continue;
        if (!_noteIsSpendable(n)) continue;
        mature.add(n);
      }
      if (mature.length <= kConsolidateAboveCount) break;
      mature.sort(
        (a, b) => (_storedNoteShe(a) ?? 0).compareTo(_storedNoteShe(b) ?? 0),
      );
      final take = mature.sublist(0, kMaxInputsPerSend);
      var sumN = BigInt.zero;
      var sumExact = true;
      for (final n in take) {
        final exact = noteNanosExact(n);
        if (exact == null) {
          sumExact = false;
          break;
        }
        sumN += exact;
      }
      if (!sumExact || sumN <= BigInt.zero) break;
      final feeQuoted = BigInt.from(
        estimateSendLevyUnits(inputs: take.length, outputs: 2),
      );
      if (sumN <= feeQuoted) break;
      final payN = sumN - feeQuoted;
      if (payN.bitLength > 64) break;
      final src =
          (take.first['address'] ?? take.first['dest'])?.toString() ?? '';
      final dest = allocateChangeDest(
        restFrame,
        from: src,
        paymentCode: paymentCode,
      );
      progress?.bump(phase: 'prove', done: 0, total: take.length);
      await _sendManyNotes(
        notes: take,
        to: dest,
        payShe: _sheOfNanos(payN),
        payNanosWire: payN.toString(),
        restFrame: restFrame,
        paymentCode: paymentCode,
        spendSeed: spendSeed,
        allowPublicHttp: allowPublicHttp,
        publicConsent: publicIpConsent,
        progress: progress,
        proveDone: 0,
        proveTotal: take.length,
      );
      rounds++;
      if (Platform.environment['FLUTTER_TEST'] != 'true') {
        await Future<void>.delayed(const Duration(milliseconds: 40));
      }
    }
    return rounds;
  }

  /// One Flow tx. A batch spends every note in [notes]. Notes are marked spent
  /// only after the node accepts the tx. Closed until FS-1.
  Future<ShearTx> _sendManyNotes({
    required List<Map<String, dynamic>> notes,
    required String to,
    required double payShe,
    String? payNanosWire,
    required String restFrame,
    String? paymentCode,
    required Uint8List spendSeed,
    String? memo,
    bool allowPublicHttp = false,
    bool publicConsent = false,
    SendProgress? progress,
    int proveDone = 0,
    int proveTotal = 1,
  }) async {
    if (notes.isEmpty) throw StateError(kErrNoSealedNote);
    if (pool == null) throw StateError(kErrNoSealedNote);
    if (!allowPublicHttp &&
        (pool!.pinnedPublicWithoutConsent ||
            !localSendReady(pool!.baseUrl))) {
      throw StateError(kErrPublicHttp);
    }
    final src =
        (notes.first['address'] ?? notes.first['dest'])?.toString() ?? '';
    if (!isDestAddress(src)) throw ArgumentError('bad_send');
    var destTo = to;
    SilentPay? pay;
    if (isFullPaymentCode(to)) {
      pay = silentPay(to);
      if (pay == null) throw ArgumentError('bad_send');
      destTo = pay.dest;
    } else if (isShearAddress(to)) {
      if (to.trim() == restFrame.trim()) {
        destTo = currentDest(restFrame, paymentCode: paymentCode);
      } else {
        throw StateError(kErrPayIdentity);
      }
    } else if (!isDestAddress(to)) {
      throw ArgumentError('bad_send');
    }
    if (destTo == src) throw ArgumentError('same_dest');
    var inputSum = BigInt.zero;
    for (final n in notes) {
      final exact = noteNanosExact(n);
      if (exact == null) throw StateError(kErrNoSealedNote);
      inputSum += exact;
    }
    final memoOn = memo != null && memo.isNotEmpty;
    final feeUnits = estimateSendLevyUnits(
      inputs: notes.length,
      outputs: 3,
      memo: memoOn,
    );
    final fee = BigInt.from(feeUnits);
    var payUnits = sendUnitsFromWire(payNanosWire);
    if (payUnits <= BigInt.zero) {
      final scaled = payShe * kUnitsPerShe;
      if (!scaled.isFinite) throw StateError('fee_short');
      final rounded = scaled.round();
      if (rounded <= 0 || rounded > _kSafeDoubleNanos)
        throw StateError('fee_short');
      if ((rounded.toDouble() - scaled).abs() > 1e-4)
        throw StateError('fee_short');
      payUnits = BigInt.from(rounded);
    }
    var heldUnits = BigInt.zero;
    for (final n in notes) {
      heldUnits += _heldNanosOf(n, restFrame, paymentCode);
    }
    if (heldUnits > BigInt.zero) {
      final split = holdProtectedPay(
        noteNanos: inputSum,
        payNanos: payUnits,
        feeNanos: fee,
        heldNanos: heldUnits,
      );
      payUnits = split.pay;
    } else if (payUnits + fee > inputSum) {
      payUnits = inputSum - fee;
    }
    if (payUnits <= BigInt.zero || payUnits.bitLength > 64)
      throw StateError('fee_short');
    final change = inputSum - payUnits - fee;
    if (heldUnits > BigInt.zero && change < heldUnits) {
      throw StateError('fee_short');
    }
    debugLastPayNanos = payUnits;
    debugLastFeeNanos = fee;
    debugLastChangeNanos = change;
    if (change < BigInt.zero || change.bitLength > 64)
      throw StateError('fee_short');
    final payNanos = u64OnWire(payUnits);
    final changeNanos = u64OnWire(change);
    String? changeDest;
    if (change > BigInt.zero) {
      changeDest = allocateChangeDest(
        restFrame,
        from: src,
        paymentCode: paymentCode,
      );
      if (changeDest == src || changeDest == destTo)
        throw ArgumentError('same_dest');
    }
    Map<String, dynamic>? memoCt;
    if (memoOn) {
      if (pay?.shared == null) throw ArgumentError('no_shared');
      memoCt = await memoSeal(destTo, memo, pay!.shared);
    }
    final vouts = <Map<String, dynamic>>[
      {'address': destTo, 'nanos': payNanos, 'kind': 'send'},
      if (changeDest != null)
        {'address': changeDest, 'nanos': changeNanos, 'kind': 'send'},
      {'kind': 'dummy', 'nanos': 0},
    ];
    if (progress?.cancelRequested == true) throw StateError('send_cancelled');
    final sealedBuilt = await _sealFlowOffUi({
      'spendSeed': spendSeed,
      'destTo': destTo,
      'src': src,
      'changeDest': changeDest,
      'admitBase': admitBase ?? _admitBaseOf(paymentCode),
      'vouts': [for (final o in vouts) Map<String, dynamic>.from(o)],
    });
    final sealed = <Map<String, dynamic>>[
      for (final raw in (sealedBuilt['vouts'] as List))
        if (raw is Map) Map<String, dynamic>.from(raw),
    ];
    var done = proveDone;
    final total = proveTotal < notes.length ? notes.length : proveTotal;
    if (progress?.cancelRequested == true) throw StateError('send_cancelled');
    progress?.bump(phase: 'prove', done: done, total: total);
    final spend = await _fs1Spend(
      notes: notes,
      sealed: sealed,
      fee: feeUnits,
      spendSeed: spendSeed,
      memoCt: memoCt,
    );
    final vin = spend.vin;
    final proofs = spend.proofs;
    final excess = spend.excess;
    done += notes.length;
    progress?.bump(phase: 'prove', done: done, total: total);
    final posted = postedFlowBody(vin: vin, vout: sealed, proofs: proofs);
    if (progress?.cancelRequested == true) throw StateError('send_cancelled');
    if (!isBindable(src, restFrame: restFrame, paymentCode: paymentCode)) {
      throw StateError('unspendable_dest');
    }
    final postedVin = List<Map<String, dynamic>>.from(
      (posted['vin'] as List).whereType<Map>().map(
        (v) => Map<String, dynamic>.from(v),
      ),
    );
    final postedVout = List<Map<String, dynamic>>.from(
      (posted['vout'] as List).whereType<Map>().map(
        (v) => Map<String, dynamic>.from(v),
      ),
    );
    final msg = spendMessage(
      from: src,
      vout: postedVout,
      kind: 'send',
      vin: postedVin,
    );
    final shared = _stealthShared[src];
    final signed = await signSpendOffUi(<String, dynamic>{
      'spendSeed': spendSeed,
      'message': msg,
      if (shared != null) 'shared': shared,
    });
    final sig = signed['sig'] as Uint8List;
    final pub = signed['pub'] as Uint8List;
    if (progress?.cancelRequested == true) throw StateError('send_cancelled');
    progress?.bump(phase: 'broadcast', done: done, total: total);
    final wire = await flowPostHexOffUi(posted);
    // The change output already reserved [feeUnits]. A lighter one-pass fee
    // must not be written back. A heavier body is fee_short, not a vote error.
    final fs1Hex = _bytesHex(spend.fs1);
    if (!sealedFeeCovers(feeUnits, <String, dynamic>{
      'kind': 'send',
      'vin': wire['vin'],
      'vout': wire['vout'],
      if (wire['admitProof'] != null) 'admit_proof': wire['admitProof'],
      if (wire['admitProofs'] != null) 'admit_proofs': wire['admitProofs'],
      'fs1': fs1Hex,
      'anchor': spend.anchor,
    })) {
      throw StateError('fee_short');
    }
    final json = await pool!.send(
      publicConsent: publicConsent,
      from: src,
      to: destTo,
      amount: _sheOfExactNanos(payUnits.toString()) ?? payShe,
      nanosWire: payUnits.toString(),
      memoCt: memoCt,
      kind: 'send',
      change: changeDest,
      sig: _bytesHex(sig),
      spendPub: _bytesHex(pub),
      ephPub: pay?.ephPub != null ? _bytesHex(pay!.ephPub) : null,
      vin: List<dynamic>.from(wire['vin'] as List? ?? const []),
      vout: List<dynamic>.from(wire['vout'] as List? ?? const []),
      excess: _bytesHex(excess),
      admitProof: wire['admitProof'] is Map
          ? Map<String, dynamic>.from(wire['admitProof'] as Map)
          : proofs.first,
      admitProofs: wire['admitProofs'] is List
          ? List<Map<String, dynamic>>.from(
              (wire['admitProofs'] as List).whereType<Map>().map(
                (p) => Map<String, dynamic>.from(p),
              ),
            )
          : null,
      spendTag: proofs.first['spendTag'] is Uint8List
          ? _bytesHex(proofs.first['spendTag'] as Uint8List)
          : proofs.first['spendTag']?.toString(),
      fee: feeUnits,
      fs1: fs1Hex,
      anchor: spend.anchor,
    );
    if (json['ok'] != true || json['tx'] is! Map) {
      throw StateError(json['reason']?.toString() ?? 'send failed');
    }
    for (final note in notes) {
      note['spent'] = true;
      final d = (note['address'] ?? note['dest'])?.toString() ?? '';
      if (d.isEmpty) continue;
      final she = _storedNoteShe(note) ?? 0;
      final left = spendable(payKey(d)) - she;
      _spendable[payKey(d)] = left <= 1e-18 ? 0 : left;
    }
    for (var i = 0; i < sealed.length; i++) {
      final o = sealed[i];
      if ((o['kind'] as String?) == 'dummy') continue;
      final addr = o['address'] as String?;
      if (addr == null) continue;
      final ours =
          addr == src ||
          addr == changeDest ||
          isBindable(addr, restFrame: restFrame, paymentCode: paymentCode);
      if (!ours) continue;
      if (!noteIsFs1Leaf(_noteBytes(o['admitPub']), _noteBytes(o['commit'])))
        continue;
      rememberNote({
        'address': addr,
        'dest': addr,
        'kind': o['kind'] ?? 'send',
        'commit': o['commit'],
        'noteCommit': o['noteCommit'],
        'r': o['r'],
        'rEph': o['rEph'],
        'rCt': o['rCt'],
        'admitPub': o['admitPub'],
        'index': i,
        'verified': true,
        'prev': Uint8List(32),
        if (o['valueProof'] != null) 'valueProof': o['valueProof'],
        if (o['rangeProof'] != null) 'rangeProof': o['rangeProof'],
        if (o['nanos'] != null) 'nanos': o['nanos'],
        if (tryU64Units(o['nanos']) != null &&
            _sheOfExactNanos(tryU64Units(o['nanos'])!.toString()) != null)
          'amount': _sheOfExactNanos(tryU64Units(o['nanos'])!.toString()),
      });
      _proofCheckedDests.add(payKey(addr));
      final addUnits = tryU64Units(o['nanos']);
      final add = addUnits == null
          ? null
          : _sheOfExactNanos(addUnits.toString());
      if (add != null && addr != changeDest) {
        _spendable[payKey(addr)] = spendable(payKey(addr)) + add;
        _dests.add(addr);
      }
    }
    if (changeDest != null && change > BigInt.zero) {
      final changeShe = _sheOfExactNanos(change.toString());
      if (changeShe != null) {
        _spendable[changeDest] = spendable(changeDest) + changeShe;
      }
      _dests.add(changeDest);
    }
    final echoed = Map<String, dynamic>.from(json['tx'] as Map);
    echoed['amount'] = _sheOfExactNanos(payUnits.toString()) ?? payShe;
    echoed['from'] ??= src;
    final raw = ShearTx.fromJson(echoed);
    final tx = ShearTx(
      id: raw.id,
      from: raw.from,
      to: destTo,
      amount: raw.amount,
      kind: raw.kind,
      height: raw.height,
      confirmed: raw.confirmed,
      memo: memoCt != null || raw.memo,
      memoPlain: memo,
      memoCt: memoCt ?? raw.memoCt,
      change: changeDest,
    );
    _txs.add(tx);
    return tx;
  }

  /// Local multi-note send. The same hold split as [_sendManyNotes], without
  /// a proof, so a test can see the recipient, the fee, and the change.
  Future<ShearTx> _sendLocalHeldBatch({
    required String from,
    required String to,
    required double amount,
    required String restFrame,
    String? paymentCode,
    String? nanosWire,
    String? memo,
  }) async {
    final plan = await _planSpendOffUi(
      restFrame,
      paymentCode,
      amount,
      memo: memo != null && memo.isNotEmpty,
      needNanos: nanosWire,
    );
    if (plan['covered'] != true) {
      if (plan['shortFee'] == true) throw StateError('fee_short');
      throw fundsRefusal(amount);
    }
    final raw = (plan['batches'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    if (raw.length != 1) throw StateError('insufficient');
    final notes = <Map<String, dynamic>>[];
    for (final spec
        in (raw.single['notes'] as List? ?? const []).whereType<Map>()) {
      final i = spec['index'];
      if (i is! num || i < 0 || i >= _notes.length) continue;
      notes.add(_notes[i.toInt()]);
    }
    if (notes.length < 2) throw StateError('insufficient');
    var input = BigInt.zero;
    var held = BigInt.zero;
    for (final n in notes) {
      final exact = noteNanosExact(n);
      if (exact == null) throw StateError('fee_short');
      input += exact;
      held += _heldNanosOf(n, restFrame, paymentCode);
    }
    final fee = BigInt.from(
      estimateSendLevyUnits(
        inputs: notes.length,
        outputs: 3,
        memo: memo != null && memo.isNotEmpty,
      ),
    );
    var pay = sendUnitsFromWire(nanosWire);
    if (pay <= BigInt.zero) {
      final rounded = (amount * kUnitsPerShe).round();
      if (rounded > 0) pay = BigInt.from(rounded);
    }
    final split = holdProtectedPay(
      noteNanos: input,
      payNanos: pay,
      feeNanos: fee,
      heldNanos: held,
    );
    if (split.pay <= BigInt.zero || split.change < held) {
      throw StateError('fee_short');
    }
    debugLastPayNanos = split.pay;
    debugLastFeeNanos = fee;
    debugLastChangeNanos = split.change;
    final postedShe = _sheOfExactNanos(split.pay.toString()) ?? amount;
    String? changeDest;
    if (split.change > BigInt.zero) {
      changeDest = allocateChangeDest(
        restFrame,
        from: from,
        paymentCode: paymentCode,
      );
      _rememberBuiltChange(changeDest, split.change);
    }
    for (final n in notes) {
      n['spent'] = true;
    }
    final tx = ShearTx(
      id: 'send-${DateTime.now().millisecondsSinceEpoch}',
      from: from,
      to: to,
      amount: postedShe,
      kind: 'send',
      confirmed: false,
      change: changeDest,
    );
    _txs.add(tx);
    return tx;
  }

  /// One note when one note covers. Otherwise batches of at most
  /// [kMaxInputsPerSend], each batch one Flow tx.
  Future<ShearTx> sendSpendableSum({
    required String from,
    required String to,
    required double amount,
    String? memo,
    bool local = false,
    String? kind,
    String? programId,
    String? restFrame,
    String? paymentCode,
    String? choice,
    int? currentEpoch,
    int? epochStartMs,
    int? lockEpoch,
    int? unlockAtMs,
    String? change,
    Uint8List? spendSeed,
    bool allowPublicHttp = false,
    bool publicConsent = false,
    bool paintedCover = false,
    SendProgress? progress,
    String? nanosWire,
  }) async {
    final sendKind =
        kind ?? (programId == 'shear-reserve-v1' ? 'lock' : 'send');
    Future<ShearTx> once(
      double pay,
      String src, {
      Map<String, dynamic>? note,
      String? payNanos,
    }) {
      final wire = (payNanos != null && payNanos.isNotEmpty) ? payNanos : null;
      return send(
        from: src,
        to: to,
        amount: pay,
        publicConsent: publicConsent,
        memo: memo,
        local: local,
        kind: kind,
        programId: programId,
        restFrame: restFrame,
        paymentCode: paymentCode,
        choice: choice,
        currentEpoch: currentEpoch,
        epochStartMs: epochStartMs,
        lockEpoch: lockEpoch,
        unlockAtMs: unlockAtMs,
        change: change,
        spendSeed: spendSeed,
        allowPublicHttp: allowPublicHttp,
        paintedCover: paintedCover,
        progress: progress,
        spendNote: note,
        nanosWire: wire,
      );
    }

    if (sendKind != 'send' || paintedCover || restFrame == null) {
      return once(amount, from, payNanos: nanosWire);
    }
    if (local) {
      if (_matureOwnedCount(restFrame, paymentCode: paymentCode) <= 1) {
        return once(amount, from, payNanos: nanosWire);
      }
      return _sendLocalHeldBatch(
        from: from,
        to: to,
        amount: amount,
        restFrame: restFrame,
        paymentCode: paymentCode,
        nanosWire: nanosWire,
        memo: memo,
      );
    }
    if (spendSeed == null || spendSeed.length != 32 || pool == null) {
      return once(amount, from, payNanos: nanosWire);
    }
    consolidateIncomingRewards(restFrame, paymentCode: paymentCode);
    progress?.bump(phase: 'select', done: 0, total: 1);
    final plan = await _planSpendOffUi(
      restFrame,
      paymentCode,
      amount,
      memo: memo != null && memo.isNotEmpty,
      needNanos: nanosWire,
    );
    if (progress?.cancelRequested == true) throw StateError('send_cancelled');
    final rawBatches = (plan['batches'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    if (plan['covered'] != true || rawBatches.isEmpty) {
      if (plan['shortFee'] == true) throw StateError('fee_short');
      final refusal = fundsRefusal(amount);
      if (refusal.message == kErrHeaderSync) throw refusal;
      if (plan['empty'] == true) throw StateError(kErrNoSealedNote);
      throw refusal;
    }
    final batches =
        <({double pay, String payNanos, List<Map<String, dynamic>> notes})>[];
    for (final b in rawBatches) {
      final specs = (b['notes'] as List? ?? const []).whereType<Map>().toList();
      final refs = <Map<String, dynamic>>[];
      for (final spec in specs) {
        final i = spec['index'];
        if (i is! num || i < 0 || i >= _notes.length) continue;
        refs.add(_notes[i.toInt()]);
      }
      final pay = (b['pay'] as num?)?.toDouble() ?? 0;
      final payNanos = b['payNanos']?.toString() ?? '';
      if (refs.isEmpty) continue;
      if (payNanos.isEmpty && pay <= 1e-12) continue;
      batches.add((pay: pay, payNanos: payNanos, notes: refs));
    }
    if (batches.isEmpty) throw StateError('insufficient');
    if (batches.length == 1 && batches.single.notes.length == 1) {
      progress?.bump(phase: 'broadcast', done: 0, total: 1);
      final only = batches.single;
      final tx = await once(
        only.pay,
        (only.notes.single['address'] ?? only.notes.single['dest'])
                ?.toString() ??
            from,
        note: only.notes.single,
        payNanos: only.payNanos,
      );
      progress?.bump(phase: 'broadcast', done: 1, total: 1);
      return tx;
    }
    final totalProofs = batches.fold<int>(0, (s, b) => s + b.notes.length);
    ShearTx? last;
    var done = 0;
    for (final batch in batches) {
      if (progress?.cancelRequested == true) throw StateError('send_cancelled');
      if (batch.notes.length == 1) {
        progress?.bump(phase: 'prove', done: done, total: totalProofs);
        last = await once(
          batch.pay,
          (batch.notes.single['address'] ?? batch.notes.single['dest'])
                  ?.toString() ??
              from,
          note: batch.notes.single,
          payNanos: batch.payNanos,
        );
        done += 1;
        progress?.bump(phase: 'prove', done: done, total: totalProofs);
      } else {
        last = await _sendManyNotes(
          notes: batch.notes,
          to: to,
          payShe: batch.pay,
          payNanosWire: batch.payNanos,
          restFrame: restFrame,
          paymentCode: paymentCode,
          spendSeed: spendSeed,
          memo: memo,
          allowPublicHttp: allowPublicHttp,
          progress: progress,
          proveDone: done,
          proveTotal: totalProofs,
        );
        done += batch.notes.length;
      }
      if (Platform.environment['FLUTTER_TEST'] != 'true' &&
          batches.length > 1) {
        await Future<void>.delayed(const Duration(milliseconds: 40));
      }
    }
    return last!;
  }

  double _roomAfterLevy(double she) {
    var pay = she;
    for (var k = 0; k < 6; k++) {
      final fee = levyNanos((pay * kUnitsPerShe).round()) / kUnitsPerShe;
      final next = she - fee;
      if (next <= 1e-12) return 0;
      if ((next - pay).abs() < 1e-12) return next;
      pay = next;
    }
    return pay > 1e-12 ? pay : 0;
  }

  /// Notes whose individual rooms are under [amount], together covering it.
  List<({String dest, double pay})> _sumSlices(
    String restFrame,
    String? paymentCode,
    double amount,
  ) {
    final owned = moneyDests(
      restFrame,
      paymentCode: paymentCode,
    ).map(payKey).toSet();
    final rows = <({String dest, double room})>[];
    for (final n in _notes) {
      if (n['spent'] == true) continue;
      if (!_noteMature(n)) continue;
      final dest = (n['address'] ?? n['dest'])?.toString() ?? '';
      if (dest.isEmpty || !owned.contains(payKey(dest))) continue;
      final room = _roomAfterLevy(_noteSheOf(n, 0));
      if (room <= 1e-12) continue;
      rows.add((dest: dest, room: room));
    }
    if (rows.length < 2) return const [];
    rows.sort((a, b) => b.room.compareTo(a.room));
    if (rows.first.room + 1e-12 >= amount) return const [];
    final picked = <({String dest, double room})>[];
    var have = 0.0;
    for (final r in rows) {
      picked.add(r);
      have += r.room;
      if (have + 1e-12 >= amount) break;
    }
    if (have + 1e-12 < amount) return const [];
    final out = <({String dest, double pay})>[];
    var left = amount;
    for (final r in picked) {
      if (left <= 1e-12) break;
      final pay = left < r.room ? left : r.room;
      if (pay <= 1e-12) return const [];
      out.add((dest: r.dest, pay: pay));
      left -= pay;
    }
    if (left > 1e-8 || out.length < 2) return const [];
    return out;
  }

  /// Production lock. [sealSignReserveWire] funds the π leaf, the wallet FS-1
  /// prover spends the inputs, and the fund proof is bound to that body.
  Future<ShearTx> _sendSealedLock({
    required String from,
    required Uint8List spendSeed,
    required int lockEpoch,
  }) async {
    this.spendSeed ??= spendSeed;
    if (spendPub == null || spendPub!.length != 32) {
      spendPub = ed25519PublicFromSeed(spendSeed);
    }
    final client = pool;
    if (client == null) throw StateError('no_pool');
    try {
      final book = await client.reserveTrancheBook();
      final rows = book['tranches'];
      if (rows is List) rememberDerivedLockLeaves(rows);
    } catch (_) {}
    final lockIndex = _nextLockIndex();
    final cols = await _fluxColumns();
    if (cols.pubs.isEmpty || cols.commits.length != cols.pubs.length) throw StateError('fluxset');
    final picked = <Map<String, dynamic>>[];
    var have = 0;
    final need = kPiSheNanos + kLevyCapNanos + 1;
    for (final note in _notes) {
      if (note['spent'] == true) continue;
      if ((note['kind'] ?? '').toString() == 'lock') continue;
      if (!noteHasSealedSpendBytes(note)) continue;
      final units = tryU64Units(note['nanos']);
      if (units == null || units <= BigInt.zero || units.bitLength > 63) continue;
      final commit = _noteBytes(note['commit']);
      final pub = _noteBytes(note['admitPub']);
      if (commit == null) continue;
      var at = -1;
      for (var i = 0; i < cols.commits.length; i++) {
        if (_sameBytes32(cols.commits[i], commit) && (pub == null || _sameBytes32(cols.pubs[i], pub))) {
          at = i;
          break;
        }
      }
      if (at < 0 || picked.any((row) => row['index'] == at)) continue;
      picked.add({...note, 'index': at});
      have += units.toInt();
      if (picked.length >= kFs1InputMax || have >= need) break;
    }
    if (picked.isEmpty || have < need) throw StateError('insufficient');
    final top = picked.map((row) => row['index'] as int).reduce((a, b) => a > b ? a : b);
    final anchor = pickFs1Anchor(_fs1Anchors, top);
    if (anchor == null) throw StateError(kErrFs1Anchor);
    final changeSeed = lockChangeSeedOf(spendSeed, lockIndex);
    final changeDest = changeSeed == null
        ? null
        : destCommitFromSpendPub(ed25519PublicFromSeed(changeSeed));
    if (changeSeed == null || changeDest == null || changeDest.length != 20) {
      throw StateError('bad_send');
    }
    final id = 'lock-${_bytesHex(randomBytes(16))}';
    final built = sealWalletLockTx(
      spendSeed: spendSeed,
      address: from,
      lockIndex: lockIndex,
      lockEpoch: lockEpoch,
      proveHeight: 0,
      anchor: anchor.height,
      fluxNotes: fs1NotesBytes(cols.pubs, cols.commits, anchor.n),
      inputs: picked,
      inputNanos: have,
      changeDest20: changeDest,
      changeSpendSeed: changeSeed,
      id: id,
    );
    if (built == null) throw StateError('stake_reward');
    final rawTx = built['tx'];
    if (rawTx is! Map) throw StateError('stake_reward');
    final wire = _hexify(Map<String, dynamic>.from(rawTx));
    if (wire is! Map) throw StateError('bad_send');
    final ack = await client.postRaw(Map<String, dynamic>.from(wire));
    if (ack['ok'] == false) throw StateError(ack['reason']?.toString() ?? 'bad_send');
    for (final note in picked) {
      final commit = _noteBytes(note['commit']);
      if (commit == null) continue;
      for (final row in _notes) {
        final haveCommit = _noteBytes(row['commit']);
        if (haveCommit != null && _bytesEq(haveCommit, commit)) row['spent'] = true;
      }
    }
    final scalar = built['scalar'];
    final blind = built['blind'];
    final leaf = built['note'];
    final portalId = built['portalId']?.toString() ?? '';
    final unlock = built['unlock'] is int ? built['unlock'] as int : consensusUnlockPeriod(lockEpoch);
    if (scalar is Uint8List && blind is Uint8List && leaf is Uint8List && leaf.length == 64) {
      rememberNote({
        'kind': 'lock',
        'address': from,
        'dest': from,
        'scalar': scalar,
        'blind': blind,
        'note': leaf,
        'unlock': unlock,
        'amount': kPiSheNanos,
        'nanos': kPiSheNanos,
        'epochs': <int>[lockEpoch],
        'lockEpoch': lockEpoch,
        'lockIndex': lockIndex,
        'portalId': portalId,
        'dest20': built['dest20'],
        'commit': built['commit'],
        'vaultLock': true,
        'verified': true,
      });
      if (portalId.isNotEmpty) noteChainPortals([portalId]);
    }
    final change = built['change'];
    final changeN = built['changeNanos'];
    if (change is Map) {
      rememberNote({
        'address': from,
        'dest': from,
        'kind': 'send',
        'commit': change['commit'],
        'noteCommit': change['noteCommit'],
        'r': change['r'],
        'admitPub': change['admitPub'],
        if (change['rEph'] != null) 'rEph': change['rEph'],
        if (change['rCt'] != null) 'rCt': change['rCt'],
        if (change['amtCt'] != null) 'amtCt': change['amtCt'],
        'nanos': changeN,
        'spendSeed': changeSeed,
        'changeSeed': changeSeed,
        'verified': true,
        if (changeN is int && _sheOfExactNanos(changeN.toString()) != null)
          'amount': _sheOfExactNanos(changeN.toString()),
      });
    }
    lastSealedLock = Map<String, Object?>.from(built);
    return ShearTx(
      id: id,
      from: from,
      to: from,
      amount: kPiSheNanos / kUnitsPerShe,
      kind: 'lock',
      confirmed: false,
    );
  }

  /// The body [ _sendSealedLock] just posted, including the leaf opening.
  Map<String, Object?>? lastSealedLock;

  Future<ShearTx> send({
    required String from,
    required String to,
    required double amount,
    String? memo,
    bool local = false,
    String? kind,
    String? programId,
    String? restFrame,
    String? paymentCode,
    String? choice,
    int? currentEpoch,
    int? epochStartMs,
    int? lockEpoch,
    int? unlockAtMs,
    String? change,
    Uint8List? spendSeed,
    bool allowPublicHttp = false,
    bool publicConsent = false,
    bool paintedCover = false,
    SendProgress? progress,
    Map<String, dynamic>? spendNote,
    String? nanosWire,
  }) async {
    final sendKind =
        kind ?? (programId == 'shear-reserve-v1' ? 'lock' : 'send');
    if (sendKind != 'vote' && sendKind != 'roll' && amount <= 0) {
      throw ArgumentError('amount');
    }
    // A lock is one π leaf (the node refuses any other amount); a note larger
    // than that keeps the rest as hidden change in the same tx.
    if (sendKind == 'lock' && !isOnePiLeaf(amount)) throw StateError(kErrLockAmount);
    if (isShearAddress(from)) {
      throw ArgumentError('rest_frame');
    }
    var destTo = to;
    SilentPay? pay;
    if (isPaymentFingerprint(to) && sendKind == 'send') {
      throw StateError(kErrShortShe1);
    }
    if (isFullPaymentCode(to)) {
      pay = silentPay(to);
      if (pay == null) throw ArgumentError('bad_send');
      destTo = pay.dest;
    } else if (isShearAddress(to) && sendKind == 'send') {
      if (restFrame != null && to.trim() == restFrame.trim()) {
        destTo = currentDest(restFrame, paymentCode: paymentCode);
      } else {
        throw StateError(kErrPayIdentity);
      }
    } else if (!isDestAddress(to) && sendKind == 'send') {
      throw ArgumentError('bad_send');
    }
    if (isShearAddress(destTo) || isPaymentCode(destTo)) {
      throw ArgumentError('rest_frame');
    }
    if (!local &&
        pool != null &&
        !allowPublicHttp &&
        (pool!.pinnedPublicWithoutConsent ||
            !localSendReady(pool!.baseUrl))) {
      throw StateError(kErrPublicHttp);
    }
    if (sendKind == 'lock' && !local && pool != null && spendSeed != null && spendSeed.length == 32) {
      return _sendSealedLock(
        from: from,
        spendSeed: spendSeed,
        lockEpoch: lockEpoch ?? currentEpoch ?? 0,
      );
    }
    if (sendKind == 'send' && destTo == from) {
      throw ArgumentError('same_dest');
    }
    if (sendKind == 'send' && change != null && change == from) {
      throw ArgumentError('same_dest');
    }
    if (sendKind == 'send' &&
        restFrame != null &&
        (viewSecret ?? '').isNotEmpty) {
      final portal = vaultDest(restFrame, viewKey: viewSecret!);
      if (portal != null && (destTo == portal || change == portal)) {
        throw ArgumentError('portal_change');
      }
    }
    var src = from;
    if (spendSeed != null && spendSeed.length == 32) {
      this.spendSeed ??= spendSeed;
      spendPub ??= ed25519PublicFromSeed(spendSeed);
    }
    if (paymentCode != null) {
      spendPub ??= decodePaymentCode(paymentCode)?['spendPub'];
    }
    if (spendPub != null && spendPub!.length == 32) {
      if (!isBindable(src, restFrame: restFrame, paymentCode: paymentCode)) {
        src = encodeDestAddress(
          destCommitFromSpendPub(spendPub!),
          admitBase ?? _admitBaseOf(paymentCode),
        );
      }
    }
    var depth = 0;
    // Mempool depth is recorded for the pressure readout. The consensus levy
    // ignores amount and depth. The quote is the weight floor unless a sealed
    // body is passed to levyNanos. A large principal is not a larger fee.
    if (pool != null && !local && !paintedCover) {
      try {
        final pressure = await pool!.mempoolPressure();
        depth = (pressure['depth'] as num?)?.toInt() ?? 0;
      } catch (_) {}
    }
    final taxed = levyTaxed(sendKind);
    var payUnits = sendKind == 'vote'
        ? BigInt.zero
        : sendUnitsFromWire(nanosWire);
    if (payUnits <= BigInt.zero && sendKind != 'vote') {
      final rounded = (amount * kUnitsPerShe).round();
      if (rounded > 0 && rounded <= _kSafeDoubleNanos)
        payUnits = BigInt.from(rounded);
    }
    final nanos = payUnits.bitLength <= 63 ? payUnits.toInt() : 0;
    final levy = taxed ? levyNanos(nanos, depth: depth) : 0;
    // Roll keeps the vault sum. Continuum pays the levy and nothing else.
    final needShe = (sendKind == 'vote' || sendKind == 'roll' ? 0.0 : amount) + levy / kUnitsPerShe;
    if (restFrame != null && (sendKind == 'vote' || sendKind == 'lock')) {
      final home = homeDest(restFrame, paymentCode: paymentCode);
      final short = spendable(src) + 1e-12 < needShe;
      if (src == home || short) {
        if (spendableOwned(restFrame, paymentCode: paymentCode) + 1e-12 >=
            needShe) {
          src = consolidateSpendableForLock(
            restFrame,
            paymentCode: paymentCode,
            needShe: needShe,
            keepHome: sendKind == 'lock',
          );
        }
      }
    } else if (spendable(src) < needShe && restFrame != null) {
      if (spendableOwned(restFrame, paymentCode: paymentCode) >= needShe) {
        src = spendFrom(restFrame, paymentCode: paymentCode, amount: needShe);
      }
    }
    if (src != from &&
        spendable(src) + 1e-12 < needShe &&
        restFrame != null &&
        spendableOwned(restFrame, paymentCode: paymentCode) + 1e-12 >=
            needShe) {
      _moveSpendableOnto(src);
    }
    if (sendKind == 'send' &&
        restFrame != null &&
        change == null &&
        _coinLedger != null &&
        src == _coinLedger &&
        !_ownsSealedOn(src)) {
      final hopped = _hopOffMiningMailbox(
        src,
        restFrame,
        paymentCode: paymentCode,
      );
      if (hopped != src) src = hopped;
    }
    // A withdraw pays the reserve principal. Continuum spendable is not the source.
    if (!paintedCover && sendKind != 'withdraw') {
      final usable = _shownSpendable(src);
      final owned = restFrame == null
          ? usable
          : spendableOwned(restFrame, paymentCode: paymentCode);
      if (usable + 1e-12 < amount && owned + 1e-12 < amount) {
        if (sendKind == 'send') {
          _releaseUnbackedSpendable(
            src,
            restFrame: restFrame,
            paymentCode: paymentCode,
          );
        }
        throw fundsRefusal(amount);
      }
      final pk = payKey(src);
      if (usable + 1e-12 >= needShe && spendable(pk) > usable + 1e-12) {
        _spendable[pk] = usable;
      }
    }
    if (sendKind != 'withdraw' && spendable(src) < needShe) {
      var fromNotes = 0.0;
      for (final n in _notes) {
        if (n['spent'] == true) continue;
        if (n['address'] != src && n['dest'] != src) continue;
        final amt = n['amount'];
        if (amt is num) fromNotes += amt.toDouble();
      }
      if (fromNotes >= needShe) {
        _spendable[src] = fromNotes;
      }
    }
    if (sendKind != 'withdraw' && spendable(src) < amount) {
      final owned = restFrame == null
          ? spendable(src)
          : spendableOwned(restFrame, paymentCode: paymentCode);
      if (owned + 1e-12 < amount) {
        if (sendKind == 'send') {
          _releaseUnbackedSpendable(
            src,
            restFrame: restFrame,
            paymentCode: paymentCode,
          );
        }
        throw fundsRefusal(amount);
      }
    }
    Map<String, dynamic>? spent;
    Map<String, dynamic>? chosen;
    var fundedShe = spendable(src);
    if (sendKind == 'send' &&
        spendSeed != null &&
        spendSeed.length == 32 &&
        pool != null &&
        !local &&
        !paintedCover) {
      // The planner already chose this note off the UI isolate. Do not scan
      // spend tags for every other note.
      if (spendNote != null) {
        chosen = spendNote;
        final addr =
            (spendNote['address'] ?? spendNote['dest'])?.toString() ?? '';
        if (addr.isNotEmpty) src = addr;
        fundedShe = _storedNoteShe(spendNote) ?? spendable(src);
      } else {
        // Pull the pool note list when the local book has no covering note.
        await _fluxColumns();
        await _stampSpendTagsOffUi();
        Map<String, dynamic>? pick(
          String fromDest, {
          bool ignoreConfs = false,
        }) => _pickSpendNote(
          fromDest,
          needShe,
          spendSeed,
          ignoreConfs: ignoreConfs,
          amountFallback: spendable(fromDest),
        );
        void adopt(String fromDest, Map<String, dynamic> note) {
          spent = note;
          src = fromDest;
        }

        bool sealedOn(String d) => _ownsSealedOn(d);
        var hadLocal = sealedOn(src);
        if (!hadLocal && restFrame != null) {
          for (final d in moneyDests(restFrame, paymentCode: paymentCode)) {
            if (sealedOn(d)) {
              hadLocal = true;
              break;
            }
          }
        }
        final first = pick(src);
        if (first != null) {
          adopt(src, first);
        } else if (restFrame != null) {
          for (final d in moneyDests(restFrame, paymentCode: paymentCode)) {
            if (d == src) continue;
            final alt = pick(d);
            if (alt != null) {
              adopt(d, alt);
              break;
            }
          }
        }
        // Collate when the local book has no sealed note. A spend-tag reject
        // stays no_note; the book is then rebuilt from the notes still held.
        if (spent == null && !hadLocal) {
          await collateSpendNotes(
            dest: src,
            restFrame: restFrame,
            paymentCode: paymentCode,
          );
          final again = pick(src);
          if (again != null) {
            adopt(src, again);
          } else if (restFrame != null) {
            for (final d in moneyDests(restFrame, paymentCode: paymentCode)) {
              final alt = pick(d);
              if (alt != null) {
                adopt(d, alt);
                break;
              }
            }
          }
        }
        // 9 confirmations stay in force. A balance snapshot does not make a
        // young note spendable.
        // After the picker misses, the book is the notes we can actually spend
        // so Continuum does not keep claiming a cover this send cannot use.
        if (spent == null) {
          final keys = <String>{payKey(src), payKey(from)};
          if (restFrame != null) {
            for (final d in syncDests(restFrame, paymentCode: paymentCode)) {
              if (isDestAddress(d)) keys.add(payKey(d));
            }
          }
          for (final key in keys) {
            if (!isDestAddress(key)) continue;
            _spendable[key] = inventoriedNoteShe(key, sum: true);
          }
          throw StateError(hadLocal ? 'no_note' : kErrNoSealedNote);
        }
        chosen = spent;
        fundedShe = _noteSheOf(chosen!, spendable(src));
      }
    }
    String? changeDest = change;
    // Change is the note minus the pay minus the weight-floor levy.
    // A double must not round it or drop it once it no longer fits in 2^53.
    final feeUnits = BigInt.from(levy < 0 ? 0 : levy);
    final fundedUnits = sendKind == 'send'
        ? fundedSendUnits(chosen ?? spendNote, fundedShe)
        : null;
    BigInt? changeUnits;
    if (fundedUnits != null &&
        (chosen != null || spendNote != null) &&
        noteNanosExact((chosen ?? spendNote)!) != null) {
      final note = (chosen ?? spendNote)!;
      final heldUnits = _heldNanosOf(note, restFrame, paymentCode);
      if (heldUnits > BigInt.zero) {
        final split = holdProtectedPay(
          noteNanos: fundedUnits,
          payNanos: payUnits,
          feeNanos: feeUnits,
          heldNanos: heldUnits,
        );
        if (payUnits > BigInt.zero && split.pay <= BigInt.zero) {
          throw StateError('insufficient');
        }
        payUnits = split.pay;
        changeUnits = split.change;
      } else {
        final cost = payUnits + feeUnits;
        if (cost > fundedUnits) throw StateError('insufficient');
        final next = fundedUnits - cost;
        if (next.bitLength > 64) throw StateError('fee_short');
        changeUnits = next;
      }
    }
    debugLastChangeNanos = changeUnits;
    if (sendKind == 'send') {
      debugLastPayNanos = payUnits;
      debugLastFeeNanos = feeUnits;
    }
    final postedShe = sendKind == 'send'
        ? (_sheOfExactNanos(payUnits.toString()) ?? amount)
        : amount;
    if (sendKind == 'send') {
      String? portal;
      if (restFrame != null && (viewSecret ?? '').isNotEmpty) {
        portal = vaultDest(restFrame, viewKey: viewSecret!);
      }
      final leftover = fundedShe - needShe;
      final wantsChange = changeUnits != null
          ? changeUnits > BigInt.zero
          : leftover > 1e-18;
      if (wantsChange) {
        final derive = restFrame ?? src;
        if (paymentCode != null && isFullPaymentCode(paymentCode)) {
          final payChange = silentPay(paymentCode);
          changeDest ??= payChange?.dest;
          if (payChange != null)
            _stealthShared[payChange.dest] = payChange.shared;
          if (changeDest == src || changeDest == portal) {
            final again = silentPay(paymentCode);
            changeDest = again?.dest;
            if (again != null) _stealthShared[again.dest] = again.shared;
          }
        } else if ((viewSecret ?? '').isNotEmpty) {
          changeDest ??= allocateChangeDest(
            derive,
            from: src,
            portalDest: portal,
            paymentCode: paymentCode,
          );
        } else {
          throw ArgumentError('same_dest');
        }
      }
      refuseSheetChange(
        from: src,
        to: destTo,
        change: changeDest,
        portalDest: portal,
      );
      rememberSpentDest(src);
      rememberSpentDest(destTo);
      if (changeDest != null) rememberSpentDest(changeDest);
    }
    Map<String, dynamic>? memoCt;
    if (memo != null && memo.isNotEmpty) {
      if (pay?.shared == null) throw ArgumentError('no_shared');
      memoCt = await memoSeal(destTo, memo, pay!.shared);
    }
    String? sigHex;
    String? spendPubHex;
    final vouts = <Map<String, dynamic>>[
      {'address': destTo, 'nanos': u64OnWire(payUnits), 'kind': sendKind},
    ];
    if (sendKind == 'send' && changeDest != null) {
      if (changeUnits != null) {
        if (changeUnits > BigInt.zero) {
          vouts.add({
            'address': changeDest,
            'nanos': u64OnWire(changeUnits),
            'kind': 'send',
          });
        }
      } else {
        final leftoverNanos = ((fundedShe - needShe) * kUnitsPerShe).round();
        if (leftoverNanos > 0 && leftoverNanos <= _kSafeDoubleNanos) {
          vouts.add({
            'address': changeDest,
            'nanos': leftoverNanos,
            'kind': 'send',
          });
        }
      }
    }
    if (sendKind == 'send' && !vouts.any((o) => o['kind'] == 'dummy')) {
      vouts.add({'kind': 'dummy', 'nanos': 0});
    }
    List<Map<String, dynamic>> vin = [
      {'address': src},
    ];
    Map<String, dynamic>? admitProof;
    dynamic excess;
    String? fs1Hex;
    int? fs1Anchor;
    var flowFee = levy < 0 ? 0 : levy;
    if (sendKind == 'send' &&
        spendSeed != null &&
        spendSeed.length == 32 &&
        pool != null &&
        !local) {
      if (chosen == null && paintedCover) {
        final sealed = sealPaintedSpendVouts([
          for (final o in vouts) Map<String, dynamic>.from(o),
        ]);
        vouts
          ..clear()
          ..addAll(sealed);
      } else if (chosen == null) {
        throw StateError('no_note');
      }
      if (chosen != null) {
      final note = chosen!;
      if (!noteHasSealedSpendBytes(note)) throw StateError('no_note');
      // The pool weighs the sealed body, including the FS-1 proof, and refuses
      // a fee under that weight or over the cap. The proof binds the fee, so
      // the change note is sealed to the cap before the proof is built.
      final have = fundedSendUnits(note, fundedShe);
      final cap = BigInt.from(kLevyCapNanos);
      if (have != null && have >= payUnits + cap && flowFee < kLevyCapNanos) {
        final next = have - payUnits - cap;
        flowFee = kLevyCapNanos;
        final changeAt = changeDest == null
            ? -1
            : vouts.indexWhere((o) => o['kind'] == 'send' && o['address'] == changeDest);
        if (next > BigInt.zero && changeAt >= 0) {
          vouts[changeAt]['nanos'] = u64OnWire(next);
        } else if (changeAt >= 0) {
          vouts.removeAt(changeAt);
        }
      }
      final sealedBuilt = await _sealFlowOffUi({
        'spendSeed': spendSeed,
        'destTo': destTo,
        'src': src,
        'changeDest': changeDest,
        'admitBase': admitBase ?? _admitBaseOf(paymentCode),
        'vouts': [for (final o in vouts) Map<String, dynamic>.from(o)],
      });
      final sealed = <Map<String, dynamic>>[
        for (final raw in (sealedBuilt['vouts'] as List))
          Map<String, dynamic>.from(raw as Map),
      ];
      vouts
        ..clear()
        ..addAll(sealed);
      for (var i = 0; i < vouts.length; i++) {
        final o = vouts[i];
        if ((o['kind'] as String?) == 'dummy') continue;
        final addr = o['address'] as String?;
        if (addr == null || addr.isEmpty) continue;
        if (addr == src || addr == changeDest) {
          if (!noteIsFs1Leaf(_noteBytes(o['admitPub']), _noteBytes(o['commit']))) continue;
          rememberNote({
            'address': addr,
            'dest': addr,
            'kind': o['kind'] ?? 'send',
            'commit': o['commit'],
            'noteCommit': o['noteCommit'],
            'r': o['r'],
            'rEph': o['rEph'],
            'rCt': o['rCt'],
            'admitPub': o['admitPub'],
            'index': i,
            'prev': Uint8List(32),
            if (o['valueProof'] != null) 'valueProof': o['valueProof'],
            if (o['rangeProof'] != null) 'rangeProof': o['rangeProof'],
            if (o['nanos'] != null) 'nanos': o['nanos'],
            if (tryU64Units(o['nanos']) != null && _sheOfExactNanos(tryU64Units(o['nanos'])!.toString()) != null)
              'amount': _sheOfExactNanos(tryU64Units(o['nanos'])!.toString()),
          });
        }
        }
        if (progress?.cancelRequested == true)
          throw StateError('send_cancelled');
        progress?.bump(phase: 'prove', done: 0, total: 1);
        final spend = await _fs1Spend(
          notes: [note],
          sealed: vouts,
          fee: flowFee,
          spendSeed: spendSeed,
          memoCt: memoCt,
        );
        vin = spend.vin;
        excess = spend.excess;
        admitProof = spend.proofs.first;
        fs1Hex = _bytesHex(spend.fs1);
        fs1Anchor = spend.anchor;
        progress?.bump(phase: 'prove', done: 1, total: 1);
      }
    }
    List<Map<String, dynamic>> postedVin;
    final List<Map<String, dynamic>> postedVout;
    int? reserveFee;
    String? postedWithdrawId;
    String? postedWithdrawNonce;
    String? postedPortalId;
    String? postedPayoutPortalId;
    String? postedLockAuth;
    String? postedOwnerPub;
    String? postedVaultLockNote;
    if (sendKind == 'lock' || sendKind == 'vote' || sendKind == 'withdraw' || sendKind == 'roll') {
      if (spendSeed != null && spendSeed.length == 32) {
        if (!isBindable(src, restFrame: restFrame, paymentCode: paymentCode)) {
          throw StateError('unspendable_dest');
        }
      }
      final shared = _stealthShared[src];
      // Roll names the vault portal. The levy debit may sit on another dest.
      final built = await _reserveSealOffUi({
        'to': sendKind == 'roll' ? from : destTo,
        'from': sendKind == 'roll' ? from : src,
        'kind': sendKind,
        'nanos': nanos,
        'spendSeed': spendSeed,
        'shared': shared,
        'vouts': sendKind == 'roll'
            ? <Map<String, dynamic>>[]
            : <Map<String, dynamic>>[
                for (final o in vouts) Map<String, dynamic>.from(o),
              ],
        'vin': <Map<String, dynamic>>[
          for (final o in vin) Map<String, dynamic>.from(o),
        ],
        'choice': choice ?? '',
        'programId': programId ?? '',
        if (sendKind == 'lock' && lockEpoch != null) 'lockEpoch': lockEpoch,
        if (sendKind == 'lock' && unlockAtMs != null) 'unlockAtMs': unlockAtMs,
        if (sendKind == 'lock') 'lockIndex': _nextLockIndex(),
      });
      final sealed = <Map<String, dynamic>>[
        for (final raw in (built['vouts'] as List))
          if (raw is Map) Map<String, dynamic>.from(raw),
      ];
      vouts
        ..clear()
        ..addAll(sealed);
      postedVin = <Map<String, dynamic>>[
        for (final raw in (built['postedVin'] as List))
          if (raw is Map) Map<String, dynamic>.from(raw),
      ];
      postedVout = <Map<String, dynamic>>[
        for (final raw in (built['postedVout'] as List))
          if (raw is Map) Map<String, dynamic>.from(raw),
      ];
      final sig = built['sig'];
      final pub = built['pub'];
      if (sig is Uint8List) sigHex = _bytesHex(sig);
      if (pub is Uint8List) spendPubHex = _bytesHex(pub);
      // An FS-1 lock is authorised by the SAL. The identity spend key stays off the wire.
      if (sendKind == 'lock') {
        sigHex = null;
        spendPubHex = null;
      }
      final boundFee = built['fee'];
      if (boundFee is int && boundFee > 0) reserveFee = boundFee;
      if (built['id'] is String) postedWithdrawId = built['id'] as String;
      if (built['withdrawNonce'] is String) postedWithdrawNonce = built['withdrawNonce'] as String;
      if (built['portalId'] is String && (built['portalId'] as String).isNotEmpty) {
        postedPortalId = built['portalId'] as String;
      }
      if (sendKind != 'withdraw' && sendKind != 'lock' && built['payoutPortalId'] is String && (built['payoutPortalId'] as String).isNotEmpty) {
        postedPayoutPortalId = built['payoutPortalId'] as String;
      }
      if (sendKind == 'lock' && built['lockAuth'] is String) postedLockAuth = built['lockAuth'] as String;
      if (sendKind == 'lock' && built['ownerPub'] is String) postedOwnerPub = built['ownerPub'] as String;
      if (sendKind == 'lock' && built['vaultLockNote'] is String) postedVaultLockNote = built['vaultLockNote'] as String;
    } else {
      postedVin = _postedVin(vin);
      postedVout = _postedVout(vouts);
      if (spendSeed != null && spendSeed.length == 32) {
        if (!isBindable(src, restFrame: restFrame, paymentCode: paymentCode)) {
          throw StateError('unspendable_dest');
        }
        // Sign the posted C̃-only vin/vout so spendPackDigest matches the server.
        final msg = spendMessage(
          from: src,
          vout: postedVout,
          kind: sendKind,
          vin: postedVin,
        );
        final shared = _stealthShared[src];
        final signed = await signSpendOffUi(<String, dynamic>{
          'spendSeed': spendSeed,
          'message': msg,
          if (shared != null) 'shared': shared,
        });
        final sig = signed['sig'] as Uint8List;
        final pub = signed['pub'] as Uint8List;
        sigHex = _bytesHex(sig);
        spendPubHex = _bytesHex(pub);
      }
    }
    if (pool != null && !local) {
      Future<Map<String, dynamic>> postOnce() async {
        final wire = await flowPostHexOffUi(<String, dynamic>{
          'vin': postedVin,
          'vout': postedVout,
          'admitProof': admitProof,
        });
        final proof = wire['admitProof'];
        return pool!.send(
          publicConsent: publicConsent,
          from: src,
          to: destTo,
          amount: sendKind == 'vote' ? 0 : postedShe,
          memoCt: memoCt,
          kind: sendKind,
          programId: programId,
          choice: choice,
          currentEpoch: currentEpoch,
          epochStartMs: epochStartMs,
          change: sendKind == 'send' ? changeDest : null,
          sig: sigHex,
          spendPub: spendPubHex,
          ephPub: pay?.ephPub != null ? _bytesHex(pay!.ephPub) : null,
          vin: List<dynamic>.from(wire['vin'] as List? ?? const []),
          vout: List<dynamic>.from(wire['vout'] as List? ?? const []),
          excess: excess is Uint8List ? _bytesHex(excess) : excess,
          admitProof: proof is Map ? Map<String, dynamic>.from(proof) : null,
          admitProofs: fs1Hex != null && proof is Map
              ? [Map<String, dynamic>.from(proof)]
              : null,
          spendTag: admitProof?['spendTag'] is Uint8List
              ? _bytesHex(admitProof!['spendTag'] as Uint8List)
              : admitProof?['spendTag']?.toString(),
          paintedOwedNanos: paintedCover ? _paintedFundOwedNanos : 0,
          nanosWire: nanosWire,
          fee: reserveFee ?? (fs1Hex != null ? flowFee : null),
          id: postedWithdrawId,
          withdrawNonce: postedWithdrawNonce,
          portalId: postedPortalId,
          payoutPortalId: postedPayoutPortalId,
          fs1: fs1Hex,
          anchor: fs1Anchor,
          lockAuth: postedLockAuth,
          ownerPub: postedOwnerPub,
          vaultLockNote: postedVaultLockNote,
        );
      }

      Map<String, dynamic>? json;
      Object? lastErr;
      for (var attempt = 0; attempt < 3; attempt++) {
        final retryNote = chosen;
        // A stale anchor is the one reject a fresh prove can fix. C̃ changes
        // with every prove, so vin, excess, and the signature are rebuilt.
        if (attempt > 0 &&
            sendKind == 'send' &&
            spendSeed != null &&
            spendSeed.length == 32 &&
            retryNote != null &&
            fs1Hex != null) {
          final spend = await _fs1Spend(
            notes: [retryNote],
            sealed: vouts,
            fee: flowFee,
            spendSeed: spendSeed,
            memoCt: memoCt,
          );
          vin = spend.vin;
          excess = spend.excess;
          admitProof = spend.proofs.first;
          fs1Hex = _bytesHex(spend.fs1);
          fs1Anchor = spend.anchor;
          postedVin = _postedVin(vin);
          final msg = spendMessage(
            from: src,
            vout: postedVout,
            kind: sendKind,
            vin: postedVin,
          );
          final shared = _stealthShared[src];
          final signed = await signSpendOffUi(<String, dynamic>{
            'spendSeed': spendSeed,
            'message': msg,
            if (shared != null) 'shared': shared,
          });
          sigHex = _bytesHex(signed['sig'] as Uint8List);
          spendPubHex = _bytesHex(signed['pub'] as Uint8List);
        }
        json = await postOnce();
        if (json['ok'] == true && json['tx'] is Map) break;
        lastErr = _sendHumanError(
          json['reason']?.toString(),
          pool?.baseUrl,
          allowPublicHttp: allowPublicHttp,
          kind: sendKind,
        );
        final why = json['reason']?.toString() ?? '';
        if (why != 'admit' &&
            why != 'admit_membership' &&
            why != 'admit_anchor_root' &&
            why != 'admit_anchor_window')
          break;
      }
      if (json == null || json['ok'] != true || json['tx'] is! Map) {
        throw lastErr ?? StateError('send failed');
      }
      if (sendKind == 'lock') _rememberTimeLock(vouts, destTo);
      chosen?['spent'] = true;
      if (sendKind == 'lock' && _verifiedConfirmedShe(src) != null) {
        // The pool balance below is already net. Debit only when Spendable
        // shows the opened-note cap, which is the gross sum.
        _noteLockDebit(src, needShe, nanos: payUnits + BigInt.from(levy));
      }
      final echoed = Map<String, dynamic>.from(json['tx'] as Map);
      if (sendKind == 'send') {
        echoed['amount'] = postedShe;
      } else {
        echoed['amount'] ??= needShe;
      }
      echoed['from'] ??= src;
      final raw = ShearTx.fromJson(echoed);
      // wallet_api.js sets fromBalance to 0 and sends changeBalance for the
      // pool's reconstructed leftover whenever change is parked. That figure
      // is the spent output, not the other confirmed notes on this dest.
      // Debit the send from the local sum and park only this note's change.
      if (sendKind == 'send') {
        final left = spendable(src) - needShe;
        _spendable[src] = left <= 1e-18 ? 0 : left;
        if (changeUnits != null) {
          _rememberBuiltChange(changeDest, changeUnits);
        } else {
          final noteChange = fundedShe - needShe;
          _parkChange(
            src,
            changeDest,
            changeShe: noteChange > 1e-18 ? noteChange : null,
          );
        }
      } else if (sendKind != 'withdraw') {
        final reported = (json['fromBalance'] as num?)?.toDouble();
        var nextBal = reported ?? (spendable(src) - needShe);
        if (nextBal < 0) nextBal = 0;
        _spendable[src] = nextBal;
        final parkedAmt = (json['changeBalance'] as num?)?.toDouble();
        if (changeDest != null && parkedAmt != null && parkedAmt > 1e-18) {
          _spendable[src] = 0;
          _spendable[changeDest] = spendable(changeDest) + parkedAmt;
          _dests.add(changeDest);
        } else {
          _parkChange(src, changeDest, changeShe: fundedShe - needShe);
        }
      }
      final tx = ShearTx(
        id: raw.id,
        from: raw.from,
        to: destTo,
        amount: raw.amount,
        kind: raw.kind,
        height: raw.height,
        confirmed: raw.confirmed,
        memo: memoCt != null || raw.memo,
        memoPlain: memo,
        memoCt: memoCt ?? raw.memoCt,
        change: changeDest,
      );
      _txs.add(tx);
      return tx;
    }
    if (sendKind == 'lock') _rememberTimeLock(vouts, destTo);
    if (sendKind != 'withdraw') {
      final netBook = spendable(src) - needShe;
      _spendable[src] = netBook <= 1e-18 ? 0 : netBook;
      if (sendKind == 'lock' &&
          (_verifiedConfirmedShe(src) != null ||
              _spendableNanosOn(src) > BigInt.zero)) {
        // This book is already net. A confirmRound pot has no opened-note cap,
        // so the assignment above is the only cut. The cap path shows the gross
        // opened sum and needs this debit once so a 0 book cannot paint it back.
        _noteLockDebit(src, needShe, nanos: payUnits + BigInt.from(levy));
      }
      if (sendKind == 'send' && changeUnits != null) {
        _rememberBuiltChange(changeDest, changeUnits);
      } else {
        _parkChange(src, changeDest, changeShe: fundedShe - needShe);
      }
    }
    final tx = ShearTx(
      id: 'send-${DateTime.now().millisecondsSinceEpoch}',
      from: src,
      to: destTo,
      amount: sendKind == 'send' ? postedShe : amount,
      kind: kind ?? (programId == 'shear-reserve-v1' ? 'lock' : 'send'),
      confirmed: false,
      memo: memoCt != null,
      memoPlain: memo,
      memoCt: memoCt,
      change: changeDest,
    );
    _txs.add(tx);
    return tx;
  }

  void _rememberBuiltChange(String? changeDest, BigInt? changeUnits) {
    if (changeDest == null || changeDest.isEmpty) return;
    if (changeUnits == null || changeUnits <= BigInt.zero) return;
    final she = _sheOfExactNanos(changeUnits.toString());
    if (she == null || she <= 1e-18) return;
    _spendable[changeDest] = spendable(changeDest) + she;
    _dests.add(changeDest);
  }

  void _parkChange(String src, String? changeDest, {double? changeShe}) {
    if (changeDest == null || changeDest.isEmpty || changeDest == src) return;
    final leftover = spendable(src);
    if (leftover <= 1e-18) return;
    var moved = changeShe ?? leftover;
    if (moved > leftover) moved = leftover;
    if (moved <= 1e-18) return;
    final kept = leftover - moved;
    _spendable[src] = kept <= 1e-18 ? 0 : kept;
    _spendable[changeDest] = spendable(changeDest) + moved;
    _dests.add(changeDest);
  }

  /// Deprecated. Pool auto-pays ≥ π SHE to the miner ssa1 dest.
  Future<ShearTx> pullPool({
    required String login,
    required String dest,
    required double amount,
    required Uint8List seed,
  }) async {
    throw StateError('auto_payout');
    if (isShearAddress(dest) || dest.startsWith('she1')) {
      throw ArgumentError('she1');
    }
    if (!isDestAddress(dest)) throw ArgumentError('dest');
    if (!login.startsWith('she1')) throw ArgumentError('need_she1');
    final nanos = (amount * kUnitsPerShe).round();
    // dart format off
    final sig = signPoolWithdraw(seed: seed, login: login, dest: dest, nanos: nanos);
    // dart format on
    if (pool == null) throw StateError('no_pool');
    final json = await pool!.poolWithdraw(
      login: login,
      dest: dest,
      nanos: nanos,
      sig: sig,
    );
    if (json['ok'] != true) {
      throw StateError(json['reason']?.toString() ?? 'withdraw');
    }
    final raw = json['tx'];
    final map = raw is Map
        ? Map<String, dynamic>.from(raw)
        : <String, dynamic>{};
    final tx = ShearTx(
      id:
          map['id']?.toString() ??
          'pull-${DateTime.now().millisecondsSinceEpoch}',
      from: 'pool',
      to: dest,
      amount: amount,
      kind: 'pool-withdraw',
      height: (map['height'] as num?)?.toInt(),
      confirmed: false,
    );
    mergeChainTx(tx);
    return tx;
  }

  Future<Map<String, dynamic>?> fetchPendingPull(String login) async {
    if (pool == null) return null;
    final json = await pool!.pullPending(login);
    if (json['ok'] != true) return null;
    final p = json['pending'];
    if (p is Map) return Map<String, dynamic>.from(p);
    return null;
  }

  Future<ShearTx> signPendingPull({
    required String login,
    required String dest,
    required int nanos,
    required Uint8List seed,
  }) async {
    throw StateError('auto_payout');
    if (isShearAddress(dest) || dest.startsWith('she1')) {
      throw ArgumentError('she1');
    }
    if (!isDestAddress(dest)) throw ArgumentError('dest');
    if (!login.startsWith('she1')) throw ArgumentError('need_she1');
    // dart format off
    final sig = signPoolWithdraw(seed: seed, login: login, dest: dest, nanos: nanos);
    // dart format on
    if (pool == null) throw StateError('no_pool');
    final json = await pool!.poolWithdraw(
      login: login,
      dest: dest,
      nanos: nanos,
      sig: sig,
    );
    if (json['ok'] != true) {
      throw StateError(json['reason']?.toString() ?? 'withdraw');
    }
    final raw = json['tx'];
    final map = raw is Map
        ? Map<String, dynamic>.from(raw)
        : <String, dynamic>{};
    final tx = ShearTx(
      id:
          map['id']?.toString() ??
          'pull-${DateTime.now().millisecondsSinceEpoch}',
      from: 'pool',
      to: dest,
      amount: nanos / kUnitsPerShe,
      kind: 'pool-withdraw',
      height: (map['height'] as num?)?.toInt(),
      confirmed: false,
    );
    mergeChainTx(tx);
    return tx;
  }

  void replaceFromBackup({
    required String address,
    required double spendable,
    required double pending,
    required List<ShearTx> txs,
    int? destCount,
    int? destIndex,
  }) {
    _spendable[address] = spendable;
    _pending[address] = pending;
    _txs
      ..clear()
      ..addAll(txs);
    this.destCount = (destCount ?? this.destCount);
    if (this.destCount < 1) this.destCount = 1;
    this.destIndex = destIndex ?? this.destIndex;
    if (this.destIndex < 0 || this.destIndex >= this.destCount)
      this.destIndex = this.destCount - 1;
    prune();
  }
}

/// Unlock probes public seeds only after consent, with no own node and no base.
bool creditFollowProbesPublic({
  required bool ownNode,
  required String base,
  bool publicConsent = false,
}) => publicConsent && !ownNode && base.trim().isEmpty;

/// Read base for the credit-follow worker. An own node replaces the public book.
/// A public live base is not passed on without consent.
String creditFollowReadBase(ShearPoolClient? pool) {
  if (pool != null && pool.usesOwnNode) return pool.baseUrl;
  if (pool != null && pool.isPinned) {
    if (!pool.publicConsent && isPublicWalletHost(pool.baseUrl)) return '';
    return pool.baseUrl;
  }
  final live = pool?.sync?.liveBase ?? '';
  if (live.isEmpty) return '';
  if (pool?.publicConsent != true && isPublicWalletHost(live)) return '';
  return live;
}

/// Seeds the worker may probe. An own node is the only seed.
List<String> creditFollowReadSeeds(ShearPoolClient? pool) {
  if (pool != null && pool.usesOwnNode) return [pool.baseUrl];
  final consent = pool?.publicConsent == true;
  return [
    for (final s in (pool?.sync?.seeds ?? kPublicNodeSeeds))
      if (consent || !isPublicWalletHost(s)) s,
  ];
}

class ShearPoolClient {
  /// Production (no [baseUrl]) reads headers 1…tip from a live seed. Tests pin [baseUrl].
  ShearPoolClient({
    String? baseUrl,
    HttpClient? http,
    ShearReadSync? sync,
    String? userUrl,
  }) : _pinned = baseUrl,
       _ownsHttp = http == null,
       _http = http ?? _freshHttp() {
    _sync =
        sync ??
        (baseUrl == null ? ShearReadSync(http: _http, userUrl: userUrl) : null);
    pinWalletHttp(_http, allowPublic: () => _publicConsent);
  }

  /// True when this client's sockets go through the consent dial.
  bool get debugConnectPinned => walletConnectPinned(_http);

  /// The client the pool dials with. Tests set findProxy and certificate checks here.
  HttpClient get debugHttp => _http;

  static HttpClient _freshHttp() => HttpClient()
    ..connectionTimeout = const Duration(seconds: 8)
    ..idleTimeout = const Duration(seconds: 30);

  final String? _pinned;
  final bool _ownsHttp;
  HttpClient _http;
  ShearReadSync? _sync;
  String? _ownNode;
  bool _publicConsent = false;

  /// Public seeds and the public pool stay dark until this is set.
  bool get publicConsent => _publicConsent;
  set publicConsent(bool value) {
    final dropping = _publicConsent && !value;
    _publicConsent = value;
    _sync?.publicConsent = value;
    if (!value) _dropPublicLiveBase();
    if (dropping) _abandonInFlight();
  }

  /// Revoke, or a switch off the public path. Clears a public read base and
  /// drops sockets that were already open to it.
  void stopPublicReads() {
    _publicConsent = false;
    _sync?.publicConsent = false;
    _dropPublicLiveBase();
    _abandonInFlight();
  }

  void _dropPublicLiveBase() {
    final live = _sync?.liveBase;
    if (live != null && isPublicWalletHost(live)) _sync!.liveBase = null;
  }

  /// Drop the current sockets so the next post is a new connection.
  void openFreshConnection() {
    if (!_ownsHttp) return;
    _abandonInFlight();
  }

  void _abandonInFlight() {
    if (!_ownsHttp) return;
    final old = _http;
    old.close(force: true);
    _http = _freshHttp();
    pinWalletHttp(_http, allowPublic: () => _publicConsent);
    _sync?.rebindHttp(_http);
  }

  /// Reads and posts use only this node. Null returns to the public seeds.
  void useOwnNode(String? url) {
    if (url == null || url.trim().isEmpty) {
      if (_sync != null && _sync!.liveBase == _ownNode) _sync!.liveBase = null;
      _sync?.blockPublicProbe = false;
      _ownNode = null;
      return;
    }
    final parsed = parseOwnNodeUrl(url);
    if (parsed == null) {
      throw ArgumentError(ownNodeUrlError(url) ?? kOwnNodeUrlError);
    }
    _ownNode = parsed;
    if (_sync != null) {
      _sync!.liveBase = parsed;
      _sync!.blockPublicProbe = true;
    }
  }

  bool get usesOwnNode => _ownNode != null;
  final Set<int> _pinnedProven = {};
  int _pinnedTip = 0;

  ShearReadSync? get sync => _sync;
  bool get isPinned => _pinned != null;

  /// The constructed host is a public node and this client has no consent.
  /// [baseUrl] hides that host, so send refusal must not trust [baseUrl] alone.
  bool get pinnedPublicWithoutConsent {
    final raw = _ownNode ?? _pinned;
    if (raw == null || raw.isEmpty || _publicConsent) return false;
    return isPublicWalletHost(raw);
  }

  String? _pinnedGenesis;

  String? get genesisHex => _sync?.genesisHex ?? _pinnedGenesis;

  String get baseUrl {
    if (_ownNode != null) return _ownNode!;
    if (_pinned != null && (_publicConsent || !isPublicWalletHost(_pinned!)))
      return _pinned!;
    final live = _sync?.liveBase;
    if (live != null &&
        live.isNotEmpty &&
        (_publicConsent || !isPublicWalletHost(live))) {
      return live;
    }
    return kWalletDefaultSeed;
  }

  int get provenHeaders => _sync?.provenHeaders ?? _pinnedProven.length;
  int get wantedHeaders =>
      _sync?.wantedHeaders ?? (_pinnedTip < 1 ? 0 : _pinnedTip);
  bool get nodeLive => _sync != null
      ? _sync!.liveBase != null
      : _pinned != null && _pinnedTip > 0;

  /// Live chain tip from the last successful /stats (0 if never seen).
  int get liveTip => _sync?.sampledTip ?? _pinnedTip;

  String honestyText() => walletHonestyText(
    live: nodeLive,
    proven: provenHeaders,
    wanted: wantedHeaders,
    failures: _sync?.failures ?? 0,
    height: _sync?.sampledTip ?? _pinnedTip,
  );

  Future<void> followLive() async {
    if (_ownNode != null || _pinned != null) {
      await _provePinned();
      return;
    }
    await _sync?.followTip();
  }

  Future<String?> fetchGenesisHex() async {
    try {
      final batch = await _getRawFirst(const [
        '/headers?from=1&to=1',
        '/api/explorer/headers?from=1&to=1',
      ]);
      final rows = batch?['headers'];
      if (rows is List && rows.isNotEmpty && rows.first is Map) {
        final hex = (rows.first as Map)['header']?.toString() ?? '';
        if (hex.isNotEmpty) return hex.toLowerCase();
      }
    } catch (_) {}
    try {
      final hdr = await _getRawFirst(const [
        '/header?height=1',
        '/api/explorer/header?height=1',
      ]);
      final hex = hdr?['header']?.toString() ?? '';
      if (hex.isNotEmpty) return hex.toLowerCase();
    } catch (_) {}
    return null;
  }

  Future<void> _provePinned() async {
    try {
      final stats = await _getRawFirst(const ['/stats', '/api/stats']);
      if (stats == null || !isUsableTipStats(stats)) return;
      final tip = (stats['height'] as num?)?.toInt() ?? 0;
      if (tip < 1) return;
      _pinnedTip = tip;
      final genesis = await fetchGenesisHex();
      if (genesis != null &&
          genesis.isNotEmpty &&
          _pinnedGenesis != null &&
          genesis != _pinnedGenesis) {
        _pinnedProven.clear();
      }
      if (genesis != null && genesis.isNotEmpty) _pinnedGenesis = genesis;
      const page = kNodeSyncHeaderPage;
      for (var from = 1; from <= tip; from += page) {
        final to = from + page - 1 > tip ? tip : from + page - 1;
        var need = false;
        for (var h = from; h <= to; h++) {
          if (!_pinnedProven.contains(h)) {
            need = true;
            break;
          }
        }
        if (!need) continue;
        try {
          final batch = await _getRawFirst([
            '/headers?from=$from&to=$to',
            '/api/explorer/headers?from=$from&to=$to',
          ]);
          final rows = batch?['headers'];
          if (rows is List) {
            for (final row in rows) {
              if (row is! Map) continue;
              final h = (row['height'] as num?)?.toInt() ?? 0;
              final hex = row['header']?.toString() ?? '';
              if (h >= 1 && hex.isNotEmpty) _pinnedProven.add(h);
            }
          }
        } catch (_) {}
        for (var h = from; h <= to; h++) {
          if (_pinnedProven.contains(h)) continue;
          try {
            final hdr = await _getRawFirst([
              '/header?height=$h',
              '/api/explorer/header?height=$h',
            ]);
            if ((hdr?['header']?.toString() ?? '').isNotEmpty)
              _pinnedProven.add(h);
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  void close() {
    _http.close(force: true);
  }

  Future<Map<String, dynamic>> _getRaw(
    String path, {
    String? open,
    Duration? timeout,
  }) async {
    final base = baseUrl;
    if (!_publicConsent && _ownNode == null && isPublicWalletHost(base)) {
      throw StateError(kLocalNodeDownCopy);
    }
    final target = Uri.parse('$base$path');
    final req = await _http.getUrl(target);
    stampLocalRpc(req, target);
    req.followRedirects = false;
    req.maxRedirects = 0;
    if (open != null && open.isNotEmpty) {
      req.headers.set('X-Shear-Open', open);
    }
    final res = timeout == null
        ? await req.close()
        : await req.close().timeout(timeout);
    final text = timeout == null
        ? await utf8.decodeStream(res)
        : await utf8.decodeStream(res).timeout(timeout);
    if (res.statusCode >= 300 && res.statusCode < 400) {
      throw StateError('redirect');
    }
    final map = _decodePoolBody(
      res.statusCode,
      res.headers.contentType?.mimeType,
      text,
    );
    // GET fallbacks try the next path on non-2xx. HTML already threw above.
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw StateError('http_${res.statusCode}');
    }
    return map;
  }

  Future<Map<String, dynamic>?> _getRawFirst(
    List<String> paths, {
    String? open,
  }) async {
    for (final path in paths) {
      try {
        return await _getRaw(path, open: open);
      } catch (_) {}
    }
    return null;
  }

  Future<void> _ensureBase({bool? publicConsent}) async {
    if (_ownNode != null || _pinned != null) return;
    if (_sync?.liveBase != null) return;
    final allowed = publicConsent ?? _publicConsent;
    if (!allowed) return;
    await _sync?.findLiveNode();
  }

  Future<Map<String, dynamic>> _get(String path, {String? open}) async {
    await _ensureBase();
    try {
      return await _getRaw(path, open: open);
    } catch (_) {
      if (_pinned == null) _sync?.noteFailure();
      rethrow;
    }
  }

  Future<Map<String, dynamic>> _postOnce(
    String base,
    String path,
    Map<String, dynamic> body,
  ) async {
    if (!_publicConsent && _ownNode == null && isPublicWalletHost(base)) {
      throw StateError(kLocalNodeDownCopy);
    }
    final target = Uri.parse('$base$path');
    final req = await _http.postUrl(target);
    stampLocalRpc(req, target);
    req.followRedirects = false;
    req.maxRedirects = 0;
    req.persistentConnection = false;
    req.headers.contentType = ContentType.json;
    final payload = utf8.encode(jsonEncode(body));
    final dump = Platform.environment['SHEAR_DUMP_SEND'];
    if (dump != null && dump.isNotEmpty && path.contains('send')) {
      File(dump).writeAsBytesSync(payload);
    }
    req.contentLength = payload.length;
    req.add(payload);
    final res = await req.close();
    if (res.statusCode >= 300 && res.statusCode < 400) {
      await res.drain<void>();
      throw StateError('redirect');
    }
    final text = await utf8.decodeStream(res);
    return _decodePoolBody(
      res.statusCode,
      res.headers.contentType?.mimeType,
      text,
    );
  }

  /// Non-spend posts (history, register) keep the configured host.
  /// The public pool is not a substitute, and it is not a fallback unless
  /// [publicConsent] is set. A spend never uses this.
  String _nonSpendPostBase(String? url, {bool publicConsent = false}) {
    String trim(String raw) {
      final s = raw.trim();
      return s.endsWith('/') ? s.substring(0, s.length - 1) : s;
    }

    if (url != null && url.isNotEmpty) {
      if (isPublicPoolHttp(url) || isPublicWalletHost(url)) {
        if (publicConsent) return trim(url);
        return kLocalNodeRpc;
      }
      final u = Uri.tryParse(url);
      if (u != null && u.host.isNotEmpty) return trim(url);
    }
    if (publicConsent) return kPublicPoolHttp;
    return kLocalNodeRpc;
  }

  Future<Map<String, dynamic>> _post(
    String path,
    Map<String, dynamic> body, {
    bool legacyPoolSend = false,
    bool publicConsent = false,
  }) async {
    await _ensureBase(publicConsent: publicConsent);
    if (path == '/api/wallet/send') {
      return _postSpend(
        path,
        body,
        legacyPoolSend: legacyPoolSend,
        publicConsent: publicConsent,
      );
    }
    final first =
        _ownNode ??
        _pinned ??
        _nonSpendPostBase(baseUrl, publicConsent: publicConsent);
    try {
      return await _postOnce(first, path, body);
    } on FormatException {
      if (_pinned == null && _ownNode == null) _sync?.noteFailure();
      throw StateError(kErrPoolHtml);
    } on SocketException {
      if (_ownNode != null ||
          _pinned != null ||
          isPublicPoolHttp(first) ||
          !publicConsent) {
        if (_pinned == null && _ownNode == null) _sync?.noteFailure();
        if (!publicConsent && _ownNode == null && _pinned == null) {
          throw StateError(kLocalNodeDownCopy);
        }
        rethrow;
      }
      return _postOnce(kPublicPoolHttp, path, body);
    } catch (_) {
      if (_pinned == null && _ownNode == null) _sync?.noteFailure();
      rethrow;
    }
  }

  /// Spend broadcast. Nodes only, unless [legacyPoolSend] names a pool host.
  /// Connection loss tries the next node. It does not try the public pool.
  Future<Map<String, dynamic>> _postSpend(
    String path,
    Map<String, dynamic> body, {
    bool legacyPoolSend = false,
    bool publicConsent = false,
  }) async {
    final targets = nodeSendTargets(
      baseUrl,
      pinned: _ownNode ?? _pinned,
      legacyPoolSend: legacyPoolSend,
      publicConsent: publicConsent,
    );
    Object? last;
    for (final base in targets) {
      try {
        return await _postOnce(base, path, body);
      } on FormatException {
        throw StateError(kErrPoolHtml);
      } on SocketException catch (e) {
        last = e;
      } on HttpException catch (e) {
        last = e;
      } on HandshakeException catch (e) {
        last = e;
      } on TlsException catch (e) {
        last = e;
      }
    }
    if (_pinned == null && _ownNode == null) _sync?.noteFailure();
    if (!publicConsent && _ownNode == null && _pinned == null) {
      throw StateError(kLocalNodeDownCopy);
    }
    if (last != null) throw last;
    throw StateError('node not running');
  }

  /// JSON error objects (non-2xx with a reason) are returned so send mapping
  /// still sees `unsigned` / `insufficient`. HTML and other non-JSON become
  /// [kErrPoolHtml] or `http_<status>`. FormatException never leaves here.
  Map<String, dynamic> _decodePoolBody(
    int status,
    String? contentType,
    String text,
  ) {
    final trimmed = text.trimLeft();
    if (_poolBodyLooksHtml(contentType, trimmed)) {
      throw StateError('pool returned an error page (http_$status)');
    }
    if (trimmed.isEmpty) {
      if (status < 200 || status >= 300) throw StateError('http_$status');
      throw StateError('pool returned an error page (http_$status)');
    }
    Object? decoded;
    try {
      decoded = jsonDecode(trimmed);
    } on FormatException {
      decoded = null;
    }
    if (decoded is Map) return Map<String, dynamic>.from(decoded);
    if (status < 200 || status >= 300) throw StateError('http_$status');
    throw StateError('pool returned an error page (http_$status)');
  }

  bool _poolBodyLooksHtml(String? contentType, String trimmed) {
    final ct = (contentType ?? '').toLowerCase();
    if (ct.contains('text/html') || ct.contains('application/xhtml'))
      return true;
    final sample = trimmed.length > 160 ? trimmed.substring(0, 160) : trimmed;
    final low = sample.toLowerCase();
    if (low.startsWith('<!doctype') ||
        low.startsWith('<html') ||
        low.startsWith('<head') ||
        low.startsWith('<body')) {
      return true;
    }
    return low.startsWith('<') && low.contains('<html');
  }

  Future<Map<String, dynamic>> balance(String address, {String? open}) {
    final q = StringBuffer(
      '/api/wallet/balance?address=${Uri.encodeQueryComponent(address)}',
    );
    if (open != null && open.isNotEmpty) {
      q.write('&open=${Uri.encodeQueryComponent(open)}');
    }
    return _get(q.toString(), open: open);
  }

  Future<Map<String, dynamic>> history(
    String address, {
    String? viewKey,
    String? open,
  }) {
    if (viewKey != null && viewKey.isNotEmpty) {
      return _post('/api/wallet/history', {
        'address': address,
        'viewKey': viewKey,
        if (open != null && open.isNotEmpty) 'open': open,
      });
    }
    final q = StringBuffer(
      '/api/wallet/history?address=${Uri.encodeQueryComponent(address)}',
    );
    if (open != null && open.isNotEmpty) {
      q.write('&open=${Uri.encodeQueryComponent(open)}');
    }
    return _get(q.toString(), open: open);
  }

  Future<Map<String, dynamic>> explorerHistory({
    required String viewKey,
    String? address,
  }) => _post('/api/explorer/history', {
    'viewKey': viewKey,
    if (address != null) 'address': address,
  });

  Future<Map<String, dynamic>> registerView({
    required String address,
    required String viewKey,
  }) {
    final host = Uri.tryParse(baseUrl)?.host ?? '';
    if (host.isNotEmpty &&
        host != '127.0.0.1' &&
        host != 'localhost' &&
        host != '::1') {
      throw StateError('view_register_remote_blocked');
    }
    return _post('/api/wallet/register', {
      'address': address,
      'viewKey': viewKey,
    });
  }

  Future<Map<String, dynamic>> postRaw(Map<String, dynamic> body) {
    return _post('/api/wallet/send', body);
  }

  Future<Map<String, dynamic>> send({
    required String from,
    required String to,
    required double amount,
    Map<String, dynamic>? memoCt,
    String? open,
    String? sig,
    String? portalOpen,
    String? kind,
    String? programId,
    String? choice,
    int? currentEpoch,
    int? epochStartMs,
    String? change,
    String? spendPub,
    String? ephPub,
    List<dynamic>? vin,
    List<dynamic>? vout,
    dynamic excess,
    Map<String, dynamic>? admitProof,
    List<Map<String, dynamic>>? admitProofs,
    String? spendTag,
    int? fee,
    int paintedOwedNanos = 0,
    bool legacyPoolSend = false,
    bool publicConsent = false,
    String? nanosWire,
    String? id,
    String? withdrawNonce,
    String? portalId,
    String? payoutPortalId,
    String? fs1,
    int? anchor,
    String? lockAuth,
    String? ownerPub,
    String? vaultLockNote,
  }) {
    return _post('/api/wallet/send', walletSendBody(
      from: from,
      to: to,
      amount: amount,
      memoCt: memoCt,
      open: open,
      sig: sig,
      portalOpen: portalOpen,
      kind: kind,
      programId: programId,
      choice: choice,
      currentEpoch: currentEpoch,
      epochStartMs: epochStartMs,
      change: change,
      spendPub: spendPub,
      ephPub: ephPub,
      vin: vin,
      vout: vout,
      excess: excess,
      admitProof: admitProof,
      admitProofs: admitProofs,
      spendTag: spendTag,
      fee: fee,
      paintedOwedNanos: paintedOwedNanos,
      nanosWire: nanosWire,
      id: id,
      withdrawNonce: withdrawNonce,
      portalId: portalId,
      payoutPortalId: payoutPortalId,
      fs1: fs1,
      anchor: anchor,
      lockAuth: lockAuth,
      ownerPub: ownerPub,
      vaultLockNote: vaultLockNote,
    ), legacyPoolSend: legacyPoolSend, publicConsent: publicConsent);
  }

  Future<Map<String, dynamic>> fluxset() async {
    final got = await _getRawFirst(const ['/fluxset', '/api/wallet/fluxset']);
    if (got != null) return got;
    return _get('/api/wallet/fluxset');
  }

  Future<Map<String, dynamic>> notes(String address, {String? open}) async {
    final q = Uri.encodeQueryComponent(address);
    final extra = (open != null && open.isNotEmpty)
        ? '&open=${Uri.encodeQueryComponent(open)}'
        : '';
    final got = await _getRawFirst([
      '/notes?address=$q$extra',
      '/api/wallet/notes?address=$q$extra',
    ], open: open);
    if (got != null) return got;
    return _get('/api/wallet/notes?address=$q$extra', open: open);
  }

  Future<Map<String, dynamic>> mempoolPressure() =>
      _get('/api/mempoolPressure');

  Future<Map<String, dynamic>> poolWithdraw({
    required String login,
    required String dest,
    required int nanos,
    required String sig,
  }) => _post('/api/pool/withdraw', {
    'login': login,
    'dest': dest,
    'nanos': nanos,
    'sig': sig,
  });

  Future<Map<String, dynamic>> pullPending(String login) =>
      _get('/api/pool/pullPending?login=${Uri.encodeQueryComponent(login)}');

  Future<Map<String, dynamic>> stats() async {
    final got = await _getRawFirst(const ['/stats', '/api/stats']);
    if (got != null) return got;
    return _get('/api/stats');
  }

  /// Public header at height. No identity, view key, or shear1.
  /// [timeout] bounds the read so a host that accepts and stays silent
  /// cannot hold the catch-up pass.
  Future<Map<String, dynamic>> headerAt(
    int height, {
    Duration timeout = const Duration(seconds: 5),
  }) async {
    for (final path in [
      '/header?height=$height',
      '/api/explorer/header?height=$height',
    ]) {
      try {
        return await _getRaw(path, timeout: timeout);
      } on TimeoutException {
        rethrow;
      } catch (_) {}
    }
    return _get('/api/explorer/header?height=$height').timeout(timeout);
  }

  /// Public HASH_TX DAG. Used only to read continuity at a claim height.
  Future<Map<String, dynamic>> explorerDag() => _get('/api/explorer/dag');

  Future<Map<String, dynamic>> policy() => _get('/api/policy');

  /// Per-portal Reserve stake/idle/accrued. Not a public vortice.
  Future<Map<String, dynamic>> reservePortal(String dest) =>
      _get('/api/vault/reserve?dest=$dest');

  /// Every portal's matured-tranche rows. No portal id is on the query.
  Future<Map<String, dynamic>> reserveTrancheBook() =>
      _get('/api/vault/reserve?view=tranches');
}

/// Tip lines the Windows binary prints for `--print-tip`.
/// Default seeds are the local node RPC and the public node HTTP seeds.
/// A refused loopback must not hide a live same-genesis height.
Future<String> continuumTipReport({
  List<String>? seeds,
  HttpClient? http,
}) async {
  final clientHttp =
      http ?? (HttpClient()..connectionTimeout = const Duration(seconds: 8));
  final sync = ShearReadSync(
    seeds: seeds,
    jitter: Duration.zero,
    http: clientHttp,
  );
  final client = ShearPoolClient(http: clientHttp, sync: sync);
  final ledger = ShearLedger(pool: client);
  await ledger.syncTip();
  return [
    'magic=$kBookMagic',
    'followTip.liveBase=${sync.liveBase}',
    'followTip.sampledTip=${sync.sampledTip}',
    'syncTip.liveBase=${client.baseUrl}',
    'syncTip.liveTip=${client.liveTip}',
    'sealedHeight=${ledger.sealedHeight}',
    'displayHeight=${ledger.displayHeight}',
    'tipHeight=${ledger.tipHeight}',
  ].join('\n');
}

/// 20-byte dest on a lock output, as 40 hex chars. An address is not a dest20.
String? _lockDest20Hex(List<dynamic>? vout) {
  if (vout == null) return null;
  for (final o in vout) {
    if (o is! Map) continue;
    final d = o['dest20'];
    if (d is Uint8List && d.length == 20) return _bytesHex(d);
    if (d is String) {
      final hex = d.startsWith('0x') ? d.substring(2) : d;
      if (RegExp(r'^[0-9a-fA-F]{40}$').hasMatch(hex)) return hex.toLowerCase();
    }
  }
  return null;
}

Map<String, dynamic> _lockPostRow(Map<dynamic, dynamic> raw) {
  final out = <String, dynamic>{};
  for (final e in raw.entries) {
    final key = e.key.toString();
    if (key == 'address' || key == 'from' || key == 'to' || key == 'spendPub' || key == 'sig' || key == 'valueProof' || key == 'r') continue;
    final v = e.value;
    if (v is String && (v.contains('ssa1') || v.contains('she1') || v.contains('shear1'))) continue;
    out[key] = v;
  }
  return out;
}

/// Body for POST /api/wallet/send. A flow send (kind send) posts the sealed tx only:
/// no from, to, amount, nanos, change, open, or painted owed (AL-3). Its recipient must
/// carry an admit base, or there is no key to encrypt amtCt to (AL-7). A lock posts
/// portalId, dest20, vout, and the FS-1 proof, with no from, to, or spendPub.
/// Vote and withdraw keep their public-amount body. Locked leaves and vote-plan.json
/// stay on this device: this map has no lockedLeaves and no planDir.
Map<String, dynamic> walletSendBody({
  required String from,
  required String to,
  required double amount,
  Map<String, dynamic>? memoCt,
  String? open,
  String? sig,
  String? portalOpen,
  String? kind,
  String? programId,
  String? choice,
  int? currentEpoch,
  int? epochStartMs,
  String? change,
  String? spendPub,
  String? ephPub,
  List<dynamic>? vin,
  List<dynamic>? vout,
  dynamic excess,
  Map<String, dynamic>? admitProof,
  List<Map<String, dynamic>>? admitProofs,
  String? spendTag,
  int? fee,
  int paintedOwedNanos = 0,
  String? nanosWire,
  String? id,
  String? withdrawNonce,
  String? portalId,
  String? payoutPortalId,
  String? fs1,
  int? anchor,
  String? lockAuth,
  String? ownerPub,
  String? vaultLockNote,
}) {
  final flow = kind == null || kind.isEmpty || kind == 'send';
  if (flow) {
    if (admitBaseFromAddress(to) == null)
      throw StateError('send_dest_no_admit_base');
    final sealed =
        sig != null &&
        sig.isNotEmpty &&
        spendPub != null &&
        spendPub.isNotEmpty &&
        vin != null &&
        vin.isNotEmpty &&
        vout != null &&
        vout.isNotEmpty &&
        (admitProof != null || (admitProofs != null && admitProofs.isNotEmpty));
    if (!sealed) throw StateError('send_not_sealed');
    for (final o in vout) {
      if (o is Map &&
          o['kind'] != 'dummy' &&
          (o['amtCt'] == null || o['rEph'] == null || o['rCt'] == null)) {
        throw StateError('send_vout_not_wrapped');
      }
    }
    return {
      if (fee != null) 'fee': fee,
      if (memoCt != null) 'memoCt': memoCt,
      'sig': sig,
      'spendPub': spendPub,
      'vin': vin,
      'vout': vout,
      if (excess != null) 'excess': excess,
      if (admitProof != null) 'admit_proof': admitProof,
      if (admitProofs != null && admitProofs.isNotEmpty)
        'admit_proofs': admitProofs,
      if (spendTag != null && spendTag.isNotEmpty) 'spendTag': spendTag,
      if (fs1 != null && fs1.isNotEmpty) 'fs1': fs1,
      if (anchor != null && anchor > 0) 'anchor': anchor,
      if (id != null && id.isNotEmpty) 'id': id,
      if (withdrawNonce != null && withdrawNonce.isNotEmpty)
        'withdrawNonce': withdrawNonce,
    };
  }
  if (kind == 'lock') {
    final rows = vout == null
        ? null
        : <dynamic>[
            for (final o in vout)
              if (o is Map) _lockPostRow(o) else o,
          ];
    return {
      'kind': 'lock',
      if (programId != null && programId.isNotEmpty) 'programId': programId,
      if (portalId != null && portalId.isNotEmpty) 'portalId': portalId,
      if (_lockDest20Hex(rows) != null) 'dest20': _lockDest20Hex(rows),
      // A hidden lock publishes no amount. nanos 0 is the π leaf, not the coinbase.
      'nanos': 0,
      if (fee != null) 'fee': fee,
      if (vin != null) 'vin': vin,
      if (rows != null) 'vout': rows,
      if (excess != null) 'excess': excess,
      if (admitProof != null) 'admit_proof': admitProof,
      if (admitProofs != null && admitProofs.isNotEmpty) 'admit_proofs': admitProofs,
      if (spendTag != null && spendTag.isNotEmpty) 'spendTag': spendTag,
      if (fs1 != null && fs1.isNotEmpty) 'fs1': fs1,
      if (anchor != null && anchor > 0) 'anchor': anchor,
      if (id != null && id.isNotEmpty) 'id': id,
      if (lockAuth != null && lockAuth.isNotEmpty) 'lockAuth': lockAuth,
      if (ownerPub != null && ownerPub.isNotEmpty) 'ownerPub': ownerPub,
      if (vaultLockNote != null && vaultLockNote.isNotEmpty) 'vaultLockNote': vaultLockNote,
    };
  }
  return {
    'from': from,
    'to': to,
    if (nanosWire != null && nanosWire.isNotEmpty) 'nanos': nanosWire,
    if (nanosWire == null || nanosWire.isEmpty) 'amount': amount,
    if (fee != null) 'fee': fee,
    if (paintedOwedNanos > 0) 'paintedOwedNanos': paintedOwedNanos,
    if (memoCt != null) 'memoCt': memoCt,
    if (open != null && open.isNotEmpty) 'open': open,
    if (sig != null && sig.isNotEmpty) 'sig': sig,
    if (spendPub != null && spendPub.isNotEmpty) 'spendPub': spendPub,
    if (ephPub != null && ephPub.isNotEmpty) 'ephPub': ephPub,
    if (portalOpen != null && portalOpen.isNotEmpty) 'portalOpen': portalOpen,
    'kind': kind,
    if (programId != null && programId.isNotEmpty) 'programId': programId,
    if (choice != null && choice.isNotEmpty) 'choice': choice,
    if (currentEpoch != null) 'currentEpoch': currentEpoch,
    if (epochStartMs != null) 'epochStartMs': epochStartMs,
    if (change != null && change.isNotEmpty) 'change': change,
    if (vin != null) 'vin': vin,
    if (vout != null) 'vout': vout,
    if (excess != null) 'excess': excess,
    if (admitProof != null) 'admit_proof': admitProof,
    if (admitProofs != null && admitProofs.isNotEmpty)
      'admit_proofs': admitProofs,
    if (spendTag != null && spendTag.isNotEmpty) 'spendTag': spendTag,
    if (id != null && id.isNotEmpty) 'id': id,
    if (withdrawNonce != null && withdrawNonce.isNotEmpty) 'withdrawNonce': withdrawNonce,
    if (portalId != null && portalId.isNotEmpty) 'portalId': portalId,
    if (kind != 'withdraw' && payoutPortalId != null && payoutPortalId.isNotEmpty) 'payoutPortalId': payoutPortalId,
  };
}

/// Integer nanos as SHE. Eleven protocol digits, no public-frame truncation.
String exactSheFromNanos(int nanos) {
  if (nanos <= 0) return '0';
  final whole = nanos ~/ kUnitsPerShe;
  final frac = nanos % kUnitsPerShe;
  if (frac == 0) return '$whole';
  var digits = frac.toString().padLeft(11, '0');
  while (digits.endsWith('0')) {
    digits = digits.substring(0, digits.length - 1);
  }
  return '$whole.$digits';
}

/// Same verify-weight as `txVerifyWeight` in `crypto/block_budget.js`.
int _quoteVerifyWeight(Map<String, dynamic> tx) {
  if (tx['coinbase'] == true) return 0;
  final vin = tx['vin'];
  final vout = tx['vout'];
  final nIn = vin is List ? vin.length : 0;
  final nOut = vout is List ? vout.length : 0;
  final fs1 = tx['fs1'];
  if (fs1 != null && fs1 != '' && nIn >= 1 && nIn <= 8) {
    return 2 + (25 + 25 * nIn) + 23 * nOut;
  }
  var w = 2 + 40 * nIn + 23 * nOut;
  final kind = tx['kind']?.toString() ?? '';
  if (kind == 'lock' || kind == 'vote' || kind == 'withdraw' || kind == 'roll') w += 19;
  return w;
}

int _publicByteCount(Object? value, Set<Object> seen) {
  if (value == null) return 0;
  if (value is String) return utf8.encode(value).length;
  if (value is num || value is bool) return 0;
  if (value is Uint8List) return value.length;
  if (value is List) {
    if (!seen.add(value)) return 0;
    var n = 0;
    for (final item in value) {
      n += _publicByteCount(item, seen);
    }
    return n;
  }
  if (value is Map) {
    if (!seen.add(value)) return 0;
    var n = 0;
    for (final item in value.values) {
      n += _publicByteCount(item, seen);
    }
    return n;
  }
  return 0;
}

/// Weight levy of [body], raised until the fee digits are covered. No fake signature.
int _claimLevyFloor(Map<String, dynamic> body) {
  final copy = Map<String, dynamic>.from(body);
  copy.remove('fee');
  var fee = levyFromWeight(flowWeight(copy));
  if (fee > kLevyCapNanos) return kLevyCapNanos;
  copy['fee'] = fee;
  for (var step = 0; step < 8; step++) {
    final need = levyFromWeight(flowWeight(copy));
    if (need <= fee) return fee;
    if (need > kLevyCapNanos) return fee;
    fee = need;
    copy['fee'] = fee;
  }
  return fee > kLevyCapNanos ? kLevyCapNanos : fee;
}

int _feeAtRate(int peerFee, int peerWeight, int claimWeight) {
  final pw = peerWeight < 1 ? 1 : peerWeight;
  final cw = claimWeight < 1 ? 1 : claimWeight;
  if (peerFee <= 0) return 0;
  return (peerFee * cw + pw - 1) ~/ pw;
}

/// Low, Medium, and High fees for one claim, plus a custom bid.
/// Low is the cheapest mempool fee rate, medium the upper median, high the dearest.
/// Each fee is that rate times this claim's verify-weight, clamped to the levy.
/// An empty mempool prices all three at the weight floor. [she] is the exact SHE.
Map<String, dynamic> rewardClaimFeePresets({
  required Map<String, dynamic> body,
  List<Map<String, dynamic>> mempool = const [],
  int? custom,
}) {
  final weight = _quoteVerifyWeight(body);
  final bytes = _publicByteCount(body, <Object>{});
  final floor = _claimLevyFloor(body);
  final rates = <({int fee, int w, int i})>[];
  for (var i = 0; i < mempool.length; i++) {
    final tx = mempool[i];
    if (tx['coinbase'] == true) continue;
    final fee = tx['fee'];
    if (fee is! int || fee <= 0) continue;
    final w = _quoteVerifyWeight(tx);
    rates.add((fee: fee, w: w < 1 ? 1 : w, i: i));
  }
  rates.sort((a, b) {
    final left = a.fee * b.w;
    final right = b.fee * a.w;
    if (left != right) return left < right ? -1 : 1;
    return a.i.compareTo(b.i);
  });
  ({int fee, bool capped}) at(int index) {
    if (rates.isEmpty) return (fee: floor, capped: false);
    final slot = index < 0
        ? 0
        : (index >= rates.length ? rates.length - 1 : index);
    final rate = rates[slot];
    final raw = _feeAtRate(rate.fee, rate.w, weight < 1 ? 1 : weight);
    var fee = raw;
    var capped = false;
    if (fee < floor) fee = floor;
    if (fee > kLevyCapNanos) {
      fee = kLevyCapNanos;
      capped = true;
    } else if (raw > kLevyCapNanos) {
      capped = true;
    }
    return (fee: fee, capped: capped);
  }

  final n = rates.length;
  final picks = n == 0 ? [at(0), at(0), at(0)] : [at(0), at(n ~/ 2), at(n - 1)];
  const labels = [
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
  ];
  final presets = <Map<String, dynamic>>[
    for (var i = 0; i < labels.length; i++)
      {
        'id': labels[i][0],
        'label': labels[i][1],
        'fee': picks[i].fee,
        'she': exactSheFromNanos(picks[i].fee),
        'capped': picks[i].capped,
      },
  ];
  Map<String, dynamic> customRow;
  if (custom == null) {
    customRow = {
      'id': 'custom',
      'label': 'Custom',
      'fee': null,
      'she': null,
      'ok': true,
    };
  } else {
    final legal = custom >= floor && custom <= kLevyCapNanos;
    customRow = {
      'id': 'custom',
      'label': 'Custom',
      'fee': custom < 0 ? null : custom,
      'she': custom < 0 ? null : exactSheFromNanos(custom),
      'ok': legal,
      if (!legal) 'reason': 'levy',
    };
  }
  return {
    'weight': weight < 1 ? 1 : weight,
    'bytes': bytes,
    'floor': floor,
    'cap': kLevyCapNanos,
    'presets': presets,
    'custom': customRow,
  };
}

/// Reward-claim body plus Low / Medium / High and a custom fee.
/// Each preset's `she` is the exact cost. [fee] is the custom bid.
/// [preset] `low`, `medium`, or `high` selects that quote for the tx.
/// A legal custom bid wins over [preset]. The weight floor is the default.
/// Continuum does not render these buttons yet.
Map<String, dynamic> rewardClaimSendBody({
  required String to,
  required Object nanos,
  required String nullifier,
  required List<dynamic> proof,
  required List<dynamic> vout,
  int? fee,
  String? id,
  String? preset,
  List<Map<String, dynamic>> mempool = const [],
}) {
  final draft = <String, dynamic>{
    'kind': 'reward-claim',
    'programId': 'shear-reserve-v1',
    'mint': true,
    'to': to,
    'nanos': nanos,
    'nullifier': nullifier,
    'proof': proof,
    'vin': const <dynamic>[],
    'vout': vout,
    if (id != null && id.isNotEmpty) 'id': id,
  };
  final quote = rewardClaimFeePresets(
    body: draft,
    mempool: mempool,
    custom: fee,
  );
  final presets = (quote['presets'] as List).cast<Map<String, dynamic>>();
  final custom = quote['custom'] as Map<String, dynamic>;
  int chosen = quote['floor'] as int;
  final named = presets.where((row) => row['id'] == preset);
  if (fee != null && custom['ok'] == true && custom['fee'] is int) {
    chosen = custom['fee'] as int;
  } else if (named.isNotEmpty) {
    chosen = named.first['fee'] as int;
  }
  draft['fee'] = chosen;
  return {'tx': draft, ...quote, 'bytes': _publicByteCount(draft, <Object>{})};
}
