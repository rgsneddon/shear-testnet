import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'shear_ctf.dart';
import 'shear_identity.dart';
import 'shear_eip712.dart';
import 'shear_levy.dart';
import 'shear_read_open.dart';
import 'shear_read_sync.dart';
import 'shear_session.dart';
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
bool pendingReceiveThinPoll(Iterable<ShearTx> txs) => txs.any((t) =>
    (t.kind == 'pool-withdraw' || t.kind == 'receive') && (t.height ?? 0) < 1);

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
    out.add(NodeOwnerLand(
      height: height,
      dest: dest,
      amount: amount,
      kind: kind == 'pot' || kind == 'block' || kind == 'coinbase' ? 'blockfound' : kind,
    ));
  }

  for (final row in history) {
    final kind = row['kind']?.toString() ?? '';
    final dest = _rowDest(row);
    if (dest == null) continue;
    add(_rowHeight(row), dest, _proofOpenedShe(row), kind.isEmpty ? 'blockfound' : kind);
  }
  for (final row in notes) {
    final kind = row['kind']?.toString() ?? (row['coinbase'] == true ? 'coinbase' : '');
    final dest = _rowDest(row);
    if (dest == null) continue;
    if (kind == 'hash' || kind == 'dummy' || kind == 'send') continue;
    add(_rowHeight(row), dest, _proofOpenedShe(row), kind.isEmpty ? 'coinbase' : kind);
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
            final kind = item['kind']?.toString() ?? (coinbase ? 'coinbase' : '');
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

bool _flowCryptoOnCaller() =>
    sealFlowOnCaller ||
    debugFlowCryptoOnCaller ||
    debugNativeSpendProver != null ||
    debugNativeSealNote != null ||
    Platform.environment['FLUTTER_TEST'] == 'true';

/// Counts ledger, sync, and proof work that still runs on the UI isolate.
int debugUiHeavyCount = 0;

/// Isolate that last ran [ShearLedger.followOffUi]'s body. Differs from the UI isolate.
String debugCreditFollowStamp = '';

/// `balances` or `credits`, from the worker that ran the real sync method.
String debugCreditFollowKind = '';

/// Kinds returned to this isolate, in order. Tests read the Apply entry.
final List<String> debugCreditFollowKinds = <String>[];

/// Worker stamps paired with [debugCreditFollowKinds].
final List<String> debugCreditFollowStamps = <String>[];

/// Keys of the last [followOffUi] payload. A session follow must not carry
/// `notes` — encoding that book on the UI isolate is the Verifying hang.
List<String> debugLastFollowSpecKeys = <String>[];

/// How many credit follows have returned to this isolate.
int debugCreditFollowRuns = 0;

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
  final opened = await openSessionEnvelope(Map<String, dynamic>.from(raw), password);
  final plain = opened['plain'];
  if (plain is! Map) return spec;
  final j = Map<String, dynamic>.from(plain);
  return <String, dynamic>{
    ...spec,
    if (j['seedHex'] != null) 'seedHex': j['seedHex'],
    if (j['address'] != null) 'address': j['address'],
    if (j['viewKey'] != null) 'viewKey': j['viewKey'],
    if (j['paymentCode'] != null) 'paymentCode': j['paymentCode'],
    'dests': j['dests'] ?? spec['dests'],
    'txs': j['txs'] ?? const <dynamic>[],
    'sealed': j['sealedHeight'] ?? spec['sealed'],
    'destCount': j['destCount'] ?? spec['destCount'],
    'destIndex': j['destIndex'] ?? spec['destIndex'],
  };
}

/// Tip, balance, notes, and history run here. The UI isolate only adopts the
/// book the worker already collated.
Future<Map<String, dynamic>> creditFollowWorker(String specJson) async {
  var spec = jsonDecode(specJson) as Map<String, dynamic>;
  spec = await _bookFromSession(spec);
  spec.remove('sessionPassword');
  final base = spec['baseUrl']?.toString() ?? '';
  final pool = base.isEmpty ? null : ShearPoolClient(baseUrl: base);
  final ledger = ShearLedger(pool: pool);
  try {
    ledger.installCreditFollow(spec);
    final rest = spec['restFrame']?.toString() ?? '';
    final code = spec['paymentCode']?.toString();
    if (rest.isNotEmpty) {
      ledger.recheckRestFrameSpendable(rest, paymentCode: code);
    }
    final full = spec['full'] == true;
    final chain = spec['chain'] != false;
    // Unlock Verifying is this branch: recheck the coins already in hand.
    // It does not download the book. That download is the later population.
    final opened = !chain
        ? ledger.recheckRestFrameSpendable(
            rest,
            paymentCode: (code == null || code.isEmpty) ? null : code,
          )
        : full
            ? await ledger.syncCredits(rest, paymentCode: code)
            : await ledger.syncBalancesOnly(rest, paymentCode: code);
    final out = ledger.exportCreditFollow(restFrame: rest, paymentCode: code, full: full && chain);
    out['stamp'] = identityHashCode(Isolate.current).toString();
    out['kind'] = !chain ? 'verify' : (full ? 'credits' : 'balances');
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

/// Seal Flow vouts (range proof + admit pub). Production hop-fee pay calls this
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
    final n = (o['nanos'] as int?) ?? 0;
    final d20 = hash20FromAddress(addr);
    var note = nativeSealNote(n, dest20: d20, kind: kind);
    if (addr.isNotEmpty) note['address'] = addr;
    final B = admitBaseFromAddress(addr) ??
        ((addr == src || addr == changeDest) ? fallbackBase : null);
    note = attachAdmitPub(
      note,
      admitBase: B != null ? pointFrom(B) : null,
      spendSeed: B == null ? spendSeed : null,
    );
    sealed.add(note);
  }
  return {'vouts': sealed};
}

/// BP+ / ADMIT prove. Same off-isolate rule as [sealFlowSpendVouts].
Map<String, dynamic> reproveFlowSpendWire(Map<String, dynamic> input) {
  final spendSeed = input['spendSeed'] as Uint8List;
  final spentNote = Map<String, dynamic>.from(input['spentNote'] as Map);
  final pubs = <Uint8List>[
    for (final p in (input['pubs'] as List? ?? const []))
      if (p is Uint8List) p,
  ];
  final vin = <Map<String, dynamic>>[
    for (final raw in (input['vin'] as List? ?? const []))
      if (raw is Map) Map<String, dynamic>.from(raw),
  ];
  final vout = <Map<String, dynamic>>[
    for (final raw in (input['vout'] as List? ?? const []))
      if (raw is Map) Map<String, dynamic>.from(raw),
  ];
  final body = <String, dynamic>{'vin': vin, 'vout': vout};
  final commits = <Uint8List>[
    for (final raw in (input['commits'] as List? ?? const []))
      if (raw is Uint8List) raw,
  ];
  proveFlowSpend(
    body,
    spendSeed: spendSeed,
    spentNote: spentNote,
    pubs: pubs,
    commits: commits,
  );
  return {
    'admitProof': body['admit_proof'],
    'spendTag': body['spendTag'],
  };
}

Future<Map<String, dynamic>> _sealFlowOffUi(Map<String, dynamic> input) {
  if (_flowCryptoOnCaller()) {
    noteUiHeavy('seal');
    return Future<Map<String, dynamic>>.value(sealFlowSpendVouts(input));
  }
  return Isolate.run(() => sealFlowSpendVouts(input));
}

Future<Map<String, dynamic>> _proveFlowOffUi(Map<String, dynamic> input) {
  if (_flowCryptoOnCaller()) {
    noteUiHeavy('prove');
    return Future<Map<String, dynamic>>.value(reproveFlowSpendWire(input));
  }
  return Isolate.run(() => reproveFlowSpendWire(input));
}

/// Hexify a Flow post body inside the worker. Vin, vout, and the admit proof
/// are byte-heavy; the UI isolate only sends them and posts the result.
Map<String, dynamic> flowPostHex(Map<String, dynamic> raw) {
  final proof = raw['admitProof'];
  return <String, dynamic>{
    'vin': List<dynamic>.from(_hexify(raw['vin']) as List? ?? const []),
    'vout': List<dynamic>.from(_hexify(raw['vout']) as List? ?? const []),
    'admitProof': proof == null ? null : Map<String, dynamic>.from(_hexify(proof) as Map),
  };
}

Future<Map<String, dynamic>> flowPostHexOffUi(Map<String, dynamic> raw) {
  return Isolate.run(() => flowPostHex(raw));
}

/// Hexify the scan snapshot inside the worker, then scan. The caller sends
/// the raw snapshot; the JSON clone does not run on the UI isolate.
Map<String, dynamic> scanSealedWire(Map<String, dynamic> raw) {
  return scanSealedVouts(<String, dynamic>{
    'vouts': _hexify(raw['vouts']),
    'dests': List<String>.from(raw['dests'] as List? ?? const []),
    'dest': raw['dest'],
    'spendSeed': raw['spendSeed'],
    'seenCommitHex': List<String>.from(raw['seenCommitHex'] as List? ?? const []),
    'txHints': _hexify(raw['txHints']),
    'prev': raw['prev'],
    'startIndex': raw['startIndex'],
  });
}

Future<Map<String, dynamic>> scanSealedWireOffUi(Map<String, dynamic> raw) {
  return Isolate.run(() => scanSealedWire(raw));
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
    final proofChecked = _completeValueProof(o);
    final verifiedNanos = proofChecked ? _verifiedClaimNanos(o) : null;
    final num? amt = (verifiedNanos != null && verifiedNanos > 0)
        ? verifiedNanos / kUnitsPerShe
        : null;
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
      if (proofChecked) 'proofChecked': true,
      if (verifiedNanos != null) 'verified': true,
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

/// R and z present. A bare `{v}` claim is not a proof.
bool _completeValueProof(Map o) {
  final vp = o['valueProof'];
  if (vp is! Map) return false;
  if (_noteBytes(o['commit']) == null) return false;
  if (_noteBytes(vp['R']) == null || _noteBytes(vp['z']) == null) return false;
  return vp['v'] is num;
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
    if (v['commit'] != null) row['commit'] = v['commit'];
    return row;
  }).toList();
}

List<Map<String, dynamic>> _postedVout(List<Map<String, dynamic>> vouts) {
  return vouts.map(compactSealedVout).toList();
}

/// Reserve lock/vote/withdraw out, same seal as pool `sealedReserveVout`.
/// Public nanos + dest20 + noteCommitOfDest20, with `commit` so wallet_api
/// keeps this body instead of minting a fresh seal after the spend sig.
Map<String, dynamic> sealedReserveVout(String to, int nanos, String kind) {
  final d20 = hash20FromAddress(to);
  if (d20 == null) return {'address': to, 'nanos': nanos, 'kind': kind};
  final note = sealCoinbaseNote(nanos, dest20: d20, kind: kind);
  note['address'] = to;
  final vp = note['valueProof'];
  if (vp is Map) {
    note['valueProof'] = {...Map<String, dynamic>.from(vp), 'v': nanos};
  }
  return note;
}

/// Seal and sign one reserve lock, vote, or withdraw.
/// Production calls this only from [Isolate.run].
Map<String, dynamic> sealSignReserveWire(Map<String, dynamic> input) {
  final to = (input['to'] as String?) ?? '';
  final from = (input['from'] as String?) ?? '';
  final kind = (input['kind'] as String?) ?? 'lock';
  final nanos = (input['nanos'] as int?) ?? 0;
  final spendSeed = input['spendSeed'] is Uint8List ? input['spendSeed'] as Uint8List : null;
  final shared = input['shared'] is Uint8List ? input['shared'] as Uint8List : null;
  final spec = <Map<String, dynamic>>[
    for (final raw in (input['vouts'] as List? ?? const []))
      if (raw is Map) Map<String, dynamic>.from(raw),
  ];
  final vinIn = <Map<String, dynamic>>[
    for (final raw in (input['vin'] as List? ?? const []))
      if (raw is Map) Map<String, dynamic>.from(raw),
  ];
  final sealed = <Map<String, dynamic>>[
    for (final o in spec)
      sealedReserveVout(
        (o['address'] as String?) ?? to,
        (o['nanos'] as int?) ?? (kind == 'vote' ? 0 : nanos),
        (o['kind'] as String?) ?? kind,
      ),
  ];
  final postedVin = _postedVin(vinIn);
  final postedVout = _postedVout(sealed);
  Uint8List? sig;
  Uint8List? pub;
  if (spendSeed != null && spendSeed.length == 32) {
    final msg = spendMessage(from: from, vout: postedVout, kind: kind, vin: postedVin);
    if (shared != null) {
      sig = stealthSign(spendSeed, shared, msg);
      pub = stealthTweakPub(ed25519PublicFromSeed(spendSeed), shared);
    } else {
      sig = ed25519Sign(spendSeed, msg);
      pub = ed25519PublicFromSeed(spendSeed);
    }
  }
  return {
    'vouts': sealed,
    'postedVin': postedVin,
    'postedVout': postedVout,
    'sig': sig,
    'pub': pub,
    'isolateStamp': reserveIsolateStamp,
  };
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
List<Map<String, dynamic>> sealPaintedSpendVouts(List<Map<String, dynamic>> spec) {
  final out = <Map<String, dynamic>>[];
  for (final o in spec) {
    final kind = (o['kind'] as String?) ?? 'send';
    final n = (o['nanos'] as int?) ?? 0;
    final Uint8List d20;
    if (kind == 'dummy') {
      d20 = randomBytes(20);
    } else {
      final addr = (o['address'] as String?) ?? '';
      final hashed = hash20FromAddress(addr);
      if (hashed == null) continue;
      d20 = hashed;
    }
    final note = sealCoinbaseNote(n, dest20: d20, kind: kind);
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
    return LockFundingPlan(sources: [cover], from: cover, consolidate: false, have: have, need: needShe);
  }
  if (have + 1e-12 >= needShe && holding.isNotEmpty) {
    return LockFundingPlan(sources: holding, from: null, consolidate: true, have: have, need: needShe);
  }
  return LockFundingPlan(sources: const [], from: null, consolidate: false, have: have, need: needShe);
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
double paintedContinuumSpendable(ShearLedger ledger, String restFrame, {String? paymentCode}) {
  return ledger.spendableOwned(restFrame, paymentCode: paymentCode);
}

/// Sum of sealed notes on money dests. Not the painted Continuum figure.
double chainNoteSum(ShearLedger ledger, String restFrame, {String? paymentCode}) {
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
  return isFullPaymentCode(s) || isDestAddress(s);
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
  bool privacyHopUp = false,
  bool allowPublicHttp = false,
  int depth = 0,
}) async {
  final candidate = enteredTo.trim();
  if (!continuumPayable(candidate)) {
    return ContinuumSendResult(posted: false, to: startTo, remark: kErrShortShe1);
  }
  if (amount <= 0) {
    return ContinuumSendResult(posted: false, to: candidate, remark: kErrSendGeneric);
  }
  final nanos = (amount * kUnitsPerShe).round();
  final levy = levyNanos(nanos, depth: depth);
  final need = amount + levy / kUnitsPerShe;
  final painted = paintedContinuumSpendable(ledger, restFrame, paymentCode: paymentCode);
  if (painted + 1e-12 < need) {
    return ContinuumSendResult(posted: false, to: candidate, remark: kErrSendGeneric);
  }
  debugLastContinuumSendError = null;
  final mark = ledger.markPaintedBook();
  final gap = ledger.fundFromPaintedContinuum(restFrame, paymentCode: paymentCode, needShe: need);
  if (gap == null) {
    ledger.restorePaintedBook(mark);
    return ContinuumSendResult(posted: false, to: candidate, remark: kErrSendGeneric);
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
      memo: memo,
      local: local,
      restFrame: restFrame,
      paymentCode: paymentCode,
      spendSeed: spendSeed,
      privacyHopUp: privacyHopUp,
      allowPublicHttp: allowPublicHttp,
      paintedCover: gap > 1e-12,
    );
    return ContinuumSendResult(posted: true, to: candidate, remark: '', tx: tx);
  } catch (e) {
    debugLastContinuumSendError = e;
    ledger.restorePaintedBook(mark);
    return ContinuumSendResult(posted: false, to: candidate, remark: flowSendAdvisoryOf(e));
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
const kErrPayIdentity = 'pay this identity with their full she1 or ssa1 dest';
const kErrLockUnsigned = 'lock signature rejected';

String voteFailCopy(Object error) {
  final msg = error.toString().toLowerCase();
  if (msg.contains('not_voter') || msg.contains('not eligible')) {
    return 'You’re not eligible to vote from this portal this epoch';
  }
  if (msg.contains('vote_locked') || msg.contains('sealed')) {
    return 'Vote already sealed for this epoch';
  }
  if (msg.contains('unsigned') || msg.contains('lock signature') || msg.contains('bad_vote')) {
    return 'Vote could not be signed — check Continuum fee and portal, then try again';
  }
  return error.toString();
}
/// Hop-fee picker had no sealed note, and the rest-frame sum could not cover the fee.
/// One Flow input spends one note. A user send of the sum posts one transaction per note.
const kErrNoSealedNote =
    'No sealed Continuum note ready for the hop fee — wait for sync/confirms';
/// Pool answered with an HTML error page (or other non-JSON). Never surface FormatException.
const kErrPoolHtml = 'pool returned HTML';

const kFlowMiningRefuse =
    'Can’t spend from your mining mailbox — Continuum will use a spend note instead.';

/// Flow vin. A covering dest other than the mining mailbox.
/// Throws [kFlowMiningRefuse] when the only covering dest is that mailbox.
String flowSpendFrom(ShearLedger ledger, {
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
  if (ledger.spendableOwned(restFrame, paymentCode: paymentCode) + 1e-12 >= amount) {
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
  throw StateError('insufficient');
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
/// rejection is not collapsed to [kErrSendGeneric]. Raw `no_note` and HTML
/// parse failures are rewritten; a real pool reason is kept.
String hopFeeAdvisoryOf(Object error) {
  if (error is FormatException) return kErrPoolHtml;
  var msg = '';
  if (error is StateError) {
    msg = error.message.trim();
  } else if (error is ArgumentError) {
    msg = error.message?.toString().trim() ?? '';
  } else {
    msg = error.toString().trim();
    const prefixes = <String>[
      'Bad state: ',
      'Invalid argument(s): ',
      'FormatException: ',
      'Exception: ',
    ];
    for (final p in prefixes) {
      if (msg.startsWith(p)) {
        msg = msg.substring(p.length).trim();
        break;
      }
    }
  }
  if (msg.isEmpty) return kErrSendGeneric;
  if (msg == 'no_note') return kErrNoSealedNote;
  if (msg == 'unsigned') return kErrLockUnsigned;
  if (msg.startsWith('pool returned an error page') || msg == kErrPoolHtml) return msg;
  final low = msg.toLowerCase();
  if (low.contains('<html') ||
      low.contains('<!doctype') ||
      low.contains('formatexception') ||
      low.contains('unexpected character')) {
    final code = RegExp(r'http_(\d+)').firstMatch(msg);
    if (code != null) return 'pool returned an error page (http_${code.group(1)})';
    return kErrPoolHtml;
  }
  return msg;
}

/// Public alias of [_sendHumanError] for unit tests.
StateError sendHumanError(
  String? reason,
  String? baseUrl, {
  bool hopUp = false,
  bool allowPublicHttp = false,
  String? kind,
}) =>
    _sendHumanError(
      reason,
      baseUrl,
      hopUp: hopUp,
      allowPublicHttp: allowPublicHttp,
      kind: kind,
    );

StateError _sendHumanError(
  String? reason,
  String? baseUrl, {
  bool hopUp = false,
  bool allowPublicHttp = false,
  String? kind,
}) {
  final why = (reason == null || reason.trim().isEmpty) ? 'send failed' : reason.trim();
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
  if (why == 'range_proof' || why == 'commit_sum') return StateError(kErrRangeProof);
  if (why == 'unsigned' &&
      (kind == 'lock' || kind == 'vote' || kind == 'withdraw')) {
    return StateError(kErrLockUnsigned);
  }
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
          (j['hashNanos'] is num && (j['hashNanos'] as num) > 0
              ? (j['hashNanos'] as num).toDouble() / kUnitsPerShe
              : null) ??
          (kind == 'hash' && amount > 0 ? amount : null),
      threads: (j['threads'] as num?)?.toInt(),
      pot: (j['pot'] as num?)?.toDouble() ??
          (j['potNanos'] is num && (j['potNanos'] as num) > 0
              ? (j['potNanos'] as num).toDouble() / kUnitsPerShe
              : null),
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

/// Continuum pending vortex remark. Sender: sending. Recipient: receive.
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
    final block = t.kind == 'blockfound' || t.kind == 'coinbase' || t.kind == 'block';
    if (!block || hash <= 0) {
      out.add(ShearviewTreeRow(tx: t));
      continue;
    }
    final potRaw = (t.pot != null && t.pot! > 0) ? t.pot! : t.amount - hash;
    final pot = potRaw > 1e-15 ? potRaw : 0.0;
    out.add(ShearviewTreeRow(
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
    ));
    out.add(ShearviewTreeRow(
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
    ));
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
class ShearLedger implements ReadProofSink {
  ShearLedger({this.pool}) {
    pool?.sync?.proofSink = this;
  }

  final ShearPoolClient? pool;
  final Map<String, double> _spendable = {};
  /// Session header nanos. Never copied into [_spendable].
  final Map<String, double> _advisorySpendable = {};
  /// Accepted Reserve locks still sitting in the verified note sum.
  final Map<String, double> _lockDebitShe = {};
  /// Owned sealed notes (commit, noteCommit, r, prev, index, admit x). Reserve vault excepted.
  final List<Map<String, dynamic>> _notes = [];
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
  void ingestReadOpen(ReadBlockOpen open, {required List blocks, String? dest}) {
    rememberNodeChain(bodies: [
      for (final b in blocks)
        if (b is Map) Map<String, dynamic>.from(b),
    ]);
    if (open.liveTip >= 1) noteLiveHeight(open.liveTip);
    creditKnownNodeLands();
    final frame = (dest != null && dest.isNotEmpty) ? dest : (_restFrame ?? '');
    if (frame.isEmpty && open.opened.every((n) => n.dest.isEmpty)) return;
    final fallback = frame.isEmpty ? '' : (isDestAddress(frame) ? frame : homeDest(frame));
    final used = <Map>[];
    var credited = false;
    for (final opened in open.opened) {
      if (!opened.verified || opened.nanos <= 0 || opened.commit.isEmpty) continue;
      final raw = _takeReadNote(blocks, opened, used);
      if (raw == null) continue;
      final tagged = opened.dest.isNotEmpty ? opened.dest : (_rowDest(raw) ?? fallback);
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
  Map<String, dynamic>? _takeReadNote(List blocks, OpenedReadNote opened, List<Map> used) {
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
      if (commit != null && openedHere.any((c) => _bytesEq(c, commit))) continue;
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
          if (row['proofChecked'] == true) {
            final dest = (row['dest'] ?? row['address'])?.toString() ?? '';
            if (dest.isNotEmpty) _proofCheckedDests.add(payKey(dest));
          }
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
          confirmed: h > 0 && confirmationsOf(h) >= spendableConfirmations,
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

  bool historyStamped(String address) {
    final key = payKey(address);
    return _sealedHeight >= 1 && _historyAt[key] == _sealedHeight;
  }

  bool notesStamped(String address) {
    final key = payKey(address);
    return _sealedHeight >= 1 && _notesAt[key] == _sealedHeight;
  }

  /// Closure Apply, every mode. The next credit sync must pull node history
  /// and notes again instead of trusting a caught-up stamp.
  void onClosureApply() {
    _historyAt.clear();
    _notesAt.clear();
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
      if (land.dest != key && payKey(land.dest) != key && land.dest != address) continue;
      if (confirmationsOf(land.height) >= spendableConfirmations) continue;
      final have = _txs.any((t) =>
          isWalletBlockKind(t.kind) &&
          (t.height ?? 0) == land.height &&
          (t.to == land.dest || payKey(t.to) == key));
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
  void _enrollOwnerLand({required String dest, required double amount, required int height}) {
    if (height < 1 || amount <= 0 || dest.isEmpty) return;
    final pk = payKey(dest);
    final key = _ownerLandKey(pk, height);
    if (_landSettled.contains(key) || _landEnrolled.contains(key)) return;
    _landEnrolled.add(key);
    final already = _immature.any((r) => r.height == height && payKey(r.dest) == pk);
    if (!already) {
      _immature.add((dest: pk, amount: amount, height: height));
    }
  }

  void _ensureOwnerLandRow(NodeOwnerLand land) {
    final id = 'blockfound:${land.height}:${land.dest}';
    final have = _txs.any((t) =>
        t.id == id ||
        (isWalletBlockKind(t.kind) &&
            (t.height ?? 0) == land.height &&
            (t.to == land.dest || payKey(t.to) == payKey(land.dest))));
    if (!have) {
      _txs.add(ShearTx(
        id: id,
        from: 'coinbase',
        to: land.dest,
        amount: land.amount,
        kind: land.kind == 'mine' ? 'mine' : 'blockfound',
        height: land.height,
        confirmed: false,
      ));
      rememberDest(land.dest);
    }
    _enrollOwnerLand(dest: land.dest, amount: land.amount, height: land.height);
  }

  /// Credit every node land in (before, tip]. A height with none is a miss.
  void creditNodeLandsInGap({required int before, required int tip, String? extraDest}) {
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
  /// Failed note pulls while spendable is ahead of the sealed book.
  /// Stop the background retry after two misses at this height; Pay still forces one.
  final Map<String, int> _noteMisses = {};
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
    _noteMisses.clear();
    _ingestMisses.clear();
    _nodeBodies.clear();
    _nodeHistoryRows.clear();
    _nodeNoteRows.clear();
    honestLandMisses.clear();
    tipAdvancedWithoutLanding = false;
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

  /// Positive supply only. A 0 from a thin stats body must not wipe a live figure.
  void applyCirculatingNanos(Object? raw) {
    if (raw is! num) return;
    final n = raw.round();
    if (n > 0) circulatingNanos = n;
  }
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
    if (pool != null && isPoolLedgerHost(pool!.baseUrl)) return _sealedHeight;
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
      settleTo(_sealedHeight);
      return;
    }
    tipHeight = sealedHeight + 1;
    if (sealedHeight > _sealedHeight) _sealedHeight = sealedHeight;
    if (sealedHeight > prev) {
      final beforeLands = _bookedLandCount();
      if (prev > 0) {
        _historyAt.clear();
        _notesAt.clear();
        _bundleOpenRounds(height: prev + 1);
      }
      creditNodeLandsInGap(before: prev, tip: sealedHeight);
      tipAdvancedWithoutLanding = _bookedLandCount() == beforeLands;
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
    if (have >= 0 && (_standInReceipt(tx.id) || _standInReceipt(_txs[have].id) || !_anchorReceipt(tx) || !_anchorReceipt(_txs[have]) || (tx.height ?? 0) == (_txs[have].height ?? 0))) {
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

  /// A pool send and the wallet's echo of it. Not a block reward.
  bool _receiptKind(String kind) => kind == 'receive' || kind == 'pool-withdraw';

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
      final sameSlot = have >= 0 &&
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
        if (tx.to.isNotEmpty && !_isProgramVaultDest(tx.to)) rememberDest(tx.to);
        return;
      }
    }
    if (tx.kind == 'receive' && (tx.height ?? 0) < 1 && !tx.confirmed) {
      creditReceive(to: tx.to, amount: tx.amount, from: tx.from, id: tx.id);
      return;
    }
    if (tx.isBlockBundle && (tx.height ?? 0) >= 1 && tx.to.isNotEmpty) {
      final slot = _txs.indexWhere((t) =>
          t.isBlockBundle && t.to == tx.to && (t.height ?? 0) == tx.height);
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
        _enrollOwnerLand(dest: prev.to, amount: prev.amount > 0 ? prev.amount : tx.amount, height: prev.height ?? 0);
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
    _collapseDuplicateReceipts();
    final kept = _txs.cast<ShearTx?>().firstWhere((t) => t!.id == roundId, orElse: () => null);
    return kept ?? tx;
  }

  /// Confirmations of a sealed height, counting the including block as 1.
  /// Uses [displayHeight] so a receive at the live tip is not hidden while
  /// paint lags one block behind the node.
  int confirmationsOf(int height, [int? tip]) {
    final t = tip ?? displayHeight;
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
          t.kind != 'pool-withdraw' &&
          t.kind != 'lock' &&
          t.kind != 'withdraw') continue;
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
    if (_isProgramVaultDest(address) || _isProgramVaultDest(payKey(address))) return;
    final key = isDestAddress(address) ? address : payKey(address);
    if (!isDestAddress(key)) return;
    _advisorySpendable[key] = amount;
    final owned = inventoriedNoteShe(key, sum: true);
    final shown = spendable(key);
    if (shown > owned + 1e-12) _spendable[key] = owned;
  }

  Future<void> _applyStatsTip(Map<String, dynamic> json) async {
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
      final genesis = pool!.genesisHex ?? await pool!.fetchGenesisHex();
      if (genesis != null && genesis.isNotEmpty) bindChainGenesis(genesis);
      applyTipHex(hex, sealedHeight: sealed);
      if (json.containsKey('hashrate')) networkHashrate = paint.hashrate;
      if (json.containsKey('circulatingNanos')) circulatingNanos = paint.circulatingNanos;
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
        vaultLockedNanos = 0;
      } else {
        take('lockedNanos', (n) => vaultLockedNanos = n);
        if (json['reserveVaultNanos'] is num) {
          vaultLockedNanos = (json['reserveVaultNanos'] as num).round();
        }
      }
      take('potEmittedNanos', (n) => potEmittedNanos = n);
      take('hashBonusEmittedNanos', (n) => hashBonusEmittedNanos = n);
      take('miners', (n) => networkMiners = n);
  }

  Future<void> syncTip() async {
    if (pool == null) return;
    final frame = _restFrame;
    if (frame != null && frame.isNotEmpty) {
      final dests = moneyDests(frame).toList();
      pool!.sync?.proofDests = dests;
      pool!.sync?.proofDest = dests.isEmpty ? homeDest(frame) : dests.first;
    }
    try {
      final live = pool!.liveTip;
      if (live > _sealedHeight) noteLiveHeight(live);
      final first = await pool!.stats().timeout(const Duration(seconds: 2));
      await _applyStatsTip(first);
    } catch (_) {}
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
      await syncTip();
      final json = await _balanceWithOne504Retry(address);
      applyPoolSnapshot(address, json, beforeHeight: before, tipSealed: _sealedHeight);
      _markSettled(_sealedHeight, before);
      await syncHistory(address);
      return spendable(address);
    } catch (e) {
      if (poolHttp504(e)) rethrow;
      return prev;
    }
  }

  double spendableOwned(String restFrame, {String? paymentCode}) {
    spendPub ??= decodePaymentCode(paymentCode ?? '')?['spendPub'];
    _dropProgramVaults();
    final seen = <String>{};
    var n = 0.0;
    for (final d in moneyDests(restFrame, paymentCode: paymentCode)) {
      if (!isDestAddress(d)) continue;
      final key = payKey(d);
      if (!isDestAddress(key) || !seen.add(key)) continue;
      if (_isProgramVaultDest(key)) continue;
      n += _shownSpendable(key);
    }
    // confirmRound before a spend pub parks the coin on the shear1 rest-frame.
    // payKey aliases an ssa once a spend pub exists; that book is already summed.
    if (!isDestAddress(restFrame) && payKey(restFrame) == restFrame) {
      n += _shownSpendable(restFrame);
    }
    return n;
  }

  /// Open-wallet coin control. Notes parked on the shear1 rest frame join the
  /// spendable dest. Every other owned ssa1 stays one note and is counted in
  /// that same sum. A young note stays unspendable. Does not invent coins.
  double recheckRestFrameSpendable(String restFrame, {String? paymentCode}) {
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
        if (!isBindable(addr, restFrame: restFrame, paymentCode: paymentCode)) continue;
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

  double _shownSpendable(String key) {
    final cap = _verifiedConfirmedShe(key);
    final pk = payKey(key);
    final debit = _lockDebitShe[pk] ?? 0;
    double afterDebit(double she) {
      final left = she - debit;
      return left <= 1e-12 ? 0 : left;
    }
    if (cap != null) {
      _unverifiedExternal.remove(pk);
      _externalShe.remove(pk);
      if ((spendable(pk) - cap).abs() > 1e-12) _spendable[pk] = cap;
      return afterDebit(cap);
    }
    // The lock already took needShe out of this book. Debit is only for a
    // gross figure: the opened-note cap above, or settled lands shown instead
    // of a larger pool number.
    final rest = _bookMinusUnverified(pk, spendable(key));
    final settled = _settledNodeShe[pk] ?? 0;
    if (settled <= 1e-12 || rest + 1e-12 >= settled) return rest;
    final book = spendable(key);
    final external = _externalShe[pk];
    if (external != null && book + 1e-12 >= settled && external + 1e-12 >= book) {
      return afterDebit(settled);
    }
    return rest;
  }

  void _noteLockDebit(String src, double needShe) {
    if (needShe <= 1e-12) return;
    final pk = payKey(src);
    _lockDebitShe[pk] = (_lockDebitShe[pk] ?? 0) + needShe;
  }

  /// Null cap: the pool figure is not spendable. A confirmRound credit that
  /// settled locally is what remains after that figure is removed.
  /// A recorded 0 is a zero pool figure, not a claim on coins landed later.
  double _bookMinusUnverified(String pk, double book) {
    if (_externalShe.containsKey(pk)) {
      final local = book - (_externalShe[pk] ?? 0);
      if (local <= 1e-12) return 0;
      return local;
    }
    if (_unverifiedExternal.contains(pk)) return 0;
    return book;
  }

  /// Null when this dest has not presented a complete value proof.
  double? _verifiedConfirmedShe(String dest) {
    final key = payKey(dest);
    if (!_proofCheckedDests.contains(key)) return null;
    var total = 0.0;
    for (final n in _notes) {
      if (n['spent'] == true || n['verified'] != true) continue;
      if (!_noteOnDest(n, key)) continue;
      // Same floor as the Flow picker. A missing height is already in the
      // mature book; a stamped height still waits for 9 confirmations.
      if (!_noteMature(n)) continue;
      final she = _noteSheOf(n, 0);
      if (she <= 0) continue;
      total += she;
    }
    return total;
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

  /// Confirmed enough to spend. A missing height is already in the mature book.
  /// Same floor as the Flow picker: [spendableConfirmations] from [_sealedHeight].
  bool _noteMature(Map<String, dynamic> note, {bool ignoreConfs = false}) {
    if (ignoreConfs) return true;
    final h = (note['height'] as num?)?.toInt();
    if (h == null || h < 1) return true;
    return (_sealedHeight - h + 1) >= spendableConfirmations;
  }

  /// One sealed note on [dest] can cover [needShe]. Several smaller notes are
  /// not combined. An amount-less note falls back to the spendable book.
  bool _structuralCover(String dest, double needShe) {
    var largest = 0.0;
    var bare = false;
    for (final n in _notes) {
      if (n['spent'] == true) continue;
      if (!_noteOnDest(n, dest)) continue;
      if (_noteBytes(n['commit']) == null || _noteBytes(n['r']) == null) continue;
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
      if (_noteBytes(n['commit']) == null || _noteBytes(n['r']) == null) continue;
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
      if (_noteBytes(n['commit']) == null || _noteBytes(n['r']) == null) continue;
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
    var saw = false;
    var failed = false;
    for (final key in dests) {
      try {
        final json = await pool!.notes(key);
        final rows = json['notes'];
        if (rows is! List) {
          failed = true;
          continue;
        }
        saw = true;
        if (rows.isEmpty) continue;
        final raw = _sealedScanInput(rows, spendSeed: seed, dest: key);
        final scanned = await scanSealedWireOffUi(raw);
        _applySealedScan(scanned);
        if (_stampIngest(key, count: false)) _notesAt[key] = _sealedHeight;
      } catch (_) {
        failed = true;
      }
    }
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
      if (n['spent'] == true) continue;
      if (!_noteOnDest(n, dest)) continue;
      if (_noteBytes(n['commit']) == null || _noteBytes(n['r']) == null) continue;
      if (!_noteMature(n, ignoreConfs: ignoreConfs)) continue;
      final tag = _noteSpendTagHex(spendSeed, n);
      if (tag != null && _spentTagHex.contains(tag)) {
        n['spent'] = true;
        continue;
      }
      final noteShe = _noteSheOf(n, amountFallback);
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
  String spendFrom(String restFrame, {String? paymentCode, required double amount, bool requireCover = false}) {
    final plan = planLockFunding(this, restFrame: restFrame, paymentCode: paymentCode, needShe: amount);
    if (plan.from != null) return plan.from!;
    if (requireCover) return '';
    final dests = moneyDests(restFrame, paymentCode: paymentCode).toList();
    return dests.isNotEmpty ? dests.first : currentDest(restFrame, paymentCode: paymentCode);
  }

  String _hopOffMiningMailbox(String home, String restFrame, {String? paymentCode}) {
    final fresh = newDest(restFrame, paymentCode: paymentCode);
    final amt = _spendable.remove(home) ?? 0;
    if (amt > 0) _spendable[fresh] = (_spendable[fresh] ?? 0) + amt;
    return fresh;
  }

  /// Copy of chain spendable and the owed already folded into it.
  PaintedBookMark markPaintedBook() => PaintedBookMark(
        Map<String, double>.from(_spendable),
        _owedSpent,
      );

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
  double? fundFromPaintedContinuum(String restFrame, {String? paymentCode, required double needShe}) {
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
    final plan = planLockFunding(this, restFrame: restFrame, paymentCode: paymentCode, needShe: needShe);
    final home = homeDest(restFrame, paymentCode: paymentCode);
    if (plan.from != null && plan.from != home) return plan.from!;
    final miss = lockFundingShortfall(plan);
    if (miss.isNotEmpty) throw StateError(miss);
    if (plan.from == home) {
      if (keepHome) return home;
      if (_paintedFundDest == home && spendable(home) + 1e-9 >= needShe) return home;
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
      if (_paintedFundDest == home && spendable(home) + 1e-9 >= needShe) return home;
      return _hopOffMiningMailbox(home, restFrame, paymentCode: paymentCode);
    }
    return target;
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
  void _takeOwed(Map<String, dynamic> json, String address) {
    final owed = json['owedPi'] ?? json['confirmingPot'];
    if (owed is num && owed >= 0) _owedPiDisplay = owed.toDouble();
    if (owed is num && owed > 0 && isDestAddress(address) && !_isProgramVaultDest(address)) {
      _owedPiDest = address;
    }
  }

  /// One pull-book figure for the whole sweep. A later dest that reports 0
  /// must not wipe the mailbox's positive owed-π.
  void _finishOwedSweep(double owedMax, {required bool saw, String dest = ''}) {
    if (saw) _owedPiDisplay = owedMax;
    if (saw && owedMax > 0 && isDestAddress(dest) && !_isProgramVaultDest(dest)) {
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
      creditNodeLandsInGap(before: beforeHeight, tip: tipSealed, extraDest: address);
      if (beforeHeight > 0 && tipSealed == beforeHeight + 1) {
        confirmRound(address: address, pot: 0, height: beforeHeight + 1);
      }
      if (beforeHeight > 0) settleTo(tipSealed);
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
      return await pool!.balance(address);
    } catch (e) {
      if (!poolHttp504(e)) rethrow;
      return await pool!.balance(address);
    }
  }

  /// Balance sweep. Owed-π is the max pull-book figure across dests, applied
  /// after the loop so a change dest's 0 does not clear the mailbox.
  Future<({double max, bool saw, String dest})> _balancesFor(Iterable<String> dests, {required int before}) async {
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
      'baseUrl': (pool != null && pool!.isPinned) ? pool!.baseUrl : '',
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
      'settledNodeShe': _followEncode(_settledNodeShe),
      'proofChecked': _proofCheckedDests.toList(),
      'unverifiedExternal': _unverifiedExternal.toList(),
      'sealed': _sealedHeight,
      'settled': _settledHeight,
      'notesAt': _followEncode(_notesAt),
      'historyAt': _followEncode(_historyAt),
      'openCollated': _openCollated,
      'destCount': destCount,
      'destIndex': destIndex,
      'nodeBodies': <Object?>[for (final b in _nodeBodies) _followEncode(b)],
      'nodeHistory': <Object?>[for (final b in _nodeHistoryRows) _followEncode(b)],
      'nodeNotes': <Object?>[for (final b in _nodeNoteRows) _followEncode(b)],
    };
  }

  void installCreditFollow(Map<String, dynamic> spec) {
    final seed = spec['seedHex']?.toString() ?? '';
    final address = spec['address']?.toString() ?? '';
    final view = spec['viewKey']?.toString() ?? '';
    final code = spec['paymentCode']?.toString() ?? '';
    if (seed.isNotEmpty && address.isNotEmpty && view.isNotEmpty && code.isNotEmpty) {
      bindIdentity(ShearIdentity(
        seedHex: seed,
        address: address,
        viewKey: view,
        paymentCode: code,
      ));
    }
    _dests
      ..clear()
      ..addAll(((spec['dests'] as List?) ?? const <dynamic>[]).map((e) => e.toString()));
    _txs
      ..clear()
      ..addAll(<ShearTx>[
        for (final raw in (spec['txs'] as List?) ?? const <dynamic>[])
          if (_followRevive(raw) is Map)
            ShearTx.fromJson(Map<String, dynamic>.from(_followRevive(raw) as Map)),
      ]);
    _notes
      ..clear()
      ..addAll(<Map<String, dynamic>>[
        for (final raw in (spec['notes'] as List?) ?? const <dynamic>[])
          if (_followRevive(raw) is Map)
            Map<String, dynamic>.from(_followRevive(raw) as Map),
      ]);
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
    takeDoubles(_settledNodeShe, spec['settledNodeShe']);
    _proofCheckedDests
      ..clear()
      ..addAll(((spec['proofChecked'] as List?) ?? const <dynamic>[]).map((e) => e.toString()));
    _unverifiedExternal
      ..clear()
      ..addAll(((spec['unverifiedExternal'] as List?) ?? const <dynamic>[]).map((e) => e.toString()));
    _sealedHeight = (spec['sealed'] as num?)?.toInt() ?? _sealedHeight;
    _settledHeight = (spec['settled'] as num?)?.toInt() ?? _settledHeight;
    _notesAt
      ..clear()
      ..addAll(_followInts(spec['notesAt']));
    _historyAt
      ..clear()
      ..addAll(_followInts(spec['historyAt']));
    _openCollated = spec['openCollated'] == true;
    destCount = (spec['destCount'] as num?)?.toInt() ?? destCount;
    destIndex = (spec['destIndex'] as num?)?.toInt() ?? destIndex;
    List<Map<String, dynamic>> rows(Object? raw) => <Map<String, dynamic>>[
          for (final item in (raw as List?) ?? const <dynamic>[])
            if (_followRevive(item) is Map)
              Map<String, dynamic>.from(_followRevive(item) as Map),
        ];
    _nodeBodies
      ..clear()
      ..addAll(rows(spec['nodeBodies']));
    _nodeHistoryRows
      ..clear()
      ..addAll(rows(spec['nodeHistory']));
    _nodeNoteRows
      ..clear()
      ..addAll(rows(spec['nodeNotes']));
  }

  void adoptCreditFollow(Map<String, dynamic> spec) {
    installCreditFollow(spec);
  }

  /// Balance poll or full credit sync. HTTP and note scan run in [Isolate.run].
  /// This isolate only copies the worker's collated book back.
  Future<double> followOffUi({
    required String restFrame,
    String? paymentCode,
    required bool full,
    bool chain = true,
    String? sessionPath,
    String? sessionPassword,
  }) async {
    final pinned = pool != null && pool!.isPinned;
    final spec = <String, dynamic>{
      'full': full,
      'chain': chain,
      'restFrame': restFrame,
      'paymentCode': paymentCode ?? '',
      'baseUrl': pinned ? pool!.baseUrl : (pool?.sync?.liveBase ?? ''),
      'address': _restFrame ?? restFrame,
      'seedHex': spendSeed == null ? '' : _bytesHex(spendSeed!),
      'viewKey': viewSecret ?? '',
      'sealed': _sealedHeight,
      'settled': _settledHeight,
      'destCount': destCount,
      'destIndex': destIndex,
      'dests': _dests.toList(),
    };
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
        'settledNodeShe',
        'proofChecked',
        'unverifiedExternal',
        'notesAt',
        'historyAt',
        'openCollated',
        'nodeBodies',
        'nodeHistory',
        'nodeNotes',
      ]) {
        spec[key] = book[key];
      }
    }
    debugLastFollowSpecKeys = spec.keys.map((k) => k.toString()).toList();
    final result = await Isolate.run(() => creditFollowWorker(jsonEncode(spec)));
    debugCreditFollowStamp = result['stamp']?.toString() ?? '';
    debugCreditFollowKind = result['kind']?.toString() ?? '';
    debugCreditFollowKinds.add(debugCreditFollowKind);
    debugCreditFollowStamps.add(debugCreditFollowStamp);
    debugCreditFollowRuns += 1;
    adoptCreditFollow(result);
    final opened = result['opened'];
    return opened is num ? opened.toDouble() : spendableOwned(restFrame, paymentCode: paymentCode);
  }

  /// Pull Continuum for this wallet's own money dests.
  /// A payment from someone else counts. A mining payout is not required.
  /// Do not query every historical dest.
  Future<double> syncCredits(String restFrame, {String? paymentCode, bool openMemos = false}) async {
    if (pool == null) {
      final opened = recheckRestFrameSpendable(restFrame, paymentCode: paymentCode);
      _openCollated = true;
      return opened;
    }
    keepOwnedDests(restFrame, paymentCode: paymentCode);
    final before = _settledHeight;
    try {
      final live = pool?.liveTip ?? 0;
      if (live > _sealedHeight) noteLiveHeight(live);
      await syncTip();
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
    final histSeen = <String>{};
    for (final d in dests) {
      final key = payKey(d);
      if (!histSeen.add(key)) continue;
      if (_notesAt[key] == _sealedHeight) {
        final lag = spendable(key) > 1e-12 && !_ownsSealedOn(key);
        if (!lag || (_noteMisses[key] ?? 0) >= 2) continue;
      }
      final seed = spendSeed;
      if (seed != null && seed.length == 32 && pool != null && !isPoolLedgerHost(pool!.baseUrl)) {
        try {
          final json = await pool!.notes(key);
          final rows = json['notes'];
          if (rows is List) {
            if (rows.isNotEmpty) {
              final raw = _sealedScanInput(rows, spendSeed: seed, dest: key);
              final scanned = await scanSealedWireOffUi(raw);
              _applySealedScan(scanned);
            }
            if (_stampIngest(key, count: false)) _notesAt[key] = _sealedHeight;
            if (_ownsSealedOn(key)) {
              _noteMisses.remove(key);
            } else if (spendable(key) > 1e-12) {
              _noteMisses[key] = (_noteMisses[key] ?? 0) + 1;
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
    // Node bodies and the history just pulled. A tip that did not move still
    // credits every opened owner land. Pool balance is not in that material.
    creditKnownNodeLands();
    settleTo(_sealedHeight);
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
    final opened = recheckRestFrameSpendable(restFrame, paymentCode: paymentCode);
    _openCollated = true;
    return opened;
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

  Future<List<ShearTx>> syncHistory(String address, {bool openMemos = false}) async {
    if (pool == null) return ownerHistory(address);
    if (isPoolLedgerHost(pool!.baseUrl)) return ownerHistory(address);
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
      if ((named || spendable(key) <= 0) && _stampIngest(key)) {
        _historyAt[key] = _sealedHeight;
      }
      final histRows = <Map<String, dynamic>>[
        for (final row in rows)
          if (row is Map) Map<String, dynamic>.from(row),
      ];
      if (!isPoolLedgerHost(pool!.baseUrl)) rememberNodeChain(history: histRows);
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

  /// A credit parked on destForLogin, or on the shear1 rest-frame itself,
  /// moves onto destCommit once the spend pub is known. Spendable coins stay
  /// spendable. Coins still under 9 confirmations stay confirming.
  void _foldFlowDest(String restFrame, {String? paymentCode}) {
    final pub = _spendPubOf(paymentCode);
    if (pub == null || pub.length != 32) return;
    final bound = encodeDestAddress(destCommitFromSpendPub(pub), _admitBaseOf(paymentCode));
    if (!isDestAddress(bound)) return;
    final fromKeys = <String>{};
    if (restFrame.isNotEmpty && !isDestAddress(restFrame) && restFrame != bound) {
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
    final d = _freshStealthDest(restFrame, paymentCode: paymentCode, from: home);
    _coinLedger = d;
    _dests.add(d);
    return d;
  }

  /// Continuum receive: the one coin-ledger address. A second receive adds to it.
  String allocateReceiveDest(String restFrame, {String? paymentCode}) =>
      coinLedgerDest(restFrame, paymentCode: paymentCode);

  /// Change returns to the coin ledger. Never [from] and never the Reserve portal.
  String allocateChangeDest(String restFrame, {String? from, String? portalDest, String? paymentCode}) {
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
      final h = t.height ?? 0;
      if (h < 1) return false;
      // Still on the Continuum pending vortex. A history page that omits this
      // id must not drop it before 9 confirmations.
      if (h <= _sealedHeight + 1 && confirmationsOf(h) < spendableConfirmations) return false;
      // Lock/withdraw rows replay portal principal after a thin staked=0 sync.
      // A later history page of payouts must not erase them.
      if (t.kind == 'lock' || t.kind == 'withdraw') return false;
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
        if (isWalletBlockKind(t.kind)) return true;
        return !t.confirmed &&
            (t.kind == 'receive' ||
                t.kind == 'send' ||
                t.kind == 'pool-withdraw' ||
                isOwnerLanding(t));
      }
      final confs = confirmationsOf(h);
      if (isWalletBlockKind(t.kind)) return true;
      if (isOwnerLanding(t)) return confs >= 1;
      return confs >= continuumConfirmations;
    }).toList();
    rows.sort((a, b) => (b.height ?? 0).compareTo(a.height ?? 0));
    return rows;
  }

  /// Coins still arriving: incoming rows with fewer than 9 confirmations.
  /// Not added into Spendable. A row already counted as immature is not summed twice.
  double unconfirmedIncomingShe(String restFrame, {String? paymentCode}) {
    _collapseDuplicateReceipts();
    final keys = ownedAddresses(restFrame, paymentCode: paymentCode).toSet();
    const incoming = {'receive', 'coinbase', 'blockfound', 'pool-withdraw', 'withdraw'};
    var n = 0.0;
    final covered = <String>{};
    for (final t in _txs) {
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
    return shearviewTxs(address).where((t) => shearviewMatches(t, query)).toList();
  }

  /// Continuum: full blocks still filling the 6-slice pie, plus in-flight
  /// send/receive/pool-withdraw. Hash rewards never list on their own — they sit in the block.
  List<ShearTx> pendingTxs(String address) {
    _collapseDuplicateReceipts();
    final rows = _ownedRolled(address).where((t) {
      if (t.kind == 'hash' || t.kind == 'sample') return false;
      if (!t.confirmed && t.kind == 'pool-withdraw') {
        final h = t.height ?? 0;
        if (h < 1) return true;
        return confirmationsOf(h) < continuumConfirmations;
      }
      if (!t.confirmed && (t.kind == 'send' || t.kind == 'lock' || t.kind == 'vote')) return true;
      final h = t.height ?? 0;
      if (h < 1) {
        // Rollup paints block rows confirmed. The book row is still unconfirmed
        // until a height is stamped and the maturity floor is met.
        if (t.kind == 'blockfound' || t.kind == 'coinbase' || t.kind == 'mine') return true;
        return t.kind == 'receive' && !t.confirmed;
      }
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

  Future<({List<Uint8List> pubs, List<Uint8List> commits})> _fluxColumns() async {
    if (pool == null) return (pubs: const <Uint8List>[], commits: const <Uint8List>[]);
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
      final rawPubs = live['pubs'];
      final rawCommits = live['commits'];
      if (rawPubs is! List || rawCommits is! List || rawPubs.length != rawCommits.length) {
        return (pubs: const <Uint8List>[], commits: const <Uint8List>[]);
      }
      final pubs = <Uint8List>[];
      final commits = <Uint8List>[];
      for (var i = 0; i < rawPubs.length; i++) {
        final p = _noteBytes(rawPubs[i]);
        final c = _noteBytes(rawCommits[i]);
        if (p == null || c == null || p.length != 32 || c.length != 32) continue;
        pubs.add(p);
        commits.add(c);
      }
      return (pubs: pubs, commits: commits);
    } catch (_) {
      return (pubs: const <Uint8List>[], commits: const <Uint8List>[]);
    }
  }

  /// One Flow vin is one note. When no note covers [amount] and the rest-frame
  /// sum does, post one proven send per note until the pay is filled.
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
    String? change,
    Uint8List? spendSeed,
    bool privacyHopUp = false,
    bool allowPublicHttp = false,
    bool paintedCover = false,
  }) async {
    final sendKind = kind ?? (programId == 'shear-reserve-v1' ? 'lock' : 'send');
    Future<ShearTx> once(double pay, String src) {
      return send(
        from: src,
        to: to,
        amount: pay,
        memo: memo,
        local: local,
        kind: kind,
        programId: programId,
        restFrame: restFrame,
        paymentCode: paymentCode,
        choice: choice,
        currentEpoch: currentEpoch,
        epochStartMs: epochStartMs,
        change: change,
        spendSeed: spendSeed,
        privacyHopUp: privacyHopUp,
        allowPublicHttp: allowPublicHttp,
        paintedCover: paintedCover,
      );
    }
    if (sendKind != 'send' || local || paintedCover || restFrame == null) {
      return once(amount, from);
    }
    try {
      return await once(amount, from);
    } catch (e) {
      final msg = e is StateError ? e.message : '';
      if (msg != 'no_note' && msg != kErrNoSealedNote && msg != 'insufficient') rethrow;
      final slices = _sumSlices(restFrame, paymentCode, amount);
      if (slices.length < 2) rethrow;
      ShearTx? last;
      for (final slice in slices) {
        last = await once(slice.pay, slice.dest);
      }
      return last!;
    }
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
  List<({String dest, double pay})> _sumSlices(String restFrame, String? paymentCode, double amount) {
    final owned = moneyDests(restFrame, paymentCode: paymentCode).map(payKey).toSet();
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
    bool paintedCover = false,
  }) async {
    final sendKind = kind ?? (programId == 'shear-reserve-v1' ? 'lock' : 'send');
    if (sendKind != 'vote' && amount <= 0) throw ArgumentError('amount');
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
      this.spendSeed ??= spendSeed;
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
    // Painted funding already reserved the levy at the caller's depth. A
    // mempool-depth surge here asks for more SHE than that reserve and the
    // pool fee (floor) does not charge it, so the second send looks short.
    if (pool != null && !local && !paintedCover) {
      try {
        final pressure = await pool!.mempoolPressure();
        depth = (pressure['depth'] as num?)?.toInt() ?? 0;
      } catch (_) {}
    }
    final taxed = levyTaxed(sendKind);
    final nanos = sendKind == 'vote' ? 0 : (amount * kUnitsPerShe).round();
    final levy = taxed ? levyNanos(nanos, depth: depth) : 0;
    final needShe = (sendKind == 'vote' ? 0.0 : amount) + levy / kUnitsPerShe;
    if (restFrame != null && (sendKind == 'vote' || sendKind == 'lock')) {
      final home = homeDest(restFrame, paymentCode: paymentCode);
      final short = spendable(src) + 1e-12 < needShe;
      if (src == home || short) {
        if (spendableOwned(restFrame, paymentCode: paymentCode) + 1e-12 >= needShe) {
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
        spendableOwned(restFrame, paymentCode: paymentCode) + 1e-12 >= needShe) {
      _moveSpendableOnto(src);
    }
    if (sendKind == 'send' &&
        restFrame != null &&
        change == null &&
        _coinLedger != null &&
        src == _coinLedger &&
        !_ownsSealedOn(src)) {
      final hopped = _hopOffMiningMailbox(src, restFrame, paymentCode: paymentCode);
      if (hopped != src) src = hopped;
    }
    if (!paintedCover) {
      final usable = _shownSpendable(src);
      final owned = restFrame == null
          ? usable
          : spendableOwned(restFrame, paymentCode: paymentCode);
      if (usable + 1e-12 < needShe && owned + 1e-12 < needShe) {
        throw StateError('insufficient');
      }
      final pk = payKey(src);
      if (usable + 1e-12 >= needShe && spendable(pk) > usable + 1e-12) {
        _spendable[pk] = usable;
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
    if (spendable(src) < needShe) {
      final owned = restFrame == null
          ? spendable(src)
          : spendableOwned(restFrame, paymentCode: paymentCode);
      if (owned + 1e-12 < needShe) throw StateError('insufficient');
    }
    Map<String, dynamic>? spent;
    Map<String, dynamic>? chosen;
    var fundedShe = spendable(src);
    List<Uint8List> livePubs = const [];
    List<Uint8List> liveCommits = const [];
    if (sendKind == 'send' && spendSeed != null && spendSeed.length == 32 && pool != null && !local && !paintedCover) {
      // One sealed note covers this send. A sum of smaller notes is posted by
      // sendSpendableSum as one transaction per note. Pull the pool note list
      // when the local book has no covering note.
      final cols = await _fluxColumns();
      livePubs = cols.pubs;
      liveCommits = cols.commits;
      Map<String, dynamic>? pick(String fromDest, {bool ignoreConfs = false}) =>
          _pickSpendNote(
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
      // so Continuum does not keep claiming a cover the hop fee cannot use.
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
      final spentNote = {
        'kind': (note['kind'] as String?) ?? 'pot',
        'commit': _noteBytes(note['commit'])!,
        'noteCommit': _noteBytes(note['noteCommit'])!,
        'r': _noteBytes(note['r'])!,
      };
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
          'prev': _noteBytes(note['prev']) ?? Uint8List(32),
          'index': (note['index'] as int?) ?? 0,
          'commit': spentNote['commit'],
          'noteCommit': spentNote['noteCommit'],
          'r': spentNote['r'],
        }
      ];
      excess = kernelExcess(vouts, vin);
      var pubs = livePubs;
      var commits = liveCommits;
      if (pubs.isEmpty || commits.length != pubs.length) {
        final again = await _fluxColumns();
        pubs = again.pubs;
        commits = again.commits;
      }
      if (pubs.isEmpty || commits.length != pubs.length) throw StateError('fluxset');
      final dumpPubs = Platform.environment['SHEAR_DUMP_PUBS'];
      if (dumpPubs != null && dumpPubs.isNotEmpty) {
        File(dumpPubs).writeAsStringSync(jsonEncode({
          'n': pubs.length,
          'pubs': pubs.map(_bytesHex).toList(),
        }));
      }
      final proved = await _proveFlowOffUi({
        'vin': vin,
        'vout': vouts,
        'spendSeed': spendSeed,
        'spentNote': spentNote,
        'pubs': pubs,
        'commits': commits,
      });
      admitProof = Map<String, dynamic>.from(proved['admitProof'] as Map);
      note['spent'] = true;
      }
    }
    final List<Map<String, dynamic>> postedVin;
    final List<Map<String, dynamic>> postedVout;
    if (sendKind == 'lock' || sendKind == 'vote' || sendKind == 'withdraw') {
      if (spendSeed != null && spendSeed.length == 32) {
        if (!isBindable(src, restFrame: restFrame, paymentCode: paymentCode)) {
          throw StateError('unspendable_dest');
        }
      }
      final shared = _stealthShared[src];
      final built = await _reserveSealOffUi({
        'to': destTo,
        'from': src,
        'kind': sendKind,
        'nanos': nanos,
        'spendSeed': spendSeed,
        'shared': shared,
        'vouts': <Map<String, dynamic>>[
          for (final o in vouts) Map<String, dynamic>.from(o),
        ],
        'vin': <Map<String, dynamic>>[
          for (final o in vin) Map<String, dynamic>.from(o),
        ],
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
    } else {
      postedVin = _postedVin(vin);
      postedVout = _postedVout(vouts);
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
          vin: List<dynamic>.from(wire['vin'] as List? ?? const []),
          vout: List<dynamic>.from(wire['vout'] as List? ?? const []),
          excess: excess is Uint8List ? _bytesHex(excess) : excess,
          admitProof: proof is Map ? Map<String, dynamic>.from(proof) : null,
          spendTag: admitProof?['spendTag'] is Uint8List
              ? _bytesHex(admitProof!['spendTag'] as Uint8List)
              : admitProof?['spendTag']?.toString(),
          paintedOwedNanos: paintedCover ? _paintedFundOwedNanos : 0,
        );
      }

      Map<String, dynamic>? json;
      Object? lastErr;
      for (var attempt = 0; attempt < 3; attempt++) {
        final retryNote = chosen;
        if (attempt > 0 && sendKind == 'send' && spendSeed != null && spendSeed.length == 32 && retryNote != null) {
          final again = await _fluxColumns();
          final pubs = again.pubs;
          final commits = again.commits;
          if (pubs.isEmpty || commits.length != pubs.length) throw StateError('fluxset');
          final spentNote = {
            'kind': (retryNote['kind'] as String?) ?? 'pot',
            'commit': _noteBytes(retryNote['commit'])!,
            'noteCommit': _noteBytes(retryNote['noteCommit'])!,
            'r': _noteBytes(retryNote['r'])!,
          };
          final proved = await _proveFlowOffUi({
            'vin': vin,
            'vout': vouts,
            'spendSeed': spendSeed,
            'spentNote': spentNote,
            'pubs': pubs,
            'commits': commits,
          });
          admitProof = Map<String, dynamic>.from(proved['admitProof'] as Map);
        }
        json = await postOnce();
        if (json['ok'] == true && json['tx'] is Map) break;
        lastErr = _sendHumanError(
          json['reason']?.toString(),
          pool?.baseUrl,
          hopUp: privacyHopUp,
          allowPublicHttp: allowPublicHttp,
          kind: sendKind,
        );
        final why = json['reason']?.toString() ?? '';
        if (why != 'admit' && why != 'admit_membership') break;
      }
      if (json == null || json['ok'] != true || json['tx'] is! Map) {
        throw lastErr ?? StateError('send failed');
      }
      if (sendKind == 'lock') _noteLockDebit(src, needShe);
      final raw = ShearTx.fromJson(Map<String, dynamic>.from(json['tx'] as Map));
      // wallet_api.js sets fromBalance to 0 and sends changeBalance for the
      // pool's reconstructed leftover whenever change is parked. That figure
      // is the spent output, not the other confirmed notes on this dest.
      // Debit the send from the local sum and park only this note's change.
      if (sendKind == 'send') {
        final left = spendable(src) - needShe;
        _spendable[src] = left <= 1e-18 ? 0 : left;
        final noteChange = fundedShe - needShe;
        _parkChange(src, changeDest, changeShe: noteChange > 1e-18 ? noteChange : null);
      } else {
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
    _spendable[src] = spendable(src) - needShe;
    if (sendKind == 'lock') _noteLockDebit(src, needShe);
    _parkChange(src, changeDest, changeShe: fundedShe - needShe);
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
    final map = _decodePoolBody(res.statusCode, res.headers.contentType?.mimeType, text);
    // GET fallbacks try the next path on non-2xx. HTML already threw above.
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw StateError('http_${res.statusCode}');
    }
    return map;
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

  Future<Map<String, dynamic>> _postOnce(String base, String path, Map<String, dynamic> body) async {
    final req = await _http.postUrl(Uri.parse('$base$path'));
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
    final text = await utf8.decodeStream(res);
    return _decodePoolBody(res.statusCode, res.headers.contentType?.mimeType, text);
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) async {
    await _ensureBase();
    final first = _pinned ?? walletSendBase(baseUrl);
    try {
      return await _postOnce(first, path, body);
    } on FormatException {
      if (_pinned == null) _sync?.noteFailure();
      throw StateError(kErrPoolHtml);
    } on SocketException {
      if (_pinned != null || isPublicPoolHttp(first)) {
        if (_pinned == null) _sync?.noteFailure();
        rethrow;
      }
      // A send may try the pool host. The chain base stays on the node.
      return _postOnce(kPublicPoolHttp, path, body);
    } catch (_) {
      if (_pinned == null) _sync?.noteFailure();
      rethrow;
    }
  }

  /// JSON error objects (non-2xx with a reason) are returned so send mapping
  /// still sees `unsigned` / `insufficient`. HTML and other non-JSON become
  /// [kErrPoolHtml] or `http_<status>`. FormatException never leaves here.
  Map<String, dynamic> _decodePoolBody(int status, String? contentType, String text) {
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
    if (ct.contains('text/html') || ct.contains('application/xhtml')) return true;
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
    int paintedOwedNanos = 0,
  }) =>
      _post('/api/wallet/send', {
        'from': from,
        'to': to,
        'amount': amount,
        if (paintedOwedNanos > 0) 'paintedOwedNanos': paintedOwedNanos,
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

/// Tip lines the Windows binary prints for `--print-tip`.
/// Default seeds are the local node RPC and the public node HTTP seeds.
/// A refused loopback must not hide a live same-genesis height.
Future<String> continuumTipReport({List<String>? seeds, HttpClient? http}) async {
  final clientHttp = http ?? (HttpClient()..connectionTimeout = const Duration(seconds: 8));
  final sync = ShearReadSync(seeds: seeds, jitter: Duration.zero, http: clientHttp);
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
