import 'dart:convert';
import 'dart:io';
import 'dart:math';

/// Wallet reads headers 1…tip from a live node/pool. Not FlyClient locators.
const kWalletDefaultSeed = 'https://pool.shear.digital';
/// Prefer a local node/pool when one is running (0.28 / kit source).
const kLocalPoolHttp = 'http://127.0.0.1:8088';
const kLocalNodeRpc = 'http://127.0.0.1:18332';

/// Fill 0..1 of headers read vs headers 1…tip.
double walletSyncFill({required int proven, required int wanted}) {
  if (wanted <= 0) return 0;
  if (proven >= wanted) return 1;
  return (proven / wanted).clamp(0.0, 1.0);
}

int walletSyncPercent({required int proven, required int wanted}) {
  return (walletSyncFill(proven: proven, wanted: wanted) * 100).floor().clamp(0, 100);
}

/// Sync label. Never paints HONEST. No fill bar.
String walletHonestyText({
  required bool live,
  required int proven,
  required int wanted,
  int failures = 0,
}) {
  if (!live && failures > 0) return 'no network';
  if (!live && wanted <= 0) return 'no network';
  final pct = walletSyncPercent(proven: proven, wanted: wanted);
  if (pct >= 100) return '100% synchronised';
  return '$pct% synchronising...';
}

class ShearReadSync {
  ShearReadSync({
    List<String>? seeds,
    this.userUrl,
    HttpClient? http,
    this.jitter = const Duration(milliseconds: 400),
    Random? random,
  })  : seeds = List<String>.unmodifiable(_dedupe([
          if (userUrl != null && userUrl.trim().isNotEmpty) userUrl,
          if (seeds == null) ...[kLocalPoolHttp, kLocalNodeRpc, kWalletDefaultSeed] else ...seeds,
        ])),
        _http = http ?? (HttpClient()..connectionTimeout = const Duration(seconds: 8)),
        _rng = random ?? Random();

  final List<String> seeds;
  final String? userUrl;
  final Duration jitter;
  final HttpClient _http;
  final Random _rng;

  String? liveBase;
  DateTime? _backoffUntil;
  int _failures = 0;
  final Set<int> _proven = {};
  int sampledTip = 0;

  int get provenHeaders => _proven.length;
  int get wantedHeaders => sampledTip < 1 ? 0 : sampledTip;
  int get failures => _failures;
  bool get honest =>
      liveBase != null && wantedHeaders > 0 && provenHeaders >= wantedHeaders;

  String honestyText() => walletHonestyText(
        live: liveBase != null,
        proven: provenHeaders,
        wanted: wantedHeaders,
        failures: _failures,
      );

  static List<String> _dedupe(Iterable<String> raw) {
    final out = <String>[];
    final seen = <String>{};
    for (final u in raw) {
      final n = _norm(u);
      if (n.isEmpty || seen.contains(n)) continue;
      seen.add(n);
      out.add(n);
    }
    return out;
  }

  static String _norm(String url) {
    var s = url.trim();
    if (s.endsWith('/')) s = s.substring(0, s.length - 1);
    return s;
  }

  Future<String?> ensureLive() async {
    if (liveBase != null) return liveBase;
    final until = _backoffUntil;
    if (until != null && DateTime.now().isBefore(until)) return null;
    return findLiveNode();
  }

  /// Read every header 1…tip (paged). Already-read heights are skipped.
  Future<void> followTip() async {
    final base = await ensureLive();
    if (base == null) return;
    final stats = await _get(base, '/api/stats');
    if (stats == null) {
      noteFailure();
      return;
    }
    final tip = (stats['height'] as num?)?.toInt() ?? 0;
    if (tip < 1) return;
    await _catchUpHeaders(base, tip);
  }

  Future<String?> findLiveNode() async {
    if (jitter > Duration.zero) {
      final cap = jitter.inMilliseconds;
      if (cap > 0) {
        await Future<void>.delayed(Duration(milliseconds: _rng.nextInt(cap + 1)));
      }
    }
    String? best;
    var bestScore = -1;
    for (final seed in seeds) {
      final score = await _score(seed);
      if (score > bestScore) {
        bestScore = score;
        best = seed;
      }
    }
    if (best == null || bestScore < 0) {
      _failures++;
      final shift = (_failures - 1).clamp(0, 6);
      _backoffUntil = DateTime.now().add(Duration(milliseconds: 1000 * (1 << shift)));
      liveBase = null;
      return null;
    }
    _failures = 0;
    _backoffUntil = null;
    liveBase = best;
    return best;
  }

  void noteFailure() {
    liveBase = null;
    _failures++;
    final shift = (_failures - 1).clamp(0, 6);
    _backoffUntil = DateTime.now().add(Duration(milliseconds: 1000 * (1 << shift)));
  }

  Future<void> _catchUpHeaders(String base, int tip) async {
    var h = 1;
    while (h <= tip) {
      if (_proven.contains(h)) {
        h++;
        continue;
      }
      final to = h + 1999 > tip ? tip : h + 1999;
      final batch = await _get(base, '/api/explorer/headers?from=$h&to=$to');
      final rows = batch?['headers'];
      if (rows is List && rows.isNotEmpty) {
        for (final row in rows) {
          if (row is! Map) continue;
          final hh = (row['height'] as num?)?.toInt() ?? 0;
          final hex = row['header']?.toString() ?? '';
          if (hh > 0 && hex.isNotEmpty) _proven.add(hh);
        }
        h = to + 1;
        continue;
      }
      final hdr = await _get(base, '/api/explorer/header?height=$h');
      final hex = hdr?['header']?.toString() ?? '';
      if (hex.isNotEmpty) _proven.add(h);
      h++;
    }
    sampledTip = tip;
  }

  Future<int> _score(String base) async {
    final stats = await _get(base, '/api/stats');
    if (stats == null) return -1;
    final tip = (stats['height'] as num?)?.toInt() ?? 0;
    if (tip < 1) return -1;
    return tip;
  }

  Future<Map<String, dynamic>?> _get(String base, String path) async {
    try {
      final req = await _http.getUrl(Uri.parse('$base$path'));
      final res = await req.close();
      if (res.statusCode < 200 || res.statusCode >= 300) {
        await res.drain<void>();
        return null;
      }
      final decoded = jsonDecode(await utf8.decodeStream(res));
      if (decoded is Map<String, dynamic>) return decoded;
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
      return null;
    } catch (_) {
      return null;
    }
  }
}
