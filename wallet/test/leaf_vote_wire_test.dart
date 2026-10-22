import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_fs1.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_ristretto.dart';

/// The vote screen posts one leaf vote per plan row. The proof, the fee
/// spend, and the window are the ones the wallet already holds. There is
/// no portal-vote fallback and no address on the wire.
void main() {
  test('a planned leaf vote posts a fresh proof at the census window', () async {
    expect(Fs1Native.tryLoad(), isNotNull, reason: 'fs1_prover_unavailable');
    final id = createIdentity();
    final dest = id.address;
    final seed = hexToBytes(id.seedHex);
    final voteL = estimateSendLevyUnits(inputs: 1, outputs: 1);
    expect(voteL, greaterThan(0));

    final reserve = ShearReserve()..currentEpoch = 1;
    reserve.portal(dest).staked = kPiSheNanos;
    const open = 100;
    final close = voteCloseHeightOf(open);
    expect(close, isNotNull);
    expect(close, isNot(0));
    expect(close, isNot(4000));
    expect(close, open + (kReserveEpochDays - kReserveJoinCutoffDays) * kVaultDayBlocks);

    final fee = attachAdmitPub(
      sealCoinbaseNote(voteL, dest20: Uint8List(20)..[0] = 4, kind: 'pot'),
      spendSeed: seed,
    );
    fee['nanos'] = voteL;
    final feeHex = _hex(fee['commit'] as Uint8List);
    const height = 200;
    expect(height, greaterThan(open));
    expect(height, lessThan(close!));

    final posts = <Map<String, dynamic>>[];
    final pool = _LeafPool(posts, {
      'pubs': [fee['admitPub']],
      'commits': [fee['commit']],
      'anchors': [
        {'height': 32, 'n': 1},
      ],
      'spendTags': <Object>[],
    });
    addTearDown(pool.close);
    final ledger = ShearLedger(pool: pool)..bindIdentity(id);
    ledger.replaceFromBackup(
      address: dest,
      spendable: 1,
      pending: 0,
      txs: const [],
    );
    ledger.rememberNodeChain(bodies: [
      {
        'height': open,
        'txs': [
          {
            'coinbase': true,
            'epochCensusCommit': [
              {'epoch': 1, 'leafCount': 1, 'openHeight': open},
            ],
          },
        ],
      },
    ]);
    ledger.rememberNote(fee);
    ledger.rememberNote({
      'kind': 'lock',
      'scalar': scalarBytes(randomScalar()),
      'blind': scalarBytes(randomScalar()),
      'note': Uint8List(64),
      'amount': kPiSheNanos,
      'epochs': [1],
      'unlock': 0,
    });

    final dir = Directory.systemTemp.createTempSync('shear-leaf-vote-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    File('${dir.path}${Platform.pathSeparator}vote-plan.json').writeAsStringSync(jsonEncode({
      'epoch': 1,
      'openHeight': open,
      'closeHeight': close,
      'txs': [
        {'leaf': 0, 'height': height, 'feeInput': feeHex},
      ],
    }));

    // The recorder is the post under test. Consent is set so the public-dial
    // gate does not refuse this wire.
    final result = await castPlannedLeafVotes(
      ledger: ledger,
      reserve: reserve,
      planDir: dir.path,
      restFrame: dest,
      dest: dest,
      choice: kVoteIncrease,
      spendSeed: seed,
      local: false,
      publicIpConsent: true,
    );
    expect(result.enacted, isTrue, reason: result.remark);
    expect(posts, hasLength(1));
    final body = posts.single;
    expect(body['kind'], 'leaf-vote');
    expect(body['programId'], kReserveProgram);
    expect(body['height'], height);
    expect(body.containsKey('from'), isFalse);
    expect(body.containsKey('to'), isFalse);
    expect(body.containsKey('portalId'), isFalse);
    expect(body.containsKey('payoutPortalId'), isFalse);
    expect(body.containsKey('feeInput'), isFalse);
    expect(body.containsKey('parentTx'), isFalse);
    expect(body.containsKey('parent'), isFalse);
    final proof = body['voteProof'];
    expect(proof, isA<List>());
    expect((proof as List).isNotEmpty, isTrue);
    expect(proof.first, 0x56);
    expect(body['anchor'], isA<int>());
    expect(body['anchor'] as int, greaterThan(0));
    final fs1 = body['fs1'];
    expect(fs1, isA<List>());
    expect((fs1 as List).isNotEmpty, isTrue);
    expect(fs1.first, 0xf1);
    final admits = body['admit_proofs'];
    expect(admits, isA<List>());
    expect((admits as List), hasLength(1));
    final admit = admits.single as Map;
    expect(admit.keys.toSet(), {'blob', 'cTilde', 'spendTag'});
    final saved = jsonDecode(
      File('${dir.path}${Platform.pathSeparator}vote-plan.json').readAsStringSync(),
    ) as Map;
    expect(saved['openHeight'], open);
    expect(saved['closeHeight'], close);
  }, timeout: const Timeout(Duration(minutes: 3)));
}

String _hex(List<int> raw) =>
    raw.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

class _LeafPool extends ShearPoolClient {
  _LeafPool(this.posts, this.flux)
      : super(
          baseUrl: 'http://127.0.0.1:9',
          http: HttpClient()..connectionTimeout = const Duration(milliseconds: 50),
        );

  final List<Map<String, dynamic>> posts;
  final Map<String, dynamic> flux;

  @override
  Future<Map<String, dynamic>> fluxset() async => flux;

  @override
  Future<Map<String, dynamic>> postRaw(Map<String, dynamic> body) async {
    posts.add(body);
    return {'ok': true, 'id': 'leaf-vote-wire'};
  }
}
