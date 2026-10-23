import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_fs1.dart';
import 'package:shear_wallet/shear_ed25519.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_pack.dart';
import 'package:shear_wallet/shear_vault_reward.dart';

void main() {
  test('a restored lock index does not restart at 0', () {
    final id = createIdentity();
    final seed = hexToBytes(id.seedHex);
    final ledger = ShearLedger()..spendSeed = seed;
    final portal = reservePortalIdFromSeed('', seed, 0);
    expect(portal, isNotNull);
    ledger.noteChainPortals([portal!]);
    expect(ledger.nextLockIndex, 1);
  });

  test('restore clears the notes cursor so sync reads below the sealed tip', () {
    final ledger = ShearLedger();
    final id = createIdentity();
    ledger.bindIdentity(id);
    ledger.restoreSealedTip(12);
    expect(ledger.rescanBelowSealed, isTrue);
    expect(ledger.sealedHeight, 12);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    expect(ledger.notesStamped(home), isFalse);
  });

  test('a withdraw change is found and spent after restore', () async {
    expect(Fs1Native.tryLoad(), isNotNull, reason: 'fs1_prover_unavailable');
    final id = createIdentity();
    final seed = hexToBytes(id.seedHex);
    final portal = reservePortalIdFromSeed('', seed, 0)!;
    final nonce = Uint8List(32)..[0] = 9;
    final changeSeed = withdrawChangeSeedOf(seed, portal, nonce);
    if (changeSeed == null) fail('change seed');
    const changeNanos = 100000;
    final built = hiddenChangeNote(
      changeNanos,
      destCommitOf(changeSeed),
      spendSeed: changeSeed,
      admitBase: admitPub(admitBaseScalar(seed)),
    );
    expect(built, isNotNull);
    built!['portalId'] = portal;
    built['withdrawNonce'] = nonce;
    final flux = <String, dynamic>{
      'pubs': <Object>[],
      'commits': <Object>[],
      'anchors': [
        {'height': 32, 'n': 1},
      ],
      'spendTags': <Object>[],
    };
    final pool = _RestorePool(flux);
    addTearDown(pool.close);
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    ledger.restoreSealedTip(12);
    ledger.ingestSealedVouts([built], spendSeed: seed, dest: ledger.homeDest(id.address, paymentCode: id.paymentCode));
    final found = ledger.notes.where((n) => n['changeSeed'] is Uint8List);
    expect(found, isNotEmpty);
    final row = Map<String, dynamic>.from(found.first);
    expect(row['spendSeed'], isA<Uint8List>());
    expect(row['r'], isA<Uint8List>());
    (flux['pubs'] as List).add(row['admitPub']);
    (flux['commits'] as List).add(row['commit']);
    final out = hiddenChangeNote(changeNanos - 100, Uint8List(20)..[0] = 4);
    expect(out, isNotNull);
    final spent = await ledger.spendFs1Notes(
      notes: [row],
      sealed: [out!],
      fee: 100,
      spendSeed: row['spendSeed'] as Uint8List,
      kind: 'send',
    );
    expect(spent.fs1.isNotEmpty, isTrue);
    expect(spent.fs1.first, 0xf1);
    expect(spent.vin, hasLength(1));
  }, timeout: const Timeout(Duration(minutes: 3)));
}

class _RestorePool extends ShearPoolClient {
  _RestorePool(this.flux)
      : super(
          baseUrl: 'http://127.0.0.1:9',
          http: HttpClient()..connectionTimeout = const Duration(milliseconds: 50),
        );

  final Map<String, dynamic> flux;

  @override
  Future<Map<String, dynamic>> fluxset() async => flux;
}

Uint8List destCommitOf(Uint8List seed) {
  final raw = destCommitFromSpendPub(ed25519PublicFromSeed(seed));
  return Uint8List.fromList(raw.sublist(0, 20));
}
