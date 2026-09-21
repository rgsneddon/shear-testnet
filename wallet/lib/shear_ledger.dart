import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'shear_ctf.dart';
import 'shear_identity.dart';
import 'shear_eip712.dart';
import 'shear_levy.dart';
import 'shear_read_sync.dart';
import 'shear_ed25519.dart';
import 'shear_pack.dart';
import 'shear_admit.dart';
import 'shear_native_prove.dart';
import 'shear_note.dart';
import 'shear_ristretto.dart';
import 'shear_tip_tick.dart';

const kSheDecimals = 11;
const kShePublicDigits = 9;
const kUnitsPerShe = 100000000000; // 10^11
/// Fingerprint pot (BLOCK_SUBSIDY_NANOS / NANOS_PER_SHE). Continuum display only; do not mint from this.
const kBlockPotShe = 1.0;
/// Fingerprint target interval (TARGET_BLOCK_INTERVAL_MS). Continuum display only.
const kTargetBlockIntervalMs = 90000;
/// 0.00000000001 SHE per valid hash.
const kHashBonusShe = 0.00000000001;
const kHashBonusVoteDeltaShe = 0.00000000001;

/// Pending receive / pool-withdraw (height < 1) must not drive full history+notes+memoOpen.
bool pendingReceiveThinPoll(Iterable<ShearTx> txs) => txs.any((t) =>
    (t.kind == 'pool-withdraw' || t.kind == 'receive') && (t.height ?? 0) < 1);

/// Full syncCredits only after confirm/timeout; thin tip/balance while pending.
/// First unlock collate must still run even if a pending receive already exists.
bool shouldFullSyncCredits({
  required bool hasPendingReceive,
  required bool historyBehindTip,
  bool openCollatePending = false,
}) {
  if (openCollatePending) return true;
  if (hasPendingReceive) return false;
  return historyBehindTip;
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

/// Pure CPU scan of compacted vouts. Full-sync calls this via [Isolate.run].
/// Returns `{notes, hashFolds}` maps — no ledger mutation.
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
  final txHints = <Map<String, dynamic>>[
    for (final raw in (input['txHints'] as List? ?? const []))
      if (raw is Map) Map<String, dynamic>.from(raw),
  ];
  final dest = input['dest'] as String?;
  final prevIn = input['prev'];
  final prev = prevIn == null
      ? null
      : (prevIn is Uint8List
          ? prevIn
          : Uint8List.fromList(List<int>.from(prevIn as List)));
  final startIndex = (input['startIndex'] as num?)?.toInt() ?? 0;
  final xBase = admitBaseScalar(spendSeed);
  final notes = <Map<String, dynamic>>[];
  final hashFolds = <Map<String, dynamic>>[];
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
      if (d20 != null && noteBytesEq(nc, noteCommitOfDest20(d20))) matched = dest;
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
    if (matched == null) continue;
    final commitHex = _bytesHex(commit);
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
    final admit = _noteBytes(o['admitPub']);
    if (admit != null) {
      try {
        final want = pointBytes(admitPub(admitScalarFromSeed(spendSeed, {
          'kind': (o['kind'] as String?) ?? 'pot',
          'noteCommit': nc,
          'commit': commit,
        })));
        if (!noteBytesEq(want, admit)) continue;
      } catch (_) {
        continue;
      }
    }
    final kind = (o['kind'] as String?) ?? 'pot';
    num? amt = o['amount'] as num?;
    if (amt == null && o['nanos'] is num) {
      amt = (o['nanos'] as num) / kUnitsPerShe;
    }
    if (amt == null) {
      final vp = o['valueProof'];
      if (vp is Map && vp['v'] is num) {
        amt = (vp['v'] as num) / kUnitsPerShe;
      }
    }
    if (amt == null) {
      final h = (o['height'] as num?)?.toInt();
      for (final t in txHints) {
        if (h != null && (t['height'] as num?)?.toInt() != h) continue;
        if (t['to'] != matched) continue;
        final tk = t['kind']?.toString() ?? '';
        final same = tk == kind
            || (kind == 'pot' && tk == 'coinbase')
            || (kind == 'hash' && tk == 'hash');
        if (!same) continue;
        amt = t['amount'] as num?;
        break;
      }
    }
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
    });
    seenHex.add(commitHex);
    if (kind == 'hash' && amt != null && !seenCommit) {
      hashFolds.add({
        'matched': matched,
        'she': amt.toDouble(),
        'height': (o['height'] as num?)?.toInt() ?? 0,
      });
    }
  }
  return {'notes': notes, 'hashFolds': hashFolds};
}

/// Pure history-row parse + optional memoOpen. Full-sync via [Isolate.run].
Future<Map<String, dynamic>> parseHistoryPayload(Map<String, dynamic> input) async {
  final amountsOnly = input['amountsOnly'] == true && input['destProof'] != true;
  if (amountsOnly) {
    return {'amountsOnly': true, 'txs': <Map<String, dynamic>>[], 'dests': <String>[], 'named': false};
  }
  final key = input['key']?.toString() ?? '';
  final openMemos = input['openMemos'] == true;
  final existingPlain = <String, String>{
    for (final e in (input['existingPlain'] as Map? ?? {}).entries)
      e.key.toString(): e.value.toString(),
  };
  final vaults = <String>{...List<String>.from(input['vaultDests'] as List? ?? const [])};
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
    if (v['commit'] != null) row['commit'] = v['commit'];
    return row;
  }).toList();
}

List<Map<String, dynamic>> _postedVout(List<Map<String, dynamic>> vouts) {
  return vouts.map(compactSealedVout).toList();
}

String formatShe(num she) {
  if (!she.isFinite) return '0.000000000';
  final trunc = (she * 1e9).truncateToDouble() / 1e9;
  if (trunc == 0 && she != 0) {
    final s = formatHashBonusShe((she.abs() * kUnitsPerShe).round());
    return she < 0 ? '-$s' : s;
  }
  final s = trunc.toStringAsFixed(kShePublicDigits);
  if (RegExp(r'^-?\d+\.000000000$').hasMatch(s)) return trunc.truncate().toString();
  return s;
}

/// Full nano SHE (`*.***********`). Do not use [formatShe] for the hashbonus banner.
const kErrNoteSpent = 'that note was already spent';
const kErrRangeProof = 'range proof failed';
const kErrPublicHttp = 'node not running — sends would use the public node and show your IP';
const kErrSyncTip = 'node not at tip — wait for sync';
const kErrSendGeneric = 'not sent - try again';
const kErrShortShe1 = 'paste full she1 from Receive (not fingerprint)';

/// Flow send catch: map known failures; keep generic for unknown.
String flowSendAdvisoryOf(Object error) {
  final msg = error.toString();
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
  return kErrSendGeneric;
}

/// Submit snack that keeps the reason body. Hop-fee pay uses this so a pool
/// rejection is not collapsed to [kErrSendGeneric].
String hopFeeAdvisoryOf(Object error) {
  if (error is StateError) {
    final m = error.message.trim();
    return m.isEmpty ? kErrSendGeneric : m;
  }
  if (error is ArgumentError) {
    final m = error.message?.toString().trim() ?? '';
    if (m.isNotEmpty) return m;
  }
  var msg = error.toString().trim();
  const prefixes = <String>[
    'Bad state: ',
    'Invalid argument(s): ',
    'Exception: ',
  ];
  for (final p in prefixes) {
    if (msg.startsWith(p)) {
      msg = msg.substring(p.length).trim();
      break;
    }
  }
  return msg.isEmpty ? kErrSendGeneric : msg;
}

/// Public alias of [_sendHumanError] for unit tests.
StateError sendHumanError(
  String? reason,
  String? baseUrl, {
  bool hopUp = false,
  bool allowPublicHttp = false,
}) =>
    _sendHumanError(
      reason,
      baseUrl,
      hopUp: hopUp,
      allowPublicHttp: allowPublicHttp,
    );

StateError _sendHumanError(
  String? reason,
  String? baseUrl, {
  bool hopUp = false,
  bool allowPublicHttp = false,
}) {
  final why = (reason == null || reason.trim().isEmpty) ? 'send failed' : reason.trim();
  if (why == 'admit_link_tag' || why == 'admit') {
    return StateError(kErrNoteSpent);
  }
  if (why == 'range_proof' || why == 'commit_sum') return StateError(kErrRangeProof);
  final url = baseUrl ?? '';
  // Hop up, or an explicit public-HTTP allow (hop fee, confirmed unprivate),
  // keeps the server reason. Do not rewrite those to the IP-leak advisory.
  if (url.contains('pool.shear.digital') && !hopUp && !allowPublicHttp) {
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
bool keepLocalOwnerHistory({required bool amountsOnly, required bool destProof}) =>
    amountsOnly && destProof != true;

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
      kind == 'coinbase' || kind == 'blockfound' || kind == 'block' || kind == 'pot' || kind == 'mine';

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
      memoCt: j['memoCt'] is Map ? Map<String, dynamic>.from(j['memoCt'] as Map) : null,
      rounds: (j['rounds'] as num?)?.toInt(),
      hashAmount: (j['hashAmount'] as num?)?.toDouble() ??
          (kind == 'hash' && amount > 0 ? amount : null),
      threads: (j['threads'] as num?)?.toInt(),
      pot: (j['pot'] as num?)?.toDouble(),
      change: j['change']?.toString(),
      atMs: (j['atMs'] as num?)?.toInt() ??
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
    kind == 'blockfound' || kind == 'coinbase' || kind == 'block' || kind == 'pot' || kind == 'mine';

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
  if (kind == 'hash' || kind == 'send' || kind == 'receive' || kind == 'claim') {
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
    isFlowTransfer(t) || t.kind == 'pool-withdraw' || t.kind == 'blockfound' || t.kind == 'coinbase';

bool isReservePendingKind(ShearTx t) => t.kind == 'lock' || t.kind == 'vote';

/// Continuum pending pie remark. Sender: sending. Recipient: receive.
String continuumPendingRemark(ShearTx t, {required bool outgoing}) {
  if (t.kind == 'send') return 'sending';
  if (t.kind == 'pool-withdraw') return outgoing ? 'sending' : 'receiving';
  if (t.kind == 'receive') return outgoing ? 'sending' : 'receive';
  return walletTxLabel(t);
}

/// Shearview kind after 1 conf. Pending remarks drop at 6: sent / received.
String shearviewKindLabel(ShearTx t, {required bool outgoing, required int confs}) {
  if (t.kind == 'pool-withdraw') {
    if (confs >= ShearLedger.continuumConfirmations) return outgoing ? 'sent' : 'received';
    return outgoing ? 'sending' : 'receiving';
  }
  if (!isFlowTransfer(t)) return walletTxLabel(t);
  if (confs >= ShearLedger.continuumConfirmations) return outgoing ? 'sent' : 'received';
  return outgoing ? 'sending' : 'receiving';
}

/// Owner ShearView list: height, status, sums. Never blank amount for the owner.
String shearviewListTitle(ShearTx t, {required int confs, required bool outgoing}) {
  final kind = shearviewKindLabel(t, outgoing: outgoing, confs: confs);
  final h = t.height ?? 0;
  if (h < 1) return 'pending  $kind  ${formatShe(t.amount)} SHE';
  final pending = confs >= 1 && confs < ShearLedger.continuumConfirmations;
  final status = pending ? 'pending  $kind' : kind;
  return 'h=$h  $status  ${formatShe(t.amount)} SHE';
}

/// Owner ShearView list: from/to, date, snippet. Never blank dest for the owner.
String shearviewListSubtitle(ShearTx t, {int? tipMs, int? tipHeight, required int confs}) {
  final from = t.from.isEmpty ? '—' : t.from;
  final to = t.to.isEmpty ? '—' : t.to;
  return '$from → $to  ${shearviewDate(t, tipMs: tipMs, tipHeight: tipHeight)}  ${shearviewSnippet(t)}';
}

String shearviewDate(ShearTx t, {int? tipMs, int? tipHeight}) {
  final ms = t.atMs;
  if (ms != null && ms > 0) {
    return DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true).toIso8601String();
  }
  final h = t.height ?? 0;
  if (tipMs != null && tipHeight != null && h > 0 && tipHeight >= h) {
    final est = tipMs - (tipHeight - h) * kTargetBlockIntervalMs;
    if (est > 0) return DateTime.fromMillisecondsSinceEpoch(est, isUtc: true).toIso8601String();
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
  if (t.kind == 'blockfound' || t.kind == 'coinbase' || t.kind == 'block') return 'block landing';
  return t.kind;
}

/// Fold per-hash / pot / mine rows into one block row per dest+height.
/// Open-round hashes (no height) are not a block yet and are omitted.
List<ShearTx> rollupExplorerTxs(Iterable<ShearTx> txs) {
  final rest = <ShearTx>[];
  final blocks = <String, ({String dest, int height, double pot, double hash, int threads})>{};
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
      final prev = blocks[key] ?? (dest: dest, height: height, pot: 0.0, hash: 0.0, threads: 0);
      var pot = prev.pot;
      var hash = prev.hash;
      var threads = prev.threads;
      final amt = t.amount;
      if (kind == 'hash') {
        hash += amt;
        threads += t.threads ?? 0;
      } else if (kind == 'mine' || kind == 'blockfound' || kind == 'block') {
        pot += amt - (t.hashAmount ?? 0);
        hash += t.hashAmount ?? 0;
        threads += t.threads ?? t.rounds ?? 0;
      } else {
        pot += amt;
      }
      blocks[key] = (dest: dest, height: height, pot: pot, hash: hash, threads: threads);
      continue;
    }
    rest.add(t);
  }
  for (final b in blocks.values) {
    rest.add(ShearTx(
      id: b.dest.isEmpty ? 'blockfound:${b.height}' : 'blockfound:${b.height}:${b.dest}',
      from: 'coinbase',
      to: b.dest,
      amount: b.pot + b.hash,
      kind: 'blockfound',
      height: b.height,
      confirmed: true,
      hashAmount: b.hash,
      threads: b.threads > 0 ? b.threads : null,
      pot: b.pot > 0 ? b.pot : null,
    ));
  }
  return rest;
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
class ShearLedger {
  ShearLedger({this.pool});

  final ShearPoolClient? pool;
  final Map<String, double> _spendable = {};
  /// Owned sealed notes (commit, noteCommit, r, prev, index, admit x). Reserve vault excepted.
  final List<Map<String, dynamic>> _notes = [];
  List<Map<String, dynamic>> get notes => List.unmodifiable(_notes);
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
      };

  void _applySealedScan(Map<String, dynamic> out) {
    final notes = out['notes'];
    if (notes is List) {
      for (final n in notes) {
        if (n is Map) {
          final row = Map<String, dynamic>.from(n);
          rememberNote(row);
          _creditNoteToShearview(row);
        }
      }
    }
    final folds = out['hashFolds'];
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
        _txs.add(ShearTx(
          id: id,
          from: 'coinbase',
          to: matched,
          amount: she,
          kind: 'blockfound',
          height: h,
          confirmed: h < 1 || confirmationsOf(h) >= spendableConfirmations,
          hashAmount: she,
        ));
      }
      if (h > 0) {
        _immature.add((dest: matched, amount: she, height: h));
      }
    }
  }

  /// Turn an unwrapped dest-owned note into a ShearView row so open collate
  /// does not wait for a later history/incoming delta. Hash folds stay in
  /// [_applySealedScan]. Existing dest+height rows are filled, not duplicated.
  void _creditNoteToShearview(Map<String, dynamic> note) {
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
        ? _bytesHex(commit).substring(0, commit.length < 8 ? commit.length * 2 : 16)
        : '${dest.hashCode}';
    final existing = _txs.indexWhere((t) {
      if (t.to != dest) return false;
      if ((t.height ?? 0) != (h ?? 0)) return false;
      if (isBlock) return isWalletBlockKind(t.kind);
      return t.kind == 'receive' || t.kind == kind || t.kind == 'send';
    });
    final id = existing >= 0
        ? _txs[existing].id
        : (isBlock && h != null && h > 0
            ? 'blockfound:$h:$dest'
            : (h != null && h > 0 ? 'note:$h:$dest:$tag' : 'note-pending:$dest:$tag'));
    var atMs = _headerTimestampMs;
    if (atMs != null && h != null && h > 0 && _sealedHeight >= h) {
      atMs = atMs - (_sealedHeight - h) * kTargetBlockIntervalMs;
    } else if (h == null || h < 1) {
      atMs = null;
    }
    mergeChainTx(ShearTx(
      id: id,
      from: isBlock ? 'coinbase' : (note['from']?.toString() ?? 'pending'),
      to: dest,
      amount: amt.toDouble(),
      kind: isBlock ? 'blockfound' : (kind == 'send' ? 'receive' : kind),
      height: h,
      confirmed: h != null && h > 0 && confirmationsOf(h) >= spendableConfirmations,
      atMs: atMs,
    ));
  }

  /// Scan compacted vouts (chain persist drops r). Match noteCommit to dest20, unwrap rEph/rCt.
  /// Tests call this synchronously; the 1 Hz/full-sync path uses [Isolate.run] on [scanSealedVouts].
  void ingestSealedVouts(
    List<dynamic> vouts, {
    required Uint8List spendSeed,
    String? dest,
    Uint8List? prev,
    int startIndex = 0,
  }) {
    _applySealedScan(scanSealedVouts(_sealedScanInput(
      vouts,
      spendSeed: spendSeed,
      dest: dest,
      prev: prev,
      startIndex: startIndex,
    )));
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
  /// Last height whose open-round pending was settled. Display [sealedHeight]
  /// can run ahead (1s tip poll); settlement uses this so confirmRound still
  /// fires after syncTip.
  int _settledHeight = 0;
  final Map<String, int> _historyAt = {};
  final Map<String, int> _notesAt = {};
  /// First unlock notes-then-history collate finished. Thin pending-receive
  /// ticks must not skip that first full pull.
  bool _openCollated = false;
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

  /// Last known sealed tip from shewall. Never apply 0 over a remembered height.
  void restoreSealedTip(int height, {String? genesis}) {
    if (genesis != null && genesis.trim().isNotEmpty) restoreChainGenesis(genesis);
    final h = height;
    if (h < 1) return;
    if (h > _sealedHeight) _sealedHeight = h;
    if (h + 1 > tipHeight) tipHeight = h + 1;
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
    _notes.clear();
    _pending.clear();
    _immature.clear();
    _owedPiDisplay = 0;
    _historyAt.clear();
    _notesAt.clear();
    _openCollated = false;
    _sealedHeight = 0;
    _settledHeight = 0;
    lag1Root = null;
    tipHeight = 1;
  }

  int? _headerTimestampMs;
  int? _prevHeaderTimestampMs;
  /// Network circulating supply from pool /api/stats. Continuum Integral Q.
  int? circulatingNanos;
  /// Network-wide stats from /api/stats (Continuum right-hand box).
  int? networkHashrate;
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
    final live = pool?.liveTip ?? 0;
    return live > _sealedHeight ? live : _sealedHeight;
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

  Path1Observation path1Observation() => foldSealedPots(
        _txs,
        observedIntervalMs: observedIntervalMs,
      );

  /// Last height Continuum already settled into spendable.
  int get settledHeight => _settledHeight;
  /// Consensus floor: 6 confirmations. Operator lock — do not change; flag them.
  static const spendableConfirmations = 6;
  /// Continuum pie lifetime matches consensus spendable.
  static const continuumConfirmations = 6;
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
    _advanceSealed(sealedHeight);
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
      settleTo(_sealedHeight);
      return;
    }
    tipHeight = sealedHeight + 1;
    if (sealedHeight > _sealedHeight) _sealedHeight = sealedHeight;
    if (prev > 0 && sealedHeight > prev) {
      _bundleOpenRounds(height: prev + 1);
    }
    settleTo(sealedHeight);
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
    if (_isProgramVaultDest(address) || _isProgramVaultDest(payKey(address))) return 0;
    return _spendable[payKey(address)] ?? _spendable[address] ?? 0;
  }

  /// Per-dest pending, or the wallet total when [address] is a rest-frame / she1.
  /// Money dests are destCommit(spendPub) and stealth dests in [_stealthShared].
  double pending(String address, {String? paymentCode}) {
    if (isDestAddress(address)) return _pending[address] ?? 0;
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
    return n;
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
    _txs.add(ShearTx(
      id: id,
      from: 'hash',
      to: dest,
      amount: amount,
      kind: 'hash',
      confirmed: false,
    ));
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
    if (ephPub != null && paymentCode != null && (viewSecret ?? '').isNotEmpty) {
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
    _pending[key] = (_pending[key] ?? 0) + amount;
    _dests.add(key);
    final tx = ShearTx(
      id: id ?? 'recv-pending-$key-${_txs.length}',
      from: from ?? 'pending',
      to: key,
      amount: amount,
      kind: 'receive',
      confirmed: false,
    );
    _txs.add(tx);
    return tx;
  }

  void _applyPoolHashPending(String address, double hashAmount) {
    final key = payKey(address);
    // Only the still-open round. Height-stamped receives are Continuum pie
    // rows, not live pending — recounting them refilled pending() after tip.
    final recv = _txs
        .where((t) =>
            !t.confirmed &&
            t.kind == 'receive' &&
            (t.height ?? 0) < 1 &&
            (t.to == key || t.from == key || t.to == address))
        .fold<double>(0, (n, t) => n + t.amount);
    _pending[key] = recv + hashAmount;
    if (key != address) _pending[address] = 0;
    _upsertHashPending(key, hashAmount);
  }

  /// Merge a chain/history row onto a local tx (same id, or a height-less
  /// pool-withdraw to the same dest and amount). Height and kind come from
  /// the node — never invented.
  void mergeChainTx(ShearTx tx) {
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
          _txs.add(ShearTx(
            id: id,
            from: 'coinbase',
            to: tx.to,
            amount: she,
            kind: 'blockfound',
            height: h,
            confirmed: confirmationsOf(h) >= spendableConfirmations,
            hashAmount: she,
            atMs: tx.atMs,
          ));
        }
        rememberDest(tx.to);
      }
      return;
    }
    var i = _txs.indexWhere((t) => t.id == tx.id);
    if (i < 0 && tx.kind == 'pool-withdraw') {
      i = _txs.indexWhere((t) =>
          t.kind == 'pool-withdraw' &&
          (t.height ?? 0) < 1 &&
          t.to == tx.to &&
          (t.amount - tx.amount).abs() < 1e-9);
    }
    if (i >= 0) {
      final prev = _txs[i];
      final nextHeight = (tx.height ?? 0) > (prev.height ?? 0) ? tx.height : prev.height;
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
      return;
    }
    if (tx.kind == 'receive' && (tx.height ?? 0) < 1 && !tx.confirmed) {
      creditReceive(to: tx.to, amount: tx.amount, from: tx.from, id: tx.id);
      return;
    }
    _txs.add(tx);
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
    mergeChainTx(ShearTx(
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
    ));
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
      mergeChainTx(ShearTx(
        id: id,
        from: row['from']?.toString() ?? (kind == 'pool-withdraw' ? 'pool' : 'pending'),
        to: to,
        amount: amount,
        kind: kind == 'pool-withdraw' ? 'pool-withdraw' : 'receive',
        height: height,
        confirmed: row['confirmed'] == true,
      ));
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
    final existing = _txs.cast<ShearTx?>().firstWhere((t) => t!.id == roundId, orElse: () => null);
    if (existing != null) {
      if (height > _sealedHeight) _sealedHeight = height;
      settleTo(_sealedHeight);
      prune();
      return existing;
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
    final hashBonus = hashPendingOf(dest) + (dest == address ? 0 : hashPendingOf(address));
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
    settleTo(_sealedHeight);
    prune();
    return tx;
  }

  /// Confirmations of a sealed height, counting the including block as 1.
  /// Uses [displayHeight] so a receive at the live tip is not hidden while
  /// paint lags one block behind the node.
  int confirmationsOf(int height, [int? tip]) {
    final t = tip ?? displayHeight;
    if (height < 1 || t < height) return 0;
    return t - height + 1;
  }

  /// Hash bonus on verified dests at ≥ 6 confirmations. Display only; no claim.
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
    creditsFrozen = json['frozen'] == true;
    final op = json['operational'];
    if (op is Map && op['pool_merchant'] is num) {
      confirmedNeed = (op['pool_merchant'] as num).toInt();
    }
    freezeReason = json['freeze_reason']?.toString() ?? '';
    freezeBanner = json['freeze_banner']?.toString() ?? '';
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
    if (blankFork) vaultLockedNanos = 0;
  }

  /// Disconnect orphaned heights; rows bounce to pending.
  void bounceHeights(Iterable<int> heights) {
    final drop = heights.toSet();
    for (var i = 0; i < _txs.length; i++) {
      final h = _txs[i].height ?? 0;
      if (!drop.contains(h)) continue;
      final t = _txs[i];
      if (t.confirmed) {
        _spendable[t.to] = (_spendable[t.to] ?? 0) - t.amount;
      }
      _txs[i] = t.copyWith(confirmed: false);
      _immature.add((dest: t.to, amount: t.amount, height: h));
    }
    prune();
  }

  /// Move immature credits into spendable once the committing block is accepted.
  void settleTo(int tip) {
    if (tip > _sealedHeight) _sealedHeight = tip;
    final keep = <({String dest, double amount, int height})>[];
    for (final row in _immature) {
      if (!creditsFrozen && confirmationsOf(row.height, tip) >= spendableConfirmations) {
        _spendable[row.dest] = (_spendable[row.dest] ?? 0) + row.amount;
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
      if (!creditsFrozen && confirmationsOf(h, tip) >= spendableConfirmations) {
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
          t.kind != 'pool-withdraw') continue;
      if (!seen.add(t.id)) continue;
      next.add(t);
    }
    _txs
      ..clear()
      ..addAll(next);
  }

  void rememberSpendable(String address, double amount) {
    if (amount > spendable(address)) _spendable[address] = amount;
  }

  Future<void> syncTip() async {
    if (pool == null) return;
    try {
      await pool!.followLive().timeout(kWalletTipTimeout);
      final json = await pool!.stats();
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
      final sealed = (json['height'] as num?)?.toInt() ?? 0;
      final hex = json['header']?.toString() ?? '';
      final genesis = pool!.genesisHex ?? await pool!.fetchGenesisHex();
      if (genesis != null && genesis.isNotEmpty) bindChainGenesis(genesis);
      if (isUsableTipStats(json)) {
        applyTipHex(hex, sealedHeight: sealed);
      } else {
        applyTipHex('', sealedHeight: 0);
      }
      final raw = json['networkAvgBlockTimeMs'] ?? json['avgBlockTimeMs'];
      final avg = raw is num ? raw.round() : int.tryParse('$raw');
      if (avg != null && avg >= 0) applyAvgBlockTimeMs(avg);
      final circ = json['circulatingNanos'];
      if (circ is num && circ >= 0) circulatingNanos = circ.round();
      void take(String k, void Function(int) set) {
        final v = json[k];
        if (v is num && v >= 0) set(v.round());
      }
      take('hashrate', (n) => networkHashrate = n);
      take('hashBonusNanos', (n) => liveHashBonusNanos = n);
      take('extraMintedNanos', (n) => extraMintedNanos = n);
      take('mintBankNanos', (n) => extraMintedNanos = n);
      if (blankFork) {
        vaultLockedNanos = 0;
      } else {
        take('lockedNanos', (n) => vaultLockedNanos = n);
        if (json['reserveVaultNanos'] is num) {
          vaultLockedNanos = (json['reserveVaultNanos'] as num).round();
        }
      }
      take('potEmittedNanos', (n) => potEmittedNanos = n);
      take('hashBonusEmittedNanos', (n) => hashBonusEmittedNanos = n);
      take('bits', (n) => networkBits = n);
      take('blockBits', (n) => networkBits = n);
      take('miners', (n) => networkMiners = n);
    } catch (_) {}
  }

  Future<double> syncSpendable(String address) async {
    final prev = spendable(address);
    if (pool == null) return prev;
    try {
      final before = _settledHeight;
      await syncTip();
      final json = await pool!.balance(address);
      applyPoolSnapshot(address, json, beforeHeight: before, tipSealed: _sealedHeight);
      _markSettled(_sealedHeight, before);
      await syncHistory(address);
      return spendable(address);
    } catch (_) {
      return prev;
    }
  }

  double _noteSpendable(String dest) {
    var n = 0.0;
    for (final note in _notes) {
      if (note['spent'] == true) continue;
      if (note['address'] != dest && note['dest'] != dest) continue;
      final amt = note['amount'];
      if (amt is! num) continue;
      final h = (note['height'] as num?)?.toInt();
      if (h != null && h > 0 && confirmationsOf(h) < spendableConfirmations) continue;
      n += amt.toDouble();
    }
    return n;
  }

  double spendableOwned(String restFrame, {String? paymentCode}) {
    spendPub ??= decodePaymentCode(paymentCode ?? '')?['spendPub'];
    _dropProgramVaults();
    var n = 0.0;
    for (final d in ownedAddresses(restFrame, paymentCode: paymentCode)) {
      if (_isProgramVaultDest(d)) continue;
      final mapped = _spendable[d] ?? 0;
      final notes = _noteSpendable(d);
      n += mapped >= notes ? mapped : notes;
    }
    return n;
  }

  /// Dest that actually holds reconstructed credits for a spend.
  /// Only dests [isBindable] accepts for the signing key. destAtIndex is not a money path.
  String spendFrom(String restFrame, {String? paymentCode, required double amount}) {
    final dests = moneyDests(restFrame, paymentCode: paymentCode).toList();
    for (final d in dests) {
      if (spendable(d) >= amount) return d;
    }
    return dests.isNotEmpty ? dests.first : currentDest(restFrame, paymentCode: paymentCode);
  }

  /// Light dests for a pool pull. Bindable money dests only.
  /// she1 / shear1 / destAtIndex are never queried as pay dests.
  Set<String> syncDests(String restFrame, {String? paymentCode}) {
    final keys = moneyDests(restFrame, paymentCode: paymentCode);
    if (isDestAddress(restFrame) && isBindable(restFrame, restFrame: restFrame, paymentCode: paymentCode)) {
      keys.add(restFrame);
    }
    return keys;
  }

  /// Pool snapshot → ledger (unlock / Continuum path).
  ///
  /// Reconstructed [balance] is already-confirmed spendable at the tip, including
  /// first boot when local sealed height was 0. Open-round [pending] + [incoming]
  /// stay pending until sealed height advances by one from a known height.
  void applyPoolSnapshot(
    String address,
    Map<String, dynamic> json, {
    required int beforeHeight,
    required int tipSealed,
  }) {
    _ingestIncoming(json);
    final owed = json['owedPi'] ?? json['confirmingPot'];
    if (owed is num && owed >= 0) _owedPiDisplay = owed.toDouble();
    if (!isDestAddress(address)) return;
    _applyPoolHashPending(address, (json['pending'] as num?)?.toDouble() ?? 0);
    if (beforeHeight > 0 && tipSealed > beforeHeight) {
      confirmRound(address: address, pot: 0, height: beforeHeight + 1);
      settleTo(tipSealed);
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
      _spendable[key] = live;
    }
  }

  /// Pull Continuum from the silent mining dest and current Flow dest.
  /// Mining credits land on the silent dest. Do not query every historical dest.
  Future<double> syncCredits(String restFrame, {String? paymentCode, bool openMemos = false}) async {
    if (pool == null) {
      _openCollated = true;
      return spendableOwned(restFrame, paymentCode: paymentCode);
    }
    keepOwnedDests(restFrame, paymentCode: paymentCode);
    final before = _settledHeight;
    try {
      await syncTip();
    } catch (_) {}
    final dests = syncDests(restFrame, paymentCode: paymentCode);
    for (final d in dests) {
      if (!isDestAddress(d)) continue;
      try {
        final json = await pool!.balance(d);
        applyPoolSnapshot(d, json, beforeHeight: before, tipSealed: _sealedHeight);
      } catch (_) {}
    }
    _markSettled(_sealedHeight, before);
    final histSeen = <String>{};
    for (final d in dests) {
      final key = payKey(d);
      if (!histSeen.add(key)) continue;
      if (_notesAt[key] == _sealedHeight) continue;
      final seed = spendSeed;
      if (seed != null && seed.length == 32 && pool != null) {
        try {
          final json = await pool!.notes(key);
          final rows = json['notes'];
          if (rows is List) {
            if (rows.isEmpty) {
              _notesAt[key] = _sealedHeight;
            } else {
              final raw = _sealedScanInput(rows, spendSeed: seed, dest: key);
              final input = <String, dynamic>{
                'vouts': jsonDecode(jsonEncode(_hexify(raw['vouts']))),
                'dests': List<String>.from(raw['dests'] as List? ?? const []),
                'dest': raw['dest'],
                'spendSeed': seed,
                'seenCommitHex': List<String>.from(raw['seenCommitHex'] as List? ?? const []),
                'txHints': jsonDecode(jsonEncode(raw['txHints'])),
                'prev': raw['prev'],
                'startIndex': raw['startIndex'],
              };
              final scanned = await Isolate.run(() => scanSealedVouts(input));
              _applySealedScan(scanned);
              _notesAt[key] = _sealedHeight;
            }
          }
        } catch (_) {}
      }
    }
    histSeen.clear();
    for (final d in dests) {
      final key = payKey(d);
      if (!histSeen.add(key)) continue;
      try {
        await syncHistory(key, openMemos: openMemos);
      } catch (_) {}
    }
    _openCollated = true;
    return spendableOwned(restFrame, paymentCode: paymentCode);
  }

  /// Thin poll: tip + dest balances only. No history, notes, or memoOpen.
  Future<double> syncBalancesOnly(String restFrame, {String? paymentCode}) async {
    if (pool == null) return spendableOwned(restFrame, paymentCode: paymentCode);
    keepOwnedDests(restFrame, paymentCode: paymentCode);
    final before = _settledHeight;
    try {
      await syncTip();
    } catch (_) {}
    final dests = syncDests(restFrame, paymentCode: paymentCode);
    for (final d in dests) {
      if (!isDestAddress(d)) continue;
      try {
        final json = await pool!.balance(d);
        applyPoolSnapshot(d, json, beforeHeight: before, tipSealed: _sealedHeight);
      } catch (_) {}
    }
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

  Future<List<ShearTx>> syncHistory(String address, {bool openMemos = false}) async {
    if (pool == null) return ownerHistory(address);
    final key = payKey(address);
    if (_historyAt[key] == _sealedHeight && !needsHistoryRefresh) {
      return ownerHistory(address);
    }
    try {
      final json = await pool!.history(address, open: destProofOpen(homeDest(address)));
      final rows = (json['txs'] as List?) ?? const [];
      final existingPlain = <String, String>{
        for (final t in _txs)
          if (t.memoPlain != null && t.memoPlain!.isNotEmpty) t.id: t.memoPlain!,
      };
      final input = <String, dynamic>{
        'amountsOnly': json['amountsOnly'] == true,
        'destProof': json['destProof'] == true,
        'key': key,
        'openMemos': openMemos,
        'existingPlain': Map<String, String>.from(existingPlain),
        'vaultDests': _vaultDests.toList(),
        'rows': jsonDecode(jsonEncode([
          for (final row in rows)
            if (row is Map) Map<String, dynamic>.from(row),
        ])),
      };
      final parsed = await Isolate.run(() => parseHistoryPayload(input));
      if (keepLocalOwnerHistory(
        amountsOnly: json['amountsOnly'] == true || parsed['amountsOnly'] == true,
        destProof: json['destProof'] == true,
      )) {
        return ownerHistory(address);
      }
      final txs = <ShearTx>[
        for (final raw in (parsed['txs'] as List? ?? const []))
          if (raw is Map) ShearTx.fromJson(Map<String, dynamic>.from(raw)),
      ].where((tx) =>
          (tx.to.isNotEmpty || tx.from.isNotEmpty) &&
          (tx.amount > 0 || (tx.hashAmount ?? 0) > 0)).toList();
      adoptLiveHistory(key, txs);
      for (final tx in txs) {
        if (payKey(tx.to) == key && tx.to.isNotEmpty && !_isProgramVaultDest(tx.to)) {
          _dests.add(tx.to);
        }
        mergeChainTx(tx);
      }
      // Empty live history with a known credit is a miss (node stall on a
      // new block) — retry next poll instead of freezing Shearview.
      final named = parsed['named'] == true;
      if (named || spendable(key) <= 0) {
        _historyAt[key] = _sealedHeight;
      }
    } catch (_) {}
    prune();
    return ownerHistory(address);
  }

  /// Dests this shear1 wallet has seen. Encrypted session stores these locally.
  List<String> exportedDests() =>
      _dests.where(isDestAddress).where((d) => !_isProgramVaultDest(d)).toList();

  void restoreDests(Iterable<String> dests) {
    for (final d in dests) {
      rememberDest(d);
    }
  }

  /// Drop dests that are not bindable money dests for this wallet.
  void keepOwnedDests(String restFrame, {String? paymentCode}) {
    final allow = moneyDests(restFrame, paymentCode: paymentCode);
    if (isDestAddress(restFrame)) allow.add(restFrame);
    final drop = _dests.where((d) => !allow.contains(d) && d != restFrame && !_stealthShared.containsKey(d)).toList();
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
      final raw = _continuityBytes(json['continuity']?.toString() ?? json['continuityRoot']?.toString() ?? '');
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
    if (paymentCode != null && isFullPaymentCode(paymentCode)) return paymentCode;
    final pub = spendPub;
    final v = viewSecret;
    if (pub != null && pub.length == 32 && v != null && v.isNotEmpty) {
      return paymentCodeAtIndex(v, pub, 0);
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
      if (a == null || a.isEmpty || !isDestAddress(a) || _isProgramVaultDest(a)) return;
      if (_isIndexedDest(a, restFrame)) return;
      if (pub != null && pub.length == 32) {
        if (isBindable(a, restFrame: restFrame, paymentCode: paymentCode)) keys.add(a);
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

  /// Local rest-frame credits were stored on destForLogin before spendPub was
  /// known. Fold them onto destCommit so the signed dest matches the key.
  void _foldFlowDest(String restFrame, {String? paymentCode}) {
    final pub = _spendPubOf(paymentCode);
    if (pub == null || pub.length != 32) return;
    final bound = encodeDestAddress(destCommitFromSpendPub(pub), _admitBaseOf(paymentCode));
    final flow = destForLogin(
      restFrame,
      height: tipHeight,
      continuityRoot: lag1Root,
      viewKey: viewSecret,
    );
    if (flow == null || flow == bound || _stealthShared.containsKey(flow)) return;
    if (destMatchesSpendPub(flow, pub)) return;
    final s = _spendable.remove(flow) ?? 0;
    final p = _pending.remove(flow) ?? 0;
    var moved = s != 0 || p != 0;
    for (var i = 0; i < _txs.length; i++) {
      final t = _txs[i];
      if (t.to != flow && t.from != flow) continue;
      _txs[i] = ShearTx(
        id: t.id,
        from: t.from == flow ? bound : t.from,
        to: t.to == flow ? bound : t.to,
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
    if (!moved) return;
    if (s != 0) _spendable[bound] = (_spendable[bound] ?? 0) + s;
    if (p != 0) _pending[bound] = (_pending[bound] ?? 0) + p;
    _dests.remove(flow);
    _dests.add(bound);
  }

  String? destAt(String restFrame, int index) {
    final v = viewSecret;
    if (v == null || v.isEmpty) return null;
    final hit = destAtIndex(restFrame, index: index, viewKey: v);
    if (hit != null) return hit;
    final spend = hash20FromAddress(restFrame);
    if (spend == null) return null;
    return encodeDestAddress(indexedDestHash(
      spendHash20: spend,
      closure: closureCommit(v),
      index: index,
    ));
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
      return encodeDestAddress(destCommitFromSpendPub(pub), _admitBaseOf(paymentCode));
    }
    return destForLogin(restFrame, height: tipHeight, continuityRoot: lag1Root, viewKey: viewSecret) ??
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

  String _freshStealthDest(String restFrame, {String? paymentCode, String? from, String? portalDest}) {
    final code = _ownPaymentCode(restFrame, paymentCode: paymentCode);
    if (code != null) {
      for (var i = 0; i < 24; i++) {
        final pay = silentPay(code);
        if (pay == null) continue;
        if (pay.dest == from || pay.dest == portalDest || _isProgramVaultDest(pay.dest)) continue;
        _stealthShared[pay.dest] = pay.shared;
        _dests.add(pay.dest);
        return pay.dest;
      }
    }
    return currentDest(restFrame, paymentCode: paymentCode);
  }

  /// Continuum receive: always a newly derived ssa1. Two receives → two dests.
  String allocateReceiveDest(String restFrame, {String? paymentCode}) =>
      newDest(restFrame, paymentCode: paymentCode);

  /// Send change to a newly derived stealth dest. Never [from] and never the Reserve portal.
  String allocateChangeDest(String restFrame, {String? from, String? portalDest, String? paymentCode}) {
    if (_ownPaymentCode(restFrame, paymentCode: paymentCode) == null) {
      throw ArgumentError('same_dest');
    }
    for (var i = 0; i < 24; i++) {
      final d = _freshStealthDest(restFrame, paymentCode: paymentCode, from: from, portalDest: portalDest);
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
        .where((t) =>
            t.kind != 'sample' &&
            (t.confirmed ||
                t.kind == 'send' ||
                t.kind == 'pool-withdraw' ||
                t.kind == 'blockfound' ||
                t.kind == 'coinbase'))
        .toList();
  }

  List<ShearTx> _ownedRolled(String address) {
    final keys = ownedAddresses(address);
    final mine = _txs.where((t) {
      if (t.kind == 'sample') return false;
      return keys.contains(t.to) ||
          keys.contains(t.from) ||
          ((t.from == 'hash' || t.from == 'coinbase' || t.from == 'pending' || t.from == 'pool') &&
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
      return openingForDest(from: dest, restFrame: rest, viewKey: view, destCount: destCount);
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
      if ((t.height ?? 0) < 1) return false;
      final mine = payKey(t.to) == key || t.to == key || payKey(t.from) == key || t.from == key;
      if (!mine) {
        if ((t.from == 'coinbase' || t.from == 'pool' || t.kind == 'block' || t.kind == 'blockfound') &&
            !liveIds.contains(t.id)) {
          return true;
        }
        return false;
      }
      if (liveIds.contains(t.id)) return false;
      if (t.kind == 'send' && !t.confirmed && (t.height ?? 0) < 1) return false;
      return true;
    });
  }

  bool isOutgoingTx(String address, ShearTx t) {
    return ownedAddresses(address).contains(t.from);
  }

  /// Dedicated explorer list. Owner view: every landing (amount, dest, status)
  /// from 1 conf — never explorerRowPublic blanks. Hash sits inside the block row.
  /// Height-less pending owner rows belong here too (open collate + live append).
  List<ShearTx> shearviewTxs(String address) {
    final rows = _ownedRolled(address).where((t) {
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
        return !t.confirmed &&
            (t.kind == 'receive' ||
                t.kind == 'send' ||
                t.kind == 'pool-withdraw' ||
                isOwnerLanding(t));
      }
      final confs = confirmationsOf(h);
      if (isOwnerLanding(t)) return confs >= 1;
      return confs >= continuumConfirmations;
    }).toList();
    rows.sort((a, b) => (b.height ?? 0).compareTo(a.height ?? 0));
    return rows;
  }

  /// Pool-custodial pot still confirming toward π auto-pay, plus in-flight
  /// pool-withdraw landings. Display only — not Continuum spendable.
  double owedTowardPi(String restFrame, {String? paymentCode}) {
    var n = _owedPiDisplay;
    for (final t in pendingTxs(restFrame)) {
      if (t.kind == 'pool-withdraw') n += t.amount;
      final pot = t.pot ?? 0;
      if (pot > 0) n += pot;
    }
    return n;
  }

  double _owedPiDisplay = 0;

  List<ShearTx> shearviewSearch(String address, String query) {
    return shearviewTxs(address).where((t) => shearviewMatches(t, query)).toList();
  }

  /// Continuum: full blocks still filling the 6-slice pie, plus in-flight
  /// send/receive/pool-withdraw. Hash rewards never list on their own — they sit in the block.
  List<ShearTx> pendingTxs(String address) {
    final rows = _ownedRolled(address).where((t) {
      if (t.kind == 'hash' || t.kind == 'sample') return false;
      if (!t.confirmed && (t.kind == 'send' || t.kind == 'pool-withdraw' || t.kind == 'lock' || t.kind == 'vote')) return true;
      final h = t.height ?? 0;
      if (h < 1) return t.kind == 'receive' && !t.confirmed;
      return confirmationsOf(h) < continuumConfirmations;
    }).toList();
    rows.sort((a, b) => (b.height ?? 0).compareTo(a.height ?? 0));
    return rows;
  }

  /// Principal + interest from The Reserve, paid to a Continuum dest.
  ShearTx creditReserve({
    required String to,
    required double amount,
    int? height,
  }) {
    if (amount <= 0) throw ArgumentError('amount');
    if (isShearAddress(to)) throw ArgumentError('rest_frame');
    final key = payKey(to);
    _spendable[key] = spendable(key) + amount;
    _dests.add(key);
    final tx = ShearTx(
      id: 'reserve-${DateTime.now().millisecondsSinceEpoch}',
      from: 'shear-reserve-v1',
      to: key,
      amount: amount,
      kind: 'reserve',
      height: height,
      confirmed: true,
    );
    _txs.add(tx);
    return tx;
  }

  final Set<String> _spentTagHex = {};

  String? _noteSpendTagHex(Uint8List spendSeed, Map<String, dynamic> note) {
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

  Future<List<Uint8List>> _fluxsetPubs() async {
    if (pool == null) return const [];
    try {
      final live = await pool!.fluxset();
      _spentTagHex.clear();
      final tags = live['spendTags'];
      if (tags is List) {
        for (final t in tags) {
          if (t is String && t.isNotEmpty) {
            _spentTagHex.add(t.toLowerCase());
          } else {
            final b = _noteBytes(t);
            if (b != null && b.isNotEmpty) _spentTagHex.add(_bytesHex(b));
          }
        }
      }
      final raw = live['pubs'];
      if (raw is! List) return const [];
      return raw
          .map((p) => _noteBytes(p))
          .whereType<Uint8List>()
          .where((p) => p.length == 32)
          .toList();
    } catch (_) {
      return const [];
    }
  }

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
    String? change,
    Uint8List? spendSeed,
    bool privacyHopUp = false,
    bool allowPublicHttp = false,
  }) async {
    final sendKind = kind ?? (programId == 'shear-reserve-v1' ? 'lock' : 'send');
    if (sendKind != 'vote' && amount <= 0) throw ArgumentError('amount');
    if (isShearAddress(from) || isShearAddress(to)) {
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
    } else if (!isDestAddress(to) && sendKind == 'send') {
      throw ArgumentError('bad_send');
    }
    if (!local &&
        pool != null &&
        !localSendReady(pool!.baseUrl) &&
        !privacyHopUp &&
        !allowPublicHttp) {
      throw StateError(kErrPublicHttp);
    }
    if (sendKind == 'send' && destTo == from) {
      throw ArgumentError('same_dest');
    }
    if (sendKind == 'send' && change != null && change == from) {
      throw ArgumentError('same_dest');
    }
    if (sendKind == 'send' && restFrame != null && (viewSecret ?? '').isNotEmpty) {
      final portal = vaultDest(restFrame, viewKey: viewSecret!);
      if (portal != null && (destTo == portal || change == portal)) {
        throw ArgumentError('portal_change');
      }
    }
    var src = from;
    if (spendSeed != null && spendSeed.length == 32) {
      spendPub ??= ed25519PublicFromSeed(spendSeed);
    }
    if (paymentCode != null) {
      spendPub ??= decodePaymentCode(paymentCode)?['spendPub'];
    }
    if (spendPub != null && spendPub!.length == 32) {
      if (!isBindable(src, restFrame: restFrame, paymentCode: paymentCode)) {
        src = encodeDestAddress(destCommitFromSpendPub(spendPub!), admitBase ?? _admitBaseOf(paymentCode));
      }
    }
    var depth = 0;
    if (pool != null && !local) {
      try {
        final pressure = await pool!.mempoolPressure();
        depth = (pressure['depth'] as num?)?.toInt() ?? 0;
      } catch (_) {}
    }
    final taxed = levyTaxed(sendKind);
    final nanos = sendKind == 'vote' ? 0 : (amount * kUnitsPerShe).round();
    final levy = taxed ? levyNanos(nanos, depth: depth) : 0;
    final needShe = (sendKind == 'vote' ? 0.0 : amount) + levy / kUnitsPerShe;
    if (spendable(src) < needShe && restFrame != null) {
      if (spendableOwned(restFrame, paymentCode: paymentCode) >= needShe) {
        src = spendFrom(restFrame, paymentCode: paymentCode, amount: needShe);
      }
    }
    if (spendable(src) < needShe) {
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
    if (spendable(src) < needShe) throw StateError('insufficient');
    Map<String, dynamic>? spent;
    var fundedShe = spendable(src);
    List<Uint8List> livePubs = const [];
    if (sendKind == 'send' && spendSeed != null && spendSeed.length == 32 && pool != null && !local) {
      livePubs = await _fluxsetPubs();
      for (final n in _notes) {
        if (n['spent'] == true) continue;
        if (n['address'] != src && n['dest'] != src) continue;
        if (_noteBytes(n['commit']) == null || _noteBytes(n['r']) == null) continue;
        final h = (n['height'] as num?)?.toInt();
        if (h != null && h > 0 && (_sealedHeight - h + 1) < spendableConfirmations) {
          continue;
        }
        final tag = _noteSpendTagHex(spendSeed, n);
        if (tag != null && _spentTagHex.contains(tag)) {
          n['spent'] = true;
          continue;
        }
        final amt = n['amount'];
        final noteShe = amt is num ? amt.toDouble() : fundedShe;
        if (noteShe + 1e-18 < needShe) continue;
        final have = spent?['amount'];
        final haveShe = have is num ? have.toDouble() : -1.0;
        if (spent == null || noteShe > haveShe) spent = n;
      }
      if (spent == null) throw StateError('no_note');
      if (spent['amount'] is num) fundedShe = (spent['amount'] as num).toDouble();
    }
    String? changeDest = change;
    if (sendKind == 'send') {
      String? portal;
      if (restFrame != null && (viewSecret ?? '').isNotEmpty) {
        portal = vaultDest(restFrame, viewKey: viewSecret!);
      }
      final leftover = fundedShe - needShe;
      if (leftover > 1e-18) {
        final derive = restFrame ?? src;
        if (paymentCode != null && isFullPaymentCode(paymentCode)) {
          final payChange = silentPay(paymentCode);
          changeDest ??= payChange?.dest;
          if (payChange != null) _stealthShared[payChange.dest] = payChange.shared;
          if (changeDest == src || changeDest == portal) {
            final again = silentPay(paymentCode);
            changeDest = again?.dest;
            if (again != null) _stealthShared[again.dest] = again.shared;
          }
        } else if ((viewSecret ?? '').isNotEmpty) {
          changeDest ??= allocateChangeDest(derive, from: src, portalDest: portal, paymentCode: paymentCode);
        } else {
          throw ArgumentError('same_dest');
        }
      }
      refuseSheetChange(from: src, to: destTo, change: changeDest, portalDest: portal);
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
      {'address': destTo, 'nanos': nanos, 'kind': sendKind},
    ];
    if (sendKind == 'send' && changeDest != null) {
      final leftoverNanos = ((fundedShe - needShe) * kUnitsPerShe).round();
      if (leftoverNanos > 0) {
        vouts.add({'address': changeDest, 'nanos': leftoverNanos, 'kind': 'send'});
      }
    }
    if (sendKind == 'send' && !vouts.any((o) => o['kind'] == 'dummy')) {
      vouts.add({'kind': 'dummy', 'nanos': 0});
    }
    List<Map<String, dynamic>> vin = [
      {'address': src}
    ];
    Map<String, dynamic>? admitProof;
    dynamic excess;
    if (sendKind == 'send' && spendSeed != null && spendSeed.length == 32 && pool != null && !local) {
      if (spent == null) throw StateError('no_note');
      final spentNote = {
        'kind': (spent['kind'] as String?) ?? 'pot',
        'commit': _noteBytes(spent['commit'])!,
        'noteCommit': _noteBytes(spent['noteCommit'])!,
        'r': _noteBytes(spent['r'])!,
      };
      final sealed = <Map<String, dynamic>>[];
      for (final o in vouts) {
        final kind = (o['kind'] as String?) ?? 'send';
        if (kind == 'dummy') {
          var note = nativeSealNote(0, dest20: randomBytes(20), kind: 'dummy');
          note = attachAdmitPub(note);
          sealed.add(note);
          continue;
        }
        final addr = (o['address'] as String?) ?? destTo;
        final n = (o['nanos'] as int?) ?? 0;
        final d20 = hash20FromAddress(addr);
        var note = nativeSealNote(n, dest20: d20, kind: kind);
        if (addr.isNotEmpty) note['address'] = addr;
        final B = admitBaseFromAddress(addr) ??
            ((addr == src || addr == changeDest) ? (admitBase ?? _admitBaseOf(paymentCode)) : null);
        note = attachAdmitPub(
          note,
          admitBase: B != null ? pointFrom(B) : null,
          spendSeed: B == null ? spendSeed : null,
        );
        sealed.add(note);
      }
      vouts
        ..clear()
        ..addAll(sealed);
      for (var i = 0; i < vouts.length; i++) {
        final o = vouts[i];
        if ((o['kind'] as String?) == 'dummy') continue;
        final addr = o['address'] as String?;
        if (addr == null || addr.isEmpty) continue;
        if (addr == src || addr == changeDest) {
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
            if (o['nanos'] != null) 'nanos': o['nanos'],
            if (o['nanos'] != null) 'amount': (o['nanos'] as num) / kUnitsPerShe,
          });
        }
      }
      vin = [
        {
          'prev': _noteBytes(spent['prev']) ?? Uint8List(32),
          'index': (spent['index'] as int?) ?? 0,
          'commit': spentNote['commit'],
          'noteCommit': spentNote['noteCommit'],
          'r': spentNote['r'],
        }
      ];
      excess = kernelExcess(vouts, vin);
      var pubs = livePubs;
      if (pubs.isEmpty) pubs = await _fluxsetPubs();
      if (pubs.isEmpty) throw StateError('fluxset');
      final dumpPubs = Platform.environment['SHEAR_DUMP_PUBS'];
      if (dumpPubs != null && dumpPubs.isNotEmpty) {
        File(dumpPubs).writeAsStringSync(jsonEncode({
          'n': pubs.length,
          'pubs': pubs.map(_bytesHex).toList(),
        }));
      }
      final body = <String, dynamic>{'vin': vin, 'vout': vouts};
      proveFlowSpend(body, spendSeed: spendSeed, spentNote: spentNote, pubs: pubs);
      admitProof = Map<String, dynamic>.from(body['admit_proof'] as Map);
      spent['spent'] = true;
    }
    final postedVin = _postedVin(vin);
    final postedVout = _postedVout(vouts);
    if (spendSeed != null && spendSeed.length == 32) {
      if (!isBindable(src, restFrame: restFrame, paymentCode: paymentCode)) {
        throw StateError('unspendable_dest');
      }
      // Sign the posted C̃-only vin/vout so spendPackDigest matches the server.
      final msg = spendMessage(from: src, vout: postedVout, kind: sendKind, vin: postedVin);
      final shared = _stealthShared[src];
      late Uint8List sig;
      late Uint8List pub;
      if (shared != null) {
        sig = stealthSign(spendSeed, shared, msg);
        pub = stealthTweakPub(ed25519PublicFromSeed(spendSeed), shared);
      } else {
        sig = ed25519Sign(spendSeed, msg);
        pub = ed25519PublicFromSeed(spendSeed);
      }
      sigHex = _bytesHex(sig);
      spendPubHex = _bytesHex(pub);
    }
    if (pool != null && !local) {
      Future<Map<String, dynamic>> postOnce() {
        return pool!.send(
          from: src,
          to: destTo,
          amount: sendKind == 'vote' ? 0 : amount,
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
          vin: List<dynamic>.from(_hexify(postedVin) as List),
          vout: List<dynamic>.from(_hexify(postedVout) as List),
          excess: excess is Uint8List ? _bytesHex(excess) : excess,
          admitProof: admitProof != null
              ? Map<String, dynamic>.from(_hexify(admitProof) as Map)
              : null,
          spendTag: admitProof?['spendTag'] is Uint8List
              ? _bytesHex(admitProof!['spendTag'] as Uint8List)
              : admitProof?['spendTag']?.toString(),
        );
      }

      Map<String, dynamic>? json;
      Object? lastErr;
      for (var attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0 && sendKind == 'send' && spendSeed != null && spendSeed.length == 32 && spent != null) {
          final pubs = await _fluxsetPubs();
          if (pubs.isEmpty) throw StateError('fluxset');
          final spentNote = {
            'kind': (spent['kind'] as String?) ?? 'pot',
            'commit': _noteBytes(spent['commit'])!,
            'noteCommit': _noteBytes(spent['noteCommit'])!,
            'r': _noteBytes(spent['r'])!,
          };
          final body = <String, dynamic>{'vin': vin, 'vout': vouts};
          proveFlowSpend(body, spendSeed: spendSeed, spentNote: spentNote, pubs: pubs);
          admitProof = Map<String, dynamic>.from(body['admit_proof'] as Map);
        }
        json = await postOnce();
        if (json['ok'] == true && json['tx'] is Map) break;
        lastErr = _sendHumanError(
          json['reason']?.toString(),
          pool?.baseUrl,
          hopUp: privacyHopUp,
          allowPublicHttp: allowPublicHttp,
        );
        final why = json['reason']?.toString() ?? '';
        if (why != 'admit' && why != 'admit_membership') break;
      }
      if (json == null || json['ok'] != true || json['tx'] is! Map) {
        throw lastErr ?? StateError('send failed');
      }
      final raw = ShearTx.fromJson(Map<String, dynamic>.from(json['tx'] as Map));
      _spendable[src] = (json['fromBalance'] as num?)?.toDouble()
          ?? (spendable(src) - needShe);
      final parkedAmt = (json['changeBalance'] as num?)?.toDouble();
      if (changeDest != null && parkedAmt != null && parkedAmt > 1e-18) {
        _spendable[src] = 0;
        _spendable[changeDest] = spendable(changeDest) + parkedAmt;
        _dests.add(changeDest);
      } else {
        _parkChange(src, changeDest);
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
    _spendable[src] = spendable(src) - needShe;
    _parkChange(src, changeDest);
    final tx = ShearTx(
      id: 'send-${DateTime.now().millisecondsSinceEpoch}',
      from: src,
      to: destTo,
      amount: amount,
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

  void _parkChange(String src, String? changeDest) {
    if (changeDest == null || changeDest.isEmpty) return;
    final leftover = spendable(src);
    if (leftover <= 1e-18) return;
    _spendable[src] = 0;
    _spendable[changeDest] = spendable(changeDest) + leftover;
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
    final sig = signPoolWithdraw(seed: seed, login: login, dest: dest, nanos: nanos);
    if (pool == null) throw StateError('no_pool');
    final json = await pool!.poolWithdraw(login: login, dest: dest, nanos: nanos, sig: sig);
    if (json['ok'] != true) {
      throw StateError(json['reason']?.toString() ?? 'withdraw');
    }
    final raw = json['tx'];
    final map = raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{};
    final tx = ShearTx(
      id: map['id']?.toString() ?? 'pull-${DateTime.now().millisecondsSinceEpoch}',
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
    final sig = signPoolWithdraw(seed: seed, login: login, dest: dest, nanos: nanos);
    if (pool == null) throw StateError('no_pool');
    final json = await pool!.poolWithdraw(login: login, dest: dest, nanos: nanos, sig: sig);
    if (json['ok'] != true) {
      throw StateError(json['reason']?.toString() ?? 'withdraw');
    }
    final raw = json['tx'];
    final map = raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{};
    final tx = ShearTx(
      id: map['id']?.toString() ?? 'pull-${DateTime.now().millisecondsSinceEpoch}',
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
    if (this.destIndex < 0 || this.destIndex >= this.destCount) this.destIndex = this.destCount - 1;
    prune();
  }
}

class ShearPoolClient {
  /// Production (no [baseUrl]) reads headers 1…tip from a live seed. Tests pin [baseUrl].
  ShearPoolClient({
    String? baseUrl,
    HttpClient? http,
    ShearReadSync? sync,
    String? userUrl,
  })  : _pinned = baseUrl,
        _http = http ?? (HttpClient()
          ..connectionTimeout = const Duration(seconds: 8)
          ..idleTimeout = const Duration(seconds: 30)) {
    _sync = sync ??
        (baseUrl == null
            ? ShearReadSync(http: _http, userUrl: userUrl)
            : null);
  }

  final String? _pinned;
  final HttpClient _http;
  ShearReadSync? _sync;
  final Set<int> _pinnedProven = {};
  int _pinnedTip = 0;

  ShearReadSync? get sync => _sync;
  bool get isPinned => _pinned != null;
  String? _pinnedGenesis;

  String? get genesisHex => _sync?.genesisHex ?? _pinnedGenesis;

  String get baseUrl => _pinned ?? _sync?.liveBase ?? kWalletDefaultSeed;

  int get provenHeaders => _sync?.provenHeaders ?? _pinnedProven.length;
  int get wantedHeaders =>
      _sync?.wantedHeaders ?? (_pinnedTip < 1 ? 0 : _pinnedTip);
  bool get nodeLive =>
      _sync != null ? _sync!.liveBase != null : _pinned != null && _pinnedTip > 0;

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
    if (_pinned != null) {
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
            if ((hdr?['header']?.toString() ?? '').isNotEmpty) _pinnedProven.add(h);
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  void close() {
    _http.close(force: true);
  }

  Future<Map<String, dynamic>> _getRaw(String path) async {
    final req = await _http.getUrl(Uri.parse('$baseUrl$path'));
    final res = await req.close();
    final text = await utf8.decodeStream(res);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw StateError('http_${res.statusCode}');
    }
    return jsonDecode(text) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>?> _getRawFirst(List<String> paths) async {
    for (final path in paths) {
      try {
        return await _getRaw(path);
      } catch (_) {}
    }
    return null;
  }

  Future<void> _ensureBase() async {
    if (_pinned != null) return;
    if (_sync?.liveBase != null) return;
    await _sync?.findLiveNode();
  }

  Future<Map<String, dynamic>> _get(String path) async {
    await _ensureBase();
    try {
      return await _getRaw(path);
    } catch (_) {
      if (_pinned == null) _sync?.noteFailure();
      rethrow;
    }
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) async {
    await _ensureBase();
    try {
      final req = await _http.postUrl(Uri.parse('$baseUrl$path'));
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
      return jsonDecode(await utf8.decodeStream(res)) as Map<String, dynamic>;
    } catch (_) {
      if (_pinned == null) _sync?.noteFailure();
      rethrow;
    }
  }

  Future<Map<String, dynamic>> balance(String address) =>
      _get('/api/wallet/balance?address=$address');

  Future<Map<String, dynamic>> history(String address, {String? viewKey, String? open}) {
    if (viewKey != null && viewKey.isNotEmpty) {
      return _post('/api/wallet/history', {'address': address, 'viewKey': viewKey, if (open != null && open.isNotEmpty) 'open': open});
    }
    final q = StringBuffer('/api/wallet/history?address=${Uri.encodeQueryComponent(address)}');
    if (open != null && open.isNotEmpty) {
      q.write('&open=${Uri.encodeQueryComponent(open)}');
    }
    return _get(q.toString());
  }

  Future<Map<String, dynamic>> explorerHistory({required String viewKey, String? address}) =>
      _post('/api/explorer/history', {
        'viewKey': viewKey,
        if (address != null) 'address': address,
      });

  Future<Map<String, dynamic>> registerView({required String address, required String viewKey}) {
    final host = Uri.tryParse(baseUrl)?.host ?? '';
    if (host.isNotEmpty && host != '127.0.0.1' && host != 'localhost' && host != '::1') {
      throw StateError('view_register_remote_blocked');
    }
    return _post('/api/wallet/register', {'address': address, 'viewKey': viewKey});
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
    String? spendTag,
  }) =>
      _post('/api/wallet/send', {
        'from': from,
        'to': to,
        'amount': amount,
        if (memoCt != null) 'memoCt': memoCt,
        if (open != null && open.isNotEmpty) 'open': open,
        if (sig != null && sig.isNotEmpty) 'sig': sig,
        if (spendPub != null && spendPub.isNotEmpty) 'spendPub': spendPub,
        if (ephPub != null && ephPub.isNotEmpty) 'ephPub': ephPub,
        if (portalOpen != null && portalOpen.isNotEmpty) 'portalOpen': portalOpen,
        if (kind != null && kind.isNotEmpty) 'kind': kind,
        if (programId != null && programId.isNotEmpty) 'programId': programId,
        if (choice != null && choice.isNotEmpty) 'choice': choice,
        if (currentEpoch != null) 'currentEpoch': currentEpoch,
        if (epochStartMs != null) 'epochStartMs': epochStartMs,
        if (change != null && change.isNotEmpty) 'change': change,
        if (vin != null) 'vin': vin,
        if (vout != null) 'vout': vout,
        if (excess != null) 'excess': excess,
        if (admitProof != null) 'admit_proof': admitProof,
        if (spendTag != null && spendTag.isNotEmpty) 'spendTag': spendTag,
      });

  Future<Map<String, dynamic>> fluxset() async {
    final got = await _getRawFirst(const ['/fluxset', '/api/wallet/fluxset']);
    if (got != null) return got;
    return _get('/api/wallet/fluxset');
  }

  Future<Map<String, dynamic>> notes(String address) async {
    final q = Uri.encodeQueryComponent(address);
    final got = await _getRawFirst([
      '/notes?address=$q',
      '/api/wallet/notes?address=$q',
    ]);
    if (got != null) return got;
    return _get('/api/wallet/notes?address=$q');
  }

  Future<Map<String, dynamic>> mempoolPressure() => _get('/api/mempoolPressure');

  Future<Map<String, dynamic>> poolWithdraw({
    required String login,
    required String dest,
    required int nanos,
    required String sig,
  }) =>
      _post('/api/pool/withdraw', {
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
  Future<Map<String, dynamic>> headerAt(int height) async {
    final got = await _getRawFirst([
      '/header?height=$height',
      '/api/explorer/header?height=$height',
    ]);
    if (got != null) return got;
    return _get('/api/explorer/header?height=$height');
  }

  /// Public HASH_TX DAG. Used only to read continuity at a claim height.
  Future<Map<String, dynamic>> explorerDag() => _get('/api/explorer/dag');

  Future<Map<String, dynamic>> policy() => _get('/api/policy');

  /// Per-portal Reserve stake/idle/accrued. Not a public vortice.
  Future<Map<String, dynamic>> reservePortal(String dest) =>
      _get('/api/vault/reserve?dest=$dest');
}
