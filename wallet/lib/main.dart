import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import 'shear_identity.dart';
import 'shear_ledger.dart';
import 'shear_lock.dart';
import 'shear_macos_install.dart';
import 'shear_session.dart';
import 'shear_shewall.dart';
import 'shear_theme.dart';
import 'shear_ctf.dart';
import 'shear_ctf_cli.dart';
import 'shear_vortex.dart';
import 'shear_reserve.dart';
import 'shear_reserve_towers.dart';
import 'shear_confirm_pie.dart';
import 'shear_biometrics.dart';
import 'shear_export.dart';
import 'shear_qr.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:file_picker/file_picker.dart';
import 'shear_social.dart';
import 'shear_levy.dart';
import 'shear_eip712.dart';
import 'shear_tip_tick.dart';
import 'shear_read_sync.dart';
import 'shear_privacy_hop.dart';
import 'shear_closure.dart';
import 'shear_node_proc.dart';
import 'rx_privacy_browser.dart';
import 'rp_mail.dart';

const kWalletVersion = '0.71';
/// Lock-in card stays up at least this long; Dismiss is disabled until then.
const kReserveLockHold = Duration(seconds: 6);
/// Shown after a Reserve lock is accepted. Spendable drops and staking starts now.
const kReserveLockSent = 'Deposit accepted. Spendable is reduced and staking has started.';
/// Your deposits scroller: two rows visible; extra deposits scroll inside.
const kDepositRowHeight = 22.0;
const kTabs = [
  'Continuum',
  'Flow',
  'Resistance',
  'Vortex',
  'Shearview',
  'Closure',
];
const kSymbols = ['∇·J = 0', 'J^μ', 'η', 'Ω^{μν}', 'S_{μν}', 'G_{μν}'];
/// Continuum side-by-side spendable | stats at this width and above.
const kContinuumSplitWidth = 720.0;
const kExplains = [
  'Your spendable balance and payment code.',
  'Send SHEAR to a published payment code or an ssa1 dest.',
  'Transactional data in a CLI output.',
  'Contracts which are deployed into your wallet.',
  'Your personal transaction explorer.',
  'Password and backup. Encrypts shewall.bin so you can restore this wallet on another install.',
];

/// What login populated, in order. Spendable is first. Sync chrome is later.
final List<String> debugPopulationOrder = <String>[];

Future<void> main(List<String> args) async {
  final tipFlag = args.indexOf('--print-tip');
  if (tipFlag >= 0) {
    final report = await continuumTipReport();
    final body = 'pin=$kWalletVersion\n$report\n';
    final out = tipFlag + 1 < args.length ? args[tipFlag + 1] : '';
    if (out.isNotEmpty && !out.startsWith('-')) {
      final f = File(out);
      f.parent.createSync(recursive: true);
      f.writeAsStringSync(body);
    }
    stdout.writeln(body.trimRight());
    final height = RegExp(r'displayHeight=(\d+)').firstMatch(report);
    exit((int.tryParse(height?.group(1) ?? '') ?? 0) >= 1 ? 0 : 2);
  }
  runApp(ShearWalletApp(demoTx: kDebugMode, biometrics: DeviceBiometrics()));
}

class ShearWalletApp extends StatefulWidget {
  const ShearWalletApp({
    super.key,
    this.session,
    this.ledger,
    this.launchExecutable,
    this.demoTx = false,
    this.reserve,
    this.downloadVortice,
    this.biometrics,
    this.exportDest,
    this.savePicker,
    this.importSrc,
    this.openUrl,
    this.scanQr,
    this.pickQrImage,
    this.startUnlocked = false,
    this.skipPoolSync = false,
    this.privacyHop,
    this.postReserveLock = false,
    this.hopFeePay,
    this.hostAndroid,
    this.bookLoading = false,
  });

  final ShearSession? session;
  final ShearLedger? ledger;
  final String? launchExecutable;
  /// Local observation only: confirm one testnet round so Shearview/Resistance have a tx.
  final bool demoTx;
  final ShearReserve? reserve;
  /// Test hook. Production fetches the origin named in the vort1. key.
  final Future<Vortice?> Function(String key)? downloadVortice;
  final ShearBiometrics? biometrics;
  /// Test hook. Production opens a user save dialog (SAF on Android).
  final File Function()? exportDest;
  /// Test hook. Production uses [defaultShewallSavePicker] (no bytes on desktop).
  final Future<String?> Function({Uint8List? bytes})? savePicker;
  /// Test hook. Production opens a user open dialog for shewall.bin.
  final File Function()? importSrc;
  final Future<bool> Function(Uri url)? openUrl;
  /// Test hook. Production opens the device camera to scan a Continuum receive QR.
  final Future<String?> Function()? scanQr;
  /// Test hook for Scan QR image pick. Production uses FilePicker then
  /// [decodeReceiveQrImage] (Windows has no mobile_scanner plugin).
  final Future<Uint8List?> Function()? pickQrImage;
  /// Tests: session already sealed and identity in memory.
  final bool startUnlocked;
  /// Tests: skip unlock HTTP so the sign-pull dialog can be driven without a hung pool.
  final bool skipPoolSync;
  /// Residual hop controller. Tests inject a mock.
  final PrivacyHopController? privacyHop;
  /// Tests: post Reserve lock to [ledger.pool] even when [skipPoolSync] is set.
  final bool postReserveLock;

  /// Test hook. Production pays the hop fee with [ShearLedger.send], whose
  /// seal/prove runs in [Isolate.run]. A slow hook must not run in the confirm turn.
  final Future<void> Function()? hopFeePay;

  /// Null uses the real platform. Tests set this so a phone bar can be
  /// measured on a desktop host. iOS will use this same coins-only shell.
  final bool? hostAndroid;

  /// Tests: show the first-open Loading spinner without a live credit follow.
  final bool bookLoading;

  @override
  ShearWalletAppState createState() => ShearWalletAppState();
}

class ShearWalletAppState extends State<ShearWalletApp> with WidgetsBindingObserver {
  /// Phone shell. Android today. The iOS wallet, when it is cut, is this same
  /// coins-only app: no local node and no 1 SHE continuity card.
  bool get _hostAndroid =>
      widget.hostAndroid ?? (!kIsWeb && (Platform.isAndroid || Platform.isIOS));

  /// First open, before a saved book or a finished note read. Later blocks
  /// keep Continuum on screen.
  bool get _showBookLoading =>
      widget.bookLoading || (_spendableAwaiting && !ledger.restoredBook);

  late final ShearSession session = widget.session ?? ShearSession();
  late final ShearLedger ledger = widget.ledger ?? ShearLedger(pool: ShearPoolClient());
  late final ShearBiometrics biometrics = widget.biometrics ?? const NoBiometrics();
  final GlobalKey<NavigatorState> _nav = GlobalKey<NavigatorState>();
  final GlobalKey<ScaffoldMessengerState> _snack = GlobalKey<ScaffoldMessengerState>();
  ShearIdentity? id;
  String password = '';
  bool unlocked = false;
  bool _verifying = false;
  /// Sync chrome and the block-height label wait until spendable has painted.
  bool _chromeReady = false;

  /// True from the responding shell until the unlock credit read returns.
  /// The figure is not 0 SHE during that wait.
  bool _spendableAwaiting = false;
  /// True while opened coins are still being collated. The bar says SYNCING.
  bool _spendSyncing = false;
  /// True after a notes read finished and the sealed height is known.
  bool _bookCollated = false;
  /// Connect bare Flyclient sample. Local-node mode does not read these.
  bool _flySampling = false;
  bool _flyOk = false;
  bool _flyFailed = false;
  bool _flyBusy = false;
  int _flyTip = 0;
  String? _flyGenesis;
  bool _openedPersistOnce = false;
  String? _lockError;
  bool _bioReady = false;
  bool _bioStored = false;
  int tab = 0;
  final flowTo = TextEditingController();
  String _flowAcceptedTo = '';
  final flowAmt = TextEditingController();
  final flowMemo = TextEditingController();
  final unlockCtrl = TextEditingController();
  final confirmCtrl = TextEditingController();
  final reserveAmt = TextEditingController();
  final vorticeKeyCtrl = TextEditingController();
  final shearviewQuery = TextEditingController();
  bool _vorticeBusy = false;
  late final ShearReserve reserve = widget.reserve ?? ShearReserve();
  late final PrivacyHopController hop =
      widget.privacyHop ?? PrivacyHopController();
  late final ShearNodeSidecar sidecar;
  NodeProcHandle? _nodeHandle;
  Timer? _nodeLogPaint;
  bool _nodeLogDirty = false;
  bool _proofBusy = false;
  bool _proofAgain = false;
  final _nodeConsoleScroll = ScrollController();
  int vortexTab = 0;
  List<Vortice> vortices = leanContinuumVortices();
  final Set<String> openedMemos = {};
  String? lastMemoPlain;
  ThemeMode _themeMode = ThemeMode.light;
  final Map<String, String> _cliById = {};
  String? _focusedTxId;
  bool _showCtfTranscript = false;
  Timer? _accrualTick;
  Timer? _preloginTick;
  int _tipWatchGen = 0;
  bool _tipBusy = false;
  bool _creditBusy = false;
  int _tipNoteKicks = 0;
  bool _creditAgain = false;
  bool _pullBusy = false;
  Timer? _creditFollow;
  bool _accrualPaused = false;
  DateTime _lastPersist = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime _lastPoll = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime _lastVault = DateTime.fromMillisecondsSinceEpoch(0);
  int _lastPaintSealed = -1;
  int _lastPaintSpendable = 0;
  int _lastPaintPending = 0;
  Map<String, dynamic>? _pullOffer;
  bool _pullPrompting = false;
  final Set<String> _handledPullIds = {};
  bool _showReceiveQr = false;
  Map<String, dynamic>? _reserveLockNotice;
  String? _reserveVoteDraft;
  Timer? _reserveLockHold;
  bool _reserveLockDismissable = false;
  int _mempoolDepth = 0;
  String? _flowSendAdvisory;
  bool _flowSendOk = false;
  String? _flowReceiveDest;
  String? _spentDestWarn;
  bool _newMemoExpanded = false;
  late final List<ScrollController> _tabScroll;
  final _depositsScroll = ScrollController();
  bool _reserveUnprivateOk = false;
  String? _reserveDepositProgress;
  /// Hop fee already posted this process. VPN grant / retry must not pay again.
  bool _hopFeePaidSession = false;
  bool _hopBusy = false;
  String? _hopProgress;
  int _owedAnchorMs = 0;
  double _owedAnchorShe = 0;

  void _onHop() {
    if (mounted) setState(() {});
  }

  final List<String> _pendingNodeLines = [];
  Future<void>? _nodeLogApply;

  void _ingestNodeLine(String line) {
    if (!mounted || line.isEmpty) return;
    _pendingNodeLines.add(line);
    _nodeLogApply ??= _drainNodeLog();
  }

  Future<void> _drainNodeLog() async {
    try {
      while (mounted && _pendingNodeLines.isNotEmpty) {
        final batch = List<String>.from(_pendingNodeLines);
        _pendingNodeLines.clear();
        await followNodeLog(batch);
      }
    } finally {
      _nodeLogApply = null;
      if (mounted && _pendingNodeLines.isNotEmpty) {
        _nodeLogApply = _drainNodeLog();
      }
    }
  }

  /// Node log lines while sync is moving. The status scan is [parseNodeLogBatchOffUi].
  /// Appending the text and painting stay on this isolate so a frame can run.
  @visibleForTesting
  Future<void> followNodeLog(List<String> lines) async {
    await Future<void>.delayed(Duration.zero);
    if (!mounted || lines.isEmpty) return;
    sidecar.seekerTip = ledger.pool?.liveTip ?? ledger.displayHeight;
    for (final line in lines) {
      sidecar.addLog(line);
    }
    final st = await parseNodeLogBatchOffUi(lines);
    if (!mounted) return;
    var matched = false;
    if (st != null) {
      sidecar.reportedHeight = st.height;
      sidecar.reportedIbd = st.ibd;
      matched = sidecar.takeOverIfMatched();
    }
    _requestShellPaint();
    if (sidecar.localSyncNoticeDue(caughtTip: matched)) _showLocalNodeSynced();
    if (sidecar.hasHeldBlocks) unawaited(_openSidecarProofs());
  }

  /// The header tip already moved. Read notes now, and again while the note
  /// host is still a block behind that header. Four tries, then the hot poll.
  Future<void> _kickNotesForTip() async {
    final ident = id;
    if (!mounted || !unlocked || ident == null || widget.skipPoolSync) return;
    if (!ledger.notesBehindSealedTip && !ledger.spendableReadFailed) {
      _tipNoteKicks = 0;
      return;
    }
    if (_tipNoteKicks >= 4) return;
    if (_creditBusy) {
      Timer(const Duration(milliseconds: 400), () {
        unawaited(_kickNotesForTip());
      });
      return;
    }
    _tipNoteKicks++;
    _creditBusy = true;
    if (mounted) setState(() => _spendSyncing = true);
    try {
      await _followCredits(
        ident,
        full: false,
        spendableFirst: true,
        onCoins: _onOpenedCoins,
      );
      _rememberLedger();
      unawaited(session.persist());
      if (mounted) _requestShellPaint();
    } catch (_) {
      ledger.noteSpendableReadFailed();
    } finally {
      _creditBusy = false;
      _spendableAwaiting = false;
      if (_spendSyncing && mounted) setState(() => _spendSyncing = false);
      if (_creditAgain && mounted && unlocked) _armCreditFollow();
    }
    if (!mounted || !unlocked) return;
    if (!ledger.notesBehindSealedTip && !ledger.spendableReadFailed) {
      _tipNoteKicks = 0;
      return;
    }
    Timer(const Duration(milliseconds: 400), () {
      unawaited(_kickNotesForTip());
    });
  }

  /// About 8 Hz. Log lines, tip height, and proof walks share this paint.
  void _requestShellPaint() {
    if (!mounted) return;
    _nodeLogDirty = true;
    _nodeLogPaint ??= Timer(const Duration(milliseconds: 125), _paintNodeLog);
  }

  /// One follow-up credit sync after a burst. It does not re-enter on the
  /// same turn as the sync that just finished.
  void _armCreditFollow() {
    if (_creditFollow != null) return;
    _creditFollow = Timer(const Duration(milliseconds: 125), () {
      _creditFollow = null;
      if (!mounted || !unlocked) return;
      if (!_creditAgain) return;
      if (_creditBusy) {
        _armCreditFollow();
        return;
      }
      _creditAgain = false;
      unawaited(_onNodeTip(ledger.displayHeight));
    });
  }

  /// About 8 Hz. Every line is already ingested; this only publishes.
  void _paintNodeLog() {
    _nodeLogPaint = null;
    if (!mounted || !_nodeLogDirty) return;
    _nodeLogDirty = false;
    setState(() {});
    _pinNodeConsole();
  }

  Future<void> _startSharedNode(String binary, Map<String, String> env, List<String> args) async {
    await _stopSharedNode();
    final merged = Map<String, String>.from(Platform.environment)..addAll(env);
    final work = sidecar.workDir;
    if (work != null && work.isNotEmpty) {
      final delim = Platform.isWindows ? ';' : ':';
      final extra =
          '$work${Platform.pathSeparator}runtime$delim$work${Platform.pathSeparator}crypto${Platform.pathSeparator}native';
      merged['PATH'] = '$extra$delim${merged['PATH'] ?? ''}';
    }
    final handle = await startNodeProcessOffUi(
      binary: binary,
      args: args,
      environment: merged,
      workingDirectory: (work != null && work.isNotEmpty) ? work : null,
    );
    _nodeHandle = handle;
    handle.listen(_ingestNodeLine);
  }

  void _pinNodeConsole() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_nodeConsoleScroll.hasClients) return;
      final max = _nodeConsoleScroll.position.maxScrollExtent;
      if (max > 0 && _nodeConsoleScroll.offset != max) {
        _nodeConsoleScroll.jumpTo(max);
      }
    });
  }

  Future<void> _stopSharedNode() async {
    final handle = _nodeHandle;
    _nodeHandle = null;
    _nodeLogPaint?.cancel();
    _nodeLogPaint = null;
    if (handle != null) await handle.kill();
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final beside = File(Platform.resolvedExecutable).parent.path;
    final dataDir = closureNodeDataDir(
      override: Platform.environment['SHEAR_DATA'] ?? Platform.environment['SHEAR_NODE_DATA'],
      besideDir: beside,
    );
    final packed = resolvePackagedNode(
      override: Platform.environment['SHEAR_NODE_BIN'],
      besideDir: beside,
    );
    sidecar = ShearNodeSidecar(
      android: widget.hostAndroid ?? (!kIsWeb && Platform.isAndroid),
      storedMode: widget.session?.closureSendMode,
      nodeBinary: packed?.binary,
      dataDir: dataDir,
      datadirEmpty: () => closureDatadirEmpty(dataDir),
      startProcess: _startSharedNode,
      onStop: _stopSharedNode,
    )
      ..proofSink = ledger
      ..nodeScript = packed?.script
      ..workDir = packed?.workDir;
    _tabScroll = List.generate(kTabs.length, (_) => ScrollController());
    hop.addListener(_onHop);
    _boot();
  }

  @override
  void dispose() {
    flowTo.dispose();
    flowAmt.dispose();
    flowMemo.dispose();
    unlockCtrl.dispose();
    confirmCtrl.dispose();
    reserveAmt.dispose();
    vorticeKeyCtrl.dispose();
    shearviewQuery.dispose();
    for (final c in _tabScroll) {
      c.dispose();
    }
    _depositsScroll.dispose();
    hop.removeListener(_onHop);
    unawaited(hop.disconnect());
    WidgetsBinding.instance.removeObserver(this);
    _tipWatchGen += 1;
    _accrualTick?.cancel();
    _preloginTick?.cancel();
    final dying = _nodeHandle;
    _nodeHandle = null;
    _nodeLogPaint?.cancel();
    _creditFollow?.cancel();
    unawaited(dying?.kill(wait: false) ?? Future<void>.value());
    _nodeConsoleScroll.dispose();
    _reserveLockHold?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused || state == AppLifecycleState.inactive) {
      _accrualPaused = true;
      _tipWatchGen += 1;
      _accrualTick?.cancel();
      _accrualTick = null;
      return;
    }
    if (state != AppLifecycleState.resumed) return;
    _accrualPaused = false;
    if (unlocked && !widget.skipPoolSync) _startAccrualTick(immediate: true);
  }

  Future<void> _boot() async {
    id = await session.loadOrCreate();
    _themeMode = session.darkMode ? ThemeMode.dark : ThemeMode.light;
    sidecar
      ..committed = closureModeFromStored(session.closureSendMode, android: _hostAndroid)
      ..pending = closureModeFromStored(session.closureSendMode, android: _hostAndroid);
    if (!_hostAndroid && Platform.environment['FLUTTER_TEST'] != 'true') {
      unawaited(sidecar.startDesktopBook());
    }
    _syncJoinRoster();
    try {
      _bioReady = await biometrics.available;
    } catch (_) {
      _bioReady = false;
    }
    try {
      final stored = await biometrics.recalledPassword();
      _bioStored = stored != null && stored.isNotEmpty;
    } catch (_) {
      _bioStored = false;
    }
    if (widget.startUnlocked && session.identity != null && session.password != null) {
      await _enterWallet(session.password!);
      return;
    }
    if (!widget.skipPoolSync) unawaited(_preloginSync());
    if (mounted) setState(() {});
  }

  /// Headers/tip from the local node before unlock. Spend keys stay sealed.
  Future<void> _preloginSync() async {
    Future<void> once() async {
      try {
        await ledger.syncTip(proveChain: false);
      } catch (_) {}
      if (mounted && !unlocked) setState(() {});
    }

    await once();
    _preloginTick?.cancel();
    _preloginTick = Timer.periodic(const Duration(seconds: 2), (_) {
      if (!mounted || unlocked) {
        _preloginTick?.cancel();
        return;
      }
      unawaited(once());
    });
  }

  void _syncJoinRoster() {
    final seen = <String>{};
    final extras = <Vortice>[];
    for (final v in [...session.deployedVortices, ...vortices]) {
      if (isPinnedProgram(v.id) || isReservedProgram(v.id) || v.id.isEmpty || seen.contains(v.id)) continue;
      seen.add(v.id);
      extras.add(v);
    }
    vortices = [
      reserveVortice,
      ...extras,
    ];
    final chips = vortices.where(vorticeChipVisible).length + 1;
    if (vortexTab >= chips) vortexTab = 0;
  }

  Future<void> _deployFromKey(String raw) async {
    final key = raw.trim();
    final parsed = parseVorticeKey(key);
    if (parsed == null) return;
    if (vortices.any((v) => v.id == parsed.id)) return;
    if (_vorticeBusy) return;
    _vorticeBusy = true;
    try {
      final got = widget.downloadVortice != null
          ? await widget.downloadVortice!(key)
          : await downloadVorticeFromOrigin(key);
      if (!mounted || got == null) return;
      final next = deployVortice(vortices, got);
      if (next.length == vortices.length) return;
      session.deployedVortices = next
          .where((v) => !isPinnedProgram(v.id) && v.id.isNotEmpty)
          .toList();
      if (!mounted) return;
      setState(() {
        vortices = next;
        vortexTab = next.where(vorticeChipVisible).length - 1;
        vorticeKeyCtrl.clear();
      });
      await session.persist();
    } finally {
      _vorticeBusy = false;
    }
  }

  Future<void> _removeVortice(BuildContext context, Vortice v) async {
    if (v.id == reserveProgram || isPinnedProgram(v.id) || isReservedProgram(v.id) || v.id == '_add') {
      return;
    }
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove vortice'),
        content: Text(
          'Remove ${v.name} from this wallet? The programme stays at the vort1 origin. The Reserve stays.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const Key('vortice-remove-confirm'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    final next = removeVortice(vortices, v.id);
    session.deployedVortices = next
        .where((x) => !isPinnedProgram(x.id) && x.id.isNotEmpty)
        .toList();
    if (!mounted) return;
    setState(() {
      vortices = next;
      vortexTab = 0;
    });
    await session.persist();
  }

  Future<void> _setPassword(String pw, String confirm) async {
    final err = walletPasswordError(pw, confirm: confirm);
    if (err != null) {
      setState(() {
        _lockError = err == 'mismatch'
            ? 'Passwords do not match.'
            : err == 'too_short'
                ? 'Use at least $kMinWalletPasswordLen characters.'
                : 'Enter a password that encrypts shewall.bin.';
      });
      return;
    }
    try {
      await session.setPassword(pw, confirm: confirm);
    } catch (e) {
      setState(() => _lockError = 'Could not seal the wallet.');
      return;
    }
    if (session.biometricsEnabled && _bioReady) {
      try {
        await biometrics.rememberPassword(pw);
      } catch (_) {}
    }
    await _enterWallet(pw);
  }

  Future<void> _unlock(String pw) async {
    if (session.needsPasswordSet) {
      await _setPassword(pw, confirmCtrl.text);
      return;
    }
    if (pw.isEmpty) {
      setState(() => _lockError = 'Enter your wallet password.');
      return;
    }
    try {
      id = await session.unlock(pw);
    } catch (e) {
      final msg = e is FormatException ? e.message : '';
      if (msg.startsWith('shewall_reset_required')) {
        setState(() => _lockError =
            'This shewall is from a prior book. Reset the wallet to use ADMITv2 (shear-testnet-v11).');
        return;
      }
      setState(() => _lockError = 'Wrong password.');
      return;
    }
    if (session.biometricsEnabled && _bioReady) {
      try {
        await biometrics.rememberPassword(pw);
      } catch (_) {}
    }
    await _enterWallet(pw);
  }

  Future<void> _importShewall() async {
    final pw = unlockCtrl.text;
    if (pw.isEmpty) {
      setState(() => _lockError = 'Enter the password that encrypts this shewall.bin.');
      return;
    }
    try {
      final src = widget.importSrc?.call() ?? await pickShewallImportFile();
      if (src == null) {
        setState(() => _lockError = 'No shewall.bin selected.');
        return;
      }
      final imported = await importEncryptedShewall(
        src: src,
        password: pw,
        ledger: ledger,
        onVortices: (v) => session.deployedVortices = v,
      );
      session.identity = imported;
      await session.setPassword(pw);
      await _enterWallet(pw);
    } catch (_) {
      setState(() => _lockError = 'Import failed. Check the file and password.');
    }
  }

  Future<bool> _sealBiometricsOn(BuildContext context) async {
    final ctrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        key: const Key('bio-seal'),
        title: const Text('Seal biometrics with password'),
        content: TextField(
          key: const Key('bio-seal-password'),
          controller: ctrl,
          obscureText: true,
          decoration: const InputDecoration(labelText: 'Wallet password'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Seal')),
        ],
      ),
    );
    if (ok != true) {
      ctrl.dispose();
      return false;
    }
    final pw = ctrl.text;
    ctrl.dispose();
    try {
      if (session.password != null && session.password != pw) {
        throw const FormatException('wrong_password');
      }
      if (session.needsUnlock || session.identity == null) {
        await session.unlock(pw);
      } else if (session.password != pw) {
        throw const FormatException('wrong_password');
      }
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Wrong password. Biometrics stay off.')),
        );
      }
      return false;
    }
    try {
      await biometrics.rememberPassword(pw);
    } catch (_) {}
    session.biometricsEnabled = true;
    _bioStored = true;
    await session.persist();
    return true;
  }

  @visibleForTesting
  Future<void> unlockBiometricsNow() => _unlockBiometric();

  /// Same path as the lock-gate Set password / Unlock buttons. Argon2id cannot complete in FakeAsync.
  @visibleForTesting
  Future<void> setPasswordNow() => _setPassword(unlockCtrl.text, confirmCtrl.text);

  @visibleForTesting
  Future<void> unlockNow() => _unlock(unlockCtrl.text);

  /// Same path as the lock-gate and Closure Import buttons.
  @visibleForTesting
  Future<void> importShewallNow() => _importShewall();

  /// Same path as the Closure Export button. Argon2id cannot complete in FakeAsync.
  @visibleForTesting
  Future<void> exportShewallNow() async {
    final ident = id ?? session.identity;
    final pw = session.password ?? password;
    void snack(String msg) => _snack.currentState?.showSnackBar(SnackBar(content: Text(msg)));
    if (ident == null || pw.isEmpty) {
      snack('Unlock with your password first.');
      return;
    }
    if (session.biometricsEnabled) {
      final ok = await biometrics.authenticate(reason: 'Export shewall.bin');
      if (!ok) {
        snack('Re-auth required to export.');
        return;
      }
    }
    try {
      _rememberLedger();
      final packed = exportShewall(
        identity: ident,
        ledger: ledger,
        reserveSnapshot: session.rememberedReserve,
        vortices: session.deployedVortices,
      );
      final sealed = await sealShewallBin(packed, pw);
      final path = await saveShewallBytes(
        sealed,
        dest: widget.exportDest?.call(),
        picker: widget.savePicker,
      );
      snack('Wrote encrypted $shewallName to $path');
    } catch (e) {
      snack('Export failed: $e');
    }
  }

  Future<void> _unlockBiometric() async {
    if (!_bioReady || !(_bioStored || session.biometricsEnabled)) return;
    final ok = await biometrics.authenticate();
    if (!ok) {
      setState(() => _lockError = 'Biometrics failed. Use your password.');
      return;
    }
    final stored = await biometrics.recalledPassword();
    if (stored == null || stored.isEmpty) {
      setState(() => _lockError = 'No password stored for biometrics. Unlock once with your password.');
      return;
    }
    await _unlock(stored);
  }

  Future<void> _enterWallet(String pw) async {
    _preloginTick?.cancel();
    if (session.identity == null) return;
    // Write the scrubbed book before any credit follow re-reads session.json.
    // Otherwise the worker would put the stub height 20 back.
    if (session.bookCacheNeedsPersist) {
      await session.persist();
      session.bookCacheNeedsPersist = false;
    }
    id = session.identity;
    password = pw;
    ledger.bindIdentity(id!);
    ledger.bindVaultDest(restFrame: id!.address, viewKey: id!.viewKey);
    ledger.restoreDests(session.rememberedDests);
    ledger.restoreSealedTip(
      session.rememberedSealedHeight,
      genesis: session.rememberedChainGenesis,
    );
    ledger.restoreOpenedProofs(session.rememberedOpenedProofs);
    if (session.rememberedTxs.isNotEmpty) {
      await applyUserArchiveOffUi(ledger, {
        'dests': session.rememberedDests,
        'destCount': session.rememberedDestCount,
        'destIndex': session.rememberedDestIndex,
        'sealedHeight': session.rememberedSealedHeight,
        if (session.rememberedChainGenesis != null)
          'chainGenesis': session.rememberedChainGenesis,
        'txs': session.rememberedTxs,
      });
    }
    // After the archive. replaceFromBackup clears the painted sum, and the
    // saved notes put the accepted coins back without opening them again.
    if (session.rememberedNotes.isNotEmpty) {
      ledger.restoreSessionNotes(
        session.rememberedNotes,
        covered: session.rememberedNotesCovered,
        paymentCode: id!.paymentCode,
      );
    }
    if (session.rememberedReserve != null) {
      reserve.applyLocalSnapshot(session.rememberedReserve!);
    }
    if (!widget.skipPoolSync) {
      // _finishUnlockSync paints the shell before its credit await.
      if (!mounted || id == null) return;
      await _finishUnlockSync();
    }
    if (!mounted) return;
    if (!debugPopulationOrder.contains('shell')) {
      debugPopulationOrder.add('shell');
    }
    setState(() {
      _lockError = null;
      unlocked = true;
      _verifying = false;
      _chromeReady = widget.skipPoolSync;
    });
    try {
      if (widget.demoTx) {
        var pay = ledger.currentDest(id!.address);
        if (ledger.spendable(pay) <= 0) {
          final minted = ledger.confirmRound(address: id!.address, pot: 1, height: 1);
          ledger.settleTo(ShearLedger.continuumConfirmations);
          _ingestTx(id!, minted);
        }
      }
    } catch (_) {}
    // Do not build a CTF transcript for every sealed row on unlock — that
    // froze Shearview when history was hundreds of bundled blocks.
    if (mounted && !unlocked) setState(() => unlocked = true);
    _syncJoinRoster();
    if (!widget.skipPoolSync && id != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !unlocked || id == null) return;
        debugPopulationOrder.add('chrome');
        setState(() => _chromeReady = true);
        final ident = id!;
        unawaited(() async {
          // The chrome frame is already scheduled. Accrual and history start
          // after this callback returns so the main screen paints first.
          await Future<void>.delayed(Duration.zero);
          if (!mounted || !unlocked) return;
          _startAccrualTick(immediate: true, thinFirst: true);
          try {
            await ledger.syncHistory(ident.address);
          } catch (_) {}
          if (!mounted || id == null) return;
          await _syncVaults(ident);
        }());
      });
    }
    if (widget.skipPoolSync) _startAccrualTick(immediate: true);
    if (widget.demoTx) {
      unawaited(_playDemoLive());
    }
  }

  bool _sidecarIbd() => sidecar.running && !sidecar.honest;

  /// Full credit sync only once a running local node has caught the seeker.
  /// The wallet's sealed height is not that node's tip. Connect Bare is not a
  /// local IBD, so its poll can still collate.
  bool _fullCreditNow({required bool wantFull}) {
    if (sidecar.committed == ClosureSendMode.connectBare) return wantFull;
    if (!sidecar.running || !sidecar.honest) return false;
    return localNodeMatchesSeeker(
      nodeHeight: sidecar.reportedHeight,
      ibd: sidecar.reportedIbd,
      seekerTip: sidecar.seekerTip,
    );
  }

  Future<void> _followCredits(
    ShearIdentity ident, {
    required bool full,
    bool chain = true,
    bool spendableFirst = false,
    void Function()? onCoins,
  }) {
    return ledger.followOffUi(
      restFrame: ident.address,
      paymentCode: ident.paymentCode,
      full: full,
      chain: chain,
      spendableFirst: spendableFirst,
      sessionPath: session.store.path,
      sessionPassword: session.password,
      onCoins: onCoins,
    );
  }

  void _onOpenedCoins() {
    final who = id;
    if (!mounted || who == null) return;
    if (ledger.spendableOwned(who.address, paymentCode: who.paymentCode) <= 1e-12) {
      return;
    }
    _spendableAwaiting = false;
    _spendSyncing = false;
    if (ledger.sealedHeight > 0) _bookCollated = true;
    if (!_openedPersistOnce) {
      _openedPersistOnce = true;
      _rememberLedger();
      unawaited(session.persist());
    }
    setState(() {});
  }

  /// Apply's poll, off the gesture zone. Widget tests run that zone under
  /// fake async, and Isolate.run entered there does not return. This waits
  /// out an in-flight tick, then polls balances while the local node is in
  /// IBD. Queuing [_onNodeTip] instead would only run the short verify walk.
  Future<void> _followBalancesAfterApply(ShearIdentity ident) async {
    final waitUntil = DateTime.now().add(const Duration(seconds: 20));
    while (_creditBusy && mounted && DateTime.now().isBefore(waitUntil)) {
      await Future<void>.delayed(const Duration(milliseconds: 25));
    }
    if (!mounted || !unlocked || _creditBusy) return;
    _creditBusy = true;
    try {
      await _followCredits(ident, full: _fullCreditNow(wantFull: false));
    } catch (_) {}
    finally {
      _creditBusy = false;
      if (_creditAgain && mounted && unlocked) _armCreditFollow();
    }
  }

  Future<void> _finishUnlockSync() async {
    final ident = id;
    if (ident == null) return;
    if (_creditBusy) {
      _creditAgain = true;
      if (mounted) setState(() => _verifying = false);
      return;
    }
    // Paint a responding shell before the credit await. The await is the
    // worker isolate. Sync chrome and block info stay down until it returns.
    _creditBusy = true;
    debugPopulationOrder.add('spendable');
    // A book saved on this device paints now. The follow only opens new notes.
    _spendableAwaiting = !ledger.restoredBook;
    _spendSyncing = true;
    if (_usesFlyclientTip) unawaited(_runFlyclientSample());
    debugPopulationOrder.add('shell');
    if (mounted) {
      setState(() {
        _lockError = null;
        unlocked = true;
        _verifying = false;
        _chromeReady = false;
      });
    }
    await Future<void>.delayed(Duration.zero);
    try {
      if (id == null) return;
      await _followCredits(
        id!,
        full: false,
        chain: true,
        spendableFirst: true,
        onCoins: _onOpenedCoins,
      );
      _rememberLedger();
    } catch (_) {
      // A thrown credit read is not an empty book. Leave the figure on "…".
      ledger.noteSpendableReadFailed();
    }
    finally {
      _creditBusy = false;
      _spendableAwaiting = false;
      _spendSyncing = false;
      final who = id;
      if (who != null && ledger.sealedHeight > 0 && !ledger.spendableReadFailed) {
        _bookCollated = true;
      }
      if (mounted) setState(() => _verifying = false);
      if (_creditAgain && mounted && unlocked) _armCreditFollow();
    }
    if (mounted && unlocked) unawaited(session.persist());
    if (!_hostAndroid && mounted && unlocked) unawaited(_paintContinuity());
  }

  bool _continuityBusy = false;

  /// Desktop continuity card. Phone wallets do not fetch or show it.
  /// Runs outside the tip timeout so a slow stats read cannot hold a new coin.
  Future<void> _paintContinuity() async {
    if (_continuityBusy || !mounted || _hostAndroid || widget.skipPoolSync) return;
    _continuityBusy = true;
    try {
      final changed = await ledger.readContinuityFigures();
      if (changed && mounted) _requestShellPaint();
    } finally {
      _continuityBusy = false;
    }
  }

  Future<void> _onNodeTip(int height) async {
    final ident = id;
    if (!mounted || !unlocked || ident == null || widget.skipPoolSync) return;
    if (height > ledger.sealedHeight) {
      ledger.noteLiveHeight(height);
      _lastPaintSealed = ledger.sealedHeight;
      _tipNoteKicks = 0;
      _requestShellPaint();
      // The new fee has to join Pending in this same height step.
      unawaited(_kickNotesForTip());
      return;
    }
    if (_creditBusy) {
      _creditAgain = true;
      return;
    }
    _creditBusy = true;
    try {
      await _followCredits(ident, full: false, chain: false);
      _openLocalReadPrefix();
      _rememberLedger();
      if (!mounted) return;
      final spendUnits = (ledger.spendable(ident.address) * 1e9).round();
      final pendingN = ledger.pendingTxs(ident.address).length;
      _lastPaintSealed = ledger.sealedHeight;
      _lastPaintSpendable = spendUnits;
      _lastPaintPending = pendingN;
      _requestShellPaint();
    } catch (_) {
    } finally {
      _creditBusy = false;
      if (_creditAgain && mounted && unlocked) _armCreditFollow();
    }
  }

  /// Run node opens proofs of blocks already read while IBD is still true.
  /// The walk is [openWhileCatchingUpOffUi], so the tick can paint first.
  void _openLocalReadPrefix() {
    final sync = ledger.pool?.sync;
    if (sync == null || sync.readBlocks.isEmpty) return;
    if (sidecar.committed == ClosureSendMode.connectBare) {
      unawaited(_openBareProofs());
      return;
    }
    if (sidecar.committed != ClosureSendMode.localNode &&
        sidecar.committed != ClosureSendMode.localNodeFull) {
      return;
    }
    sidecar.holdReadBlocks(
      sync.readBlocks,
      dest: sync.proofDest,
      readHeights: sync.readHeights,
      liveTip: ledger.pool?.liveTip ?? sync.sampledTip,
    );
    unawaited(_openSidecarProofs());
  }

  /// Connect Bare opens the new block off the UI isolate. The bar can paint
  /// the height while [verifySealedNote] runs.
  Future<void> _openBareProofs() async {
    await Future<void>.delayed(Duration.zero);
    if (_proofBusy) {
      _proofAgain = true;
      return;
    }
    _proofBusy = true;
    try {
      do {
        _proofAgain = false;
        final sync = ledger.pool?.sync;
        if (sync == null || sync.readBlocks.isEmpty) return;
        await sync.openConnectBareOffUi(
          blocks: sync.readBlocks,
          readHeights: sync.readHeights,
          liveTip: sync.sampledTip,
          dest: sync.proofDest,
        );
        _requestShellPaint();
      } while (_proofAgain && mounted);
    } catch (_) {
    } finally {
      _proofBusy = false;
    }
  }

  /// One proof walk at a time. A newer status line runs after this one, not
  /// piled on the UI isolate.
  Future<void> _openSidecarProofs() async {
    await Future<void>.delayed(Duration.zero);
    if (_proofBusy) {
      _proofAgain = true;
      return;
    }
    _proofBusy = true;
    try {
      do {
        _proofAgain = false;
        if (!sidecar.hasHeldBlocks) return;
        await sidecar.openWhileCatchingUpOffUi();
        _requestShellPaint();
      } while (_proofAgain && mounted && sidecar.hasHeldBlocks);
    } catch (_) {
    } finally {
      _proofBusy = false;
    }
  }

  void _startAccrualTick({bool immediate = false, bool thinFirst = false}) {
    _accrualTick?.cancel();
    final watchGen = ++_tipWatchGen;
    // Android has no local node. A loopback /events watch never connects and
    // is not the public book the fee wallet spends from.
    if (!_hostAndroid && !widget.skipPoolSync) {
      unawaited(listenNodeTips(
        base: kLocalNodeRpc,
        cancelled: () => watchGen != _tipWatchGen || !mounted,
        onTip: (height) {
          unawaited(_onNodeTip(height));
        },
      ));
    }
    if (widget.skipPoolSync) {
      _accrualTick = Timer.periodic(kWalletHotPoll, (_) {
        if (!mounted || !unlocked) return;
        setState(() {});
      });
      return;
    }
    Future<void> tick() async {
      if (!mounted || !unlocked || _accrualPaused) return;
      final ident = id;
      if (ident == null) return;
      // A frame runs before this poll's tip read and credit follow.
      if (mounted) setState(() {});
      await Future<void>.delayed(Duration.zero);
      if (!mounted || !unlocked || _accrualPaused || id == null) return;
      if (_usesFlyclientTip) unawaited(_runFlyclientSample());
      if (!_hostAndroid) unawaited(_paintContinuity());
      final now = DateTime.now();
      if (!immediate && !walletShouldPoll(lastPoll: _lastPoll, now: now, hot: true)) {
        return;
      }
      immediate = false;
      _lastPoll = now;
      // Notes before the tip walk. A header read must not hold spendable.
      final notesDueFirst = notesCollateDue(
        openCollated: ledger.openCollated,
        readFailed: ledger.spendableReadFailed,
        notesLag: ledger.notesLagSpendable,
        notesBehindTip: ledger.notesBehindSealedTip,
      );
      var openedNotesThisTick = false;
      if (notesDueFirst && !_creditBusy) {
        openedNotesThisTick = true;
        thinFirst = false;
        _creditBusy = true;
        if (mounted) setState(() => _spendSyncing = true);
        try {
          await _followCredits(
            ident,
            full: false,
            spendableFirst: true,
            onCoins: _onOpenedCoins,
          );
          _rememberLedger();
          if (mounted) _requestShellPaint();
        } catch (_) {
          ledger.noteSpendableReadFailed();
        } finally {
          _creditBusy = false;
          _spendableAwaiting = false;
          if (_spendSyncing && mounted) setState(() => _spendSyncing = false);
          if (_creditAgain && mounted && unlocked) _armCreditFollow();
        }
      }
      if (!mounted || !unlocked || id == null) return;
      var tipMoved = false;
      await runTipAccrualTick(
        busy: _tipBusy,
        setBusy: (v) => _tipBusy = v,
        timeout: const Duration(seconds: 3),
        work: () async {
          final before = ledger.sealedHeight;
          try {
            await ledger.syncTip(proveChain: false).timeout(const Duration(seconds: 4));
          } catch (_) {}
          tipMoved = ledger.sealedHeight != before;
          if (tipMoved && mounted) {
            _lastPaintSealed = ledger.sealedHeight;
            sidecar.seekerTip = ledger.pool?.liveTip ?? ledger.displayHeight;
            _requestShellPaint();
          }
          if (tipMoved || now.difference(_lastVault) >= kWalletVaultGap) {
            _lastVault = DateTime.now();
            _syncJoinRoster();
            await _syncVaults(ident);
          }
        },
      );
      // The notes pull already ran at the height it saw. A tip that moved
      // during that read cleared the stamp, so this same tick pulls once more.
      // A quiet tip does not start a second follow.
      if (!mounted || !unlocked || id == null) return;
      if (openedNotesThisTick && !tipMoved) return;
      final thin = pendingReceiveThinPoll([
        ...ledger.pendingTxs(ident.address),
        ...ledger.ownerHistory(ident.address),
      ]);
      // History stays behind the desktop sidecar. The notes open does not.
      // A missed unlock read is retried on every platform, including Android.
      final notesDue = notesCollateDue(
        openCollated: ledger.openCollated,
        readFailed: ledger.spendableReadFailed,
        notesLag: ledger.notesLagSpendable,
        notesBehindTip: ledger.notesBehindSealedTip,
      );
      final full = thinFirst
          ? false
          : shouldFullSyncCredits(
              hasPendingReceive: thin,
              historyBehindTip: ledger.historyBehindTip,
              openCollatePending: notesDue,
              tipMovedWithoutLanding: tipMoved && ledger.tipAdvancedWithoutLanding,
            );
      thinFirst = false;
      if (_creditBusy) {
        _creditAgain = true;
        return;
      }
      _creditBusy = true;
      if ((notesDue || full) && mounted) setState(() => _spendSyncing = true);
      try {
        await _followCredits(
          ident,
          full: _fullCreditNow(wantFull: full),
          spendableFirst: notesDue,
          onCoins: _onOpenedCoins,
        );
        _rememberLedger();
        final persistAt = DateTime.now();
        if (persistAt.difference(_lastPersist) >= const Duration(seconds: 15)) {
          _lastPersist = persistAt;
          unawaited(session.persist());
        }
        final spendUnits = (ledger.spendable(ident.address) * 1e9).round();
        final pendingN = ledger.pendingTxs(ident.address).length;
        final owedShe = ledger.owedTowardPi(ident.address, paymentCode: ident.paymentCode);
        _touchOwedClock(owedShe);
        final dirty = ledger.sealedHeight != _lastPaintSealed
            || spendUnits != _lastPaintSpendable
            || pendingN != _lastPaintPending
            || tipMoved
            || owedShe > 0;
        sidecar.seekerTip = ledger.pool?.liveTip ?? ledger.displayHeight;
        _openLocalReadPrefix();
        if (sidecar.takeOverIfMatched()) {
          if (mounted) {
            _requestShellPaint();
            if (sidecar.localSyncNoticeDue(caughtTip: true)) _showLocalNodeSynced();
          }
        }
        if (dirty && mounted) {
          _lastPaintSealed = ledger.sealedHeight;
          _lastPaintSpendable = spendUnits;
          _lastPaintPending = pendingN;
          _requestShellPaint();
        }
      } finally {
        _creditBusy = false;
        if (_spendSyncing && mounted) setState(() => _spendSyncing = false);
        if (_creditAgain && mounted && unlocked) _armCreditFollow();
      }
    }
    if (immediate) unawaited(tick());
    _accrualTick = Timer.periodic(kWalletHotPoll, (_) { unawaited(tick()); });
  }

  /// Vortex opens the Reserve send. Read this wallet's own dest balances the
  /// moment the tab is chosen. SHE may have been paid in by someone else;
  /// a mining payout is not required. Same path on every platform.
  Future<void>? _vortexWarm;

  Future<void> _warmVortexBalance() async {
    final ident = id;
    if (!mounted || ident == null || !unlocked || widget.skipPoolSync || ledger.pool == null) {
      return;
    }
    if (_vortexWarm != null) return;
    final run = () async {
      try {
        await _followCredits(ident, full: false);
        _rememberLedger();
      } catch (_) {}
      try {
        final pressure = await ledger.pool!.mempoolPressure();
        _mempoolDepth = (pressure['depth'] as num?)?.toInt() ?? _mempoolDepth;
      } catch (_) {}
      if (mounted) setState(() {});
    }();
    _vortexWarm = run;
    try {
      await run;
    } finally {
      if (identical(_vortexWarm, run)) _vortexWarm = null;
    }
  }

  /// Wallet pull is gone. A found block seals the miner pay; this wallet does not pull a pool balance.
  Future<void> _pollPull(ShearIdentity ident) async {
    assert(ident.paymentCode.isNotEmpty || ident.paymentCode.isEmpty);
    return;
  }

  String _pullFailReason(Object e) {
    if (e is StateError) return e.message;
    if (e is ArgumentError) return '${e.message}';
    final s = '$e';
    const prefix = 'Bad state: ';
    return s.startsWith(prefix) ? s.substring(prefix.length) : s;
  }

  void _showPoolWithdrawError(String reason) {
    void show() {
      if (!mounted) return;
      final messenger = _snack.currentState;
      if (messenger == null) return;
      // hide/clear keep the current bar on an exit animation and queue the
      // next one behind it — a second failed Sign would still paint the first
      // reason. Yank the current bar so the new pool reason is visible now.
      messenger.removeCurrentSnackBar();
      messenger.showSnackBar(
        SnackBar(
          key: Key('pull-sign-error-$reason'),
          content: Text('Pool withdraw: $reason'),
        ),
      );
    }

    WidgetsBinding.instance.addPostFrameCallback((_) => show());
  }

  @visibleForTesting
  Future<void> pollPullNow() async {
    final ident = id;
    if (ident == null || !unlocked) return;
    await _pollPull(ident);
  }

  Future<void> _playDemoLive() async {
    final ident = id;
    if (ident == null) return;
    await Future<void>.delayed(const Duration(seconds: 2));
    if (!mounted || !unlocked) return;
    try {
      ledger.bindIdentity(ident);
      final pay = ledger.currentDest(ident.address, paymentCode: ident.paymentCode);
      if (ledger.pendingTxs(ident.address).isEmpty && ledger.spendable(pay) > 0.25) {
        final peer = createIdentity();
        final to = destForLogin(peer.address, height: 1, viewKey: peer.viewKey)!;
        final tx = await ledger.send(from: pay, to: to, amount: 0.25, local: true);
        _ingestTx(ident, tx);
        _focusedTxId = tx.id;
        if (mounted) setState(() {});
      }
    } catch (_) {}
    await Future<void>.delayed(const Duration(seconds: 5));
    if (!mounted || !unlocked) return;
    if (ledger.pendingTxs(ident.address).isNotEmpty) {
      _findBlock();
    }
  }

  int get _resistanceTab => kTabs.indexOf('Resistance');

  void _findBlock() {
    final ident = id;
    if (ident == null) return;
    ledger.bindIdentity(ident);
    final minted = ledger.confirmRound(
      address: ident.address,
      pot: 1,
      height: ledger.sealedHeight + 1,
    );
    _ingestTx(ident, minted);
    _ingestHistory();
    if (mounted) setState(() {});
  }

  void _ingestTx(ShearIdentity ident, ShearTx tx) {
    _cliById[tx.id] = ctfTranscript(
      identity: ident,
      tx: tx,
      spendableAfter: ledger.spendableOwned(ident.address, paymentCode: ident.paymentCode),
      continuityRoot: ledger.lag1Root,
      confs: ledger.confirmationsOf(tx.height ?? 0),
    );
  }

  void _ingestHistory() {
    final ident = id;
    if (ident == null) return;
    for (final t in ledger.shearviewTxs(ident.address)) {
      _ingestTx(ident, t);
    }
  }

  String get _cliText {
    final focus = _focusedTxId;
    if (focus != null && _cliById.containsKey(focus)) return _cliById[focus]!;
    if (_cliById.isEmpty) {
      return 'READY.\nWaiting for CTF conclusions…\nSend or confirm a transfer, or open a tx from Shearview.';
    }
    return _cliById.values.join('\n');
  }

  String get _exe {
    if (widget.launchExecutable != null) return widget.launchExecutable!;
    try {
      return Platform.resolvedExecutable;
    } catch (_) {
      return '';
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Shear $kWalletVersion',
      navigatorKey: _nav,
      scaffoldMessengerKey: _snack,
      theme: shearLightTheme(),
      darkTheme: shearDarkTheme(),
      themeMode: _themeMode,
      themeAnimationDuration: Duration.zero,
      home: Builder(
        builder: (ctx) => unlocked ? _shell(ctx) : _lockGate(ctx),
      ),
    );
  }

  void _toggleTheme() {
    setState(() {
      _themeMode = _themeMode == ThemeMode.dark ? ThemeMode.light : ThemeMode.dark;
    });
    session.darkMode = _themeMode == ThemeMode.dark;
    unawaited(session.persist());
  }

  Widget _brandMark({double size = 40}) {
    return Image.asset(
      kShearLogoAsset,
      width: size,
      height: size,
      fit: BoxFit.contain,
      filterQuality: FilterQuality.medium,
    );
  }

  Widget _brandWordmark({double height = 22}) {
    return Image.asset(
      shearWordmarkAsset(_themeMode == ThemeMode.dark ? Brightness.dark : Brightness.light),
      height: height,
      fit: BoxFit.contain,
      filterQuality: FilterQuality.high,
    );
  }

  /// One circular mark + SHEAR letters (no second logo).
  Widget _brandLockup({required double mark, required double wordHeight}) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        _brandMark(size: mark),
        SizedBox(width: mark * 0.18),
        _brandWordmark(height: wordHeight),
      ],
    );
  }

  Widget _lockGate(BuildContext context) {
    final theme = Theme.of(context);
    final first = session.needsPasswordSet;
    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    child: _brandLockup(mark: 88, wordHeight: 52),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    'she is private',
                    style: TextStyle(color: theme.colorScheme.onSurface),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    first
                        ? 'Set a password. It encrypts shewall.bin so you can restore this wallet on any device. You will enter it on every run.'
                        : 'Enter the password that encrypts shewall.bin.',
                    style: TextStyle(color: theme.colorScheme.onSurface),
                    textAlign: TextAlign.center,
                  ),
                  TextField(
                    controller: unlockCtrl,
                    obscureText: true,
                    decoration: InputDecoration(labelText: first ? 'New password' : 'Password'),
                    onSubmitted: (_) {
                      if (first) {
                        _setPassword(unlockCtrl.text, confirmCtrl.text);
                      } else {
                        _unlock(unlockCtrl.text);
                      }
                    },
                  ),
                  if (first) ...[
                    TextField(
                      controller: confirmCtrl,
                      obscureText: true,
                      decoration: const InputDecoration(labelText: 'Confirm password'),
                      onSubmitted: (_) => _setPassword(unlockCtrl.text, confirmCtrl.text),
                    ),
                  ],
                  if (_lockError != null) ...[
                    const SizedBox(height: 8),
                    Text(_lockError!, style: TextStyle(color: theme.colorScheme.error)),
                  ],
                  const SizedBox(height: 12),
                  FilledButton(
                    onPressed: () {
                      if (first) {
                        _setPassword(unlockCtrl.text, confirmCtrl.text);
                      } else {
                        _unlock(unlockCtrl.text);
                      }
                    },
                    child: Text(first ? 'Set password' : 'Unlock'),
                  ),
                  const SizedBox(height: 8),
                  OutlinedButton(
                    onPressed: _importShewall,
                    child: const Text('Import shewall.bin'),
                  ),
                  if (!first && _bioReady && (_bioStored || session.biometricsEnabled)) ...[
                    const SizedBox(height: 8),
                    OutlinedButton(
                      key: const Key('unlock-biometrics'),
                      onPressed: _unlockBiometric,
                      child: const Text('Unlock with biometrics'),
                    ),
                  ],
                  const SizedBox(height: 8),
                  TextButton(
                    onPressed: _toggleTheme,
                    child: Text(_themeMode == ThemeMode.dark ? 'Light mode' : 'Dark mode'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _rememberLedger() {
    session.rememberedDests = ledger.exportedDests();
    session.rememberedDestCount = ledger.destCount;
    session.rememberedDestIndex = ledger.destIndex;
    session.rememberedSealedHeight = ledger.sealedHeight;
    session.rememberedOpenedProofs = ledger.exportOpenedProofs();
    session.rememberedNotes = ledger.exportNotesForSession();
    session.rememberedNotesCovered = ledger.notesCovered;
    session.rememberedChainGenesis = ledger.chainGenesis;
    session.rememberedTxs = [
      for (final t in ledger.transactions)
        if (t.kind != 'sample') t.toJson(),
    ];
    final ident = id;
    final dest = ident == null ? null : _reserveDestOf(ident);
    if (dest != null) {
      final p = reserve.portal(dest);
      session.rememberedReserve = {
        'dest': dest,
        'staked': p.staked,
        'idle': p.idle,
        'joined': p.joined,
        'vote': p.vote,
        'voteEpoch': p.voteEpoch,
        'claimable': p.claimableRewards,
      };
    }
  }

  int get _continuumVaultNanos {
    if (ledger.blankFork || ledger.vaultSealBanner.isNotEmpty) return 0;
    return reserve.totalLockedNanos > 0 ? reserve.totalLockedNanos : (ledger.vaultLockedNanos ?? 0);
  }

  int get _continuumExtraMintedNanos =>
      reserve.mintBankNanos > 0 ? reserve.mintBankNanos : (ledger.extraMintedNanos ?? 0);

  /// Android has no node. Desktop uses this only while Connect bare is the
  /// committed path. p2P Node and Full Node keep their own tip word.
  bool get _usesFlyclientTip =>
      !widget.skipPoolSync &&
      (_hostAndroid || sidecar.committed == ClosureSendMode.connectBare);

  /// SYNCING while this wallet's coins are still opening. CONNECTED with the
  /// sealed height once that collation has finished. A quiet phone with no
  /// live tip stays "not connected". A book this device already saved keeps
  /// that word until a sample actually returns: the note re-read is not a
  /// new connection. Connect bare uses the Flyclient sample for that word.
  /// The note scan still paints spendable on its own.
  String _linkWord() {
    if (_usesFlyclientTip) {
      final quietBook =
          ledger.restoredBook && ledger.sealedHeight > 0 && !_flyOk && !_flyFailed;
      return connectBareLinkWord(
        sampling: !quietBook &&
            (_flySampling || (_spendSyncing && !_flyOk && !_flyFailed)),
        sampleOk: _flyOk,
        sampleFailed: _flyFailed && !_flyOk,
        sampleTip: _flyTip,
        noteTip: ledger.sealedHeight,
        sampleGenesis: _flyGenesis,
        noteGenesis: ledger.chainGenesis,
      );
    }
    if (_spendSyncing) return 'SYNCING';
    if (_bookCollated && ledger.sealedHeight > 0 && !_tipHud.ibd) return 'CONNECTED';
    if (_tipHud.live && !_tipHud.ibd) return 'CONNECTED';
    return 'not connected';
  }

  bool get _flyDisagree =>
      _flyOk &&
      flyclientTipDisagrees(
        sampleTip: _flyTip,
        noteTip: ledger.sealedHeight,
        sampleGenesis: _flyGenesis,
        noteGenesis: ledger.chainGenesis,
      );

  String _barHeightText() {
    if (!_usesFlyclientTip) {
      if (_hostAndroid) {
        final sealed = ledger.sealedHeight;
        return sealed > 0 ? 'height $sealed' : 'height —';
      }
      return _tipHud.label;
    }
    if (_flyDisagree && _flyTip > 0) {
      return _hostAndroid ? 'height $_flyTip' : 'block height: tip disagree · $_flyTip';
    }
    if (_flyFailed) {
      if (_hostAndroid) {
        final sealed = ledger.sealedHeight;
        // A failed sample must not blank a height this device already saved.
        if (ledger.restoredBook && sealed > 0) return 'height $sealed';
        return 'height —';
      }
      return 'block height: sample failed';
    }
    if (_flyOk && _flyTip > 0) {
      return _hostAndroid ? 'height $_flyTip' : 'block height: height $_flyTip';
    }
    if (_hostAndroid) {
      final sealed = ledger.sealedHeight;
      return sealed > 0 ? 'height $sealed' : 'height —';
    }
    return _tipHud.label;
  }

  bool get _heightAmber => _usesFlyclientTip
      ? (_flyDisagree || _flyFailed || !_flyOk)
      : _tipHud.amber;

  /// Header sample beside the note scan. It never reads a dest balance.
  Future<void> _runFlyclientSample() async {
    if (_flyBusy || !mounted || !_usesFlyclientTip) return;
    final sync = ledger.pool?.sync;
    if (sync == null) return;
    _flyBusy = true;
    if (!_flyOk && !_flyFailed && mounted) {
      setState(() => _flySampling = true);
    }
    try {
      await sync.sampleFlyclient();
      if (!mounted) return;
      // A live genesis that is not the cached stub drops height 20 and seeks
      // that book's tip, including height 1.
      final liveGenesis = sync.flyclientGenesis ?? '';
      if (sync.flyclientOk && liveGenesis.isNotEmpty) {
        ledger.bindChainGenesis(liveGenesis);
      }
      final disagree = sync.flyclientOk &&
          flyclientTipDisagrees(
            sampleTip: sync.flyclientTip,
            noteTip: ledger.sealedHeight,
            sampleGenesis: sync.flyclientGenesis,
            noteGenesis: ledger.chainGenesis,
          );
      setState(() {
        _flySampling = false;
        _flyOk = sync.flyclientOk;
        _flyFailed = !sync.flyclientOk;
        _flyTip = sync.flyclientTip;
        _flyGenesis = sync.flyclientGenesis;
      });
      if (sync.flyclientOk && !disagree && sync.flyclientTip > 0) {
        final beforeTip = ledger.sealedHeight;
        if (sync.flyclientTip > ledger.sealedHeight) {
          ledger.noteLiveHeight(sync.flyclientTip);
        }
        if (ledger.sealedHeight > beforeTip) {
          _tipNoteKicks = 0;
          unawaited(_kickNotesForTip());
        }
        if (sync.flyclientTip > sidecar.seekerTip) {
          sidecar.seekerTip = sync.flyclientTip;
        }
        sidecar.adoptBookPin(
          genesis: sync.flyclientGenesis,
          magic: kBookMagic,
          trustedTip: sync.flyclientTip,
        );
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _flySampling = false;
          _flyFailed = true;
          _flyOk = false;
        });
      }
    } finally {
      _flyBusy = false;
    }
  }

  /// Android keeps the logo, the link, and the sealed height. The mode chip,
  /// version, and theme control stay on the wider desktop bar.
  PreferredSizeWidget _topBar(BuildContext context) {
    if (_hostAndroid) {
      final heightLabel = _barHeightText();
      final link = _linkWord();
      // A saved book already knows its height. The first open still waits.
      final showRestored = ledger.restoredBook && ledger.sealedHeight > 0;
      final showHeight = showRestored ||
          (_chromeReady &&
              (!_spendSyncing || (_usesFlyclientTip && _flyOk && _flyTip > 0)));
      final banner = Theme.of(context).appBarTheme.backgroundColor;
      return AppBar(
        key: const Key('android-top-banner'),
        automaticallyImplyLeading: false,
        backgroundColor: banner,
        foregroundColor: Theme.of(context).appBarTheme.foregroundColor,
        toolbarHeight: 56,
        titleSpacing: 8,
        title: Row(
          children: [
            Flexible(
              child: FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: _brandLockup(mark: 28, wordHeight: 16),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                link,
                key: const Key('wallet-connected'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
              ),
            ),
            const SizedBox(width: 8),
            if (showHeight)
              Text(
                heightLabel,
                key: const Key('wallet-block-height'),
                maxLines: 1,
                overflow: TextOverflow.fade,
                softWrap: false,
                style: TextStyle(
                  fontSize: 13,
                  color: _heightAmber
                      ? const Color(0xFFE6A817)
                      : Theme.of(context).colorScheme.onSurface,
                ),
              ),
            IconButton(
              key: const Key('android-banner-theme'),
              tooltip: _themeMode == ThemeMode.dark ? 'Light mode' : 'Dark mode',
              visualDensity: VisualDensity.compact,
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
              onPressed: _toggleTheme,
              icon: Icon(_themeMode == ThemeMode.dark ? Icons.light_mode : Icons.dark_mode),
            ),
          ],
        ),
      );
    }
    return AppBar(
      automaticallyImplyLeading: false,
      toolbarHeight: 64,
      titleSpacing: 12,
      title: FittedBox(
        fit: BoxFit.scaleDown,
        alignment: Alignment.centerLeft,
        child: Row(
          children: [
            _brandLockup(mark: 44, wordHeight: 32),
            const SizedBox(width: 10),
            Text('$kWalletVersion  ${kSymbols[tab]}'),
            const SizedBox(width: 10),
            Text(
              _linkWord(),
              key: const Key('wallet-connected'),
              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700),
            ),
          ],
        ),
      ),
      actions: [
        FittedBox(
          fit: BoxFit.scaleDown,
          child: Row(
            children: [
              if (_chromeReady)
                Padding(
                padding: const EdgeInsets.only(right: 8),
                child: Text(
                  closureChipLabel(sidecar.committed),
                  key: Key(closureChipKey(sidecar.committed)),
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    color: sidecar.committed == ClosureSendMode.connectBare
                        ? const Color(0xFF5EEAD4)
                        : sidecar.committed == ClosureSendMode.localNode
                            ? const Color(0xFF00E5FF)
                            : const Color(0xFF39FF14),
                  ),
                ),
              ),
              if (_verifying)
                const Padding(
                  padding: EdgeInsets.only(right: 8),
                  child: Text('Verifying…', key: Key('unlock-verifying')),
                ),
              if (_chromeReady && (!_spendSyncing || (_usesFlyclientTip && _flyOk && _flyTip > 0)))
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: InkWell(
                    onTap: (kDebugMode || widget.demoTx) ? _findBlock : null,
                    child: Text(
                      _barHeightText(),
                      key: const Key('wallet-block-height'),
                      style: TextStyle(
                        fontSize: 12,
                        color: _heightAmber
                            ? const Color(0xFFE6A817)
                            : Theme.of(context).colorScheme.onSurface,
                      ),
                    ),
                  ),
                ),
              IconButton(
                tooltip: _themeMode == ThemeMode.dark ? 'Light mode' : 'Dark mode',
                onPressed: _toggleTheme,
                icon: Icon(_themeMode == ThemeMode.dark ? Icons.light_mode : Icons.dark_mode),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _shell(BuildContext context) {
    final ident = id;
    if (ident == null) {
      return Scaffold(
        backgroundColor: Theme.of(context).scaffoldBackgroundColor,
        body: const Center(child: CircularProgressIndicator()),
      );
    }
    final pages = <Widget Function()>[
      () => _showBookLoading ? _bookLoading() : _continuum(context, ident),
      () => _flow(context, ident),
      () => _resistance(context),
      () => _vortex(context, ident),
      () => _shearview(context, ident),
      () => _closure(context, ident),
    ];
    return Scaffold(
      backgroundColor: Theme.of(context).scaffoldBackgroundColor,
      appBar: _topBar(context),
      body: Stack(
        children: [
          Column(
            children: [
              if (!kIsWeb && Platform.isMacOS && isEphemeralMacosLaunchPath(_exe))
                MaterialBanner(
                  backgroundColor: Theme.of(context).bannerTheme.backgroundColor,
                  content: Text(
                    macosMoveBody,
                    style: Theme.of(context).bannerTheme.contentTextStyle,
                  ),
                  actions: const [SizedBox.shrink()],
                ),
              Expanded(child: pages[tab]()),
            ],
          ),
          if (_hopProgress != null)
            Positioned.fill(
              child: AbsorbPointer(
                child: ColoredBox(
                  color: const Color(0x66000000),
                  child: Center(
                    child: Card(
                      key: const Key('reserve-hop-progress'),
                      child: Padding(
                        padding: const EdgeInsets.all(20),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const SizedBox(
                              width: 22,
                              height: 22,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                            const SizedBox(width: 16),
                            Text(_hopProgress!, key: const Key('reserve-hop-progress-text')),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: tab,
        onDestinationSelected: (i) {
          setState(() => tab = i);
          if (kTabs[i] == 'Vortex') unawaited(_warmVortexBalance());
        },
        destinations: [
          for (var i = 0; i < kTabs.length; i++)
            NavigationDestination(
              icon: Tooltip(
                message: kExplains[i],
                waitDuration: const Duration(milliseconds: 400),
                child: Text(
                  kSymbols[i],
                  style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.onSurface),
                ),
              ),
              label: kTabs[i],
            ),
        ],
      ),
    );
  }

  /// Same walk the new-block path runs. Tests call this; the tip path calls it too.
  @visibleForTesting
  Future<void> populateHeldBlocksNow() => _openBareProofs();

  /// The indicator future returns immediately. Tip and credit sync keep running
  /// and publish on the shared paint timer.
  Future<void> _pullRefreshTipAndBalance() {
    final ident = id;
    if (ident == null || widget.skipPoolSync || _pullBusy) {
      return Future<void>.value();
    }
    _pullBusy = true;
    unawaited(_finishPullRefresh(ident));
    return Future<void>.value();
  }

  Future<void> _finishPullRefresh(ShearIdentity ident) async {
    try {
      await _followCredits(ident, full: _fullCreditNow(wantFull: true))
          .timeout(const Duration(seconds: 20));
      _rememberLedger();
      _requestShellPaint();
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Couldn’t refresh tip and balance.')),
        );
      }
    } finally {
      _pullBusy = false;
    }
  }

  Widget _card(List<Widget> kids) {
    return Builder(builder: (context) {
      final list = ListView(
        key: PageStorageKey<String>('tab-$tab'),
        controller: _tabScroll[tab],
        primary: false,
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [_panel(context, kids)],
      );
      final phone = !kIsWeb && (Platform.isAndroid || Platform.isIOS);
      if (!phone) return list;
      return RefreshIndicator(
        key: const Key('wallet-pull-refresh'),
        onRefresh: _pullRefreshTipAndBalance,
        child: list,
      );
    });
  }

  Future<void> _scanReceiveQr(BuildContext context) async {
    String? raw;
    try {
      if (widget.scanQr != null) {
        raw = await widget.scanQr!();
      } else {
        raw = await Navigator.of(context).push<String>(
          MaterialPageRoute(
            builder: (_) => ScanReceiveQrPage(pickImage: widget.pickQrImage),
          ),
        );
      }
    } on MissingPluginException {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Scan failed — could not open image picker.')),
        );
      }
      return;
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              scanQrUsesLiveCamera()
                  ? 'Camera failed: ${flowSendAdvisoryOf(e)}'
                  : 'Scan failed — could not open image picker.',
            ),
          ),
        );
      }
      return;
    }
    if (raw == null || raw.isEmpty) return;
    final got = parseReceiveQr(raw);
    if (got == null) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Not a Shear receive QR.')),
        );
      }
      return;
    }
    flowTo.text = got;
    _noteFlowTo(got);
    if (mounted) setState(() {});
  }

  void _noteFlowTo(String raw) {
    final d = raw.trim();
    final warn = d.isNotEmpty && ledger.warnSpentDestPaste(d)
        ? 'This dest was already used in this wallet.'
        : null;
    if (warn != _spentDestWarn) {
      _spentDestWarn = warn;
    }
  }

  String _offerReceiveDest(ShearIdentity ident) {
    ledger.bindIdentity(ident);
    _flowReceiveDest ??= ledger.allocateReceiveDest(ident.address, paymentCode: ident.paymentCode);
    return _flowReceiveDest!;
  }

  Future<void> _openSocial(String url) async {
    final uri = socialUri(url);
    if (uri == null) return;
    final opener = widget.openUrl;
    if (opener != null) {
      await opener(uri);
      return;
    }
    // External browser only: in-app tabs share cookies and send a referrer.
    await launchUrl(
      uri,
      mode: LaunchMode.externalApplication,
      webOnlyWindowName: '_blank',
    );
  }

  Widget _socialIcon(BuildContext context, String name, String url) {
    final IconData icon;
    switch (name) {
      case 'Discord':
        icon = Icons.forum;
        break;
      case 'Telegram':
        icon = Icons.send;
        break;
      default:
        icon = Icons.close;
    }
    return IconButton(
      tooltip: name,
      onPressed: () => _openSocial(url),
      icon: name == 'X'
          ? const Text('X', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18))
          : Icon(icon),
    );
  }

  Widget _neonText(String text, Color glow, {Key? key}) {
    return Text(
      text,
      key: key,
      style: TextStyle(
        fontWeight: FontWeight.w800,
        color: glow,
        shadows: [
          Shadow(color: glow, blurRadius: 10),
          Shadow(color: glow.withOpacity(0.55), blurRadius: 18),
        ],
      ),
    );
  }

  String _shearviewTitle(String address, ShearTx t) {
    final confs = ledger.confirmationsOf(t.height ?? 0);
    return shearviewListTitle(
      t,
      confs: confs,
      outgoing: ledger.isOutgoingTx(address, t),
    );
  }

  String _shearviewSubtitle(ShearTx t) {
    return shearviewListSubtitle(
      t,
      tipMs: ledger.tipTimestampMs,
      tipHeight: ledger.displayHeight,
      confs: ledger.confirmationsOf(t.height ?? 0),
    );
  }

  List<Widget> _shearviewMemoAdvice(ShearIdentity ident, List<ShearTx> hist) {
    final unread = hist.where((t) {
      if (t.kind != 'receive') return false;
      if (!t.memo || t.memoPlain == null || t.memoPlain!.isEmpty) return false;
      if (ledger.isOutgoingTx(ident.address, t)) return false;
      return !openedMemos.contains(t.id);
    }).toList();
    if (unread.isEmpty) return const [];
    return [
      InkWell(
        key: const Key('shearview-new-memo'),
        onTap: () {
          if (!_newMemoExpanded) setState(() => _newMemoExpanded = true);
        },
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'you have a new memo',
              style: TextStyle(fontWeight: FontWeight.w700, color: shearAccentOf(context)),
            ),
            if (_newMemoExpanded) ...[
              const SizedBox(height: 6),
              for (final t in unread)
                Text(t.memoPlain!, key: Key('shearview-memo-body-${t.id}')),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  key: const Key('shearview-memo-dismiss'),
                  onPressed: () {
                    setState(() {
                      for (final t in unread) {
                        openedMemos.add(t.id);
                      }
                      _newMemoExpanded = false;
                    });
                  },
                  child: const Text('Dismiss'),
                ),
              ),
            ],
          ],
        ),
      ),
    ];
  }

  Widget _glowBanner(BuildContext context, {required Key key, required String text}) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final fill = dark ? const Color(0xFFE8F1F8) : const Color(0xFF0A1628);
    final glow = dark ? const Color(0xFF0088A8) : const Color(0xFF4FD8E8);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        text,
        key: key,
        textAlign: TextAlign.center,
        style: TextStyle(
          fontWeight: FontWeight.w800,
          letterSpacing: 0.5,
          color: glow,
          shadows: [
            Shadow(color: glow, blurRadius: 10),
            Shadow(color: glow.withOpacity(0.5), blurRadius: 18),
          ],
        ),
      ),
    );
  }

  Widget _panel(BuildContext context, List<Widget> kids, {Key? key}) {
    final theme = Theme.of(context);
    return Card(
      key: key,
      color: theme.cardColor,
      surfaceTintColor: Colors.transparent,
      child: SizedBox(
        width: double.infinity,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: DefaultTextStyle.merge(
            style: TextStyle(color: theme.colorScheme.onSurface),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: kids),
          ),
        ),
      ),
    );
  }

  TableRow _continuumStatRow(BuildContext context, String label, String value, {Key? key}) {
    final style = TextStyle(color: shearMutedOf(context), fontSize: 13);
    return TableRow(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 3, horizontal: 0),
          child: Text(label, key: key, style: style),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 3, horizontal: 0),
          child: Text(value, style: style, textAlign: TextAlign.right),
        ),
      ],
    );
  }

  /// One spinner. No step list. The bar stays so the shell is still responding.
  Widget _bookLoading() {
    return const Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          CircularProgressIndicator(key: Key('continuum-loading')),
          SizedBox(height: 16),
          Text('Loading', key: Key('continuum-loading-label')),
        ],
      ),
    );
  }

  Widget _continuum(BuildContext context, ShearIdentity ident) {
    final spend = ledger.spendableOwned(ident.address, paymentCode: ident.paymentCode);
    final spendReady = !_spendableAwaiting &&
        ledger.spendableFigureReady(ident.address, paymentCode: ident.paymentCode);
    final unconfirmed = ledger.unconfirmedIncomingShe(ident.address, paymentCode: ident.paymentCode);
    final pending = ledger.pendingTxs(ident.address);
    final reserveDest = _reserveDestOf(ident);
    final inReserveNanos = reserveDest == null ? 0 : reserve.portal(reserveDest).nanos;
    final path1 = ledger.path1Observation();
    final fluxSec = (path1.targetIntervalMs / 1000).round();
    final observed = observedIntervalLabel(ledger.sealedMeanBlockMs);
    final integral = integralQCirculationLabel(ledger.circulatingNanos);
    final avgReward = avgBlockRewardLabel(
      potEmittedNanos: ledger.potEmittedNanos,
      hashBonusEmittedNanos: ledger.hashBonusEmittedNanos,
      height: ledger.emittedAtHeight ?? 0,
    );
    final resistance = resistanceBitsLabel(ledger.networkWorkBits);
    final spendPane = <Widget>[
      Text(
        spendReady ? '${formatShe(spend)} SHE' : '…',
        key: const Key('continuum-spendable'),
        style: TextStyle(
          fontSize: 28,
          fontWeight: FontWeight.w700,
          color: shearAccentOf(context),
        ),
      ),
      Text('Spendable', style: TextStyle(color: shearMutedOf(context))),
      if (unconfirmed > 0)
        Text(
          'Unconfirmed  ${formatShe(unconfirmed)} SHE',
          key: const Key('continuum-unconfirmed'),
          style: TextStyle(color: shearMutedOf(context), fontSize: 13),
        ),
      if (fundsNotCorrectlyShown(
        spendableShe: spend,
        circulatingNanos: ledger.circulatingNanos,
      ))
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Text(
            kFundsNotCorrectlyShown,
            key: const Key('continuum-funds-not-shown'),
            style: TextStyle(
              color: Theme.of(context).colorScheme.error,
              fontWeight: FontWeight.w700,
              fontSize: 14,
            ),
          ),
        ),
      if (inReserveNanos > 0) ...[
        const SizedBox(height: 8),
        TextButton(
          key: const Key('continuum-in-reserve'),
          style: TextButton.styleFrom(
            padding: EdgeInsets.zero,
            minimumSize: Size.zero,
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            alignment: Alignment.centerLeft,
          ),
          onPressed: () => setState(() => tab = kTabs.indexOf('Vortex')),
          child: Text(
            'In Reserve  ${formatShe(inReserveNanos / kUnitsPerShe)} SHE  ·  The Reserve',
            style: TextStyle(fontWeight: FontWeight.w700, color: Theme.of(context).colorScheme.onSurface),
          ),
        ),
        Text(
          'Locked in The Reserve (Resistance portal). Not Continuum spendable.',
          style: TextStyle(color: shearMutedOf(context), fontSize: 12),
        ),
      ],
      if (spendReady && spend == 0 && pending.isEmpty) ...[
        const SizedBox(height: 8),
        Text(
          'Sync a local node at 127.0.0.1:18332. Tip, blocks, and lands come from the node network. If that feed is missing, those fields stay empty. Pool HUD is not the chain. Spendable is coins with 9 confirmations. Unconfirmed is coins still arriving. This book starts empty until your first landing.',
          key: const Key('continuum-empty-honesty'),
          style: TextStyle(color: shearMutedOf(context), fontSize: 12),
        ),
      ],
      const SizedBox(height: 12),
      Text('Receive ID', style: TextStyle(fontWeight: FontWeight.w700, color: Theme.of(context).colorScheme.onSurface)),
      const SizedBox(height: 6),
      SelectableText(ident.paymentCodeFull, key: const Key('receive-she1-full')),
      const SizedBox(height: 8),
      OutlinedButton(
        key: const Key('copy-id'),
        onPressed: () => Clipboard.setData(ClipboardData(text: ident.paymentCodeFull)),
        child: const Text('Copy ID'),
      ),
      const SizedBox(height: 12),
      Text('Receive QR', style: TextStyle(fontWeight: FontWeight.w700, color: Theme.of(context).colorScheme.onSurface)),
      const SizedBox(height: 6),
      OutlinedButton(
        key: const Key('show-qr'),
        onPressed: () => setState(() => _showReceiveQr = !_showReceiveQr),
        child: Text(_showReceiveQr ? 'Hide QR code' : 'Show QR code'),
      ),
      if (_showReceiveQr) ...[
        const SizedBox(height: 6),
        Center(
          child: ColoredBox(
            color: Colors.white,
            child: CustomPaint(
              key: const Key('receive-qr'),
              size: const Size(320, 320),
              painter: QrPainter(
                data: encodeReceiveQr(ident.paymentCodeFull),
                version: QrVersions.auto,
                gapless: true,
              ),
            ),
          ),
        ),
      ],
      const SizedBox(height: 12),
      Text('ssa1 dest — mining mailbox', style: TextStyle(fontWeight: FontWeight.w700, color: Theme.of(context).colorScheme.onSurface)),
      const SizedBox(height: 6),
      SelectableText(ledger.homeDest(ident.address, paymentCode: ident.paymentCode), key: const Key('continuum-ssa1')),
      const SizedBox(height: 8),
      OutlinedButton(
        key: const Key('copy-dest'),
        onPressed: () {
          final shown = ledger.homeDest(ident.address, paymentCode: ident.paymentCode);
          Clipboard.setData(ClipboardData(text: shown));
        },
        child: const Text('Copy dest'),
      ),
      const SizedBox(height: 6),
      Text(
        'Copy dest copies the mailbox shown above. Stable mining login for ShearK / stratum. Copy once — you do not need to continually update your miner dest.',
        style: TextStyle(color: Theme.of(context).colorScheme.onSurface.withOpacity(0.7)),
      ),
    ];
    final statsPane = <Widget>[
      Text(
        '1 SHE per block continuity',
        style: TextStyle(fontWeight: FontWeight.w700, color: Theme.of(context).colorScheme.onSurface),
      ),
      const SizedBox(height: 8),
      Table(
        columnWidths: const {
          0: FlexColumnWidth(1.3),
          1: FlexColumnWidth(1),
        },
        defaultVerticalAlignment: TableCellVerticalAlignment.middle,
        children: [
          _continuumStatRow(context, 'Height', '${ledger.displayHeight}'),
          if (ledger.networkHashrate != null)
            _continuumStatRow(
              context,
              'Network hashrate',
              '${ledger.networkHashrate} H/s',
            ),
          _continuumStatRow(context, 'Closure quantum', '${formatShe(path1.quantumShe)} SHE'),
          _continuumStatRow(context, 'Target flux', '${formatShe(path1.quantumShe)} SHE / $fluxSec s'),
          if (observed.isNotEmpty)
            _continuumStatRow(context, 'Observed interval', observed),
          if (integral != '—')
            _continuumStatRow(
              context,
              'Integral Q',
              integral,
              key: const Key('continuum-integral-q'),
            ),
          _continuumStatRow(
            context,
            'Hash bonus',
            continuumHashBonusLabel(
              emittedNanos: (ledger.confirmedHashBonus(
                        ident.address,
                        paymentCode: ident.paymentCode,
                      ) *
                      kUnitsPerShe)
                  .round(),
            ),
            key: const Key('continuum-hash-bonus'),
          ),
          if (avgReward != '—')
            _continuumStatRow(
              context,
              'Avg block reward',
              avgReward,
              key: const Key('continuum-avg-block-reward'),
            ),
          _continuumStatRow(
            context,
            'VAULT',
            '${formatShe(_continuumVaultNanos / kUnitsPerShe)} SHE',
            key: const Key('continuum-vault'),
          ),
          _continuumStatRow(
            context,
            'Extra minted',
            '${formatShe(_continuumExtraMintedNanos / kUnitsPerShe)} SHE',
            key: const Key('continuum-extra-minted'),
          ),
          if (resistance.isNotEmpty)
            _continuumStatRow(context, 'Resistance', resistance),
        ],
      ),
      if (spendableExceedsCirculating(
        spendableShe: spend,
        circulatingNanos: ledger.circulatingNanos,
      ))
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Text(
            kFundsNotCorrectlyShown,
            key: const Key('continuum-supply-banner'),
            style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 13),
          ),
        ),
      const SizedBox(height: 12),
      Row(
        children: [
          _socialIcon(context, 'Discord', kDiscordUrl),
          _socialIcon(context, 'Telegram', kTelegramUrl),
          _socialIcon(context, 'X', kXUrl),
        ],
      ),
    ];
    final pendingPane = <Widget>[
      Text('Pending', style: TextStyle(fontWeight: FontWeight.w700, color: Theme.of(context).colorScheme.onSurface)),
      Text(
        'Each pending transfer stays on this list. Tap a row to open it in Shearview. One vortex point turns yellow per confirmation; at ${ShearLedger.spendableConfirmations} confs the row drops and the coins are spendable. Hash rewards sit inside a found block, not as their own rows.',
        style: TextStyle(color: shearMutedOf(context), fontSize: 12),
      ),
      for (final t in pending)
        InkWell(
          key: ValueKey('pending-row-${t.id}'),
          onTap: () => _openPendingInShearview(t),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                ConfirmVortex(
                  key: Key('confirm-pie-${t.id}'),
                  filled: ledger.confirmationsOf(t.height ?? 0),
                  size: 28,
                  need: ShearLedger.continuumConfirmations,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${continuumPendingRemark(t, outgoing: ledger.isOutgoingTx(ident.address, t))}  ${formatShe(t.amount)} SHE',
                        style: const TextStyle(fontSize: 13),
                      ),
                      Text(
                        '${ledger.confirmationsOf(t.height ?? 0).clamp(0, ShearLedger.continuumConfirmations)}/${ShearLedger.continuumConfirmations} conf  ${t.from} → ${t.to}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: shearMutedOf(context), fontSize: 11),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
    ];
    return LayoutBuilder(builder: (context, constraints) {
      final wide = constraints.maxWidth >= kContinuumSplitWidth;
      return ListView(
        controller: _tabScroll[0],
        primary: false,
        padding: const EdgeInsets.all(16),
        children: [
          if (ledger.blankFork || ledger.vaultSealBanner.isNotEmpty) ...[
            Text(
              ledger.vaultSealBanner.isNotEmpty
                  ? ledger.vaultSealBanner
                  : 'This tip diverged before the Reserve vault seal. This fork has no Reserve vault.',
              key: const Key('continuum-vault-seal-banner'),
              style: TextStyle(
                color: Theme.of(context).colorScheme.error,
                fontSize: 13,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 12),
          ],
          if (wide && !_hostAndroid)
            IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(
                    flex: 2,
                    child: _panel(context, spendPane, key: const Key('continuum-spend')),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    flex: 1,
                    child: _panel(context, statsPane, key: const Key('continuum-stats')),
                  ),
                ],
              ),
            )
          else ...[
            _panel(context, spendPane, key: const Key('continuum-spend')),
            if (!_hostAndroid) ...[
              const SizedBox(height: 12),
              _panel(context, statsPane, key: const Key('continuum-stats')),
            ],
          ],
          if (pending.isNotEmpty) ...[
            const SizedBox(height: 12),
            _panel(context, pendingPane),
          ],
        ],
      );
    });
  }

  void _openPendingInShearview(ShearTx t) {
    setState(() {
      shearviewQuery.text = t.id;
      _focusedTxId = t.id;
      tab = kTabs.indexOf('Shearview');
    });
  }

  /// Shearview rows for the current search, plus a pending row the search
  /// names when that transfer is not yet in the sealed landing list.
  List<ShearTx> _shearviewRows(String address) {
    final query = shearviewQuery.text;
    final hist = ledger.shearviewSearch(address, query);
    final have = hist.map((t) => t.id).toSet();
    final extra = ledger.pendingTxs(address).where((t) => !have.contains(t.id) && shearviewMatches(t, query));
    return [...extra, ...hist];
  }

  Widget _shearview(BuildContext context, ShearIdentity ident) {
    final hist = _shearviewRows(ident.address);
    return _card([
      const Text('Shearview  S_{μν}', style: TextStyle(fontWeight: FontWeight.w700)),
      Text(
        'Your transactions: height, from/to, date, amount, snippet. Tap a row for full Resistance detail. A block pot share is the parent. Hash bonuses paid in that block are children under it. The two amounts add.',
        style: TextStyle(color: shearMutedOf(context)),
      ),
      Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          TextButton(
            key: const Key('shearview-clear'),
            onPressed: () {
              shearviewQuery.clear();
              setState(() {});
            },
            child: const Text('Clear'),
          ),
          Expanded(
            child: TextField(
              key: const Key('shearview-search'),
              controller: shearviewQuery,
              decoration: const InputDecoration(labelText: 'Search id, dest, kind, amount, height, memo'),
              onChanged: (_) => setState(() {}),
            ),
          ),
        ],
      ),
      ..._shearviewMemoAdvice(ident, hist),
      if (hist.isEmpty)
        Text(
          'No landings yet. A found block seals hash bonus and your pot share (after the 1% fee) to this dest in that block. Spendable after 9 confirmations. Tap a row for full Resistance detail.',
          key: const Key('shearview-empty'),
          style: TextStyle(color: shearMutedOf(context)),
        ),
      for (final row in shearviewTree(hist))
        Padding(
          padding: EdgeInsets.only(left: row.child ? 28 : 0),
          child: ListTile(
          key: Key(row.child ? 'shearview-hash-${row.tx.id}' : 'shearview-row-${row.tx.id}'),
          dense: true,
          isThreeLine: !row.child,
          selected: row.tx.id == _focusedTxId,
          title: Text(row.child
              ? 'h=${row.tx.height ?? 0}  hashbonus  ${formatShe(row.tx.amount)} SHE'
              : _shearviewTitle(ident.address, row.tx)),
          subtitle: row.child
              ? null
              : Text(
            row.tx.kind == 'receive' && row.tx.memo && openedMemos.contains(row.tx.id) && row.tx.memoPlain != null
                ? '${_shearviewSubtitle(row.tx)}  memo: ${row.tx.memoPlain}'
                : _shearviewSubtitle(row.tx),
          ),
          onTap: () async {
            final t = row.tx;
            if (row.child) {
              setState(() => _focusedTxId = t.id);
              return;
            }
            if (t.memo && t.memoPlain == null && t.memoCt != null) {
              final plain = await memoOpenOffUi(t.to, t.memoCt);
              ledger.applyMemoPlain(t.id, plain);
            }
            if (!mounted) return;
            setState(() {
              if (t.memo) {
                openedMemos.add(t.id);
                lastMemoPlain = t.memoPlain ?? ledger.ownerHistory(ident.address)
                    .cast<ShearTx?>()
                    .firstWhere((x) => x!.id == t.id, orElse: () => t)
                    ?.memoPlain;
              }
              _ingestTx(ident, t);
              _focusedTxId = t.id;
              tab = _resistanceTab;
            });
          },
        ),
        ),
    ]);
  }

  Widget _flow(BuildContext context, ShearIdentity ident) {
    return _card([
      const Text('Flow  J^μ', style: TextStyle(fontWeight: FontWeight.w700)),
      const Text('Pay she1, ssa1, or shear1. The book only records an ssa1 dest. Coins settle on destCommit after 9 confirms.'),
      SelectableText(_offerReceiveDest(ident), key: const Key('flow-receive-dest')),
      const SizedBox(height: 8),
      OutlinedButton(
        key: const Key('flow-new-dest'),
        onPressed: () => setState(() {
          _flowReceiveDest = ledger.allocateReceiveDest(ident.address, paymentCode: ident.paymentCode);
        }),
        child: const Text('New dest'),
      ),
      const SizedBox(height: 8),
      TextField(
        controller: flowTo,
        decoration: const InputDecoration(labelText: 'To (she1, ssa1, or shear1)'),
        onChanged: (v) => setState(() => _noteFlowTo(v)),
      ),
      if (_spentDestWarn != null) ...[
        const SizedBox(height: 8),
        Text(_spentDestWarn!, key: const Key('spent-dest-warn')),
      ],
      const SizedBox(height: 8),
      OutlinedButton(
        key: const Key('scan-qr'),
        onPressed: () => _scanReceiveQr(context),
        child: const Text('Scan receive QR'),
      ),
      const SizedBox(height: 8),
      OutlinedButton(
        key: const Key('flow-paste'),
        onPressed: () async {
          final data = await Clipboard.getData('text/plain');
          final raw = data?.text ?? '';
          final next = applyReceiveQrTo(flowTo.text, raw);
          if (next == flowTo.text) {
            final copy = receiveQrFailCopy(raw);
            if (copy != null && context.mounted) {
              ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(copy)));
            }
            return;
          }
          setState(() {
            flowTo.text = next;
            _noteFlowTo(next);
          });
        },
        child: const Text('Paste receive code'),
      ),
      const SizedBox(height: 20),
      TextField(
        key: const Key('flow-amount'),
        controller: flowAmt,
        decoration: const InputDecoration(labelText: 'Amount SHE'),
        keyboardType: TextInputType.number,
      ),
      TextField(controller: flowMemo, decoration: const InputDecoration(labelText: 'Memo (optional)')),
      FilledButton(
        key: const Key('flow-send'),
        onPressed: () async {
          if (sidecar.sendBlocked && !walletAtTip(_syncLabel)) {
            setState(() {
              _flowSendAdvisory = sidecar.sendBlockedCopy;
              _flowSendOk = false;
            });
            return;
          }
          final amount = double.tryParse(flowAmt.text) ?? 0;
          final bare = sidecar.committed == ClosureSendMode.connectBare;
          final result = await submitContinuumSend(
            ledger: ledger,
            restFrame: ident.address,
            paymentCode: ident.paymentCode,
            startTo: _flowAcceptedTo,
            enteredTo: flowTo.text,
            amount: amount,
            memo: flowMemo.text.trim().isEmpty ? null : flowMemo.text.trim(),
            spendSeed: hexToBytes(ident.seedHex),
            local: false,
            allowPublicHttp: bare,
            depth: _mempoolDepth,
          );
          if (!mounted) return;
          setState(() {
            flowTo.text = result.to;
            if (result.posted && result.tx != null) {
              _flowAcceptedTo = result.to;
              _ingestTx(ident, result.tx!);
              _focusedTxId = result.tx!.id;
              _flowSendAdvisory = 'sent';
              _flowSendOk = true;
            } else {
              _flowSendAdvisory = result.remark.isEmpty ? kErrSendGeneric : result.remark;
              _flowSendOk = false;
            }
          });
        },
        child: const Text('Send'),
      ),
      if (_flowSendAdvisory != null) ...[
        const SizedBox(height: 8),
        _neonText(
          _flowSendAdvisory!,
          _flowSendOk ? const Color(0xFF00FF41) : const Color(0xFFFF3B3B),
          key: const Key('flow-send-advisory'),
        ),
      ],
      const SizedBox(height: 8),
      Builder(builder: (_) {
        final amt = double.tryParse(flowAmt.text) ?? 0;
        final L = levyNanos((amt * kUnitsPerShe).round());
        return Text('Flow levy (empty mempool) ${formatShe(L / kUnitsPerShe)} SHE. Hash bonuses stay on the found block.');
      }),
      const Text(
        'Receive: she1 (silent pay), ssa1 dest, or shear1 identity. Chain dests are ssa1 only. Spendable is node-verified notes after 9 confirms. Memo plaintext opens only with the stealth shared secret.',
      ),
    ]);
  }

  Widget _resistance(BuildContext context) {
    if (sidecar.showResistanceConsole) _pinNodeConsole();
    final dark = Theme.of(context).brightness == Brightness.dark;
    final bg = dark ? kCliDarkBg : kCliLightBg;
    final fg = dark ? kCliDarkFg : kCliLightFg;
    final ident = id;
    ShearTx? focused;
    if (ident != null && _focusedTxId != null) {
      for (final t in ledger.shearviewTxs(ident.address)) {
        if (t.id == _focusedTxId) {
          focused = t;
          break;
        }
      }
    }
    final header = focused == null
        ? ''
        : resistanceTxHeader(
            focused,
            confs: ledger.confirmationsOf(focused.height ?? 0),
          );
    return ColoredBox(
      key: const Key('resistance-cli'),
      color: bg,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Resistance  η  —  Tx detail',
                    style: TextStyle(
                      color: fg,
                      fontFamily: 'Courier',
                      fontWeight: FontWeight.w700,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                TextButton(
                  key: const Key('resistance-start'),
                  onPressed: () => _resistanceStart(context),
                  child: Text('Start', style: TextStyle(color: fg, fontFamily: 'Courier')),
                ),
                TextButton(
                  key: const Key('resistance-stop'),
                  onPressed: () => _resistanceStop(context),
                  child: Text('Stop', style: TextStyle(color: fg, fontFamily: 'Courier')),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              sidecar.progress.isEmpty
                  ? 'Start continues from the saved tip. Stop saves the current tip.'
                  : sidecar.progress,
              key: const Key('resistance-sync-height'),
              style: TextStyle(color: fg, fontFamily: 'Courier', fontSize: 12, height: 1.35),
            ),
            const SizedBox(height: 8),
            if (header.isNotEmpty) ...[
              SelectableText(
                header,
                key: const Key('resistance-tx-header'),
                style: TextStyle(
                  color: fg,
                  fontFamily: 'Courier',
                  fontSize: 12,
                  height: 1.35,
                ),
              ),
              const SizedBox(height: 8),
            ],
            Expanded(
              flex: sidecar.showResistanceConsole ? 2 : 1,
              child: Container(
                color: bg,
                alignment: Alignment.topLeft,
                child: SingleChildScrollView(
                  controller: _tabScroll[2],
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (header.isEmpty)
                        SelectableText(
                          _cliText,
                          style: TextStyle(
                            color: fg,
                            fontFamily: 'Courier',
                            fontSize: 12,
                            height: 1.35,
                          ),
                        )
                      else ...[
                        TextButton(
                          key: const Key('ctf-transcript-toggle'),
                          onPressed: () => setState(() => _showCtfTranscript = !_showCtfTranscript),
                          child: Text(
                            _showCtfTranscript ? 'Hide CTF transcript' : 'CTF transcript',
                            style: TextStyle(
                              color: fg,
                              fontFamily: 'Courier',
                              fontSize: 12,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                        if (_showCtfTranscript)
                          SelectableText(
                            _cliText,
                            style: TextStyle(
                              color: fg,
                              fontFamily: 'Courier',
                              fontSize: 12,
                              height: 1.35,
                            ),
                          ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
            if (sidecar.showResistanceConsole)
              Column(
                key: const Key('resistance-node-console'),
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Node output',
                    key: const Key('resistance-node-console-title'),
                    style: TextStyle(color: fg, fontFamily: 'Courier', fontWeight: FontWeight.w700),
                  ),
                  SizedBox(
                    key: const Key('resistance-node-console-scroll'),
                    height: 12 * 1.2 * 9,
                    child: SingleChildScrollView(
                      controller: _nodeConsoleScroll,
                      child: sidecar.log.isEmpty
                          ? Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'Waiting for node output…',
                                  key: const Key('resistance-node-console-empty'),
                                  style: const TextStyle(
                                    fontFamily: 'Courier',
                                    fontSize: 12,
                                    height: 1.2,
                                  ),
                                ),
                                if (sidecar.progress.isNotEmpty)
                                  Text(
                                    sidecar.progress,
                                    style: TextStyle(color: fg, fontFamily: 'Courier', fontSize: 12, height: 1.2),
                                  ),
                              ],
                            )
                          : SelectableText(
                              (sidecar.log.length > 80
                                      ? sidecar.log.sublist(sidecar.log.length - 80)
                                      : sidecar.log)
                                  .join('\n'),
                              key: const Key('resistance-node-console-log'),
                              style: TextStyle(color: fg, fontFamily: 'Courier', fontSize: 12, height: 1.2),
                            ),
                    ),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }

  String? _reserveDestOf(ShearIdentity ident) =>
      vaultDest(ident.address, viewKey: ledger.viewSecret ?? ident.viewKey);

  /// Lock rows this wallet already holds, so a thin vault map can replay
  /// this portal's principal instead of painting staked=0.
  List<Map<String, dynamic>> _reserveLockRows(String dest) {
    final pid = portalIdFromDest(dest);
    final rows = <Map<String, dynamic>>[];
    for (final t in ledger.transactions) {
      if (t.kind != 'lock' && t.kind != 'withdraw') continue;
      if (t.amount <= 0 && t.kind == 'lock') continue;
      final to = t.to;
      if (to != dest && portalIdFromDest(to) != pid) continue;
      rows.add({
        'id': t.id,
        'kind': t.kind,
        'portalId': pid,
        'dest': to.isNotEmpty ? to : dest,
        'nanos': (t.amount * kUnitsPerShe).round(),
      });
    }
    return rows;
  }

  String _txFeeAdvice(int amountNanos, {required String oneFeeTo, int? depth}) {
    final L = levyNanos(amountNanos, depth: depth ?? _mempoolDepth);
    return 'Tx fee ${formatShe(L / kUnitsPerShe)} SHE from Continuum spendable (mempool L now). One fee to $oneFeeTo.';
  }

  Future<int> _mempoolDepthNow() async {
    if (ledger.pool == null || widget.skipPoolSync) return _mempoolDepth;
    try {
      final p = await ledger.pool!.mempoolPressure();
      _mempoolDepth = (p['depth'] as num?)?.toInt() ?? _mempoolDepth;
    } catch (_) {}
    return _mempoolDepth;
  }

  Future<void> _reserveSend(BuildContext context, ShearIdentity ident) async {
    final dest = _reserveDestOf(ident);
    if (dest == null) return;
    final she = double.tryParse(reserveAmt.text.trim()) ?? 0;
    if (!unprivateAmountPermitted(she)) return;
    final depth = await _mempoolDepthNow();
    final lockNanos = (she * kUnitsPerShe).round();
    final lockL = levyNanos(lockNanos, depth: depth);
    final need = she + lockL / kUnitsPerShe;
    final painted = paintedContinuumSpendable(ledger, ident.address, paymentCode: ident.paymentCode);
    if (painted + 1e-12 < need) {
      final remark = lockFundingShortfall(LockFundingPlan(
        sources: const [],
        from: null,
        consolidate: false,
        have: painted,
        need: need,
      ));
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(remark)));
      }
      return;
    }
    final go = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        key: const Key('reserve-sign'),
        title: const Text('Sign Reserve deposit'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Lock ${formatShe(she)} SHE into The Reserve.\n'
              'This spends Continuum and locks the coins in your portal until the epoch ends.',
            ),
            const SizedBox(height: 8),
            Text(
              _txFeeAdvice(lockNanos, oneFeeTo: 'add funds to the vault', depth: depth),
              key: const Key('reserve-lock-sign-levy'),
            ),
          ],
        ),
        actions: [
          TextButton(
            key: const Key('reserve-sign-cancel'),
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const Key('reserve-sign-accept'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Sign'),
          ),
        ],
      ),
    );
    if (go != true || !mounted) return;
    await _reserveLockPosted(
      context,
      ident,
      dest: dest,
      she: she,
      need: need,
      levyShe: lockL / kUnitsPerShe,
    );
  }

  void _showLocalNodeSynced() {
    final ctx = _nav.currentContext;
    if (ctx == null) return;
    showDialog<void>(
      context: ctx,
      builder: (dctx) => AlertDialog(
        key: const Key('local-node-synced'),
        title: const Text('Local node synced'),
        content: const Text(
          'Your wallet local node is synced to the tip. Sends can use local-node mode.',
        ),
        actions: [
          TextButton(
            key: const Key('local-node-synced-ok'),
            onPressed: () => Navigator.pop(dctx),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  TipHud get _tipHud {
    final live = ledger.pool?.nodeLive == true && !sidecar.seekerDishonest;
    final seek = live ? ledger.pool?.liveTip : null;
    final ibd = sidecar.seekerDishonest || (sidecar.running && !sidecar.honest);
    return tipHud(
      sealed: ledger.sealedHeight,
      seek: seek,
      live: live,
      ibd: ibd,
    );
  }

  String get _syncLabel => _tipHud.syncWord;

  void _touchOwedClock(double owedShe) {
    final nowMs = DateTime.now().millisecondsSinceEpoch;
    if (owedShe <= 0) {
      _owedAnchorMs = 0;
      _owedAnchorShe = 0;
      return;
    }
    if (_owedAnchorMs == 0 || owedShe != _owedAnchorShe) {
      _owedAnchorMs = nowMs;
      _owedAnchorShe = owedShe;
    }
  }

  int _owedMatureLeftMs(double owedShe) {
    _touchOwedClock(owedShe);
    return owedMatureLeftMs(
      owedShe: owedShe,
      anchoredShe: _owedAnchorShe,
      anchorMs: _owedAnchorMs,
      nowMs: DateTime.now().millisecondsSinceEpoch,
    );
  }

  bool get _reserveSendReady {
    final she = double.tryParse(reserveAmt.text.trim()) ?? 0;
    if (!unprivateAmountPermitted(she)) return false;
    if (sidecar.committed == ClosureSendMode.localNode ||
        sidecar.committed == ClosureSendMode.localNodeFull) {
      return sidecar.honest || walletAtTip(_syncLabel);
    }
    return true;
  }

  Future<void> _reserveLockPosted(
    BuildContext context,
    ShearIdentity ident, {
    required String dest,
    required double she,
    required double need,
    required double levyShe,
  }) async {
    ledger.rememberVaultDest(dest);
    if (mounted) {
      setState(() => _reserveDepositProgress = 'Consolidating Continuum notes for Deposit…');
      await _yieldUiFrame();
    }
    final result = await postReserveDeposit(
      ledger: ledger,
      reserve: reserve,
      restFrame: ident.address,
      paymentCode: ident.paymentCode,
      dest: dest,
      she: she,
      depth: _mempoolDepth,
      spendSeed: hexToBytes(ident.seedHex),
      local: reserveLockPostsLocal(
        hasPool: ledger.pool != null,
        skipPoolSync: widget.skipPoolSync,
        postReserveLock: widget.postReserveLock,
      ),
    );
    if (!result.posted || result.tx == null) {
      if (mounted) setState(() => _reserveDepositProgress = null);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(result.remark.isEmpty ? 'Not enough Continuum spendable' : result.remark)),
        );
      }
      return;
    }
    final tx = result.tx!;
    final p = reserve.portal(dest);
    _reserveLockHold?.cancel();
    _reserveLockDismissable = false;
    _reserveLockHold = Timer(kReserveLockHold, () {
      if (mounted) setState(() => _reserveLockDismissable = true);
    });
    _reserveLockNotice = {
      'she': she,
      'txid': tx.id,
      'cumulative': p.nanos / kUnitsPerShe,
      'canVote': p.canVote,
      'levyShe': levyShe,
      'sent': kReserveLockSent,
    };
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text(kReserveLockSent)),
      );
    }
    if (mounted) {
      setState(() => _reserveDepositProgress = null);
    }
  }

  /// One frame of budget so the pay/connect card paints before fee crypto or Connect.
  Future<void> _yieldUiFrame() => Future<void>.delayed(const Duration(milliseconds: 1));

  Future<void> _payHopFee(ShearIdentity ident, double need) async {
    final hook = widget.hopFeePay;
    if (hook != null) {
      await hook();
      return;
    }
    final from = ledger.spendFrom(
      ident.address,
      paymentCode: ident.paymentCode,
      amount: need,
    );
    // Spendable covers the fee. Do not scan the note book or wait for one
    // sealed note. Same path on every platform.
    await ledger.send(
      from: from,
      to: kPrivacyHopFeeDest,
      amount: kPrivacyHopFeeShe,
      kind: 'hop-fee',
      local: ledger.pool == null || widget.skipPoolSync,
      restFrame: ident.address,
      paymentCode: ident.paymentCode,
      spendSeed: hexToBytes(ident.seedHex),
      allowPublicHttp: true,
    );
  }

  Future<void> _reserveHopToggle(BuildContext context, ShearIdentity ident) async {
    if (_hopBusy) return;
    if (hop.isUp || hop.isConnecting) {
      await hop.disconnect();
      return;
    }
    if (!privacyHopFeeDestOk(kPrivacyHopFeeDest)) {
      _snack.currentState?.showSnackBar(
        const SnackBar(content: Text('Hop fee dest is not the pool ssa1')),
      );
      return;
    }
    var need = kPrivacyHopFeeShe;
    if (!_hopFeePaidSession) {
      final depth = await _mempoolDepthNow();
      final feeNanos = (kPrivacyHopFeeShe * kUnitsPerShe).round();
      final feeL = levyNanos(feeNanos, depth: depth);
      need = kPrivacyHopFeeShe + feeL / kUnitsPerShe;
      if (ledger.spendableOwned(ident.address, paymentCode: ident.paymentCode) < need) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(
              'Not enough Continuum spendable for hop fee $kPrivacyHopFeeSheText + tx fee ${formatShe(feeL / kUnitsPerShe)} SHE',
            ),
          ));
        }
        return;
      }
      final go = await showDialog<bool>(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => AlertDialog(
          key: const Key('reserve-hop-fee-confirm'),
          title: Text(kPrivacyHopFeeConfirmTitle),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(kPrivacyHopFeeConfirmBody),
              const SizedBox(height: 8),
              Text(
                _txFeeAdvice(feeNanos, oneFeeTo: 'pay the Privacy hop fee', depth: depth),
                key: const Key('reserve-hop-fee-levy'),
              ),
            ],
          ),
          actions: [
            TextButton(
              key: const Key('reserve-hop-fee-cancel'),
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              key: const Key('reserve-hop-fee-accept'),
              onPressed: () => Navigator.pop(ctx, true),
              child: Text(kPrivacyHopFeePayLabel),
            ),
          ],
        ),
      );
      if (go != true || !mounted) return;
    }
    setState(() => _hopBusy = true);
    try {
      if (!_hopFeePaidSession) {
        setState(() => _hopProgress = kHopProgressPaying);
        await _yieldUiFrame();
        if (!mounted) return;
        try {
          await _payHopFee(ident, need);
        } catch (e) {
          if (mounted) {
            setState(() => _hopProgress = null);
            _snack.currentState?.showSnackBar(
              SnackBar(content: Text(hopFeeAdvisoryOf(e))),
            );
          }
          return;
        }
        if (!mounted) return;
        _hopFeePaidSession = true;
      }
      setState(() => _hopProgress = kHopProgressConnecting);
      await _yieldUiFrame();
      if (!mounted) return;
      final ok = await hop.connect();
      if (!mounted) return;
      setState(() => _hopProgress = null);
      if (!ok) {
        _snack.currentState?.showSnackBar(
          SnackBar(content: Text(hop.message.isEmpty ? 'Privacy hop unreachable' : hop.message)),
        );
      }
    } finally {
      if (mounted) {
        setState(() {
          _hopBusy = false;
          if (!hop.isConnecting) _hopProgress = null;
        });
      }
    }
  }

  Future<void> _reserveUnprivateConfirm(BuildContext context) async {
    final go = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        key: const Key('reserve-unprivate-confirm'),
        title: const Text(kUnprivateConfirmTitle),
        content: const Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(kUnprivateConfirmHelper),
          ],
        ),
        actions: [
          TextButton(
            key: const Key('reserve-unprivate-cancel'),
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const Key('reserve-unprivate-accept'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text(kUnprivateConfirmLabel),
          ),
        ],
      ),
    );
    if (go == true && mounted) {
      setState(() => _reserveUnprivateOk = true);
    }
  }

  Future<void> _reserveWithdraw(BuildContext context, ShearIdentity ident) async {
    final dest = _reserveDestOf(ident);
    if (dest == null) return;
    final to = ledger.currentDest(ident.address, paymentCode: ident.paymentCode);
    final now = DateTime.now().millisecondsSinceEpoch;
    final p0 = dest.isNotEmpty ? reserve.portal(dest) : null;
    final canPrev = (p0?.claimableRewards ?? 0) > 0;
    if (!reserve.epochIsOver(now) && !canPrev) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(reserveEpochStillOpenCopy())),
        );
      }
      return;
    }
    final go = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        key: const Key('reserve-withdraw-sign'),
        title: const Text('Sign Reserve withdraw'),
        content: Text(reserveWithdrawDialogCopy()),
        actions: [
          TextButton(
            key: const Key('reserve-withdraw-sign-cancel'),
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const Key('reserve-withdraw-sign-accept'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Sign'),
          ),
        ],
      ),
    );
    if (go != true || !mounted) return;
    final out = reserve.withdrawTo(ledger, dest: dest, payout: to, nowMs: now);
    if (out == null) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(reserveEpochStillOpenCopy())),
        );
      }
      return;
    }
    if (mounted) setState(() {});
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Withdraw signed — Continuum updates when the payout is sealed')),
      );
    }
  }

  Future<void> _reserveVote(BuildContext context, ShearIdentity ident, String choice) async {
    final dest = _reserveDestOf(ident);
    if (dest == null || dest.isEmpty) return;
    final gate = reserveVoteGate(ledger, reserve, dest);
    if (gate != null) {
      if (context.mounted) {
        final messenger = ScaffoldMessenger.of(context);
        messenger.clearSnackBars();
        messenger.showSnackBar(SnackBar(content: Text(gate)));
      }
      return;
    }
    final already = reserve.portal(dest);
    if (already.vote != null && already.voteEpoch == reserve.currentEpoch) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(voteFailCopy(StateError('vote_locked')))),
        );
      }
      return;
    }
    var depth = await _mempoolDepthNow();
    var voteL = levyNanos(0, depth: depth);
    if (ledger.spendableOwned(ident.address, paymentCode: ident.paymentCode) < voteL / kUnitsPerShe) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Not enough Continuum spendable for vote tx fee ${formatShe(voteL / kUnitsPerShe)} SHE'),
        ));
      }
      return;
    }
    final sealed = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => _ReserveVoteSealDialog(
        levyLine: _txFeeAdvice(0, oneFeeTo: 'cast this vote', depth: depth),
      ),
    );
    if (sealed != true || !mounted) return;
    depth = await _mempoolDepthNow();
    voteL = levyNanos(0, depth: depth);
    if (ledger.spendableOwned(ident.address, paymentCode: ident.paymentCode) < voteL / kUnitsPerShe) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Not enough Continuum spendable for vote tx fee ${formatShe(voteL / kUnitsPerShe)} SHE'),
        ));
      }
      return;
    }
    final go = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        key: const Key('reserve-vote-sign'),
        title: const Text('Sign Reserve vote'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Post this vote to the chain so every node and wallet reads the same tally.\n'
              'Choice: $choice',
            ),
            const SizedBox(height: 8),
            Text(
              _txFeeAdvice(0, oneFeeTo: 'cast this vote', depth: depth),
              key: const Key('reserve-vote-sign-levy'),
            ),
          ],
        ),
        actions: [
          TextButton(
            key: const Key('reserve-vote-sign-cancel'),
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const Key('reserve-vote-sign-accept'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Sign'),
          ),
        ],
      ),
    );
    if (go != true || !mounted) return;
    final tun = hop.tunVerified && !hop.probeOnly;
    final result = await commandReserveVote(
      ledger: ledger,
      reserve: reserve,
      restFrame: ident.address,
      paymentCode: ident.paymentCode,
      dest: dest,
      choice: choice,
      depth: depth,
      spendSeed: hexToBytes(ident.seedHex),
      local: ledger.pool == null || widget.skipPoolSync,
      privacyHopUp: tun,
    );
    if (context.mounted) {
      final messenger = ScaffoldMessenger.of(context);
      messenger.removeCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text(result.remark)));
    }
    if (!result.enacted) return;
    if (!widget.skipPoolSync) {
      await _syncVaults(ident);
    }
    if (mounted) setState(() => _reserveVoteDraft = choice);
  }

  List<Widget> _reservePane(BuildContext context, ShearIdentity ident) {
    final dest = _reserveDestOf(ident) ?? '';
    final p = dest.isEmpty ? ReservePortal() : reserve.portal(dest);
    final now = DateTime.now().millisecondsSinceEpoch;
    final daysLeft = (reserve.remainingMs(now) / 86400000).floor();
    final dayOfEpoch = reserveDayOfEpoch(epochStartMs: reserve.epochStartMs, nowMs: now);
    final stakedShe = formatShe(p.staked / kUnitsPerShe);
    final idleShe = formatShe(p.idle / kUnitsPerShe);
    final totalShe = formatShe(p.nanos / kUnitsPerShe);
    final programShe = formatShe(reserve.totalLockedNanos / kUnitsPerShe);
    final needVoteShe = formatShe(p.remainingToVoteNanos / kUnitsPerShe);
    final rw = dest.isEmpty
        ? const ReserveRewards(
            accrued: 0, projected: 0, staked: 0, idle: 0, oracleBps: 0, elapsedMs: 0)
        : reserve.rewards(dest, now);
    final accruedShe = formatShe(rw.accrued / kUnitsPerShe);
    final endShe = formatShe(rw.projected / kUnitsPerShe);
    final rate = '${(rw.oracleBps / 100).toStringAsFixed(2)}%';
    final voted = p.vote != null && p.voteEpoch == reserve.currentEpoch;
    final draft = _reserveVoteDraft ?? p.vote;
    final yours = _panel(context, [
            const Text('The Reserve', style: TextStyle(fontWeight: FontWeight.w700)),
            if ((sidecar.committed == ClosureSendMode.localNode ||
                    sidecar.committed == ClosureSendMode.localNodeFull) &&
                sidecar.sendBlocked)
              Text(
                sidecar.sendBlockedCopy,
                key: const Key('reserve-local-wait'),
                style: TextStyle(color: shearMutedOf(context)),
              ),
            const Text(
              'The Reserve is Shear governance. Deposit any amount into your own portal, '
              'in as many transactions as you like. Only a vote needs that sum to reach π SHE, '
              'then 9 confirmations. The first portal to reach π opens a 400-day epoch. '
              'Last-99-day deposits still unlock a vote but earn no stake. '
              'Interest is a variable rate observed by The Reserve oracle. '
              'The winning vote then moves the hash bonus by one unit.',
            ),
            const SizedBox(height: 8),
            _glowBanner(
              context,
              key: const Key('reserve-hashbonus-per-u'),
              text: "Miner's HashBonus now = ${formatHashBonusShe(reserve.liveHashBonusNanos)}",
            ),
            if (reserve.cutoffDisclaimer(now)) ...[
              const SizedBox(height: 8),
              const Text(kReserveCutoffDisclaimer),
            ],
            if (_reserveLockNotice != null) ...[
              const SizedBox(height: 8),
              Card(
                key: const Key('reserve-locked-in'),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        kReserveLockSent,
                        key: Key('reserve-lock-sent'),
                        style: TextStyle(fontWeight: FontWeight.w700),
                      ),
                      Text(
                        'Locked in  ${formatShe((_reserveLockNotice!['she'] as num).toDouble())} SHE. '
                        'Coins are locked in your portal.',
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                      if (_reserveLockNotice!['levyShe'] != null)
                        Text(
                          'Tx fee ${formatShe((_reserveLockNotice!['levyShe'] as num).toDouble())} SHE from Continuum spendable. One fee to add funds to the vault.',
                          key: const Key('reserve-locked-in-levy'),
                        ),
                      Text('Tx  ${_reserveLockNotice!['txid']}'),
                      Text(
                        'Portal total  ${formatShe((_reserveLockNotice!['cumulative'] as num).toDouble())} SHE'
                        '${_reserveLockNotice!['canVote'] == true ? '  ·  vote unlocked' : ''}',
                      ),
                      Align(
                        alignment: Alignment.centerRight,
                        child: TextButton(
                          key: const Key('reserve-lock-dismiss'),
                          onPressed: _reserveLockDismissable
                              ? () => setState(() => _reserveLockNotice = null)
                              : null,
                          child: const Text('Dismiss'),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
            if (p.nanos > 0) ...[
              const SizedBox(height: 8),
              _glowBanner(
                context,
                key: const Key('reserve-apr'),
                text: 'Oracle observed Apr $rate · ${vaultObserveLabel(sealed: false)}',
              ),
            ],
            if (p.deposits.isNotEmpty) ...[
              const SizedBox(height: 8),
              const Text('Your deposits', style: TextStyle(fontWeight: FontWeight.w600)),
              SizedBox(
                key: const Key('reserve-deposits-scroll'),
                height: kDepositRowHeight * 2,
                child: ListView.builder(
                  controller: _depositsScroll,
                  primary: false,
                  physics: const AlwaysScrollableScrollPhysics(),
                  itemExtent: kDepositRowHeight,
                  itemCount: p.deposits.length,
                  itemBuilder: (context, i) {
                    final d = p.deposits.reversed.elementAt(i);
                    return Text(
                      '${formatShe(d.nanos / kUnitsPerShe)} SHE  ·  ${DateTime.fromMillisecondsSinceEpoch(d.atMs).toIso8601String().split('T').first}',
                      key: Key('reserve-deposit-$i'),
                    );
                  },
                ),
              ),
            ],
            const SizedBox(height: 8),
            TextField(
              key: const Key('reserve-amount'),
              controller: reserveAmt,
              keyboardType: TextInputType.number,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(labelText: 'Amount SHEAR'),
            ),
            Text(
              _txFeeAdvice(
                ((double.tryParse(reserveAmt.text.trim()) ?? 0) * kUnitsPerShe).round(),
                oneFeeTo: 'add funds to the vault',
              ),
              key: const Key('reserve-lock-levy'),
            ),
            if (_reserveDepositProgress != null) ...[
              const SizedBox(height: 8),
              Text(_reserveDepositProgress!, key: const Key('reserve-deposit-progress')),
            ],
            const SizedBox(height: 8),
            const Text(
              kReserveIpDisclaimer,
              key: Key('reserve-ip-disclaimer'),
            ),
            const SizedBox(height: 8),
            Wrap(spacing: 8, runSpacing: 8, children: [
              FilledButton(
                key: const Key('reserve-send'),
                onPressed: _reserveSendReady ? () => _reserveSend(context, ident) : null,
                child: const Text('Deposit sum'),
              ),
              if ((p.nanos > 0 && reserve.epochIsOver(now)) || p.claimableRewards > 0)
                FilledButton(
                  key: const Key('reserve-withdraw'),
                  onPressed: () => _reserveWithdraw(context, ident),
                  child: Text(p.claimableRewards > 0 && !reserve.epochIsOver(now)
                      ? 'Withdraw previous-epoch rewards'
                      : 'Withdraw to Continuum'),
                ),
            ]),
    ], key: const Key('reserve-yours-box'));
    final overall = _panel(context, [
            Text('Overall sums', key: const Key('reserve-overall'), style: const TextStyle(fontWeight: FontWeight.w700)),
            Text('Program locked  $programShe SHE'),
            Text('Program staked  ${formatShe(reserve.totalStakedNanos / kUnitsPerShe)} SHE  ·  idle ${formatShe(reserve.totalIdleNanos / kUnitsPerShe)} SHE'),
            Text('Fee bank  ${formatShe(reserve.feeBankNanos / kUnitsPerShe)} SHE  ·  extra-minted ${formatShe(reserve.mintBankNanos / kUnitsPerShe)} SHE'),
            Text('Accrued (all portals)  ${formatShe(reserve.totalAccruedNanos / kUnitsPerShe)} SHE  ·  claimable ${formatShe(reserve.totalClaimableNanos / kUnitsPerShe)} SHE'),
            Text('Live hash bonus  ${formatHashBonusShe(reserve.liveHashBonusNanos)} SHE/hash'),
            Text(
              reserve.bonusEnacted
                  ? 'Enacted +${reserve.enactedUp} / −${reserve.enactedDown} / hold ${reserve.enactedHold} → delta ${reserve.enactedDelta}, live bonus = ${reserve.enactedLiveBonus}'
                  : 'Votes  +${reserve.votesIncrease} / −${reserve.votesDecrease} / hold ${reserve.votesHold}',
              key: const Key('reserve-overall-votes'),
            ),
            Text(reserve.epochStartMs == 0
                ? 'No epoch yet. It starts when a portal\'s own deposits reach π SHE.'
                : '$daysLeft days remaining in this epoch  ·  day $dayOfEpoch of $kReserveEpochDays'),
            if (reserve.uniqueEpochs.isNotEmpty) ...[
              const SizedBox(height: 8),
              const Text('Epochs', style: TextStyle(fontWeight: FontWeight.w600)),
              Table(
                key: const Key('reserve-epoch-table'),
                columnWidths: const {
                  0: FlexColumnWidth(0.7),
                  1: FlexColumnWidth(1.4),
                  2: FlexColumnWidth(1.4),
                },
                children: [
                  const TableRow(children: [
                    Padding(padding: EdgeInsets.symmetric(vertical: 2), child: Text('Epoch')),
                    Padding(padding: EdgeInsets.symmetric(vertical: 2), child: Text('Start')),
                    Padding(padding: EdgeInsets.symmetric(vertical: 2), child: Text('End')),
                  ]),
                  for (final e in reserve.uniqueEpochs)
                    TableRow(children: [
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 2),
                        child: Text('${e.epoch}'),
                      ),
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 2),
                        child: Text(reserveLocalDateTime(e.startMs)),
                      ),
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 2),
                        child: Text(reserveLocalDateTime(e.endMs)),
                      ),
                    ]),
                ],
              ),
            ],
    ], key: const Key('reserve-overall-box'));
    final voteKids = <Widget>[
      const Text('Vote to raise, lower, or leave the hash bonus (±1 unit). The pot schedule does not change. Your vote is sealed for this epoch.'),
    ];
    if (voted) {
      final choice = p.vote!;
      voteKids.add(ListTile(
        key: Key('reserve-vote-$choice'),
        dense: true,
        leading: const Icon(Icons.check, color: Color(0xFF1A9A4A), key: Key('reserve-vote-check')),
        title: Text(choice),
      ));
      voteKids.add(Text(
        'Vote results  +${reserve.votesIncrease} / −${reserve.votesDecrease} / hold ${reserve.votesHold}',
        key: const Key('reserve-vote-results'),
      ));
      voteKids.add(const SizedBox(height: 8));
      voteKids.add(_glowBanner(
        context,
        key: const Key('reserve-your-vote'),
        text: 'Your vote: $choice',
      ));
    } else {
      for (final v in [kVoteIncrease, kVoteDecrease, kVoteHold]) {
        voteKids.add(CheckboxListTile(
          key: Key('reserve-vote-$v'),
          dense: true,
          title: Text(v),
          value: draft == v,
          onChanged: (on) {
            setState(() => _reserveVoteDraft = on == true ? v : null);
          },
        ));
      }
      voteKids.add(Text(
        _txFeeAdvice(0, oneFeeTo: 'cast this vote'),
        key: const Key('reserve-vote-levy'),
      ));
      voteKids.add(FilledButton(
        key: const Key('reserve-vote-submit'),
        onPressed: draft == null ? null : () => _reserveVote(context, ident, draft),
        child: const Text('Cast vote'),
      ));
    }
    final vote = _panel(context, voteKids, key: const Key('reserve-vote-box'));
    final sumsBox = Container(
      key: const Key('reserve-yours-sums-box'),
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Your sums',
            key: const Key('reserve-holdings'),
            textAlign: TextAlign.left,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          Text('Staked  $stakedShe SHE', textAlign: TextAlign.justify),
          Text('Idle  $idleShe SHE', textAlign: TextAlign.justify),
          Text(
            'Locked  $totalShe SHE${p.joined ? '  ·  joined this epoch' : ''}',
            textAlign: TextAlign.justify,
          ),
          if (p.canVote)
            const Text(
              'Locked stake can vote',
              key: Key('reserve-locked-can-vote'),
              textAlign: TextAlign.justify,
            ),
          Text(
            'Accrued this epoch  $accruedShe SHE  ·  updates daily at frozen oracle bps; paid at epoch end',
            textAlign: TextAlign.justify,
          ),
          Text(
            'Previous-epoch rewards  ${formatShe(p.claimableRewards / kUnitsPerShe)} SHE  ·  withdrawable now',
            textAlign: TextAlign.justify,
          ),
          Text(
            p.canVote
                ? 'Vote unlocked  portal holds ≥ π SHE'
                : 'Need $needVoteShe SHE more to reach π and unlock a vote. Deposits add up.',
            key: const Key('reserve-pi-progress'),
            textAlign: TextAlign.justify,
          ),
          if (p.nanos > 0) ...[
            Text(
              '$kReserveAccruedLabel  $accruedShe SHE  ·  updates daily (day $dayOfEpoch)',
              textAlign: TextAlign.justify,
            ),
            Text('At epoch end  $endShe SHE', textAlign: TextAlign.justify),
          ],
        ],
      ),
    );
    return [
      ReserveVoteTowers(
        decrease: reserve.bonusEnacted ? reserve.enactedDown : reserve.votesDecrease,
        hold: reserve.bonusEnacted ? reserve.enactedHold : reserve.votesHold,
        increase: reserve.bonusEnacted ? reserve.enactedUp : reserve.votesIncrease,
      ),
      const SizedBox(height: 12),
      LayoutBuilder(builder: (ctx, box) {
        final side = box.maxWidth >= 560;
        final right = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            overall,
            const SizedBox(height: 12),
            vote,
          ],
        );
        if (side) {
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: yours),
              const SizedBox(width: 12),
              Expanded(child: right),
            ],
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            yours,
            const SizedBox(height: 12),
            overall,
            const SizedBox(height: 12),
            vote,
          ],
        );
      }),
      const SizedBox(height: 12),
      sumsBox,
    ];
  }

  Future<void> _syncVaults(ShearIdentity ident) async {
    final pool = ledger.pool;
    if (pool == null) return;
    try {
      final dest = _reserveDestOf(ident);
      // A read. The phone's live base is often the public pool, and that
      // snapshot is what replays a thin staked=0 back to this portal's locks.
      if (dest != null) {
        final p = reserve.portal(dest);
        final keepStaked = p.staked;
        final keepIdle = p.idle;
        final keepJoined = p.joined;
        final json = Map<String, dynamic>.from(await pool.reservePortal(dest));
        if (json['ok'] == false) return;
        final locks = _reserveLockRows(dest);
        if (locks.isNotEmpty) {
          final prior = json['locks'];
          json['locks'] = [
            if (prior is List) ...prior,
            ...locks,
          ];
        }
        reserve.applyRemotePortal(dest, json);
        // Pool can lag the lock that was just signed. The notice is not the
        // only guard: applyRemotePortal keeps principal the snapshot credits.
        if (_reserveLockNotice != null) {
          if (p.staked < keepStaked) p.staked = keepStaked;
          if (p.idle < keepIdle) p.idle = keepIdle;
        }
        if (keepJoined && p.nanos >= kPiSheNanos) p.joined = true;
        if (!ledger.blankFork) {
          ledger.vaultLockedNanos = reserve.totalLockedNanos;
          ledger.setReserveHeldNanos(dest, reserve.portal(dest).nanos);
        } else {
          ledger.vaultLockedNanos = 0;
          ledger.setReserveHeldNanos(dest, 0);
        }
        ledger.extraMintedNanos = reserve.mintBankNanos;
      }
    } catch (_) {}
    try {
      final p = await pool.mempoolPressure();
      _mempoolDepth = (p['depth'] as num?)?.toInt() ?? _mempoolDepth;
    } catch (_) {}
    if (mounted) setState(() {});
  }

  Widget _vortex(BuildContext context, ShearIdentity ident) {
    final tabs = [
      ...vortices.where(vorticeChipVisible),
      const Vortice(id: '_add', name: 'Add new vortice'),
    ];
    final i = vortexTab.clamp(0, tabs.length - 1);
    final cur = tabs[i];
    final kids = <Widget>[
      const Text('Vortex  Ω^{μν}', style: TextStyle(fontWeight: FontWeight.w700)),
      SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(children: [
          for (var n = 0; n < tabs.length; n++)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: ChoiceChip(
                label: Text(tabs[n].name),
                selected: n == i,
                onSelected: (_) => setState(() => vortexTab = n),
              ),
            ),
        ]),
      ),
      const SizedBox(height: 8),
    ];
    if (cur.id == '_add') {
      kids.addAll([
        const Text(
          'Paste a vortice deploy key from the dapp creator. '
          'A valid key names the host; this wallet downloads that dapp and deploys it here. '
          'Third-party vortice cannot mint SHE.',
        ),
        TextField(
          key: const Key('vortice-key'),
          controller: vorticeKeyCtrl,
          decoration: const InputDecoration(labelText: 'Vortice deploy key'),
          minLines: 2,
          maxLines: 4,
          onChanged: (v) {
            if (parseVorticeKey(v) != null) _deployFromKey(v);
          },
          onSubmitted: _deployFromKey,
        ),
        FilledButton(
          onPressed: () => _deployFromKey(vorticeKeyCtrl.text),
          child: const Text('Add vortice'),
        ),
      ]);
    } else if (cur.id == reserveProgram) {
      return ListView(
        controller: _tabScroll[3],
        primary: false,
        padding: const EdgeInsets.all(16),
        children: [
          _panel(context, kids),
          const SizedBox(height: 12),
          ..._reservePane(context, ident),
        ],
      );
    } else if (cur.id == kRxPrivacyBrowserProgram) {
      kids.add(const RxPrivacyBrowserPane());
      kids.add(OutlinedButton(
        key: const Key('vortice-remove'),
        onPressed: () => _removeVortice(context, cur),
        child: const Text('Remove vortice'),
      ));
    } else if (cur.id == kRpMailProgram) {
      kids.add(const RpMailPane());
      kids.add(OutlinedButton(
        key: const Key('vortice-remove'),
        onPressed: () => _removeVortice(context, cur),
        child: const Text('Remove vortice'),
      ));
    } else {
      kids.addAll([
        Text(cur.name, style: const TextStyle(fontWeight: FontWeight.w600)),
        Text('Program  ${cur.id}'),
        if (cur.origin != null) Text('Origin  ${cur.origin}'),
        const Text('Third-party vortice cannot mint SHE; it must fund its own rewards.'),
        const Text(
          'Removing it only drops it from this wallet. The vort1 origin the creator published is unchanged.',
        ),
        const SizedBox(height: 12),
        OutlinedButton(
          key: const Key('vortice-remove'),
          onPressed: () => _removeVortice(context, cur),
          child: const Text('Remove vortice'),
        ),
      ]);
    }
    return _card(kids);
  }

  Future<void> _resistanceStart(BuildContext context) async {
    await _applyResistancePath(context, sidecar.startResistanceNode);
  }

  Future<void> _resistanceStop(BuildContext context) async {
    await _applyResistancePath(context, sidecar.stopResistanceNode);
  }

  Future<void> _applyResistancePath(BuildContext context, Future<String> Function() run) async {
    final msg = await run();
    session.closureSendMode = closureModeStored(sidecar.committed);
    if (!widget.skipPoolSync) await session.persist();
    if (!mounted || !context.mounted) return;
    setState(() {});
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg.isEmpty ? 'Send path applied' : msg)),
    );
  }

  Widget _closure(BuildContext context, ShearIdentity ident) {
    return _card([
      const Text('Closure  G_{μν}', style: TextStyle(fontWeight: FontWeight.w700)),
      const Text(
        'This is your rest-frame shear1. It never goes on the book. '
        'Confirmed SHE settles here. Chain dests are ssa1 mailboxes derived '
        'from this identity; they do not need to be kept after prune.',
      ),
      const SizedBox(height: 8),
      const Text('shear1 (rest-frame — do not share)'),
      SelectableText(ident.address, key: const Key('closure-shear1')),
      const SizedBox(height: 8),
      const Text('she1 (public receive ID)'),
      SelectableText(ident.paymentCode, key: const Key('closure-she1')),
      const Text(
        'Fingerprint only — not payable. Use Continuum Show QR / full she1 to receive.',
        key: Key('closure-she1-fingerprint'),
      ),
      const SizedBox(height: 16),
      Text('Send path', key: const Key('closure-send-path'), style: const TextStyle(fontWeight: FontWeight.w700)),
      Text(
        _hostAndroid
            ? 'This phone reads height and confirms coins. It does not start a node.'
            : 'Three paths. Choose one, then Apply. The top bar shows the path that is on.',
      ),
      RadioListTile<ClosureSendMode>(
        key: const Key('closure-send-path-bare'),
        contentPadding: EdgeInsets.zero,
        value: ClosureSendMode.connectBare,
        groupValue: sidecar.pending,
        title: const Text('Connect Bare'),
        subtitle: Text(_hostAndroid
            ? kConnectBareCopy
            : 'Connect bare. You push a signed send. This device still runs the book node so blocks can land. No tunnel.'),
        onChanged: (v) => setState(() => sidecar.select(v!)),
      ),
      if (!_hostAndroid)
        RadioListTile<ClosureSendMode>(
          key: const Key('closure-send-path-local'),
          contentPadding: EdgeInsets.zero,
          value: ClosureSendMode.localNode,
          groupValue: sidecar.pending,
          title: const Text('p2P Node'),
          subtitle: const Text(kLocalNodeModeCopy),
          onChanged: (v) => setState(() => sidecar.select(v!)),
        ),
      if (!_hostAndroid)
        RadioListTile<ClosureSendMode>(
          key: const Key('closure-send-path-full'),
          contentPadding: EdgeInsets.zero,
          value: ClosureSendMode.localNodeFull,
          groupValue: sidecar.pending,
          title: const Text('Full Node'),
          subtitle: const Text(kLocalNodeFullModeCopy),
          onChanged: (v) => setState(() => sidecar.select(v!)),
        ),
      FilledButton(
        key: const Key('closure-apply'),
        onPressed: () {
          unawaited(() async {
            sidecar.adoptBookPin(
              genesis: _flyGenesis ?? ledger.chainGenesis,
              magic: kBookMagic,
              trustedTip: _flyOk && _flyTip > 0 ? _flyTip : ledger.sealedHeight,
            );
            final msg = await sidecar.apply();
            ledger.onClosureApply(bookChanged: sidecar.rescanFromGenesis);
            session.closureSendMode = closureModeStored(sidecar.committed);
            if (!widget.skipPoolSync) {
              Zone.root.run(() {
                unawaited(_followBalancesAfterApply(ident));
              });
            }
            if (!mounted) return;
            setState(() {});
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text(msg.isEmpty ? 'Send path applied' : msg)),
            );
            if (!widget.skipPoolSync) unawaited(session.persist());
          }());
        },
        child: const Text('Apply'),
      ),
      const SizedBox(height: 16),
      const Text('Settings', style: TextStyle(fontWeight: FontWeight.w700)),
      SwitchListTile(
        key: const Key('settings-dark-mode'),
        contentPadding: EdgeInsets.zero,
        title: const Text('Dark mode'),
        subtitle: const Text('The bar stays the logo, the link, and the block height.'),
        value: _themeMode == ThemeMode.dark,
        onChanged: (_) => _toggleTheme(),
      ),
      SwitchListTile(
        key: const Key('settings-biometrics'),
        contentPadding: EdgeInsets.zero,
        title: const Text('Unlock with biometrics'),
        subtitle: const Text('Password still encrypts shewall.bin. Biometrics only unlock this device.'),
        value: session.biometricsEnabled && _bioReady && _bioStored,
        onChanged: !_bioReady
            ? null
            : (on) async {
                if (on) {
                  final sealed = await _sealBiometricsOn(context);
                  if (!sealed) {
                    session.biometricsEnabled = false;
                    if (mounted) setState(() {});
                    return;
                  }
                } else {
                  session.biometricsEnabled = false;
                  _bioStored = false;
                  await biometrics.forget();
                  await session.persist();
                }
                if (mounted) setState(() {});
              },
      ),
      const SizedBox(height: 8),
      const Text(
        'Password seals shewall.bin (AES-256-GCM). Export that file and the '
        'same password restores this shear1, dests, and this wallet\'s '
        'transactions on another device.',
      ),
      const SizedBox(height: 8),
      FilledButton(
        onPressed: exportShewallNow,
        child: const Text('Export shewall.bin'),
      ),
      const SizedBox(height: 8),
      OutlinedButton(
        onPressed: importShewallNow,
        child: const Text('Import shewall.bin'),
      ),
    ]);
  }
}

/// CONFIRM step owns its field controller until the route is gone.
/// Disposing in the caller races the dialog's exit animation and the
/// TextField rebuilds against a dead controller.
class _ReserveVoteSealDialog extends StatefulWidget {
  const _ReserveVoteSealDialog({required this.levyLine});

  final String levyLine;

  @override
  State<_ReserveVoteSealDialog> createState() => _ReserveVoteSealDialogState();
}

class _ReserveVoteSealDialogState extends State<_ReserveVoteSealDialog> {
  final _typed = TextEditingController();

  @override
  void dispose() {
    _typed.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ok = _typed.text == 'CONFIRM';
    return AlertDialog(
      key: const Key('reserve-vote-confirm'),
      title: const Text('YOUR VOTE WILL BE SEALED'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'You will not be entitled to change your mind before the end of this epoch.\n'
              'Type CONFIRM to continue.',
            ),
            const SizedBox(height: 8),
            Text(widget.levyLine, key: const Key('reserve-vote-confirm-levy')),
            TextField(
              key: const Key('reserve-vote-confirm-field'),
              controller: _typed,
              maxLines: 1,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(labelText: 'Type CONFIRM'),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          key: const Key('reserve-vote-confirm-cancel'),
          onPressed: () => Navigator.pop(context, false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const Key('reserve-vote-confirm-accept'),
          onPressed: ok ? () => Navigator.pop(context, true) : null,
          child: const Text('CONFIRM'),
        ),
      ],
    );
  }
}

/// Live camera on Android/iOS/macOS. Windows/Linux have no mobile_scanner
/// plugin — Scan QR picks an image and [decodeReceiveQrImage] reads it.
bool scanQrUsesLiveCamera() {
  if (kIsWeb) return true;
  return Platform.isAndroid || Platform.isIOS || Platform.isMacOS;
}

class ScanReceiveQrPage extends StatefulWidget {
  const ScanReceiveQrPage({super.key, this.pickImage});

  /// Production: FilePicker. Tests inject PNG bytes of a receive QR.
  final Future<Uint8List?> Function()? pickImage;

  @override
  State<ScanReceiveQrPage> createState() => ScanReceiveQrPageState();
}

class ScanReceiveQrPageState extends State<ScanReceiveQrPage> {
  var _done = false;
  MobileScannerController? _controller;

  @override
  void initState() {
    super.initState();
    if (scanQrUsesLiveCamera()) {
      _controller = MobileScannerController();
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  Future<Uint8List?> _readPickedImage() async {
    if (widget.pickImage != null) return widget.pickImage!();
    final r = await FilePicker.platform.pickFiles(type: FileType.image, withData: true);
    if (r == null || r.files.isEmpty) return null;
    final f = r.files.single;
    if (f.bytes != null && f.bytes!.isNotEmpty) return f.bytes;
    final path = f.path;
    if (path == null || path.isEmpty) return null;
    return File(path).readAsBytes();
  }

  Future<void> _pickQrImage() async {
    if (_done) return;
    final bytes = await _readPickedImage();
    if (bytes == null || bytes.isEmpty) return;
    final got = decodeReceiveQrImage(bytes);
    if (got != null) {
      if (!mounted) return;
      _done = true;
      Navigator.pop(context, got);
      return;
    }
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Not a Shear receive QR.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final live = scanQrUsesLiveCamera() && _controller != null;
    return Scaffold(
      key: const Key('scan-qr-page'),
      appBar: AppBar(
        title: const Text('Scan receive QR'),
        actions: [
          IconButton(
            key: const Key('scan-qr-pick'),
            tooltip: 'Choose QR image',
            onPressed: _pickQrImage,
            icon: const Icon(Icons.photo_library_outlined),
          ),
        ],
      ),
      body: live
          ? MobileScanner(
              controller: _controller,
              errorBuilder: (context, error) => Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(
                    'Allow camera so Shear can scan a receive QR. ${error.errorCode}',
                    textAlign: TextAlign.center,
                  ),
                ),
              ),
              onDetect: (barcodes) {
                if (_done) return;
                for (final b in barcodes.barcodes) {
                  final raw = b.rawValue;
                  if (raw == null || raw.isEmpty) continue;
                  final got = parseReceiveQr(raw);
                  if (got == null) continue;
                  _done = true;
                  Navigator.pop(context, got);
                  return;
                }
              },
            )
          : Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text(
                      'No live camera on this desktop. Choose a photo of a Continuum receive QR.',
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 16),
                    FilledButton(
                      key: const Key('scan-qr-pick-button'),
                      onPressed: _pickQrImage,
                      child: const Text('Choose QR image'),
                    ),
                  ],
                ),
              ),
            ),
    );
  }
}
