import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

/// Local vote plan. The pool never sees locked leaves, this file, or a plan
/// directory. vote-plan.json is mode 0600. It is not synced, logged, or posted.
const votePlanName = 'vote-plan.json';
const voteEdgeBlocks = 10;
const voteMinSeparation = 30;

String votePlanPath(String dir) => '$dir${Platform.pathSeparator}$votePlanName';

String? _commitHex(dynamic raw) {
  if (raw is String) {
    final hex = raw.replaceFirst(RegExp(r'^0x'), '').toLowerCase();
    if (RegExp(r'^[0-9a-f]{64}$').hasMatch(hex)) return hex;
    return null;
  }
  List<int>? bytes;
  if (raw is Uint8List) bytes = raw;
  else if (raw is List<int>) bytes = raw;
  if (bytes == null || bytes.length != 32) return null;
  final out = StringBuffer();
  for (final b in bytes) {
    out.write(b.toRadixString(16).padLeft(2, '0'));
  }
  return out.toString();
}

/// Spendable note commits this wallet can use as fee inputs. Lock notes,
/// spent notes, and locked notes are not fee inputs.
List<String> ownedFeeInputs(List<dynamic> notes) {
  final out = <String>[];
  final seen = <String>{};
  for (final row in notes) {
    if (row is! Map) continue;
    if (row['spent'] == true || row['locked'] == true) continue;
    if ((row['kind'] ?? '').toString() == 'lock') continue;
    final hex = _commitHex(row['commit']);
    if (hex == null || !seen.add(hex)) continue;
    out.add(hex);
  }
  return out;
}

List<int>? _planHeights(int count, int lo, int hi, Random random) {
  if (hi < lo) return null;
  final span = hi - lo + 1;
  final need = count <= 1 ? 1 : (count - 1) * voteMinSeparation + 1;
  if (span < need) return null;
  for (var attempt = 0; attempt < 256; attempt++) {
    final draw = <int>[for (var i = 0; i < count; i++) lo + random.nextInt(span)];
    draw.sort();
    var ok = true;
    for (var i = 1; i < draw.length; i++) {
      if (draw[i] - draw[i - 1] < voteMinSeparation) {
        ok = false;
        break;
      }
    }
    if (ok) return draw;
  }
  return null;
}

/// One send per locked leaf. Each fee input is a distinct spendable note
/// commit the wallet already holds. The planner does not invent bytes.
Map<String, Object?>? castWalletVotePlan({
  required int leaves,
  required List<dynamic> notes,
  required int openHeight,
  required int closeHeight,
  Random? random,
}) {
  final count = leaves < 0 ? 0 : leaves;
  final open = openHeight < 0 ? 0 : openHeight;
  final label = 'Cast your $count votes';
  if (count == 0) {
    return {
      'label': label,
      'openHeight': open,
      'closeHeight': closeHeight,
      'txs': <Map<String, Object?>>[],
    };
  }
  final owned = ownedFeeInputs(notes);
  if (owned.length < count) return null;
  final lo = open + voteEdgeBlocks;
  final hi = closeHeight - voteEdgeBlocks;
  final heights = _planHeights(count, lo, hi, random ?? Random.secure());
  if (heights == null) return null;
  return {
    'label': label,
    'openHeight': open,
    'closeHeight': closeHeight,
    'txs': [
      for (var i = 0; i < count; i++)
        {'leaf': i, 'height': heights[i], 'feeInput': owned[i]},
    ],
  };
}

/// Write vote-plan.json in [dir] at mode 0600. The path is not a sync root
/// and the bytes are not logged.
void saveWalletVotePlan(String dir, Map<String, Object?> plan) {
  final parent = Directory(dir);
  parent.createSync(recursive: true);
  final dest = File(votePlanPath(dir));
  final tmp = File('${parent.path}${Platform.pathSeparator}.$votePlanName.$pid.tmp');
  tmp.writeAsStringSync(jsonEncode(plan), flush: true);
  if (!Platform.isWindows) {
    final mode = Process.runSync('chmod', ['600', tmp.path]);
    if (mode.exitCode != 0) {
      throw StateError('vote_plan_mode');
    }
  }
  tmp.renameSync(dest.path);
  if (!Platform.isWindows) {
    final mode = Process.runSync('chmod', ['600', dest.path]);
    if (mode.exitCode != 0) throw StateError('vote_plan_mode');
    final got = dest.statSync().mode & 0x1ff;
    if (got != 0x180) throw StateError('vote_plan_mode');
  }
}
