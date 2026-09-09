import 'dart:convert';
import 'dart:io';
import 'dart:math';

/// FlyClient locators: O(log tip) header samples, not a 1…tip flood.
const kWalletDefaultSeed = 'https://pool.shear.digital';
/// Prefer a local node/pool when one is running (0.28 / kit source).
const kLocalPoolHttp = 'http://127.0.0.1:8088';
const kLocalNodeRpc = 'http://127.0.0.1:18332';

/// Logarithmic header heights: 1, 2, 4, … tip (genesis + tip always).
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

/// Fill 0..1 of FlyClient samples vs the locator set.
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
  /// Header hex at height 1. Identifies the live book after a chain reset.
  String? genesisHex;

  int get provenHeaders =>
      flyclientSampleHeights(sampledTip).where(_proven.contains).length;
  int get wantedHeaders => flyclientSampleHeights(sampledTip).length;
  int get failures => _failures;
  bool get honest =>
      liveBase != null &&
      wantedHeaders > 0 &&
      flyclientSampleHeights(sampledTip).every(_proven.contains);

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

  DateTime? _lastFindAt;
  static const _refindEvery = Duration(seconds: 60);

  /// Read missing headers only. Once 1…tip is proven, a tick is `/api/stats`.
  /// Does not re-probe every seed on every call (that stalled the pool).
  Future<void> followTip() async {
    final now = DateTime.now();
    final staleFind = _lastFindAt == null || now.difference(_lastFindAt!) >= _refindEvery;
    final String? base;
    if (liveBase == null || staleFind) {
      base = await findLiveNode();
      _lastFindAt = now;
    } else {
      base = await ensureLive();
    }
    if (base == null) return;
    final stats = await _get(base, '/api/stats');
    if (stats == null) {
      noteFailure();
      return;
    }
    final tip = (stats['height'] as num?)?.toInt() ?? 0;
    if (tip < 1) return;
    final chainMovedBack = sampledTip > 0 && tip < sampledTip;
    if (genesisHex == null || chainMovedBack || !_proven.contains(1)) {
      final genesis = await _genesisOf(base);
      if (genesis.isNotEmpty && genesisHex != null && genesis != genesisHex) {
        _proven.clear();
        sampledTip = 0;
      }
      if (genesis.isNotEmpty) genesisHex = genesis;
    }
    sampledTip = tip;
    if (honest && tip <= sampledTip && _proven.contains(1)) {
      return;
    }
    await _proveSamples(base, tip);
  }

  Future<String?> findLiveNode() async {
    if (jitter > Duration.zero) {
      final cap = jitter.inMilliseconds;
      if (cap > 0) {
        await Future<void>.delayed(Duration(milliseconds: _rng.nextInt(cap + 1)));
      }
    }
    final probes = <String, ({int height, String genesis})>{};
    for (final seed in seeds) {
      final p = await _probe(seed);
      if (p != null) probes[seed] = p;
    }
    if (probes.isEmpty) {
      _failures++;
      final shift = (_failures - 1).clamp(0, 6);
      _backoffUntil = DateTime.now().add(Duration(milliseconds: 1000 * (1 << shift)));
      liveBase = null;
      return null;
    }
    String? genesisOf(String? url) {
      if (url == null || url.isEmpty) return null;
      return probes[_norm(url)]?.genesis;
    }

    // Canonical public/user seed wins over a taller leftover local book.
    final want = genesisOf(userUrl) ??
        genesisOf(kWalletDefaultSeed) ??
        genesisOf(kLocalPoolHttp) ??
        genesisHex;
    String? best;
    var bestH = -1;
    for (final e in probes.entries) {
      if (want != null && want.isNotEmpty && e.value.genesis != want) continue;
      if (e.value.height > bestH) {
        bestH = e.value.height;
        best = e.key;
      }
    }
    best ??= probes.entries.reduce((a, b) => a.value.height >= b.value.height ? a : b).key;
    final gotGenesis = want ?? probes[best]!.genesis;
    if (genesisHex != null && gotGenesis.isNotEmpty && gotGenesis != genesisHex) {
      _proven.clear();
      sampledTip = 0;
    }
    if (gotGenesis.isNotEmpty) genesisHex = gotGenesis;
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

  Future<void> _proveSamples(String base, int tip) async {
    for (final h in flyclientSampleHeights(tip)) {
      if (_proven.contains(h)) continue;
      final hdr = await _get(base, '/api/explorer/header?height=$h');
      final hex = hdr?['header']?.toString() ?? '';
      if (hex.isEmpty) continue;
      if (h == 1) {
        final g = hex.toLowerCase();
        if (genesisHex != null && genesisHex != g) {
          _proven.clear();
        }
        genesisHex = g;
      }
      _proven.add(h);
    }
    sampledTip = tip;
  }

  Future<({int height, String genesis})?> _probe(String base) async {
    final stats = await _get(base, '/api/stats');
    if (stats == null) return null;
    final tip = (stats['height'] as num?)?.toInt() ?? 0;
    if (tip < 1) return null;
    var genesis = await _genesisOf(base);
    if (genesis.isEmpty) genesis = (stats['header']?.toString() ?? '').toLowerCase();
    return (height: tip, genesis: genesis);
  }

  Future<String> _genesisOf(String base) async {
    final batch = await _get(base, '/api/explorer/headers?from=1&to=1');
    final rows = batch?['headers'];
    if (rows is List && rows.isNotEmpty && rows.first is Map) {
      final hex = (rows.first as Map)['header']?.toString() ?? '';
      if (hex.isNotEmpty) return hex.toLowerCase();
    }
    final hdr = await _get(base, '/api/explorer/header?height=1');
    return (hdr?['header']?.toString() ?? '').toLowerCase();
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
