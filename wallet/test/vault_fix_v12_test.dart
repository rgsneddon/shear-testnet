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

  test('the receipt adds the arrival stub', () async {
    final run = await _post(
      leaves: (seed) {
        final portal = portalsFromSeed(seed, 1).first['portalId'] as String;
        return [
          _leaf(amount: 1000, portalId: portal, lockIndex: 0, epoch: 0, stubNanos: 50),
        ];
      },
    );
    expect(run.posts, hasLength(1));
    expect(run.posts.single['nanos'], 1050);
    expect(run.bookGets, 1);
  }, timeout: const Timeout(Duration(minutes: 5)));

  test('two portals get unrelated ids and post on their own slots', () async {
    const t0 = 1700000000000;
    final reserve = ShearReserve()
      ..currentEpoch = 1
      ..epochStartMs = t0;
    late final Uint8List seed;
    late final String a;
    late final String b;
    late final int slotA;
    late final int slotB;
    var found = false;
    for (var n = 1; n < 64; n++) {
      final trial = Uint8List(32)..[0] = n;
      final portals = portalsFromSeed(trial, 2);
      final left = portals[0]['portalId'] as String;
      final right = portals[1]['portalId'] as String;
      final one = vaultWithdrawSlotMs(reserve, 0, left);
      final two = vaultWithdrawSlotMs(reserve, 0, right);
      if (one == two) continue;
      seed = trial;
      a = left;
      b = right;
      slotA = one;
      slotB = two;
      found = true;
      break;
    }
    expect(found, isTrue);
    final earlier = slotA <= slotB ? a : b;
    final earlySlot = slotA <= slotB ? slotA : slotB;
    final lateSlot = slotA <= slotB ? slotB : slotA;
    expect(earlySlot, isNot(lateSlot));
    final one = await _post(
      seed: seed,
      hosts: 2,
      nowMs: earlySlot,
      leaves: (_) => [
        _leaf(amount: 1000, portalId: a, lockIndex: 0, epoch: 0),
        _leaf(amount: 2000, portalId: b, lockIndex: 1, epoch: 0),
      ],
    );
    expect(one.bookGets, 1);
    expect(one.posts, hasLength(1));
    expect(one.posts.single['portalId'], earlier);
    final first = await _post(
      seed: seed,
      hosts: 2,
      nowMs: lateSlot,
      leaves: (_) => [
        _leaf(amount: 1000, portalId: a, lockIndex: 0, epoch: 0, stubNanos: 7),
        _leaf(amount: 2000, portalId: b, lockIndex: 1, epoch: 0, stubNanos: 11),
      ],
    );
    expect(first.posts, hasLength(1));
    expect(first.posts.single['portalId'], a);
    expect(first.posts.single['nanos'], 1007);
    final second = await _post(
      seed: seed,
      hosts: 1,
      nowMs: lateSlot,
      leaves: (_) => [
        _leaf(amount: 2000, portalId: b, lockIndex: 1, epoch: 0, stubNanos: 11),
      ],
    );
    expect(second.posts, hasLength(1));
    expect(second.posts.single['portalId'], b);
    expect(second.posts.single['nanos'], 2011);
    final ids = [
      first.posts.single['id'].toString(),
      second.posts.single['id'].toString(),
    ];
    expect(ids[0], matches(RegExp(r'^wd-[0-9a-f]{32}$')));
    expect(ids[1], matches(RegExp(r'^wd-[0-9a-f]{32}$')));
    expect(ids[0].substring(3) == ids[1].substring(3), isFalse);
    expect(ids[0].contains('$lateSlot'), isFalse);
    expect(ids[1].contains('$lateSlot'), isFalse);
    expect(ids[0].startsWith(ids[1]), isFalse);
    expect(ids[1].startsWith(ids[0]), isFalse);
    expect(first.posts.single['portalId'], a);
    expect(second.posts.single['portalId'], b);
  }, timeout: const Timeout(Duration(minutes: 5)));

  test('a run posts at most one matured portal', () async {
    const t0 = 1700000000000;
    final reserve = ShearReserve()
      ..currentEpoch = 1
      ..epochStartMs = t0;
    final seed = Uint8List(32)..[0] = 7;
    final portals = portalsFromSeed(seed, 2);
    final a = portals[0]['portalId'] as String;
    final b = portals[1]['portalId'] as String;
    final late = [
      vaultWithdrawSlotMs(reserve, 0, a),
      vaultWithdrawSlotMs(reserve, 0, b),
    ].reduce((x, y) => x > y ? x : y);
    final run = await _post(
      seed: seed,
      hosts: 2,
      nowMs: late,
      leaves: (_) => [
        _leaf(amount: 1000, portalId: a, lockIndex: 0, epoch: 0),
        _leaf(amount: 2000, portalId: b, lockIndex: 1, epoch: 0),
      ],
    );
    expect(run.posts, hasLength(1));
    expect(run.posts.map((body) => body['portalId']).toSet(), hasLength(1));
  }, timeout: const Timeout(Duration(minutes: 5)));
}

class _Run {
  _Run(this.ledger, this.posts, this.posted, this.seed, this.host, this.before, this.bookGets);
  final ShearLedger ledger;
  final List<Map<String, dynamic>> posts;
  final List<Object?> posted;
  final Uint8List seed;
  final Map<String, dynamic> host;
  final int before;
  final int bookGets;
}

Future<_Run> _post({
  required List<Map<String, Object?>> Function(Uint8List seed) leaves,
  bool ok = true,
  Uint8List? seed,
  int hosts = 1,
  int? nowMs,
}) async {
  expect(Fs1Native.tryLoad(), isNotNull, reason: 'fs1_prover_unavailable');
  final id = seed == null ? createIdentity() : null;
  final spend = seed ?? hexToBytes(createIdentity().seedHex);
  final bound = id ?? createIdentity();
  final dest = bound.address;
  final made = leaves(spend);
  final hostNotes = <Map<String, dynamic>>[];
  for (var i = 0; i < hosts; i++) {
    hostNotes.add(attachAdmitPub(
      sealCoinbaseNote(4000, dest20: Uint8List(20)..[0] = 3 + i, kind: 'pot'),
      spendSeed: spend,
    ));
  }
  final tranches = <String, List<Map<String, Object?>>>{};
  for (final leaf in made) {
    final portal = leaf['portalId'] as String;
    tranches.putIfAbsent(portal, () => <Map<String, Object?>>[]).add({
      'commit': _hex((leaf['note'] as Uint8List).sublist(32, 64)),
      'epoch': (leaf['epochs'] as List).first,
      'remainMs': 0,
      if (leaf['stubNanos'] is int) 'stubNanos': leaf['stubNanos'],
    });
  }
  final posts = <Map<String, dynamic>>[];
  final pool = _WdPool(posts, {
    'pubs': [for (final host in hostNotes) host['admitPub']],
    'commits': [for (final host in hostNotes) host['commit']],
    'anchors': [
      {'height': 32, 'n': hostNotes.length},
    ],
    'spendTags': <Object>[],
  }, tranches, ok: ok);
  addTearDown(pool.close);
  final ledger = ShearLedger(pool: pool)..bindIdentity(bound);
  for (final host in hostNotes) {
    ledger.rememberNote(host);
  }
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
  String? maturedPortal;
  for (final leaf in made) {
    final epoch = (leaf['epochs'] as List).first;
    if (epoch is int && reserve.currentEpoch > epoch) {
      maturedPortal = leaf['portalId'] as String;
      break;
    }
  }
  final slot = maturedPortal == null ? t0 + kReserveEpochMs : vaultWithdrawSlotMs(reserve, 0, maturedPortal);
  // The CLI passes the seed and the lock leaves. This is that call.
  final posted = await postMaturedWithdraws(
    ledger,
    reserve: reserve,
    dest: dest,
    payout: dest,
    nowMs: nowMs ?? slot,
    spendSeed: spend,
    leaves: reserveLockLeaves(ledger.notes),
    local: false,
    publicIpConsent: true,
  );
  return _Run(ledger, posts, posted, spend, storedHost, before, pool.bookGets);
}

Map<String, Object?> _leaf({
  required int amount,
  required String portalId,
  required int lockIndex,
  required int epoch,
  int stubNanos = 0,
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
    if (stubNanos > 0) 'stubNanos': stubNanos,
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
  int bookGets = 0;

  @override
  Future<Map<String, dynamic>> fluxset() async => flux;

  @override
  Future<Map<String, dynamic>> reserveTrancheBook() async {
    bookGets += 1;
    final rows = <Map<String, Object?>>[];
    for (final entry in tranches.entries) {
      for (final row in entry.value) {
        rows.add({
          ...row,
          'portalId': entry.key,
        });
      }
    }
    return {'ok': true, 'tranches': rows};
  }

  @override
  Future<Map<String, dynamic>> postRaw(Map<String, dynamic> body) async {
    posts.add(body);
    if (!ok) return {'ok': false, 'reason': 'unsigned'};
    return {'ok': true, 'id': 'wd-fix'};
  }
}
