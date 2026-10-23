import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_ed25519.dart';
import 'package:shear_wallet/shear_eip712.dart';
import 'package:shear_wallet/shear_fs1.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_pack.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_ristretto.dart';
import 'package:shear_wallet/shear_withdraw.dart';

/// The app and the CLI both call [postMaturedWithdraws]. Tranches come from
/// the node. A refused post adds no payout note.
void main() {
  test('one matured portal withdraws, an unmatured portal does not, and the CLI arguments are that call', () async {
    final run = await _post(
      leaves: (seed) {
        final portals = portalsFromSeed(seed, 2);
        return [
          _leaf(amount: 1000, portalId: portals[1]['portalId'] as String, lockIndex: 1, epoch: 0),
          _leaf(amount: 2000, portalId: portals[0]['portalId'] as String, lockIndex: 0, epoch: 5),
        ];
      },
    );
    expect(run.posts, hasLength(1));
    final body = run.posts.single;
    final mature = portalsFromSeed(run.seed, 2)[1]['portalId'];
    expect(body['portalId'], mature);
    expect(body['nanos'], 1000);
    expect(body.containsKey('payoutPortalId'), isFalse);
    final owner = _hex(ed25519PublicFromSeed(reservePortalSpendSeed(run.seed, 1)!));
    final identity = _hex(ed25519PublicFromSeed(run.seed));
    expect(body['ownerPub'], owner);
    expect(body['ownerPub'], isNot(identity));
    final payout = run.ledger.notes.where((n) => n['kind'] == 'withdraw').single;
    final payoutSeed = payout['payoutSeed'] as Uint8List;
    final stamped = <String, dynamic>{
      'commit': payout['commit'],
      'noteCommit': payout['noteCommit'],
      'kind': 'withdraw',
    };
    expect(payout['admitPub'], orderedEquals(pointBytes(admitPub(admitScalarFromSeed(payoutSeed, stamped)))));
    expect(admitBaseBytes(payoutSeed), isNot(orderedEquals(admitBaseBytes(run.seed))));
    expect(run.host['spent'], isTrue);
  }, timeout: const Timeout(Duration(minutes: 5)));

  test('two matured leaves of one portal are one withdraw of their sum', () async {
    final run = await _post(
      leaves: (seed) {
        final portal = portalsFromSeed(seed, 1).first['portalId'] as String;
        return [
          _leaf(amount: 1000, portalId: portal, lockIndex: 0, epoch: 0),
          _leaf(amount: 2500, portalId: portal, lockIndex: 0, epoch: 0),
        ];
      },
    );
    expect(run.posts, hasLength(1));
    expect(run.posts.single['nanos'], 3500);
    expect(run.ledger.notes.where((n) => n['kind'] == 'withdraw'), hasLength(1));
  }, timeout: const Timeout(Duration(minutes: 5)));

  test('a refused post adds no payout note and does not spend the host', () async {
    final run = await _post(
      ok: false,
      leaves: (seed) {
        final portal = portalsFromSeed(seed, 1).first['portalId'] as String;
        return [
          _leaf(amount: 1000, portalId: portal, lockIndex: 0, epoch: 0),
        ];
      },
    );
    expect(run.posts, hasLength(1));
    expect(run.posted, isEmpty);
    expect(run.ledger.notes.where((n) => n['kind'] == 'withdraw'), isEmpty);
    expect(run.ledger.notes, hasLength(run.before));
    expect(run.host['spent'], isNot(true));
  }, timeout: const Timeout(Duration(minutes: 5)));
}

class _Run {
  _Run(this.ledger, this.posts, this.posted, this.seed, this.host, this.before);
  final ShearLedger ledger;
  final List<Map<String, dynamic>> posts;
  final List<Object?> posted;
  final Uint8List seed;
  final Map<String, dynamic> host;
  final int before;
}

Future<_Run> _post({
  required List<Map<String, Object?>> Function(Uint8List seed) leaves,
  bool ok = true,
}) async {
  expect(Fs1Native.tryLoad(), isNotNull, reason: 'fs1_prover_unavailable');
  final id = createIdentity();
  final dest = id.address;
  final seed = hexToBytes(id.seedHex);
  final made = leaves(seed);
  final host = attachAdmitPub(
    sealCoinbaseNote(4000, dest20: Uint8List(20)..[0] = 3, kind: 'pot'),
    spendSeed: seed,
  );
  final tranches = <String, List<Map<String, Object?>>>{};
  for (final leaf in made) {
    final portal = leaf['portalId'] as String;
    tranches.putIfAbsent(portal, () => <Map<String, Object?>>[]).add({
      'commit': _hex((leaf['note'] as Uint8List).sublist(32, 64)),
      'epoch': (leaf['epochs'] as List).first,
      'remainMs': 0,
    });
  }
  final posts = <Map<String, dynamic>>[];
  final pool = _WdPool(posts, {
    'pubs': [host['admitPub']],
    'commits': [host['commit']],
    'anchors': [
      {'height': 32, 'n': 1},
    ],
    'spendTags': <Object>[],
  }, tranches, ok: ok);
  addTearDown(pool.close);
  final ledger = ShearLedger(pool: pool)..bindIdentity(id);
  ledger.rememberNote(host);
  for (final leaf in made) {
    ledger.rememberNote(Map<String, dynamic>.from(leaf));
  }
  const t0 = 1700000000000;
  final reserve = ShearReserve()
    ..currentEpoch = 1
    ..epochStartMs = t0;
  reserve.portal(dest)
    ..staked = kPiSheNanos
    ..joined = true;
  final before = ledger.notes.length;
  final storedHost = ledger.notes.firstWhere((n) => n['kind'] == 'pot');
  // The CLI passes the seed and the lock leaves. This is that call.
  final posted = await postMaturedWithdraws(
    ledger,
    reserve: reserve,
    dest: dest,
    payout: dest,
    nowMs: t0 + kReserveEpochMs,
    spendSeed: hexToBytes(id.seedHex),
    leaves: reserveLockLeaves(ledger.notes),
    local: false,
    publicIpConsent: true,
  );
  return _Run(ledger, posts, posted, seed, storedHost, before);
}

Map<String, Object?> _leaf({
  required int amount,
  required String portalId,
  required int lockIndex,
  required int epoch,
}) {
  final scalar = scalarBytes(randomScalar());
  final blind = scalarBytes(randomScalar());
  final note = vaultLeafNote(amount: amount, scalar: scalar, blind: blind, unlock: 0);
  return {
    'kind': 'lock',
    'scalar': scalar,
    'blind': blind,
    'note': note,
    'unlock': 0,
    'amount': amount,
    'epochs': <int>[epoch],
    'withdrawPeriod': epoch,
    'portalId': portalId,
    'lockIndex': lockIndex,
  };
}

String _hex(List<int> raw) => raw.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

class _WdPool extends ShearPoolClient {
  _WdPool(this.posts, this.flux, this.tranches, {this.ok = true})
      : super(
          baseUrl: 'http://127.0.0.1:9',
          http: HttpClient()..connectionTimeout = const Duration(milliseconds: 50),
        );

  final List<Map<String, dynamic>> posts;
  final Map<String, dynamic> flux;
  final Map<String, List<Map<String, Object?>>> tranches;
  final bool ok;

  @override
  Future<Map<String, dynamic>> fluxset() async => flux;

  @override
  Future<Map<String, dynamic>> reserveTranches(String portalId) async => {
        'ok': true,
        'portalId': portalId,
        'tranches': tranches[portalId] ?? const <Map<String, Object?>>[],
      };

  @override
  Future<Map<String, dynamic>> postRaw(Map<String, dynamic> body) async {
    posts.add(body);
    if (!ok) return {'ok': false, 'reason': 'unsigned'};
    return {'ok': true, 'id': 'wd-fix'};
  }
}
