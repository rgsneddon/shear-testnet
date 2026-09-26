import 'dart:convert';
import 'dart:io';

enum ClosureSendMode { connectBare, shearPrivacyVpn, localNode, localNodeFull }

const kClosureModeBare = 'connectBare';
const kClosureModeVpn = 'shearPrivacyVpn';
const kClosureModeLocal = 'localNode';
const kClosureModeFull = 'localNodeFull';

/// Connect bare is the new-session default. Stored hop and full-node values
/// fold into the two 0.55 paths: bare, or the one syncing node.
ClosureSendMode closureModeFromStored(String? raw, {required bool android}) {
  switch (raw) {
    case kClosureModeLocal:
    case kClosureModeFull:
    case 'fullNode':
      return ClosureSendMode.localNode;
    case kClosureModeBare:
    case kClosureModeVpn:
    case null:
    case '':
    default:
      return ClosureSendMode.connectBare;
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

/// The wallet node does not listen for miners. Stratum stays on the fleet.
int? closureStratumPort(ClosureSendMode mode, {required bool android}) {
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
    'This Android pack does not include a node runtime, so Run node cannot start on the phone. '
    'Continuum stays on Connect bare. The light seeker still follows the live tip.';

/// One wallet node. Start resumes from the saved tip. Stop leaves that tip on disk.
const kLocalNodeModeCopy =
    'Run one node beside the wallet. It requests each next block in order until the tip. '
    'Start resumes from the saved height. Stop saves that height and leaves the book. No stratum.';
const kLocalNodeFullModeCopy = kLocalNodeModeCopy;

/// The VPN tunnel is deprecated. Connect bare pushes a signed send. Nodes verify it.
const kConnectBareCopy =
    'Connect bare. You push a signed send. Each node verifies it on the book it holds. '
    'DINS-DAG and the ADMITv2 fluxset keep that spend private. No tunnel and no node on this device.';

/// Published snapshot. Used only when the wallet node datadir is empty.
const kPublicBootstrapUrl = 'https://boot.shear.digital';

const kResistanceEmptyCopy =
    'Empty book. Installing the published snapshot once, then requesting each next block until the tip.';

String resistanceResumeCopy(int height) {
  if (height > 0) {
    return 'Resuming from height $height. Requesting each next block until the tip.';
  }
  return 'Resuming from the blocks already stored. Requesting each next block until the tip.';
}

String resistanceStopCopy(int height) {
  if (height > 0) {
    return 'Saved tip height $height. The book stays. Start continues from that height.';
  }
  return 'Stopped. No tip was saved yet. The book stays.';
}

const kNodeTipFileName = 'tip.json';

int readSavedNodeTip(String dataDir) {
  if (dataDir.isEmpty) return 0;
  final f = File('$dataDir${Platform.pathSeparator}$kNodeTipFileName');
  if (!f.existsSync()) return 0;
  try {
    final raw = jsonDecode(f.readAsStringSync());
    final h = raw is Map ? raw['height'] : null;
    if (h is int && h > 0) return h;
    if (h is num && h > 0) return h.toInt();
  } catch (_) {}
  return 0;
}

void writeSavedNodeTip(String dataDir, int height) {
  if (dataDir.isEmpty || height < 1) return;
  final dir = Directory(dataDir);
  if (!dir.existsSync()) dir.createSync(recursive: true);
  File('${dir.path}${Platform.pathSeparator}$kNodeTipFileName')
      .writeAsStringSync('${jsonEncode({'height': height})}\n');
}

String closureChipLabel(ClosureSendMode mode) {
  switch (mode) {
    case ClosureSendMode.connectBare:
      return 'CONNECT BARE';
    case ClosureSendMode.shearPrivacyVpn:
      return 'VPN HOP MODE';
    case ClosureSendMode.localNode:
    case ClosureSendMode.localNodeFull:
      return 'RUN NODE';
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

/// Spawn environment for the wallet node. Bootstrap is set only for an empty book.
Map<String, String> closureSpawnEnv(
  ClosureSendMode mode, {
  required bool android,
  required String dataDir,
  bool emptyDatadir = false,
}) {
  return <String, String>{
    'SHEAR_RPC_BIND': '127.0.0.1',
    'SHEAR_RPC_PORT': '18332',
    'SHEAR_DATA': dataDir,
    'SHEAR_MAX_PEERS': android ? '8' : '16',
    'SHEAR_GETBLOCK_BATCH': '1',
    'SHEAR_SOLO': '0',
    'SHEAR_FAST_SYNC': '1',
    if (emptyDatadir) 'SHEAR_BOOTSTRAP': '1',
    if (emptyDatadir) 'SHEAR_BOOTSTRAP_URL': kPublicBootstrapUrl,
  };
}

List<String> closureSpawnArgs({required bool emptyDatadir, required ClosureSendMode mode}) {
  // Args stay empty. An empty book carries the snapshot URL in the environment.
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
    pending = mode == ClosureSendMode.localNode || mode == ClosureSendMode.localNodeFull
        ? ClosureSendMode.localNode
        : ClosureSendMode.connectBare;
  }

  bool get showResistanceConsole => committed == ClosureSendMode.localNode;

  bool get showSoloMine => false;

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
    final next = pending == ClosureSendMode.localNode || pending == ClosureSendMode.localNodeFull
        ? ClosureSendMode.localNode
        : ClosureSendMode.connectBare;
    final prev = committed;
    if (next == ClosureSendMode.connectBare) {
      await stop();
      committed = next;
      lastEnv = {};
      lastArgs = const [];
      progress = kConnectBareCopy;
      return progress;
    }
    if (prev != next) {
      progress = 'Restarting local node for new send path…';
      await stop();
    }
    committed = next;
    final empty = datadirEmpty?.call() ?? emptyDatadir;
    lastEnv = closureSpawnEnv(next, android: android, dataDir: dataDir, emptyDatadir: empty);
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

  /// Resistance Start. Resume the saved tip and request each later block. No tunnel.
  Future<String> startResistanceNode() async {
    select(ClosureSendMode.localNode);
    final empty = datadirEmpty?.call() ?? emptyDatadir;
    final saved = reportedHeight > 0 ? reportedHeight : readSavedNodeTip(dataDir);
    if (running && committed == pending) {
      progress = empty && saved < 1 ? kResistanceEmptyCopy : resistanceResumeCopy(saved);
      return progress;
    }
    final msg = await apply();
    if (!running) return msg;
    progress = empty ? kResistanceEmptyCopy : resistanceResumeCopy(saved);
    return progress;
  }

  /// Resistance Stop. Save the current tip and leave the book on disk. No tunnel.
  Future<String> stopResistanceNode() async {
    final saved = reportedHeight > 0 ? reportedHeight : readSavedNodeTip(dataDir);
    if (saved > 0) writeSavedNodeTip(dataDir, saved);
    select(ClosureSendMode.connectBare);
    await apply();
    progress = resistanceStopCopy(saved);
    return progress;
  }
}
