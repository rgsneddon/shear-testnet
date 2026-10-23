import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_session.dart';

Uint8List _unhex(String hex) {
  final raw = hex.startsWith('0x') ? hex.substring(2) : hex;
  if (raw.length.isOdd) throw StateError('hex');
  final out = Uint8List(raw.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(raw.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

/// shewall.bin of the master secret, taken before the vote and the withdraw.
Future<void> main() async {
  final path = Platform.environment['SHEAR_BACKUP_FIXTURE'];
  if (path == null || path.isEmpty) throw StateError('fixture');
  final raw = jsonDecode(File(path).readAsStringSync());
  if (raw is! Map) throw StateError('fixture');
  final id = createIdentity(_unhex(raw['seed'].toString()));
  final ledger = ShearLedger()..bindIdentity(id);
  final dest = File(raw['out'].toString());
  await exportEncryptedShewall(
    identity: id,
    ledger: ledger,
    password: raw['password'].toString(),
    dest: dest,
  );
  stdout.writeln(jsonEncode({'ok': true, 'bytes': dest.lengthSync()}));
}
