import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:path/path.dart' as p;

import 'shear_identity.dart';
import 'shear_ledger.dart';
import 'shear_vortex.dart';
import 'shear_shewall.dart';
export 'shear_shewall.dart' show shewallName;

class ShearSession {
  ShearSession({File? store}) : store = store ?? defaultStore();

  final File store;
  ShearIdentity? identity;
  bool joinRetired = false;
  List<Vortice> deployedVortices = const [];

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

  Future<ShearIdentity> loadOrCreate() async {
    if (store.existsSync()) {
      final j = jsonDecode(store.readAsStringSync()) as Map<String, dynamic>;
      identity = ShearIdentity.fromJson(j);
      joinRetired = j['joinRetired'] == true;
      deployedVortices = ((j['vortices'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => Vortice.fromJson(Map<String, dynamic>.from(e)))
          .where((v) => v.id.isNotEmpty && !isPinnedProgram(v.id))
          .toList();
      // Do not rewrite she1. It is the perpetual public ID.
      return identity!;
    }
    identity = createIdentity();
    await persist();
    return identity!;
  }

  Future<void> persist() async {
    store.parent.createSync(recursive: true);
    final body = <String, dynamic>{
      ...identity!.toJson(),
      'joinRetired': joinRetired,
      'vortices': deployedVortices.map((v) => v.toJson()).toList(),
    };
    store.writeAsStringSync(jsonEncode(body));
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

Uint8List exportShewall({
  required ShearIdentity identity,
  required ShearLedger ledger,
}) {
  ledger.prune();
  final dest20 = hash20FromAddress(identity.address) ?? Uint8List(20);
  return packShewall(
    seed32: _hexBytes(identity.seedHex),
    dest20: dest20,
    spendableNanos: (ledger.spendable(identity.address) * kUnitsPerShe).round(),
    pendingNanos: (ledger.pending(identity.address) * kUnitsPerShe).round(),
  );
}

ShearIdentity importShewall(Uint8List packed, ShearLedger ledger) {
  final u = unpackShewall(packed);
  final id = createIdentity(u['seed32']!);
  final spend = shewallU64(u['spendableNanos']!) / kUnitsPerShe;
  final pend = shewallU64(u['pendingNanos']!) / kUnitsPerShe;
  ledger.replaceFromBackup(
    address: id.address,
    spendable: spend,
    pending: pend,
    txs: spend > 0
        ? [
            ShearTx(
              id: 'shewall-restore',
              from: 'backup',
              to: id.address,
              amount: spend,
              kind: 'coinbase',
              height: 1,
              confirmed: true,
            ),
          ]
        : const [],
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
