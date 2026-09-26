import 'dart:convert';
import 'dart:io';

enum ClosureSendMode { connectBare, shearPrivacyVpn, localNode, localNodeFull }

const kClosureModeBare = 'connectBare';
const kClosureModeVpn = 'shearPrivacyVpn';
const kClosureModeLocal = 'localNode';
const kClosureModeFull = 'localNodeFull';

/// Connect bare is the new-session default. A missing or empty stored mode
/// opens bare. An explicit VPN string stays on the hop. Unknown text stays
/// on VPN so a corrupt value is not dropped onto a public send.
/// Legacy fullNode becomes local-node-full on desktop and local node on Android.
ClosureSendMode closureModeFromStored(String? raw, {required bool android}) {
  switch (raw) {
    case kClosureModeLocal:
      return ClosureSendMode.localNode;
    case kClosureModeFull:
    case 'fullNode':
      return android ? ClosureSendMode.localNode : ClosureSendMode.localNodeFull;
    case kClosureModeVpn:
      return ClosureSendMode.shearPrivacyVpn;
    case kClosureModeBare:
    case null:
    case '':
      return ClosureSendMode.connectBare;
    default:
      return ClosureSendMode.shearPrivacyVpn;
  }
}

String closureModeStored(ClosureSendMode mode) {
  switch (mode) {
    case ClosureSendMode.connectBare:
      return kClosureModeBare;
    case ClosureSendMode.shearPrivacyVpn:
      return kClosureModeVpn;
    case ClosureSendMode.localNode:
      return kClosureModeLocal;
    case ClosureSendMode.localNodeFull:
      return kClosureModeFull;
  }
}

/// B does not listen. C desktop is loopback 1111. Android never arms stratum.
int? closureStratumPort(ClosureSendMode mode, {required bool android}) {
  if (android) return null;
  if (mode == ClosureSendMode.localNodeFull) return 1111;
  return null;
}

/// Parsed node `printNodeStatus` line. Null when the line is not a status row.
({int height, bool ibd})? parseLocalNodeStatus(String line) {
  final t = line.trim();
  if (t.isEmpty) return null;
  if (t.startsWith('{')) {
    try {
      final decoded = jsonDecode(t);
      if (decoded is Map && decoded['event']?.toString() == 'status') {
        final raw = decoded['height'];
        final height = raw is num ? raw.toInt() : int.tryParse('$raw') ?? 0;
        return (height: height, ibd: decoded['ibd'] == true);
      }
    } catch (_) {}
    return null;
  }
  if (!t.startsWith('status ')) return null;
  final ibd = RegExp(r'\bibd=(true|false)\b').firstMatch(t);
  final height = RegExp(r'\bheight=(\d+)\b').firstMatch(t);
  if (ibd == null || height == null) return null;
  return (height: int.tryParse(height.group(1)!) ?? 0, ibd: ibd.group(1) == 'true');
}

/// True when a sidecar status line says this node is past IBD at a real height.
/// Matches node `printNodeStatus`: JSON `event=status` and the `status height=` line.
bool observeLocalTip(String line) {
  final st = parseLocalNodeStatus(line);
  return st != null && !st.ibd && st.height > 0;
}

/// Local node may take the wallet only when its tip has caught the light seeker.
bool localNodeMatchesSeeker({required int nodeHeight, required bool ibd, required int seekerTip}) {
  return !ibd && nodeHeight > 0 && seekerTip > 0 && nodeHeight >= seekerTip;
}

/// Log one sidecar line. The wallet switches to full-node mode only when the
/// node's tip matches the light-seeker tip. True only on that false→true edge.
bool noteSidecarLine(ShearNodeSidecar side, String line) {
  side.addLog(line);
  final st = parseLocalNodeStatus(line);
  if (st == null) return false;
  side.reportedHeight = st.height;
  side.reportedIbd = st.ibd;
  return side.takeOverIfMatched();
}

bool closureArmsStratum(ClosureSendMode mode, {required bool android}) =>
    closureStratumPort(mode, android: android) == 1111;

/// Desktop zip layout. Android has no node.exe beside the app.
const kDesktopNodeMissingCopy =
    'Local node binary was not found beside Continuum. '
    'Extract the wallet zip so runtime/node.exe (Linux: runtime/node) and node/src/node.js sit next to the wallet.';

/// The Android pack does not ship a node runtime. Do not tell the user to extract the desktop zip.
const kAndroidNodeMissingCopy =
    'This Android pack does not include a node runtime, so a local node cannot start on the phone. '
    'Continuum stays on Shear Privacy VPN. The light seeker still follows the live tip.';

/// Local-node mode copy. The GUI node syncs from peers. It does not auto-bootstrap.
const kLocalNodeModeCopy =
    'Run a local Shear node in Continuum. Syncs from peers. No solo mining stratum.';
const kLocalNodeFullModeCopy =
    'For solo mining. Syncs from peers. Exposes localhost stratum for ShearK.';

/// Default send path. No hop lookup and no node process.
const kConnectBareCopy =
    'Does not look for the privacy hop and does not start a node. Sends of any amount post to the pool.';

String closureChipLabel(ClosureSendMode mode) {
  switch (mode) {
    case ClosureSendMode.connectBare:
      return 'CONNECT BARE';
    case ClosureSendMode.shearPrivacyVpn:
      return 'VPN HOP MODE';
    case ClosureSendMode.localNode:
      return 'LOCAL NODE';
    case ClosureSendMode.localNodeFull:
      return 'FULL NODE MODE';
  }
}

String closureChipKey(ClosureSendMode mode) {
  switch (mode) {
    case ClosureSendMode.connectBare:
      return 'wallet-mode-connect-bare';
    case ClosureSendMode.shearPrivacyVpn:
      return 'wallet-mode-vpn-hop';
    case ClosureSendMode.localNode:
      return 'wallet-mode-local-node';
    case ClosureSendMode.localNodeFull:
      return 'wallet-mode-full-node';
  }
}

/// Spawn environment for the shared tip node. Desktop C does not set FAST_SYNC.
Map<String, String> closureSpawnEnv(
  ClosureSendMode mode, {
  required bool android,
  required String dataDir,
}) {
  final env = <String, String>{
    'SHEAR_RPC_BIND': '127.0.0.1',
    'SHEAR_RPC_PORT': '18332',
    'SHEAR_DATA': dataDir,
    'SHEAR_MAX_PEERS': android ? '8' : '16',
    'SHEAR_GETBLOCK_BATCH': android ? '4' : '8',
  };
  if (mode == ClosureSendMode.localNodeFull && !android) {
    env['SHEAR_SOLO'] = '1';
    env['SHEAR_STRATUM'] = '1111';
    env['SHEAR_STRATUM_BIND'] = '127.0.0.1';
    return env;
  }
  env['SHEAR_SOLO'] = '0';
  env['SHEAR_FAST_SYNC'] = '1';
  return env;
}

List<String> closureSpawnArgs({required bool emptyDatadir, required ClosureSendMode mode}) {
  // Empty datadir and every send mode sync from peers. No bootstrap URL.
  if (emptyDatadir ||
      mode == ClosureSendMode.connectBare ||
      mode == ClosureSendMode.shearPrivacyVpn ||
      mode == ClosureSendMode.localNode ||
      mode == ClosureSendMode.localNodeFull) {
    return const [];
  }
  return const [];
}

/// Shared tip node beside Continuum, or [override] when set.
String? resolveSharedNodeBinary({String? override, String? besideDir}) {
  if (override != null && override.isNotEmpty) return override;
  if (besideDir == null || besideDir.isEmpty) return null;
  final sep = Platform.pathSeparator;
  for (final name in ['shear-node.exe', 'shear-node', 'node.exe', 'node']) {
    final path = '$besideDir$sep$name';
    if (File(path).existsSync()) return path;
  }
  return null;
}

/// Node runtime plus the Shear entry script shipped inside the wallet zip.
class PackagedNode {
  const PackagedNode({required this.binary, this.script, this.workDir});

  final String binary;
  final String? script;
  final String? workDir;
}

/// Prefer `runtime/node` + `node/src/node.js` next to the wallet executable.
/// A lone `shear-node` file is still accepted for older layouts.
PackagedNode? resolvePackagedNode({String? override, String? besideDir}) {
  if (override != null && override.isNotEmpty) {
    return PackagedNode(binary: override, workDir: besideDir);
  }
  if (besideDir == null || besideDir.isEmpty) return null;
  final sep = Platform.pathSeparator;
  final script = '$besideDir${sep}node${sep}src${sep}node.js';
  if (File(script).existsSync()) {
    for (final name in ['runtime${sep}node.exe', 'runtime${sep}node']) {
      final path = '$besideDir$sep$name';
      if (File(path).existsSync()) {
        return PackagedNode(binary: path, script: script, workDir: besideDir);
      }
    }
  }
  final legacy = resolveSharedNodeBinary(besideDir: besideDir);
  if (legacy == null) return null;
  return PackagedNode(binary: legacy, workDir: besideDir);
}

String closureNodeDataDir({String? override, required String besideDir}) {
  if (override != null && override.isNotEmpty) return override;
  return '$besideDir${Platform.pathSeparator}shear-node-data';
}

bool closureDatadirEmpty(String dataDir) {
  if (dataDir.isEmpty) return true;
  final sep = Platform.pathSeparator;
  return !File('$dataDir${sep}chain.bin').existsSync() &&
      !File('$dataDir${sep}chain.jsonl').existsSync();
}

typedef ClosureProcessStart = Future<void> Function(
  String binary,
  Map<String, String> env,
  List<String> args,
);

/// Continuum sidecar. Connect bare and VPN keep no node. Local node has no
/// stratum. Local-node-full on desktop listens on 1111. Android never arms it.
class ShearNodeSidecar {
  ShearNodeSidecar({
    this.android = false,
    this.nodeBinary,
    this.dataDir = '',
    this.emptyDatadir = true,
    this.datadirEmpty,
    this.startProcess,
    this.onStop,
    String? storedMode,
  }) {
    final mode = closureModeFromStored(storedMode, android: android);
    committed = mode;
    pending = mode;
  }

  final bool android;
  final String? nodeBinary;
  final String dataDir;
  final bool emptyDatadir;
  final bool Function()? datadirEmpty;
  final ClosureProcessStart? startProcess;
  final Future<void> Function()? onStop;

  /// Set when [nodeBinary] is a Node runtime and the Shear entry is [nodeScript].
  String? nodeScript;
  String? workDir;

  /// Last status line from the local node, compared with [seekerTip].
  int reportedHeight = 0;
  bool reportedIbd = true;
  int seekerTip = 0;

  bool get _noNode =>
      committed == ClosureSendMode.connectBare || committed == ClosureSendMode.shearPrivacyVpn;

  /// True once, when the local node first catches the light-seeker tip.
  bool takeOverIfMatched() {
    if (_noNode) return false;
    final matched = localNodeMatchesSeeker(
      nodeHeight: reportedHeight,
      ibd: reportedIbd,
      seekerTip: seekerTip,
    );
    if (!matched) {
      if (honest) {
        honest = false;
        progress = 'Local node is behind the light-seeker tip.';
      }
      return false;
    }
    if (honest) return false;
    markSynced();
    return true;
  }

  ClosureSendMode committed = ClosureSendMode.connectBare;
  ClosureSendMode pending = ClosureSendMode.connectBare;
  bool honest = false;
  bool running = false;
  int? listenPort;
  String progress = '';
  Map<String, String> lastEnv = {};
  List<String> lastArgs = const [];
  final List<String> log = [];

  void select(ClosureSendMode mode) {
    pending = android && mode == ClosureSendMode.localNodeFull
        ? ClosureSendMode.localNode
        : mode;
  }

  bool get showResistanceConsole =>
      committed == ClosureSendMode.localNode || committed == ClosureSendMode.localNodeFull;

  bool get showSoloMine => !android && committed == ClosureSendMode.localNodeFull;

  bool get sendBlocked => !_noNode && !honest;

  String get sendBlockedCopy =>
      'Wait until your local node is synced to the tip before sending.';

  void addLog(String line) {
    log.add(line);
    if (log.length > 500) log.removeAt(0);
  }

  void markSynced() {
    if (_noNode) return;
    honest = true;
    progress = '';
  }

  Future<void> stop() async {
    running = false;
    honest = false;
    listenPort = null;
    if (onStop != null) await onStop!();
  }

  /// Commits [pending]. Apply→A stops the sidecar immediately. B↔C restarts.
  Future<String> apply() async {
    final next = android && pending == ClosureSendMode.localNodeFull
        ? ClosureSendMode.localNode
        : pending;
    final prev = committed;
    if (next == ClosureSendMode.connectBare || next == ClosureSendMode.shearPrivacyVpn) {
      await stop();
      committed = next;
      lastEnv = {};
      lastArgs = const [];
      progress = next == ClosureSendMode.connectBare
          ? kConnectBareCopy
          : 'Shear Privacy VPN — light wallet active';
      return progress;
    }
    if (prev != next) {
      progress = 'Restarting local node for new send path…';
      await stop();
    }
    committed = next;
    lastEnv = closureSpawnEnv(next, android: android, dataDir: dataDir);
    final empty = datadirEmpty?.call() ?? emptyDatadir;
    lastArgs = closureSpawnArgs(emptyDatadir: empty, mode: next);
    listenPort = closureStratumPort(next, android: android);
    if (nodeBinary == null || nodeBinary!.isEmpty || startProcess == null) {
      running = false;
      honest = false;
      progress = android ? kAndroidNodeMissingCopy : kDesktopNodeMissingCopy;
      return progress;
    }
    final spawnArgs = <String>[
      if (nodeScript != null && nodeScript!.isNotEmpty) nodeScript!,
      ...lastArgs,
    ];
    await startProcess!(nodeBinary!, lastEnv, spawnArgs);
    running = true;
    honest = false;
    return progress;
  }
}
