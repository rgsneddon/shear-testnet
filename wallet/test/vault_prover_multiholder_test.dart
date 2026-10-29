import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_fs1.dart';
import 'package:shear_wallet/shear_ristretto.dart';
import 'package:shear_wallet/shear_vault_reward.dart';

String _hex(List<int> raw) =>
    raw.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

Uint8List _flip(Uint8List root) {
  final bad = Uint8List.fromList(root);
  bad[bad.length - 1] = bad[bad.length - 1] == 0 ? 1 : 0;
  return bad;
}

/// Root of [notes] from the native tree, not from [vaultLockTree].
Uint8List _nativeRoot(List<Uint8List> notes) {
  final fs1 = Fs1Native.tryLoad();
  expect(fs1, isNotNull, reason: 'fs1_prover_unavailable');
  final handle = fs1!.treeNew();
  expect(handle, isNot(0));
  expect(fs1.treeAppend(handle, Uint8List.fromList(notes.expand((n) => n).toList())), isTrue);
  final root = fs1.treeRoot(handle);
  fs1.treeFree(handle);
  expect(root, isNotNull);
  expect(root!.length, 32);
  return root;
}

Map<String, dynamic> _lock(Uint8List scalar, Uint8List blind) => {
      'amount': kPiSheNanos,
      'scalar': scalar,
      'blind': blind,
      'unlockEpoch': 32,
    };

void main() {
  test('two holders: vote and claim roots are the full lock tree', () async {
    expect(Fs1Native.tryLoad(), isNotNull, reason: 'fs1_prover_unavailable');
    final a0s = scalarBytes(randomScalar());
    final a0b = scalarBytes(randomScalar());
    final b0s = scalarBytes(randomScalar());
    final b0b = scalarBytes(randomScalar());
    final a1s = scalarBytes(randomScalar());
    final a1b = scalarBytes(randomScalar());
    final b1s = scalarBytes(randomScalar());
    final b1b = scalarBytes(randomScalar());
    final a0 = _lock(a0s, a0b);
    final notes = <Uint8List>[
      vaultLockNoteBytes(kPiSheNanos, a0s, a0b, 32),
      vaultLockNoteBytes(kPiSheNanos, b0s, b0b, 32),
      vaultLockNoteBytes(kPiSheNanos, a1s, a1b, 32),
      vaultLockNoteBytes(kPiSheNanos, b1s, b1b, 32),
    ];
    expect(notes, hasLength(4));
    expect(vaultLockNoteIndex(notes, vaultLockOpeningNote(a0)), 0);
    final root = _nativeRoot(notes);
    // ignore: avoid_print
    print('dart builder root ${_hex(root)}');

    final proposal = voteProposalId(3, 'hb');
    expect(proposal, isNotNull);
    final vote = await proveLeafVoteOffUi({
      'locks': [a0],
      'which': 0,
      'notes': notes,
      'chainRoot': root,
      'epoch': 3,
      'choice': 1,
      'seq': 1,
      'proposalId': proposal,
      'dest20': Uint8List(20)..[0] = 5,
    });
    expect(vote, isNotNull);
    expect(vote!['root'], orderedEquals(root));

    final claim = await proveVaultLockOffUi({
      'locks': [a0],
      'which': 0,
      'notes': notes,
      'chainRoot': root,
      'rootEpoch': 1,
      'earnEpoch': 1,
      'bps': 281,
      'remainMs': 1,
      'span': 1,
      'dest20': Uint8List(20)..[0] = 6,
    });
    expect(claim['ok'], isTrue);
    expect(claim['root'], orderedEquals(root));

    final bad = _flip(root);
    final refusedVote = await proveLeafVoteOffUi({
      'locks': [a0],
      'which': 0,
      'notes': notes,
      'chainRoot': bad,
      'epoch': 3,
      'choice': 1,
      'seq': 1,
      'proposalId': proposal,
      'dest20': Uint8List(20)..[0] = 5,
    });
    expect(refusedVote, isNull);
    await expectLater(
      proveVaultLockOffUi({
        'locks': [a0],
        'which': 0,
        'notes': notes,
        'chainRoot': bad,
        'rootEpoch': 1,
        'earnEpoch': 1,
        'bps': 281,
        'remainMs': 1,
        'span': 1,
        'dest20': Uint8List(20)..[0] = 6,
      }),
      throwsA(isA<StateError>().having((e) => e.message, 'message', 'vault_root')),
    );
  }, timeout: const Timeout(Duration(minutes: 3)));

  test('census is one private read and prove is scheduled off the UI isolate', () async {
    final notes = <Uint8List>[
      for (var i = 0; i < 4; i++) Uint8List(64)..[0] = i + 1,
    ];
    final root = Uint8List(32)..[0] = 9;
    var reads = 0;
    final census = await readVaultLockCensus(() async {
      reads += 1;
      return {
        'ok': true,
        'public': false,
        'spendable': 'never',
        'notes': [for (final note in notes) _hex(note)],
        'root': _hex(root),
      };
    });
    expect(reads, 1);
    expect(census.notes, hasLength(4));
    for (var i = 0; i < 4; i++) {
      expect(census.notes[i], orderedEquals(notes[i]));
    }
    expect(census.root, orderedEquals(root));

    expect(vaultProveOnCaller(), isTrue);
    final reward = File('lib/shear_vault_reward.dart').readAsStringSync();
    expect(reward, contains('Isolate.run(() => proveVaultLockRewardStamped(input))'));
    expect(reward, contains('Isolate.run(() => proveLeafVoteStamped(input))'));
    final offUi = reward.indexOf('Future<Map<String, dynamic>> proveVaultLockOffUi');
    expect(offUi, greaterThan(0));
    final offBody = reward.substring(offUi, reward.indexOf('\n}', offUi));
    expect(offBody, contains('Isolate.run(() => proveVaultLockRewardStamped(input))'));
    expect(offBody.contains('vaultProveOnCaller()'), isTrue);

    final reserve = File('lib/shear_reserve.dart').readAsStringSync();
    final voteStart = reserve.indexOf('Future<ReserveVoteResult> castPlannedLeafVotes');
    final voteEnd = reserve.indexOf('class ReserveVoteTower');
    final voteBody = reserve.substring(voteStart, voteEnd);
    expect('readVaultLockCensus('.allMatches(voteBody).length, 1);
    expect(voteBody.indexOf('readVaultLockCensus('), lessThan(voteBody.indexOf('for (final row in txs)')));

    final claimStart = reserve.indexOf('Future<({ShearTx tx, Map<String, int> settled})?> postReserveVaultClaim');
    final claimEnd = reserve.indexOf('Future<List<({ShearTx tx, Map<String, int> settled})>> postMaturedWithdraws');
    final claimBody = reserve.substring(claimStart, claimEnd);
    expect('readVaultLockCensus('.allMatches(claimBody).length, 1);

    final ledger = File('lib/shear_ledger.dart').readAsStringSync();
    final censusStart = ledger.indexOf('Future<Map<String, dynamic>> vaultLockCensus()');
    expect(censusStart, greaterThan(0));
    final censusLine = ledger.substring(censusStart, ledger.indexOf('\n', censusStart));
    expect(censusLine, contains("'/api/vault/locks'"));
    expect(censusLine.contains('?'), isFalse);
    expect(censusLine.contains('index'), isFalse);
    expect(censusLine.contains('open:'), isFalse);
  });
}
