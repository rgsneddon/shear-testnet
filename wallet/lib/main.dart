import 'dart:async';
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
import 'shear_join.dart';
import 'shear_confirm_pie.dart';
import 'shear_biometrics.dart';
import 'shear_export.dart';
import 'shear_qr.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'shear_social.dart';
import 'shear_levy.dart';
import 'shear_eip712.dart';

const kWalletVersion = '0.15';
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
  'Your spendable balance and she1 address.',
  'Send SHEAR to anyone with a she1 address.',
  'Transactional data in a CLI output.',
  'Contracts which are deployed into your wallet.',
  'Your personal transaction explorer.',
  'Password and backup. Encrypts shewall.bin so you can restore this wallet on another install.',
];

void main() {
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
    this.join,
    this.downloadVortice,
    this.biometrics,
    this.exportDest,
    this.savePicker,
    this.importSrc,
    this.openUrl,
    this.scanQr,
    this.startUnlocked = false,
    this.skipPoolSync = false,
  });

  final ShearSession? session;
  final ShearLedger? ledger;
  final String? launchExecutable;
  /// Local observation only: confirm one testnet round so Shearview/Resistance have a tx.
  final bool demoTx;
  final ShearReserve? reserve;
  final ShearJoin? join;
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
  /// Tests: session already sealed and identity in memory.
  final bool startUnlocked;
  /// Tests: skip unlock HTTP so the sign-pull dialog can be driven without a hung pool.
  final bool skipPoolSync;

  @override
  ShearWalletAppState createState() => ShearWalletAppState();
}

class ShearWalletAppState extends State<ShearWalletApp> {
  late final ShearSession session = widget.session ?? ShearSession();
  late final ShearLedger ledger = widget.ledger ?? ShearLedger(pool: ShearPoolClient());
  late final ShearBiometrics biometrics = widget.biometrics ?? const NoBiometrics();
  final GlobalKey<NavigatorState> _nav = GlobalKey<NavigatorState>();
  final GlobalKey<ScaffoldMessengerState> _snack = GlobalKey<ScaffoldMessengerState>();
  ShearIdentity? id;
  String password = '';
  bool unlocked = false;
  String? _lockError;
  bool _bioReady = false;
  bool _bioStored = false;
  int tab = 0;
  final flowTo = TextEditingController();
  final flowAmt = TextEditingController();
  final flowMemo = TextEditingController();
  final unlockCtrl = TextEditingController();
  final confirmCtrl = TextEditingController();
  final reserveAmt = TextEditingController();
  final joinKeyCtrl = TextEditingController();
  final vorticeKeyCtrl = TextEditingController();
  final shearviewQuery = TextEditingController();
  bool _vorticeBusy = false;
  late final ShearReserve reserve = widget.reserve ?? ShearReserve();
  late final ShearJoin join = widget.join ?? ShearJoin();
  String? joinStatus;
  int vortexTab = 0;
  List<Vortice> vortices = const [reserveVortice, joinVortice, joinWatchVortice];
  final Set<String> openedMemos = {};
  String? lastMemoPlain;
  ThemeMode _themeMode = ThemeMode.light;
  final Map<String, String> _cliById = {};
  String? _focusedTxId;
  Timer? _accrualTick;
  Map<String, dynamic>? _pullOffer;
  bool _pullPrompting = false;
  final Set<String> _handledPullIds = {};
  bool _poolUnlockQueued = false;

  @override
  void initState() {
    super.initState();
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
    joinKeyCtrl.dispose();
    vorticeKeyCtrl.dispose();
    shearviewQuery.dispose();
    _accrualTick?.cancel();
    super.dispose();
  }

  Future<void> _boot() async {
    id = await session.loadOrCreate();
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
    if (mounted) setState(() {});
  }

  void _syncJoinRoster() {
    final now = DateTime.now().millisecondsSinceEpoch;
    join.burnUnclaimed(now);
    final expired = session.joinRetired ||
        (join.genesisMs != 0 && (join.burned || join.remainingMs(now) == 0));
    if (expired && !session.joinRetired) {
      session.joinRetired = true;
      session.persist();
    }
    final seen = <String>{};
    final extras = <Vortice>[];
    for (final v in [...session.deployedVortices, ...vortices]) {
      if (isPinnedProgram(v.id) || v.id.isEmpty || seen.contains(v.id)) continue;
      seen.add(v.id);
      extras.add(v);
    }
    vortices = reapExpiredJoin(
      [
        reserveVortice,
        if (!session.joinRetired) joinVortice,
        joinWatchVortice,
        ...extras,
      ],
      expired: session.joinRetired,
    );
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
    } catch (_) {
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
      final imported = await importEncryptedShewall(src: src, password: pw, ledger: ledger);
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

  Future<void> _unlockBiometric() async {
    if (!_bioReady || !_bioStored) return;
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
    if (session.identity == null) return;
    id = session.identity;
    password = pw;
    ledger.viewSecret = id!.viewKey;
    ledger.restoreDests(session.rememberedDests);
    setState(() {
      _lockError = null;
    });
    if (!widget.skipPoolSync) {
      try {
        await ledger.syncTip().timeout(const Duration(seconds: 3));
      } catch (_) {}
      try {
        await ledger
            .syncCredits(id!.address, paymentCode: id!.paymentCode)
            .timeout(const Duration(seconds: 8));
        session.rememberedDests = ledger.exportedDests();
        await session.persist();
      } catch (_) {}
    }
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
    if (mounted) setState(() => unlocked = true);
    _accrualTick?.cancel();
    _syncJoinRoster();
    if (id != null && !widget.skipPoolSync) unawaited(_syncVaults(id!));
    var ticks = 0;
    var tipBusy = false;
    var creditBusy = false;
    _accrualTick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted || !unlocked) return;
      _syncJoinRoster();
      final ident = id;
      if (ident != null && !tipBusy && !widget.skipPoolSync) {
        tipBusy = true;
        unawaited(ledger.syncTip().whenComplete(() {
          tipBusy = false;
          if (mounted) setState(() {});
        }));
      }
      ticks += 1;
      if (ident != null && ticks % 2 == 0 && !widget.skipPoolSync) {
        unawaited(_pollPull(ident));
      }
      if (ticks % 5 == 0 && ident != null && !creditBusy && !widget.skipPoolSync) {
        creditBusy = true;
        unawaited(ledger.syncCredits(ident.address, paymentCode: ident.paymentCode).whenComplete(() {
          session.rememberedDests = ledger.exportedDests();
          unawaited(session.persist());
          unawaited(_syncVaults(ident));
          creditBusy = false;
          if (mounted) setState(() {});
        }));
      }
      if (!mounted) return;
      setState(() {});
    });
    if (widget.demoTx) {
      unawaited(_playDemoLive());
    }
  }

  Future<void> _pollPull(ShearIdentity ident) async {
    if (_pullPrompting || !mounted || !unlocked) return;
    try {
      final p = await ledger.fetchPendingPull(ident.paymentCode);
      if (p == null || p['login'] == null) return;
      final login = p['login'].toString().split('.')[0];
      if (login != ident.paymentCode.split('.')[0]) return;
      final offerId = p['id']?.toString() ?? '';
      if (offerId.isNotEmpty && _handledPullIds.contains(offerId)) return;
      if (_pullOffer?['id'] == p['id'] && _pullPrompting) return;
      if (!mounted) return;
      _pullPrompting = true;
      _pullOffer = p;
      final nanos = (p['nanos'] as num?)?.round() ?? 0;
      final dest = p['dest']?.toString() ?? '';
      final she = formatShe(nanos / kUnitsPerShe);
      final navCtx = _nav.currentContext;
      if (navCtx == null || !navCtx.mounted) return;
      final go = await showDialog<bool>(
        context: navCtx,
        barrierDismissible: false,
        builder: (ctx) => AlertDialog(
          key: const Key('pull-sign'),
          title: Text(p['kind']?.toString() == 'admin-spendable' ? 'Sign pool send' : 'Sign pool pull'),
          content: Text('Pay $she SHE to $dest'),
          actions: [
            TextButton(
              key: const Key('pull-sign-cancel'),
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              key: const Key('pull-sign-accept'),
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Sign'),
            ),
          ],
        ),
      );
      if (offerId.isNotEmpty) _handledPullIds.add(offerId);
      if (go == true && mounted) {
        try {
          final tx = await ledger.signPendingPull(
            login: ident.paymentCode,
            dest: dest,
            nanos: nanos,
            seed: hexToBytes(ident.seedHex),
          );
          _ingestTx(ident, tx);
          if (mounted) setState(() {});
        } catch (e) {
          if (!mounted) return;
          _showPoolWithdrawError(_pullFailReason(e));
        }
      }
    } catch (_) {
      /* pool unreachable */
    } finally {
      _pullPrompting = false;
      _pullOffer = null;
    }
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
      ledger.viewSecret = ident.viewKey;
      final pay = ledger.currentDest(ident.address);
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

  void _maybeFirePoolUnlock(ShearIdentity ident, String? source) {
    final send = poolUnlockSend(
      height: ledger.sealedHeight,
      nowMs: DateTime.now().toUtc().millisecondsSinceEpoch,
      source: source,
    );
    if (send == null || _poolUnlockQueued) return;
    _poolUnlockQueued = true;
    final payload = send;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      try {
        final tx = await ledger.send(
          from: ledger.currentDest(ident.address),
          to: payload['to'] as String,
          amount: payload['amountShe'] as double,
          memo: payload['memo'] as String,
          restFrame: ident.address,
          paymentCode: ident.paymentCode,
        );
        _ingestTx(ident, tx);
      } catch (_) {}
    });
  }

  void _findBlock() {
    final ident = id;
    if (ident == null) return;
    ledger.viewSecret = ident.viewKey;
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
    );
  }

  void _ingestHistory() {
    final ident = id;
    if (ident == null) return;
    for (final t in ledger.ownerHistory(ident.address)) {
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
                  if (!first && _bioReady && _bioStored) ...[
                    const SizedBox(height: 8),
                    OutlinedButton(
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

  Widget _shell(BuildContext context) {
    final ident = id;
    if (ident == null) {
      return Scaffold(
        backgroundColor: Theme.of(context).scaffoldBackgroundColor,
        body: const Center(child: CircularProgressIndicator()),
      );
    }
    final pages = [
      _continuum(context, ident),
      _flow(context, ident),
      _resistance(context),
      _vortex(context, ident),
      _shearview(context, ident),
      _closure(context, ident),
    ];
    return Scaffold(
      backgroundColor: Theme.of(context).scaffoldBackgroundColor,
      appBar: AppBar(
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
            ],
          ),
        ),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: Center(
              child: InkWell(
                onTap: (kDebugMode || widget.demoTx) ? _findBlock : null,
                child: Text(
                  'block height: ${ledger.sealedHeight}',
                  style: TextStyle(
                    fontSize: 12,
                    color: Theme.of(context).colorScheme.onSurface,
                  ),
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
      body: Column(
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
          Expanded(child: pages[tab]),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: tab,
        onDestinationSelected: (i) => setState(() => tab = i),
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

  Widget _card(List<Widget> kids) {
    return Builder(builder: (context) {
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [_panel(context, kids)],
      );
    });
  }

  Future<void> _scanReceiveQr(BuildContext context) async {
    String? raw;
    if (widget.scanQr != null) {
      raw = await widget.scanQr!();
    } else {
      raw = await Navigator.of(context).push<String>(
        MaterialPageRoute(builder: (_) => const _ScanReceiveQrPage()),
      );
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
    if (mounted) setState(() {});
  }

  Future<void> _openSocial(String url) async {
    final uri = Uri.parse(url);
    final opener = widget.openUrl;
    if (opener != null) {
      await opener(uri);
      return;
    }
    await launchUrl(uri, mode: LaunchMode.externalApplication);
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

  TableRow _continuumStatRow(BuildContext context, String label, String value) {
    final style = TextStyle(color: shearMutedOf(context), fontSize: 13);
    return TableRow(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 3, horizontal: 0),
          child: Text(label, style: style),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 3, horizontal: 0),
          child: Text(value, style: style, textAlign: TextAlign.right),
        ),
      ],
    );
  }

  Widget _continuum(BuildContext context, ShearIdentity ident) {
    final spend = ledger.spendableOwned(ident.address, paymentCode: ident.paymentCode);
    final pending = ledger.pendingTxs(ident.address);
    final path1 = ledger.path1Observation();
    final fluxSec = (path1.targetIntervalMs / 1000).round();
    final dt = path1.observedIntervalMs;
    final spendPane = <Widget>[
      Text(
        '${formatShe(spend)} SHE',
        style: TextStyle(
          fontSize: 28,
          fontWeight: FontWeight.w700,
          color: shearAccentOf(context),
        ),
      ),
      Text('Spendable', style: TextStyle(color: shearMutedOf(context))),
      const SizedBox(height: 12),
      Text('Receive ID', style: TextStyle(fontWeight: FontWeight.w700, color: Theme.of(context).colorScheme.onSurface)),
      const SizedBox(height: 6),
      SelectableText(ident.paymentCode),
      const SizedBox(height: 8),
      OutlinedButton(
        key: const Key('copy-id'),
        onPressed: () => Clipboard.setData(ClipboardData(text: ident.paymentCode)),
        child: const Text('Copy ID'),
      ),
      const SizedBox(height: 12),
      Text('Receive QR', style: TextStyle(fontWeight: FontWeight.w700, color: Theme.of(context).colorScheme.onSurface)),
      const SizedBox(height: 6),
      Center(
        child: ColoredBox(
          color: Colors.white,
          child: CustomPaint(
            key: const Key('receive-qr'),
            size: const Size(168, 168),
            painter: QrPainter(
              data: encodeReceiveQr(ident.paymentCode),
              version: QrVersions.auto,
              gapless: true,
            ),
          ),
        ),
      ),
      const SizedBox(height: 12),
      Text('ssa1 dest (from your shear1 — chain mailbox)', style: TextStyle(fontWeight: FontWeight.w700, color: Theme.of(context).colorScheme.onSurface)),
      const SizedBox(height: 6),
      SelectableText(ledger.homeDest(ident.address, paymentCode: ident.paymentCode), key: const Key('continuum-ssa1')),
      const SizedBox(height: 8),
      OutlinedButton(
        key: const Key('copy-dest'),
        onPressed: () => Clipboard.setData(ClipboardData(text: ledger.homeDest(ident.address, paymentCode: ident.paymentCode))),
        child: const Text('Copy dest'),
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
          _continuumStatRow(context, 'Closure quantum', '${formatShe(path1.quantumShe)} SHE'),
          _continuumStatRow(context, 'Target flux', '${formatShe(path1.quantumShe)} SHE / $fluxSec s'),
          _continuumStatRow(
            context,
            'Observed interval',
            dt == null ? '—' : '${(dt / 1000).toStringAsFixed(1)} s',
          ),
          _continuumStatRow(context, 'Integral Q', '${formatShe(path1.integralQShe)} SHE'),
        ],
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
        'Each pending block fills a 6-slice pie (spendable at ${ShearLedger.spendableConfirmations}). Hash rewards are inside the block, not listed as their own txs.',
        style: TextStyle(color: shearMutedOf(context), fontSize: 12),
      ),
      for (final t in pending)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              ConfirmPie(
                key: Key('confirm-pie-${t.id}'),
                filled: ledger.confirmationsOf(t.height ?? 0),
                size: 28,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${walletTxLabel(t)}  ${formatShe(t.amount)} SHE',
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
    ];
    return LayoutBuilder(builder: (context, constraints) {
      final wide = constraints.maxWidth >= kContinuumSplitWidth;
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (wide)
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
            const SizedBox(height: 12),
            _panel(context, statsPane, key: const Key('continuum-stats')),
          ],
          if (pending.isNotEmpty) ...[
            const SizedBox(height: 12),
            _panel(context, pendingPane),
          ],
        ],
      );
    });
  }

  Widget _shearview(BuildContext context, ShearIdentity ident) {
    final hist = ledger.shearviewSearch(ident.address, shearviewQuery.text);
    return _card([
      const Text('Shearview  S_{μν}', style: TextStyle(fontWeight: FontWeight.w700)),
      Text('Your dedicated explorer. Full blocks only — hash rewards are inside each block.', style: TextStyle(color: shearMutedOf(context))),
      TextField(
        key: const Key('shearview-search'),
        controller: shearviewQuery,
        decoration: const InputDecoration(labelText: 'Search id, dest, kind, amount, height, memo'),
        onChanged: (_) => setState(() {}),
      ),
      if (hist.any((t) => t.memo && t.memoPlain != null && !openedMemos.contains(t.id)))
        Text('you have a new memo', style: TextStyle(fontWeight: FontWeight.w700, color: shearAccentOf(context))),
      if (hist.isEmpty) Text('No confirmed transactions yet.', style: TextStyle(color: shearMutedOf(context))),
      for (final t in hist)
        ListTile(
          dense: true,
          title: Text('${walletTxLabel(t)}  ${formatShe(t.amount)} SHE'),
          subtitle: Text(
            t.memo && openedMemos.contains(t.id) && t.memoPlain != null
                ? '${t.from} → ${t.to}  h=${t.height ?? '-'}  memo: ${t.memoPlain}'
                : '${t.from} → ${t.to}  h=${t.height ?? '-'}',
          ),
          onTap: () => setState(() {
            if (t.memo) {
              openedMemos.add(t.id);
              lastMemoPlain = t.memoPlain;
            }
            _ingestTx(ident, t);
            _focusedTxId = t.id;
            tab = _resistanceTab;
          }),
        ),
    ]);
  }

  Widget _flow(BuildContext context, ShearIdentity ident) {
    return _card([
      const Text('Flow  J^μ', style: TextStyle(fontWeight: FontWeight.w700)),
      const Text('ssa1 dest this round (pay). Offer she1, never shear1.'),
      SelectableText(ledger.currentDest(ident.address)),
      const SizedBox(height: 8),
      TextField(controller: flowTo, decoration: const InputDecoration(labelText: 'To (she1 or ssa1)')),
      OutlinedButton(
        key: const Key('scan-qr'),
        onPressed: () => _scanReceiveQr(context),
        child: const Text('Scan receive QR'),
      ),
      TextField(controller: flowAmt, decoration: const InputDecoration(labelText: 'Amount SHE'), keyboardType: TextInputType.number),
      TextField(controller: flowMemo, decoration: const InputDecoration(labelText: 'Memo (optional)')),
      FilledButton(
        onPressed: () async {
          try {
            final tx = await ledger.send(
              from: ledger.currentDest(ident.address),
              to: flowTo.text.trim(),
              amount: double.parse(flowAmt.text),
              memo: flowMemo.text.trim().isEmpty ? null : flowMemo.text.trim(),
              restFrame: ident.address,
              paymentCode: ident.paymentCode,
            );
            _ingestTx(ident, tx);
            _focusedTxId = tx.id;
            setState(() {});
          } catch (e) {
            if (mounted) {
              ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
            }
          }
        },
        child: const Text('Send'),
      ),
      const SizedBox(height: 8),
      Builder(builder: (_) {
        final amt = double.tryParse(flowAmt.text) ?? 0;
        final L = levyNanos((amt * kUnitsPerShe).round());
        return Text('Flow levy (empty mempool) ${formatShe(L / kUnitsPerShe)} SHE. Hash bonuses stay on the found block.');
      }),
      const Text(
        'Receive: offer she1 (silent ID). Chain dests are ssa1. Never share shear1. Memo text is only in Shearview and theirs. Miner pulls sign in a popup (EIP-712 PoolWithdraw, chainId 2701); she1 never goes on the book.',
      ),
    ]);
  }

  Widget _resistance(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final bg = dark ? kCliDarkBg : kCliLightBg;
    final fg = dark ? kCliDarkFg : kCliLightFg;
    return ColoredBox(
      key: const Key('resistance-cli'),
      color: bg,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Resistance  η  —  CTF CLI',
              style: TextStyle(
                color: fg,
                fontFamily: 'Courier',
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 8),
            Expanded(
              child: Container(
                color: bg,
                alignment: Alignment.topLeft,
                child: SingleChildScrollView(
                  child: SelectableText(
                    _cliText,
                    style: TextStyle(
                      color: fg,
                      fontFamily: 'Courier',
                      fontSize: 12,
                      height: 1.35,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  String? _reserveDestOf(ShearIdentity ident) =>
      vaultDest(ident.address, viewKey: ledger.viewSecret ?? ident.viewKey);

  Future<void> _reserveSend(BuildContext context, ShearIdentity ident, {required bool addMore}) async {
    final dest = _reserveDestOf(ident);
    if (dest == null) return;
    final she = double.tryParse(reserveAmt.text.trim()) ?? 0;
    if (she <= 0) return;
    if (ledger.spendableOwned(ident.address, paymentCode: ident.paymentCode) < she) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Not enough spendable SHE')));
      }
      return;
    }
    final from = ledger.spendFrom(ident.address, paymentCode: ident.paymentCode, amount: she);
    final now = DateTime.now().millisecondsSinceEpoch;
    final err = reserve.deposit(dest: dest, she: she, nowMs: now, payout: from);
    if (err != null) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
      }
      return;
    }
    await ledger.send(
      from: from,
      to: dest,
      amount: she,
      local: true,
      kind: 'lock',
      programId: kReserveProgram,
      restFrame: ident.address,
      paymentCode: ident.paymentCode,
    );
    if (mounted) setState(() {});
    if (context.mounted && addMore) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Added to your Reserve key-portal')));
    }
  }

  Future<void> _reserveWithdraw(BuildContext context, ShearIdentity ident) async {
    final dest = _reserveDestOf(ident);
    if (dest == null) return;
    final to = ledger.currentDest(ident.address);
    final now = DateTime.now().millisecondsSinceEpoch;
    final out = reserve.withdrawTo(ledger, dest: dest, payout: to, nowMs: now);
    if (out == null) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('The epoch is still open. Withdraw after 400 days.')),
        );
      }
      return;
    }
    if (mounted) setState(() {});
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Principal and interest returned to Continuum')),
      );
    }
  }

  List<Widget> _reservePane(BuildContext context, ShearIdentity ident) {
    final dest = _reserveDestOf(ident) ?? '';
    final p = dest.isEmpty ? ReservePortal() : reserve.portal(dest);
    final now = DateTime.now().millisecondsSinceEpoch;
    final daysLeft = (reserve.remainingMs(now) / 86400000).floor();
    final stakedShe = formatShe(p.staked / kUnitsPerShe);
    final idleShe = formatShe(p.idle / kUnitsPerShe);
    final rw = dest.isEmpty
        ? const ReserveRewards(
            accrued: 0, projected: 0, staked: 0, idle: 0, oracleBps: 0, elapsedMs: 0)
        : reserve.rewards(dest, now);
    final accruedShe = formatShe(rw.accrued / kUnitsPerShe);
    final endShe = formatShe(rw.projected / kUnitsPerShe);
    final rate = '${(rw.oracleBps / 100).toStringAsFixed(2)}%';
    return [
      const Text('The Reserve', style: TextStyle(fontWeight: FontWeight.w700)),
      const Text(
        'The Reserve is Shear governance. Lock over π SHE into your portal. '
        'The first qualifying stake opens a 400-day epoch. '
        'Last-99-day deposits still unlock a vote but earn no stake. '
        'Interest is a variable rate observed by The Reserve oracle. '
        'The winning vote then moves the hash bonus by one unit.',
      ),
      if (reserve.cutoffDisclaimer(now)) ...[
        const SizedBox(height: 8),
        const Text(kReserveCutoffDisclaimer),
      ],
      const SizedBox(height: 8),
      Text('Your portal  $stakedShe SHE staked · $idleShe SHE idle'
          '${p.joined ? ' · joined this epoch' : ''}'),
      Text(reserve.epochStartMs == 0
          ? 'No epoch yet. The first π SHE deposit will start it.'
          : '$daysLeft days remaining in this epoch.'),
      Text('Live hash bonus  ${reserve.liveHashBonusNanos} unit(s)  ·  '
          'votes +${reserve.votesIncrease} / −${reserve.votesDecrease} / hold ${reserve.votesHold}'),
      if (p.nanos > 0) ...[
        Text('$kReserveAccruedLabel  $accruedShe SHE'),
        Text('At epoch end  $endShe SHE'),
        Text('Observed rate  $rate a year on staked SHE. Idle SHE does not accrue.'),
      ],
      const SizedBox(height: 8),
      TextField(
        controller: reserveAmt,
        keyboardType: TextInputType.number,
        decoration: const InputDecoration(labelText: 'Amount SHEAR'),
      ),
      const SizedBox(height: 8),
      Wrap(spacing: 8, runSpacing: 8, children: [
        FilledButton(
          onPressed: () => _reserveSend(context, ident, addMore: false),
          child: const Text('Send'),
        ),
        OutlinedButton(
          onPressed: () => _reserveSend(context, ident, addMore: true),
          child: const Text('Add more SHE to the vault'),
        ),
        if (p.nanos > 0 && reserve.epochStartMs != 0 && reserve.remainingMs(now) == 0)
          FilledButton(
            onPressed: () => _reserveWithdraw(context, ident),
            child: const Text('Withdraw to Continuum'),
          ),
      ]),
      if (p.canVote) ...[
        const SizedBox(height: 12),
        const Text('Vote to raise, lower, or leave the hash bonus (±1 unit). The 1 SHE pot does not change.'),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final v in [kVoteIncrease, kVoteDecrease, kVoteHold])
            ChoiceChip(
              label: Text(v),
              selected: p.vote == v,
              onSelected: (_) {
                if (p.vote != null &&
                    p.voteEpoch == reserve.currentEpoch &&
                    reserve.remainingMs(now) < kReserveJoinCutoffMs) {
                  return;
                }
                reserve.vote(dest: dest, choice: v, nowMs: now);
                setState(() {});
              },
            ),
        ]),
      ],
    ];
  }

  Future<void> _syncVaults(ShearIdentity ident) async {
    final pool = ledger.pool;
    if (pool == null) return;
    try {
      join.applyRemote(await pool.joinVault());
    } catch (_) {}
    try {
      final dest = _reserveDestOf(ident);
      if (dest != null) {
        reserve.applyRemotePortal(dest, await pool.reservePortal(dest));
      }
    } catch (_) {}
    if (mounted) setState(() {});
  }

  Future<void> _joinCredit(BuildContext context, ShearIdentity ident) async {
    final payout = ledger.homeDest(ident.address, paymentCode: ident.paymentCode);
    final now = DateTime.now().millisecondsSinceEpoch;
    final parsed = join.decodeKey(joinKeyCtrl.text);
    if (parsed == null) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('That migration key cannot be read.')));
      }
      return;
    }
    Map<String, int>? out;
    final pool = ledger.pool;
    if (pool != null) {
      out = await join.claimViaPool(ledger, pool: pool, key: joinKeyCtrl.text, payout: payout);
    } else {
      out = join.claimTo(ledger, key: joinKeyCtrl.text, payout: payout, nowMs: now);
    }
    if (out == null) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(join.windowOpen(now) ? 'This key has already been used, or the proof failed.' : kJoinWindowClosed),
        ));
      }
      return;
    }
    final pending = (out['pending'] ?? 0) > 0;
    if (mounted) setState(() => joinStatus = pending ? 'queued' : 'credited');
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            pending
                ? '${formatShe(parsed.she)} SHE queued. Spendable after the claim is sealed and confirmed.'
                : '${formatShe(parsed.she)} SHE credited to Continuum',
          ),
        ),
      );
    }
  }

  List<Widget> _joinPane(BuildContext context, ShearIdentity ident) {
    final now = DateTime.now().millisecondsSinceEpoch;
    final daysLeft = (join.remainingMs(now) / 86400000).floor();
    final parsed = join.decodeKey(joinKeyCtrl.text);
    final amount = parsed == null ? '—' : '${formatShe(parsed.she)} SHE';
    join.burnUnclaimed(now);
    return [
      const Text('The Join', style: TextStyle(fontWeight: FontWeight.w700)),
      const Text(
        'The Join vault is minted once at snapshot — the full prior-ledger circulation. '
        'Paste a join1. key from the prior-ledger wallet to claim your share onto this Continuum dest (1:1, no interest). '
        'The window is ninety-nine days from genesis. After that, unclaimed allocation is burned.',
      ),
      if (!join.windowOpen(now) && join.genesisMs != 0) ...[
        const SizedBox(height: 8),
        const Text(kJoinWindowClosed),
      ],
      const SizedBox(height: 8),
      Text(join.genesisMs == 0
          ? 'No genesis snapshot on this node yet.'
          : '$daysLeft days remaining in the claim window.'),
      Text('Vault remaining  ${formatShe(join.remainingNanos / kUnitsPerShe)} SHE'),
      const SizedBox(height: 8),
      TextField(
        controller: joinKeyCtrl,
        decoration: const InputDecoration(labelText: 'Migration key'),
        onChanged: (_) => setState(() {}),
        minLines: 2,
        maxLines: 4,
      ),
      const SizedBox(height: 8),
      Text('Amount to credit  $amount'),
      const SizedBox(height: 8),
      FilledButton(
        onPressed: (join.windowOpen(now) || ledger.pool != null) ? () => _joinCredit(context, ident) : null,
        child: const Text('Credit'),
      ),
    ];
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
      kids.addAll(_reservePane(context, ident));
    } else if (cur.id == joinProgram) {
      kids.addAll(_joinPane(context, ident));
    } else {
      final body = parseVorticeSource(cur.source);
      final unlock = cur.id == poolUnlockProgram || body?['id'] == poolUnlockProgram;
      if (unlock) _maybeFirePoolUnlock(ident, cur.source);
      kids.addAll([
        Text(cur.name, style: const TextStyle(fontWeight: FontWeight.w600)),
        Text('Program  ${cur.id}'),
        if (cur.origin != null) Text('Origin  ${cur.origin}'),
        if (unlock) ...[
          const SizedBox(height: 8),
          Text(
            poolUnlockCountdown(nowMs: DateTime.now().toUtc().millisecondsSinceEpoch, height: ledger.sealedHeight),
            key: const Key('pool-unlock-countdown'),
            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16),
          ),
          const Text('Opens 11 September 2044 21:00 UTC · height 6,312,001'),
          const Text('Then signs 1,000,000 SHE to the ssa1 dest with memo: pool wallet is now unlocked. No tap.'),
        ],
        const Text('Third-party vortice cannot mint SHE; it must fund its own rewards.'),
      ]);
    }
    return _card(kids);
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
      const SizedBox(height: 16),
      const Text('Settings', style: TextStyle(fontWeight: FontWeight.w700)),
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
        'same password restores this shear1 on another device.',
      ),
      const SizedBox(height: 8),
      FilledButton(
        onPressed: () async {
          final pw = session.password ?? password;
          if (pw.isEmpty) {
            if (mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Unlock with your password first.')),
              );
            }
            return;
          }
          try {
            final packed = exportShewall(identity: ident, ledger: ledger);
            final sealed = await sealShewallBin(packed, pw);
            final path = await saveShewallBytes(
              sealed,
              dest: widget.exportDest?.call(),
              picker: widget.savePicker,
            );
            if (mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text('Wrote encrypted $shewallName to $path')),
              );
            }
          } catch (e) {
            if (mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text('Export failed: $e')),
              );
            }
          }
        },
        child: const Text('Export shewall.bin'),
      ),
      const SizedBox(height: 8),
      OutlinedButton(
        onPressed: () async {
          final pw = session.password ?? password;
          if (pw.isEmpty) {
            if (mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Unlock with your password first.')),
              );
            }
            return;
          }
          try {
            final src = widget.importSrc?.call() ?? await pickShewallImportFile();
            if (src == null) {
              if (mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('No shewall.bin selected.')),
                );
              }
              return;
            }
            final imported = await importEncryptedShewall(src: src, password: pw, ledger: ledger);
            session.identity = imported;
            await session.setPassword(pw);
            id = imported;
            ledger.viewSecret = imported.viewKey;
            if (mounted) {
              setState(() {});
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Imported shewall.bin')),
              );
            }
          } catch (e) {
            if (mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text('Import failed: $e')),
              );
            }
          }
        },
        child: const Text('Import shewall.bin'),
      ),
    ]);
  }
}

class _ScanReceiveQrPage extends StatefulWidget {
  const _ScanReceiveQrPage();

  @override
  State<_ScanReceiveQrPage> createState() => _ScanReceiveQrPageState();
}

class _ScanReceiveQrPageState extends State<_ScanReceiveQrPage> {
  var _done = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan receive QR')),
      body: MobileScanner(
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
      ),
    );
  }
}
