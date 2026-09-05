import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:path/path.dart' as p;

import 'shear_identity.dart';
import 'shear_ledger.dart';
import 'shear_lock.dart';
import 'shear_reserve.dart';
import 'shear_vortex.dart';
import 'shear_shewall.dart';
export 'shear_shewall.dart' show shewallName;

const kMinWalletPasswordLen = 8;

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
  List<String> rememberedDests = const [];
  List<Map<String, dynamic>> rememberedTxs = const [];
  int rememberedDestCount = 1;
  int rememberedDestIndex = 0;
  int rememberedSealedHeight = 0;
  Map<String, dynamic>? rememberedReserve;
  List<Vortice> deployedVortices = const [];
  bool sealed = false;
  Map<String, dynamic>? _envelope;
  String? _password;

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
    _applyPlain(j);
    sealed = false;
    _envelope = null;
    _password = null;
    return identity;
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
      final plain = await ShearLock.open(env, password);
      _applyPlain(plain);
      _password = password;
      sealed = true;
      return identity!;
    } catch (e) {
      if (e is FormatException && e.message == 'password_not_set') rethrow;
      throw const FormatException('wrong_password');
    }
  }

  Future<void> persist() async {
    if (!sealed || _password == null || identity == null) return;
    store.parent.createSync(recursive: true);
    final env = Map<String, dynamic>.from(await ShearLock.seal(_plainBody(), _password!));
    env['biometricsEnabled'] = biometricsEnabled;
    _envelope = env;
    store.writeAsStringSync(jsonEncode(env));
  }

  Map<String, dynamic> _plainBody() => {
        ...identity!.toJson(),
        'biometricsEnabled': biometricsEnabled,
        'dests': rememberedDests.where((d) => d.startsWith('ssa1')).toList(),
        'destCount': rememberedDestCount,
        'destIndex': rememberedDestIndex,
        'sealedHeight': rememberedSealedHeight,
        'txs': rememberedTxs,
        if (rememberedReserve != null) 'reserve': rememberedReserve,
        'vortices': deployedVortices.map((v) => v.toJson()).toList(),
      };

  void _applyPlain(Map<String, dynamic> j) {
    identity = ShearIdentity.fromJson(j);
    biometricsEnabled = j['biometricsEnabled'] == true;
    rememberedDests = ((j['dests'] as List?) ?? const [])
        .map((e) => e.toString())
        .where((d) => d.startsWith('ssa1'))
        .toList();
    rememberedDestCount = (j['destCount'] as num?)?.toInt() ?? 1;
    rememberedDestIndex = (j['destIndex'] as num?)?.toInt() ?? 0;
    rememberedSealedHeight = (j['sealedHeight'] as num?)?.toInt() ?? 0;
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
  final sums = <String, double>{};
  for (final t in txs) {
    if (!t.confirmed || t.to.isEmpty) continue;
    if (t.kind == 'send') continue;
    sums[t.to] = (sums[t.to] ?? 0) + t.amount;
  }
  for (final e in sums.entries) {
    ledger.rememberSpendable(e.key, e.value);
  }
}

Uint8List exportShewall({
  required ShearIdentity identity,
  required ShearLedger ledger,
  Map<String, dynamic>? reserveSnapshot,
}) {
  ledger.prune();
  final dest20 = hash20FromAddress(identity.address) ?? Uint8List(20);
  final archive = ledgerUserArchive(ledger);
  if (reserveSnapshot != null) archive['reserve'] = reserveSnapshot;
  return packShewall(
    seed32: _hexBytes(identity.seedHex),
    dest20: dest20,
    spendableNanos: (ledger.spendableOwned(identity.address, paymentCode: identity.paymentCode) * kUnitsPerShe).round(),
    pendingNanos: (ledger.pending(identity.address) * kUnitsPerShe).round(),
    archive: archive,
  );
}

ShearIdentity importShewall(Uint8List packed, ShearLedger ledger, {ShearReserve? reserve}) {
  final u = unpackShewall(packed);
  final id = createIdentity(u['seed32']!);
  final spend = shewallU64(u['spendableNanos']!) / kUnitsPerShe;
  final pend = shewallU64(u['pendingNanos']!) / kUnitsPerShe;
  final archive = unpackShewallArchive(packed);
  if (archive != null) {
    applyUserArchive(ledger, archive);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    if (spend > ledger.spendableOwned(id.address, paymentCode: id.paymentCode)) {
      ledger.rememberSpendable(home, spend);
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
}) async {
  if (password.isEmpty) throw const FormatException('empty');
  final packed = exportShewall(identity: identity, ledger: ledger, reserveSnapshot: reserveSnapshot);
  final sealed = await sealShewallBin(packed, password);
  return writeShewallFile(dest, sealed);
}

Future<ShearIdentity> importEncryptedShewall({
  required File src,
  required String password,
  required ShearLedger ledger,
  ShearReserve? reserve,
}) async {
  final opened = await openShewallBin(readShewallFile(src), password);
  return importShewall(opened, ledger, reserve: reserve);
}
