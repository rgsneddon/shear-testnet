import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:path/path.dart' as p;

import 'shear_closure.dart';
import 'shear_identity.dart';
import 'shear_ledger.dart';
import 'shear_lock.dart';
import 'shear_reserve.dart';
import 'shear_vortex.dart';
import 'shear_shewall.dart';
export 'shear_shewall.dart' show shewallName;

const kMinWalletPasswordLen = 8;

/// Stamp of the isolate that last sealed and wrote shewall. Differs from the
/// UI isolate when [ShearSession.persist] ran off-UI.
String debugSessionPersistStamp = '';

/// Stamp of the isolate that last opened the session envelope.
String debugSessionUnlockStamp = '';

/// True while archive rows are being parsed off the UI isolate.
bool debugArchiveHydrateScheduled = false;

/// Stamp of the isolate that last parsed an archive. Differs from the UI isolate.
String debugArchiveHydrateStamp = '';

/// Parse untrusted archive rows off the UI isolate. Nanos and coinbase defaults
/// are resolved here. The caller only copies the normalized rows onto the ledger.
Map<String, dynamic> hydrateArchiveEnvelope(List<dynamic> rows) {
  final txs = <Map<String, dynamic>>[];
  for (final row in rows) {
    if (row is! Map) continue;
    txs.add(ShearTx.fromJson(Map<String, dynamic>.from(row)).toJson());
  }
  return <String, dynamic>{
    'txs': txs,
    'stamp': identityHashCode(Isolate.current).toString(),
  };
}

List<ShearTx> _txsFromHydrated(List<dynamic> rows) {
  return <ShearTx>[
    for (final row in rows)
      if (row is Map)
        ShearTx(
          id: row['id']?.toString() ?? '',
          from: row['from']?.toString() ?? '',
          to: row['to']?.toString() ?? '',
          amount: (row['amount'] as num?)?.toDouble() ?? 0,
          kind: row['kind']?.toString() ?? '',
          height: (row['height'] as num?)?.toInt(),
          confirmed: row['confirmed'] is bool ? row['confirmed'] as bool : true,
          memo: row['memo'] == true,
          memoPlain: row['memoPlain']?.toString(),
          memoCt: row['memoCt'] is Map ? Map<String, dynamic>.from(row['memoCt'] as Map) : null,
          rounds: (row['rounds'] as num?)?.toInt(),
          hashAmount: (row['hashAmount'] as num?)?.toDouble(),
          threads: (row['threads'] as num?)?.toInt(),
          pot: (row['pot'] as num?)?.toDouble(),
          change: row['change']?.toString(),
          atMs: (row['atMs'] as num?)?.toInt(),
        ),
  ];
}

Future<void> applyUserArchiveOffUi(ShearLedger ledger, Map<String, dynamic> archive) async {
  final rows = archive['txs'];
  debugArchiveHydrateScheduled = true;
  try {
    final opened = await Isolate.run(
      () => hydrateArchiveEnvelope(rows is List ? rows : const <dynamic>[]),
    );
    debugArchiveHydrateStamp = opened['stamp'] as String;
    final hydrated = opened['txs'];
    final dests = ((archive['dests'] as List?) ?? const []).map((e) => e.toString()).toList();
    ledger.replaceFromBackup(
      address: dests.isNotEmpty ? dests.first : '',
      spendable: 0,
      pending: 0,
      txs: _txsFromHydrated(hydrated is List ? hydrated : const <dynamic>[]),
      destCount: (archive['destCount'] as num?)?.toInt(),
      destIndex: (archive['destIndex'] as num?)?.toInt(),
    );
    ledger.restoreDests(dests);
    final g = archive['chainGenesis']?.toString() ?? '';
    ledger.restoreSealedTip((archive['sealedHeight'] as num?)?.toInt() ?? 0, genesis: g);
  } finally {
    debugArchiveHydrateScheduled = false;
  }
}

/// Argon open of a session envelope. Production calls this from [Isolate.run].
Future<Map<String, dynamic>> openSessionEnvelope(
  Map<String, dynamic> env,
  String password,
) async {
  final plain = await ShearLock.open(env, password);
  return <String, dynamic>{
    'plain': plain,
    'stamp': identityHashCode(Isolate.current).toString(),
  };
}

/// Argon seal of a session envelope. Does not touch the file. Production calls
/// this from [Isolate.run]; [ShearSession.persist] writes only if this call is
/// still the latest, so a slow seal cannot put an older biometrics flag back.
Future<Map<String, dynamic>> sealSessionEnvelope(
  Map<String, dynamic> plain,
  String password,
  bool bio,
) async {
  final env = Map<String, dynamic>.from(await ShearLock.seal(plain, password));
  env['biometricsEnabled'] = bio;
  return <String, dynamic>{
    'env': env,
    'stamp': identityHashCode(Isolate.current).toString(),
  };
}

void writeSessionFile(String path, Map<String, dynamic> env) {
  final file = File(path);
  file.parent.createSync(recursive: true);
  file.writeAsStringSync(jsonEncode(env), flush: true);
  if (!Platform.isWindows) {
    try {
      Process.runSync('chmod', ['600', path]);
    } catch (_) {}
  }
}

/// Argon seal plus the shewall write. Prefer [ShearSession.persist], which
/// drops a stale seal instead of letting it overwrite a newer one.
Future<Map<String, dynamic>> sealAndWriteSession(
  String path,
  Map<String, dynamic> plain,
  String password,
  bool bio,
) async {
  final sealed = await sealSessionEnvelope(plain, password, bio);
  writeSessionFile(path, Map<String, dynamic>.from(sealed['env'] as Map));
  return sealed;
}

String? walletPasswordError(String password, {String? confirm}) {
  final pw = password;
  if (pw.isEmpty) return 'empty';
  if (pw.length < kMinWalletPasswordLen) return 'too_short';
  if (confirm != null && pw != confirm) return 'mismatch';
  return null;
}

class ShearSession {
  ShearSession({File? store}) : store = store ?? defaultStore() {
    _peek();
  }

  void _peek() {
    if (!store.existsSync()) return;
    try {
      final j = jsonDecode(store.readAsStringSync()) as Map<String, dynamic>;
      if (j['kind'] == ShearLock.kind) {
        sealed = true;
        _envelope = j;
        biometricsEnabled = j['biometricsEnabled'] == true;
      }
    } catch (_) {}
  }

  final File store;
  ShearIdentity? identity;
  bool biometricsEnabled = false;
  /// Committed Closure send path. Not written as continuumSendPath.
  /// A new session opens on Connect bare. A stored Shear VPN tunnel string opens Connect bare.
  String closureSendMode = kClosureModeBare;
  bool darkMode = false;
  List<String> rememberedDests = const [];
  List<Map<String, dynamic>> rememberedTxs = const [];
  int rememberedDestCount = 1;
  int rememberedDestIndex = 0;
  int rememberedSealedHeight = 0;
  String? rememberedChainGenesis;
  Map<String, dynamic>? rememberedReserve;
  List<Vortice> deployedVortices = const [];
  bool sealed = false;
  Map<String, dynamic>? _envelope;
  String? _password;
  int _persistGen = 0;

  bool get needsPasswordSet => !sealed;
  bool get needsUnlock => sealed && identity == null;
  String? get password => _password;

  static String macPath(String home) =>
      '$home/Library/Application Support/Shear/session.json';

  static File defaultStore() {
    if (Platform.isWindows) {
      final root = Platform.environment['APPDATA'] ?? '.';
      return File(p.join(root, 'Shear', 'session.json'));
    }
    if (Platform.isAndroid) {
      return File('/data/user/0/com.shear.shear_wallet/files/Shear/session.json');
    }
    final home = Platform.environment['HOME'] ?? '.';
    if (Platform.isMacOS || Platform.isIOS) {
      return File(macPath(home));
    }
    return File(p.join(home, '.shear', 'session.json'));
  }

  Future<ShearIdentity?> loadOrCreate() async {
    if (identity != null && sealed && _password != null) return identity;
    if (!store.existsSync()) {
      identity = createIdentity();
      sealed = false;
      _envelope = null;
      _password = null;
      return identity;
    }
    final raw = store.readAsStringSync();
    if (raw.trim().isEmpty) {
      identity = createIdentity();
      sealed = false;
      return identity;
    }
    final j = jsonDecode(raw) as Map<String, dynamic>;
    if (j['kind'] == ShearLock.kind) {
      sealed = true;
      _envelope = j;
      identity = null;
      _password = null;
      biometricsEnabled = j['biometricsEnabled'] == true;
      return null;
    }
    throw const FormatException('plaintext_session');
  }

  Future<void> setPassword(String password, {String? confirm}) async {
    final err = walletPasswordError(password, confirm: confirm);
    if (err != null) throw FormatException(err);
    identity ??= createIdentity();
    _password = password;
    sealed = true;
    await persist();
  }

  Future<ShearIdentity> unlock(String password) async {
    if (password.isEmpty) {
      throw const FormatException('empty');
    }
    final env = _envelope;
    if (env == null) {
      throw const FormatException('password_not_set');
    }
    try {
      final opened = await Isolate.run(() => openSessionEnvelope(env, password));
      debugSessionUnlockStamp = opened['stamp'] as String;
      final plainRaw = opened['plain'];
      if (plainRaw is! Map) throw const FormatException('wrong_password');
      _applyPlain(Map<String, dynamic>.from(plainRaw));
      _password = password;
      sealed = true;
      return identity!;
    } catch (e) {
      if (e is FormatException && e.message.startsWith('shewall_reset_required')) rethrow;
      if (e is FormatException && e.message == 'password_not_set') rethrow;
      throw const FormatException('wrong_password');
    }
  }

  Future<void> persist() async {
    if (!sealed || _password == null || identity == null) return;
    final gen = ++_persistGen;
    final path = store.path;
    final plain = _plainBody();
    final password = _password!;
    final bio = biometricsEnabled;
    final sealedEnv = await Isolate.run(
      () => sealSessionEnvelope(plain, password, bio),
    );
    // The isolate must not write. A seal requested earlier can finish later
    // and would put the old biometrics flag back on disk.
    if (gen != _persistGen) return;
    final env = Map<String, dynamic>.from(sealedEnv['env'] as Map);
    await Isolate.run(() => writeSessionFile(path, env));
    if (gen != _persistGen) return;
    _envelope = env;
    debugSessionPersistStamp = sealedEnv['stamp'] as String;
  }

  Map<String, dynamic> _plainBody() => {
        ...identity!.toJson(),
        'biometricsEnabled': biometricsEnabled,
        'darkMode': darkMode,
        'closureSendMode': closureSendMode,
        'dests': rememberedDests.where((d) => d.startsWith('ssa1')).toList(),
        'destCount': rememberedDestCount,
        'destIndex': rememberedDestIndex,
        'sealedHeight': rememberedSealedHeight,
        if (rememberedChainGenesis != null && rememberedChainGenesis!.isNotEmpty)
          'chainGenesis': rememberedChainGenesis,
        'txs': rememberedTxs,
        if (rememberedReserve != null) 'reserve': rememberedReserve,
        'vortices': deployedVortices.map((v) => v.toJson()).toList(),
      };

  /// Explicit reset: drop a v3 shewall and mint a new identity on this book.
  Future<ShearIdentity> resetForNewBook({String? password}) async {
    identity = createIdentity();
    rememberedDests = const [];
    rememberedTxs = const [];
    rememberedDestCount = 1;
    rememberedDestIndex = 0;
    rememberedSealedHeight = 0;
    rememberedChainGenesis = null;
    rememberedReserve = null;
    deployedVortices = const [];
    final pw = password ?? _password;
    if (pw != null && pw.isNotEmpty) {
      _password = pw;
      sealed = true;
      await persist();
    }
    return identity!;
  }

  void _applyPlain(Map<String, dynamic> j) {
    identity = ShearIdentity.fromJson(j);
    biometricsEnabled = j['biometricsEnabled'] == true;
    darkMode = j['darkMode'] == true;
    closureSendMode = _closureFromPlain(j);
    rememberedDests = ((j['dests'] as List?) ?? const [])
        .map((e) => e.toString())
        .where((d) => d.startsWith('ssa1'))
        .toList();
    rememberedDestCount = (j['destCount'] as num?)?.toInt() ?? 1;
    rememberedDestIndex = (j['destIndex'] as num?)?.toInt() ?? 0;
    rememberedSealedHeight = (j['sealedHeight'] as num?)?.toInt() ?? 0;
    rememberedChainGenesis = j['chainGenesis']?.toString();
    rememberedTxs = ((j['txs'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
    rememberedReserve = j['reserve'] is Map ? Map<String, dynamic>.from(j['reserve'] as Map) : null;
    deployedVortices = ((j['vortices'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => Vortice.fromJson(Map<String, dynamic>.from(e)))
        .where((v) => v.id.isNotEmpty && !isPinnedProgram(v.id) && !isReservedProgram(v.id))
        .toList();
  }
}

String _closureFromPlain(Map<String, dynamic> j) {
  final stored = j['closureSendMode']?.toString();
  final legacy = (stored == null || stored.isEmpty)
      ? j['continuumSendPath']?.toString()
      : stored;
  final raw = (legacy == null || legacy.isEmpty) && j['fullNode'] == true
      ? 'fullNode'
      : legacy;
  return closureModeStored(
    closureModeFromStored(raw, android: Platform.isAndroid),
  );
}

Uint8List _hexBytes(String hex) {
  final s = hex.trim();
  final out = Uint8List(s.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(s.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

Map<String, dynamic> ledgerUserArchive(ShearLedger ledger) {
  ledger.prune();
  return {
    'dests': ledger.exportedDests(),
    'destCount': ledger.destCount,
    'destIndex': ledger.destIndex,
    'sealedHeight': ledger.sealedHeight,
    if (ledger.chainGenesis != null && ledger.chainGenesis!.isNotEmpty)
      'chainGenesis': ledger.chainGenesis,
    'txs': [
      for (final t in ledger.transactions)
        if (t.kind != 'sample') t.toJson(),
    ],
  };
}

void applyUserArchive(ShearLedger ledger, Map<String, dynamic> archive) {
  final dests = ((archive['dests'] as List?) ?? const []).map((e) => e.toString()).toList();
  final txs = <ShearTx>[
    for (final row in (archive['txs'] as List?) ?? const [])
      if (row is Map) ShearTx.fromJson(Map<String, dynamic>.from(row)),
  ];
  ledger.replaceFromBackup(
    address: dests.isNotEmpty ? dests.first : '',
    spendable: 0,
    pending: 0,
    txs: txs,
    destCount: (archive['destCount'] as num?)?.toInt(),
    destIndex: (archive['destIndex'] as num?)?.toInt(),
  );
  ledger.restoreDests(dests);
  final g = archive['chainGenesis']?.toString() ?? '';
  ledger.restoreSealedTip((archive['sealedHeight'] as num?)?.toInt() ?? 0, genesis: g);
  // Landing history is not spendable. syncCredits or the shewall header is.
}

Uint8List exportShewall({
  required ShearIdentity identity,
  required ShearLedger ledger,
  Map<String, dynamic>? reserveSnapshot,
  List<Vortice>? vortices,
}) {
  ledger.prune();
  final dest20 = hash20FromAddress(identity.address) ?? Uint8List(20);
  final archive = ledgerUserArchive(ledger);
  if (reserveSnapshot != null) archive['reserve'] = reserveSnapshot;
  if (vortices != null && vortices.isNotEmpty) {
    archive['vortices'] = vortices.map((v) => v.toJson()).toList();
  }
  return packShewall(
    seed32: _hexBytes(identity.seedHex),
    dest20: dest20,
    spendableNanos: (ledger.spendableOwned(identity.address, paymentCode: identity.paymentCode) * kUnitsPerShe).round(),
    pendingNanos: (ledger.pending(identity.address) * kUnitsPerShe).round(),
    archive: archive,
  );
}

ShearIdentity importShewall(
  Uint8List packed,
  ShearLedger ledger, {
  ShearReserve? reserve,
  void Function(List<Vortice>)? onVortices,
}) {
  final u = unpackShewall(packed);
  final id = createIdentity(u['seed32']!);
  ledger.viewSecret = id.viewKey;
  ledger.spendPub = decodePaymentCode(id.paymentCode)?['spendPub'];
  final spend = shewallU64(u['spendableNanos']!) / kUnitsPerShe;
  final pend = shewallU64(u['pendingNanos']!) / kUnitsPerShe;
  final archive = unpackShewallArchive(packed);
  if (archive != null) {
    applyUserArchive(ledger, archive);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    if (spend > ledger.spendableOwned(id.address, paymentCode: id.paymentCode)) {
      ledger.rememberSpendable(home, spend);
    }
    final vortRaw = archive['vortices'];
    if (onVortices != null && vortRaw is List) {
      onVortices([
        for (final row in vortRaw)
          if (row is Map) Vortice.fromJson(Map<String, dynamic>.from(row)),
      ]);
    }
    final snap = archive['reserve'];
    if (reserve != null && snap is Map) {
      reserve.applyLocalSnapshot(Map<String, dynamic>.from(snap));
    }
    return id;
  }
  ledger.replaceFromBackup(
    address: id.address,
    spendable: spend,
    pending: pend,
    txs: const [],
  );
  return id;
}

Future<File> writeShewallFile(File dest, Uint8List sealed) async {
  dest.parent.createSync(recursive: true);
  if (sealed.isNotEmpty && sealed[0] == 0x7b) {
    throw const FormatException('json_refused');
  }
  dest.writeAsBytesSync(sealed);
  return dest;
}

Uint8List readShewallFile(File src) {
  final raw = src.readAsBytesSync();
  if (raw.isNotEmpty && raw[0] == 0x7b) {
    throw const FormatException('json_refused');
  }
  return raw;
}

Future<File> exportEncryptedShewall({
  required ShearIdentity identity,
  required ShearLedger ledger,
  required String password,
  required File dest,
  Map<String, dynamic>? reserveSnapshot,
  List<Vortice>? vortices,
}) async {
  if (password.isEmpty) throw const FormatException('empty');
  final packed = exportShewall(
    identity: identity,
    ledger: ledger,
    reserveSnapshot: reserveSnapshot,
    vortices: vortices,
  );
  final sealed = await sealShewallBin(packed, password);
  return writeShewallFile(dest, sealed);
}

Future<ShearIdentity> importEncryptedShewall({
  required File src,
  required String password,
  required ShearLedger ledger,
  ShearReserve? reserve,
  void Function(List<Vortice>)? onVortices,
}) async {
  final opened = await openShewallBin(readShewallFile(src), password);
  final archive = unpackShewallArchive(opened);
  if (archive == null) {
    return importShewall(opened, ledger, reserve: reserve, onVortices: onVortices);
  }
  final u = unpackShewall(opened);
  final id = createIdentity(u['seed32']!);
  ledger.viewSecret = id.viewKey;
  ledger.spendPub = decodePaymentCode(id.paymentCode)?['spendPub'];
  final spend = shewallU64(u['spendableNanos']!) / kUnitsPerShe;
  await applyUserArchiveOffUi(ledger, archive);
  final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
  if (spend > ledger.spendableOwned(id.address, paymentCode: id.paymentCode)) {
    ledger.rememberSpendable(home, spend);
  }
  final vortRaw = archive['vortices'];
  if (onVortices != null && vortRaw is List) {
    onVortices([
      for (final row in vortRaw)
        if (row is Map) Vortice.fromJson(Map<String, dynamic>.from(row)),
    ]);
  }
  final snap = archive['reserve'];
  if (reserve != null && snap is Map) {
    reserve.applyLocalSnapshot(Map<String, dynamic>.from(snap));
  }
  return id;
}
