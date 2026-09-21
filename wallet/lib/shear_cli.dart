import 'dart:convert';
import 'dart:io';

import 'shear_ctf.dart';
import 'shear_eip712.dart';
import 'shear_identity.dart';
import 'shear_ledger.dart';
import 'shear_levy.dart';
import 'shear_read_sync.dart';
import 'shear_reserve.dart';
import 'shear_session.dart';
import 'shear_shewall.dart';
import 'shear_vortex.dart';

/// Public wallet pin. Keep in lock-step with [kWalletVersion] in main.dart.
const kCliVersion = '0.46';

/// GUI surface each command covers. Tests assert this map stays complete.
const kCliGuiCoverage = <String, String>{
  'create': 'Closure — Create',
  'restore': 'Closure — Import shewall.bin',
  'unlock': 'lock screen',
  'status': 'Continuum',
  'id': 'Continuum — Copy ID (she1)',
  'dest': 'Continuum — Copy dest (ssa1 mining mailbox)',
  'balance': 'Continuum spendable / pending',
  'receive': 'fresh stealth ssa1 (not the mining mailbox)',
  'send': 'Flow — sign and post a spend',
  'sign': 'Flow / pull / vote / lock — sign with spend key',
  'vote': 'Vortex — The Reserve vote (signed)',
  'rewards': 'Vortex — The Reserve staked / accrued / claim',
  'history': 'Shearview',
  'tx': 'Resistance — CTF transcript',
  'backup': 'Closure — Export shewall.bin',
  'password': 'Closure — set / change password',
  'reset': 'Closure — explicit book reset',
  'sync': 'Continuum node sync',
  'reserve': 'Vortex — The Reserve lock / vote / withdraw',
  'vortex': 'Vortex — create vort1, register, call, list',
  'version': 'title pin',
  'help': 'this help',
};

const kCliRootCommands = [
  'help',
  'version',
  'create',
  'restore',
  'unlock',
  'status',
  'id',
  'dest',
  'balance',
  'receive',
  'send',
  'sign',
  'vote',
  'rewards',
  'history',
  'tx',
  'backup',
  'password',
  'reset',
  'sync',
  'reserve',
  'vortex',
];

const kCliReserveSubs = ['status', 'lock', 'vote', 'withdraw', 'rewards', 'claim'];
const kCliVortexSubs = ['list', 'show', 'create', 'register', 'call', 'remove'];
const kCliSignSubs = ['flow', 'pull', 'vote', 'lock'];

const kCliHelp = '''
Shear wallet CLI $kCliVersion  (GUI pin $kCliVersion)
Book magic: $kBookMagic
ADMIT = Anonymous Destination Membership Integer Transactions (ADMITv2)

Every GUI function has a command. Nested --help prints that command only.
Password never belongs on argv (it shows in ps). Use --password-file or
SHEAR_WALLET_PASSWORD. Node RPC defaults to http://127.0.0.1:18332.

Usage:
  shear <command> [options]
  shear help
  shear <command> --help

Commands (GUI surface):
  help                 this help
  version              pin, magic, platforms
  create               Closure — new identity + password
  restore              Closure — import shewall.bin
  unlock               lock screen
  status               Continuum overview
  id                   Continuum — she1 (Copy ID)
  dest                 Continuum — ssa1 mining mailbox (Copy dest)
  balance              Continuum spendable + pending
  receive              mint a fresh stealth ssa1 (not the mining mailbox)
  send                 Flow — sign + pay she1 or ssa1
  sign                 sign Flow / pool-pull / Reserve vote / lock
  vote                 The Reserve vote (signed kind=vote)
  rewards              The Reserve staked + accrued + claim
  history              Shearview
  tx <id>              Resistance — CTF transcript
  backup               Closure — export shewall.bin
  password             Closure — set password
  reset                explicit reset off a foreign-book shewall
  sync                 headers + compact blocks from local node
  reserve              Vortex — The Reserve (lock | vote | withdraw | status)
  vortex               create vort1 | register | call | list | show | remove

Global options:
  --store PATH         session.json (default: OS app-support path)
  --password-file PATH read password (no trailing-newline strip beyond one \\n)
  --rpc URL            local node (default http://127.0.0.1:18332)
  --json               machine-readable stdout
  --network MAGIC      must be $kBookMagic today; shear-v1 waits for genesis
  -h, --help           help

Examples:
  shear create --store ./session.json --password-file ./pw
  shear dest --store ./session.json --password-file ./pw
  shear send --to she1… --amount 0.001 --password-file ./pw
  shear sign flow --to ssa1… --amount 0.001 --password-file ./pw
  shear sign pull --dest ssa1… --amount 0.01 --password-file ./pw
  shear vote --choice hold --password-file ./pw
  shear vortex create --id mydapp --origin https://example.com/dapp --source-file ./dapp.json
  shear vortex register --vort1 'vort1.…'
  shear vortex call --id mydapp --kind send --to ssa1… --amount 0.001

Mainnet shear-v1 is not live. This CLI refuses to emit that book.
''';

class _BufSink implements IOSink {
  _BufSink(this.buf);
  final StringBuffer buf;
  @override
  void writeln([Object? o = '']) => buf.writeln(o);
  @override
  void write(Object? o) => buf.write(o);
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

/// Run the CLI. Returns process exit code. Does not call [exit].
Future<int> runShearCli(
  List<String> argv, {
  StringBuffer? stdout,
  StringBuffer? stderr,
  Map<String, String>? env,
}) async {
  final outBuf = stdout ?? StringBuffer();
  final errBuf = stderr ?? StringBuffer();
  final out = _BufSink(outBuf);
  final err = _BufSink(errBuf);
  try {
    return await _run(argv, out, err, env ?? Platform.environment);
  } on FormatException catch (e) {
    err.writeln(e.message);
    return 2;
  } on ArgumentError catch (e) {
    err.writeln(e.message);
    return 2;
  } catch (e) {
    err.writeln(e.toString());
    return 1;
  }
}

Future<int> _run(List<String> argv, IOSink out, IOSink err, Map<String, String> env) async {
  final args = [...argv];
  if (args.isEmpty || args.first == 'help' || args.contains('-h') && args.length == 1) {
    out.writeln(kCliHelp.trimRight());
    return 0;
  }
  final cmd = args.removeAt(0);
  if (cmd == '-h' || cmd == '--help') {
    out.writeln(kCliHelp.trimRight());
    return 0;
  }
  if (!kCliRootCommands.contains(cmd)) {
    err.writeln('unknown command: $cmd');
    err.writeln('Try: shear help');
    return 2;
  }
  if (args.contains('-h') || args.contains('--help')) {
    out.writeln(_commandHelp(cmd));
    return 0;
  }
  final flags = _parseFlags(args);
  if (flags.rest.contains('-h') || flags.rest.contains('--help')) {
    out.writeln(_commandHelp(cmd));
    return 0;
  }
  final network = flags['network'] ?? env['SHEAR_NETWORK'] ?? kBookMagic;
  if (network == 'shear-v1') {
    err.writeln(jsonEncode({
      'ok': false,
      'emit': false,
      'reason': 'clock_wait',
      'magic': 'shear-v1',
      'detail': 'mainnet is not cut. This CLI stays on $kBookMagic.',
    }));
    return 3;
  }
  if (network != kBookMagic) {
    err.writeln('unsupported network $network (this pin is $kBookMagic)');
    return 2;
  }

  switch (cmd) {
    case 'help':
      out.writeln(kCliHelp.trimRight());
      return 0;
    case 'version':
      return _version(out, flags.json);
    case 'create':
      return _create(out, err, flags, env);
    case 'restore':
      return _restore(out, err, flags, env);
    case 'unlock':
      return _unlock(out, err, flags, env);
    case 'status':
      return _status(out, err, flags, env);
    case 'id':
      return _id(out, flags, env);
    case 'dest':
      return _dest(out, flags, env);
    case 'balance':
      return _balance(out, flags, env);
    case 'receive':
      return _receive(out, flags, env);
    case 'send':
      return _send(out, err, flags, env);
    case 'sign':
      return _sign(out, err, flags, env);
    case 'vote':
      return _vote(out, err, flags, env);
    case 'rewards':
      return _rewards(out, err, flags, env);
    case 'history':
      return _history(out, flags, env);
    case 'tx':
      return _tx(out, err, flags, env);
    case 'backup':
      return _backup(out, err, flags, env);
    case 'password':
      return _password(out, err, flags, env);
    case 'reset':
      return _reset(out, err, flags, env);
    case 'sync':
      return _sync(out, err, flags, env);
    case 'reserve':
      return _reserve(out, err, flags, env);
    case 'vortex':
      return _vortex(out, err, flags, env);
    default:
      err.writeln('unknown command: $cmd');
      return 2;
  }
}

class _Flags {
  _Flags(this.map, this.rest, this.json);
  final Map<String, String> map;
  final List<String> rest;
  final bool json;
  String? operator [](String k) => map[k];
}

_Flags _parseFlags(List<String> args) {
  final map = <String, String>{};
  final rest = <String>[];
  var json = false;
  for (var i = 0; i < args.length; i++) {
    final a = args[i];
    if (a == '--json') {
      json = true;
      continue;
    }
    if (a.startsWith('--') && a.contains('=')) {
      final eq = a.indexOf('=');
      map[a.substring(2, eq)] = a.substring(eq + 1);
      continue;
    }
    if (a.startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('-')) {
      map[a.substring(2)] = args[++i];
      continue;
    }
    if (a.startsWith('--')) {
      map[a.substring(2)] = '1';
      continue;
    }
    rest.add(a);
  }
  return _Flags(map, rest, json);
}

String _commandHelp(String cmd) {
  switch (cmd) {
    case 'create':
      return '''
shear create — Closure: new wallet

  --store PATH
  --password-file PATH   required (or SHEAR_WALLET_PASSWORD)
  --confirm-file PATH    optional; must match password

Writes a sealed session.json. Prints she1 and Copy dest.
''';
    case 'restore':
      return '''
shear restore — Closure: import shewall.bin

  --file PATH            shewall.bin
  --store PATH
  --password-file PATH   password of that shewall
''';
    case 'unlock':
      return '''
shear unlock — open a sealed session

  --store PATH
  --password-file PATH
''';
    case 'status':
      return 'shear status — Continuum: she1, dest, spendable, pending, height, magic\n';
    case 'id':
      return 'shear id — print she1 (Copy ID). Never a dest. Never mine to this alone.\n';
    case 'dest':
      return 'shear dest — print the stable mining mailbox (homeDest / Copy dest). ShearK login is ssa1.worker\n';
    case 'balance':
      return 'shear balance — spendable and pending SHE (confidential amounts)\n';
    case 'receive':
      return 'shear receive — mint a fresh stealth ssa1 (not the mining mailbox)\n';
    case 'send':
      return '''
shear send — Flow

  --to she1…|ssa1…       required
  --amount SHE           required
  --memo TEXT            optional
  --store PATH
  --password-file PATH
  --rpc URL
  --dry-run              build locally, do not post

Fee is space (weight), not a percent of what you send.
Signs with the spend key (same as GUI Send).
''';
    case 'sign':
      return '''
shear sign — sign with the spend key (never prints the key)

  shear sign flow --to she1…|ssa1… --amount SHE [--memo TEXT]
      Same as `shear send`: ADMITv2 + BP+ Flow, spend-sig on the compact body.
  shear sign pull --dest ssa1… --amount SHE
      EIP-712 pool-withdraw signature, then post (miner pull).
  shear sign vote --choice increase|decrease|hold
      Signed Reserve vote (kind=vote).
  shear sign lock --amount SHE
      Signed Reserve lock.

  --dry-run   sign locally, do not post
  --password-file PATH
''';
    case 'vote':
      return '''
shear vote --choice increase|decrease|hold

Signed Reserve vote. Alias of `shear reserve vote` / `shear sign vote`.
One vote per portal per epoch. GUI: Vortex → The Reserve → Cast vote.
''';
    case 'rewards':
      return '''
shear rewards — staked + accrued Reserve rewards

  shear rewards                 print staked, idle, accrued, projected, claimable
  shear rewards --claim         settle principal + extra-minted interest onto Copy dest
  shear reserve claim           same as --claim
  shear reserve withdraw        same settlement (GUI unlock)

400-day floor APR, oracle default 264 bps. Extra mint is Reserve-only.
''';
    case 'history':
      return 'shear history — Shearview rows (id, kind/type, height, confirmed)\n';
    case 'tx':
      return 'shear tx <id> — Resistance CTF transcript for one Shearview row\n';
    case 'backup':
      return 'shear backup --out shewall.bin — Closure export (encrypted with session password)\n';
    case 'password':
      return 'shear password — set or change the session password (--password-file, --confirm-file)\n';
    case 'reset':
      return 'shear reset — drop a foreign-book shewall and mint a new identity on $kBookMagic\n';
    case 'sync':
      return 'shear sync — pull headers + compact blocks from --rpc (default 127.0.0.1:18332)\n';
    case 'reserve':
      return '''
shear reserve — Vortex / The Reserve

  shear reserve status
  shear reserve lock --amount SHE     signed lock
  shear reserve vote --choice increase|decrease|hold
  shear reserve withdraw
''';
    case 'vortex':
      return '''
shear vortex — vort1 create, register, use

  shear vortex list
  shear vortex show --id PROGRAM
  shear vortex create --id PROGRAM --origin https://host/path --source-file FILE [--name LABEL]
      Mint a vort1. key (origin URL + bundle hash). Same as GUI paste-and-create.
      Third-party mint is refused by consensus; this only issues the pin.
  shear vortex register --vort1 'vort1.…' [--source-file FILE]
      Fetch origin (or use --source-file), verify bundle, add to this wallet.
  shear vortex call --id PROGRAM --kind send|lock|vote --to DEST --amount SHE
      Sign a Flow that names that vortice programId (utilise a registered vortice).
  shear vortex remove --id PROGRAM
      Drop from this wallet only. Origin stays. The Reserve cannot be removed.
''';
    case 'version':
      return 'shear version — pin $kCliVersion, magic $kBookMagic, platform matrix\n';
    default:
      return kCliHelp;
  }
}

int _version(IOSink out, bool json) {
  final body = {
    'ok': true,
    'pin': kCliVersion,
    'magic': kBookMagic,
    'admit': 'ADMITv2',
    'gui': true,
    'cli': true,
    'platforms': ['macos', 'windows', 'linux', 'archlinux', 'android'],
    'executables': {
      'macos': ['Shear.app / shear-wallet-<pin>-macos.dmg', 'shear (CLI)'],
      'windows': ['shear_wallet.exe', 'shear.exe (CLI)'],
      'linux': ['shear_wallet', 'shear (CLI)'],
      'archlinux': ['PKGBUILD + shear_wallet', 'shear (CLI)'],
      'android': ['shear-wallet-<pin>-android.apk'],
    },
    'mainnet': false,
  };
  out.writeln(json ? jsonEncode(body) : 'Shear wallet $kCliVersion  magic $kBookMagic  ADMITv2  GUI+CLI');
  return 0;
}

String _readPassword(_Flags flags, Map<String, String> env) {
  final path = flags['password-file'];
  if (path != null && path.isNotEmpty) {
    var s = File(path).readAsStringSync();
    if (s.endsWith('\n')) s = s.substring(0, s.length - 1);
    if (s.endsWith('\r')) s = s.substring(0, s.length - 1);
    return s;
  }
  final envPw = env['SHEAR_WALLET_PASSWORD'];
  if (envPw != null && envPw.isNotEmpty) return envPw;
  throw const FormatException('need --password-file or SHEAR_WALLET_PASSWORD');
}

ShearSession _session(_Flags flags) {
  final path = flags['store'];
  if (path != null && path.isNotEmpty) return ShearSession(store: File(path));
  return ShearSession();
}

Future<ShearIdentity> _needId(ShearSession session, _Flags flags, Map<String, String> env) async {
  await session.loadOrCreate();
  if (session.identity != null && session.sealed && session.password != null) {
    return session.identity!;
  }
  if (session.needsUnlock || (session.sealed && session.identity == null)) {
    return session.unlock(_readPassword(flags, env));
  }
  if (session.identity != null) return session.identity!;
  throw const FormatException('no wallet — run shear create');
}

void _bindLedger(ShearLedger ledger, ShearIdentity id, [ShearSession? session]) {
  ledger.bindIdentity(id);
  if (session == null) return;
  if (session.rememberedDests.isEmpty && session.rememberedTxs.isEmpty) return;
  applyUserArchive(ledger, {
    'dests': session.rememberedDests,
    'destCount': session.rememberedDestCount,
    'destIndex': session.rememberedDestIndex,
    'sealedHeight': session.rememberedSealedHeight,
    if (session.rememberedChainGenesis != null && session.rememberedChainGenesis!.isNotEmpty)
      'chainGenesis': session.rememberedChainGenesis,
    'txs': session.rememberedTxs,
  });
}

String _voteChoice(String raw) {
  switch (raw.trim().toLowerCase()) {
    case 'increase':
    case 'up':
    case 'increase bonus':
      return kVoteIncrease;
    case 'decrease':
    case 'down':
    case 'decrease bonus':
      return kVoteDecrease;
    case 'hold':
    case 'leave':
    case 'leave bonus as-is':
      return kVoteHold;
    default:
      throw FormatException('vote choice must be increase|decrease|hold (got $raw)');
  }
}

String _rpc(_Flags flags, Map<String, String> env) =>
    flags['rpc'] ?? env['SHEAR_RPC'] ?? kWalletDefaultSeed;

Future<int> _create(IOSink out, IOSink err, _Flags flags, Map<String, String> env) async {
  final session = _session(flags);
  await session.loadOrCreate();
  final pw = _readPassword(flags, env);
  String? confirm;
  final cpath = flags['confirm-file'];
  if (cpath != null) {
    confirm = File(cpath).readAsStringSync().replaceAll(RegExp(r'[\r\n]+$'), '');
  }
  await session.setPassword(pw, confirm: confirm);
  final id = session.identity!;
  final ledger = ShearLedger();
  _bindLedger(ledger, id, session);
  final dest = ledger.currentDest(id.address, paymentCode: id.paymentCode);
  final body = {
    'ok': true,
    'magic': kBookMagic,
    'she1': id.paymentCode,
    'dest': dest,
    'store': session.store.path,
  };
  out.writeln(flags.json ? jsonEncode(body) : 'created  she1=${id.paymentCode}\ndest  $dest\nstore ${session.store.path}');
  return 0;
}

Future<int> _restore(IOSink out, IOSink err, _Flags flags, Map<String, String> env) async {
  final file = flags['file'] ?? flags.rest.cast<String?>().firstWhere((_) => true, orElse: () => null);
  if (file == null || file.isEmpty) throw const FormatException('restore needs --file shewall.bin');
  final session = _session(flags);
  final ledger = ShearLedger();
  final reserve = ShearReserve();
  final pw = _readPassword(flags, env);
  final id = await importEncryptedShewall(
    src: File(file),
    password: pw,
    ledger: ledger,
    reserve: reserve,
    onVortices: (v) => session.deployedVortices = v,
  );
  session.identity = id;
  session.rememberedDests = ledger.exportedDests();
  session.rememberedTxs = [
    for (final t in ledger.shearviewTxs(id.address)) t.toJson(),
  ];
  if (session.rememberedReserve == null && reserve.portals.isNotEmpty) {
    final dest = ledger.currentDest(id.address, paymentCode: id.paymentCode);
    session.rememberedReserve = _portalSnap(reserve, dest, DateTime.now().millisecondsSinceEpoch);
  }
  await session.setPassword(pw, confirm: pw);
  out.writeln(flags.json
      ? jsonEncode({'ok': true, 'she1': id.paymentCode, 'store': session.store.path, 'file': file})
      : 'restored  she1=${id.paymentCode}\nstore ${session.store.path}');
  return 0;
}

Future<int> _unlock(IOSink out, IOSink err, _Flags flags, Map<String, String> env) async {
  final session = _session(flags);
  await session.loadOrCreate();
  final id = await session.unlock(_readPassword(flags, env));
  out.writeln(flags.json ? jsonEncode({'ok': true, 'she1': id.paymentCode}) : 'unlocked  she1=${id.paymentCode}');
  return 0;
}

Future<int> _status(IOSink out, IOSink err, _Flags flags, Map<String, String> env) async {
  final session = _session(flags);
  final id = await _needId(session, flags, env);
  final ledger = ShearLedger();
  _bindLedger(ledger, id, session);
  final dest = ledger.currentDest(id.address, paymentCode: id.paymentCode);
  final spend = ledger.spendableOwned(id.address, paymentCode: id.paymentCode);
  final pend = ledger.pending(id.address, paymentCode: id.paymentCode);
  final body = {
    'ok': true,
    'pin': kCliVersion,
    'magic': kBookMagic,
    'she1': id.paymentCode,
    'dest': dest,
    'spendable': formatShe(spend),
    'pending': formatShe(pend),
    'height': ledger.tipHeight,
    'store': session.store.path,
    'rpc': _rpc(flags, env),
  };
  if (flags.json) {
    out.writeln(jsonEncode(body));
  } else {
    out.writeln('Shear $kCliVersion  $kBookMagic');
    out.writeln('she1       ${id.paymentCode}');
    out.writeln('dest       $dest');
    out.writeln('spendable  ${formatShe(spend)} SHE');
    out.writeln('pending    ${formatShe(pend)} SHE');
    out.writeln('height     ${ledger.tipHeight}');
  }
  return 0;
}

Future<int> _id(IOSink out, _Flags flags, Map<String, String> env) async {
  final session = _session(flags);
  final id = await _needId(session, flags, env);
  out.writeln(flags.json ? jsonEncode({'ok': true, 'she1': id.paymentCode}) : id.paymentCode);
  return 0;
}

Future<int> _dest(IOSink out, _Flags flags, Map<String, String> env) async {
  final session = _session(flags);
  final id = await _needId(session, flags, env);
  final ledger = ShearLedger();
  _bindLedger(ledger, id, session);
  final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
  out.writeln(flags.json ? jsonEncode({'ok': true, 'dest': dest, 'login': '$dest.worker'}) : dest);
  return 0;
}

Future<int> _balance(IOSink out, _Flags flags, Map<String, String> env) async {
  final session = _session(flags);
  final id = await _needId(session, flags, env);
  final ledger = ShearLedger();
  _bindLedger(ledger, id, session);
  final spend = ledger.spendableOwned(id.address, paymentCode: id.paymentCode);
  final pend = ledger.pending(id.address, paymentCode: id.paymentCode);
  if (flags.json) {
    out.writeln(jsonEncode({'ok': true, 'spendable': formatShe(spend), 'pending': formatShe(pend)}));
  } else {
    out.writeln('spendable  ${formatShe(spend)} SHE');
    out.writeln('pending    ${formatShe(pend)} SHE');
  }
  return 0;
}

Future<int> _receive(IOSink out, _Flags flags, Map<String, String> env) async {
  final session = _session(flags);
  final id = await _needId(session, flags, env);
  final ledger = ShearLedger();
  _bindLedger(ledger, id, session);
  final dest = ledger.newDest(id.address, paymentCode: id.paymentCode);
  session.rememberedDests = [...session.rememberedDests, dest];
  await session.persist();
  out.writeln(flags.json ? jsonEncode({'ok': true, 'dest': dest}) : dest);
  return 0;
}

Future<int> _send(IOSink out, IOSink err, _Flags flags, Map<String, String> env) async {
  final to = flags['to'];
  final amtRaw = flags['amount'];
  if (to == null || to.isEmpty) throw const FormatException('send needs --to she1… or ssa1…');
  if (amtRaw == null) throw const FormatException('send needs --amount');
  final amount = double.parse(amtRaw);
  final session = _session(flags);
  final id = await _needId(session, flags, env);
  final dry = flags['dry-run'] == '1';
  final ledger = ShearLedger(
    pool: dry ? null : ShearPoolClient(userUrl: _rpc(flags, env)),
  );
  _bindLedger(ledger, id, session);
  final from = ledger.currentDest(id.address, paymentCode: id.paymentCode);
  final tx = await ledger.send(
    from: from,
    to: to,
    amount: amount,
    memo: flags['memo'],
    local: dry,
    restFrame: id.address,
    paymentCode: id.paymentCode,
    spendSeed: hexToBytes(id.seedHex),
  );
  final body = {
    'ok': true,
    'id': tx.id,
    'kind': tx.kind,
    'from': tx.from,
    'to': tx.to,
    'dryRun': dry,
    'levy': 'weight (space, not a percent of what you send)',
  };
  out.writeln(flags.json ? jsonEncode(body) : 'sent  id=${tx.id}  kind=${tx.kind}');
  return 0;
}

Future<int> _history(IOSink out, _Flags flags, Map<String, String> env) async {
  final session = _session(flags);
  final id = await _needId(session, flags, env);
  final ledger = ShearLedger();
  _bindLedger(ledger, id, session);
  final q = flags['query'];
  final rows = (q == null || q.isEmpty)
      ? ledger.shearviewTxs(id.address)
      : ledger.shearviewSearch(id.address, q);
  if (flags.json) {
    out.writeln(jsonEncode({
      'ok': true,
      'txs': [
        for (final t in rows)
          {'id': t.id, 'type': t.kind, 'height': t.height, 'confirmed': t.confirmed},
      ],
    }));
    return 0;
  }
  if (rows.isEmpty) {
    out.writeln('(no Shearview rows yet)');
    return 0;
  }
  out.writeln('id\ttype\theight\tconfirmed');
  for (final t in rows) {
    out.writeln('${t.id}\t${t.kind}\t${t.height ?? '-'}\t${t.confirmed}');
  }
  return 0;
}

Future<int> _tx(IOSink out, IOSink err, _Flags flags, Map<String, String> env) async {
  final idn = flags.rest.isNotEmpty ? flags.rest.first : flags['id'];
  if (idn == null || idn.isEmpty) throw const FormatException('tx needs an id');
  final session = _session(flags);
  final ident = await _needId(session, flags, env);
  final ledger = ShearLedger();
  _bindLedger(ledger, ident, session);
  final rows = ledger.shearviewTxs(ident.address);
  final hit = rows.where((t) => t.id == idn).toList();
  if (hit.isEmpty) {
    err.writeln('unknown tx $idn');
    return 1;
  }
  final t = hit.first;
  final spend = ledger.spendableOwned(ident.address, paymentCode: ident.paymentCode);
  out.writeln(_transcript(ident, t, spend));
  return 0;
}

String _transcript(ShearIdentity identity, ShearTx tx, double spendableAfter) {
  final view = identity.viewKey;
  final height = tx.height ?? 1;
  final destAtHeight = destForLogin(identity.address, height: height, viewKey: view);
  final buf = StringBuffer();
  buf.writeln('======== SHEAR CTF  tx=${tx.id}  ========');
  buf.writeln('kind        ${tx.kind}');
  buf.writeln('height      $height');
  buf.writeln('from        ${tx.from}');
  buf.writeln('to          ${tx.to}');
  buf.writeln('she1        ${identity.paymentCode}');
  buf.writeln('destForLogin(h=$height)  ${destAtHeight ?? '(none)'}');
  buf.writeln('spendable   ${formatShe(spendableAfter)} SHE');
  buf.writeln('========');
  return buf.toString();
}

Future<int> _backup(IOSink out, IOSink err, _Flags flags, Map<String, String> env) async {
  final destPath = flags['out'] ?? 'shewall.bin';
  final session = _session(flags);
  final id = await _needId(session, flags, env);
  final ledger = ShearLedger();
  _bindLedger(ledger, id, session);
  final pw = _readPassword(flags, env);
  final dest = File(destPath);
  await exportEncryptedShewall(
    identity: id,
    ledger: ledger,
    password: pw,
    dest: dest,
    reserveSnapshot: session.rememberedReserve,
    vortices: session.deployedVortices,
  );
  out.writeln(flags.json ? jsonEncode({'ok': true, 'file': dest.path}) : 'wrote ${dest.path}');
  return 0;
}

Future<int> _password(IOSink out, IOSink err, _Flags flags, Map<String, String> env) async {
  final session = _session(flags);
  await session.loadOrCreate();
  final pw = _readPassword(flags, env);
  String? confirm;
  final cpath = flags['confirm-file'];
  if (cpath != null) {
    confirm = File(cpath).readAsStringSync().replaceAll(RegExp(r'[\r\n]+$'), '');
  }
  await session.setPassword(pw, confirm: confirm);
  out.writeln(flags.json ? jsonEncode({'ok': true}) : 'password set');
  return 0;
}

Future<int> _reset(IOSink out, IOSink err, _Flags flags, Map<String, String> env) async {
  final session = _session(flags);
  await session.loadOrCreate();
  String? pw;
  try {
    pw = _readPassword(flags, env);
  } catch (_) {}
  final id = await session.resetForNewBook(password: pw);
  out.writeln(flags.json
      ? jsonEncode({'ok': true, 'she1': id.paymentCode, 'magic': kBookMagic})
      : 'reset  she1=${id.paymentCode}  magic=$kBookMagic');
  return 0;
}

Future<int> _sync(IOSink out, IOSink err, _Flags flags, Map<String, String> env) async {
  final rpc = _rpc(flags, env);
  final session = _session(flags);
  final id = await _needId(session, flags, env);
  final client = ShearPoolClient(userUrl: rpc);
  final ledger = ShearLedger(pool: client);
  _bindLedger(ledger, id, session);
  try {
    await ledger.syncHistory(id.address);
  } catch (e) {
    err.writeln('sync failed ($rpc): $e');
    return 1;
  }
  out.writeln(flags.json
      ? jsonEncode({'ok': true, 'rpc': rpc, 'height': ledger.tipHeight, 'live': client.nodeLive})
      : 'sync  rpc=$rpc  height=${ledger.tipHeight}  live=${client.nodeLive}');
  return 0;
}

Future<int> _reserve(IOSink out, IOSink err, _Flags flags, Map<String, String> env) async {
  final sub = flags.rest.isNotEmpty ? flags.rest.first : 'status';
  if (!kCliReserveSubs.contains(sub)) {
    err.writeln('reserve subcommand: ${kCliReserveSubs.join(' | ')}');
    return 2;
  }
  final session = _session(flags);
  final id = await _needId(session, flags, env);
  final ledger = ShearLedger();
  _bindLedger(ledger, id, session);
  final reserve = ShearReserve();
  if (session.rememberedReserve != null) {
    reserve.applyLocalSnapshot(session.rememberedReserve!);
  }
  final dest = ledger.currentDest(id.address, paymentCode: id.paymentCode);
  final now = DateTime.now().millisecondsSinceEpoch;
  switch (sub) {
    case 'status':
      out.writeln(flags.json ? reserve.publicJson(now) : reserve.publicJson(now));
      return 0;
    case 'lock':
      final amt = flags['amount'];
      if (amt == null) throw const FormatException('reserve lock needs --amount');
      final she = double.parse(amt);
      final from = dest;
      final tx = await ledger.send(
        from: from,
        to: dest,
        amount: she,
        kind: 'lock',
        programId: 'shear-reserve-v1',
        local: flags['dry-run'] == '1',
        restFrame: id.address,
        paymentCode: id.paymentCode,
        spendSeed: hexToBytes(id.seedHex),
      );
      reserve.deposit(dest: dest, she: she, nowMs: now);
      session.rememberedReserve = _portalSnap(reserve, dest, now);
      await session.persist();
      out.writeln(flags.json ? jsonEncode({'ok': true, 'id': tx.id, 'kind': 'lock'}) : 'lock  id=${tx.id}');
      return 0;
    case 'vote':
      final choiceRaw = flags['choice'];
      if (choiceRaw == null) throw const FormatException('reserve vote needs --choice increase|decrease|hold');
      final choice = _voteChoice(choiceRaw);
      final errVote = reserve.vote(dest: dest, choice: choice, nowMs: now);
      if (errVote != null) {
        err.writeln(errVote);
        return 1;
      }
      await ledger.send(
        from: dest,
        to: dest,
        amount: 0,
        kind: 'vote',
        programId: 'shear-reserve-v1',
        choice: choice,
        local: flags['dry-run'] == '1',
        restFrame: id.address,
        paymentCode: id.paymentCode,
        spendSeed: hexToBytes(id.seedHex),
      );
      session.rememberedReserve = _portalSnap(reserve, dest, now);
      await session.persist();
      out.writeln(flags.json ? jsonEncode({'ok': true, 'vote': choice}) : 'vote  $choice');
      return 0;
    case 'withdraw':
    case 'claim':
      return _claimRewards(out, err, session, id, ledger, reserve, dest, now, flags);
    case 'rewards':
      return _printRewards(out, reserve, dest, now, flags);
  }
  return 2;
}

Map<String, dynamic> _portalSnap(ShearReserve reserve, String dest, int now) {
  final r = reserve.rewards(dest, now);
  final p = reserve.portal(dest);
  return {
    'dest': dest,
    'staked': r.staked,
    'idle': r.idle,
    'accrued': r.accrued,
    'claimable': p.claimableRewards,
    'joined': p.joined,
    'vote': p.vote,
    'voteEpoch': p.voteEpoch,
    'epochBps': reserve.epochBps,
    'oracleBps': reserve.oracleBps,
    'epochStartMs': reserve.epochStartMs,
    'currentEpoch': reserve.currentEpoch,
    'bonusEnacted': reserve.bonusEnacted,
    'liveHashBonusNanos': reserve.liveHashBonusNanos,
    'totalLockedNanos': reserve.totalLockedNanos,
  };
}

Map<String, dynamic> _rewardsBody(ShearReserve reserve, String dest, int now) {
  final r = reserve.rewards(dest, now);
  final p = reserve.portal(dest);
  return {
    'ok': true,
    'dest': dest,
    'staked': formatShe(r.staked / kUnitsPerShe),
    'idle': formatShe(r.idle / kUnitsPerShe),
    'accrued': formatShe(r.accrued / kUnitsPerShe),
    'projected': formatShe(r.projected / kUnitsPerShe),
    'claimable': formatShe(p.claimableRewards / kUnitsPerShe),
    'bps': r.oracleBps,
    'elapsedMs': r.elapsedMs,
    'canVote': p.canVote,
  };
}

int _printRewards(IOSink out, ShearReserve reserve, String dest, int now, _Flags flags) {
  final body = _rewardsBody(reserve, dest, now);
  if (flags.json) {
    out.writeln(jsonEncode(body));
  } else {
    out.writeln('staked     ${body['staked']} SHE');
    out.writeln('idle       ${body['idle']} SHE');
    out.writeln('accrued    ${body['accrued']} SHE  (in-epoch)');
    out.writeln('projected  ${body['projected']} SHE  (full 400-day epoch)');
    out.writeln('claimable  ${body['claimable']} SHE');
    out.writeln('bps        ${body['bps']}');
  }
  return 0;
}

Future<int> _claimRewards(
  IOSink out,
  IOSink err,
  ShearSession session,
  ShearIdentity id,
  ShearLedger ledger,
  ShearReserve reserve,
  String dest,
  int now,
  _Flags flags,
) async {
  final payout = flags['payout'] ?? dest;
  final got = reserve.withdrawTo(ledger, dest: dest, payout: payout, nowMs: now);
  if (got == null) {
    err.writeln('nothing to claim — no staked principal or accrued rewards');
    return 1;
  }
  session.rememberedReserve = _portalSnap(reserve, dest, now);
  await session.persist();
  final she = (got['payout'] ?? 0) / kUnitsPerShe;
  out.writeln(flags.json
      ? jsonEncode({'ok': true, 'payoutDest': payout, ...got, 'payoutShe': formatShe(she)})
      : 'claimed  principal=${got['principal']}  interest=${got['interest']}  onto $payout');
  return 0;
}

Future<int> _rewards(IOSink out, IOSink err, _Flags flags, Map<String, String> env) async {
  final session = _session(flags);
  final id = await _needId(session, flags, env);
  final ledger = ShearLedger();
  _bindLedger(ledger, id, session);
  final reserve = ShearReserve();
  if (session.rememberedReserve != null) reserve.applyLocalSnapshot(session.rememberedReserve!);
  final dest = ledger.currentDest(id.address, paymentCode: id.paymentCode);
  final now = DateTime.now().millisecondsSinceEpoch;
  if (flags['claim'] == '1' || flags.rest.contains('claim')) {
    return _claimRewards(out, err, session, id, ledger, reserve, dest, now, flags);
  }
  return _printRewards(out, reserve, dest, now, flags);
}

Future<int> _vote(IOSink out, IOSink err, _Flags flags, Map<String, String> env) async {
  flags.rest.insert(0, 'vote');
  return _reserve(out, err, flags, env);
}

Future<int> _sign(IOSink out, IOSink err, _Flags flags, Map<String, String> env) async {
  final sub = flags.rest.isNotEmpty ? flags.rest.first : 'flow';
  if (!kCliSignSubs.contains(sub)) {
    err.writeln('sign subcommand: ${kCliSignSubs.join(' | ')}');
    return 2;
  }
  switch (sub) {
    case 'flow':
      return _send(out, err, flags, env);
    case 'pull':
      return _signPull(out, err, flags, env);
    case 'vote':
      flags.rest.insert(0, 'vote');
      return _reserve(out, err, flags, env);
    case 'lock':
      flags.rest.insert(0, 'lock');
      return _reserve(out, err, flags, env);
  }
  return 2;
}

Future<int> _signPull(IOSink out, IOSink err, _Flags flags, Map<String, String> env) async {
  final session = _session(flags);
  final id = await _needId(session, flags, env);
  final dest = flags['dest'];
  final amtRaw = flags['amount'];
  if (dest == null || dest.isEmpty) throw const FormatException('sign pull needs --dest ssa1…');
  if (amtRaw == null) throw const FormatException('sign pull needs --amount');
  final amount = double.parse(amtRaw);
  final dry = flags['dry-run'] == '1';
  final seed = hexToBytes(id.seedHex);
  final nanos = (amount * kUnitsPerShe).round();
  final sig = signPoolWithdraw(seed: seed, login: id.paymentCode, dest: dest, nanos: nanos);
  if (dry) {
    out.writeln(flags.json
        ? jsonEncode({'ok': true, 'signed': true, 'kind': 'pool-withdraw', 'dest': dest, 'nanos': nanos, 'sig': sig})
        : 'signed pull  dest=$dest  nanos=$nanos\nsig $sig');
    return 0;
  }
  final ledger = ShearLedger(pool: ShearPoolClient(userUrl: _rpc(flags, env)));
  _bindLedger(ledger, id, session);
  final tx = await ledger.signPendingPull(
    login: id.paymentCode,
    dest: dest,
    nanos: nanos,
    seed: seed,
  );
  out.writeln(flags.json ? jsonEncode({'ok': true, 'id': tx.id, 'kind': tx.kind}) : 'signed pull  id=${tx.id}');
  return 0;
}

Future<int> _vortex(IOSink out, IOSink err, _Flags flags, Map<String, String> env) async {
  final sub = flags.rest.isNotEmpty ? flags.rest.first : 'list';
  if (!kCliVortexSubs.contains(sub)) {
    err.writeln('vortex subcommand: ${kCliVortexSubs.join(' | ')}');
    return 2;
  }
  final session = _session(flags);
  await _needId(session, flags, env);
  var list = session.deployedVortices.isEmpty ? <Vortice>[reserveVortice] : session.deployedVortices;
  switch (sub) {
    case 'list':
      if (flags.json) {
        out.writeln(jsonEncode({'ok': true, 'vortices': list.map((v) => v.toJson()).toList()}));
      } else {
        for (final v in list) {
          out.writeln('${v.id}\t${v.origin ?? ''}');
        }
      }
      return 0;
    case 'show':
      final idn = flags['id'];
      if (idn == null) throw const FormatException('vortex show needs --id');
      final hit = list.where((v) => v.id == idn).toList();
      if (hit.isEmpty) {
        err.writeln('no vortice $idn');
        return 1;
      }
      out.writeln(flags.json ? jsonEncode(hit.first.toJson()) : '${hit.first.id}\t${hit.first.name}\t${hit.first.origin ?? ''}');
      return 0;
    case 'create':
      final pid = flags['id'];
      final origin = flags['origin'];
      final srcPath = flags['source-file'];
      if (pid == null || origin == null || srcPath == null) {
        throw const FormatException('vortex create needs --id --origin --source-file');
      }
      final source = File(srcPath).readAsStringSync();
      final key = mintVorticeDeployKey(programId: pid, origin: origin, source: source, name: flags['name']);
      if (key == null) {
        err.writeln('vort1 create failed (bad id/origin, or reserved program)');
        return 1;
      }
      out.writeln(flags.json ? jsonEncode({'ok': true, 'vort1': key, 'id': pid}) : key);
      return 0;
    case 'register':
      final key = flags['vort1'] ?? flags['key'];
      if (key == null || key.isEmpty) throw const FormatException('vortex register needs --vort1');
      final srcPath = flags['source-file'];
      final v = await downloadVorticeFromOrigin(key, source: srcPath != null ? File(srcPath).readAsStringSync() : null);
      if (v == null) {
        err.writeln('vort1 fetch failed');
        return 1;
      }
      list = deployVortice(list, v);
      session.deployedVortices = list;
      await session.persist();
      out.writeln(flags.json ? jsonEncode({'ok': true, 'id': v.id}) : 'registered  ${v.id}');
      return 0;
    case 'call':
      final pid = flags['id'];
      if (pid == null) throw const FormatException('vortex call needs --id');
      if (!list.any((v) => v.id == pid) && pid != reserveProgram) {
        err.writeln('vortice $pid is not in this wallet — register it first');
        return 1;
      }
      flags.map['kind'] = flags['kind'] ?? 'send';
      if (pid == reserveProgram || flags['kind'] == 'lock' || flags['kind'] == 'vote') {
        flags.rest.insert(0, flags['kind'] == 'vote' ? 'vote' : (flags['kind'] == 'lock' ? 'lock' : 'status'));
        return _reserve(out, err, flags, env);
      }
      return _send(out, err, flags, env);
    case 'remove':
      final idn = flags['id'];
      if (idn == null) throw const FormatException('vortex remove needs --id');
      list = removeVortice(list, idn);
      session.deployedVortices = list;
      await session.persist();
      out.writeln(flags.json ? jsonEncode({'ok': true}) : 'removed  $idn');
      return 0;
  }
  return 2;
}
