import 'dart:math';
import 'dart:typed_data';

import 'shear_vote_plan.dart';

/// One leaf vote. The fee is one owned FS-1 note. [fs1] is that note's
/// spend, [admitProof] is its record, and [excess] balances the fee against
/// the spent commitment. Change is [change], a fresh note, or there is no
/// change when the note equals the fee. A fee integer with no spend is not
/// a vote. The plaintext `from` is not an input.
///
/// [notes] are the wallet's notes. A note from [usedParents] or marked as
/// another vote's change is skipped. The choice among the rest is random.
/// Proving the spend is [proveFs1SpendWire]. This function binds that proof
/// to the note it picked.
Map<String, Object?>? buildLeafVote({
  required Map<String, Object?> vote,
  required List<dynamic> notes,
  required int fee,
  required List<int> fs1,
  required List<int> excess,
  required Map<String, Object?> admitProof,
  required int anchor,
  Random? random,
  Set<String>? usedParents,
  Set<String>? usedCommits,
  Map<String, Object?>? change,
  String planDir = '',
  int leaves = 0,
  int openHeight = 0,
  int closeHeight = 0,
}) {
  if (fee <= 0 || anchor < 0) return null;
  if (fs1.isEmpty || fs1[0] != 0xf1 || excess.length != 32) return null;
  final blob = admitProof['blob'];
  if (blob is! List<int> && blob is! Uint8List) return null;
  final raw = blob is Uint8List ? blob : Uint8List.fromList(blob as List<int>);
  if (raw.length < 65 || raw[0] != 0xf1) return null;
  final tilde = admitProof['cTilde'];
  if (tilde is! List<int> || tilde.length != 32) return null;
  if (change != null) {
    final kind = (change['kind'] ?? '').toString();
    if (kind == 'leaf-vote' || kind == 'vote' || kind == 'lock' || kind == 'withdraw') return null;
    if (change['commit'] == null || change['rangeProof'] == null || change['valueProof'] != null) {
      return null;
    }
  }
  Map<String, Object?>? plan;
  if (planDir.isNotEmpty && leaves > 0) {
    plan = plannedLeafVotes(
      dir: planDir,
      leaves: leaves,
      notes: notes,
      openHeight: openHeight,
      closeHeight: closeHeight,
      random: random,
    );
    if (plan == null) return null;
  }
  final rng = random ?? Random.secure();
  final note = _selectFeeNote(notes, rng, usedParents, usedCommits, plan, vote);
  if (note == null) return null;
  final commit = note['commit'];
  return {
    'kind': 'leaf-vote',
    'voteProof': vote['voteProof'],
    'voteOutput': vote['voteOutput'],
    'choice': vote['choice'],
    'voteSeq': vote['voteSeq'],
    'voteParam': vote['voteParam'],
    'earnEpoch': vote['earnEpoch'],
    'height': vote['height'],
    'fee': fee,
    'feeInput': commit,
    'parentTx': note['parentTx'],
    'anchor': anchor,
    'fs1': fs1,
    'excess': excess,
    'vin': [
      {'commit': tilde},
    ],
    'admit_proofs': [admitProof],
    'vout': change == null ? <Map<String, Object?>>[] : [change],
  };
}

Map<String, dynamic>? _selectFeeNote(
  List<dynamic> notes,
  Random random,
  Set<String>? usedParents,
  Set<String>? usedCommits,
  Map<String, Object?>? plan,
  Map<String, Object?> vote,
) {
  String? planned;
  final height = vote['height'];
  final txs = plan?['txs'];
  if (txs is List && height is int) {
    for (final row in txs) {
      if (row is Map && row['height'] == height) {
        final raw = row['feeInput'];
        if (raw is String) planned = raw;
      }
    }
  }
  final eligible = <Map<String, dynamic>>[];
  for (final row in notes) {
    if (row is! Map) continue;
    if (row['spent'] == true || row['locked'] == true) continue;
    if ((row['kind'] ?? '').toString() == 'lock') continue;
    if (row['voteChange'] == true || (row['changeOf'] ?? '').toString() == 'vote') continue;
    final commit = row['commit'];
    if (commit is! String || commit.isEmpty) continue;
    final parent = row['parentTx'] == null ? '' : row['parentTx'].toString();
    if (parent.isNotEmpty && (usedParents?.contains(parent) ?? false)) continue;
    if (usedCommits?.contains(commit) ?? false) continue;
    if (planned != null && commit != planned) continue;
    eligible.add(Map<String, dynamic>.from(row));
  }
  if (eligible.isEmpty) return null;
  return eligible[random.nextInt(eligible.length)];
}

/// Marks the change of a vote so a later vote does not spend it as a fee.
Map<String, Object?> voteChangeNote({
  required String commit,
  required String parentTx,
}) {
  return {
    'kind': 'send',
    'commit': commit,
    'parentTx': parentTx,
    'voteChange': true,
    'changeOf': 'vote',
  };
}
