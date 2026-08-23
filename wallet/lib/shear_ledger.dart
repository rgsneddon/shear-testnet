import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'shear_ctf.dart';

class ShearTx {
  const ShearTx({
    required this.id,
    required this.from,
    required this.to,
    required this.amount,
    required this.kind,
    this.height,
    this.confirmed = true,
  });

  final String id;
  final String from;
  final String to;
  final double amount;
  final String kind;
  final int? height;
  final bool confirmed;

  Map<String, dynamic> toJson() => {
        'id': id,
        'from': from,
        'to': to,
        'amount': amount,
        'kind': kind,
        'height': height,
        'confirmed': confirmed,
      };

  factory ShearTx.fromJson(Map<String, dynamic> j) => ShearTx(
        id: j['id']?.toString() ?? '',
        from: j['from']?.toString() ?? '',
        to: j['to']?.toString() ?? '',
        amount: (j['amount'] as num?)?.toDouble() ?? 0,
        kind: j['kind']?.toString() ?? '',
        height: (j['height'] as num?)?.toInt(),
        confirmed: j['confirmed'] is bool ? j['confirmed'] as bool : true,
      );
}

/// Spendable at block-found only. Per-hash credit sits in [pending] until confirm.
class ShearLedger {
  ShearLedger({this.pool});

  final ShearPoolClient? pool;
  final Map<String, double> _spendable = {};
  final Map<String, double> _pending = {};
  final List<ShearTx> _txs = [];
  final Set<String> _dests = {};
  int tipHeight = 1;
  Uint8List? lag1Root;

  Iterable<ShearTx> get transactions => List.unmodifiable(_txs);

  double spendable(String address) => _spendable[address] ?? 0;
  double pending(String address) => _pending[address] ?? 0;

  /// Accrue 1e-9 SHE per hash this open round. Not spendable, not an explorer row.
  void creditHash(String address, {int hashes = 1}) {
    final add = hashes * 1e-9;
    _pending[address] = pending(address) + add;
  }

  /// Block found: pending hash bonus + pot become spendable and explorer-visible.
  ShearTx confirmRound({
    required String address,
    double pot = 0,
    int height = 0,
  }) {
    final bonus = pending(address);
    final total = bonus + pot;
    _pending[address] = 0;
    if (total > 0) {
      _spendable[address] = spendable(address) + total;
    }
    final dest = destForLogin(address, height: height > 0 ? height : tipHeight, continuityRoot: lag1Root);
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
      ..addAll(next);
  }

  void rememberSpendable(String address, double amount) {
    if (amount > spendable(address)) _spendable[address] = amount;
  }

  Future<double> syncSpendable(String address) async {
    final prev = spendable(address);
    if (pool == null) return prev;
    try {
      final json = await pool!.balance(address);
      final live = (json['balance'] as num?)?.toDouble() ?? 0;
      _pending[address] = (json['pending'] as num?)?.toDouble() ?? 0;
      final h = (json['height'] as num?)?.toInt();
      if (h != null && h > 0) tipHeight = h;
      if (live > 0) {
        _spendable[address] = live;
        return live;
      }
      return prev;
    } catch (_) {
      return prev;
    }
  }

  Future<List<ShearTx>> syncHistory(String address) async {
    if (pool == null) return ownerHistory(address);
    try {
      final json = await pool!.history(address);
      final rows = (json['txs'] as List?) ?? const [];
      for (final row in rows) {
        final tx = ShearTx.fromJson(Map<String, dynamic>.from(row as Map));
        final i = _txs.indexWhere((t) => t.id == tx.id);
        if (i >= 0) {
          _txs[i] = tx;
        } else {
          _txs.add(tx);
        }
      }
    } catch (_) {}
    prune();
    return ownerHistory(address);
  }

  String currentDest(String restFrame) =>
      destForLogin(restFrame, height: tipHeight, continuityRoot: lag1Root);

  Set<String> ownedAddresses(String restFrame) => {
        restFrame,
        currentDest(restFrame),
        ..._dests,
      };

  List<ShearTx> ownerHistory(String address) {
    final keys = ownedAddresses(address);
    return _txs.where((t) => t.confirmed && (keys.contains(t.to) || keys.contains(t.from))).toList();
  }

  Future<ShearTx> send({
    required String from,
    required String to,
    required double amount,
  }) async {
    if (amount <= 0) throw ArgumentError('amount');
    if (spendable(from) < amount) throw StateError('insufficient');
    if (pool != null) {
      final json = await pool!.send(from: from, to: to, amount: amount);
      final tx = ShearTx.fromJson(Map<String, dynamic>.from(json['tx'] as Map));
      _spendable[from] = (json['fromBalance'] as num?)?.toDouble() ?? (spendable(from) - amount);
      _txs.add(tx);
      return tx;
    }
    _spendable[from] = spendable(from) - amount;
    final tx = ShearTx(
      id: 'send-${DateTime.now().millisecondsSinceEpoch}',
      from: from,
      to: to,
      amount: amount,
      kind: 'send',
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
  }) {
    _spendable[address] = spendable;
    _pending[address] = pending;
    _txs
      ..clear()
      ..addAll(txs);
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
  }) =>
      _post('/api/wallet/send', {'from': from, 'to': to, 'amount': amount});

  Future<Map<String, dynamic>> stats() => _get('/api/stats');
}
