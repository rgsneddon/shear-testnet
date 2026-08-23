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

const kWalletVersion = '0.0.1';
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
  'Send SHE to another shear1 address, or share yours so people can pay you.',
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
  });

  final ShearSession? session;
  final ShearLedger? ledger;
  final String? launchExecutable;

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
  final miner = ShearMinerHost();
  bool mining = false;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    id = await session.loadOrCreate();
    await ledger.syncSpendable(id!.address);
    await ledger.syncHistory(id!.address);
    if (mounted) setState(() {});
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
      theme: shearTheme(),
      home: unlocked ? _shell() : _lockGate(),
    );
  }

  Widget _lockGate() {
    final ctrl = TextEditingController();
    return Scaffold(
      backgroundColor: shearBg,
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('SHEAR', style: TextStyle(letterSpacing: 4, fontWeight: FontWeight.w800, color: shearBlue)),
                const SizedBox(height: 8),
                const Text('Create a password for this wallet. It encrypts shewall.json.'),
                TextField(
                  controller: ctrl,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: 'Password'),
                  onSubmitted: (_) => setState(() {
                    password = ctrl.text;
                    unlocked = password.isNotEmpty;
                  }),
                ),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: () => setState(() {
                    password = ctrl.text;
                    unlocked = password.isNotEmpty;
                  }),
                  child: const Text('Unlock'),
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
      _vortex(),
      _shearTab(),
      _reserve(),
      _closure(ident),
    ];
    return Scaffold(
      appBar: AppBar(
        title: Text('Shear  $kWalletVersion  ${kSymbols[tab]}'),
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
          color: shearCard,
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
    return _card([
      const Text('Continuum  ∇·J = 0', style: TextStyle(fontWeight: FontWeight.w700)),
      SelectableText(ident.address),
      Text('View key  ${ident.viewKey}', style: const TextStyle(fontSize: 12, color: shearMuted)),
      const SizedBox(height: 8),
      Text('Spendable  ${ledger.spendable(ident.address).toStringAsFixed(9)} SHE',
          style: const TextStyle(fontSize: 18, color: shearCyan, fontWeight: FontWeight.w700)),
      Text('Pending this round  ${ledger.pending(ident.address).toStringAsFixed(9)} SHE  (not spendable until block found)'),
      const SizedBox(height: 12),
      const Text('Explorer', style: TextStyle(fontWeight: FontWeight.w700)),
      if (hist.isEmpty) const Text('No confirmed transactions yet.', style: TextStyle(color: shearMuted)),
      for (final t in hist)
        ListTile(
          dense: true,
          title: Text('${t.kind}  ${t.amount.toStringAsFixed(9)} SHE'),
          subtitle: Text('${t.from} → ${t.to}  h=${t.height ?? '-'}'),
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
        OutlinedButton(
          onPressed: () => Clipboard.setData(ClipboardData(text: ident.address)),
          child: const Text('Copy address'),
        ),
      ]),
    ]);
  }

  Widget _flow(ShearIdentity ident) {
    final to = TextEditingController();
    final amt = TextEditingController();
    return _card([
      const Text('Flow  J^μ', style: TextStyle(fontWeight: FontWeight.w700)),
      TextField(controller: to, decoration: const InputDecoration(labelText: 'To (shear1…)')),
      TextField(controller: amt, decoration: const InputDecoration(labelText: 'Amount SHE'), keyboardType: TextInputType.number),
      FilledButton(
        onPressed: () async {
          try {
            await ledger.send(from: ident.address, to: to.text.trim(), amount: double.parse(amt.text));
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
      const Text('Receive: share your shear1 address. Incoming confirmed txs appear on Continuum.'),
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
            await miner.start(address: ident.address, pool: 'pool.shear.digital:1111');
          } else {
            ledger.creditHash(ident.address);
          }
          setState(() => mining = true);
        },
        child: Text(mining ? 'Stop' : 'Mine'),
      ),
      Text('Pending hashes credit 1e-9 SHE each. Spendable only when a block is found.'),
    ]);
  }

  Widget _vortex() {
    return _card(const [
      Text('Vortex  Ω^{μν}', style: TextStyle(fontWeight: FontWeight.w700)),
      Text('Contract surface. Third-party staking dapps must top up rewards; they cannot mint SHE.'),
    ]);
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

  Widget _reserve() {
    return _card(const [
      Text('Reserve  π', style: TextStyle(fontWeight: FontWeight.w700)),
      Text('Lock π SHE for 400 days to vote. Interest tracks the Bank of England Base Rate.'),
      Text('Vote: raise, lower, or hold the per-hash bonus (±1e-10). The 1 SHE pot does not change.'),
    ]);
  }

  Widget _closure(ShearIdentity ident) {
    final pw = TextEditingController();
    return _card([
      const Text('Closure  G_{μν}', style: TextStyle(fontWeight: FontWeight.w700)),
      const Text(
        'Geometric closure of the wallet: password seals shewall.json '
        '(AES-256-GCM). Copy that one file to restore address and transactions.',
      ),
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
