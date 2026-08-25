import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'shear_identity.dart';
import 'shear_ledger.dart';
import 'shear_lock.dart';
import 'shear_macos_install.dart';
import 'shear_session.dart';
import 'shear_theme.dart';
import 'shear_ctf.dart';
import 'shear_ctf_cli.dart';
import 'shear_vortex.dart';
import 'shear_reserve.dart';
import 'shear_join.dart';

const kWalletVersion = '0.0.8';
const kTabs = [
  'Continuum',
  'Flow',
  'Resistance',
  'Vortex',
  'Shearview',
  'Closure',
];
const kSymbols = ['∇·J = 0', 'J^μ', 'η', 'Ω^{μν}', 'S_{μν}', 'G_{μν}'];
const kExplains = [
  'Your spendable balance and she1 address.',
  'Send SHEAR to anyone with a she1 address.',
  'Transactional data in a CLI output.',
  'Contracts which are deployed into your wallet.',
  'Your personal transaction explorer.',
  'Password and backup. Encrypts shewall.json so you can restore this wallet on another install.',
];

void main() {
  runApp(ShearWalletApp(demoTx: kDebugMode));
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

  @override
  State<ShearWalletApp> createState() => _ShearWalletAppState();
}

class _ShearWalletAppState extends State<ShearWalletApp> {
  late final ShearSession session = widget.session ?? ShearSession();
  late final ShearLedger ledger = widget.ledger ?? ShearLedger(pool: ShearPoolClient());
  ShearIdentity? id;
  String password = '';
  bool unlocked = false;
  int tab = 0;
  final flowTo = TextEditingController();
  final flowAmt = TextEditingController();
  final flowMemo = TextEditingController();
  final unlockCtrl = TextEditingController();
  final reserveAmt = TextEditingController();
  final joinKeyCtrl = TextEditingController();
  final vorticeKeyCtrl = TextEditingController();
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
    reserveAmt.dispose();
    joinKeyCtrl.dispose();
    vorticeKeyCtrl.dispose();
    _accrualTick?.cancel();
    super.dispose();
  }

  Future<void> _boot() async {
    id = await session.loadOrCreate();
    _syncJoinRoster();
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
      await session.persist();
      if (!mounted) return;
      setState(() {
        vortices = next;
        vortexTab = next.where(vorticeChipVisible).length - 1;
        vorticeKeyCtrl.clear();
      });
    } finally {
      _vorticeBusy = false;
    }
  }

  Future<void> _unlock(String pw) async {
    if (pw.isEmpty || id == null) return;
    password = pw;
    ledger.viewSecret = id!.viewKey;
    if (mounted) setState(() => unlocked = true);
    try {
      await ledger
          .syncCredits(id!.address, paymentCode: id!.paymentCode)
          .timeout(const Duration(seconds: 8));
    } catch (_) {}
    try {
      if (widget.demoTx) {
        var pay = ledger.currentDest(id!.address);
        if (ledger.spendable(pay) <= 0) {
          final minted = ledger.confirmRound(address: id!.address, pot: 1, height: 1);
          _ingestTx(id!, minted);
        }
      }
    } catch (_) {}
    _ingestHistory();
    if (mounted) setState(() {});
    _accrualTick?.cancel();
    _syncJoinRoster();
    _accrualTick = Timer.periodic(const Duration(seconds: 8), (_) {
      if (!mounted || !unlocked) return;
      _syncJoinRoster();
      final ident = id;
      if (ident == null) return;
      unawaited(ledger.syncCredits(ident.address, paymentCode: ident.paymentCode).then((_) {
        if (mounted) setState(() {});
      }));
    });
    if (widget.demoTx) {
      unawaited(_playDemoLive());
    }
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
    var n = 0;
    for (final t in ledger.ownerHistory(ident.address, paymentCode: ident.paymentCode)) {
      if (t.kind == 'hash') continue;
      _ingestTx(ident, t);
      n += 1;
      if (n >= 24) break;
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
    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
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
                  'Create a password for this wallet. It encrypts shewall.json.',
                  style: TextStyle(color: theme.colorScheme.onSurface),
                  textAlign: TextAlign.center,
                ),
                TextField(
                  controller: unlockCtrl,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: 'Password'),
                  onSubmitted: (_) => _unlock(unlockCtrl.text),
                ),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: () => _unlock(unlockCtrl.text),
                  child: const Text('Unlock'),
                ),
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
      final theme = Theme.of(context);
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            color: theme.cardColor,
            surfaceTintColor: Colors.transparent,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: DefaultTextStyle.merge(
                style: TextStyle(color: theme.colorScheme.onSurface),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: kids),
              ),
            ),
          ),
        ],
      );
    });
  }

  Widget _continuum(BuildContext context, ShearIdentity ident) {
    final dest = ledger.currentDest(ident.address);
    final spend = ledger.spendableOwned(ident.address, paymentCode: ident.paymentCode);
    final pending = ledger.pendingTxs(ident.address, paymentCode: ident.paymentCode);
    return _card([
      Text(
        '${formatShe(spend)} SHE',
        style: TextStyle(
          fontSize: 28,
          fontWeight: FontWeight.w700,
          color: shearAccentOf(context),
        ),
      ),
      Text('Spendable', style: TextStyle(color: shearMutedOf(context))),
      if (pending.isNotEmpty) ...[
        const SizedBox(height: 16),
        Text('Pending', style: TextStyle(fontWeight: FontWeight.w700, color: Theme.of(context).colorScheme.onSurface)),
        Text('Until the next block is found.', style: TextStyle(color: shearMutedOf(context))),
        for (final t in pending)
          ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            title: Text('${t.kind}  ${formatShe(t.amount)} SHE'),
            subtitle: Text('${t.from} → ${t.to}', maxLines: 1, overflow: TextOverflow.ellipsis),
          ),
      ],
      const SizedBox(height: 20),
      Text('Receive ID (she1 — perpetual)', style: TextStyle(fontWeight: FontWeight.w700, color: Theme.of(context).colorScheme.onSurface)),
      const SizedBox(height: 6),
      SelectableText(ident.paymentCode),
      const SizedBox(height: 12),
      OutlinedButton(
        onPressed: () => Clipboard.setData(ClipboardData(text: ident.paymentCode)),
        child: const Text('Copy ID'),
      ),
    ]);
  }

  Widget _shearview(BuildContext context, ShearIdentity ident) {
    final hist = ledger
        .ownerHistory(ident.address, paymentCode: ident.paymentCode)
        .where((t) => t.confirmed)
        .toList();
    final theme = Theme.of(context);
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: hist.isEmpty ? 2 : hist.length + 1,
      itemBuilder: (context, i) {
        if (i == 0) {
          return Card(
            color: theme.cardColor,
            surfaceTintColor: Colors.transparent,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Shearview  S_{μν}', style: TextStyle(fontWeight: FontWeight.w700)),
                  if (hist.any((t) => t.memo && t.memoPlain != null && !openedMemos.contains(t.id)))
                    Text('you have a new memo', style: TextStyle(fontWeight: FontWeight.w700, color: shearAccentOf(context))),
                  if (hist.isEmpty) Text('No confirmed transactions yet.', style: TextStyle(color: shearMutedOf(context))),
                ],
              ),
            ),
          );
        }
        if (hist.isEmpty) return const SizedBox.shrink();
        final t = hist[i - 1];
        return Card(
          color: theme.cardColor,
          surfaceTintColor: Colors.transparent,
          child: ListTile(
            dense: true,
            title: Text(
              t.kind == 'blockfound' || t.kind == 'mine'
                  ? 'block found  ${formatShe(t.amount)} SHE'
                  : '${t.kind}  ${formatShe(t.amount)} SHE',
            ),
            subtitle: Text(
              t.kind == 'blockfound' || t.kind == 'mine'
                  ? '${t.threads ?? 0} threads · h=${t.height ?? '-'}'
                  : t.memo && openedMemos.contains(t.id) && t.memoPlain != null
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
        );
      },
    );
  }

  Widget _flow(BuildContext context, ShearIdentity ident) {
    return _card([
      const Text('Flow  J^μ', style: TextStyle(fontWeight: FontWeight.w700)),
      const Text('shp1 dest this round (pay). Offer she1, never shear1.'),
      SelectableText(ledger.currentDest(ident.address)),
      const SizedBox(height: 8),
      TextField(controller: flowTo, decoration: const InputDecoration(labelText: 'To (she1…)')),
      TextField(controller: flowAmt, decoration: const InputDecoration(labelText: 'Amount SHE'), keyboardType: TextInputType.number),
      TextField(controller: flowMemo, decoration: const InputDecoration(labelText: 'Memo (optional)')),
      FilledButton(
        onPressed: () async {
          try {
            final rawTo = flowTo.text.trim();
            final to = payoutDest(rawTo) ?? rawTo;
            final tx = await ledger.send(
              from: ledger.currentDest(ident.address),
              to: to,
              amount: double.parse(flowAmt.text),
              memo: flowMemo.text.trim().isEmpty ? null : flowMemo.text.trim(),
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
      const Text(
        'Receive: offer she1 (silent ID). Chain dests are shp1. Never share shear1. Memo text is only in Shearview and theirs.',
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
    final from = ledger.currentDest(ident.address);
    if (she <= 0) return;
    if (ledger.spendable(from) < she) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Not enough spendable SHE')));
      }
      return;
    }
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
        'Lock SHE for 400 days in your private key-portal. The first π SHE deposit opens the epoch. '
        'Interest is a variable rate observed by The Reserve oracle on every node. '
        'Only this vortice may mint that interest.',
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
        const Text('Vote on the per-hash bonus (±1 unit of 10⁻¹¹ SHE; the 1 SHE pot does not change)'),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final v in [kVoteIncrease, kVoteDecrease, kVoteHold])
            ChoiceChip(
              label: Text(v),
              selected: p.vote == v,
              onSelected: (_) {
                reserve.vote(dest: dest, choice: v, nowMs: now);
                setState(() {});
              },
            ),
        ]),
      ],
    ];
  }

  Future<void> _joinCredit(BuildContext context, ShearIdentity ident) async {
    final payout = ledger.currentDest(ident.address);
    final now = DateTime.now().millisecondsSinceEpoch;
    final parsed = join.decodeKey(joinKeyCtrl.text);
    if (parsed == null) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('That migration key cannot be read.')));
      }
      return;
    }
    final out = join.claimTo(ledger, key: joinKeyCtrl.text, payout: payout, nowMs: now);
    if (out == null) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(join.windowOpen(now) ? 'This key has already been used, or the proof failed.' : kJoinWindowClosed),
        ));
      }
      return;
    }
    if (mounted) setState(() => joinStatus = 'credited');
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('${formatShe(parsed.she)} SHE credited to Continuum')),
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
        'Claim the genesis snapshot into your Continuum dest. One coin on the prior ledger becomes one SHE. '
        'The window is ninety-nine days from mainnet genesis. After that, unclaimed allocation is burned.',
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
        onPressed: join.windowOpen(now) ? () => _joinCredit(context, ident) : null,
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
      kids.addAll([
        Text(cur.name, style: const TextStyle(fontWeight: FontWeight.w600)),
        Text('Program  ${cur.id}'),
        if (cur.origin != null) Text('Origin  ${cur.origin}'),
        const Text('Third-party vortice cannot mint SHE; it must fund its own rewards.'),
      ]);
    }
    return _card(kids);
  }

  Widget _closure(BuildContext context, ShearIdentity ident) {
    final pw = TextEditingController();
    return _card([
      const Text('Closure  G_{μν}', style: TextStyle(fontWeight: FontWeight.w700)),
      const Text(
        'Geometric closure of the wallet: password seals shewall.json '
        '(AES-256-GCM). Copy that one file to restore address and transactions. '
        'The password is the view key. Dest scan stays in this wallet.',
      ),
      SelectableText('View key  ${ident.viewKey}', style: TextStyle(fontSize: 12, color: shearMutedOf(context))),
      const SizedBox(height: 8),
      const Text('CTF dests this view key opens (amounts on Shearview)'),
      SelectableText('shp1  ${ledger.currentDest(ident.address)}'),
      SelectableText('shear1  ${ident.address}'),
      TextField(
        controller: pw,
        obscureText: true,
        decoration: const InputDecoration(labelText: 'Wallet password'),
        onChanged: (v) => password = v,
      ),
      const SizedBox(height: 8),
      FilledButton(
        onPressed: () async {
          if (password.isEmpty) return;
          final dump = exportShewall(identity: ident, ledger: ledger);
          final sealed = await ShearLock.seal(dump, password);
          final dest = File('${Directory.systemTemp.path}/$shewallName');
          await writeShewallFile(dest, sealed);
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('Wrote encrypted $shewallName')),
            );
          }
        },
        child: const Text('Export shewall.json'),
      ),
    ]);
  }
}
