import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ed25519.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_pack.dart';

String _hex(List<int> raw) => raw.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

Map<String, dynamic> _row(Map row) {
  final out = <String, dynamic>{};
  for (final e in row.entries) {
    final v = e.value;
    if (v is Uint8List) {
      out[e.key.toString()] = _hex(v);
    } else if (v is List<int>) {
      out[e.key.toString()] = _hex(Uint8List.fromList(v));
    } else {
      out[e.key.toString()] = v;
    }
  }
  return out;
}

/// One JSON line for the pool hidden-lock draft. The builder is the wallet.
void main() {
  test('emit a wallet lock', () {
    final id = createIdentity();
    final seed = Uint8List(32);
    for (var i = 0; i < 32; i++) {
      seed[i] = int.parse(id.seedHex.substring(i * 2, i * 2 + 2), radix: 16);
    }
    final payer = createIdentity();
    final built = sealSignReserveWire(<String, dynamic>{
      'to': id.address,
      'from': payer.address,
      'kind': 'lock',
      'nanos': 1000,
      'spendSeed': seed,
      'lockIndex': 0,
      'vouts': <Map<String, dynamic>>[
        {'address': id.address, 'nanos': 1000, 'kind': 'lock'},
      ],
    });
    final ownerSeed = reservePortalSpendSeed(seed, 0);
    expect(ownerSeed, isNotNull);
    final ownerPub = _hex(ed25519PublicFromSeed(ownerSeed!));
    final identityPub = _hex(ed25519PublicFromSeed(seed));
    expect(built['ownerPub'], ownerPub);
    expect(built['ownerPub'], isNot(identityPub));
    expect(built.containsKey('payoutPortalId'), isFalse);
    expect(built['lockAuth'], isA<String>());
    expect(built['vaultLockNote'], isA<String>());
    final body = walletSendBody(
      from: '',
      to: '',
      amount: 1000,
      nanosWire: '1000',
      kind: 'lock',
      programId: 'shear-reserve-v1',
      portalId: built['portalId'] as String,
      fee: built['fee'] is int ? built['fee'] as int : 0,
      fs1: 'f100',
      vin: const [
        {'commit': '11'},
      ],
      vout: [
        for (final row in (built['vouts'] as List))
          if (row is Map) _row(row),
      ],
      lockAuth: built['lockAuth'] as String,
      ownerPub: built['ownerPub'] as String,
      vaultLockNote: built['vaultLockNote'] as String,
      id: 'wallet-lock',
    );
    expect(body.containsKey('from'), isFalse);
    expect(body.containsKey('to'), isFalse);
    expect(body['lockAuth'], built['lockAuth']);
    expect(body['ownerPub'], ownerPub);
    print(jsonEncode({
      'body': body,
      'ownerPub': ownerPub,
      'identityPub': identityPub,
    }));
  });
}
