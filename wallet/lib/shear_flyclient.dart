import 'dart:convert';
import 'dart:io';
import 'dart:math';

/// Quiet FlyClient node-find. The wallet is not a full node; it mirrors
/// headers and stats the node relays. Not a 1s node-scan and not an archive.
const kFlyDefaultSeed = 'https://pool.shear.digital';

/// Logarithmic header heights: 1, 2, 4, … tip.
List<int> flyclientSampleHeights(int tip) {
  if (tip < 1) return const [];
  final out = <int>{};
  var h = 1;
  while (h < tip && h > 0) {
    out.add(h);
    final next = h * 2;
    if (next <= h) break;
    h = next;
  }
  out.add(tip);
  final list = out.toList()..sort();
  return list;
}

/// Honesty is proven FlyClient samples vs the logarithmic set at the claimed tip.
/// Never returns HONEST unless [live] and [proven] >= [wanted] > 0.
String walletHonestyText({
  required bool live,
  required int proven,
  required int wanted,
  int failures = 0,
}) {
  if (live && wanted > 0 && proven >= wanted) return 'HONEST';
  if (!live && failures > 0) return 'OFFLINE';
  if (wanted > 0 && proven < wanted) return 'SYNCING $proven/$wanted';
  return 'SYNCING';
}

class ShearFlyClient {
  ShearFlyClient({
    List<String>? seeds,
    this.userUrl,
    HttpClient? http,
    this.jitter = const Duration(milliseconds: 400),
    Random? random,
  })  : seeds = List<String>.unmodifiable(_dedupe([
          if (userUrl != null && userUrl.trim().isNotEmpty) userUrl,
          if (seeds == null) kFlyDefaultSeed else ...seeds,
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
  /// Bitcoin Core–shaped: want every relayed header 1…tip, not only the locator.
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

  /// Skip rediscovery while a live base is known, or while exponential backoff
  /// is in force after a failed probe.
  Future<String?> ensureLive() async {
    if (liveBase != null) return liveBase;
    final until = _backoffUntil;
    if (until != null && DateTime.now().isBefore(until)) return null;
    return findLiveNode();
  }

  /// Locator samples, then header catch-up 1…tip like Bitcoin Core IBD.
  /// Already-proven heights are skipped so the 1s timer is not a rescan.
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
    await _proveAt(base, tip);
    await _catchUpHeaders(base, tip);
  }

  /// One jittered probe of the seed list. Exponential backoff is recorded on
  /// fail so the 1s Continuum timer does not scan nodes.
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

  Future<int> _proveAt(String base, int tip) async {
    var n = 0;
    for (final h in flyclientSampleHeights(tip)) {
      if (_proven.contains(h)) {
        n++;
        continue;
      }
      final hdr = await _get(base, '/api/explorer/header?height=$h');
      final hex = hdr?['header']?.toString() ?? '';
      if (hex.isEmpty) continue;
      _proven.add(h);
      n++;
    }
    sampledTip = tip;
    return n;
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
    final proven = await _proveAt(base, tip);
    if (proven == 0) return -1;
    return tip * 1000 + proven;
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
