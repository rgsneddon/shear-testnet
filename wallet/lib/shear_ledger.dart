import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'shear_ctf.dart';
import 'shear_identity.dart';

const kSheDecimals = 11;
const kShePublicDigits = 8;
const kUnitsPerShe = 100000000000; // 10^11
/// 0.00000000001 SHE per valid hash.
const kHashBonusShe = 0.00000000001;
const kHashBonusVoteDeltaShe = 0.00000000001;

String formatShe(num she) {
  if (!she.isFinite) return '0.00000000';
  final trunc = (she * 1e8).truncateToDouble() / 1e8;
  if (trunc == 0 && she != 0) return she < 0 ? '-0.00000000' : '0.00000000';
  final s = trunc.toStringAsFixed(kShePublicDigits);
  if (RegExp(r'^-?\d+\.00000000$').hasMatch(s)) return trunc.truncate().toString();
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
      );

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
      );
}

bool _isBlockCredit(String kind) =>
    kind == 'coinbase' ||
    kind == 'hash' ||
    kind == 'pot' ||
    kind == 'mine' ||
    kind == 'blockfound';

/// 1HASH=1TX: hash txs fold into the blockfound they settled on.
List<ShearTx> rollupDestTxs(Iterable<ShearTx> txs) {
  final rest = <ShearTx>[];
  final blocks = <String, ShearTx>{};
  for (final t in txs) {
    if (!_isBlockCredit(t.kind)) {
      rest.add(t);
      continue;
    }
    final height = t.height ?? 0;
    final key = '${t.to}|$height';
    final prev = blocks[key];
    var pot = prev?.amount ?? 0;
    var hashAmt = prev?.hashAmount ?? 0;
    var threads = prev?.threads ?? 0;
    if (t.kind == 'hash') {
      hashAmt += t.amount;
      threads += t.threads ?? (t.amount / kHashBonusShe).round();
    } else if (t.kind == 'blockfound' || t.kind == 'mine') {
      final ha = t.hashAmount ?? 0;
      pot += t.amount - ha;
      hashAmt += ha;
      threads += t.threads ?? t.rounds ?? 0;
    } else {
      pot += t.amount;
    }
    blocks[key] = ShearTx(
      id: t.to.isEmpty ? 'blockfound:$height' : 'blockfound:$height:${t.to}',
      from: 'coinbase',
      to: t.to,
      amount: pot + hashAmt,
      kind: 'blockfound',
      height: height,
      confirmed: true,
      hashAmount: hashAmt,
      threads: threads,
    );
  }
  return [...rest, ...blocks.values];
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

  /// Last found/sealed block height (Continuum header).
  int get sealedHeight => _sealedHeight;

  /// Read lag-1 continuity from a 120-byte tip header. Next dest uses sealedHeight+1.
  void applyTipHeader(Uint8List header, {required int sealedHeight}) {
    lag1Root = lag1ContinuityFromHeader(header);
    tipHeight = sealedHeight < 1 ? 1 : sealedHeight + 1;
    if (sealedHeight > _sealedHeight) _sealedHeight = sealedHeight;
  }

  void applyTipHex(String headerHex, {required int sealedHeight}) {
    final raw = headerFromHex(headerHex);
    if (raw == null) {
      if (sealedHeight >= 1) tipHeight = sealedHeight + 1;
      return;
    }
    applyTipHeader(raw, sealedHeight: sealedHeight);
  }

  Iterable<ShearTx> get transactions => List.unmodifiable(_txs);

  String payKey(String address) {
    if (isDestAddress(address)) return address;
    final silent = payoutDest(address);
    if (silent != null) return silent;
    return currentDest(address);
  }

  double spendable(String address) => _spendable[payKey(address)] ?? _spendable[address] ?? 0;
  double pending(String address) => _pending[payKey(address)] ?? _pending[address] ?? 0;

  /// Accrue 0.00000000001 SHE per hash this open round. Not spendable, not an explorer row.
  void creditHash(String address, {int hashes = 1}) {
    final add = hashes * kHashBonusShe;
    final key = payKey(address);
    _pending[key] = (_pending[key] ?? 0) + add;
  }

  /// Block found: pending hash bonus + pot become spendable and explorer-visible.
  ShearTx confirmRound({
    required String address,
    double pot = 0,
    int height = 0,
  }) {
    final dest = payKey(address);
    final bonus = dest == address
        ? (_pending[address] ?? 0)
        : (_pending[dest] ?? 0) + (_pending[address] ?? 0);
    final total = bonus + pot;
    _pending[dest] = 0;
    if (dest != address) _pending[address] = 0;
    if (total > 0) {
      _spendable[dest] = (_spendable[dest] ?? 0) + total;
    }
    _dests.add(dest);
    final tx = ShearTx(
      id: 'round-$height-$dest',
      from: 'coinbase',
      to: dest,
      amount: total,
      kind: 'coinbase',
      height: height,
      confirmed: true,
    );
    if (total > 0) _txs.add(tx);
    if (height > _sealedHeight) _sealedHeight = height;
    for (var i = 0; i < _txs.length; i++) {
      if (_txs[i].confirmed) continue;
      _txs[i] = _txs[i].copyWith(confirmed: true, height: _txs[i].height ?? height);
    }
    prune();
    return tx;
  }

  /// Drop hash-sample noise. Keep sealed confirmed transfers + in-flight sends.
  void prune() {
    final seen = <String>{};
    final next = <ShearTx>[];
    for (final t in _txs) {
      if (t.kind == 'sample') continue;
      if (!t.confirmed && t.kind != 'send') continue;
      if (!seen.add(t.id)) continue;
      next.add(t);
    }
    _txs
      ..clear()
      ..addAll(rollupDestTxs(next));
  }

  void rememberSpendable(String address, double amount) {
    if (amount > spendable(address)) _spendable[address] = amount;
  }

  Future<void> syncTip() async {
    if (pool == null) return;
    try {
      final json = await pool!.stats();
      final sealed = (json['height'] as num?)?.toInt() ?? 0;
      final hex = json['header']?.toString() ?? '';
      applyTipHex(hex, sealedHeight: sealed);
    } catch (_) {}
  }

  Future<double> syncSpendable(String address) async {
    final prev = spendable(address);
    if (pool == null) return prev;
    try {
      await syncTip();
      final json = await pool!.balance(address);
      final live = (json['balance'] as num?)?.toDouble() ?? 0;
      _pending[address] = (json['pending'] as num?)?.toDouble() ?? 0;
      if (live > 0) {
        _spendable[address] = live;
        return live;
      }
      return prev;
    } catch (_) {
      return prev;
    }
  }

  double spendableOwned(String restFrame, {String? paymentCode}) {
    var n = 0.0;
    for (final d in ownedAddresses(restFrame, paymentCode: paymentCode)) {
      n += _spendable[d] ?? 0;
    }
    return n;
  }

  /// Pull Continuum from every dest this identity owns, including the
  /// she1→shp1 mining dest. Revolving dests stay for Flow; mining credits
  /// land on the silent dest.
  int _histAt = -1;

  Future<double> syncCredits(String restFrame, {String? paymentCode}) async {
    if (pool == null) return spendableOwned(restFrame, paymentCode: paymentCode);
    try {
      await syncTip();
    } catch (_) {}
    final dests = <String>{};
    final silent = payoutDest(paymentCode ?? restFrame);
    if (silent != null) dests.add(silent);
    dests.add(currentDest(restFrame));
    final pullHistory = sealedHeight != _histAt;
    for (final d in dests) {
      try {
        final json = await pool!.balance(d);
        final live = (json['balance'] as num?)?.toDouble() ?? 0;
        _pending[d] = (json['pending'] as num?)?.toDouble() ?? 0;
        if (live > 0) _spendable[d] = live;
        if (pullHistory) await syncHistory(d);
      } catch (_) {}
    }
    if (pullHistory) _histAt = sealedHeight;
    return spendableOwned(restFrame, paymentCode: paymentCode);
  }

  Future<List<ShearTx>> syncHistory(String address) async {
    if (pool == null) return ownerHistory(address);
    try {
      final json = await pool!.history(address);
      final rows = (json['txs'] as List?) ?? const [];
      final incoming = <ShearTx>[];
      for (final row in rows) {
        var tx = ShearTx.fromJson(Map<String, dynamic>.from(row as Map));
        if (tx.memoCt != null && tx.memoPlain == null) {
          final plain = await memoOpen(tx.to, tx.memoCt);
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
              rounds: tx.rounds,
            );
          }
        }
        incoming.add(tx);
      }
      final byId = <String, ShearTx>{for (final t in _txs) t.id: t};
      for (final tx in incoming) {
        byId[tx.id] = tx;
      }
      _txs
        ..clear()
        ..addAll(rollupDestTxs(byId.values));
    } catch (_) {}
    prune();
    return ownerHistory(address);
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
    final keys = <String>{restFrame, ..._dests, currentDest(restFrame)};
    final silent = payoutDest(paymentCode ?? restFrame);
    if (silent != null) {
      keys.add(silent);
      final sh = hash20FromAddress(silent);
      if (sh != null) keys.addAll(destEncodings(sh));
    }
    for (final d in listedDests(restFrame)) {
      keys.add(d);
      final h = hash20FromAddress(d);
      if (h != null) keys.addAll(destEncodings(h));
    }
    return keys;
  }

  List<ShearTx> ownerHistory(String address, {String? paymentCode}) {
    final keys = ownedAddresses(address, paymentCode: paymentCode);
    final rows = _txs
        .where((t) => (t.confirmed || t.kind == 'send') && (keys.contains(t.to) || keys.contains(t.from)))
        .toList();
    rows.sort((a, b) => (b.height ?? 0).compareTo(a.height ?? 0));
    return rows;
  }

  /// Unconfirmed transfers. Cleared when the next block is found ([confirmRound]).
  List<ShearTx> pendingTxs(String address, {String? paymentCode}) {
    final keys = ownedAddresses(address, paymentCode: paymentCode);
    return _txs
        .where((t) => !t.confirmed && t.kind != 'sample' && (keys.contains(t.to) || keys.contains(t.from)))
        .toList();
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
  }) async {
    if (amount <= 0) throw ArgumentError('amount');
    final payFrom = payoutDest(from) ?? from;
    final payTo = payoutDest(to) ?? to;
    if (isShearAddress(payFrom) || isShearAddress(payTo)) {
      throw ArgumentError('rest_frame');
    }
    if (!isDestAddress(payFrom) || !isDestAddress(payTo)) {
      throw ArgumentError('bad_dest');
    }
    if (spendable(payFrom) < amount && spendable(from) < amount) {
      throw StateError('insufficient');
    }
    Map<String, dynamic>? memoCt;
    if (memo != null && memo.isNotEmpty) {
      memoCt = await memoSeal(payTo, memo);
    }
    if (pool != null && !local) {
      final json = await pool!.send(from: payFrom, to: payTo, amount: amount, memoCt: memoCt);
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
      _spendable[payFrom] = (json['fromBalance'] as num?)?.toDouble() ?? (spendable(payFrom) - amount);
      _txs.add(tx);
      return tx;
    }
    _spendable[payFrom] = spendable(payFrom) - amount;
    final tx = ShearTx(
      id: 'send-${DateTime.now().millisecondsSinceEpoch}',
      from: payFrom,
      to: payTo,
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
  }) =>
      _post('/api/wallet/send', {
        'from': from,
        'to': to,
        'amount': amount,
        if (memoCt != null) 'memoCt': memoCt,
      });

  Future<Map<String, dynamic>> stats() => _get('/api/stats');
}
