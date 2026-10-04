import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:math';

import 'shear_read_open.dart';
import 'shear_tip_tick.dart';

import 'shear_identity.dart' show kBookMagic;
export 'shear_identity.dart' show kBookMagic;

/// Wallet default is the local node RPC. Public pool HTTP is an advanced toggle
/// (`userUrl`) with the IP warning — never the stock send path, and never the
/// chain ledger. Chain tip, bodies, history, and stats come from node seeds.
const kWalletDefaultSeed = 'http://127.0.0.1:18332';
const kLocalPoolHttp = 'http://127.0.0.1:8088';
const kLocalNodeRpc = 'http://127.0.0.1:18332';
const kPublicPoolHttp = 'https://pool.shear.digital';

/// Public node HTTP. Pool hosts are not in this list.
const kPublicNodeSeeds = <String>[
  'https://p2p.shear.digital',
  'https://r2r.shear.digital',
  'https://b2b.shear.digital',
];

/// Pool stratum / HUD host. Not a chain source. A loopback test port is not this.
bool isPoolLedgerHost(String? url) {
  if (url == null || url.isEmpty) return false;
  final u = Uri.tryParse(url);
  if (u == null) return false;
  final host = u.host.toLowerCase();
  if (host == 'pool.shear.digital' || host.endsWith('.pool.shear.digital')) return true;
  if (host == '127.0.0.1' || host == 'localhost' || host == '::1') {
    return u.port == 8088;
  }
  return false;
}

/// Chain fields Continuum may paint. Missing node keys stay null (honest empty).
class NodeChainPaint {
  const NodeChainPaint({
    this.tip = 0,
    this.headerHex = '',
    this.hashrate,
    this.circulatingNanos,
    this.bits,
    this.usable = false,
  });

  final int tip;
  final String headerHex;
  final int? hashrate;
  final int? circulatingNanos;
  final int? bits;
  final bool usable;
}

int? _chainStat(Map<String, dynamic> stats, String key) {
  if (!stats.containsKey(key)) return null;
  final v = stats[key];
  if (v is num && v >= 0) return v.round();
  return null;
}

/// Tip, hashrate, integral q, and bits from a node `/stats` body.
/// Absent keys stay null. This does not read a pool payload.
NodeChainPaint chainPaintFromNodeStats(Map<String, dynamic>? stats) {
  if (stats == null || !isUsableTipStats(stats)) return const NodeChainPaint();
  final bits = _chainStat(stats, 'bits') ?? _chainStat(stats, 'blockBits');
  return NodeChainPaint(
    tip: (stats['height'] as num).toInt(),
    headerHex: stats['header']?.toString() ?? '',
    hashrate: _chainStat(stats, 'hashrate'),
    circulatingNanos: _chainStat(stats, 'circulatingNanos'),
    bits: bits,
    usable: true,
  );
}

/// Pool JSON is not chain truth. Height, hashrate, q, and bits stay empty.
NodeChainPaint chainPaintFromPoolPayload(Map<String, dynamic>? poolStats) {
  if (poolStats == null) return const NodeChainPaint();
  return const NodeChainPaint();
}

/// Loopback RPC only. Public pool HTTP is never send-ready (IP rule).
bool isLocalRpcUrl(String? url) {
  if (url == null || url.isEmpty) return false;
  final host = Uri.tryParse(url)?.host ?? '';
  return host == '127.0.0.1' || host == 'localhost' || host == '::1';
}

bool isPublicPoolHttp(String? url) {
  final s = (url ?? '').toLowerCase();
  return s.contains('pool.shear.digital');
}

/// Tip sync may use public HTTP. Reserve/Flow spends must not.
bool localSendReady(String? url) => isLocalRpcUrl(url) && !isPublicPoolHttp(url);

/// Ports a user node or the local pool listens on.
/// An ephemeral socket such as 127.0.0.1:57299 is not a send target.
bool isWalletSendSeed(String? url) {
  if (url == null || url.isEmpty) return false;
  if (isPublicPoolHttp(url)) return true;
  final u = Uri.tryParse(url);
  if (u == null) return false;
  final host = u.host.toLowerCase();
  if (host != '127.0.0.1' && host != 'localhost' && host != '::1') return false;
  return u.port == 18332 || u.port == 8088;
}

/// Where a send is posted. A refused ephemeral loopback is not used.
String walletSendBase(String? url) {
  if (isWalletSendSeed(url)) {
    final s = url!.trim();
    return s.endsWith('/') ? s.substring(0, s.length - 1) : s;
  }
  return kPublicPoolHttp;
}

/// [name] occurs in [blob] and is not a prefix of a longer book number.
/// `shear-testnet-v1` must not match `shear-testnet-v10`.
bool _bookNameAt(String blob, String name) {
  var from = 0;
  while (from < blob.length) {
    final at = blob.indexOf(name, from);
    if (at < 0) return false;
    final end = at + name.length;
    final next = end < blob.length ? blob.codeUnitAt(end) : -1;
    final moreDigits = next >= 0x30 && next <= 0x39;
    if (!moreDigits) return true;
    from = end;
  }
  return false;
}

/// True only for the live ADMITv2 book. A leftover v3/v2 node is dropped.
bool isLiveBookStats(Map<String, dynamic> stats) {
  final blob = [
    stats['magic'],
    stats['network'],
    stats['bookLawFingerprint'],
  ].map((e) => '${e ?? ''}').join(' ');
  const retired = <String>[
    'shear-testnet-v1',
    'shear-testnet-v2',
    'shear-testnet-v3',
    'shear-testnet-v6',
    'shear-testnet-v7',
  ];
  for (final name in retired) {
    if (_bookNameAt(blob, name)) return false;
  }
  return _bookNameAt(blob, kBookMagic);
}

/// Kept for call sites; same as [isLiveBookStats].
bool isV3BookStats(Map<String, dynamic> stats) => isLiveBookStats(stats);

/// True when /stats can be used as the current chain tip.
/// Height 0 and empty fake payloads never become the tip.
bool isUsableTipStats(Map<String, dynamic>? stats) {
  if (stats == null || stats.isEmpty) return false;
  final raw = stats['height'];
  final tip = raw is num ? raw.toInt() : int.tryParse('$raw') ?? 0;
  return tip >= 1;
}

/// HTTP 200 HTML is not a node. A live seed is JSON with height ≥ 1.
bool isHtmlNodeBody(String body, {String? contentType}) {
  final ct = (contentType ?? '').toLowerCase();
  if (ct.contains('text/html')) return true;
  final t = body.trimLeft().toLowerCase();
  return t.startsWith('<!doctype') || t.startsWith('<html');
}

/// Decode a node JSON object. HTML and non-objects are not a tip.
Map<String, dynamic>? decodeNodeJson(String body, {String? contentType}) {
  if (isHtmlNodeBody(body, contentType: contentType)) return null;
  try {
    final decoded = jsonDecode(body);
    if (decoded is Map<String, dynamic>) return decoded;
    if (decoded is Map) return Map<String, dynamic>.from(decoded);
  } catch (_) {}
  return null;
}

/// How many node JSON bodies [decodeNodeJsonOffUi] has returned.
int debugNodeJsonIsolateRuns = 0;

/// Stamp from the last node JSON parse. Differs from the UI isolate when the
/// parse ran in [Isolate.run].
String debugNodeJsonOffIsolateStamp = '';

Map<String, dynamic> decodeNodeJsonWire(Map<String, String?> input) {
  final decoded = decodeNodeJson(
    input['body'] ?? '',
    contentType: input['contentType'],
  );
  return {
    'stamp': identityHashCode(Isolate.current).toString(),
    if (decoded != null) 'json': decoded,
  };
}

/// JSON parse of a node body. Always [Isolate.run]. A block page on the UI
/// isolate is what made Continuum Not Responding while the log was still moving.
Future<Map<String, dynamic>?> decodeNodeJsonOffUi(String body, {String? contentType}) async {
  await Future<void>.delayed(Duration.zero);
  final wire = await Isolate.run(() => decodeNodeJsonWire({
        'body': body,
        'contentType': contentType,
      }));
  debugNodeJsonIsolateRuns += 1;
  debugNodeJsonOffIsolateStamp = wire['stamp']?.toString() ?? '';
  final json = wire['json'];
  if (json is Map<String, dynamic>) return json;
  if (json is Map) return Map<String, dynamic>.from(json);
  return null;
}

/// Sealed height and network seek stay separate. Sealed-only is not synced.
class TipHud {
  const TipHud({
    required this.sealed,
    required this.seek,
    required this.live,
    required this.ibd,
    required this.synced,
    required this.amber,
    required this.label,
    required this.syncWord,
  });

  final int sealed;
  final int? seek;
  final bool live;
  final bool ibd;
  final bool synced;
  final bool amber;
  final String label;
  final String syncWord;
}

TipHud tipHud({
  required int sealed,
  int? seek,
  required bool live,
  required bool ibd,
}) {
  final seekKnown = live && seek != null && seek > 0;
  final synced = seekKnown && !ibd && sealed >= seek!;
  final amber = !live || ibd || !seekKnown;
  final String syncWord;
  final String label;
  if (!seekKnown) {
    syncWord = 'no live node';
    label = sealed > 0
        ? 'block height: sealed $sealed · no live node'
        : 'block height: no live node';
  } else if (!synced) {
    syncWord = 'seek $seek';
    label = 'block height: sealed $sealed · seek $seek';
  } else {
    syncWord = 'synchronised · $seek';
    label = 'block height: synchronised · sealed $sealed · seek $seek';
  }
  return TipHud(
    sealed: sealed,
    seek: seekKnown ? seek : null,
    live: live,
    ibd: ibd,
    synced: synced,
    amber: amber,
    label: label,
    syncWord: syncWord,
  );
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
  if (!live && failures == 0 && wanted <= 0 && height < 1) return 'connecting…';
  if (!live) {
    if (height > 0) return 'reconnecting · $height';
    return 'looking for a node…';
  }
  final pct = walletSyncPercent(proven: proven, wanted: wanted);
  final h = height > 0 ? height : wanted;
  if (pct >= 100) return h > 0 ? 'synchronised · $h' : 'synchronised';
  if (h > 0) return '$pct% synchronising · $h';
  return '$pct% synchronising…';
}

/// The wallet's own sync label is at the tip. A sidecar status line is not required.
bool walletAtTip(String honesty) => honesty.startsWith('synchronised');

class ShearReadSync {
  ShearReadSync({
    List<String>? seeds,
    this.userUrl,
    HttpClient? http,
    this.jitter = const Duration(milliseconds: 400),
    Random? random,
  })  : seeds = List<String>.unmodifiable(_dedupe([
          if (userUrl != null && userUrl.trim().isNotEmpty && !isPoolLedgerHost(userUrl)) userUrl,
          if (seeds == null)
            ...[kLocalNodeRpc, ...kPublicNodeSeeds]
          else
            ...seeds.where((s) => !isPoolLedgerHost(s)),
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
  final List<Map<String, dynamic>> _readBlocks = [];
  /// Heights whose proofs already ran off the UI isolate. A later block must
  /// not send the whole book through the caller again.
  final Set<int> _proofOpenedHeights = {};

  /// Money dest whose seals are opened while compact pages arrive.
  String? proofDest;

  /// Every money dest to open. A mining mailbox that is not [proofDest] still counts.
  List<String> proofDests = const [];

  /// Receives each finished walk, including a prefix while the tip is ahead.
  ReadProofSink? proofSink;

  /// Last walk of blocks already read. Set while the live tip is still ahead.
  ReadBlockOpen? lastOpen;

  String? jrootHex;
  int sampledTip = 0;

  /// Header hex at height 1. Identifies the live book after a chain reset.
  String? genesisHex;

  int get provenHeaders {
    if (sampledTip < 1) return 0;
    var n = 0;
    for (final h in _proven) {
      if (h >= 1 && h <= sampledTip) n++;
    }
    return n;
  }
  int get wantedHeaders => sampledTip < 1 ? 0 : sampledTip;
  int get provenCompactBlocks {
    if (sampledTip < 1) return 0;
    var n = 0;
    for (final h in _compactProven) {
      if (h >= 1 && h <= sampledTip) n++;
    }
    return n;
  }
  int get failures => _failures;

  /// Heights whose compact bodies have been read. An unread height is absent.
  Set<int> get readHeights => Set<int>.unmodifiable(_compactProven);

  /// Compact bodies already read, in the order each page arrived.
  List<Map<String, dynamic>> get readBlocks => List<Map<String, dynamic>>.unmodifiable(_readBlocks);
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

  /// Drop the live node only after this many consecutive RPC misses.
  /// A new block can stall /stats for a beat; one miss must not paint
  /// "looking for a node" or drop Shearview history.
  static const dropAfterFailures = 3;

  /// One seed must not spend the whole tip budget. A refused Windows loopback
  /// connect is about two seconds, and two paths on two dead locals used to
  /// expire [kWalletTipTimeout] before the public network was asked.
  static const probeBudget = Duration(seconds: 5);

  /// Headers 1…tip + compact blocks + jroot from the local (or configured) node.
  /// Re-ranks same-genesis seeds so a lagging local RPC cannot pin below the live tip.
  Future<void> followTip() async {
    try {
      await _followTipBody().timeout(kWalletTipTimeout);
    } on TimeoutException {
      // Keep last good sampledTip. Caller retries next tick.
    }
  }

  Future<void> _followTipBody() async {
    // The light seeker follows the tallest same-genesis tip. A full node that
    // is still syncing must not pin receives to its shorter local height.
    final ranked = await findLiveNode(keepOnMiss: liveBase != null);
    var base = ranked ?? liveBase;
    if (base == null) return;
    var stats = await _getFirst(base, const ['/stats', '/api/stats']);
    if (stats == null || !isUsableTipStats(stats)) {
      // Height 0 / empty fake stats cannot pin as the current tip.
      // Re-rank to a live same-genesis seed at height ≥ 1.
      base = await findLiveNode(keepOnMiss: false);
      if (base == null) return;
      stats = await _getFirst(base, const ['/stats', '/api/stats']);
      if (stats == null || !isUsableTipStats(stats)) {
        noteFailure();
        return;
      }
    }
    _failures = 0;
    _backoffUntil = null;
    final tip = (stats['height'] as num?)?.toInt() ?? 0;
    if (tip < 1) return;
    final genesis = await _genesisOf(base);
    if (genesis.isNotEmpty && genesisHex != null && genesis != genesisHex) {
      _proven.clear();
      _compactProven.clear();
      _readBlocks.clear();
      lastOpen = null;
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

  int _firstMissing(Set<int> have, int tip) {
    for (var h = 1; h <= tip; h++) {
      if (!have.contains(h)) return h;
    }
    return tip + 1;
  }

  Future<String?> findLiveNode({bool keepOnMiss = false}) async {
    if (jitter > Duration.zero) {
      final cap = jitter.inMilliseconds;
      if (cap > 0) {
        await Future<void>.delayed(Duration(milliseconds: _rng.nextInt(cap + 1)));
      }
    }
    final probes = <String, ({int height, String genesis})>{};
    final found = await Future.wait(seeds.map((seed) async {
      final p = await _probe(seed);
      return MapEntry(seed, p);
    }));
    for (final e in found) {
      if (e.value != null) probes[e.key] = e.value!;
    }
    if (probes.isEmpty) {
      if (keepOnMiss && liveBase != null) return liveBase;
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
      if (keepOnMiss && liveBase != null) return liveBase;
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
      _readBlocks.clear();
      lastOpen = null;
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
    _failures++;
    if (_failures < dropAfterFailures && liveBase != null) return;
    liveBase = null;
    final shift = (_failures - 1).clamp(0, 6);
    _backoffUntil = DateTime.now().add(Duration(milliseconds: 1000 * (1 << shift)));
  }

  Future<void> _proveHeaders(String base, int tip) async {
    for (var from = _firstMissing(_proven, tip); from <= tip; from += kNodeSyncHeaderPage) {
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
              _readBlocks.clear();
              lastOpen = null;
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
      await Future<void>.delayed(Duration.zero);
    }
    sampledTip = tip;
  }

  Future<void> _proveCompactBlocks(String base, int tip) async {
    for (var from = _firstMissing(_compactProven, tip); from <= tip; from += kNodeSyncBlockPage) {
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
      final page = <Map<String, dynamic>>[];
      final rows = batch?['blocks'];
      if (rows is List) {
        for (final row in rows) {
          if (row is! Map) continue;
          final h = (row['height'] as num?)?.toInt() ?? 0;
          if (h < 1) continue;
          if (row['header'] != null || row['txs'] != null) {
            page.add(Map<String, dynamic>.from(row));
          }
        }
      }
      for (var h = from; h <= to; h++) {
        if (_compactProven.contains(h)) continue;
        if (page.any((b) => ((b['height'] as num?)?.toInt() ?? 0) == h)) continue;
        final blk = await _getFirst(base, [
          '/block?height=$h',
          '/compactblock?height=$h',
        ]);
        if (blk == null) continue;
        if (blk['header'] != null || blk['txs'] != null || blk['ok'] == true) {
          final row = Map<String, dynamic>.from(blk);
          row['height'] = (row['height'] as num?)?.toInt() ?? h;
          page.add(row);
        }
      }
      if (page.isNotEmpty) {
        final fresh = <Map<String, dynamic>>[
          for (final row in page)
            if (!_proofOpenedHeights.contains(readBlockHeight(row))) row,
        ];
        if (fresh.isNotEmpty) {
          await applyReadPageOffUi(pageBlocks: fresh, liveTip: tip, dest: proofDest);
        }
      }
      await Future<void>.delayed(Duration.zero);
    }
  }

  /// One compact page is now in hand. Open its proofs before later pages,
  /// including while [liveTip] is still ahead of this prefix.
  ReadBlockOpen applyReadPage({
    required List pageBlocks,
    required int liveTip,
    String? dest,
    bool ibd = false,
  }) {
    for (final raw in pageBlocks) {
      if (raw is! Map) continue;
      final row = Map<String, dynamic>.from(raw);
      final h = readBlockHeight(row);
      if (h < 1) continue;
      row['height'] = h;
      _compactProven.add(h);
      _readBlocks.removeWhere((b) => readBlockHeight(b) == h);
      _readBlocks.add(row);
    }
    if (liveTip > sampledTip) sampledTip = liveTip;
    return openConnectBare(
      blocks: _readBlocks,
      readHeights: Set<int>.from(_compactProven),
      liveTip: liveTip,
      dest: dest ?? proofDest,
      ibd: ibd,
    );
  }

  /// Same page bookkeeping as [applyReadPage]. The proof walk is [Isolate.run].
  /// One block body from the node this sync is using. The JSON parse is
  /// [decodeNodeJsonOffUi]. Android block info and desktop populate share it.
  Future<Map<String, dynamic>?> blockInfo(int height) async {
    if (height < 1) return null;
    final base = (liveBase != null && liveBase!.isNotEmpty)
        ? liveBase!
        : (seeds.isNotEmpty ? seeds.first : kLocalNodeRpc);
    final got = await _getFirst(base, [
      '/block?height=$height',
      '/compactblock?height=$height',
    ]);
    if (got == null) return null;
    if (got['header'] == null && got['txs'] == null && got['ok'] != true) return null;
    return got;
  }

  Future<ReadBlockOpen> applyReadPageOffUi({
    required List pageBlocks,
    required int liveTip,
    String? dest,
    bool ibd = false,
  }) async {
    await Future<void>.delayed(Duration.zero);
    for (final raw in pageBlocks) {
      if (raw is! Map) continue;
      final row = Map<String, dynamic>.from(raw);
      final h = readBlockHeight(row);
      if (h < 1) continue;
      row['height'] = h;
      _compactProven.add(h);
      _readBlocks.removeWhere((b) => readBlockHeight(b) == h);
      _readBlocks.add(row);
    }
    if (liveTip > sampledTip) sampledTip = liveTip;
    final pageHeights = <int>{
      for (final raw in pageBlocks) readBlockHeight(raw),
    }..remove(0);
    final opened = await _openReadOffUi(
      blocks: pageBlocks,
      readHeights: pageHeights,
      liveTip: liveTip,
      dest: dest,
      ibd: ibd,
    );
    _proofOpenedHeights.addAll(pageHeights);
    lastOpen = opened;
    proofSink?.ingestReadOpen(opened, blocks: _readBlocks, dest: dest ?? proofDest);
    return opened;
  }

  List<String> _destsForOpen(String? dest) {
    final many = proofDests.where((d) => d.isNotEmpty).toList();
    if (many.length > 1) return many;
    if (many.length == 1) return many;
    final one = dest ?? proofDest;
    if (one != null && one.isNotEmpty) return [one];
    return const [];
  }

  Future<ReadBlockOpen> _openReadOffUi({
    required List blocks,
    required Set<int> readHeights,
    required int liveTip,
    String? dest,
    bool ibd = false,
  }) async {
    final dests = _destsForOpen(dest);
    if (dests.length <= 1) {
      return openReadBlockProofsOffUi(
        blocks: blocks,
        readHeights: readHeights,
        liveTip: liveTip,
        dest: dests.isEmpty ? dest : dests.first,
        ibd: ibd,
      );
    }
    final opened = <OpenedReadNote>[];
    final unspendable = <UnspendableReadNote>[];
    final order = <int>{};
    var spendable = 0;
    var catching = false;
    for (final d in dests) {
      final part = await openReadBlockProofsOffUi(
        blocks: blocks,
        readHeights: readHeights,
        liveTip: liveTip,
        dest: d,
        ibd: ibd,
      );
      order.addAll(part.order);
      catching = catching || part.catchingUp;
      for (final n in part.opened) {
        opened.add(OpenedReadNote(
          height: n.height,
          nanos: n.nanos,
          verified: n.verified,
          commit: n.commit,
          dest: d,
        ));
        spendable += n.nanos;
      }
      unspendable.addAll(part.unspendable);
    }
    final heights = order.toList()..sort();
    return ReadBlockOpen(
      order: List<int>.unmodifiable(heights),
      opened: List<OpenedReadNote>.unmodifiable(opened),
      unspendable: List<UnspendableReadNote>.unmodifiable(unspendable),
      catchingUp: catching,
      deferredUntilSync: false,
      spendableNanos: spendable,
      ibd: ibd,
      liveTip: liveTip,
    );
  }

  /// Connect bare walk over blocks already read. Same opened notes as
  /// [openConnectBare]. [verifySealedNote] runs in [Isolate.run].
  Future<ReadBlockOpen> openConnectBareOffUi({
    required List blocks,
    required Set<int> readHeights,
    required int liveTip,
    String? dest,
    bool ibd = false,
  }) async {
    final fresh = <Map<String, dynamic>>[];
    final heights = <int>{};
    for (final raw in blocks) {
      if (raw is! Map) continue;
      final h = readBlockHeight(raw);
      if (h < 1 || !readHeights.contains(h) || _proofOpenedHeights.contains(h)) continue;
      fresh.add(Map<String, dynamic>.from(raw));
      heights.add(h);
    }
    if (fresh.isEmpty) {
      return lastOpen ??
          ReadBlockOpen(
            order: const [],
            opened: const [],
            unspendable: const [],
            catchingUp: ibd || liveTip > 0,
            deferredUntilSync: false,
            spendableNanos: 0,
            ibd: ibd,
            liveTip: liveTip,
          );
    }
    final opened = await _openReadOffUi(
      blocks: fresh,
      readHeights: heights,
      liveTip: liveTip,
      dest: dest,
      ibd: ibd,
    );
    _proofOpenedHeights.addAll(heights);
    lastOpen = opened;
    proofSink?.ingestReadOpen(opened, blocks: blocks, dest: dest ?? proofDest);
    return opened;
  }

  /// Connect bare walk over blocks already read. Same function Run node calls.
  /// Opens every money dest in [proofDests], not only the home dest.
  ReadBlockOpen openConnectBare({
    required List blocks,
    required Set<int> readHeights,
    required int liveTip,
    String? dest,
    bool ibd = false,
  }) {
    final dests = _destsForOpen(dest);
    final opened = openReadBlockProofsForDests(
      blocks: blocks,
      readHeights: readHeights,
      liveTip: liveTip,
      dests: dests,
      ibd: ibd,
    );
    lastOpen = opened;
    proofSink?.ingestReadOpen(opened, blocks: blocks, dest: dest ?? proofDest);
    return opened;
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
    try {
      return await _probeBody(base).timeout(probeBudget);
    } on TimeoutException {
      return null;
    }
  }

  Future<({int height, String genesis})?> _probeBody(String base) async {
    final stats = await _getFirst(base, const ['/stats', '/api/stats']);
    if (stats == null) return null;
    if (!isV3BookStats(stats)) return null;
    if (!isUsableTipStats(stats)) return null;
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
      final ct = res.headers.contentType?.mimeType;
      final body = await utf8.decodeStream(res);
      // Every body, including one block. The size cutoff still decoded block
      // info on the UI isolate, and Android told the user to wait or close.
      return decodeNodeJsonOffUi(body, contentType: ct);
    } catch (_) {
      return null;
    }
  }
}
