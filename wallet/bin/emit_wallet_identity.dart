import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Uint8List _unhex(String hex) {
  final raw = hex.startsWith('0x') ? hex.substring(2) : hex;
  if (raw.length.isOdd) throw StateError('hex');
  final out = Uint8List(raw.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(raw.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

/// The wallet a seed restores: its rest frame, home dest, the dest20 under
/// that dest, and the admit base a payer seals a hidden note to it with.
Future<void> main() async {
  final seedHex = Platform.environment['SHEAR_WALLET_SEED'];
  if (seedHex == null || seedHex.length != 64) throw StateError('seed');
  final seed = _unhex(seedHex);
  final id = createIdentity(seed);
  final ledger = ShearLedger()..bindIdentity(id);
  final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
  final dest20 = hash20FromAddress(home);
  if (dest20 == null || dest20.length != 20) throw StateError('home dest');
  stdout.writeln(jsonEncode({
    'address': id.address,
    'paymentCode': id.paymentCode,
    'home': home,
    'dest20': _hex(dest20),
    'admitBase': _hex(admitBaseBytes(seed)),
  }));
}
