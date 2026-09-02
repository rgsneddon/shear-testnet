import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'shear_ctf.dart';
import 'shear_identity.dart';
import 'shear_eip712.dart';
import 'shear_levy.dart';

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

String formatShe(num she) {
  if (!she.isFinite) return '0.000000000';
  final trunc = (she * 1e9).truncateToDouble() / 1e9;
  if (trunc == 0 && she != 0) return she < 0 ? '-0.000000000' : '0.000000000';
  final s = trunc.toStringAsFixed(kShePublicDigits);
  if (RegExp(r'^-?\d+\.000000000$').hasMatch(s)) return trunc.truncate().toString();
  return s;
}

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
      );

  bool get isHashReward => kind == 'hash';

  bool get isBlockBundle =>
      kind == 'coinbase' || kind == 'blockfound' || kind == 'block' || kind == 'pot' || kind == 'mine';

  factory ShearTx.fromJson(Map<String, dynamic> j) => ShearTx(
        id: j['id']?.toString() ?? '',
        from: j['from']?.toString() ?? '',
        to: j['to']?.toString() ?? '',
        amount: (j['amount'] as num?)?.toDouble() ?? 0,
        kind: j['kind']?.toString() ?? '',
        height: (j['height'] as num?)?.toInt(),
        confirmed: j['confirmed'] is bool ? j['confirmed'] as bool : true,
        memo: j['memo'] == true,
        memoPlain: j['memoPlain']?.toString(),
        memoCt: j['memoCt'] is Map ? Map<String, dynamic>.from(j['memoCt'] as Map) : null,
        rounds: (j['rounds'] as num?)?.toInt(),
        hashAmount: (j['hashAmount'] as num?)?.toDouble(),
        threads: (j['threads'] as num?)?.toInt(),
        pot: (j['pot'] as num?)?.toDouble(),
      );
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
  final Map<String, double> _pending = {};
  final List<ShearTx> _txs = [];
  final Set<String> _dests = {};
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

  int? _headerTimestampMs;
  int? _prevHeaderTimestampMs;
  /// Mean interval of every sealed block on the book (from pool /api/stats).
  int? _avgBlockTimeMs;

  /// Last found/sealed block height (Continuum header).
  int get sealedHeight => _sealedHeight;

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
    final raw = headerFromHex(headerHex);
    if (raw == null) {
      if (sealedHeight >= 1) tipHeight = sealedHeight + 1;
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
    final dests = <String>{..._pending.keys, ..._dests};
    for (final t in _txs) {
      if (t.confirmed) continue;
      if (t.to.isNotEmpty) dests.add(payKey(t.to));
    }
    for (final d in dests) {
      if (d.isEmpty) continue;
      final openAmt = _pending[d] ?? 0;
      final openTx = _txs.any((t) =>
          !t.confirmed &&
          (t.kind == 'hash' || t.kind == 'receive' || t.kind == 'send' || t.kind == 'coinbase') &&
          (t.to == d || t.from == d || t.id == _hashPendingId(d)));
      if (openAmt <= 0 && !openTx) continue;
      confirmRound(address: d, pot: 0, height: height);
    }
  }

  Iterable<ShearTx> get transactions => List.unmodifiable(_txs);

  String payKey(String address) {
    if (isDestAddress(address)) return address;
    final silent = payoutDest(address);
    if (silent != null) return silent;
    return currentDest(address);
  }

  bool _isProgramVaultDest(String address) => isJoinVaultDest(address);

  /// Track a Continuum dest without crediting spendable (Join payout, etc).
  void rememberDest(String address) {
    if (address.isEmpty) return;
    final key = payKey(address);
    if (_isProgramVaultDest(address) || _isProgramVaultDest(key)) return;
    _dests.add(key);
  }

  /// Join claim is in mempool / unconfirmed. Not spendable until 6 conf.
  void noteJoinPending({required String to, required double amount}) {
    if (amount <= 0) return;
    rememberDest(to);
    final key = payKey(to);
    _pending[key] = (_pending[key] ?? 0) + amount;
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
  double pending(String address) => _pending[payKey(address)] ?? _pending[address] ?? 0;

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
  }) {
    if (amount <= 0) throw ArgumentError('amount');
    final key = payKey(to);
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

  /// Live mempool pays. Same row as [creditReceive]; skip ids we already have.
  void _ingestIncoming(Map<String, dynamic> json) {
    final rows = json['incoming'];
    if (rows is! List) return;
    for (final row in rows) {
      if (row is! Map) continue;
      final id = row['id']?.toString() ?? '';
      final to = row['to']?.toString() ?? '';
      final amount = (row['amount'] as num?)?.toDouble() ?? 0;
      if (id.isEmpty || to.isEmpty || amount <= 0) continue;
      if (_txs.any((t) => t.id == id)) continue;
      creditReceive(to: to, amount: amount, from: row['from']?.toString(), id: id);
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
  int confirmationsOf(int height, [int? tip]) {
    final t = tip ?? _sealedHeight;
    if (height < 1 || t < height) return 0;
    return t - height + 1;
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
      final json = await pool!.stats();
      if (json['policy'] is Map) {
        applyPolicy(Map<String, dynamic>.from(json['policy'] as Map));
      } else if (json['frozen'] is bool) {
        creditsFrozen = json['frozen'] as bool;
      }
      final sealed = (json['height'] as num?)?.toInt() ?? 0;
      final hex = json['header']?.toString() ?? '';
      applyTipHex(hex, sealedHeight: sealed);
      final raw = json['networkAvgBlockTimeMs'] ?? json['avgBlockTimeMs'];
      final avg = raw is num ? raw.round() : int.tryParse('$raw');
      if (avg != null && avg >= 0) applyAvgBlockTimeMs(avg);
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

  double spendableOwned(String restFrame, {String? paymentCode}) {
    _dropProgramVaults();
    var n = 0.0;
    for (final d in ownedAddresses(restFrame, paymentCode: paymentCode)) {
      if (_isProgramVaultDest(d)) continue;
      n += _spendable[d] ?? 0;
    }
    return n;
  }

  /// Dest that actually holds reconstructed credits for a spend.
  /// Silent mining dest first when it can cover [amount]; then minted dests;
  /// then the current Flow dest. Does not walk 1..tipHeight.
  String spendFrom(String restFrame, {String? paymentCode, required double amount}) {
    final dests = <String>[];
    void add(String? a) {
      if (a == null || a.isEmpty) return;
      final k = isDestAddress(a) ? a : (payoutDest(a) ?? '');
      if (k.isEmpty || !isDestAddress(k)) return;
      if (!dests.contains(k)) dests.add(k);
    }

    add(payoutDest(paymentCode ?? ''));
    add(payoutDest(restFrame));
    for (final d in listedDests(restFrame)) {
      add(d);
    }
    for (final d in _dests) {
      add(d);
    }
    add(currentDest(restFrame));
    for (final d in dests) {
      if (spendable(d) >= amount) return d;
    }
    return dests.isNotEmpty ? dests.first : currentDest(restFrame);
  }

  /// Light dests for a pool pull. Silent mining dest + current Flow dest +
  /// minted dests. Does not walk 1..tipHeight (that hung first unlock).
  Set<String> syncDests(String restFrame, {String? paymentCode}) {
    final keys = <String>{};
    void add(String? a) {
      if (a == null || a.isEmpty) return;
      if (_isProgramVaultDest(a)) return;
      if (isDestAddress(a) || isPaymentCode(a)) keys.add(a);
    }

    add(homeDest(restFrame, paymentCode: paymentCode));
    add(currentDest(restFrame));
    add(paymentCode);
    add(payoutDest(paymentCode ?? ''));
    add(payoutDest(restFrame));
    for (final d in listedDests(restFrame)) {
      add(d);
    }
    for (final d in _dests) {
      add(d);
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
      final key = payKey(address);
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
  Future<double> syncCredits(String restFrame, {String? paymentCode}) async {
    if (pool == null) return spendableOwned(restFrame, paymentCode: paymentCode);
    keepOwnedDests(restFrame, paymentCode: paymentCode);
    final before = _settledHeight;
    try {
      await syncTip();
    } catch (_) {}
    try {
      await ingestJoinClaims(restFrame);
    } catch (_) {}
    final dests = syncDests(restFrame, paymentCode: paymentCode);
    for (final d in dests) {
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
      try {
        await syncHistory(key);
      } catch (_) {}
    }
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

  Future<List<ShearTx>> syncHistory(String address) async {
    if (pool == null) return ownerHistory(address);
    final key = payKey(address);
    if (_historyAt[key] == _sealedHeight) return ownerHistory(address);
    try {
      final json = await pool!.history(address);
      final rows = (json['txs'] as List?) ?? const [];
      final parsed = <ShearTx>[];
      for (final row in rows) {
        parsed.add(ShearTx.fromJson(Map<String, dynamic>.from(row as Map)));
      }
      for (final raw in rollupExplorerTxs(parsed)) {
        var tx = raw;
        if (tx.kind == 'hash') continue;
        final existing = _txs.cast<ShearTx?>().firstWhere((t) => t!.id == tx.id, orElse: () => null);
        var plain = existing?.memoPlain ?? tx.memoPlain;
        if (plain == null && tx.memoCt != null) {
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
          );
        }
        // Only remember dests this history was fetched for (ours).
        // Never adopt counterparty `to` on a send (that was the pool dest)
        // or `from` on a receive.
        if (payKey(tx.to) == key && tx.to.isNotEmpty && !_isProgramVaultDest(tx.to)) {
          _dests.add(tx.to);
        }
        final i = _txs.indexWhere((t) => t.id == tx.id);
        if (i >= 0) {
          _txs[i] = tx;
        } else {
          _txs.add(tx);
        }
      }
      _historyAt[key] = _sealedHeight;
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

  /// Drop dests that are not this wallet's silent dest or indexed dests.
  void keepOwnedDests(String restFrame, {String? paymentCode}) {
    final allow = <String>{
      ...listedDests(restFrame),
      if (homeDest(restFrame, paymentCode: paymentCode) != restFrame)
        homeDest(restFrame, paymentCode: paymentCode),
      if (payoutDest(paymentCode ?? '') != null) payoutDest(paymentCode ?? '')!,
      if (payoutDest(restFrame) != null) payoutDest(restFrame)!,
    };
    final drop = _dests.where((d) => !allow.contains(d) && d != restFrame).toList();
    for (final d in drop) {
      _dests.remove(d);
      _spendable.remove(d);
      _pending.remove(d);
    }
  }

  /// Stable ssa1 mailbox for this shear1 wallet (indexed dest 0).
  /// Chain dests stay ssa1 — shear1 never goes on the book.
  String homeDest(String restFrame, {String? paymentCode}) {
    if (isDestAddress(restFrame)) return restFrame;
    final indexed = destAt(restFrame, 0);
    if (indexed != null && isDestAddress(indexed) && !_isProgramVaultDest(indexed)) {
      return indexed;
    }
    final silent = payoutDest(paymentCode ?? '');
    if (silent != null && isDestAddress(silent)) return silent;
    return currentDest(restFrame);
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

  /// Recover Join payout dests from public vault history.
  /// Ownership is proven locally (view key never leaves the wallet).
  Future<void> ingestJoinClaims(String restFrame) async {
    if (pool == null || viewSecret == null || viewSecret!.isEmpty) return;
    final vault = canonicalJoinVaultDest();
    final json = await pool!.history(vault);
    final rows = (json['txs'] as List?) ?? const [];
    for (final row in rows) {
      if (row is! Map) continue;
      final k = '${row['kind'] ?? ''}';
      if (k != 'claim') continue;
      final to = '${row['to'] ?? ''}';
      final h = (row['height'] as num?)?.toInt() ?? 0;
      if (to.isEmpty || h < 1 || !isDestAddress(to)) continue;
      if (_dests.contains(to)) continue;
      final root = await continuityAtHeight(h);
      var matched = false;
      for (final hh in {h, h + 1, if (h > 1) h - 1}) {
        final mine = destForLogin(
          restFrame,
          height: hh,
          continuityRoot: root ?? lag1Root,
          viewKey: viewSecret,
        );
        if (mine == to) {
          matched = true;
          break;
        }
      }
      if (matched) rememberDest(to);
    }
  }

  String? viewSecret;

  String? destAt(String restFrame, int index) {
    final v = viewSecret;
    if (v == null || v.isEmpty) return null;
    return destAtIndex(restFrame, index: index, viewKey: v);
  }

  List<String> listedDests(String restFrame) {
    final out = <String>[];
    for (var i = 0; i < destCount; i++) {
      final d = destAt(restFrame, i);
      if (d != null) out.add(d);
    }
    return out;
  }

  String currentDest(String restFrame) {
    if (isDestAddress(restFrame)) return restFrame;
    return destForLogin(restFrame, height: tipHeight, continuityRoot: lag1Root, viewKey: viewSecret) ??
        restFrame;
  }

  /// Mint the next she1 dest. Same (shear1, password, index) always regenerates it.
  String newDest(String restFrame) {
    destCount += 1;
    destIndex = destCount - 1;
    final d = destAt(restFrame, destIndex) ?? currentDest(restFrame);
    _dests.add(d);
    return d;
  }

  void selectDest(int index) {
    if (index < 0 || index >= destCount) return;
    destIndex = index;
  }

  Set<String> ownedAddresses(String restFrame, {String? paymentCode}) {
    _dropProgramVaults();
    final keys = <String>{restFrame, ..._dests, currentDest(restFrame)};
    final silent = payoutDest(paymentCode ?? restFrame);
    if (silent != null) keys.add(silent);
    for (final d in listedDests(restFrame)) {
      keys.add(d);
      final h = hash20FromAddress(d);
      if (h != null) keys.addAll(destEncodings(h));
    }
    keys.removeWhere(_isProgramVaultDest);
    return keys;
  }

  List<ShearTx> ownerHistory(String address) {
    return _ownedRolled(address)
        .where((t) => t.kind != 'hash' && (t.confirmed || t.kind == 'send' || t.kind == 'pool-withdraw'))
        .toList();
  }

  List<ShearTx> _ownedRolled(String address) {
    final keys = ownedAddresses(address);
    final mine = _txs.where((t) {
      if (t.kind == 'sample') return false;
      return keys.contains(t.to) ||
          keys.contains(t.from) ||
          t.from == 'hash' ||
          t.from == 'coinbase' ||
          t.from == 'pending' ||
          t.from == 'pool';
    });
    return rollupExplorerTxs(mine).where((t) => t.kind != 'hash').toList();
  }

  /// Dedicated explorer list: one row per full block. Never per-hash pieces.
  List<ShearTx> shearviewTxs(String address) {
    final rows = _ownedRolled(address).where((t) {
      if (t.kind == 'hash' || t.kind == 'sample') return false;
      final h = t.height ?? 0;
      if (h < 1) return false;
      return confirmationsOf(h) >= continuumConfirmations;
    }).toList();
    rows.sort((a, b) => (b.height ?? 0).compareTo(a.height ?? 0));
    return rows;
  }

  List<ShearTx> shearviewSearch(String address, String query) {
    return shearviewTxs(address).where((t) => shearviewMatches(t, query)).toList();
  }

  /// Continuum: full blocks still filling the 6-slice pie, plus in-flight
  /// send/receive/pool-withdraw. Hash rewards never list on their own — they sit in the block.
  List<ShearTx> pendingTxs(String address) {
    final rows = _ownedRolled(address).where((t) {
      if (t.kind == 'hash' || t.kind == 'sample') return false;
      if (!t.confirmed && (t.kind == 'send' || t.kind == 'pool-withdraw')) return true;
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

  /// Snapshot claim from The Join, paid to a Continuum dest.
  ShearTx creditJoin({
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
      id: 'join-${DateTime.now().millisecondsSinceEpoch}',
      from: 'shear-join-v1',
      to: key,
      amount: amount,
      kind: 'join',
      height: height,
      confirmed: true,
    );
    _txs.add(tx);
    return tx;
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
  }) async {
    if (amount <= 0) throw ArgumentError('amount');
    if (isShearAddress(from) || isShearAddress(to)) {
      throw ArgumentError('rest_frame');
    }
    var src = from;
    var depth = 0;
    if (pool != null && !local) {
      try {
        final pressure = await pool!.mempoolPressure();
        depth = (pressure['depth'] as num?)?.toInt() ?? 0;
      } catch (_) {}
    }
    final sendKind = kind ?? (programId == 'shear-reserve-v1' ? 'lock' : 'send');
    final taxed = levyTaxed(sendKind);
    final nanos = (amount * kUnitsPerShe).round();
    final levy = taxed ? levyNanos(nanos, depth: depth) : 0;
    final needShe = amount + levy / kUnitsPerShe;
    if (spendable(src) < needShe && restFrame != null) {
      if (spendableOwned(restFrame, paymentCode: paymentCode) >= needShe) {
        src = spendFrom(restFrame, paymentCode: paymentCode, amount: needShe);
      }
    }
    if (spendable(src) < needShe) throw StateError('insufficient');
    Map<String, dynamic>? memoCt;
    if (memo != null && memo.isNotEmpty) {
      memoCt = await memoSeal(to, memo);
    }
    if (pool != null && !local) {
      String? open;
      final vk = viewSecret;
      final rest = restFrame ?? '';
      if (vk != null && vk.isNotEmpty && rest.isNotEmpty) {
        open = openingForDest(from: src, restFrame: rest, viewKey: vk, destCount: destCount);
      }
      final json = await pool!.send(from: src, to: to, amount: amount, memoCt: memoCt, open: open);
      final raw = ShearTx.fromJson(Map<String, dynamic>.from(json['tx'] as Map));
      final tx = ShearTx(
        id: raw.id,
        from: raw.from,
        to: raw.to,
        amount: raw.amount,
        kind: raw.kind,
        height: raw.height,
        confirmed: raw.confirmed,
        memo: memoCt != null || raw.memo,
        memoPlain: memo,
        memoCt: memoCt ?? raw.memoCt,
      );
      _spendable[src] = (json['fromBalance'] as num?)?.toDouble() ?? (spendable(src) - amount);
      _txs.add(tx);
      return tx;
    }
    _spendable[src] = spendable(src) - amount;
    final tx = ShearTx(
      id: 'send-${DateTime.now().millisecondsSinceEpoch}',
      from: src,
      to: to,
      amount: amount,
      kind: kind ?? (programId == 'shear-reserve-v1' ? 'lock' : 'send'),
      confirmed: false,
      memo: memoCt != null,
      memoPlain: memo,
      memoCt: memoCt,
    );
    _txs.add(tx);
    return tx;
  }

  Future<ShearTx> pullPool({
    required String login,
    required String dest,
    required double amount,
    required Uint8List seed,
  }) async {
    if (amount <= 0) throw ArgumentError('amount');
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
    final tx = ShearTx(
      id: json['tx']?['id']?.toString() ?? 'pull-${DateTime.now().millisecondsSinceEpoch}',
      from: 'pool',
      to: dest,
      amount: amount,
      kind: 'pool-withdraw',
      confirmed: false,
    );
    _txs.add(tx);
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
    if (nanos <= 0) throw ArgumentError('nanos');
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
    final tx = ShearTx(
      id: json['tx']?['id']?.toString() ?? 'pull-${DateTime.now().millisecondsSinceEpoch}',
      from: 'pool',
      to: dest,
      amount: nanos / kUnitsPerShe,
      kind: 'pool-withdraw',
      confirmed: false,
    );
    _txs.add(tx);
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
  ShearPoolClient({this.baseUrl = 'https://pool.shear.digital', HttpClient? http})
      : _http = http ?? (HttpClient()..connectionTimeout = const Duration(seconds: 8));

  final String baseUrl;
  final HttpClient _http;

  Future<Map<String, dynamic>> _get(String path) async {
    final req = await _http.getUrl(Uri.parse('$baseUrl$path'));
    final res = await req.close();
    final text = await utf8.decodeStream(res);
    return jsonDecode(text) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) async {
    final req = await _http.postUrl(Uri.parse('$baseUrl$path'));
    req.headers.contentType = ContentType.json;
    req.add(utf8.encode(jsonEncode(body)));
    final res = await req.close();
    return jsonDecode(await utf8.decodeStream(res)) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> balance(String address) =>
      _get('/api/wallet/balance?address=$address');

  Future<Map<String, dynamic>> history(String address, {String? viewKey}) =>
      _get('/api/wallet/history?address=$address${viewKey != null ? '&viewKey=$viewKey' : ''}');

  Future<Map<String, dynamic>> explorerHistory({required String viewKey, String? address}) =>
      _get('/api/explorer/history?viewKey=$viewKey${address != null ? '&address=$address' : ''}');

  Future<Map<String, dynamic>> registerView({required String address, required String viewKey}) =>
      _post('/api/wallet/register', {'address': address, 'viewKey': viewKey});

  Future<Map<String, dynamic>> send({
    required String from,
    required String to,
    required double amount,
    Map<String, dynamic>? memoCt,
    String? open,
  }) =>
      _post('/api/wallet/send', {
        'from': from,
        'to': to,
        'amount': amount,
        if (memoCt != null) 'memoCt': memoCt,
        if (open != null && open.isNotEmpty) 'open': open,
      });

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

  Future<Map<String, dynamic>> stats() => _get('/api/stats');

  /// Public header at height. No identity, view key, or shear1.
  Future<Map<String, dynamic>> headerAt(int height) =>
      _get('/api/explorer/header?height=$height');

  /// Public HASH_TX DAG. Used only to read continuity at a claim height.
  Future<Map<String, dynamic>> explorerDag() => _get('/api/explorer/dag');

  Future<Map<String, dynamic>> policy() => _get('/api/policy');

  /// Per-portal Reserve stake/idle/accrued. Not a public vortice.
  Future<Map<String, dynamic>> reservePortal(String dest) =>
      _get('/api/vault/reserve?dest=$dest');

  /// Join remaining (prior-ledger migration, no APR). Not a public vortice.
  Future<Map<String, dynamic>> joinVault({String? dest}) =>
      _get('/api/vault/join${dest != null ? '?dest=$dest' : ''}');

  Future<Map<String, dynamic>> joinClaim({required String key, required String payout}) =>
      _post('/api/join/claim', {'key': key, 'payout': payout});
}
