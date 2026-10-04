import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'shear_read_open.dart';

enum ClosureSendMode { connectBare, localNode, localNodeFull }

const kClosureModeBare = 'connectBare';

/// Retired stored string. Old sessions that saved the Shear VPN tunnel open
/// on Connect bare. Not a product mode.
const kClosureModeVpn = 'shearPrivacyVpn';
const kClosureModeLocal = 'localNode';
const kClosureModeFull = 'localNodeFull';

/// Connect bare is the new-session default. A stored VPN-tunnel string folds
/// into Connect Bare. p2P Node and Full Node stay distinct. Full Node is the
/// path that passes `--solo`.
ClosureSendMode closureModeFromStored(String? raw, {required bool android}) {
  switch (raw) {
    case kClosureModeFull:
    case 'fullNode':
      return ClosureSendMode.localNodeFull;
    case kClosureModeLocal:
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

/// Public pool is TLS. Localhost solo stays cleartext.
String shearKPoolUrl({required bool publicPool}) {
  if (publicPool) return 'stratum+ssl://pool.shear.digital:443';
  return 'stratum+tcp://127.0.0.1:1111';
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
bool noteSidecarLine(ShearNodeSidecar side, String line, {bool openProofs = true}) {
  side.addLog(line);
  final st = parseLocalNodeStatus(line);
  if (st == null) return false;
  side.reportedHeight = st.height;
  side.reportedIbd = st.ibd;
  // The wallet stdout path passes false and opens in Isolate.run so a status
  // line does not walk value proofs on the UI isolate.
  if (openProofs && side.hasHeldBlocks) side.openWhileCatchingUp();
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

/// p2P Node. A full node on this device, without `--solo`.
const kLocalNodeModeCopy =
    'p2P Node. A full node on this device, without --solo. '
    'It requests each next block in order until the tip and does not mine. '
    'Start resumes from the saved height. Stop saves that height and leaves the book.';

/// Full Node. `--solo` is the first command argument, before the node syncs.
const kLocalNodeFullModeCopy =
    'Full Node. The same full node, with --solo on the command line before it syncs, '
    'so this device can solo mine. Start resumes from the saved height. '
    'Stop saves that height and leaves the book.';

/// Connect bare pushes a signed send. Nodes verify it. No tunnel on this device.
const kConnectBareCopy =
    'Connect bare. You push a signed send. Each node verifies it on the book it holds. '
    'DINS-DAG and the ADMITv2 fluxset keep that spend private. No tunnel and no node on this device.';

/// Published snapshot. Used only when the wallet node datadir is empty.
const kPublicBootstrapUrl = 'https://boot.shear.digital';

const kResistanceEmptyCopy =
    'Empty book. Syncing from genesis, each next height until the tip.';

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

Future<int> readSavedNodeTipOffUi(String dataDir) {
  return Isolate.run(() => readSavedNodeTip(dataDir));
}

Future<void> writeSavedNodeTipOffUi(String dataDir, int height) {
  return Isolate.run(() => writeSavedNodeTip(dataDir, height));
}

String closureChipLabel(ClosureSendMode mode) {
  switch (mode) {
    case ClosureSendMode.connectBare:
      return 'CONNECT BARE';
    case ClosureSendMode.localNode:
      return 'P2P NODE';
    case ClosureSendMode.localNodeFull:
      return 'FULL NODE';
  }
}

String closureChipKey(ClosureSendMode mode) {
  switch (mode) {
    case ClosureSendMode.connectBare:
      return 'wallet-mode-connect-bare';
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
  bool publicStratum = false,
}) {
  return <String, String>{
    'SHEAR_RPC_BIND': '127.0.0.1',
    'SHEAR_RPC_PORT': '18332',
    'SHEAR_DATA': dataDir,
    'SHEAR_MAX_PEERS': android ? '8' : '16',
    'SHEAR_GETBLOCK_BATCH': '1',
    'SHEAR_SOLO': (!android && mode == ClosureSendMode.localNodeFull) ? '1' : '0',
    'SHEAR_FAST_SYNC': '1',
    // Port 30303 is fleet-only. Desktop follows the same hosts over HTTPS.
    'SHEAR_HTTP_FOLLOW': android ? '0' : '1',
    'SHEARK_POOL': shearKPoolUrl(publicPool: publicStratum),
  };
}

/// Command line for the built-in node. Full Node on desktop puts `--solo` first,
/// before the process starts and therefore before it dials seeds. Bootstrap is
/// never auto-applied. Android never receives `--solo`.
List<String> closureSpawnArgs({
  required bool emptyDatadir,
  required ClosureSendMode mode,
  bool android = false,
}) {
  if (!android && mode == ClosureSendMode.localNodeFull) {
    return const ['--solo'];
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

/// `node/src/node.js` plus a Node runtime at [root], or null.
PackagedNode? _shearNodeAt(String root) {
  final sep = Platform.pathSeparator;
  final script = '$root${sep}node${sep}src${sep}node.js';
  if (!File(script).existsSync()) return null;
  for (final name in ['runtime${sep}node.exe', 'runtime${sep}node']) {
    final path = '$root$sep$name';
    if (File(path).existsSync()) {
      return PackagedNode(binary: path, script: script, workDir: root);
    }
  }
  final envPath = Platform.environment['PATH'] ?? '';
  final delim = Platform.isWindows ? ';' : ':';
  final exeName = Platform.isWindows ? 'node.exe' : 'node';
  for (final dir in envPath.split(delim)) {
    if (dir.isEmpty) continue;
    final path = '$dir$sep$exeName';
    if (File(path).existsSync()) {
      return PackagedNode(binary: path, script: script, workDir: root);
    }
  }
  return null;
}

/// Prefer `runtime/node` + `node/src/node.js` next to the wallet executable.
/// A `flutter run` binary sits under `wallet/build/...`, so also walk parents
/// until the repo (or zip root) that contains that entry. A lone `shear-node`
/// file is still accepted for older layouts.
PackagedNode? resolvePackagedNode({String? override, String? besideDir}) {
  PackagedNode? found;
  if (besideDir != null && besideDir.isNotEmpty) {
    var dir = besideDir;
    for (var i = 0; i < 8; i++) {
      found = _shearNodeAt(dir);
      if (found != null) break;
      final parent = Directory(dir).parent.path;
      if (parent == dir) break;
      dir = parent;
    }
  }
  if (override != null && override.isNotEmpty) {
    if (found != null) {
      return PackagedNode(binary: override, script: found.script, workDir: found.workDir);
    }
    return PackagedNode(binary: override, workDir: besideDir);
  }
  if (found != null) return found;
  final legacy = resolveSharedNodeBinary(besideDir: besideDir);
  if (legacy == null) return null;
  return PackagedNode(binary: legacy, workDir: besideDir);
}

/// Shared with Shear Sentinel v16. Windows: %APPDATA%\\Shear\\testnet-v10 (Roaming).
String defaultShearBookDir() {
  final data = Platform.environment['SHEAR_DATA'];
  if (data != null && data.isNotEmpty) return data;
  if (Platform.isWindows) {
    final app = Platform.environment['APPDATA'];
    if (app != null && app.isNotEmpty) {
      return '$app${Platform.pathSeparator}Shear${Platform.pathSeparator}testnet-v10';
    }
  }
  final home = Platform.environment['USERPROFILE'] ?? Platform.environment['HOME'] ?? '';
  return '$home${Platform.pathSeparator}.shear${Platform.pathSeparator}testnet-v10';
}

String closureNodeDataDir({String? override, required String besideDir}) {
  if (override != null && override.isNotEmpty) return override;
  final shared = defaultShearBookDir();
  final legacyBeside = '$besideDir${Platform.pathSeparator}shear-node-data';
  if (closureDatadirEmpty(shared) && !closureDatadirEmpty(legacyBeside)) {
    return legacyBeside;
  }
  final home = Platform.environment['USERPROFILE'] ?? Platform.environment['HOME'] ?? '';
  final posix = '$home${Platform.pathSeparator}.shear${Platform.pathSeparator}testnet-v10';
  if (Platform.isWindows &&
      shared != posix &&
      closureDatadirEmpty(shared) &&
      !closureDatadirEmpty(posix)) {
    return posix;
  }
  return shared;
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

/// Continuum sidecar. Connect bare keeps no node. Local node has no
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

  /// One Apply/Start/Stop at a time. A burst keeps the newest request.
  int _applyEpoch = 0;
  Future<void> _applyTail = Future<void>.value();
  int debugApplyEntered = 0;
  int debugApplyCoalesced = 0;

  /// Set when [nodeBinary] is a Node runtime and the Shear entry is [nodeScript].
  String? nodeScript;
  String? workDir;

  /// Last status line from the local node, compared with [seekerTip].
  int reportedHeight = 0;
  bool reportedIbd = true;
  int seekerTip = 0;
  /// Apply→Bare drops the last sidecar watermark. A dead seeker is not synced.
  bool seekerDishonest = false;

  List<dynamic> _heldBlocks = const [];
  Set<int> _heldHeights = const {};
  int _heldTip = 0;
  String? _heldDest;

  /// Last sequential open. Set while [reportedIbd] is still true.
  ReadBlockOpen? lastOpen;

  /// Receives each walk, including a status line while IBD is still true.
  ReadProofSink? proofSink;

  bool get hasHeldBlocks => _heldBlocks.isNotEmpty;

  /// Blocks the local node has already read. Opening uses these on the next
  /// status line, including while IBD is still true.
  void holdReadBlocks(List blocks, {String? dest, Set<int>? readHeights, int? liveTip}) {
    _heldBlocks = blocks;
    if (dest != null) _heldDest = dest;
    if (readHeights != null) _heldHeights = readHeights;
    if (liveTip != null) _heldTip = liveTip;
  }

  /// Run node walk. [ibd] defaults to the node's reported flag and is not
  /// forced false while the node is still catching up.
  ReadBlockOpen openRunNode({
    List? blocks,
    Set<int>? readHeights,
    int? liveTip,
    String? dest,
    bool? ibd,
  }) {
    final opened = openReadBlockProofs(
      blocks: blocks ?? _heldBlocks,
      readHeights: readHeights ?? _heldHeights,
      liveTip: liveTip ?? (_heldTip > 0 ? _heldTip : seekerTip),
      dest: dest ?? _heldDest,
      ibd: ibd ?? reportedIbd,
    );
    lastOpen = opened;
    proofSink?.ingestReadOpen(
      opened,
      blocks: blocks ?? _heldBlocks,
      dest: dest ?? _heldDest,
    );
    return opened;
  }

  /// Same ordered walk as Connect bare. Runs while [reportedIbd] is still true.
  ReadBlockOpen openWhileCatchingUp({
    List? blocks,
    Set<int>? readHeights,
    int? liveTip,
    String? dest,
  }) {
    return openRunNode(
      blocks: blocks,
      readHeights: readHeights,
      liveTip: liveTip,
      dest: dest,
      ibd: reportedIbd,
    );
  }

/// [openWhileCatchingUp] with the value-proof walk in [Isolate.run].
  Future<ReadBlockOpen> openWhileCatchingUpOffUi({
    List? blocks,
    Set<int>? readHeights,
    int? liveTip,
    String? dest,
  }) async {
    final usedBlocks = blocks ?? _heldBlocks;
    final usedDest = dest ?? _heldDest;
    final opened = await openReadBlockProofsOffUi(
      blocks: usedBlocks,
      readHeights: readHeights ?? _heldHeights,
      liveTip: liveTip ?? (_heldTip > 0 ? _heldTip : seekerTip),
      dest: usedDest,
      ibd: reportedIbd,
    );
    lastOpen = opened;
    proofSink?.ingestReadOpen(opened, blocks: usedBlocks, dest: usedDest);
    return opened;
  }

  bool get _noNode => committed == ClosureSendMode.connectBare;

  /// Dialog latch for this process. A new sidecar is a new wallet launch.
  bool _localSyncNoticeOffered = false;

  /// First full tip sync in this session may offer the dialog. A later lag
  /// that catches the tip again does not. Not stored on disk.
  bool localSyncNoticeDue({required bool caughtTip}) {
    if (!caughtTip || _localSyncNoticeOffered) return false;
    _localSyncNoticeOffered = true;
    return true;
  }

  /// True once, when the local node first catches the light-seeker tip.
  bool takeOverIfMatched() {
    final matched = localNodeMatchesSeeker(
      nodeHeight: reportedHeight,
      ibd: reportedIbd,
      seekerTip: seekerTip,
    );
    if (_noNode) {
      // Connect bare keeps the send path. A running book still catches up.
      // Matching the tip clears the bar. It does not offer the send-path dialog.
      if (!running) return false;
      if (matched) {
        honest = true;
        progress = '';
      } else if (reportedIbd) {
        honest = false;
      }
      return false;
    }
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
    switch (mode) {
      case ClosureSendMode.localNode:
        pending = ClosureSendMode.localNode;
      case ClosureSendMode.localNodeFull:
        pending = ClosureSendMode.localNodeFull;
      case ClosureSendMode.connectBare:
        pending = ClosureSendMode.connectBare;
    }
  }

  bool get showResistanceConsole =>
      committed == ClosureSendMode.localNode || committed == ClosureSendMode.localNodeFull;

  /// Full Node is the only path that solo-mines. Android never arms it.
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

  Future<void> stop() {
    return _enqueue(() async {
      await _stopNow();
      return '';
    }).then((_) {});
  }

  Future<void> _stopNow() async {
    running = false;
    honest = false;
    listenPort = null;
    if (onStop != null) await onStop!();
  }

  /// Start, Stop, and Apply share one gate. A newer request replaces one that
  /// has not entered yet, and the gate always releases.
  Future<String> _enqueue(Future<String> Function() body) {
    final ticket = ++_applyEpoch;
    final gate = _applyTail;
    final result = gate.then((_) {
      if (ticket != _applyEpoch) {
        debugApplyCoalesced += 1;
        return Future<String>.value('');
      }
      debugApplyEntered += 1;
      return body();
    });
    _applyTail = result.then((_) {}, onError: (Object _, StackTrace __) {});
    return result;
  }

  /// Commits [pending]. Apply→A stops the sidecar immediately. B↔C restarts.
  Future<String> apply() => _enqueue(_applyBody);

  Future<String> _applyBody() async {
    final ClosureSendMode next;
    switch (pending) {
      case ClosureSendMode.localNode:
        next = ClosureSendMode.localNode;
      case ClosureSendMode.localNodeFull:
        next = ClosureSendMode.localNodeFull;
      case ClosureSendMode.connectBare:
        next = ClosureSendMode.connectBare;
    }
    final prev = committed;
    if (next == ClosureSendMode.connectBare) {
      await _stopNow();
      seekerTip = 0;
      seekerDishonest = true;
      committed = next;
      lastEnv = {};
      lastArgs = const [];
      progress = kConnectBareCopy;
      return progress;
    }
    if (prev != next) {
      progress = 'Restarting local node for new send path…';
      await _stopNow();
    }
    committed = next;
    final empty = datadirEmpty?.call() ?? emptyDatadir;
    lastEnv = closureSpawnEnv(next, android: android, dataDir: dataDir, emptyDatadir: empty);
    lastArgs = closureSpawnArgs(emptyDatadir: empty, mode: next, android: android);
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
    try {
      await startProcess!(nodeBinary!, lastEnv, spawnArgs);
    } catch (e) {
      running = false;
      honest = false;
      progress = 'Local node did not start. $e';
      return progress;
    }
    running = true;
    honest = false;
    return progress;
  }

  /// Desktop Connect bare still sends as Connect bare. The book process
  /// listens, so Windows can allow it, and follows public nodes over HTTPS
  /// when port 30303 has no peer. That process writes the chain files.
  /// Android never starts it. Apply of Connect bare still stops it.
  Future<String> startDesktopBook() => _enqueue(_startDesktopBookBody);

  Future<String> _startDesktopBookBody() async {
    if (android) return progress;
    if (running) return progress;
    if (committed != ClosureSendMode.connectBare) return _applyBody();
    final empty = datadirEmpty?.call() ?? emptyDatadir;
    lastEnv = closureSpawnEnv(
      ClosureSendMode.localNode,
      android: false,
      dataDir: dataDir,
      emptyDatadir: empty,
    );
    lastArgs = const [];
    listenPort = null;
    if (nodeBinary == null || nodeBinary!.isEmpty || startProcess == null) {
      running = false;
      honest = false;
      progress = kDesktopNodeMissingCopy;
      return progress;
    }
    final spawnArgs = <String>[
      if (nodeScript != null && nodeScript!.isNotEmpty) nodeScript!,
      ...lastArgs,
    ];
    try {
      await startProcess!(nodeBinary!, lastEnv, spawnArgs);
    } catch (e) {
      running = false;
      honest = false;
      progress = 'Local node did not start. $e';
      return progress;
    }
    running = true;
    honest = false;
    progress = 'Syncing the book on this device.';
    return progress;
  }

  /// Resistance Start. Resume the saved tip and request each later block. No tunnel.
  Future<String> startResistanceNode() => _enqueue(_startResistanceBody);

  Future<String> _startResistanceBody() async {
    select(ClosureSendMode.localNode);
    final empty = datadirEmpty?.call() ?? emptyDatadir;
    final saved = reportedHeight > 0 ? reportedHeight : await readSavedNodeTipOffUi(dataDir);
    if (running && committed == pending) {
      progress = empty && saved < 1 ? kResistanceEmptyCopy : resistanceResumeCopy(saved);
      return progress;
    }
    final msg = await _applyBody();
    if (!running) return msg;
    progress = empty ? kResistanceEmptyCopy : resistanceResumeCopy(saved);
    return progress;
  }

  /// Resistance Stop. Save the current tip and leave the book on disk. No tunnel.
  Future<String> stopResistanceNode() => _enqueue(_stopResistanceBody);

  Future<String> _stopResistanceBody() async {
    final saved = reportedHeight > 0 ? reportedHeight : await readSavedNodeTipOffUi(dataDir);
    if (saved > 0) await writeSavedNodeTipOffUi(dataDir, saved);
    select(ClosureSendMode.connectBare);
    await _applyBody();
    progress = resistanceStopCopy(saved);
    return progress;
  }
}
