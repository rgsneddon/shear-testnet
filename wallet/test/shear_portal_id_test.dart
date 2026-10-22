import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_pack.dart';
import 'package:shear_wallet/shear_reserve.dart';

void main() {
  test('a portal id is not recomputed from the public address', () {
    final seed = Uint8List(32);
    final dest20 = Uint8List(20);
    for (var i = 0; i < 32; i++) seed[i] = i + 1;
    for (var i = 0; i < 20; i++) dest20[i] = 0xa0 + (i % 16);
    final blind = portalBlindFromSeed(seed);
    expect(blind, isNotNull);
    final pid = portalIdFromDest20(dest20, blind!);
    expect(pid, isNotNull);
    expect(pid!.length, 64);
    const address = 'ssa1qqexamplepublicaddress';
    expect(pid, isNot(portalIdFromDest(address)));
    final publicOnly = sha256.convert(<int>[...utf8.encode(kPortalIdTag), ...dest20]).toString();
    expect(pid, isNot(publicOnly));
    expect(portalIdFromDest20(dest20, Uint8List(32)), isNot(pid));
  });

  test('two locks from one seed are two portals and two dest20s', () {
    final id = createIdentity();
    final seed = Uint8List(32);
    for (var i = 0; i < 32; i++) {
      seed[i] = int.parse(id.seedHex.substring(i * 2, i * 2 + 2), radix: 16);
    }
    final payer = createIdentity();
    final recovered = portalsFromSeed(seed, 2);
    expect(recovered, hasLength(2));
    expect(recovered[0]['portalId'], isNot(recovered[1]['portalId']));
    expect(recovered[0]['dest20'], isNot(recovered[1]['dest20']));
    // Seed-only recovery finds the same portals again.
    final again = portalsFromSeed(seed, 2);
    expect(again[0]['portalId'], recovered[0]['portalId']);
    expect(again[1]['portalId'], recovered[1]['portalId']);
    final identity = hash20FromAddress(id.address);
    expect(identity, isNotNull);
    expect(recovered[0]['dest20'], isNot(orderedEquals(identity!)));
    expect(recovered[1]['dest20'], isNot(orderedEquals(identity)));

    Map<String, dynamic> builtAt(int lockIndex) {
      return sealSignReserveWire(<String, dynamic>{
        'to': id.address,
        'from': payer.address,
        'kind': 'lock',
        'nanos': 1000,
        'spendSeed': seed,
        'lockIndex': lockIndex,
        'vouts': <Map<String, dynamic>>[
          {'address': id.address, 'nanos': 1000, 'kind': 'lock'},
        ],
      });
    }

    final first = builtAt(0);
    final second = builtAt(1);
    expect(first['portalId'], recovered[0]['portalId']);
    expect(second['portalId'], recovered[1]['portalId']);
    expect(first['portalId'], isNot(second['portalId']));
    expect(first['portalId'], isNot(portalIdFromDest(id.address)));
    expect(first['portalId'], isNot(reservePortalId(id.address)));
    expect(first['payoutPortalId'], isNot(first['portalId']));
    final note0 = (first['vouts'] as List).first as Map;
    final note1 = (second['vouts'] as List).first as Map;
    expect(note0['portalId'], recovered[0]['portalId']);
    expect(note1['portalId'], recovered[1]['portalId']);
    expect(note0['dest20'], orderedEquals(recovered[0]['dest20'] as List<int>));
    expect(note1['dest20'], orderedEquals(recovered[1]['dest20'] as List<int>));
    expect(note0['dest20'], isNot(orderedEquals(identity)));
  });

  test('the wallet recognises its one-time withdraw payout', () {
    final seed = Uint8List(32);
    for (var i = 0; i < 32; i++) seed[i] = i + 1;
    final portalId = portalsFromSeed(seed, 1).first['portalId'] as String;
    final nonce = Uint8List(32);
    nonce[0] = 7;
    final dest = withdrawPayoutDest20(seed, portalId, nonce);
    expect(dest, isNotNull);
    expect(recognisesWithdrawPayout({'dest20': dest}, seed, portalId, nonce), isTrue);
    final other = Uint8List.fromList(nonce);
    other[1] = 1;
    expect(recognisesWithdrawPayout({'dest20': dest}, seed, portalId, other), isFalse);
    final wrong = Uint8List.fromList(dest!);
    wrong[0] = wrong[0] ^ 0xff;
    expect(recognisesWithdrawPayout({'dest20': wrong}, seed, portalId, nonce), isFalse);
  });
}
