import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'shear_identity.dart';
import 'shear_ledger.dart';
import 'shear_lock.dart';
import 'shear_macos_install.dart';
import 'shear_miner_host.dart';
import 'shear_session.dart';
import 'shear_theme.dart';
import 'shear_ctf.dart';
import 'shear_vortex.dart';

const kWalletVersion = '0.0.4';
const kTabs = [
  'Continuum',
  'Flow',
  'Resistance',
  'Vortex',
  'Shear',
  'Reserve',
  'Closure',
];
const kSymbols = ['∇·J = 0', 'J^μ', 'η', 'Ω^{μν}', 'S_{μν}', 'π', 'G_{μν}'];
const kExplains = [
  'Your money. Spendable SHE after a block is found, plus this round’s pending hashes.',
  'Send SHE to an shp1 dest. Offer she1 (silent ID), never rest-frame shear1.',
  'Mining. Start hashing. Each hash credits a tiny amount; you can spend it only when a block is found.',
  'Apps and contracts other people deploy. They cannot print SHE; they must fund their own rewards.',
  'How SHE is created: 1 SHE per block, plus 0.000000001 SHE per hash to each miner in that round.',
  'Lock π SHE for 400 days to vote, and earn Bank of England base-rate interest. The only app allowed to mint extra SHE.',
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
    this.miner,
  });

  final ShearSession? session;
  final ShearLedger? ledger;
  final String? launchExecutable;
  final ShearMinerHost? miner;

  @override
  State<ShearWalletApp> createState() => _ShearWalletAppState();
}

class _ShearWalletAppState extends State<ShearWalletApp> {
  late final ShearSession session = widget.session ?? ShearSession();
  late final ShearLedger ledger = widget.ledger ?? ShearLedger(pool: ShearPoolClient());
  late final ShearMinerHost miner =
      widget.miner ?? ShearMinerHost(resolvedExecutable: widget.launchExecutable);
  ShearIdentity? id;
  String password = '';
  bool unlocked = false;
  int tab = 0;
  bool mining = false;
  final flowTo = TextEditingController();
  final flowAmt = TextEditingController();
  final flowMemo = TextEditingController();
  int vortexTab = 0;
  List<Vortice> vortices = const [reserveVortice];
  final Set<String> openedMemos = {};
  String? lastMemoPlain;
  ThemeMode _themeMode = ThemeMode.light;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  @override
  void dispose() {
    miner.stop();
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
    if (mounted) setState(() => unlocked = true);
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
      home: unlocked ? _shell() : _lockGate(),
    );
  }

  void _toggleTheme() {
    setState(() {
      _themeMode = _themeMode == ThemeMode.dark ? ThemeMode.light : ThemeMode.dark;
    });
  }

  Widget _brandMark({double size = 40}) {
    return Image.asset(kShearLogoAsset, width: size, height: size, filterQuality: FilterQuality.medium);
  }

  Widget _brandWordmark({double height = 22}) {
    return Image.asset(
      shearWordmarkAsset(_themeMode == ThemeMode.dark ? Brightness.dark : Brightness.light),
      height: height,
      filterQuality: FilterQuality.high,
    );
  }

  Widget _lockGate() {
    final ctrl = TextEditingController();
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                _brandMark(size: 72),
                const SizedBox(height: 10),
                _brandWordmark(height: 28),
                const SizedBox(height: 8),
                const Text('Create a password for this wallet. It encrypts shewall.json.'),
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

  Widget _shell() {
    final ident = id;
    if (ident == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final pages = [
      _continuum(ident),
      _flow(ident),
      _resistance(ident),
      _vortex(ident),
      _shearTab(),
      _reserve(ident),
      _closure(ident),
    ];
    return Scaffold(
      appBar: AppBar(
        leading: Padding(padding: const EdgeInsets.all(8), child: _brandMark(size: 28)),
        title: Row(
          children: [
            _brandWordmark(height: 22),
            const SizedBox(width: 8),
            Text('$kWalletVersion  ${kSymbols[tab]}'),
          ],
        ),
        actions: [
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
              content: const Text(macosMoveBody),
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
                child: Text(kSymbols[i], style: const TextStyle(fontSize: 11)),
              ),
              label: kTabs[i],
            ),
        ],
      ),
    );
  }

  Widget _card(List<Widget> kids) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          color: Theme.of(context).cardColor,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: kids),
          ),
        ),
      ],
    );
  }

  Widget _continuum(ShearIdentity ident) {
    final hist = ledger.ownerHistory(ident.address);
    final dest = ledger.currentDest(ident.address);
    final listed = ledger.listedDests(ident.address);
    return _card([
      const Text('Continuum  ∇·J = 0', style: TextStyle(fontWeight: FontWeight.w700)),
      const Text('she is quiet. Public ID (she1) — offer this everywhere'),
      SelectableText(ident.paymentCode),
      const SizedBox(height: 6),
      const Text('Rest-frame shear1 (never share, never on chain)'),
      SelectableText(ident.address),
      const SizedBox(height: 6),
      const Text('shp1 dests revolve each round; New dest mints more shp1.'),
      for (var i = 0; i < listed.length; i++)
        ListTile(
          dense: true,
          selected: i == ledger.destIndex,
          title: SelectableText(listed[i]),
          subtitle: Text(i == ledger.destIndex ? 'selected · dest $i' : 'dest $i'),
          onTap: () => setState(() => ledger.selectDest(i)),
        ),
      Wrap(spacing: 8, children: [
        FilledButton(
          onPressed: () => setState(() => ledger.newDest(ident.address)),
          child: const Text('New dest'),
        ),
        OutlinedButton(
          onPressed: () => Clipboard.setData(ClipboardData(text: ident.paymentCode)),
          child: const Text('Copy ID'),
        ),
        OutlinedButton(
          onPressed: () => Clipboard.setData(ClipboardData(text: dest)),
          child: const Text('Copy dest'),
        ),
      ]),
      const SizedBox(height: 8),
      Text('Spendable  ${ledger.spendable(dest).toStringAsFixed(9)} SHE',
          style: const TextStyle(fontSize: 18, color: shearCyan, fontWeight: FontWeight.w700)),
      Text('Pending this round  ${ledger.pending(dest).toStringAsFixed(9)} SHE  (not spendable until block found)'),
      const SizedBox(height: 12),
      const Text('Explorer', style: TextStyle(fontWeight: FontWeight.w700)),
      if (hist.any((t) => t.memo && t.memoPlain != null && !openedMemos.contains(t.id)))
        const Text('you have a new memo', style: TextStyle(fontWeight: FontWeight.w700, color: shearCyan)),
      if (hist.isEmpty) const Text('No confirmed transactions yet.', style: TextStyle(color: shearMuted)),
      for (final t in hist)
        ListTile(
          dense: true,
          title: Text('${t.kind}  ${t.amount.toStringAsFixed(9)} SHE'),
          subtitle: Text(
            t.memo && openedMemos.contains(t.id) && t.memoPlain != null
                ? '${t.from} → ${t.to}  h=${t.height ?? '-'}  memo: ${t.memoPlain}'
                : '${t.from} → ${t.to}  h=${t.height ?? '-'}',
          ),
          onTap: t.memo
              ? () => setState(() {
                    openedMemos.add(t.id);
                    lastMemoPlain = t.memoPlain;
                  })
              : null,
        ),
      const SizedBox(height: 8),
      Wrap(spacing: 8, children: [
        FilledButton(
          onPressed: () async {
            final dump = exportShewall(identity: ident, ledger: ledger);
            final sealed = await ShearLock.seal(dump, password);
            final dest = File('${Directory.systemTemp.path}/$shewallName');
            await writeShewallFile(dest, sealed);
            if (mounted) {
              ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Wrote $shewallName')));
            }
          },
          child: const Text('Export shewall.json'),
        ),
      ]),
    ]);
  }

  Widget _flow(ShearIdentity ident) {
    return _card([
      const Text('Flow  J^μ', style: TextStyle(fontWeight: FontWeight.w700)),
      const Text('shp1 dest this round (mine / pay). Offer she1, never shear1.'),
      SelectableText(ledger.currentDest(ident.address)),
      const SizedBox(height: 8),
      TextField(controller: flowTo, decoration: const InputDecoration(labelText: 'To (shp1…)')),
      TextField(controller: flowAmt, decoration: const InputDecoration(labelText: 'Amount SHE'), keyboardType: TextInputType.number),
      TextField(controller: flowMemo, decoration: const InputDecoration(labelText: 'Memo (optional)')),
      FilledButton(
        onPressed: () async {
          try {
            await ledger.send(
              from: ledger.currentDest(ident.address),
              to: flowTo.text.trim(),
              amount: double.parse(flowAmt.text),
              memo: flowMemo.text.trim().isEmpty ? null : flowMemo.text.trim(),
            );
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
        'Receive: offer she1 (silent ID). Chain dests are shp1. Never share shear1. Memo text is only in your explorer tab and theirs.',
      ),
    ]);
  }

  Widget _resistance(ShearIdentity ident) {
    return _card([
      const Text('Resistance  η', style: TextStyle(fontWeight: FontWeight.w700)),
      Text(mining ? 'Mining…' : 'Idle'),
      FilledButton(
        onPressed: () async {
          if (mining) {
            miner.stop();
            setState(() => mining = false);
            return;
          }
          if (miner.isDesktop) {
            final proc = await miner.start(
              address: ledger.currentDest(ident.address),
              pool: 'pool.shear.digital:1111',
            );
            if (proc == null) {
              if (mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Bundled shear-miner not found next to the app.')),
                );
              }
              return;
            }
          } else {
            miner.startInApp(onHashes: (n) {
              ledger.creditHash(ident.address, hashes: n);
              if (mounted) setState(() {});
            });
          }
          setState(() => mining = true);
        },
        child: Text(mining ? 'Stop' : 'Mine'),
      ),
      Text('Pending hashes credit 1e-9 SHE each. Spendable only when a block is found.'),
    ]);
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

  Widget _shearTab() {
    return _card(const [
      Text('Shear  S_{μν}', style: TextStyle(fontWeight: FontWeight.w700)),
      Text('Block pot: 1 SHE.'),
      Text('Per hash this round: 0.000000001 SHE to each hasher who produced that hash.'),
      Text('The Reserve is the only dapp that may mint extra SHE (BoE interest on locked π).'),
      Text('Network: shear-testnet-v1. Pool: pool.shear.digital:1111. Algo: ShearHash.'),
    ]);
  }

  Widget _reserve(ShearIdentity ident) {
    return _card([
      const Text('Reserve  π', style: TextStyle(fontWeight: FontWeight.w700)),
      const Text('Lock π SHE for 400 days to vote. Interest tracks the Bank of England Base Rate.'),
      const Text('Vote: raise, lower, or hold the per-hash bonus (±1e-10). The 1 SHE pot does not change.'),
      const SizedBox(height: 8),
      const Text('Lock principal is vault shp1, never rest-frame shear1.'),
      SelectableText(vaultDest(ident.address, viewKey: ledger.viewSecret ?? ident.viewKey) ?? ''),
    ]);
  }

  Widget _closure(ShearIdentity ident) {
    final pw = TextEditingController();
    return _card([
      const Text('Closure  G_{μν}', style: TextStyle(fontWeight: FontWeight.w700)),
      const Text(
        'Geometric closure of the wallet: password seals shewall.json '
        '(AES-256-GCM). Copy that one file to restore address and transactions. '
        'The password is the view key. Dest scan stays in this wallet.',
      ),
      SelectableText('View key  ${ident.viewKey}', style: const TextStyle(fontSize: 12, color: shearMuted)),
      const SizedBox(height: 8),
      const Text('CTF dests this view key opens (amounts on explorer)'),
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
