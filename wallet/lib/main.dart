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

const kWalletVersion = '0.0.5';
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
  runApp(const ShearWalletApp());
}

class ShearWalletApp extends StatefulWidget {
  const ShearWalletApp({
    super.key,
    this.session,
    this.ledger,
    this.launchExecutable,
    this.demoTx = false,
  });

  final ShearSession? session;
  final ShearLedger? ledger;
  final String? launchExecutable;
  /// Local observation only: confirm one testnet round so Shearview/Resistance have a tx.
  final bool demoTx;

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
  int vortexTab = 0;
  List<Vortice> vortices = const [reserveVortice];
  final Set<String> openedMemos = {};
  String? lastMemoPlain;
  ThemeMode _themeMode = ThemeMode.light;
  final Map<String, String> _cliById = {};
  String? _focusedTxId;

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
    super.dispose();
  }

  Future<void> _boot() async {
    id = await session.loadOrCreate();
    if (mounted) setState(() {});
  }

  Future<void> _unlock(String pw) async {
    if (pw.isEmpty || id == null) return;
    password = pw;
    ledger.viewSecret = pw;
    final dest = ledger.currentDest(id!.address);
    await ledger.syncSpendable(dest);
    await ledger.syncHistory(dest);
    if (widget.demoTx && ledger.ownerHistory(id!.address).isEmpty) {
      ledger.viewSecret = id!.viewKey;
      final tx = ledger.confirmRound(address: id!.address, pot: 1, height: 1);
      _ingestTx(id!, tx);
      _focusedTxId = tx.id;
      tab = _resistanceTab;
    }
    _ingestHistory();
    if (mounted) setState(() => unlocked = true);
  }

  int get _resistanceTab => kTabs.indexOf('Resistance');

  void _ingestTx(ShearIdentity ident, ShearTx tx) {
    _cliById[tx.id] = ctfTranscript(
      identity: ident,
      tx: tx,
      spendableAfter: ledger.spendable(ident.address),
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
    final ctrl = TextEditingController();
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
                  controller: ctrl,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: 'Password'),
                  onSubmitted: (_) => _unlock(ctrl.text),
                ),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: () => _unlock(ctrl.text),
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
      _vortex(ident),
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
              child: Text(
                'block height: ${ledger.sealedHeight}',
                style: TextStyle(
                  fontSize: 12,
                  color: Theme.of(context).colorScheme.onSurface,
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
    final spend = ledger.spendable(dest);
    final pending = ledger.pendingTxs(ident.address);
    return _card([
      Text(
        '${spend.toStringAsFixed(9)} SHE',
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
            title: Text('${t.kind}  ${t.amount.toStringAsFixed(9)} SHE'),
            subtitle: Text('${t.from} → ${t.to}', maxLines: 1, overflow: TextOverflow.ellipsis),
          ),
      ],
      const SizedBox(height: 20),
      Text('Receive ID', style: TextStyle(fontWeight: FontWeight.w700, color: Theme.of(context).colorScheme.onSurface)),
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
    final hist = ledger.ownerHistory(ident.address).where((t) => t.confirmed).toList();
    return _card([
      const Text('Shearview  S_{μν}', style: TextStyle(fontWeight: FontWeight.w700)),
      if (hist.any((t) => t.memo && t.memoPlain != null && !openedMemos.contains(t.id)))
        Text('you have a new memo', style: TextStyle(fontWeight: FontWeight.w700, color: shearAccentOf(context))),
      if (hist.isEmpty) Text('No confirmed transactions yet.', style: TextStyle(color: shearMutedOf(context))),
      for (final t in hist)
        ListTile(
          dense: true,
          title: Text('${t.kind}  ${t.amount.toStringAsFixed(9)} SHE'),
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
      const Text('shp1 dest this round (pay). Offer she1, never shear1.'),
      SelectableText(ledger.currentDest(ident.address)),
      const SizedBox(height: 8),
      TextField(controller: flowTo, decoration: const InputDecoration(labelText: 'To (shp1…)')),
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

  Widget _vortex(ShearIdentity ident) {
    final keyCtrl = TextEditingController();
    final tabs = [...vortices, const Vortice(id: '_add', name: 'Add new vortice')];
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
        const Text('Paste a vortice key from the dapp creator.'),
        TextField(controller: keyCtrl, decoration: const InputDecoration(labelText: 'Creator vortice key')),
        FilledButton(
          onPressed: () {
            final next = addVortice(vortices, keyCtrl.text);
            if (next.length == vortices.length) return;
            setState(() {
              vortices = next;
              vortexTab = next.length - 1;
            });
          },
          child: const Text('Add vortice'),
        ),
      ]);
    } else if (cur.id == reserveProgram) {
      kids.addAll([
        const Text('The Reserve. Lock π SHE for 400 days. Only this vortice may mint extra SHE.'),
        SelectableText(vaultDest(ident.address, viewKey: ledger.viewSecret ?? ident.viewKey) ?? ''),
      ]);
    } else {
      kids.addAll([
        Text(cur.name, style: const TextStyle(fontWeight: FontWeight.w600)),
        Text('Program  ${cur.id}'),
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
      SelectableText(ledger.currentDest(ident.address)),
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
