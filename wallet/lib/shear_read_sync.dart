import 'dart:convert';
import 'dart:io';
import 'dart:math';

/// Wallet default is the local node RPC. Public pool HTTP is an advanced toggle
/// (`userUrl`) with the IP warning — never the stock send path.
const kWalletDefaultSeed = 'http://127.0.0.1:18332';
const kLocalPoolHttp = 'http://127.0.0.1:8088';
const kLocalNodeRpc = 'http://127.0.0.1:18332';
const kPublicPoolHttp = 'https://pool.shear.digital';
/// Live book. Frozen shear-testnet-v2 is a different book — never follow it.
const kBookMagic = 'shear-testnet-v3';

/// True only for the live v3 book. A taller leftover v2 node is dropped.
bool isV3BookStats(Map<String, dynamic> stats) {
  final blob = [
    stats['magic'],
    stats['network'],
    stats['bookLawFingerprint'],
  ].map((e) => '${e ?? ''}').join(' ');
  if (blob.contains('shear-testnet-v2')) return false;
  if (blob.contains('shear-testnet-v1')) return false;
  return blob.contains(kBookMagic);
}

/// Header page size matching node `HEADERS_PAGE`.
const kNodeSyncHeaderPage = 2000;

/// Compact-block page size matching node RPC `getblocks` cap.
const kNodeSyncBlockPage = 64;

/// Test-only logarithmic locator list (old FlyClient sampler).
/// Not the send / balance / history / tip-proof path.
List<int> flyclientSampleHeightsForTest(int tip) {
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

/// Inclusive height range for one node-sync header/block page.
List<int> nodeSyncHeights(int from, int tip, {int page = kNodeSyncHeaderPage}) {
  if (tip < 1) return const [];
  final start = from < 1 ? 1 : from;
  if (start > tip) return const [];
  final end = start + page - 1 > tip ? tip : start + page - 1;
  return [for (var h = start; h <= end; h++) h];
}

/// Fill 0..1 of proven headers vs the live tip.
double walletSyncFill({required int proven, required int wanted}) {
  if (wanted <= 0) return 0;
  if (proven >= wanted) return 1;
  return (proven / wanted).clamp(0.0, 1.0);
}

int walletSyncPercent({required int proven, required int wanted}) {
  return (walletSyncFill(proven: proven, wanted: wanted) * 100).floor().clamp(0, 100);
}

/// Sync label. Never paints HONEST. Never a stuck "no network".
String walletHonestyText({
  required bool live,
  required int proven,
  required int wanted,
  int failures = 0,
  int height = 0,
}) {
  if (!live && failures == 0 && wanted <= 0) return 'connecting…';
  if (!live) return 'looking for a v3 node…';
  final pct = walletSyncPercent(proven: proven, wanted: wanted);
  final h = height > 0 ? height : wanted;
  if (pct >= 100) return h > 0 ? 'synchronised · $h' : 'synchronised';
  if (h > 0) return '$pct% synchronising · $h';
  return '$pct% synchronising…';
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
          if (seeds == null) ...[kLocalNodeRpc, kLocalPoolHttp, kPublicPoolHttp] else ...seeds,
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
  final Set<int> _compactProven = {};
  String? jrootHex;
  int sampledTip = 0;

  /// Header hex at height 1. Identifies the live book after a chain reset.
  String? genesisHex;

  int get provenHeaders => sampledTip < 1
      ? 0
      : [for (var h = 1; h <= sampledTip; h++) h].where(_proven.contains).length;
  int get wantedHeaders => sampledTip < 1 ? 0 : sampledTip;
  int get provenCompactBlocks => sampledTip < 1
      ? 0
      : [for (var h = 1; h <= sampledTip; h++) h].where(_compactProven.contains).length;
  int get failures => _failures;
  bool get honest =>
      liveBase != null &&
      wantedHeaders > 0 &&
      provenHeaders >= wantedHeaders &&
      provenCompactBlocks >= wantedHeaders &&
      (jrootHex != null && jrootHex!.isNotEmpty);

  String honestyText() => walletHonestyText(
        live: liveBase != null,
        proven: provenHeaders,
        wanted: wantedHeaders,
        failures: _failures,
        height: sampledTip,
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

  /// Headers 1…tip + compact blocks + jroot from the local (or configured) node.
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
    final stats = await _getFirst(base, const ['/stats', '/api/stats']);
    if (stats == null) {
      noteFailure();
      return;
    }
    final tip = (stats['height'] as num?)?.toInt() ?? 0;
    if (tip < 1) return;
    final genesis = await _genesisOf(base);
    if (genesis.isNotEmpty && genesisHex != null && genesis != genesisHex) {
      _proven.clear();
      _compactProven.clear();
      jrootHex = null;
      sampledTip = 0;
    }
    if (genesis.isNotEmpty) genesisHex = genesis;
    sampledTip = tip;
    if (honest) return;
    await _proveHeaders(base, tip);
    await _proveCompactBlocks(base, tip);
    await _proveJroot(base);
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

    // Canonical user/local seed wins over a taller leftover book.
    String? want = genesisOf(userUrl) ?? genesisOf(kWalletDefaultSeed) ?? genesisHex;
    if (want == null || want.isEmpty) {
      for (var i = seeds.length - 1; i >= 0; i--) {
        final g = probes[seeds[i]]?.genesis;
        if (g != null && g.isNotEmpty) {
          want = g;
          break;
        }
      }
    }
    String? best;
    var bestH = -1;
    for (final e in probes.entries) {
      if (want != null && want.isNotEmpty && e.value.genesis != want) continue;
      if (e.value.height > bestH) {
        bestH = e.value.height;
        best = e.key;
      }
    }
    if (best == null) {
      _failures++;
      final shift = (_failures - 1).clamp(0, 6);
      _backoffUntil = DateTime.now().add(Duration(milliseconds: 1000 * (1 << shift)));
      liveBase = null;
      return null;
    }
    final gotGenesis = want ?? probes[best]!.genesis;
    if (genesisHex != null && gotGenesis.isNotEmpty && gotGenesis != genesisHex) {
      _proven.clear();
      _compactProven.clear();
      jrootHex = null;
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

  Future<void> _proveHeaders(String base, int tip) async {
    for (var from = 1; from <= tip; from += kNodeSyncHeaderPage) {
      final to = from + kNodeSyncHeaderPage - 1 > tip ? tip : from + kNodeSyncHeaderPage - 1;
      var need = false;
      for (var h = from; h <= to; h++) {
        if (!_proven.contains(h)) {
          need = true;
          break;
        }
      }
      if (!need) continue;
      final batch = await _getFirst(base, [
        '/headers?from=$from&to=$to',
        '/api/explorer/headers?from=$from&to=$to',
      ]);
      final rows = batch?['headers'];
      if (rows is List) {
        for (final row in rows) {
          if (row is! Map) continue;
          final h = (row['height'] as num?)?.toInt() ?? 0;
          final hex = row['header']?.toString() ?? '';
          if (h < 1 || hex.isEmpty) continue;
          if (h == 1) {
            final g = hex.toLowerCase();
            if (genesisHex != null && genesisHex != g) {
              _proven.clear();
              _compactProven.clear();
            }
            genesisHex = g;
          }
          _proven.add(h);
        }
      }
      for (var h = from; h <= to; h++) {
        if (_proven.contains(h)) continue;
        final hdr = await _getFirst(base, [
          '/header?height=$h',
          '/api/explorer/header?height=$h',
        ]);
        final hex = hdr?['header']?.toString() ?? '';
        if (hex.isEmpty) continue;
        if (h == 1) genesisHex = hex.toLowerCase();
        _proven.add(h);
      }
    }
    sampledTip = tip;
  }

  Future<void> _proveCompactBlocks(String base, int tip) async {
    for (var from = 1; from <= tip; from += kNodeSyncBlockPage) {
      final to = from + kNodeSyncBlockPage - 1 > tip ? tip : from + kNodeSyncBlockPage - 1;
      var need = false;
      for (var h = from; h <= to; h++) {
        if (!_compactProven.contains(h)) {
          need = true;
          break;
        }
      }
      if (!need) continue;
      final batch = await _getFirst(base, [
        '/blocks?from=$from&to=$to',
        '/compactblocks?from=$from&to=$to',
      ]);
      final rows = batch?['blocks'];
      if (rows is List) {
        for (final row in rows) {
          if (row is! Map) continue;
          final h = (row['height'] as num?)?.toInt() ?? 0;
          if (h < 1) continue;
          if (row['header'] != null || row['txs'] != null) _compactProven.add(h);
        }
      }
      for (var h = from; h <= to; h++) {
        if (_compactProven.contains(h)) continue;
        final blk = await _getFirst(base, [
          '/block?height=$h',
          '/compactblock?height=$h',
        ]);
        if (blk == null) continue;
        if (blk['header'] != null || blk['txs'] != null || blk['ok'] == true) {
          _compactProven.add(h);
        }
      }
    }
  }

  Future<void> _proveJroot(String base) async {
    final live = await _getFirst(base, [
      '/jroot',
      '/api/wallet/jroot',
      '/fluxset',
      '/api/wallet/fluxset',
    ]);
    final root = live?['jroot']?.toString() ?? '';
    if (root.isNotEmpty) jrootHex = root.toLowerCase();
  }

  Future<({int height, String genesis})?> _probe(String base) async {
    final stats = await _getFirst(base, const ['/stats', '/api/stats']);
    if (stats == null) return null;
    if (!isV3BookStats(stats)) return null;
    final tip = (stats['height'] as num?)?.toInt() ?? 0;
    if (tip < 1) return null;
    var genesis = await _genesisOf(base);
    if (genesis.isEmpty) genesis = (stats['header']?.toString() ?? '').toLowerCase();
    return (height: tip, genesis: genesis);
  }

  Future<String> _genesisOf(String base) async {
    final batch = await _getFirst(base, const [
      '/headers?from=1&to=1',
      '/api/explorer/headers?from=1&to=1',
    ]);
    final rows = batch?['headers'];
    if (rows is List && rows.isNotEmpty && rows.first is Map) {
      final hex = (rows.first as Map)['header']?.toString() ?? '';
      if (hex.isNotEmpty) return hex.toLowerCase();
    }
    final hdr = await _getFirst(base, const [
      '/header?height=1',
      '/api/explorer/header?height=1',
    ]);
    return (hdr?['header']?.toString() ?? '').toLowerCase();
  }

  Future<Map<String, dynamic>?> _getFirst(String base, List<String> paths) async {
    for (final path in paths) {
      final got = await _get(base, path);
      if (got != null) return got;
    }
    return null;
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
