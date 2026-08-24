import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import 'shear_identity.dart';
import 'shear_ledger.dart';

class ShearSession {
  ShearSession({File? store}) : store = store ?? defaultStore();

  final File store;
  ShearIdentity? identity;

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
      if (identity!.paymentCode != j['paymentCode']) await persist();
      return identity!;
    }
    identity = createIdentity();
    await persist();
    return identity!;
  }

  Future<void> persist() async {
    store.parent.createSync(recursive: true);
    store.writeAsStringSync(jsonEncode(identity!.toJson()));
  }
}

const shewallName = 'shewall.json';

Map<String, dynamic> exportShewall({
  required ShearIdentity identity,
  required ShearLedger ledger,
}) {
  ledger.prune();
  return {
    'kind': 'shear-shewall-v1',
    'network': 'shear-testnet-v1',
    'file': shewallName,
    ...identity.toJson(),
    'spendable': ledger.spendable(identity.address),
    'pending': ledger.pending(identity.address),
    'destCount': ledger.destCount,
    'destIndex': ledger.destIndex,
    'txs': ledger.transactions.map((t) => t.toJson()).toList(),
  };
}

ShearIdentity importShewall(Map<String, dynamic> dump, ShearLedger ledger) {
  final id = ShearIdentity.fromJson(dump);
  ledger.replaceFromBackup(
    address: id.address,
    spendable: (dump['spendable'] as num?)?.toDouble() ?? 0,
    pending: (dump['pending'] as num?)?.toDouble() ?? 0,
    destCount: (dump['destCount'] as num?)?.toInt(),
    destIndex: (dump['destIndex'] as num?)?.toInt(),
    txs: ((dump['txs'] as List?) ?? const [])
        .map((e) => ShearTx.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList(),
  );
  return id;
}

Future<File> writeShewallFile(File dest, Map<String, dynamic> dump) async {
  dest.parent.createSync(recursive: true);
  dest.writeAsStringSync(const JsonEncoder.withIndent('  ').convert(dump));
  return dest;
}

Map<String, dynamic> readShewallFile(File src) {
  return jsonDecode(src.readAsStringSync()) as Map<String, dynamic>;
}
