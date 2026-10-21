import 'dart:math';
import 'dart:typed_data';

import 'shear_note.dart';
import 'shear_ristretto.dart';
import 'shear_vote_plan.dart';

/// Proves the spend of the note [buildLeafVote] already picked.
/// The result carries a fresh `t`. `cTilde` is commit + t·H, not the commit.
typedef FeeNoteProver = Map<String, Object?>? Function(Map<String, dynamic> note);

bool _bytesEq(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

List<int>? _commitBytes(Object? raw) {
  if (raw is Uint8List && raw.length == 32) return raw;
  if (raw is List<int> && raw.length == 32) return raw;
  if (raw is String) {
    final hex = raw.startsWith('0x') || raw.startsWith('0X') ? raw.substring(2) : raw;
    if (hex.length != 64) return null;
    final out = Uint8List(32);
    for (var i = 0; i < 32; i++) {
      final byte = int.tryParse(hex.substring(i * 2, i * 2 + 2), radix: 16);
      if (byte == null) return null;
      out[i] = byte;
    }
    return out;
  }
  return null;
}

/// commit + t·H. A zero t, or a cTilde that is the raw commit, is not a spend.
bool _tildeBindsCommit(List<int> commit, List<int> tilde, List<int> t) {
  if (commit.length != 32 || tilde.length != 32 || t.length != 32) return false;
  if (_bytesEq(commit, tilde)) return false;
  var zero = true;
  for (final b in t) {
    if (b != 0) {
      zero = false;
      break;
    }
  }
  if (zero) return false;
  try {
    final bound = addBytes(
      Uint8List.fromList(commit),
      mulBytes(noteHBytes, Uint8List.fromList(t)),
    );
    return _bytesEq(bound, tilde);
  } catch (_) {
    return false;
  }
}

/// One leaf vote. The fee note is picked first. [prove] spends that note
/// and returns a fresh t. The proof is kept only when cTilde = commit + t·H.
/// The posted vote carries cTilde, not the raw commit, and not the parent.
/// Those stay in the wallet. A fee integer with no spend is not a vote.
Map<String, Object?>? buildLeafVote({
  required Map<String, Object?> vote,
  required List<dynamic> notes,
  required int fee,
  required int anchor,
  FeeNoteProver? prove,
  Random? random,
  Set<String>? usedParents,
  Set<String>? usedCommits,
  Map<String, Object?>? change,
  String planDir = '',
  int leaves = 0,
  int openHeight = 0,
  int closeHeight = 0,
  int epoch = 0,
}) {
  if (fee <= 0 || anchor < 0 || prove == null) return null;
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
      epoch: epoch,
      random: random,
    );
    if (plan == null) return null;
  }
  final rng = random ?? Random.secure();
  final note = _selectFeeNote(notes, rng, usedParents, usedCommits, plan, vote);
  if (note == null) return null;
  final proved = prove(note);
  if (proved == null) return null;
  final fs1 = proved['fs1'];
  final excess = proved['excess'];
  final admitProof = proved['admitProof'];
  if (fs1 is! List<int> || fs1.isEmpty || fs1[0] != 0xf1) return null;
  if (excess is! List<int> || excess.length != 32) return null;
  if (admitProof is! Map) return null;
  final blob = admitProof['blob'];
  if (blob is! List<int> && blob is! Uint8List) return null;
  final raw = blob is Uint8List ? blob : Uint8List.fromList(blob as List<int>);
  if (raw.length < 65 || raw[0] != 0xf1) return null;
  final tilde = admitProof['cTilde'];
  if (tilde is! List<int> || tilde.length != 32) return null;
  final tag = admitProof['spendTag'];
  if (tag is! List<int> || tag.length != 32) return null;
  final t = proved['t'];
  if (t is! List<int> || t.length != 32) return null;
  final commit = _commitBytes(note['commit']);
  if (commit == null || !_tildeBindsCommit(commit, tilde, t)) return null;
  // The wire allowlist is blob, cTilde, and spendTag. t and the raw commit stay here.
  final posted = <String, Object?>{
    'blob': raw,
    'cTilde': Uint8List.fromList(tilde),
    'spendTag': Uint8List.fromList(tag),
  };
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
    'anchor': anchor,
    'fs1': fs1,
    'excess': excess,
    'vin': [
      {'commit': posted['cTilde']},
    ],
    'admit_proofs': [posted],
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
    final kind = (row['kind'] ?? '').toString();
    if (kind == 'lock' || kind == 'reward-claim') continue;
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
